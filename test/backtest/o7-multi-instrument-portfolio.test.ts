import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/backtest/backtest-engine.js';
import {
  PORTFOLIO_BACKTEST_VERSION,
  PortfolioAllocationAmbiguousError,
  runPortfolioBacktest,
} from '../../src/backtest/portfolio-backtest.js';
import type { BacktestStrategy } from '../../src/backtest/strategy.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { Decimal } from '../../src/money/decimal.js';

const CAL = getCalendar('24x7')!;
const quality = { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'not_modeled' as const, providerProduction: true, minimumTrades: 1 };
const zeroCost = { commissionBps: 0, spreadBps: 0, slippageBps: 0, minCommission: '0' };
const warmup = { requiredBars: 1, preferredBars: 1, algorithmVersion: 'test-warmup:v1' };
const START = Date.parse('2026-10-08T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function bar(
  instrumentId: string,
  index: number,
  open: string,
  options: { high?: string; low?: string; close?: string; knownDelayMs?: number } = {},
): MarketBar {
  const start = START + index * 300_000;
  const end = start + 300_000;
  const known = end + (options.knownDelayMs ?? 0);
  return {
    instrumentId,
    interval: '5m',
    startTime: iso(start),
    endTime: iso(end),
    open: Decimal.from(open),
    high: Decimal.from(options.high ?? open),
    low: Decimal.from(options.low ?? open),
    close: Decimal.from(options.close ?? open),
    volume: Decimal.from(1000),
    source: 'fixture:production',
    session: 'regular',
    adjustment: 'raw',
    isFinal: true,
    observedAt: iso(end),
    availableAt: iso(end),
    retrievedAt: iso(known),
    knowledge: {
      knownAt: iso(known),
      knowledgeSource: 'captured_by_nexus',
      vintage: 'historical_reconstruction',
      vintagePolicy: 'bar-vintage:v1',
    },
  };
}

type Plan = Readonly<Record<string, { enterAt?: number; exitAt?: number; stop?: string; target?: string }>>;

function strategy(plan: Plan): BacktestStrategy {
  return {
    id: 'o7-per-instrument',
    version: '1',
    definition: plan,
    warmup,
    evaluate(ctx) {
      const p = plan[ctx.instrumentId] ?? {};
      if (!ctx.position && p.enterAt !== undefined && ctx.history.length === p.enterAt) {
        return {
          action: 'ENTER_LONG',
          reasons: ['o7 fixture entry'],
          ...(p.stop === undefined ? {} : { stopLoss: Decimal.from(p.stop) }),
          ...(p.target === undefined ? {} : { takeProfit: Decimal.from(p.target) }),
        };
      }
      if (ctx.position && p.exitAt !== undefined && ctx.history.length === p.exitAt) {
        return { action: 'EXIT_LONG', reasons: ['o7 fixture exit'] };
      }
      return { action: 'NONE', reasons: [] };
    },
  };
}

function portfolio(
  seriesByInstrument: Readonly<Record<string, readonly MarketBar[]>>,
  plan: Plan,
  options: { capital?: string; amount?: string; replay?: 'historical_research' | 'decision_time' } = {},
) {
  return runPortfolioBacktest({
    seriesByInstrument,
    strategy: strategy(plan),
    executionCalendars: Object.fromEntries(Object.keys(seriesByInstrument).map((id) => [id, CAL])),
    initialCapital: Decimal.from(options.capital ?? '1000'),
    portfolioCurrency: 'USD',
    sizing: { type: 'fixed_cash', amount: options.amount ?? '100' },
    costModel: zeroCost,
    quality,
    replay: options.replay,
  });
}

describe('O7 multi-instrument portfolio event loop — RED', () => {
  it('has an explicit portfolio engine identity', () => {
    expect(PORTFOLIO_BACKTEST_VERSION).toBe('portfolio-backtest:v1');
  });

  it('accepts two instruments while the historical single-instrument engine still refuses them', () => {
    const A = [bar('A', 0, '100'), bar('A', 1, '100'), bar('A', 2, '100')];
    const B = [bar('B', 0, '50'), bar('B', 1, '50'), bar('B', 2, '50')];

    expect(() =>
      runBacktest({
        bars: [A[0]!, B[0]!],
        strategy: strategy({ A: { enterAt: 1 }, B: { enterAt: 1 } }),
        portfolioCurrency: 'USD',
        executionCalendar: CAL,
        initialCapital: Decimal.from(1000),
        sizing: { type: 'fixed_cash', amount: '100' },
        costModel: zeroCost,
        quality,
      }),
    ).toThrow(/single-instrument/);

    const result = portfolio({ A, B }, { A: { enterAt: 1 }, B: { enterAt: 1 } });
    expect(result.instrumentIds).toEqual(['A', 'B']);
    expect(result.fills.filter((f) => f.side === 'buy').map((f) => f.instrumentId)).toEqual(['A', 'B']);
  });

  it('treats bars with the same usable timestamp as one world batch, not two portfolio marks', () => {
    const A = [bar('A', 0, '100'), bar('A', 1, '100'), bar('A', 2, '100')];
    const B = [bar('B', 0, '50'), bar('B', 1, '50'), bar('B', 2, '50')];
    const result = portfolio({ A, B }, { A: { enterAt: 1 }, B: { enterAt: 1 } });

    expect(result.equityCurve.map((p) => p.at)).toEqual([
      iso(START + 300_000),
      iso(START + 600_000),
      iso(START + 900_000),
    ]);
  });

  it('marks a delayed instrument only with its latest point-in-time-known price', () => {
    const A = [
      bar('A', 0, '100'),
      bar('A', 1, '100'),
      bar('A', 2, '110'),
    ];
    const B = [
      bar('B', 0, '50'),
      bar('B', 1, '50'),
      bar('B', 2, '200', { knownDelayMs: 5_000 }),
    ];
    const result = portfolio({ A, B }, { A: { enterAt: 1 }, B: { enterAt: 1 } }, { replay: 'decision_time' });

    const atA = result.equityCurve.find((p) => p.at === iso(START + 900_000))!;
    const atB = result.equityCurve.find((p) => p.at === iso(START + 905_000))!;
    // cash 800 after two 100-unit allocations; A qty 1, B qty 2.
    expect(atA.equity.toString()).toBe('1010');
    expect(atB.equity.toString()).toBe('1310');
  });

  it('closing A does not mutate the still-open B position', () => {
    const A = [bar('A', 0, '100'), bar('A', 1, '100'), bar('A', 2, '105'), bar('A', 3, '105')];
    const B = [bar('B', 0, '50'), bar('B', 1, '50'), bar('B', 2, '50'), bar('B', 3, '50')];
    const result = portfolio({ A, B }, { A: { enterAt: 1, exitAt: 3 }, B: { enterAt: 1 } });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.instrumentId).toBe('A');
    expect(result.openPositions.map((p) => p.instrumentId)).toEqual(['B']);
  });

  it('preserves O6 timing independently per instrument: A gap stop exact, B range stop bounded', () => {
    const A = [
      bar('A', 0, '100'),
      bar('A', 1, '100'),
      bar('A', 2, '90', { high: '92', low: '85', close: '88' }),
    ];
    const B = [
      bar('B', 0, '50'),
      bar('B', 1, '50'),
      bar('B', 2, '50', { high: '51', low: '44', close: '48' }),
    ];
    const result = portfolio(
      { A, B },
      { A: { enterAt: 1, stop: '95', target: '120' }, B: { enterAt: 1, stop: '45', target: '70' } },
    );
    const aExit = result.fills.find((f) => f.instrumentId === 'A' && f.side === 'sell')!;
    const bExit = result.fills.find((f) => f.instrumentId === 'B' && f.side === 'sell')!;

    expect(aExit.reason).toBe('stop');
    expect(aExit.timing.kind).toBe('OPEN_EXACT');
    expect(bExit.reason).toBe('stop');
    expect(bExit.timing.kind).toBe('INTRABAR_BOUNDED');
  });

  it('fills simultaneous buys when shared cash is sufficient', () => {
    const A = [bar('A', 0, '100'), bar('A', 1, '100'), bar('A', 2, '100')];
    const B = [bar('B', 0, '100'), bar('B', 1, '100'), bar('B', 2, '100')];
    const result = portfolio({ A, B }, { A: { enterAt: 1 }, B: { enterAt: 1 } }, { amount: '400' });

    expect(result.fills.filter((f) => f.side === 'buy')).toHaveLength(2);
    expect(result.openPositions.map((p) => [p.instrumentId, p.quantity.toString()])).toEqual([
      ['A', '4'],
      ['B', '4'],
    ]);
    expect(result.equityCurve.at(-1)!.cash.toString()).toBe('200');
  });

  it('fails closed when simultaneous buys compete for insufficient cash', () => {
    const A = [bar('A', 0, '100'), bar('A', 1, '100')];
    const B = [bar('B', 0, '100'), bar('B', 1, '100')];

    expect(() => portfolio({ A, B }, { A: { enterAt: 1 }, B: { enterAt: 1 } }, { amount: '600' })).toThrow(PortfolioAllocationAmbiguousError);
    try {
      portfolio({ A, B }, { A: { enterAt: 1 }, B: { enterAt: 1 } }, { amount: '600' });
    } catch (error) {
      expect((error as PortfolioAllocationAmbiguousError).code).toBe('PORTFOLIO_ALLOCATION_AMBIGUOUS');
    }
  });

  it('is independent of map insertion order', () => {
    const A = [bar('A', 0, '100'), bar('A', 1, '101'), bar('A', 2, '102')];
    const B = [bar('B', 0, '50'), bar('B', 1, '51'), bar('B', 2, '52')];
    const plan = { A: { enterAt: 1 }, B: { enterAt: 1 } };
    const ab = portfolio({ A, B }, plan);
    const ba = portfolio({ B, A }, plan);

    expect(ba.fills).toEqual(ab.fills);
    expect(ba.trades).toEqual(ab.trades);
    expect(ba.equityCurve).toEqual(ab.equityCurve);
    expect(ba.inputFingerprint).toBe(ab.inputFingerprint);
    expect(ba.portfolioRunId).toBe(ab.portfolioRunId);
  });

  it('a future change in B changes portfolio identity but not A fills that occurred before B became usable', () => {
    const A = [bar('A', 0, '100'), bar('A', 1, '101'), bar('A', 2, '102')];
    const B1 = [bar('B', 0, '50'), bar('B', 1, '50'), bar('B', 2, '50', { knownDelayMs: 5_000 })];
    const B2 = [bar('B', 0, '50'), bar('B', 1, '50'), bar('B', 2, '500', { knownDelayMs: 5_000 })];
    const plan = { A: { enterAt: 1 }, B: { enterAt: 1 } };
    const a = portfolio({ A, B: B1 }, plan, { replay: 'decision_time' });
    const b = portfolio({ A, B: B2 }, plan, { replay: 'decision_time' });

    expect(a.inputFingerprint).not.toBe(b.inputFingerprint);
    expect(a.portfolioRunId).not.toBe(b.portfolioRunId);
    expect(b.fills.filter((f) => f.instrumentId === 'A')).toEqual(a.fills.filter((f) => f.instrumentId === 'A'));
  });
});
