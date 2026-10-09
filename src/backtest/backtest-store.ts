import { parseUtc } from '../market-data/time.js';
import { hashOf } from '../persistence/canonical-json.js';
import { isoMs, sealFor, verifySeal, type EvidenceSeal, type Sealed } from '../persistence/evidence-seal.js';
import type { BacktestRunResult } from './backtest-types.js';

export class BacktestRunConflictError extends Error {
  override readonly name = 'BacktestRunConflictError';
}
export class BacktestRunIntegrityError extends Error {
  override readonly name = 'BacktestRunIntegrityError';
}

/**
 * Warm-up metadata must be internally consistent. A run below the hard gate must show no decision, order or fill and
 * must be INVALID. A run that traded must not have a fill before its first evaluation. backtest-engine:v1 runs have no
 * warm-up metadata and are accepted only as such: they stay readable, but they cannot prove a warm-up.
 */
function verifyWarmup(run: BacktestRunResult): void {
  const w = run.warmup;
  if (w === undefined) {
    if (run.engineVersion !== 'backtest-engine:v1') throw new BacktestRunIntegrityError('warm-up metadata is missing');
    return;
  }
  if (typeof w.algorithmVersion !== 'string' || w.algorithmVersion.trim() === '') throw new BacktestRunIntegrityError('warm-up algorithmVersion is missing');
  if (!Number.isSafeInteger(w.requiredBars) || w.requiredBars < 1 || !Number.isSafeInteger(w.preferredBars) || w.preferredBars < w.requiredBars) {
    throw new BacktestRunIntegrityError('warm-up plan is malformed');
  }
  if (w.requiredWarmupMet !== (run.barsProcessed >= w.requiredBars)) throw new BacktestRunIntegrityError('requiredWarmupMet does not match barsProcessed');
  if (w.warmupBars + w.tradableBars !== run.barsProcessed) throw new BacktestRunIntegrityError('warm-up bar counts do not add up to barsProcessed');
  if (w.strategyEvaluations !== w.tradableBars) throw new BacktestRunIntegrityError('strategy evaluations must equal tradable bars');
  if (w.preferredWarmupMet !== (w.strategyEvaluations > 0 && w.evaluationsBelowPreferred === 0)) throw new BacktestRunIntegrityError('preferredWarmupMet does not match evaluations');
  if (!w.requiredWarmupMet) {
    if (w.strategyEvaluations !== 0 || w.firstStrategyEvaluationAt !== null || run.fills.length !== 0 || run.trades.length !== 0 || run.openPosition !== null) {
      throw new BacktestRunIntegrityError('run below the warm-up gate shows a decision, order or fill');
    }
    if (run.quality.grade !== 'INVALID') throw new BacktestRunIntegrityError('run below the warm-up gate must be INVALID');
    return;
  }
  if (w.firstStrategyEvaluationAt === null) throw new BacktestRunIntegrityError('strategy was evaluated but firstStrategyEvaluationAt is missing');
  const firstMs = parseUtc(w.firstStrategyEvaluationAt);
  if (run.fills.some((fill) => parseUtc(fill.at) < firstMs)) throw new BacktestRunIntegrityError('fill before the first strategy evaluation');
}

export function verifyBacktestRun(run: BacktestRunResult): BacktestRunResult {
  if (!/^[0-9a-f]{64}$/.test(run.inputFingerprint)) throw new BacktestRunIntegrityError('invalid backtest input fingerprint');
  if (!/^[0-9a-f]{64}$/.test(run.strategyFingerprint)) throw new BacktestRunIntegrityError('invalid strategy fingerprint');
  const strategyHash = hashOf({ id: run.strategyId, version: run.strategyVersion, definition: run.strategyDefinition });
  if (strategyHash !== run.strategyFingerprint) throw new BacktestRunIntegrityError('strategy metadata checksum mismatch');
  if (run.backtestRunId !== 'bt_' + run.inputFingerprint.slice(0, 40)) throw new BacktestRunIntegrityError('backtestRunId does not match input fingerprint');
  if (run.metrics.numberOfTrades !== run.trades.length) throw new BacktestRunIntegrityError('trade count does not match metrics');
  verifyWarmup(run);
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
  /** The run with its commit seal (null seal: stored before sealing existed, so its time is not provable). */
  getSealed(backtestRunId: string): Promise<Sealed<BacktestRunResult> | null>;
}

export class InMemoryBacktestRunStore implements BacktestRunStore {
  private readonly runs = new Map<string, { run: BacktestRunResult; hash: string; seal: EvidenceSeal }>();
  private readonly clock: () => Date;

  constructor(options: { clock?: () => Date } = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  async save(run: BacktestRunResult): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    verifyBacktestRun(run);
    const hash = hashOf(run);
    const existing = this.runs.get(run.backtestRunId);
    if (existing) {
      if (existing.hash !== hash) throw new BacktestRunConflictError('backtest run already exists with different content');
      return 'ALREADY_APPLIED';
    }
    // Test double for the database: recordedAt is read before the "commit", sealedAt after it.
    const recordedAt = isoMs(this.clock());
    const sealedAt = isoMs(this.clock());
    const seal = sealFor({ kind: 'backtest_run', recordId: run.backtestRunId, resultHash: hash, recordedAt, sealedAt });
    this.runs.set(run.backtestRunId, { run, hash, seal });
    return 'APPLIED';
  }

  async getSealed(backtestRunId: string): Promise<Sealed<BacktestRunResult> | null> {
    const stored = this.runs.get(backtestRunId);
    if (!stored) return null;
    if (hashOf(stored.run) !== stored.hash) throw new BacktestRunIntegrityError('stored backtest run hash mismatch');
    return { record: verifyBacktestRun(stored.run), seal: verifySeal(stored.seal, { kind: 'backtest_run', recordId: backtestRunId, resultHash: stored.hash }) };
  }

  async get(backtestRunId: string): Promise<BacktestRunResult | null> {
    return (await this.getSealed(backtestRunId))?.record ?? null;
  }
}
