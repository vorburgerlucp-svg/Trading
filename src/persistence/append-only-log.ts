// Generic append-only, hash-chained log: the persistence pattern for evidence, blackboard, memory
// and the decision audit trail (the capital ledger has its own, more specific implementation).
//
// Persistence port: AppendOnlyStore. InMemoryAppendOnlyStore is used in tests and development;
// the target for production is PostgreSQL (append-only table, unique (log, sequence) and (log, id),
// no UPDATE/DELETE grants). Records are frozen after append; corrections are new records.

import { GENESIS_HASH } from '../capital/capital-ledger.js';
import { hashOf } from './canonical-json.js';

export interface LogRecord<T> {
  readonly sequence: number;
  readonly id: string;
  readonly recordedAt: string;
  readonly payload: T;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AppendOnlyStore<T> {
  loadAll(): Promise<readonly LogRecord<T>[]>;
  /** Must reject unless record.sequence === number of stored records + 1. */
  append(record: LogRecord<T>): Promise<void>;
}

export type AppendOnlyLogErrorCode = 'duplicate_id' | 'integrity' | 'store_conflict' | 'invalid';

export class AppendOnlyLogError extends Error {
  override readonly name = 'AppendOnlyLogError';
  constructor(
    readonly code: AppendOnlyLogErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class InMemoryAppendOnlyStore<T> implements AppendOnlyStore<T> {
  private readonly records: LogRecord<T>[] = [];

  async loadAll(): Promise<readonly LogRecord<T>[]> {
    return [...this.records];
  }

  async append(record: LogRecord<T>): Promise<void> {
    if (record.sequence !== this.records.length + 1) {
      throw new AppendOnlyLogError('store_conflict', 'expected sequence ' + (this.records.length + 1) + ', got ' + record.sequence);
    }
    this.records.push(record);
  }
}

export class AppendOnlyLog<T> {
  private readonly records: LogRecord<T>[] = [];
  private readonly byId = new Map<string, LogRecord<T>>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly name: string,
    private readonly store: AppendOnlyStore<T>,
    private readonly clock: () => Date,
  ) {}

  static async open<T>(name: string, store: AppendOnlyStore<T>, options: { clock?: () => Date } = {}): Promise<AppendOnlyLog<T>> {
    const log = new AppendOnlyLog<T>(name, store, options.clock ?? (() => new Date()));
    let prevHash = GENESIS_HASH;
    for (const [index, record] of (await store.loadAll()).entries()) {
      if (record.sequence !== index + 1) throw new AppendOnlyLogError('integrity', name + ': sequence gap at ' + (index + 1));
      if (record.prevHash !== prevHash || hashRecord(record) !== record.hash) {
        throw new AppendOnlyLogError('integrity', name + ': tampered record at sequence ' + record.sequence);
      }
      log.apply(deepFreeze(record));
      prevHash = record.hash;
    }
    return log;
  }

  static inMemory<T>(name: string, options: { clock?: () => Date } = {}): Promise<AppendOnlyLog<T>> {
    return AppendOnlyLog.open<T>(name, new InMemoryAppendOnlyStore<T>(), options);
  }

  get size(): number {
    return this.records.length;
  }

  all(): readonly LogRecord<T>[] {
    return [...this.records];
  }

  get(id: string): LogRecord<T> | undefined {
    return this.byId.get(id);
  }

  /** Appends and freezes the payload. Appends are serialized; IDs are unique (idempotency). */
  append(id: string, payload: T): Promise<LogRecord<T>> {
    const run = this.queue.then(async () => {
      if (id.trim() === '') throw new AppendOnlyLogError('invalid', this.name + ': id is required');
      if (this.byId.has(id)) throw new AppendOnlyLogError('duplicate_id', this.name + ': id "' + id + '" already exists');
      const unsigned = {
        sequence: this.records.length + 1,
        id,
        recordedAt: this.clock().toISOString(),
        payload,
        prevHash: this.records.at(-1)?.hash ?? GENESIS_HASH,
      };
      const record = deepFreeze({ ...unsigned, hash: hashRecord(unsigned) });
      await this.store.append(record);
      this.apply(record);
      return record;
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

  private apply(record: LogRecord<T>): void {
    this.records.push(record);
    this.byId.set(record.id, record);
  }
}

function hashRecord<T>(record: Omit<LogRecord<T>, 'hash'>): string {
  const { sequence, id, recordedAt, payload, prevHash } = record;
  return hashOf({ sequence, id, recordedAt, payload, prevHash });
}

/** Recursively freezes plain objects and arrays (class instances such as Decimal are already immutable). */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
