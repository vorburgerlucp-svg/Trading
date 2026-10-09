import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/backtest/backtest-engine.js';
import type { BacktestStrategy, StrategyContext } from '../../src/backtest/strategy.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { Decimal } from '../../src/money/decimal.js';

// Review finding (HIGH): a strategy could write to the bars and the open position it was shown. The engine then
// computed the input fingerprint from the mutated bars, so identical input produced a different run identity, and
// the strategy's own side effects steered later decisions. The engine must hand out read-only views.

const START_MS = Date.parse('2026-10-08T13:30:00.000Z');
function bar(index: number, close: string): MarketBar {
  const start = START_MS + index * 300_000;
  const end = start + 300_000;
  const c = Decimal.from(close);
  return {
    instrumentId: 'TEST', interval: '5m', startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString(),
    open: c, high: c.plus(1), low: c.minus(1), close: c, volume: Decimal.from(1000),
    source: 'fixture:production', session: 'regular', adjustment: 'raw', isFinal: true,
    observedAt: new Date(end).toISOString(), availableAt: new Date(end).toISOString(), retrievedAt: new Date(end).toISOString(), knowledge: { knownAt: new Date(end).toISOString(), knowledgeSource: 'captured_by_nexus', vintage: 'historical_reconstruction', vintagePolicy: 'bar-vintage:v1' },
  };
}
const bars = (): MarketBar[] => [bar(0, '100'), bar(1, '100'), bar(2, '100'), bar(3, '100')].map((b) => ({ ...b }));
const quality = { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'not_modeled' as const, providerProduction: true, minimumTrades: 1 };
const cost = { commissionBps: 0, spreadBps: 0, slippageBps: 0, minCommission: '0' };
const warmup = { requiredBars: 1, preferredBars: 1, algorithmVersion: 'test-warmup:v1' };

function run(input: MarketBar[], strategy: BacktestStrategy) {
  return runBacktest({ bars: input, strategy, initialCapital: Decimal.from(1000), sizing: { type: 'fixed_cash', amount: '100' }, costModel: cost, quality });
}

describe('strategy isolation: the engine owns its data', () => {
  it('a strategy cannot change the open position it is shown (the engine refuses the write, the run fails closed)', () => {
    const writer: BacktestStrategy = {
      id: 'writer', version: '1', definition: {}, warmup,
      evaluate(ctx: StrategyContext) {
        if (!ctx.position && ctx.history.length === 1) return { action: 'ENTER_LONG', reasons: ['entry'], stopLoss: Decimal.from('90') };
        if (ctx.position) (ctx.position as { stopLoss: Decimal | null }).stopLoss = Decimal.from('200');
        return { action: 'NONE', reasons: [] };
      },
    };
    expect(() => run(bars(), writer)).toThrow(TypeError);
  });

  it('a strategy cannot change the bars it is shown (the engine refuses the write, the run fails closed)', () => {
    const writer: BacktestStrategy = {
      id: 'writer', version: '1', definition: {}, warmup,
      evaluate(ctx: StrategyContext) {
        if (ctx.history.length === 3) (ctx.history[0] as { close: Decimal }).close = Decimal.from('1');
        return { action: 'NONE', reasons: [] };
      },
    };
    expect(() => run(bars(), writer)).toThrow(TypeError);
  });

  it('identical input has one run identity, whatever the strategy does with what it reads', () => {
    const reader: BacktestStrategy = { id: 'h', version: '1', definition: {}, warmup, evaluate: (ctx) => ({ action: 'NONE', reasons: [ctx.history.length.toString()] }) };
    const idle: BacktestStrategy = { id: 'h', version: '1', definition: {}, warmup, evaluate: () => ({ action: 'NONE', reasons: [] }) };
    expect(run(bars(), reader).backtestRunId).toBe(run(bars(), idle).backtestRunId);
  });

  it('the caller\'s bar objects are not frozen or altered by a run', () => {
    const input = bars();
    run(input, { id: 'h', version: '1', definition: {}, warmup, evaluate: () => ({ action: 'NONE', reasons: [] }) });
    expect(Object.isFrozen(input[0])).toBe(false);
    expect(input[0]!.close.eq('100')).toBe(true);
  });
});
