// PostgreSQL implementation of the generic append-only log store (same locking scheme as the ledger:
// READ COMMITTED transaction + FOR UPDATE on the log head row). Payloads are stored as JSONB with a
// lossless codec; an optional projector writes normalized rows in the SAME transaction, so the
// relational view can never contain anything that is not in the hash-chained history.

import { AppendOnlyLogError, type AppendOnlyStore, type GuardRead, type LogRecord, type WriteDecision } from '../append-only-log.js';
import { decodeJson, encodeJson } from '../json-codec.js';
import { mapLogDbError } from './pg-errors.js';
import type { PgClient, PgPool } from './pool.js';

export type Projector<T> = (client: PgClient, record: LogRecord<T>) => Promise<void>;

interface Row {
  sequence_text: string;
  record_id: string;
  recorded_at: Date;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

export class PostgresAppendOnlyStore<T> implements AppendOnlyStore<T> {
  private constructor(
    private readonly pool: PgPool,
    readonly logName: string,
    private readonly projector: Projector<T> | undefined,
    private readonly lockTimeoutMs: number,
    private readonly readOnly = false,
  ) {}

  static async open<T>(pool: PgPool, logName: string, options: { projector?: Projector<T>; lockTimeoutMs?: number } = {}): Promise<PostgresAppendOnlyStore<T>> {
    await pool.query('INSERT INTO append_only_logs (log_name) VALUES ($1) ON CONFLICT (log_name) DO NOTHING', [logName]);
    return new PostgresAppendOnlyStore<T>(pool, logName, options.projector, options.lockTimeoutMs ?? 15_000);
  }

  /**
   * O22: a store that can only read. Opening it writes nothing (no log head row is created), and every append is refused before
   * any statement. A missing log reads as empty. Used by inspection and dry-run tools.
   */
  static openReadOnly<T>(pool: PgPool, logName: string): PostgresAppendOnlyStore<T> {
    return new PostgresAppendOnlyStore<T>(pool, logName, undefined, 15_000, true);
  }

  loadAll(): Promise<readonly LogRecord<T>[]> {
    return this.loadAfterWith(this.pool, 0);
  }

  loadAfter(sequence: number): Promise<readonly LogRecord<T>[]> {
    return this.loadAfterWith(this.pool, sequence);
  }

  async writeExclusive<R>(knownSequence: number, decide: (newer: readonly LogRecord<T>[]) => WriteDecision<T, R>): Promise<R> {
    return this.write(knownSequence, async () => [], (newer) => decide(newer));
  }

  /**
   * O22 Plan C review: in the same transaction, after this log's head row FOR UPDATE, the guard log's head row FOR SHARE and its
   * records after `guard.knownSequence`. Lock order: always this log first, then the guard; a writer of the guard log alone takes
   * only the guard's row (FOR UPDATE) and waits for this transaction, so it can neither commit in between nor deadlock with it as
   * long as no writer of the guard takes this log's row while holding the guard's (the service never does).
   */
  async writeExclusiveGuarded<R, G>(knownSequence: number, guard: GuardRead<G>, decide: (newer: readonly LogRecord<T>[], guardNewer: readonly LogRecord<G>[]) => WriteDecision<T, R>): Promise<R> {
    const target = guard.store.storageTarget?.() ?? guard.store;
    if (!(target instanceof PostgresAppendOnlyStore) || target.pool !== this.pool || target.logName === this.logName) {
      throw new AppendOnlyLogError('invalid', 'a guarded write needs another log of the same PostgreSQL storage');
    }
    const guardStore = target as PostgresAppendOnlyStore<G>;
    return this.write(knownSequence, async (client) => {
      await client.query('SELECT head_sequence FROM append_only_logs WHERE log_name = $1 FOR SHARE', [guardStore.logName]);
      return guardStore.loadAfterWith(client, guard.knownSequence);
    }, decide);
  }

  storageTarget(): AppendOnlyStore<T> {
    return this;
  }

  private async write<R, G>(knownSequence: number, readGuard: (client: PgClient) => Promise<readonly LogRecord<G>[]>, decide: (newer: readonly LogRecord<T>[], guardNewer: readonly LogRecord<G>[]) => WriteDecision<T, R>): Promise<R> {
    if (this.readOnly) throw new Error('read-only store: ' + this.logName + ' cannot be written');
    const client = await this.pool.connect();
    let failed: unknown;
    // A connection that dies mid-transaction emits 'error' on the client; without a listener that
    // would crash the process. The failure surfaces through the pending query instead.
    const onConnectionError = (error: Error) => {
      failed = failed ?? error;
    };
    client.on('error', onConnectionError);
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SELECT set_config('lock_timeout', $1, true)", [String(this.lockTimeoutMs) + 'ms']);
      await client.query('SELECT head_sequence FROM append_only_logs WHERE log_name = $1 FOR UPDATE', [this.logName]);
      const newer = await this.loadAfterWith(client, knownSequence);
      const guardNewer = await readGuard(client);
      const decision = decide(newer, guardNewer);
      if (decision.kind === 'append') {
        const r = decision.record;
        await client.query(
          'INSERT INTO append_only_records (log_name, sequence, record_id, recorded_at, payload, prev_hash, hash) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)',
          [this.logName, r.sequence, r.id, r.recordedAt, JSON.stringify(encodeJson(r.payload)), r.prevHash, r.hash],
        );
        await this.projector?.(client, r);
      }
      await client.query('COMMIT');
      return decision.result;
    } catch (error) {
      failed = error;
      try {
        await client.query('ROLLBACK');
      } catch {
        // connection already gone
      }
      throw mapLogDbError(error);
    } finally {
      client.off('error', onConnectionError);
      // A client that saw an error is discarded rather than reused.
      client.release(failed instanceof Error ? failed : undefined);
    }
  }

  /** @internal Also used, within a guarded write, on the guard log of the same storage. */
  async loadAfterWith(queryable: PgPool | PgClient, sequence: number): Promise<readonly LogRecord<T>[]> {
    const { rows } = await queryable.query<Row>(
      // ORDER BY the table column, never the text alias (text order would put 10 before 9).
      'SELECT r.sequence::text AS sequence_text, r.record_id, r.recorded_at, r.payload, r.prev_hash, r.hash FROM append_only_records r WHERE r.log_name = $1 AND r.sequence > $2 ORDER BY r.sequence',
      [this.logName, sequence],
    );
    return rows.map((row) => ({
      sequence: Number(row.sequence_text),
      id: row.record_id,
      recordedAt: row.recorded_at.toISOString(),
      payload: decodeJson(row.payload) as T,
      prevHash: row.prev_hash,
      hash: row.hash,
    }));
  }
}
