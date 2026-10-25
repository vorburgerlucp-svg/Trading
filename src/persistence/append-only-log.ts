// Generic append-only, hash-chained log: the persistence pattern for evidence, blackboard, memory,
// audit events, decision records and model governance (the capital ledger has its own store).
//
// Concurrency model (same as the ledger): the STORE owns the write critical section. In PostgreSQL
// that is one transaction holding a row lock on the log head, so several NEXUS processes can share a
// log safely. Inside it, the log first catches up with records committed by other processes
// (verifying their hashes), then checks idempotency, then appends. Process-local queues are only an
// optimisation, never the safety mechanism.
//
// Idempotency: re-appending an existing id with identical payload → ALREADY_APPLIED (nothing written);
// with a different payload → AppendOnlyLogError('idempotency_conflict').

import { hashOf } from './canonical-json.js';

export const GENESIS_HASH = '0'.repeat(64);

export interface LogRecord<T> {
  readonly sequence: number;
  readonly id: string;
  readonly recordedAt: string;
  readonly payload: T;
  readonly prevHash: string;
  readonly hash: string;
}

export type WriteDecision<T, R> = { kind: 'append'; record: LogRecord<T>; result: R } | { kind: 'none'; result: R };

export interface AppendOnlyStore<T> {
  loadAll(): Promise<readonly LogRecord<T>[]>;
  loadAfter(sequence: number): Promise<readonly LogRecord<T>[]>;
  /**
   * Single-writer critical section shared by every process using the same storage.
   * `decide` receives records committed after `knownSequence` and returns what to persist.
   * Persistence is atomic: the record is stored completely or not at all.
   */
  writeExclusive<R>(knownSequence: number, decide: (newer: readonly LogRecord<T>[]) => WriteDecision<T, R>): Promise<R>;
  /**
   * O22 Plan C review: like writeExclusive, and inside the SAME critical section also reads another log of the same storage (the
   * guard), so that no writer of the guard log can commit between that read and this write. In PostgreSQL: the guard log's head
   * row is locked FOR SHARE in the same transaction (after this log's FOR UPDATE: one fixed lock order), and its records after
   * `guard.knownSequence` are read in it. A writer of the guard log takes FOR UPDATE on that row and so waits, or has committed
   * before and is seen. Absent: the store cannot do this, and a guarded append is refused (never done without the guard).
   */
  writeExclusiveGuarded?<R, G>(knownSequence: number, guard: GuardRead<G>, decide: (newer: readonly LogRecord<T>[], guardNewer: readonly LogRecord<G>[]) => WriteDecision<T, R>): Promise<R>;
  /** The store that holds the data (a wrapper returns its inner store's target); used to find the guard log in the same storage. */
  storageTarget?(): AppendOnlyStore<T>;
}

/** O22 Plan C review: the other log a guarded write reads in its critical section. */
export interface GuardRead<G> {
  readonly store: AppendOnlyStore<G>;
  readonly knownSequence: number;
}

export type AppendOnlyLogErrorCode = 'idempotency_conflict' | 'integrity' | 'store_conflict' | 'invalid';

export class AppendOnlyLogError extends Error {
  override readonly name = 'AppendOnlyLogError';
  constructor(
    readonly code: AppendOnlyLogErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type AppendStatus = 'APPLIED' | 'ALREADY_APPLIED';

export interface LogOptions<T> {
  clock?: () => Date;
  onApply?: (record: LogRecord<T>) => void;
}

export interface LogAppendResult<T> {
  status: AppendStatus;
  record: LogRecord<T>;
}

/** Reference store for tests and development; enforces the same constraints as the database. */
export class InMemoryAppendOnlyStore<T> implements AppendOnlyStore<T> {
  private readonly records: LogRecord<T>[] = [];
  private readonly ids = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  async loadAll(): Promise<readonly LogRecord<T>[]> {
    return [...this.records];
  }

  async loadAfter(sequence: number): Promise<readonly LogRecord<T>[]> {
    return this.records.slice(sequence);
  }

  writeExclusive<R>(knownSequence: number, decide: (newer: readonly LogRecord<T>[]) => WriteDecision<T, R>): Promise<R> {
    const run = this.queue.then(() => {
      const decision = decide(this.records.slice(knownSequence));
      if (decision.kind === 'append') {
        const r = decision.record;
        const head = this.records.at(-1);
        if (r.sequence !== this.records.length + 1) throw new AppendOnlyLogError('store_conflict', 'expected sequence ' + (this.records.length + 1) + ', got ' + r.sequence);
        if (r.prevHash !== (head?.hash ?? GENESIS_HASH)) throw new AppendOnlyLogError('store_conflict', 'prevHash does not match the log head');
        if (this.ids.has(r.id)) throw new AppendOnlyLogError('store_conflict', 'duplicate id ' + r.id);
        this.records.push(r);
        this.ids.add(r.id);
      }
      return decision.result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The records, read synchronously inside another in-memory store's critical section (one event-loop turn: atomic). */
  recordsAfter(sequence: number): readonly LogRecord<T>[] {
    return this.records.slice(sequence);
  }

  writeExclusiveGuarded<R, G>(knownSequence: number, guard: GuardRead<G>, decide: (newer: readonly LogRecord<T>[], guardNewer: readonly LogRecord<G>[]) => WriteDecision<T, R>): Promise<R> {
    const target = guard.store.storageTarget?.() ?? guard.store;
    if (!(target instanceof InMemoryAppendOnlyStore)) return Promise.reject(new AppendOnlyLogError('invalid', 'a guarded write needs the guard log in the same storage'));
    // The guard's records are read synchronously in the same turn as the decision and the push: no other store can commit between.
    return this.writeExclusive(knownSequence, (newer) => decide(newer, (target as InMemoryAppendOnlyStore<G>).recordsAfter(guard.knownSequence)));
  }

  storageTarget(): AppendOnlyStore<T> {
    return this;
  }
}

export class AppendOnlyLog<T> {
  private readonly records: LogRecord<T>[] = [];
  private readonly byId = new Map<string, LogRecord<T>>();
  private queue: Promise<unknown> = Promise.resolve();
  private corruption: AppendOnlyLogError | null = null;

  private constructor(
    readonly name: string,
    private readonly store: AppendOnlyStore<T>,
    private readonly clock: () => Date,
    private readonly onApply: ((record: LogRecord<T>) => void) | undefined,
  ) {}

  /**
   * Loads and verifies the complete history; refuses to open a tampered log.
   * `onApply` sees every record exactly once, in order (own appends and records from other processes);
   * it lets a projection (e.g. the model registry) be derived from the log. Throwing marks the log corrupted.
   */
  static async open<T>(name: string, store: AppendOnlyStore<T>, options: LogOptions<T> = {}): Promise<AppendOnlyLog<T>> {
    const log = new AppendOnlyLog<T>(name, store, options.clock ?? (() => new Date()), options.onApply);
    log.applyVerified(await store.loadAll());
    return log;
  }

  static inMemory<T>(name: string, options: LogOptions<T> = {}): Promise<AppendOnlyLog<T>> {
    return AppendOnlyLog.open<T>(name, new InMemoryAppendOnlyStore<T>(), options);
  }

  get size(): number {
    return this.records.length;
  }

  /** True once an invalid stored record was detected; the log then refuses all reads and writes. */
  get corrupted(): boolean {
    return this.corruption !== null;
  }

  get headHash(): string {
    return this.records.at(-1)?.hash ?? GENESIS_HASH;
  }

  all(): readonly LogRecord<T>[] {
    this.assertHealthy();
    return [...this.records];
  }

  get(id: string): LogRecord<T> | undefined {
    this.assertHealthy();
    return this.byId.get(id);
  }

  /**
   * Appends (idempotently) and freezes the payload. `precondition` runs inside the critical section,
   * after records from other processes were applied, and can veto the append by throwing.
   */
  append<G = unknown>(id: string, payload: T, options: { precondition?: () => void; guard?: AppendGuard<G> } = {}): Promise<LogAppendResult<T>> {
    const run = this.queue.then(() => (options.guard ? this.appendGuardedNow(id, payload, options.guard, options.precondition) : this.appendNow(id, payload, options.precondition)));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Catches up with records committed by other processes (verified). */
  sync(): Promise<void> {
    const run = this.queue.then(async () => {
      this.assertHealthy();
      this.applyVerified(await this.store.loadAfter(this.records.length));
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  verifyIntegrity(): { ok: true } | { ok: false; sequence: number } {
    let prevHash = GENESIS_HASH;
    for (const record of this.records) {
      if (record.prevHash !== prevHash || hashRecord(record) !== record.hash) return { ok: false, sequence: record.sequence };
      prevHash = record.hash;
    }
    return { ok: true };
  }

  private async appendNow(id: string, payload: T, precondition: (() => void) | undefined): Promise<LogAppendResult<T>> {
    this.assertHealthy();
    if (typeof id !== 'string' || id.trim() === '') throw new AppendOnlyLogError('invalid', this.name + ': id is required');
    const result = await this.store.writeExclusive<LogAppendResult<T>>(this.records.length, (newer) => {
      this.applyVerified(newer);
      const existing = this.byId.get(id);
      if (existing) {
        if (hashOf(existing.payload) === hashOf(payload)) return { kind: 'none', result: { status: 'ALREADY_APPLIED', record: existing } };
        throw new AppendOnlyLogError('idempotency_conflict', this.name + ': id "' + id + '" already exists with different content');
      }
      precondition?.();
      const unsigned = { sequence: this.records.length + 1, id, recordedAt: this.clock().toISOString(), payload, prevHash: this.headHash };
      const created = deepFreeze({ ...unsigned, hash: hashRecord(unsigned) });
      return { kind: 'append', record: created, result: { status: 'APPLIED', record: created } };
    });
    // Applied only after the store committed; a failed write leaves the projection untouched.
    if (result.status === 'APPLIED') this.apply(result.record);
    return result;
  }

  /** O22 Plan C review: this log's records and store, as a guard of another log's append (read only; the log is not changed). */
  guardView(): { store: AppendOnlyStore<T>; records: readonly LogRecord<T>[] } {
    this.assertHealthy();
    return { store: this.store, records: [...this.records] };
  }

  /**
   * O22 Plan C review: an append whose decision also reads the guard log inside the same critical section (the store's
   * writeExclusiveGuarded). The guard's newer records are verified (sequence, chain, hash) against this process's copy, and
   * `guard.check` sees the guard log as it is in that critical section. Neither log is changed by the check itself.
   */
  private async appendGuardedNow<G>(id: string, payload: T, guard: AppendGuard<G>, precondition: (() => void) | undefined): Promise<LogAppendResult<T>> {
    this.assertHealthy();
    if (typeof id !== 'string' || id.trim() === '') throw new AppendOnlyLogError('invalid', this.name + ': id is required');
    if (this.store.writeExclusiveGuarded === undefined) throw new AppendOnlyLogError('invalid', this.name + ': the store cannot make a guarded write');
    const view = guard.log.guardView();
    const result = await this.store.writeExclusiveGuarded<LogAppendResult<T>, G>(this.records.length, { store: view.store, knownSequence: view.records.length }, (newer, guardNewer) => {
      this.applyVerified(newer);
      const existing = this.byId.get(id);
      if (existing) {
        if (hashOf(existing.payload) === hashOf(payload)) return { kind: 'none', result: { status: 'ALREADY_APPLIED', record: existing } };
        throw new AppendOnlyLogError('idempotency_conflict', this.name + ': id "' + id + '" already exists with different content');
      }
      const guardRecords = [...view.records];
      for (const record of guardNewer) {
        const head = guardRecords.at(-1)?.hash ?? GENESIS_HASH;
        if (record.sequence !== guardRecords.length + 1 || record.prevHash !== head || hashRecord(record) !== record.hash) {
          throw new AppendOnlyLogError('integrity', this.name + ': the guard log has an invalid record at sequence ' + record.sequence);
        }
        guardRecords.push(record);
      }
      guard.check(guardRecords);
      precondition?.();
      const unsigned = { sequence: this.records.length + 1, id, recordedAt: this.clock().toISOString(), payload, prevHash: this.headHash };
      const created = deepFreeze({ ...unsigned, hash: hashRecord(unsigned) });
      return { kind: 'append', record: created, result: { status: 'APPLIED', record: created } };
    });
    if (result.status === 'APPLIED') this.apply(result.record);
    return result;
  }

  private applyVerified(records: readonly LogRecord<T>[]): void {
    for (const record of records) {
      const expectedSequence = this.records.length + 1;
      const problem =
        record.sequence !== expectedSequence
          ? 'expected sequence ' + expectedSequence
          : record.prevHash !== this.headHash
            ? 'does not link to the local head'
            : hashRecord(record) !== record.hash
              ? 'content does not match its hash'
              : this.byId.has(record.id)
                ? 'duplicate id ' + record.id
                : null;
      if (problem) {
        this.corruption = new AppendOnlyLogError('integrity', this.name + ': invalid or tampered record at sequence ' + record.sequence + ' (' + problem + ')');
        throw this.corruption;
      }
      this.apply(deepFreeze(record));
    }
  }

  private apply(record: LogRecord<T>): void {
    this.records.push(record);
    this.byId.set(record.id, record);
    if (this.onApply) {
      try {
        this.onApply(record);
      } catch (error) {
        this.corruption = new AppendOnlyLogError('integrity', this.name + ': record ' + record.id + ' rejected by projection: ' + (error instanceof Error ? error.message : String(error)));
        throw error;
      }
    }
  }

  private assertHealthy(): void {
    if (this.corruption) throw this.corruption;
  }
}

/** O22 Plan C review: the guard of an append: another log read in the same critical section, and the check on it (throw = refuse). */
export interface AppendGuard<G> {
  readonly log: AppendOnlyLog<G>;
  readonly check: (records: readonly LogRecord<G>[]) => void;
}

export function hashRecord<T>(record: Omit<LogRecord<T>, 'hash'>): string {
  const { sequence, id, recordedAt, payload, prevHash } = record;
  return hashOf({ sequence, id, recordedAt, payload, prevHash });
}

/** Recursively freezes plain objects and arrays (class instances such as Decimal are already immutable). */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
