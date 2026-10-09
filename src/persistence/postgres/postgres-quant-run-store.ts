// PostgreSQL quant run audit store: immutable rows, idempotent by run id, conflict on a different
// result hash, integrity re-check on every read.

import { QuantRunConflictError, verifyRunRecord, type QuantRunStore } from '../../quant/quant-run-store.js';
import type { QuantRunRecord } from '../../quant/quant-types.js';
import type { Sealed } from '../evidence-seal.js';
import { decodeJson, encodeJson } from '../json-codec.js';
import { databaseClock, readSeal, sealCommittedRun } from './postgres-scanner-backtest-store.js';
import type { PgPool } from './pool.js';

export class PostgresQuantRunStore implements QuantRunStore {
  constructor(private readonly pool: PgPool) {}

  async save(record: QuantRunRecord): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    verifyRunRecord(record);
    const r = record.result;
    // Single statement (autocommit). recordedAt is read before it: a lower bound on the commit time.
    const recordedAt = await databaseClock(this.pool);
    const inserted = await this.pool.query(
      `INSERT INTO quant_runs (quant_run_id, instrument_id, source_id, bar_interval, session, adjustment, as_of, mode, use_case, stored_through, input_start, input_end, bar_count,
         input_fingerprint, engine_version, algorithm_versions, quality_severity, insufficient_data, result, result_hash, created_at, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19::jsonb, $20, $21, $22::timestamptz)
       ON CONFLICT (quant_run_id) DO NOTHING`,
      [
        r.quantRunId,
        r.instrumentId,
        r.series.source,
        r.series.interval,
        r.series.session,
        r.series.adjustment,
        r.asOf,
        r.mode,
        r.useCase,
        record.storedThrough === null ? null : String(record.storedThrough),
        r.inputStart,
        r.inputEnd,
        r.barCount,
        r.inputFingerprint,
        r.engineVersion,
        JSON.stringify(r.algorithmVersions),
        r.dataQuality.severity,
        r.insufficientData,
        JSON.stringify(encodeJson(r)),
        record.resultHash,
        record.createdAt,
        recordedAt,
      ],
    );
    if (inserted.rowCount === 1) {
      // After the commit (autocommit above): sealedAt is an upper bound on the commit time.
      await sealCommittedRun(this.pool, 'quant_run', r.quantRunId, record.resultHash, recordedAt);
      return 'APPLIED';
    }
    const existing = (await this.pool.query<{ result_hash: string }>('SELECT result_hash FROM quant_runs WHERE quant_run_id = $1', [r.quantRunId])).rows[0];
    if (existing?.result_hash !== record.resultHash) throw new QuantRunConflictError('quant run ' + r.quantRunId + ' already exists with a different result (non-determinism or unversioned algorithm change)');
    return 'ALREADY_APPLIED';
  }

  private toRecord(row: { result: unknown; result_hash: string; stored_through_text: string | null; created_at: Date }): QuantRunRecord {
    return verifyRunRecord({
      result: decodeJson(row.result) as QuantRunRecord['result'],
      resultHash: row.result_hash,
      storedThrough: row.stored_through_text === null ? null : Number(row.stored_through_text),
      createdAt: row.created_at.toISOString(),
    });
  }

  async get(quantRunId: string): Promise<QuantRunRecord | null> {
    return (await this.getSealed(quantRunId))?.record ?? null;
  }

  async getSealed(quantRunId: string): Promise<Sealed<QuantRunRecord> | null> {
    const row = (
      await this.pool.query<{ result: unknown; result_hash: string; stored_through_text: string | null; created_at: Date }>(
        'SELECT result, result_hash, stored_through::text AS stored_through_text, created_at FROM quant_runs WHERE quant_run_id = $1',
        [quantRunId],
      )
    ).rows[0];
    if (!row) return null;
    return { record: this.toRecord(row), seal: await readSeal(this.pool, 'quant_run', quantRunId, row.result_hash) };
  }

  async list(filter: { instrumentId?: string } = {}): Promise<QuantRunRecord[]> {
    const { rows } = await this.pool.query<{ result: unknown; result_hash: string; stored_through_text: string | null; created_at: Date }>(
      'SELECT result, result_hash, stored_through::text AS stored_through_text, created_at FROM quant_runs WHERE ($1::text IS NULL OR instrument_id = $1::text) ORDER BY created_at, quant_run_id',
      [filter.instrumentId ?? null],
    );
    return rows.map((r) => this.toRecord(r));
  }
}
