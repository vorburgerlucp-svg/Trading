import { describe, expect, it } from 'vitest';
import { BACKTEST_ENGINE_VERSION, runBacktest } from '../../src/backtest/backtest-engine.js';
import { verifyBacktestRun } from '../../src/backtest/backtest-store.js';
import type { BacktestStrategy } from '../../src/backtest/strategy.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { Decimal } from '../../src/money/decimal.js';

// O6 RED tests. These tests intentionally describe the v11 contract before implementation.
// v10 currently records range touches as INTRABAR_UNKNOWN from bar.startTime, which is too wide for
// daily/session bars and can place an exit before the executable market open.

const calendar = getCalendar('XNAS')!;
const quality = { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'not_modeled' as const, providerProduction: true, minimumTrades: 1 };
const zeroCost = { commissionBps: 0, spreadBps: 0, slippageBps: 0, minCommission: '0' };
const warmup = { requiredBars: 1, preferredBars: 1, algorithmVersion: 'test-warmup:v1' };

type ExpectedBoundedTiming = {
  kind: string;
  earliestAt?: string;
  latestAt?: string;
  barStart?: string;
  barEnd?: string;
  basis?: string;
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function dailyBar(date: string, open: string, high: string, low: string, close: string): MarketBar {
  const window = calendar.dailyBarWindow(date);
  const complete = calendar.dailyBarCompletion(date, 'regular');
  if (complete === null) throw new Error('test date has no regular session: ' + date);
  return {
    instrumentId: 'TEST',
    interval: '1d',
    startTime: iso(window.start),
    endTime: iso(window.end),
    open: Decimal.from(open),
    high: Decimal.from(high),
    low: Decimal.from(low),
    close: Decimal.from(close),
    volume: Decimal.from(1000),
    source: 'fixture:production',
    session: 'regular',
    adjustment: 'raw',
    isFinal: true,
    observedAt: iso(complete),
    availableAt: iso(complete),
    retrievedAt: iso(complete),
    knowledge: {
      knownAt: iso(complete),
      knowledgeSource: 'captured_by_nexus',
      vintage: 'historical_reconstruction',
      vintagePolicy: 'bar-vintage:v1',
    },
  };
}

function enterOnce(stop: string, target: string): BacktestStrategy {
  return {
    id: 'o6-enter-once',
    version: '1',
    definition: { stop, target },
    warmup,
    evaluate(ctx) {
      if (!ctx.position && ctx.history.length === 1) {
        return {
          action: 'ENTER_LONG',
          reasons: ['o6 fixture entry'],
          stopLoss: Decimal.from(stop),
          takeProfit: Decimal.from(target),
        };
      }
      return { action: 'NONE', reasons: [] };
    },
  };
}

function run(bars: MarketBar[], stop = '95', target = '110', intrabarPolicy: 'conservative' | 'mark_ambiguous' = 'conservative') {
  return runBacktest({
    bars,
    strategy: enterOnce(stop, target),
    portfolioCurrency: 'USD',
    executionCalendar: calendar,
    initialCapital: Decimal.from(1000),
    sizing: { type: 'fixed_cash', amount: '500' },
    costModel: zeroCost,
    quality,
    intrabarPolicy,
  });
}

function boundedTimingOfExit(result: ReturnType<typeof run>): ExpectedBoundedTiming {
  const exit = result.fills.find((f) => f.side === 'sell');
  if (!exit) throw new Error('expected a sell fill');
  return exit.timing as unknown as ExpectedBoundedTiming;
}

describe('O6 bounded intrabar stop timing — RED', () => {
  it('bumps the engine to v11 for the new timing contract', () => {
    expect(BACKTEST_ENGINE_VERSION).toBe('backtest-engine:v11');
  });

  it('a daily same-bar stop touch is bounded by the real XNAS session, never by local-midnight bar.startTime', () => {
    const bars = [
      dailyBar('2026-10-08', '100', '101', '99', '100'),
      dailyBar('2026-10-09', '100', '105', '94', '101'),
    ];
    const result = run(bars);
    const entry = result.fills.find((f) => f.side === 'buy')!;
    const exit = result.fills.find((f) => f.side === 'sell')!;
    const timing = boundedTimingOfExit(result);
    const session = calendar.session('2026-10-09', 'regular')!;

    expect(exit.reason).toBe('stop');
    expect(exit.rawPrice.toString()).toBe('95');
    expect(timing.kind).toBe('INTRABAR_BOUNDED');
    expect(timing.earliestAt).toBe(iso(session.open));
    expect(timing.latestAt).toBe(iso(session.close));
    expect(timing.basis).toBe('OHLC_RANGE_TOUCH');
    expect(exit.at).toBe(iso(session.open));
    expect(Date.parse(exit.at)).toBeGreaterThanOrEqual(Date.parse(entry.at));
    expect(exit.at).not.toBe(bars[1]!.startTime);
  });

  it('a carried position stopped on the next trading day is bounded by that day session open and close', () => {
    const bars = [
      dailyBar('2026-10-08', '100', '101', '99', '100'),
      dailyBar('2026-10-09', '100', '104', '98', '102'),
      dailyBar('2026-10-12', '100', '103', '94', '96'),
    ];
    const result = run(bars);
    const exit = result.fills.find((f) => f.side === 'sell')!;
    const timing = boundedTimingOfExit(result);
    const session = calendar.session('2026-10-12', 'regular')!;

    expect(exit.reason).toBe('stop');
    expect(timing.kind).toBe('INTRABAR_BOUNDED');
    expect(timing.earliestAt).toBe(iso(session.open));
    expect(timing.latestAt).toBe(iso(session.close));
    expect(exit.at).toBe(iso(session.open));
  });

  it('an intrabar take-profit uses the same proven session bounds', () => {
    const bars = [
      dailyBar('2026-10-08', '100', '101', '99', '100'),
      dailyBar('2026-10-09', '100', '111', '98', '108'),
    ];
    const result = run(bars);
    const exit = result.fills.find((f) => f.side === 'sell')!;
    const timing = boundedTimingOfExit(result);
    const session = calendar.session('2026-10-09', 'regular')!;

    expect(exit.reason).toBe('take_profit');
    expect(exit.rawPrice.toString()).toBe('110');
    expect(timing.kind).toBe('INTRABAR_BOUNDED');
    expect(timing.earliestAt).toBe(iso(session.open));
    expect(timing.latestAt).toBe(iso(session.close));
  });

  it('gap-through stop stays exact at the actual session open', () => {
    const bars = [
      dailyBar('2026-10-08', '100', '101', '99', '100'),
      dailyBar('2026-10-09', '90', '92', '85', '88'),
    ];
    const result = run(bars);
    const exit = result.fills.find((f) => f.side === 'sell')!;
    const session = calendar.session('2026-10-09', 'regular')!;

    expect(exit.reason).toBe('stop');
    expect(exit.rawPrice.toString()).toBe('90');
    expect(exit.timing.kind).toBe('OPEN_EXACT');
    if (exit.timing.kind === 'OPEN_EXACT') {
      expect(exit.timing.executionAt).toBe(iso(session.open));
      expect(exit.at).toBe(iso(session.open));
    }
  });

  it('conservative both-touched keeps the adverse stop but does not invent an exact order or timestamp', () => {
    const bars = [
      dailyBar('2026-10-08', '100', '101', '99', '100'),
      dailyBar('2026-10-09', '100', '112', '93', '105'),
    ];
    const result = run(bars);
    const exit = result.fills.find((f) => f.side === 'sell')!;
    const timing = boundedTimingOfExit(result);

    expect(exit.reason).toBe('stop');
    expect(exit.rawPrice.toString()).toBe('95');
    expect(timing.kind).toBe('INTRABAR_BOUNDED');
    expect(timing.basis).toBe('OHLC_RANGE_TOUCH');
  });

  it('mark_ambiguous still refuses to invent which protective level traded first', () => {
    const bars = [
      dailyBar('2026-10-08', '100', '101', '99', '100'),
      dailyBar('2026-10-09', '100', '112', '93', '105'),
    ];
    const result = run(bars, '95', '110', 'mark_ambiguous');

    expect(result.fills.map((f) => f.side)).toEqual(['buy']);
    expect(result.trades).toHaveLength(0);
    expect(result.ambiguousBars).toBe(1);
  });

  it('the current legacy v10 unknown-timing run remains internally verifiable before the version change', () => {
    const bars = [
      dailyBar('2026-10-08', '100', '101', '99', '100'),
      dailyBar('2026-10-09', '100', '105', '94', '101'),
    ];
    const result = run(bars);
    // RED stage preservation guard: before v11 lands this is a genuine v10 record. The implementation
    // must later keep historical v10 records verifiable rather than reinterpret them as v11.
    if (result.engineVersion === 'backtest-engine:v10') {
      expect(result.fills.find((f) => f.side === 'sell')?.timing.kind).toBe('INTRABAR_UNKNOWN');
      expect(() => verifyBacktestRun(result)).not.toThrow();
    }
  });
});
