import { BacktestRunConflictError, BacktestRunIntegrityError, verifyBacktestRun, type BacktestRunStore } from '../../backtest/backtest-store.js';
import type { BacktestRunResult } from '../../backtest/backtest-types.js';
import { hashOf } from '../canonical-json.js';
import { decodeJson, encodeJson } from '../json-codec.js';
import { ScannerRunConflictError, ScannerRunIntegrityError, verifyScannerRun, type ScannerRunStore } from '../../scanner/scanner-store.js';
import type { ScannerRun } from '../../scanner/scanner-types.js';
import type { PgPool } from './pool.js';

async function rollbackQuietly(client: { query(sql: string): Promise<unknown> }): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* connection may already be gone */ }
}

export class PostgresScannerRunStore implements ScannerRunStore {
  constructor(private readonly pool: PgPool) {}

  async save(run: ScannerRun): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    verifyScannerRun(run);
    const resultHash = hashOf(run);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        'INSERT INTO scanner_runs (scanner_run_id,input_fingerprint,definition_id,definition_version,universe_id,universe_fingerprint,universe_point_in_time_safe,as_of,result,result_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT (scanner_run_id) DO NOTHING',
        [run.scannerRunId, run.inputFingerprint, run.definitionId, run.definitionVersion, run.universeId, run.universeFingerprint, run.universePointInTimeSafe, run.asOf, JSON.stringify(encodeJson(run)), resultHash],
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
      return 'APPLIED';
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(scannerRunId: string): Promise<ScannerRun | null> {
    const row = (await this.pool.query<{ result: unknown; result_hash: string }>('SELECT result,result_hash FROM scanner_runs WHERE scanner_run_id=$1', [scannerRunId])).rows[0];
    if (!row) return null;
    const run = decodeJson(row.result) as ScannerRun;
    if (hashOf(run) !== row.result_hash) throw new ScannerRunIntegrityError('stored scanner run hash mismatch');
    return verifyScannerRun(run);
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
      const inserted = await client.query(
        'INSERT INTO backtest_runs (backtest_run_id,input_fingerprint,engine_version,instrument_id,strategy_id,strategy_version,bars_processed,quality_grade,result,result_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT (backtest_run_id) DO NOTHING',
        [run.backtestRunId, run.inputFingerprint, run.engineVersion, run.instrumentId, run.strategyId, run.strategyVersion, run.barsProcessed, run.quality.grade, JSON.stringify(encodeJson(run)), resultHash],
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
      return 'APPLIED';
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(backtestRunId: string): Promise<BacktestRunResult | null> {
    const row = (await this.pool.query<{ result: unknown; result_hash: string }>('SELECT result,result_hash FROM backtest_runs WHERE backtest_run_id=$1', [backtestRunId])).rows[0];
    if (!row) return null;
    const run = decodeJson(row.result) as BacktestRunResult;
    if (hashOf(run) !== row.result_hash) throw new BacktestRunIntegrityError('stored backtest run hash mismatch');
    return verifyBacktestRun(run);
  }
}
