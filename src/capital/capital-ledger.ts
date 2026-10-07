// Append-only, double-entry capital ledger.
//
// Guarantees (structural, checked on every append):
//  - every entry balances: the sum of all posting amounts is exactly 0 Rappen
//  - entry IDs are unique (idempotency: a re-sent broker/bank event is rejected, not double-booked)
//  - entries are frozen after append and never updated or deleted; corrections are reversal entries
//  - entries are hash-chained (SHA-256), so tampering with persisted history is detectable
//
// Business rules (no overdraft, no negative stock, ...) are enforced by the CapitalEngine through
// the `guard` callback, which runs inside the same serialized append section as the write.

import { Decimal } from '../money/decimal.js';
import { rappen, ZERO_CHF } from '../money/money.js';
import { hashOf } from '../persistence/canonical-json.js';
import { parseAccountKey } from './accounts.js';
import {
  CAPITAL_TRANSACTION_TYPES,
  type AccountBalance,
  type AccountKey,
  type EntryRefs,
  type JournalEntry,
  type JournalEntryDraft,
  type Posting,
} from './capital-types.js';

export type LedgerErrorCode =
  | 'invalid_entry'
  | 'unbalanced'
  | 'duplicate_id'
  | 'unknown_entry'
  | 'already_reversed'
  | 'guard_rejected'
  | 'store_conflict'
  | 'integrity';

export class LedgerError extends Error {
  override readonly name = 'LedgerError';
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Persistence port. Implementations must be append-only and reject out-of-order sequences. */
export interface LedgerStore {
  loadAll(): Promise<readonly JournalEntry[]>;
  /** Must reject unless entry.sequence === number of stored entries + 1 (optimistic concurrency). */
  append(entry: JournalEntry): Promise<void>;
}

export class InMemoryLedgerStore implements LedgerStore {
  private readonly entries: JournalEntry[] = [];

  async loadAll(): Promise<readonly JournalEntry[]> {
    return [...this.entries];
  }

  async append(entry: JournalEntry): Promise<void> {
    if (entry.sequence !== this.entries.length + 1) {
      throw new LedgerError('store_conflict', 'expected sequence ' + (this.entries.length + 1) + ', got ' + entry.sequence);
    }
    this.entries.push(entry);
  }
}

export interface LedgerView {
  readonly size: number;
  balance(account: AccountKey): AccountBalance;
  balances(): ReadonlyMap<AccountKey, AccountBalance>;
  get(entryId: string): JournalEntry | undefined;
  isReversed(entryId: string): boolean;
}

/** Throws to veto an append. Receives the balances as they would be after the entry is applied. */
export type AppendGuard = (draft: JournalEntryDraft, after: LedgerView) => void;

/** Builds a draft from the current state, inside the serialized append section. Throws to reject. */
export type DraftFactory = (current: LedgerView) => JournalEntryDraft;

function rejectOnError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    throw new LedgerError('guard_rejected', error instanceof Error ? error.message : String(error));
  }
}

export const GENESIS_HASH = '0'.repeat(64);
const ZERO_BALANCE: AccountBalance = Object.freeze({ amount: ZERO_CHF, quantity: Decimal.ZERO });

export class CapitalLedger implements LedgerView {
  private readonly entries: JournalEntry[] = [];
  private readonly byId = new Map<string, JournalEntry>();
  private readonly reversedIds = new Set<string>();
  private readonly current = new Map<AccountKey, AccountBalance>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly store: LedgerStore,
    private readonly clock: () => Date,
  ) {}

  /** Loads and verifies the full history from the store. Refuses to open a tampered ledger. */
  static async open(store: LedgerStore, options: { clock?: () => Date } = {}): Promise<CapitalLedger> {
    const ledger = new CapitalLedger(store, options.clock ?? (() => new Date()));
    const history = await store.loadAll();
    let prevHash = GENESIS_HASH;
    for (const [index, entry] of history.entries()) {
      if (entry.sequence !== index + 1) throw new LedgerError('integrity', 'sequence gap at position ' + (index + 1));
      if (entry.prevHash !== prevHash) throw new LedgerError('integrity', 'broken hash chain at sequence ' + entry.sequence);
      if (computeEntryHash(entry) !== entry.hash) throw new LedgerError('integrity', 'hash mismatch at sequence ' + entry.sequence);
      ledger.validateStructure(entry);
      ledger.apply(deepFreezeEntry(entry));
      prevHash = entry.hash;
    }
    return ledger;
  }

  static inMemory(options: { clock?: () => Date } = {}): Promise<CapitalLedger> {
    return CapitalLedger.open(new InMemoryLedgerStore(), options);
  }

  get size(): number {
    return this.entries.length;
  }

  get lastHash(): string {
    return this.entries.at(-1)?.hash ?? GENESIS_HASH;
  }

  all(): readonly JournalEntry[] {
    return [...this.entries];
  }

  get(entryId: string): JournalEntry | undefined {
    return this.byId.get(entryId);
  }

  isReversed(entryId: string): boolean {
    return this.reversedIds.has(entryId);
  }

  balance(account: AccountKey): AccountBalance {
    return this.current.get(account) ?? ZERO_BALANCE;
  }

  /** Current balances, or balances as of an economic point in time (entries with occurredAt <= asOf). */
  balances(options: { asOf?: string } = {}): ReadonlyMap<AccountKey, AccountBalance> {
    if (options.asOf === undefined) return new Map(this.current);
    const asOf = normalizeTimestamp(options.asOf, 'asOf');
    const result = new Map<AccountKey, AccountBalance>();
    for (const entry of this.entries) {
      if (entry.occurredAt <= asOf) applyPostings(result, entry.postings);
    }
    return result;
  }

  /**
   * Validates, hashes, persists and applies an entry. Appends are serialized: a draft factory and the
   * guard always see exactly the state the entry will be applied to (no check-then-write races).
   */
  append(draft: JournalEntryDraft | DraftFactory, guard?: AppendGuard): Promise<JournalEntry> {
    const run = this.queue.then(() => this.appendNow(draft, guard));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Re-verifies the in-memory chain (e.g. before a reconciliation run). */
  verifyIntegrity(): { ok: true } | { ok: false; sequence: number; reason: string } {
    let prevHash = GENESIS_HASH;
    for (const entry of this.entries) {
      if (entry.prevHash !== prevHash) return { ok: false, sequence: entry.sequence, reason: 'broken hash chain' };
      if (computeEntryHash(entry) !== entry.hash) return { ok: false, sequence: entry.sequence, reason: 'hash mismatch' };
      prevHash = entry.hash;
    }
    return { ok: true };
  }

  private async appendNow(input: JournalEntryDraft | DraftFactory, guard?: AppendGuard): Promise<JournalEntry> {
    const draft = typeof input === 'function' ? rejectOnError(() => input(this.viewOf(this.current))) : input;
    const unsigned = {
      sequence: this.entries.length + 1,
      id: draft.id,
      occurredAt: normalizeTimestamp(draft.occurredAt, 'occurredAt'),
      recordedAt: this.clock().toISOString(),
      type: draft.type,
      description: draft.description,
      postings: draft.postings.map(normalizePosting),
      refs: stripUndefined(draft.refs ?? {}),
      source: draft.source ?? 'engine',
      prevHash: this.lastHash,
    };
    const entry = deepFreezeEntry({ ...unsigned, hash: computeEntryHash(unsigned) });
    this.validateStructure(entry);

    if (guard) {
      const after = new Map(this.current);
      applyPostings(after, entry.postings);
      rejectOnError(() => guard(draft, this.viewOf(after)));
    }

    await this.store.append(entry);
    this.apply(entry);
    return entry;
  }

  private validateStructure(entry: JournalEntry): void {
    const fail = (message: string): never => {
      throw new LedgerError('invalid_entry', 'entry "' + entry.id + '": ' + message);
    };
    if (typeof entry.id !== 'string' || entry.id.trim() === '') fail('id is required');
    if (this.byId.has(entry.id)) throw new LedgerError('duplicate_id', 'entry id "' + entry.id + '" already exists');
    if (!CAPITAL_TRANSACTION_TYPES.includes(entry.type)) fail('unknown type "' + entry.type + '"');
    if (entry.description.trim() === '') fail('description is required');
    if (entry.postings.length < 2) fail('needs at least two postings');

    let sum = 0n;
    for (const posting of entry.postings) {
      if (typeof posting.amount !== 'bigint') fail('amount must be bigint Rappen on ' + posting.account);
      let info: ReturnType<typeof parseAccountKey>;
      try {
        info = parseAccountKey(posting.account);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      const holdsQuantity = info.kind === 'position' || info.kind === 'inventory';
      if (holdsQuantity && posting.quantity === undefined) fail('posting to ' + posting.account + ' needs a quantity');
      if (!holdsQuantity && posting.quantity !== undefined) fail('posting to ' + posting.account + ' must not carry a quantity');
      if (posting.amount === 0n && (posting.quantity === undefined || posting.quantity.isZero())) {
        fail('empty posting to ' + posting.account);
      }
      sum += posting.amount;
    }
    if (sum !== 0n) throw new LedgerError('unbalanced', 'entry "' + entry.id + '" is unbalanced by ' + sum + ' Rappen');

    if (entry.type === 'reversal') {
      const targetId = entry.refs.reversesEntryId;
      const target = targetId === undefined ? undefined : this.byId.get(targetId);
      if (!target) throw new LedgerError('unknown_entry', 'reversal of unknown entry "' + targetId + '"');
      if (target.type === 'reversal') fail('a reversal cannot be reversed; book a new entry instead');
      if (this.reversedIds.has(target.id)) throw new LedgerError('already_reversed', 'entry "' + target.id + '" is already reversed');
    }
  }

  private apply(entry: JournalEntry): void {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    if (entry.type === 'reversal' && entry.refs.reversesEntryId !== undefined) this.reversedIds.add(entry.refs.reversesEntryId);
    applyPostings(this.current, entry.postings);
  }

  private viewOf(balances: ReadonlyMap<AccountKey, AccountBalance>): LedgerView {
    return {
      size: this.entries.length + 1,
      balance: (account) => balances.get(account) ?? ZERO_BALANCE,
      balances: () => balances,
      get: (entryId) => this.byId.get(entryId),
      isReversed: (entryId) => this.reversedIds.has(entryId),
    };
  }
}

function applyPostings(target: Map<AccountKey, AccountBalance>, postings: readonly Posting[]): void {
  for (const posting of postings) {
    const before = target.get(posting.account) ?? ZERO_BALANCE;
    target.set(
      posting.account,
      Object.freeze({
        amount: rappen(before.amount + posting.amount),
        quantity: posting.quantity ? before.quantity.plus(posting.quantity) : before.quantity,
      }),
    );
  }
}

function normalizePosting(posting: Posting): Posting {
  return posting.quantity === undefined
    ? { account: posting.account, amount: posting.amount }
    : { account: posting.account, amount: posting.amount, quantity: Decimal.from(posting.quantity) };
}

function normalizeTimestamp(value: string, label: string): string {
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) throw new LedgerError('invalid_entry', label + ' is not a valid ISO timestamp: "' + value + '"');
  return new Date(millis).toISOString();
}

function stripUndefined(refs: EntryRefs): EntryRefs {
  return Object.fromEntries(Object.entries(refs).filter(([, v]) => v !== undefined)) as EntryRefs;
}

function deepFreezeEntry(entry: JournalEntry): JournalEntry {
  for (const posting of entry.postings) Object.freeze(posting);
  Object.freeze(entry.postings);
  Object.freeze(entry.refs);
  return Object.freeze(entry);
}

/** SHA-256 over a canonical JSON form (sorted keys, bigint/Decimal as strings) of everything except the hash. */
export function computeEntryHash(entry: Omit<JournalEntry, 'hash'>): string {
  const { sequence, id, occurredAt, recordedAt, type, description, postings, refs, source, prevHash } = entry;
  return hashOf({ sequence, id, occurredAt, recordedAt, type, description, postings, refs, source, prevHash });
}
