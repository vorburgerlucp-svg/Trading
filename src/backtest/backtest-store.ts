import { hashOf } from '../persistence/canonical-json.js';
import type { BacktestRunResult } from './backtest-types.js';

export class BacktestRunConflictError extends Error {
  override readonly name = 'BacktestRunConflictError';
}
export class BacktestRunIntegrityError extends Error {
  override readonly name = 'BacktestRunIntegrityError';
}

export function verifyBacktestRun(run: BacktestRunResult): BacktestRunResult {
  if (!/^[0-9a-f]{64}$/.test(run.inputFingerprint)) throw new BacktestRunIntegrityError('invalid backtest input fingerprint');
  if (!/^[0-9a-f]{64}$/.test(run.strategyFingerprint)) throw new BacktestRunIntegrityError('invalid strategy fingerprint');
  if (run.backtestRunId !== 'bt_' + run.inputFingerprint.slice(0, 40)) throw new BacktestRunIntegrityError('backtestRunId does not match input fingerprint');
  if (run.metrics.numberOfTrades !== run.trades.length) throw new BacktestRunIntegrityError('trade count does not match metrics');
  const fillIds = new Set<string>();
  for (const fill of run.fills) {
    if (fill.instrumentId !== run.instrumentId || fillIds.has(fill.fillId)) throw new BacktestRunIntegrityError('invalid or duplicate fill');
    fillIds.add(fill.fillId);
  }
  for (const trade of run.trades) {
    if (!Number.isFinite(trade.returnPct)) throw new BacktestRunIntegrityError('trade return is not finite');
    if (trade.instrumentId !== run.instrumentId || !fillIds.has(trade.entry.fillId) || !fillIds.has(trade.exit.fillId)) {
      throw new BacktestRunIntegrityError('trade references invalid fills');
    }
  }
  const finiteMetrics = [run.metrics.returnPct, run.metrics.maxDrawdownPct, run.metrics.exposurePct];
  if (run.metrics.winRate !== null) finiteMetrics.push(run.metrics.winRate);
  if (run.metrics.profitFactor !== null) finiteMetrics.push(run.metrics.profitFactor);
  if (finiteMetrics.some((n) => !Number.isFinite(n))) throw new BacktestRunIntegrityError('backtest metrics contain non-finite values');
  const lastEquity = run.equityCurve.at(-1)?.equity;
  if (lastEquity && !lastEquity.eq(run.metrics.endingEquity)) throw new BacktestRunIntegrityError('ending equity does not match equity curve');
  return run;
}

export interface BacktestRunStore {
  save(run: BacktestRunResult): Promise<'APPLIED' | 'ALREADY_APPLIED'>;
  get(backtestRunId: string): Promise<BacktestRunResult | null>;
}

export class InMemoryBacktestRunStore implements BacktestRunStore {
  private readonly runs = new Map<string, { run: BacktestRunResult; hash: string }>();

  async save(run: BacktestRunResult): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    verifyBacktestRun(run);
    const hash = hashOf(run);
    const existing = this.runs.get(run.backtestRunId);
    if (existing) {
      if (existing.hash !== hash) throw new BacktestRunConflictError('backtest run already exists with different content');
      return 'ALREADY_APPLIED';
    }
    this.runs.set(run.backtestRunId, { run, hash });
    return 'APPLIED';
  }

  async get(backtestRunId: string): Promise<BacktestRunResult | null> {
    const stored = this.runs.get(backtestRunId);
    if (!stored) return null;
    if (hashOf(stored.run) !== stored.hash) throw new BacktestRunIntegrityError('stored backtest run hash mismatch');
    return verifyBacktestRun(stored.run);
  }
}
