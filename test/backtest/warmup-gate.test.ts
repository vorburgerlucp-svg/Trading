import { describe, expect, it } from 'vitest';
import { BACKTEST_ENGINE_VERSION, runBacktest } from '../../src/backtest/backtest-engine.js';
import { verifyBacktestRun } from '../../src/backtest/backtest-store.js';
import type { BacktestRunResult } from '../../src/backtest/backtest-types.js';
import type { BacktestStrategy, StrategyContext, StrategyDecision } from '../../src/backtest/strategy.js';
import { validateWarmupPlan, warmupPlan, WarmupPlanError, type WarmupPlan } from '../../src/backtest/warmup.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { Decimal } from '../../src/money/decimal.js';
import { DEFAULT_QUANT_PARAMETERS } from '../../src/quant/quant-engine.js';

// Bars are 5-minute finals. Open equals close, so the price of a fill is the close of the bar it is taken from.
const START_MS = Date.parse('2026-10-08T13:30:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function bar(index: number, close: string, options: { availableAt?: string } = {}): MarketBar {
  const start = START_MS + index * 300_000;
  const end = start + 300_000;
  const c = Decimal.from(close);
  return {
    instrumentId: 'TEST',
    interval: '5m',
    startTime: iso(start),
    endTime: iso(end),
    open: c,
    high: c.plus(1),
    low: c.minus(1),
    close: c,
    volume: Decimal.from(1000),
    source: 'fixture:production',
    session: 'regular',
    adjustment: 'raw',
    isFinal: true,
    observedAt: iso(end),
    availableAt: options.availableAt ?? iso(end),
    retrievedAt: iso(end), knowledge: { knownAt: iso(end), knowledgeSource: 'captured_by_nexus', vintage: 'historical_reconstruction', vintagePolicy: 'bar-vintage:v1' },
  };
}

const series = (n: number, close: (i: number) => string = (i) => String(100 + i)): MarketBar[] => Array.from({ length: n }, (_, i) => bar(i, close(i)));

const plan = (requiredBars: number, preferredBars = requiredBars, algorithmVersion = 'test-warmup:v1'): WarmupPlan => ({ requiredBars, preferredBars, algorithmVersion });

interface Call {
  asOf: string;
  historyLength: number;
  history: string;
}

/** A strategy that records every evaluate() call. Warm-up correctness is judged from this log, not from the engine's own counters. */
function recorder(warmup: WarmupPlan, decide: (ctx: StrategyContext, evaluation: number) => StrategyDecision): { strategy: BacktestStrategy; calls: Call[] } {
  const calls: Call[] = [];
  const strategy: BacktestStrategy = {
    id: 'recorder',
    version: '1',
    definition: { requiredBars: warmup.requiredBars, preferredBars: warmup.preferredBars },
    warmup,
    evaluate(ctx) {
      calls.push({ asOf: ctx.asOf, historyLength: ctx.history.length, history: ctx.history.map((b) => b.close.toString()).join(',') });
      return decide(ctx, calls.length);
    },
  };
  return { strategy, calls };
}

const enterOnFirst = (ctx: StrategyContext, evaluation: number): StrategyDecision =>
  evaluation === 1 && !ctx.position ? { action: 'ENTER_LONG', reasons: ['first evaluation'] } : { action: 'NONE', reasons: [] };

const quality = { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'not_modeled' as const, providerProduction: true, minimumTrades: 1 };
const zeroCost = { commissionBps: 0, spreadBps: 0, slippageBps: 0, minCommission: '0' };

function run(bars: MarketBar[], strategy: BacktestStrategy): BacktestRunResult {
  return runBacktest({ bars, strategy, initialCapital: Decimal.from(1000), sizing: { type: 'fixed_cash', amount: '100' }, costModel: zeroCost, quality });
}

describe('Backtest warm-up enforcement (O3)', () => {
  it('hard gate: with requiredBars=5, bars 1–4 never reach the strategy and bar 5 is the first evaluation', () => {
    const bars = series(8);
    const { strategy, calls } = recorder(plan(5), () => ({ action: 'NONE', reasons: [] }));
    const result = run(bars, strategy);
    expect(calls.map((c) => c.historyLength)).toEqual([5, 6, 7, 8]);
    expect(calls[0]!.asOf).toBe(bars[4]!.availableAt);
    expect(result.warmup).toMatchObject({ requiredWarmupMet: true, warmupBars: 4, tradableBars: 4, strategyEvaluations: 4, firstStrategyEvaluationAt: bars[4]!.availableAt });
  });

  it('next-bar rule is unchanged: a signal first evaluated on bar 5 fills at bar 6 open, never on bar 5', () => {
    const bars = series(8);
    const { strategy } = recorder(plan(5), enterOnFirst);
    const result = run(bars, strategy);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.side).toBe('buy');
    expect(result.fills[0]!.at).toBe(bars[5]!.startTime);
    expect(result.fills[0]!.rawPrice.eq(bars[5]!.open)).toBe(true);
    expect(Date.parse(result.fills[0]!.at)).toBeGreaterThanOrEqual(Date.parse(result.warmup!.firstStrategyEvaluationAt!));
  });

  it('insufficient history: 4 bars for requiredBars=5 → no call, no order, no fill, and an INVALID run that is still auditable', () => {
    const bars = series(4);
    const { strategy, calls } = recorder(plan(5), enterOnFirst);
    const result = run(bars, strategy);
    expect(calls).toEqual([]);
    expect(result.fills).toEqual([]);
    expect(result.trades).toEqual([]);
    expect(result.openPosition).toBeNull();
    expect(result.quality.grade).toBe('INVALID');
    expect(result.quality.reasons[0]).toMatch(/^INSUFFICIENT_WARMUP_HISTORY: 4 bar\(s\) available, requiredBars 5/);
    expect(result.warmup).toMatchObject({ requiredWarmupMet: false, preferredWarmupMet: false, firstStrategyEvaluationAt: null, warmupBars: 4, tradableBars: 0, strategyEvaluations: 0 });
    expect(result.equityCurve).toHaveLength(4);
    expect(() => verifyBacktestRun(result)).not.toThrow();
  });

  it('exact boundary: exactly requiredBars bars → exactly one evaluation, on the last bar, and no fill', () => {
    const bars = series(5);
    const { strategy, calls } = recorder(plan(5), enterOnFirst);
    const result = run(bars, strategy);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.asOf).toBe(bars[4]!.availableAt);
    expect(result.fills).toEqual([]);
    expect(result.warmup).toMatchObject({ requiredWarmupMet: true, tradableBars: 1, warmupBars: 4, strategyEvaluations: 1 });
  });

  it('preferred history: required 5, preferred 20, 10 bars → trading happens, but preferredWarmupMet=false and marked', () => {
    const bars = series(10);
    const { strategy } = recorder(plan(5, 20), enterOnFirst);
    const result = run(bars, strategy);
    expect(result.fills.length).toBeGreaterThan(0);
    expect(result.warmup).toMatchObject({ requiredWarmupMet: true, preferredWarmupMet: false, preferredWarmupCompleteAt: null, strategyEvaluations: 6, evaluationsBelowPreferred: 6 });
    expect(result.quality.reasons.some((r) => r.startsWith('PREFERRED_WARMUP_NOT_MET'))).toBe(true);
    expect(result.quality.grade).not.toBe('INVALID');
  });

  it('preferred history met: required 5, preferred 5 → preferredWarmupMet=true and no hint', () => {
    const bars = series(8);
    const { strategy } = recorder(plan(5), enterOnFirst);
    const result = run(bars, strategy);
    expect(result.warmup).toMatchObject({ preferredWarmupMet: true, evaluationsBelowPreferred: 0, preferredWarmupCompleteAt: bars[4]!.availableAt });
    expect(result.quality.reasons.some((r) => r.startsWith('PREFERRED_WARMUP_NOT_MET'))).toBe(false);
  });

  it('fingerprint: requiredBars 50 vs 200, preferredBars, and algorithmVersion each give a different BacktestRunId; the same plan is reproducible', () => {
    const bars = series(60);
    const idOf = (w: WarmupPlan) => run(bars, recorder(w, enterOnFirst).strategy).backtestRunId;
    const base = idOf(plan(50));
    expect(idOf(plan(50))).toBe(base);
    expect(idOf(plan(200))).not.toBe(base);
    expect(idOf(plan(50, 55))).not.toBe(base);
    expect(idOf(plan(50, 50, 'test-warmup:v2'))).not.toBe(base);
  });

  it('no look-ahead: changing bars after T leaves every strategy call and every equity point up to T unchanged', () => {
    const original = series(12);
    const changed = series(12, (i) => (i > 7 ? String(500 + i) : String(100 + i)));
    const cutoff = Date.parse(original[7]!.availableAt);
    const beforeCutoff = (at: string) => Date.parse(at) <= cutoff;
    const a = recorder(plan(5), enterOnFirst);
    const b = recorder(plan(5), enterOnFirst);
    const ra = run(original, a.strategy);
    const rb = run(changed, b.strategy);
    expect(a.calls.filter((c) => beforeCutoff(c.asOf))).toEqual(b.calls.filter((c) => beforeCutoff(c.asOf)));
    expect(a.calls.filter((c) => beforeCutoff(c.asOf)).length).toBeGreaterThan(0);
    const equityUpTo = (r: BacktestRunResult) => r.equityCurve.filter((p) => beforeCutoff(p.at)).map((p) => [p.at, p.cash.toString(), p.equity.toString()]);
    expect(equityUpTo(ra)).toEqual(equityUpTo(rb));
  });

  it('delayed availability: a late bar holds the gate; warm-up counts only bars that were available', () => {
    const lateMs = START_MS + 2 * 300_000 + 300_000 + 2 * 3_600_000; // bar 2 becomes available two hours after its close
    const late = iso(lateMs);
    const bars = [bar(0, '100'), bar(1, '101'), bar(2, '102', { availableAt: late }), bar(3, '103', { availableAt: late }), bar(4, '104', { availableAt: late })];
    const { strategy, calls } = recorder(plan(3), () => ({ action: 'NONE', reasons: [] }));
    const result = run(bars, strategy);
    expect(calls[0]!.asOf).toBe(late);
    expect(calls[0]!.historyLength).toBe(3);
    expect(calls[0]!.history).toBe('100,101,102');
    expect(calls.every((c) => Date.parse(c.asOf) >= lateMs)).toBe(true);
    expect(result.warmup!.firstStrategyEvaluationAt).toBe(late);
  });

  it('exposure is measured over the tradable period: 200 warm-up bars + 20 tradable bars, position for 10 tradable bars → 10/21, not 10/220', () => {
    const bars = series(220);
    const { strategy } = recorder(plan(200), (ctx, evaluation) => {
      if (evaluation === 1 && !ctx.position) return { action: 'ENTER_LONG', reasons: ['entry'] };
      if (evaluation === 11 && ctx.position) return { action: 'EXIT_LONG', reasons: ['exit'] };
      return { action: 'NONE', reasons: [] };
    });
    const result = run(bars, strategy);
    expect(result.warmup).toMatchObject({ warmupBars: 199, tradableBars: 21, strategyEvaluations: 21 });
    expect(result.trades).toHaveLength(1);
    expect(result.metrics.exposurePct).toBeCloseTo((10 / 21) * 100, 9);
    expect(result.equityCurve).toHaveLength(220);
  });

  it('a quant-based strategy declares warmupPlan(quantParameters): one bar short is INVALID, exactly requiredBars opens the gate once', () => {
    const quantPlan = warmupPlan(DEFAULT_QUANT_PARAMETERS);
    const short = recorder(quantPlan, enterOnFirst);
    const shortRun = run(series(quantPlan.requiredBars - 1), short.strategy);
    expect(short.calls).toEqual([]);
    expect(shortRun.quality.grade).toBe('INVALID');
    expect(shortRun.warmup).toMatchObject({ requiredWarmupMet: false });
    const exact = recorder(quantPlan, enterOnFirst);
    run(series(quantPlan.requiredBars), exact.strategy);
    expect(exact.calls).toHaveLength(1);
  });

  it('a missing or malformed warm-up plan refuses the run: nothing defaults to 1', () => {
    expect(() => validateWarmupPlan(plan(0))).toThrow(WarmupPlanError);
    expect(() => validateWarmupPlan(plan(5, 4))).toThrow(WarmupPlanError);
    expect(() => validateWarmupPlan(plan(5, 5, ' '))).toThrow(WarmupPlanError);
    expect(() => run(series(10), recorder(plan(0), enterOnFirst).strategy)).toThrow(WarmupPlanError);
  });

  it('engine version: backtest-engine:v4 (v2 warm-up gate; v4 replay mode and knowledge at use)', () => {
    expect(BACKTEST_ENGINE_VERSION).toBe('backtest-engine:v4');
  });

  it('integrity: a run below the gate that shows a fill, or a flipped warm-up flag, fails verification', () => {
    const insufficient = run(series(4), recorder(plan(5), enterOnFirst).strategy);
    const fakeFill = { fillId: 'fill_000001', instrumentId: 'TEST', side: 'buy' as const, reason: 'market_entry' as const, at: insufficient.equityCurve[0]!.at, rawPrice: Decimal.from('1'), executionPrice: Decimal.from('1'), quantity: Decimal.from('1'), commission: Decimal.from('0') };
    expect(() => verifyBacktestRun({ ...insufficient, fills: [fakeFill] })).toThrow(/warm-up gate shows a decision, order or fill/);
    expect(() => verifyBacktestRun({ ...insufficient, warmup: { ...insufficient.warmup!, requiredWarmupMet: true } })).toThrow(/requiredWarmupMet/);
  });

  it('a stored backtest-engine:v1 run stays readable but cannot prove a warm-up', () => {
    const legacy: BacktestRunResult = { ...run(series(8), recorder(plan(1), enterOnFirst).strategy), engineVersion: 'backtest-engine:v1', warmup: undefined };
    expect(() => verifyBacktestRun(legacy)).not.toThrow();
    expect(() => verifyBacktestRun({ ...legacy, engineVersion: BACKTEST_ENGINE_VERSION })).toThrow(/warm-up metadata is missing/);
  });
});
