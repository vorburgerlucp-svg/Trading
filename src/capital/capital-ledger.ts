// Append-only, double-entry capital ledger.
//
// Guarantees:
//  - every entry balances: per currency, the sum of all posting amounts is exactly 0 minor units
//  - one linear, hash-chained history (SHA-256): tamper-EVIDENT (see ledger-integrity.ts)
//  - idempotency: an id is booked at most once. Replaying the same command (same fingerprint)
//    returns ALREADY_APPLIED; reusing an id for different content is an idempotency_conflict
//  - entries are frozen and never updated or deleted; corrections are reversal entries
//  - CHF-only operation: other currencies are rejected explicitly, never converted
//  - writes go through the store's cross-process critical section (PostgreSQL row lock): the ledger
//    catches up with entries committed elsewhere, then validates and runs the business-rule guard
//    against that true latest state. No double spend across servers.
//  - fail closed: once corruption is detected, every read and write throws FINANCIAL_INTEGRITY_ERROR
//
// The in-memory state is a projection of the stored history (source events), rebuilt on open.

import { Decimal } from '../money/decimal.js';
import { rappen, ZERO_CHF } from '../money/money.js';
import { GENESIS_HASH } from '../persistence/append-only-log.js';
import type { AccountBalance, AccountKey, JournalEntry, JournalEntryDraft, Posting } from './capital-types.js';
import { LedgerError } from './ledger-errors.js';
import {
  computeEntryHash,
  draftFingerprint,
  FinancialIntegrityError,
  normalizePosting,
  normalizeTimestamp,
  stripUndefined,
  structuralIssues,
  verifyLedgerEntries,
  type IntegrityIssue,
  type LedgerCheckpoint,
  type LedgerCheckpointStore,
} from './ledger-integrity.js';
import { InMemoryLedgerStore, type LedgerStore } from './ledger-store.js';

export { LedgerError, type LedgerErrorCode } from './ledger-errors.js';
export { InMemoryLedgerStore, type LedgerStore } from './ledger-store.js';
export { GENESIS_HASH } from '../persistence/append-only-log.js';
export { computeEntryHash } from './ledger-integrity.js';

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

export type AppendStatus = 'APPLIED' | 'ALREADY_APPLIED';

export interface AppendResult {
  status: AppendStatus;
  entry: JournalEntry;
}

export interface AppendOptions {
  guard?: AppendGuard;
  /** Stable id of the external/repeatable event (e.g. "broker-fill:ibkr:ORDER123:FILL4"). Must equal the draft id. */
  idempotencyKey?: string;
  /** Hash of the originating command. Defaults to the normalized draft content. */
  requestFingerprint?: string;
}

export interface LedgerOpenOptions {
  clock?: () => Date;
  /** Latest trusted checkpoint is verified on open; a mismatch is a FINANCIAL_INTEGRITY_ERROR. */
  checkpoints?: LedgerCheckpointStore;
}

const ZERO_BALANCE: AccountBalance = Object.freeze({ amount: ZERO_CHF, quantity: Decimal.ZERO });

function rejectOnError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof LedgerError || error instanceof FinancialIntegrityError) throw error;
    throw new LedgerError('guard_rejected', error instanceof Error ? error.message : String(error));
  }
}

export class CapitalLedger implements LedgerView {
  private readonly entries: JournalEntry[] = [];
  private readonly byId = new Map<string, JournalEntry>();
  private readonly reversedIds = new Set<string>();
  private readonly current = new Map<AccountKey, AccountBalance>();
  private queue: Promise<unknown> = Promise.resolve();
  private corruption: FinancialIntegrityError | null = null;

  private constructor(
    private readonly store: LedgerStore,
    private readonly clock: () => Date,
  ) {}

  /** Loads and fully verifies the stored history. Refuses (fails closed) on any integrity issue. */
  static async open(store: LedgerStore, options: LedgerOpenOptions = {}): Promise<CapitalLedger> {
    const ledger = new CapitalLedger(store, options.clock ?? (() => new Date()));
    const history = await store.loadAll();
    const checkpoint = options.checkpoints ? await options.checkpoints.getLatestCheckpoint(store.ledgerId) : null;
    const report = verifyLedgerEntries(history, { allowedCurrencies: store.allowedCurrencies, checkpoint });
    if (!report.ok) throw new FinancialIntegrityError(report.issues, 'ledger ' + store.ledgerId);
    for (const entry of history) ledger.apply(deepFreezeEntry(entry));
    return ledger;
  }

  static inMemory(options: LedgerOpenOptions = {}): Promise<CapitalLedger> {
    return CapitalLedger.open(new InMemoryLedgerStore(), options);
  }

  get ledgerId(): string {
    return this.store.ledgerId;
  }

  get allowedCurrencies(): readonly string[] {
    return this.store.allowedCurrencies;
  }

  get size(): number {
    return this.entries.length;
  }

  get lastHash(): string {
    return this.entries.at(-1)?.hash ?? GENESIS_HASH;
  }

  /** Current head, e.g. to reference the exact capital state a decision was based on. */
  head(): { ledgerId: string; sequence: number; hash: string } {
    this.assertHealthy();
    return { ledgerId: this.store.ledgerId, sequence: this.entries.length, hash: this.lastHash };
  }

  all(): readonly JournalEntry[] {
    this.assertHealthy();
    return [...this.entries];
  }

  get(entryId: string): JournalEntry | undefined {
    this.assertHealthy();
    return this.byId.get(entryId);
  }

  isReversed(entryId: string): boolean {
    this.assertHealthy();
    return this.reversedIds.has(entryId);
  }

  balance(account: AccountKey): AccountBalance {
    this.assertHealthy();
    return this.current.get(account) ?? ZERO_BALANCE;
  }

  /** Current balances, or balances as of an economic point in time (entries with occurredAt <= asOf). */
  balances(options: { asOf?: string } = {}): ReadonlyMap<AccountKey, AccountBalance> {
    this.assertHealthy();
    if (options.asOf === undefined) return new Map(this.current);
    const asOf = toTimestamp(options.asOf, 'asOf');
    const result = new Map<AccountKey, AccountBalance>();
    for (const entry of this.entries) {
      if (entry.occurredAt <= asOf) applyPostings(result, entry.postings);
    }
    return result;
  }

  /**
   * Validates, hashes, persists and applies an entry inside the store's critical section.
   * A draft factory and the guard see exactly the state the entry will be applied to.
   */
  append(input: JournalEntryDraft | DraftFactory, options: AppendOptions = {}): Promise<AppendResult> {
    const run = this.queue.then(() => this.appendNow(input, options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Catches up with entries committed by other processes (verified like everything else). */
  sync(): Promise<void> {
    const run = this.queue.then(async () => {
      this.assertHealthy();
      this.applyCommitted(await this.store.loadAfter(this.entries.length));
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Re-verifies the in-memory projection. */
  verifyIntegrity(): { ok: true } | { ok: false; issues: IntegrityIssue[] } {
    const report = verifyLedgerEntries(this.entries, { allowedCurrencies: this.store.allowedCurrencies });
    return report.ok ? { ok: true } : { ok: false, issues: report.issues };
  }

  /** Creates a checkpoint of the current head (to be stored outside the ledger database). */
  checkpoint(): LedgerCheckpoint {
    const head = this.head();
    return { ledgerId: head.ledgerId, sequence: head.sequence, hash: head.hash, createdAt: this.clock().toISOString(), signature: null };
  }

  private async appendNow(input: JournalEntryDraft | DraftFactory, options: AppendOptions): Promise<AppendResult> {
    this.assertHealthy();
    const result = await this.store.writeExclusive<AppendResult>(this.entries.length, (newer) => {
      this.applyCommitted(newer);

      // Idempotency first: a replayed event must not be re-evaluated against today's state.
      const plain = typeof input === 'function' ? null : input;
      const key = options.idempotencyKey ?? plain?.id;
      const early = key !== undefined ? this.byId.get(key) : undefined;
      if (early) {
        const fingerprint = options.requestFingerprint ?? (plain ? draftFingerprint(plain) : undefined);
        return { kind: 'none', result: this.replayResult(early, fingerprint) };
      }

      const draft = typeof input === 'function' ? rejectOnError(() => input(this.viewOf(this.current))) : input;
      if (options.idempotencyKey !== undefined && draft.id !== options.idempotencyKey) {
        throw new LedgerError('invalid_entry', 'draft id "' + draft.id + '" differs from idempotency key "' + options.idempotencyKey + '"');
      }
      const fingerprint = options.requestFingerprint ?? draftFingerprint(draft);
      const late = this.byId.get(draft.id);
      if (late) return { kind: 'none', result: this.replayResult(late, fingerprint) };

      const unsigned = {
        sequence: this.entries.length + 1,
        id: draft.id,
        occurredAt: toTimestamp(draft.occurredAt, 'occurredAt'),
        recordedAt: this.clock().toISOString(),
        type: draft.type,
        description: draft.description,
        postings: draft.postings.map(normalizePosting),
        refs: stripUndefined(draft.refs ?? {}),
        source: draft.source ?? 'engine',
        requestFingerprint: fingerprint,
        prevHash: this.lastHash,
      };
      const entry = deepFreezeEntry({ ...unsigned, hash: computeEntryHash(unsigned) });
      this.validateNew(entry);

      if (options.guard) {
        const after = new Map(this.current);
        applyPostings(after, entry.postings);
        const guard = options.guard;
        rejectOnError(() => guard(draft, this.viewOf(after)));
      }
      return { kind: 'append', entry, result: { status: 'APPLIED', entry } };
    });
    // Applied to the projection only after the store committed.
    if (result.status === 'APPLIED') this.apply(result.entry);
    return result;
  }

  private replayResult(existing: JournalEntry, fingerprint: string | undefined): AppendResult {
    if (fingerprint !== undefined && fingerprint === existing.requestFingerprint) return { status: 'ALREADY_APPLIED', entry: existing };
    throw new LedgerError('idempotency_conflict', 'id "' + existing.id + '" was already booked for a different request; refusing to book twice or overwrite');
  }

  private validateNew(entry: JournalEntry): void {
    const issues = structuralIssues(entry, this.store.allowedCurrencies);
    const first = issues[0];
    if (first) {
      const code = first.code === 'UNBALANCED' ? 'unbalanced' : first.code === 'UNSUPPORTED_CURRENCY' ? 'unsupported_currency' : 'invalid_entry';
      throw new LedgerError(code, issues.map((i) => i.message).join('; '));
    }
    if (entry.type === 'reversal') {
      const targetId = entry.refs.reversesEntryId;
      const target = targetId === undefined ? undefined : this.byId.get(targetId);
      if (!target) throw new LedgerError('unknown_entry', 'reversal of unknown entry "' + targetId + '"');
      if (target.type === 'reversal') throw new LedgerError('invalid_entry', 'a reversal cannot be reversed; book a new entry instead');
      if (this.reversedIds.has(target.id)) throw new LedgerError('already_reversed', 'entry "' + target.id + '" is already reversed');
    }
  }

  /** Applies entries committed by others, verifying chain continuity and content first. */
  private applyCommitted(newer: readonly JournalEntry[]): void {
    for (const entry of newer) {
      const issues: IntegrityIssue[] = [];
      if (entry.sequence !== this.entries.length + 1) issues.push({ code: 'SEQUENCE_GAP', sequence: entry.sequence, message: 'expected ' + (this.entries.length + 1) });
      if (entry.prevHash !== this.lastHash) issues.push({ code: 'BROKEN_CHAIN', sequence: entry.sequence, message: 'does not link to the local head' });
      if (computeEntryHash(entry) !== entry.hash) issues.push({ code: 'HASH_MISMATCH', sequence: entry.sequence, message: 'content does not match its hash' });
      if (this.byId.has(entry.id)) issues.push({ code: 'DUPLICATE_ID', sequence: entry.sequence, message: 'duplicate id ' + entry.id });
      issues.push(...structuralIssues(entry, this.store.allowedCurrencies).map((i) => ({ ...i, sequence: entry.sequence })));
      if (issues.length > 0) {
        this.corruption = new FinancialIntegrityError(issues, 'ledger ' + this.store.ledgerId);
        throw this.corruption;
      }
      this.apply(deepFreezeEntry(entry));
    }
  }

  private apply(entry: JournalEntry): void {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    if (entry.type === 'reversal' && entry.refs.reversesEntryId !== undefined) this.reversedIds.add(entry.refs.reversesEntryId);
    applyPostings(this.current, entry.postings);
  }

  private assertHealthy(): void {
    if (this.corruption) throw this.corruption;
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

function toTimestamp(value: string, label: string): string {
  try {
    return normalizeTimestamp(value);
  } catch {
    throw new LedgerError('invalid_entry', label + ' is not a valid ISO timestamp: "' + value + '"');
  }
}

function deepFreezeEntry(entry: JournalEntry): JournalEntry {
  for (const posting of entry.postings) Object.freeze(posting);
  Object.freeze(entry.postings);
  Object.freeze(entry.refs);
  return Object.freeze(entry);
}
