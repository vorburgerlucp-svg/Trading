import { BacktestRunConflictError, BacktestRunIntegrityError, verifyBacktestRun, type BacktestRunStore } from '../../backtest/backtest-store.js';
import type { BacktestRunResult } from '../../backtest/backtest-types.js';
import { hashOf } from '../canonical-json.js';
import { decodeJson, encodeJson } from '../json-codec.js';
import { ScannerRunConflictError, ScannerRunIntegrityError, verifyScannerRun, type ScannerRunStore } from '../../scanner/scanner-store.js';
import type { ScannerRun } from '../../scanner/scanner-types.js';
import { sealFor, verifySeal, type EvidenceSeal, type EvidenceSealKind, type Sealed } from '../evidence-seal.js';
import type { PgPool } from './pool.js';

async function rollbackQuietly(client: { query(sql: string): Promise<unknown> }): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* connection may already be gone */ }
}

/** Anything that can run a statement: a pool or a checked-out client. */
export type Queryable = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };

/** Canonical ISO UTC with milliseconds, exactly as the seals store and verify it. */
const ISO_MS_SQL = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** The database clock, read inside the caller's statement flow. clock_timestamp() moves during a transaction, unlike now(). */
export async function databaseClock(q: Queryable): Promise<string> {
  const row = (await q.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS ts`)).rows[0] as { ts: string };
  return row.ts;
}

/**
 * Seals a committed run in its own statement, after the commit. The seal's sealedAt is therefore an upper bound on the
 * commit time. recordedAt was read before the commit and is passed in.
 */
export async function sealCommittedRun(q: Queryable, kind: EvidenceSealKind, recordId: string, resultHash: string, recordedAt: string): Promise<void> {
  const sealedAt = await databaseClock(q);
  const seal = sealFor({ kind, recordId, resultHash, recordedAt, sealedAt });
  await q.query('INSERT INTO evidence_seals (kind, record_id, result_hash, recorded_at, sealed_at, seal_hash) VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6)', [
    seal.kind,
    seal.recordId,
    seal.resultHash,
    seal.recordedAt,
    seal.sealedAt,
    seal.sealHash,
  ]);
}

/** Loads and verifies the seal of a run. Null means the run has no seal (stored before sealing, or interrupted before it). */
export async function readSeal(pool: PgPool, kind: EvidenceSealKind, recordId: string, resultHash: string): Promise<EvidenceSeal | null> {
  const row = (
    await pool.query<{ result_hash: string; recorded_at: string; sealed_at: string; seal_hash: string }>(
      `SELECT result_hash, to_char(recorded_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS recorded_at, to_char(sealed_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS sealed_at, seal_hash
         FROM evidence_seals WHERE kind = $1 AND record_id = $2`,
      [kind, recordId],
    )
  ).rows[0];
  if (!row) return null;
  return verifySeal({ kind, recordId, resultHash: row.result_hash, recordedAt: row.recorded_at, sealedAt: row.sealed_at, sealHash: row.seal_hash }, { kind, recordId, resultHash });
}

export class PostgresScannerRunStore implements ScannerRunStore {
  constructor(private readonly pool: PgPool) {}

  async save(run: ScannerRun): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    verifyScannerRun(run);
    const resultHash = hashOf(run);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Read before the commit: a lower bound on the commit time (see evidence-seal.ts).
      const recordedAt = await databaseClock(client);
      const inserted = await client.query(
        'INSERT INTO scanner_runs (scanner_run_id,input_fingerprint,definition_id,definition_version,universe_id,universe_fingerprint,universe_point_in_time_safe,as_of,result,result_hash,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::timestamptz) ON CONFLICT (scanner_run_id) DO NOTHING',
        [run.scannerRunId, run.inputFingerprint, run.definitionId, run.definitionVersion, run.universeId, run.universeFingerprint, run.universeEvidence.strictDecisionTime, run.asOf, JSON.stringify(encodeJson(run)), resultHash, recordedAt],
      );
      if (inserted.rowCount !== 1) {
        const existing = (await client.query<{ result_hash: string }>('SELECT result_hash FROM scanner_runs WHERE scanner_run_id=$1', [run.scannerRunId])).rows[0];
        if (existing?.result_hash !== resultHash) throw new ScannerRunConflictError('scanner run already exists with different content');
        await client.query('COMMIT');
        return 'ALREADY_APPLIED';
      }
      for (const c of run.candidates) {
        await client.query(
          'INSERT INTO scanner_candidates (scanner_run_id,rank,instrument_id,quant_run_id,ranking_score,data_quality_status) VALUES ($1,$2,$3,$4,$5,$6)',
          [run.scannerRunId, c.rank, c.instrumentId, c.quantRunId, c.rankingScore, c.dataQualityStatus],
        );
      }
      await client.query('COMMIT');
      // After the commit, in its own statement: an upper bound on the commit time.
      await sealCommittedRun(client, 'scanner_run', run.scannerRunId, resultHash, recordedAt);
      return 'APPLIED';
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(scannerRunId: string): Promise<ScannerRun | null> {
    return (await this.getSealed(scannerRunId))?.record ?? null;
  }

  async getSealed(scannerRunId: string): Promise<Sealed<ScannerRun> | null> {
    const row = (await this.pool.query<{ result: unknown; result_hash: string }>('SELECT result,result_hash FROM scanner_runs WHERE scanner_run_id=$1', [scannerRunId])).rows[0];
    if (!row) return null;
    const run = decodeJson(row.result) as ScannerRun;
    if (hashOf(run) !== row.result_hash) throw new ScannerRunIntegrityError('stored scanner run hash mismatch');
    return { record: verifyScannerRun(run), seal: await readSeal(this.pool, 'scanner_run', scannerRunId, row.result_hash) };
  }
}

export class PostgresBacktestRunStore implements BacktestRunStore {
  constructor(private readonly pool: PgPool) {}

  async save(run: BacktestRunResult): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    verifyBacktestRun(run);
    const resultHash = hashOf(run);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Read before the commit: a lower bound on the commit time (see evidence-seal.ts).
      const recordedAt = await databaseClock(client);
      const inserted = await client.query(
        'INSERT INTO backtest_runs (backtest_run_id,input_fingerprint,engine_version,instrument_id,strategy_id,strategy_version,bars_processed,quality_grade,result,result_hash,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::timestamptz) ON CONFLICT (backtest_run_id) DO NOTHING',
        [run.backtestRunId, run.inputFingerprint, run.engineVersion, run.instrumentId, run.strategyId, run.strategyVersion, run.barsProcessed, run.quality.grade, JSON.stringify(encodeJson(run)), resultHash, recordedAt],
      );
      if (inserted.rowCount !== 1) {
        const existing = (await client.query<{ result_hash: string }>('SELECT result_hash FROM backtest_runs WHERE backtest_run_id=$1', [run.backtestRunId])).rows[0];
        if (existing?.result_hash !== resultHash) throw new BacktestRunConflictError('backtest run already exists with different content');
        await client.query('COMMIT');
        return 'ALREADY_APPLIED';
      }
      for (const fill of run.fills) {
        await client.query(
          'INSERT INTO backtest_fills (backtest_run_id,fill_id,instrument_id,side,reason,at,raw_price,execution_price,quantity,commission) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [run.backtestRunId, fill.fillId, fill.instrumentId, fill.side, fill.reason, fill.at, fill.rawPrice.toString(), fill.executionPrice.toString(), fill.quantity.toString(), fill.commission.toString()],
        );
      }
      for (const trade of run.trades) {
        await client.query(
          'INSERT INTO backtest_trades (backtest_run_id,trade_id,instrument_id,entry_fill_id,exit_fill_id,pnl,return_pct) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [run.backtestRunId, trade.tradeId, trade.instrumentId, trade.entry.fillId, trade.exit.fillId, trade.pnl.toString(), trade.returnPct],
        );
      }
      await client.query('COMMIT');
      // After the commit, in its own statement: an upper bound on the commit time.
      await sealCommittedRun(client, 'backtest_run', run.backtestRunId, resultHash, recordedAt);
      return 'APPLIED';
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(backtestRunId: string): Promise<BacktestRunResult | null> {
    return (await this.getSealed(backtestRunId))?.record ?? null;
  }

  async getSealed(backtestRunId: string): Promise<Sealed<BacktestRunResult> | null> {
    const row = (await this.pool.query<{ result: unknown; result_hash: string }>('SELECT result,result_hash FROM backtest_runs WHERE backtest_run_id=$1', [backtestRunId])).rows[0];
    if (!row) return null;
    const run = decodeJson(row.result) as BacktestRunResult;
    if (hashOf(run) !== row.result_hash) throw new BacktestRunIntegrityError('stored backtest run hash mismatch');
    return { record: verifyBacktestRun(run), seal: await readSeal(this.pool, 'backtest_run', backtestRunId, row.result_hash) };
  }
}
