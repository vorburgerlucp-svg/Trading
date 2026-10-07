// PostgreSQL implementation of the generic append-only log store (same locking scheme as the ledger:
// READ COMMITTED transaction + FOR UPDATE on the log head row). Payloads are stored as JSONB with a
// lossless codec; an optional projector writes normalized rows in the SAME transaction, so the
// relational view can never contain anything that is not in the hash-chained history.

import type { AppendOnlyStore, LogRecord, WriteDecision } from '../append-only-log.js';
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
  ) {}

  static async open<T>(pool: PgPool, logName: string, options: { projector?: Projector<T>; lockTimeoutMs?: number } = {}): Promise<PostgresAppendOnlyStore<T>> {
    await pool.query('INSERT INTO append_only_logs (log_name) VALUES ($1) ON CONFLICT (log_name) DO NOTHING', [logName]);
    return new PostgresAppendOnlyStore<T>(pool, logName, options.projector, options.lockTimeoutMs ?? 15_000);
  }

  loadAll(): Promise<readonly LogRecord<T>[]> {
    return this.loadAfterWith(this.pool, 0);
  }

  loadAfter(sequence: number): Promise<readonly LogRecord<T>[]> {
    return this.loadAfterWith(this.pool, sequence);
  }

  async writeExclusive<R>(knownSequence: number, decide: (newer: readonly LogRecord<T>[]) => WriteDecision<T, R>): Promise<R> {
    const client = await this.pool.connect();
    let failed: unknown;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SELECT set_config('lock_timeout', $1, true)", [String(this.lockTimeoutMs) + 'ms']);
      await client.query('SELECT head_sequence FROM append_only_logs WHERE log_name = $1 FOR UPDATE', [this.logName]);
      const decision = decide(await this.loadAfterWith(client, knownSequence));
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
      client.release(failed instanceof Error ? failed : undefined);
    }
  }

  private async loadAfterWith(queryable: PgPool | PgClient, sequence: number): Promise<readonly LogRecord<T>[]> {
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
