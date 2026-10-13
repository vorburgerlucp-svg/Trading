// Ledger persistence port.
//
// The STORE owns the write critical section, because only the storage can serialize writers across
// processes. PostgreSQL: one READ COMMITTED transaction holding `SELECT ... FOR UPDATE` on the ledger
// head row; every NEXUS server appends through that lock, so there is exactly one linear history.
// Inside the section the ledger first catches up with entries committed by other servers, then
// checks idempotency and business rules against that true latest state, then the store persists the
// entry with all lines atomically. Database constraints repeat the structural invariants as a
// second line of defense.

import { GENESIS_HASH } from '../persistence/append-only-log.js';
import type { JournalEntry } from './capital-types.js';
import { BASE_LEDGER_CURRENCY, structuralIssues } from './ledger-integrity.js';
import { LedgerError } from './ledger-errors.js';

export type LedgerWriteDecision<R> = { kind: 'append'; entry: JournalEntry; result: R } | { kind: 'none'; result: R };

export interface LedgerStore {
  readonly ledgerId: string;
  readonly allowedCurrencies: readonly string[];
  loadAll(): Promise<readonly JournalEntry[]>;
  loadAfter(sequence: number): Promise<readonly JournalEntry[]>;
  /**
   * Runs `decide` inside the cross-process critical section with all entries committed after
   * `knownSequence`, then persists the returned entry atomically (all lines or nothing).
   */
  writeExclusive<R>(knownSequence: number, decide: (newer: readonly JournalEntry[]) => LedgerWriteDecision<R>): Promise<R>;
}

/**
 * Reference implementation for tests and development. It enforces the same storage constraints as
 * the PostgreSQL schema (sequence, chain link, unique id, single reversal, structure, currency), so
 * contract tests can run the identical suite against both.
 */
export class InMemoryLedgerStore implements LedgerStore {
  private readonly entries: JournalEntry[] = [];
  private readonly ids = new Set<string>();
  private readonly reversed = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly ledgerId = 'main',
    readonly allowedCurrencies: readonly string[] = [BASE_LEDGER_CURRENCY],
  ) {}

  async loadAll(): Promise<readonly JournalEntry[]> {
    return [...this.entries];
  }

  async loadAfter(sequence: number): Promise<readonly JournalEntry[]> {
    return this.entries.slice(sequence);
  }

  writeExclusive<R>(knownSequence: number, decide: (newer: readonly JournalEntry[]) => LedgerWriteDecision<R>): Promise<R> {
    const run = this.queue.then(() => {
      const decision = decide(this.entries.slice(knownSequence));
      if (decision.kind === 'append') {
        assertStorable(decision.entry, this.entries.at(-1), this.ids, this.reversed, this.allowedCurrencies);
        this.entries.push(decision.entry);
        this.ids.add(decision.entry.id);
        if (decision.entry.refs.reversesEntryId !== undefined) this.reversed.add(decision.entry.refs.reversesEntryId);
      }
      return decision.result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** TEST ONLY: appends a raw entry bypassing every check (simulates a forged write by another party). */
  appendRawForTest(entry: JournalEntry): void {
    this.entries.push(entry);
  }

  /** TEST ONLY: simulates a privileged write that bypasses the application (tampering). */
  tamperForTest(sequence: number, replace: (entry: JournalEntry) => JournalEntry): void {
    const index = sequence - 1;
    const entry = this.entries[index];
    if (!entry) throw new Error('no entry at sequence ' + sequence);
    this.entries[index] = replace(entry);
  }
}

/** Storage-level constraints, mirrored by the PostgreSQL schema (see db/migrations). */
export function assertStorable(
  entry: JournalEntry,
  head: JournalEntry | undefined,
  ids: ReadonlySet<string>,
  reversed: ReadonlySet<string>,
  allowedCurrencies: readonly string[],
): void {
  const reject = (message: string): never => {
    throw new LedgerError('store_rejected', 'storage rejected entry "' + entry.id + '": ' + message);
  };
  if (entry.sequence !== (head?.sequence ?? 0) + 1) reject('sequence ' + entry.sequence + ' does not follow head ' + (head?.sequence ?? 0));
  if (entry.prevHash !== (head?.hash ?? GENESIS_HASH)) reject('prevHash does not match the ledger head');
  if (ids.has(entry.id)) reject('duplicate id (idempotency key)');
  const target = entry.refs.reversesEntryId;
  if (target !== undefined && reversed.has(target)) reject('entry ' + target + ' is already reversed');
  const issues = structuralIssues(entry, allowedCurrencies);
  if (issues.length > 0) reject(issues.map((i) => i.message).join('; '));
}
