import { parseUtc } from '../market-data/time.js';
import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import { isoMs, sealFor, verifySeal, type EvidenceSeal, type Sealed } from '../persistence/evidence-seal.js';
import { CORPORATE_ACTION_ENGINE_VERSION, CORPORATE_ACTION_POLICY_VERSION, CORPORATE_ACTION_REASON_TEXT } from './corporate-action-engine.js';
import { EXECUTION_CLOCK_VERSION } from './execution-clock.js';
import type { BacktestCorporateActionResult, BacktestRunResult } from './backtest-types.js';

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

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The corporate-action audit must agree with itself and with the run. Each limitation is one code, the grade is never A or B while a
 * limitation is recorded, every applied action has both state fingerprints, every split was value-neutral, and a dividend receivable
 * is never settled (V1 has no payment date) and never cash.
 */
function verifyCorporateActions(run: BacktestRunResult, ca: BacktestCorporateActionResult): void {
  if (ca.engineVersion !== CORPORATE_ACTION_ENGINE_VERSION || ca.policyVersion !== CORPORATE_ACTION_POLICY_VERSION) {
    throw new BacktestRunIntegrityError('corporate-action engine or policy version does not match this implementation');
  }
  if (new Set(ca.reasons).size !== ca.reasons.length) throw new BacktestRunIntegrityError('corporate-action reasons repeat a code');
  if (ca.complete !== (ca.reasons.length === 0)) throw new BacktestRunIntegrityError('corporate-action completeness does not match its reasons');
  for (const code of ca.reasons) {
    if (!(code in CORPORATE_ACTION_REASON_TEXT) || code === 'ACTION_BEFORE_SERIES') throw new BacktestRunIntegrityError('unknown corporate-action reason ' + code);
    if (!run.quality.reasons.some((r) => r.startsWith(code + ':'))) throw new BacktestRunIntegrityError('quality does not report corporate-action reason ' + code);
  }
  if (ca.reasons.length > 0 && (run.quality.grade === 'A' || run.quality.grade === 'B')) throw new BacktestRunIntegrityError('a run with a corporate-action limitation cannot be graded ' + run.quality.grade);
  if (ca.pending.length > 0 && !ca.reasons.includes('CORPORATE_ACTION_PENDING_AT_END')) throw new BacktestRunIntegrityError('pending corporate actions are not reported as a limitation');
  for (const a of ca.applied) {
    if (!HEX64.test(a.beforeStateFingerprint) || !HEX64.test(a.afterStateFingerprint)) throw new BacktestRunIntegrityError('applied action ' + a.actionKey + ' has no state fingerprints');
    if (typeof a.source !== 'string' || a.source.trim() === '') throw new BacktestRunIntegrityError('applied action ' + a.actionKey + ' does not name its source');
    // The transformation takes effect at the effective instant; the event that processed it is not earlier than that.
    if (a.appliedAt !== a.effectiveAt) throw new BacktestRunIntegrityError('action ' + a.actionKey + ' is not applied at its effective instant');
    if (parseUtc(a.processedAt) < parseUtc(a.appliedAt)) throw new BacktestRunIntegrityError('action ' + a.actionKey + ' was processed before it was applied');
    // The economic knowledge boundary: an action whose state changed at its effective instant must have been known by then.
    if (a.knowledgeAt === null || parseUtc(a.knowledgeAt) > parseUtc(a.effectiveAt)) throw new BacktestRunIntegrityError('action ' + a.actionKey + ' changed state without knowledge at its effective instant');
  }
  for (const c of ca.valueNeutralityChecks) {
    if (c.neutral !== true) throw new BacktestRunIntegrityError('split ' + c.actionKey + ' is not value-neutral');
  }
  for (const r of ca.dividendReceivables) {
    if (r.settlement !== 'UNSETTLED' || r.settledAt !== null || r.paymentDate !== null) throw new BacktestRunIntegrityError('receivable ' + r.receivableId + ' is settled without a payment date');
    if (!Decimal.from(r.grossAmount).eq(Decimal.from(r.entitledQuantity).times(r.amountPerShare))) throw new BacktestRunIntegrityError('receivable ' + r.receivableId + ' gross amount does not match its quantity and rate');
  }
  if (ca.settledDividends.length !== 0) throw new BacktestRunIntegrityError('dividend settlement is not supported in V1');
}

/**
 * Fill timing must be what the fill claims (execution-clock:v1). An OPEN_EXACT fill executes at its session open, which is not before its bar
 * window start. An INTRABAR_UNKNOWN fill carries no execution instant: its `at` is the bar window start, and the window is non-empty.
 * The execution calendar identity must be recorded, and the open position must come from its entry fill.
 */
function verifyExecutionClock(run: BacktestRunResult): void {
  if (run.engineVersion !== 'backtest-engine:v7') return;
  if (!run.executionClock || run.executionClock.version !== EXECUTION_CLOCK_VERSION || run.executionClock.calendarId.trim() === '') {
    throw new BacktestRunIntegrityError('execution clock identity is missing or of another version');
  }
  const byId = new Map(run.fills.map((f) => [f.fillId, f]));
  for (const fill of run.fills) {
    const t = fill.timing;
    if (!t) throw new BacktestRunIntegrityError('fill ' + fill.fillId + ' has no timing');
    if (t.kind === 'OPEN_EXACT') {
      if (fill.at !== t.executionAt) throw new BacktestRunIntegrityError('exact fill ' + fill.fillId + ' does not execute at its recorded open');
      if (parseUtc(t.barStart) > parseUtc(t.executionAt)) throw new BacktestRunIntegrityError('fill ' + fill.fillId + ' executes before its bar window starts');
    } else {
      if (fill.at !== t.barStart) throw new BacktestRunIntegrityError('intrabar fill ' + fill.fillId + ' has an inconsistent bar window');
      if (parseUtc(t.barStart) >= parseUtc(t.barEnd)) throw new BacktestRunIntegrityError('intrabar fill ' + fill.fillId + ' has an empty bar window');
    }
  }
  if (run.openPosition) {
    const entry = byId.get(run.openPosition.entryFillId);
    if (!entry || entry.side !== 'buy' || entry.at !== run.openPosition.entryTime) throw new BacktestRunIntegrityError('open position entry time does not match its entry fill');
  }
}

export function verifyBacktestRun(run: BacktestRunResult): BacktestRunResult {
  verifyExecutionClock(run);
  if (run.engineVersion === 'backtest-engine:v5') {
    if (typeof run.portfolioCurrency !== 'string' || !/^[A-Z]{3}$/.test(run.portfolioCurrency)) throw new BacktestRunIntegrityError('portfolio currency is missing or invalid');
  }
  if (run.corporateActions) verifyCorporateActions(run, run.corporateActions);
  for (const point of run.equityCurve) {
    const receivables = point.receivablesValue ?? Decimal.ZERO;
    if (!point.equity.eq(point.cash.plus(point.marketValue).plus(receivables))) throw new BacktestRunIntegrityError('equity is not cash + market value + receivables');
  }
  if (run.openPosition && !run.fills.some((f) => f.fillId === run.openPosition!.entryFillId && f.side === 'buy')) {
    throw new BacktestRunIntegrityError('open position does not reference its entry fill');
  }
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
