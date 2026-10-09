import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/backtest/backtest-engine.js';
import { verifyBacktestRun } from '../../src/backtest/backtest-store.js';
import type { BacktestStrategy } from '../../src/backtest/strategy.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { Decimal } from '../../src/money/decimal.js';

function bar(index: number, o: string, h: string, l: string, c: string): MarketBar {
  const start = Date.parse('2026-10-08T13:30:00.000Z') + index * 300_000;
  const end = start + 300_000;
  return {
    instrumentId: 'TEST',
    interval: '5m',
    startTime: new Date(start).toISOString(),
    endTime: new Date(end).toISOString(),
    open: Decimal.from(o),
    high: Decimal.from(h),
    low: Decimal.from(l),
    close: Decimal.from(c),
    volume: Decimal.from(1000),
    source: 'fixture:production',
    session: 'regular',
    adjustment: 'raw',
    isFinal: true,
    observedAt: new Date(end).toISOString(),
    availableAt: new Date(end).toISOString(),
    retrievedAt: new Date(end).toISOString(),
  };
}

const quality = { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'not_modeled' as const, providerProduction: true, minimumTrades: 1 };
const zeroCost = { commissionBps: 0, spreadBps: 0, slippageBps: 0, minCommission: '0' };
/** Explicit test warm-up: the strategy may act from the first bar. Every strategy declares its own plan. */
const firstBarWarmup = { requiredBars: 1, preferredBars: 1, algorithmVersion: 'test-warmup:v1' };

function enterThenExit(entryHistoryLength: number, exitHistoryLength: number, stops?: { stop: string; tp: string }): BacktestStrategy {
  return {
    id: 'enter-exit',
    version: '1',
    definition: { entryHistoryLength, exitHistoryLength, stops: stops ?? null },
    warmup: firstBarWarmup,
    evaluate(ctx) {
      if (!ctx.position && ctx.history.length === entryHistoryLength) {
        return {
          action: 'ENTER_LONG',
          reasons: ['test entry'],
          ...(stops ? { stopLoss: Decimal.from(stops.stop), takeProfit: Decimal.from(stops.tp) } : {}),
        };
      }
      if (ctx.position && ctx.history.length === exitHistoryLength) return { action: 'EXIT_LONG', reasons: ['test exit'] };
      return { action: 'NONE', reasons: [] };
    },
  };
}

describe('Backtest Engine point-in-time execution', () => {
  it('a decision from bar T fills only at T+1 open', () => {
    const bars = [
      bar(0, '100', '101', '99', '100'),
      bar(1, '102', '103', '101', '102'),
      bar(2, '103', '104', '102', '103'),
      bar(3, '104', '105', '103', '104'),
    ];
    const result = runBacktest({
      bars,
      strategy: enterThenExit(1, 3),
      initialCapital: Decimal.from(1000),
      sizing: { type: 'fixed_cash', amount: '500' },
      costModel: zeroCost,
      quality,
    });
    expect(result.fills[0]?.side).toBe('buy');
    expect(result.fills[0]?.at).toBe(bars[1]!.startTime);
    expect(result.fills[0]?.rawPrice.toString()).toBe('102');
    expect(result.fills[1]?.side).toBe('sell');
    expect(result.fills[1]?.at).toBe(bars[3]!.startTime);
    expect(result.trades).toHaveLength(1);
  });

  it('gap through stop exits at the gap open', () => {
    const bars = [
      bar(0, '100', '101', '99', '100'),
      bar(1, '100', '102', '98', '101'),
      bar(2, '88', '92', '85', '90'),
    ];
    const result = runBacktest({
      bars,
      strategy: enterThenExit(1, 99, { stop: '95', tp: '120' }),
      initialCapital: Decimal.from(1000),
      sizing: { type: 'fixed_cash', amount: '500' },
      costModel: zeroCost,
      quality,
    });
    expect(result.fills.map((f) => f.side)).toEqual(['buy', 'sell']);
    expect(result.fills[1]?.reason).toBe('stop');
    expect(result.fills[1]?.rawPrice.toString()).toBe('88');
  });

  it('conservative policy chooses stop when SL and TP are both touched after entry', () => {
    const bars = [
      bar(0, '100', '101', '99', '100'),
      bar(1, '100', '112', '93', '105'),
    ];
    const result = runBacktest({
      bars,
      strategy: enterThenExit(1, 99, { stop: '95', tp: '110' }),
      initialCapital: Decimal.from(1000),
      sizing: { type: 'fixed_cash', amount: '500' },
      costModel: zeroCost,
      quality,
      intrabarPolicy: 'conservative',
    });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.exit.reason).toBe('stop');
    expect(result.trades[0]?.exit.rawPrice.toString()).toBe('95');
  });

  it('realistic costs can turn a small gross winner into a loser', () => {
    const bars = [
      bar(0, '100', '101', '99', '100'),
      bar(1, '100', '101', '99', '100'),
      bar(2, '100.5', '101', '100', '100.5'),
    ];
    const strategy = enterThenExit(1, 2);
    const base = {
      bars,
      strategy,
      initialCapital: Decimal.from(1000),
      sizing: { type: 'fixed_cash' as const, amount: '500' },
      quality,
    };
    const free = runBacktest({ ...base, costModel: zeroCost });
    const costly = runBacktest({ ...base, costModel: { commissionBps: 30, spreadBps: 30, slippageBps: 20, minCommission: '1' } });
    expect(free.trades[0]?.pnl.isPositive()).toBe(true);
    expect(costly.trades[0]?.pnl.isNegative()).toBe(true);
  });

  it('waits for the first bar whose open occurs after a delayed decision became available', () => {
    const first = bar(0, '100', '101', '99', '100');
    const second = bar(1, '102', '103', '101', '102');
    const third = bar(2, '104', '105', '103', '104');
    const delayedFirst = { ...first, availableAt: new Date(Date.parse(second.startTime) + 60_000).toISOString(), retrievedAt: new Date(Date.parse(second.startTime) + 60_000).toISOString() };
    const result = runBacktest({
      bars: [delayedFirst, second, third],
      strategy: enterThenExit(1, 99),
      initialCapital: Decimal.from(1000),
      sizing: { type: 'fixed_cash', amount: '500' },
      costModel: zeroCost,
      quality,
    });
    expect(result.fills[0]?.at).toBe(third.startTime);
    expect(result.fills[0]?.rawPrice.toString()).toBe('104');
  });

  it('refuses to claim corporate actions are modeled before the engine can apply them to open positions', () => {
    expect(() => runBacktest({
      bars: [bar(0, '100', '101', '99', '100'), bar(1, '101', '102', '100', '101')],
      strategy: enterThenExit(1, 99),
      initialCapital: Decimal.from(1000),
      sizing: { type: 'fixed_cash', amount: '500' },
      costModel: zeroCost,
      quality: { ...quality, corporateActions: 'modeled' },
    })).toThrow(/cannot claim corporate actions are modeled/);
  });

  it('rejects mixed series instead of silently combining different adjustments or sources', () => {
    const a = bar(0, '100', '101', '99', '100');
    const b = { ...bar(1, '101', '102', '100', '101'), adjustment: 'split_adjusted' as const };
    expect(() => runBacktest({
      bars: [a, b],
      strategy: enterThenExit(1, 99),
      initialCapital: Decimal.from(1000),
      sizing: { type: 'fixed_cash', amount: '500' },
      costModel: zeroCost,
      quality,
    })).toThrow(/uniform interval\/session\/adjustment\/source/);
  });

  it('changes the backtest identity when strategy parameters change even if id/version stay the same', () => {
    const bars = [
      bar(0, '100', '101', '99', '100'),
      bar(1, '101', '102', '100', '101'),
      bar(2, '102', '103', '101', '102'),
      bar(3, '103', '104', '102', '103'),
    ];
    const common = {
      bars,
      initialCapital: Decimal.from(1000),
      sizing: { type: 'fixed_cash' as const, amount: '500' },
      costModel: zeroCost,
      quality,
    };
    const a = runBacktest({ ...common, strategy: enterThenExit(1, 3) });
    const b = runBacktest({ ...common, strategy: enterThenExit(2, 3) });
    expect(a.strategyId).toBe(b.strategyId);
    expect(a.strategyVersion).toBe(b.strategyVersion);
    expect(a.strategyFingerprint).not.toBe(b.strategyFingerprint);
    expect(a.backtestRunId).not.toBe(b.backtestRunId);
  });

  it('detects strategy metadata tampering even when the stored strategy fingerprint is left unchanged', () => {
    const result = runBacktest({
      bars: [bar(0, '100', '101', '99', '100'), bar(1, '101', '102', '100', '101'), bar(2, '102', '103', '101', '102')],
      strategy: enterThenExit(1, 99),
      initialCapital: Decimal.from(1000),
      sizing: { type: 'fixed_cash', amount: '500' },
      costModel: zeroCost,
      quality,
    });
    const changed = { ...result, strategyDefinition: { ...result.strategyDefinition, entryHistoryLength: 2 } };
    expect(() => verifyBacktestRun(changed)).toThrow(/strategy metadata checksum mismatch/);
  });

  it('rejects per-instrument availability inversion instead of retroactively trading delayed bars', () => {
    const first = bar(0, '100', '101', '99', '100');
    const second = bar(1, '100', '101', '99', '100');
    const inverted = { ...first, availableAt: new Date(Date.parse(second.availableAt) + 1000).toISOString() };
    expect(() => runBacktest({
      bars: [inverted, second],
      strategy: enterThenExit(1, 2),
      initialCapital: Decimal.from(1000),
      sizing: { type: 'fixed_cash', amount: '500' },
      costModel: zeroCost,
      quality,
    })).toThrow(/availability inversion/);
  });
});
