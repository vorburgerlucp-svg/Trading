// O5 executable risk sizing (docs/O5_EXECUTABLE_RISK_SIZING_V1.md). These tests state the risk-per-trade contract: the budget counts the entry and exit
// commissions, the spread and slippage, and a configured gap stress; the quantity rounds down; the cash cap includes the entry commission; and the audit
// record is complete and verified. Every expected number was computed with an independent exact-fraction oracle, not with the code under test.
// This is a deterministic configured stress model. It is not VaR, not a probability and not a guarantee against a larger real gap.

import { describe, expect, it } from 'vitest';
import { BACKTEST_ENGINE_VERSION, runBacktest } from '../../src/backtest/backtest-engine.js';
import { BacktestRunIntegrityError, InMemoryBacktestRunStore, verifyBacktestRun } from '../../src/backtest/backtest-store.js';
import type { BacktestFill, BacktestRunResult, PositionSizing } from '../../src/backtest/backtest-types.js';
import type { BacktestStrategy, StrategyContext, StrategyDecision } from '../../src/backtest/strategy.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { Decimal } from '../../src/money/decimal.js';
import { decodeJson, encodeJson } from '../../src/persistence/json-codec.js';

const START_MS = Date.parse('2026-10-08T13:30:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** A deep copy that keeps every Decimal a Decimal: the forged values must reach the recomputation, not fail on their type. */
const losslessClone = (r: BacktestRunResult): BacktestRunResult => decodeJson(encodeJson(r)) as BacktestRunResult;

/** A 5-minute final bar. Open, high, low and close are explicit; a flat bar has all four equal. */
function bar(index: number, open: string, options: { high?: string; low?: string; close?: string } = {}): MarketBar {
  const start = START_MS + index * 300_000;
  const end = start + 300_000;
  const o = Decimal.from(open);
  const c = Decimal.from(options.close ?? open);
  return {
    instrumentId: 'TEST',
    interval: '5m',
    startTime: iso(start),
    endTime: iso(end),
    open: o,
    high: Decimal.from(options.high ?? open),
    low: Decimal.from(options.low ?? open),
    close: c,
    volume: Decimal.from(1000),
    source: 'fixture:production',
    session: 'regular',
    adjustment: 'raw',
    isFinal: true,
    observedAt: iso(end),
    availableAt: iso(end),
    retrievedAt: iso(end),
    knowledge: { knownAt: iso(end), knowledgeSource: 'captured_by_nexus', vintage: 'historical_reconstruction', vintagePolicy: 'bar-vintage:v1' },
  };
}

/** Decides ENTER_LONG once, on the first evaluation (bar 0). The entry fills at bar 1's open. Never exits, so a protective exit is the only close. */
function entry(stop?: string | null): BacktestStrategy {
  return {
    id: 'o5-entry',
    version: '1',
    definition: { stop: stop ?? null },
    warmup: { requiredBars: 1, preferredBars: 1, algorithmVersion: 'test-warmup:v1' },
    evaluate(ctx: StrategyContext): StrategyDecision {
      if (!ctx.position && ctx.history.length === 1) {
        return { action: 'ENTER_LONG', reasons: ['o5 entry'], ...(stop === undefined || stop === null ? {} : { stopLoss: Decimal.from(stop) }) };
      }
      return { action: 'NONE', reasons: [] };
    },
  };
}

const quality = { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'not_modeled' as const, providerProduction: true, minimumTrades: 1 };
const zero = { commissionBps: 0, spreadBps: 0, slippageBps: 0, minCommission: '0' };
const withCosts = (over: Partial<typeof zero>) => ({ ...zero, ...over });

const risk = (over: Record<string, unknown> = {}): PositionSizing =>
  ({ type: 'risk_per_trade', riskBasisPoints: 100, maxCashBasisPoints: 10_000, stopGapStressBasisPoints: 0, ...over }) as unknown as PositionSizing;

/** Entry at bar 1's open of 100, a 10 000 account, and a flat tail. */
const flat = (): MarketBar[] => [bar(0, '100'), bar(1, '100'), bar(2, '100'), bar(3, '100')];

function run(bars: MarketBar[], strategy: BacktestStrategy, sizing: PositionSizing, costModel = zero, capital = '10000'): BacktestRunResult {
  return runBacktest({ bars, strategy, portfolioCurrency: 'USD', executionCalendar: getCalendar('24x7')!, initialCapital: Decimal.from(capital), sizing, costModel, quality });
}

const buyFills = (r: BacktestRunResult): BacktestFill[] => r.fills.filter((f) => f.side === 'buy');
const onlyBuy = (r: BacktestRunResult): BacktestFill => {
  const buys = buyFills(r);
  expect(buys).toHaveLength(1);
  return buys[0]!;
};

describe('engine version and configuration (O5 §2, §15)', () => {
  it('the backtest engine is backtest-engine:v10', () => {
    expect(BACKTEST_ENGINE_VERSION).toBe('backtest-engine:v10');
  });

  it.each([
    ['a missing stopGapStressBasisPoints', { stopGapStressBasisPoints: undefined }],
    ['a fractional gap stress', { stopGapStressBasisPoints: 1.5 }],
    ['a NaN gap stress', { stopGapStressBasisPoints: Number.NaN }],
    ['an infinite gap stress', { stopGapStressBasisPoints: Number.POSITIVE_INFINITY }],
    ['a negative gap stress', { stopGapStressBasisPoints: -1 }],
    ['a gap stress of 10 000 bp', { stopGapStressBasisPoints: 10_000 }],
    ['a risk of 0 bp', { riskBasisPoints: 0 }],
    ['a risk above 10 000 bp', { riskBasisPoints: 10_001 }],
    ['a fractional cash cap', { maxCashBasisPoints: 100.5 }],
    ['a cash cap of 0 bp', { maxCashBasisPoints: 0 }],
  ])('%s is refused before the run starts', (_label, over) => {
    expect(() => run(flat(), entry('95'), risk(over))).toThrow();
  });
});

describe('zero costs and zero gap reproduce the old formula (O5 §19)', () => {
  it('riskBudget / (entry − stop) with zero costs: 100 / 5 = 20 shares, rounded down, within the cash cap', () => {
    expect(onlyBuy(run(flat(), entry('95'), risk())).quantity.eq('20')).toBe(true);
  });
});

describe('the costs are counted in the risk budget (O5 §4–§7, brief 1–5)', () => {
  it('a 1% commission on each side gives 14.388489208633, not 20: the commissions are in the modeled downside', () => {
    const fill = onlyBuy(run(flat(), entry('95'), risk(), withCosts({ commissionBps: 100 })));
    expect(fill.quantity.eq('14.388489208633')).toBe(true);
  });

  it('a 200 bp spread gives 14.388489208633: the sell side pays half the spread on the stressed exit', () => {
    const fill = onlyBuy(run(flat(), entry('95'), risk(), withCosts({ spreadBps: 200 })));
    expect(fill.quantity.eq('14.388489208633')).toBe(true);
  });

  it('100 bp slippage gives 14.388489208633: the sell side pays the slippage on the stressed exit', () => {
    const fill = onlyBuy(run(flat(), entry('95'), risk(), withCosts({ slippageBps: 100 })));
    expect(fill.quantity.eq('14.388489208633')).toBe(true);
  });

  it('a minimum commission of 2 on each side gives 19.2, and both minimums are counted', () => {
    const fill = onlyBuy(run(flat(), entry('95'), risk(), withCosts({ minCommission: '2' })));
    expect(fill.quantity.eq('19.2')).toBe(true);
  });

  it('with both minimums of 1 on a 10-unit budget the position is 1.6 and its modeled downside is exactly 10', () => {
    const fill = onlyBuy(run(flat(), entry('95'), risk({ riskBasisPoints: 100 }), withCosts({ minCommission: '1' }), '1000'));
    expect(fill.quantity.eq('1.6')).toBe(true);
  });

  it.each([
    ['commission', { commissionBps: 100 }],
    ['minimum commission', { minCommission: '2' }],
    ['spread', { spreadBps: 200 }],
    ['slippage', { slippageBps: 100 }],
  ])('a %s alone never increases the quantity, and strictly reduces it here', (_label, costs) => {
    const zeroQty = onlyBuy(run(flat(), entry('95'), risk())).quantity;
    const costQty = onlyBuy(run(flat(), entry('95'), risk(), withCosts(costs))).quantity;
    expect(costQty.lte(zeroQty)).toBe(true);
    expect(costQty.lt(zeroQty)).toBe(true);
  });
});

describe('the configured gap stress reduces the quantity (O5 §4, §21)', () => {
  it('a 200 bp stress stresses the stop 95 to 93.10, and the quantity is 14.492753623188', () => {
    const fill = onlyBuy(run(flat(), entry('95'), risk({ stopGapStressBasisPoints: 200 })));
    expect(fill.quantity.eq('14.492753623188')).toBe(true);
  });

  it('a 500 bp stress gives 10.256410256410', () => {
    const fill = onlyBuy(run(flat(), entry('95'), risk({ stopGapStressBasisPoints: 500 })));
    expect(fill.quantity.eq('10.25641025641')).toBe(true);
  });

  it('0, 200 and 500 bp give non-increasing quantities, and the stress per unit rises', () => {
    const q0 = onlyBuy(run(flat(), entry('95'), risk({ stopGapStressBasisPoints: 0 }))).quantity;
    const q200 = onlyBuy(run(flat(), entry('95'), risk({ stopGapStressBasisPoints: 200 }))).quantity;
    const q500 = onlyBuy(run(flat(), entry('95'), risk({ stopGapStressBasisPoints: 500 }))).quantity;
    expect(q200.lt(q0)).toBe(true);
    expect(q500.lt(q200)).toBe(true);
  });
});

describe('the cash cap includes the entry commission (O5 §11, §38)', () => {
  it('with cash 1000 and a 50% cash cap, a minimum commission of 2 gives 4.98, and the entry total is exactly 500', () => {
    const r = run(flat(), entry('95'), risk({ riskBasisPoints: 10_000, maxCashBasisPoints: 5_000 }), withCosts({ minCommission: '2' }), '1000');
    const fill = onlyBuy(r);
    expect(fill.quantity.eq('4.98')).toBe(true);
    expect(fill.executionPrice.times(fill.quantity).plus(fill.commission).eq('500')).toBe(true);
  });

  it('one tick more than 4.98 would exceed the 500 cash budget', () => {
    expect(Decimal.from('4.980000000001').times(100).plus(2).gt('500')).toBe(true);
  });
});

describe('the risk boundary is exact (O5 §9, §37)', () => {
  it('14.388489208633 has modeled stress downside ≤ 100, and one tick more exceeds 100', () => {
    const q = Decimal.from('14.388489208633');
    // With a 1% commission and no gap: 5 per unit of price drop, 1 per unit on entry and 0.95 per unit on exit.
    const downside = (x: Decimal) => x.times(5).plus(x.times(1)).plus(x.times('0.95'));
    expect(downside(q).lte(100)).toBe(true);
    expect(downside(q.plus('0.000000000001')).gt(100)).toBe(true);
    const fill = onlyBuy(run(flat(), entry('95'), risk(), withCosts({ commissionBps: 100 })));
    expect(fill.quantity.eq(q)).toBe(true);
  });
});

describe('a stop that is not valid creates no BUY fill (O5 §5, §29)', () => {
  it('a stop above the raw entry but below the buy execution price creates no fill', () => {
    const r = run(flat(), entry('100.5'), risk(), withCosts({ slippageBps: 100 }));
    expect(buyFills(r)).toHaveLength(0);
  });

  it.each([['0'], ['-5']])('a stop of %s creates no BUY fill', (stop) => {
    expect(buyFills(run(flat(), entry(stop), risk()))).toHaveLength(0);
  });

  it('a stop equal to the raw entry creates no BUY fill', () => {
    expect(buyFills(run(flat(), entry('100'), risk()))).toHaveLength(0);
  });

  it('a missing stop creates no BUY fill and no fixed-cash fallback', () => {
    expect(buyFills(run(flat(), entry(null), risk()))).toHaveLength(0);
  });
});

describe('the audit record is complete and verified (O5 §13–§15, brief 7)', () => {
  it('every market_entry BUY fill of a risk-sized run carries a risk-sizing:v1 record that agrees with the fill', () => {
    const fill = onlyBuy(run(flat(), entry('95'), risk()));
    const audit = fill.riskSizing!;
    expect(audit).toBeDefined();
    expect(audit.version).toBe('risk-sizing:v1');
    expect(audit.quantity.eq(fill.quantity)).toBe(true);
    expect(audit.entryExecutionPrice.eq(fill.executionPrice)).toBe(true);
    expect(audit.entryCommission.eq(fill.commission)).toBe(true);
    expect(audit.rawEntryPrice.eq('100')).toBe(true);
    expect(audit.stopLoss.eq('95')).toBe(true);
    expect(audit.modeledStressDownside.eq('100')).toBe(true);
    expect(audit.riskBudget.eq('100')).toBe(true);
    expect(audit.bindingConstraint).toBe('risk_budget');
  });

  it('the record names the cash-cap and risk-cap quantities, so the binding constraint can be recovered', () => {
    const audit = onlyBuy(run(flat(), entry('95'), risk())).riskSizing!;
    expect(audit.riskLimitedQuantity.eq('20')).toBe(true);
    expect(audit.cashLimitedQuantity.eq('100')).toBe(true);
  });

  it('a fixed_cash fill carries no risk record', () => {
    const fill = onlyBuy(run(flat(), entry('95'), { type: 'fixed_cash', amount: '1000' }));
    expect(fill.riskSizing).toBeUndefined();
  });

  it('a percent_equity fill carries no risk record', () => {
    const fill = onlyBuy(run(flat(), entry('95'), { type: 'percent_equity', basisPoints: 5_000 }));
    expect(fill.riskSizing).toBeUndefined();
  });

  it('a tampered audit fails verification closed, and so does a tampered quantity', () => {
    const r = run(flat(), entry('95'), risk());
    const forged = losslessClone(r);
    const fill = forged.fills.find((f) => f.side === 'buy')! as BacktestFill & { riskSizing: { modeledStressDownside: Decimal } };
    fill.riskSizing.modeledStressDownside = Decimal.from('1');
    expect(() => verifyBacktestRun(forged)).toThrow(BacktestRunIntegrityError);
    const forgedQuantity = losslessClone(r);
    forgedQuantity.fills.find((f) => f.side === 'buy')!.quantity = Decimal.from('21');
    expect(() => verifyBacktestRun(forgedQuantity)).toThrow(BacktestRunIntegrityError);
  });

  it('a structurally inconsistent audit is refused in memory, before it can be stored', async () => {
    const r = run(flat(), entry('95'), risk());
    const forged = losslessClone(r);
    const fill = forged.fills.find((f) => f.side === 'buy')! as BacktestFill & { riskSizing: { riskBudget: Decimal } };
    fill.riskSizing.riskBudget = Decimal.from('1');
    await expect(new InMemoryBacktestRunStore().save(forged)).rejects.toThrow(BacktestRunIntegrityError);
  });

  it('a v9 risk-sized run without a record is not reinterpreted and still verifies', () => {
    const r = run(flat(), entry('95'), { type: 'fixed_cash', amount: '1000' });
    const legacy = { ...r, engineVersion: 'backtest-engine:v9' };
    expect(() => verifyBacktestRun(legacy)).not.toThrow();
  });
});

describe('no look-ahead: the future gap does not change the entry (O5 §8, brief 24)', () => {
  it('two runs identical through the entry, with a small and a catastrophic later gap, give the same entry and audit', () => {
    const through = [bar(0, '100'), bar(1, '100')];
    const small = run([...through, bar(2, '94', { high: '94', low: '94', close: '94' }), bar(3, '94')], entry('95'), risk());
    const catastrophic = run([...through, bar(2, '10', { high: '10', low: '10', close: '10' }), bar(3, '10')], entry('95'), risk());
    const a = onlyBuy(small);
    const b = onlyBuy(catastrophic);
    expect(a.quantity.eq(b.quantity)).toBe(true);
    expect(a.executionPrice.eq(b.executionPrice)).toBe(true);
    expect(a.riskSizing).toBeDefined();
    expect(b.riskSizing).toEqual(a.riskSizing);
  });
});

describe('the components of the modeled downside are recorded (O5 §5–§8)', () => {
  it('with a 1% commission the stressed exit commission is 0.95 × quantity, and the entry commission equals the buy fill commission', () => {
    const fill = onlyBuy(run(flat(), entry('95'), risk(), withCosts({ commissionBps: 100 })));
    const audit = fill.riskSizing!;
    expect(audit.entryCommission.eq(fill.commission)).toBe(true);
    expect(audit.stressExitCommission.eq('13.66906474820135')).toBe(true);
    expect(audit.stressExecutionPrice.eq('95')).toBe(true);
  });
});

describe('fixed_cash and percent_equity keep their quantities (O5 §30)', () => {
  it('fixed_cash 100 at 10 buys 10 units', () => {
    const r = runBacktest({ bars: [bar(0, '10'), bar(1, '10'), bar(2, '10')], strategy: entry(null), portfolioCurrency: 'USD', executionCalendar: getCalendar('24x7')!, initialCapital: Decimal.from(1000), sizing: { type: 'fixed_cash', amount: '100' }, costModel: zero, quality });
    expect(onlyBuy(r).quantity.eq('10')).toBe(true);
  });

  it('percent_equity 5000 bp of 1000 equity at 100 buys 5 units', () => {
    const r = runBacktest({ bars: [bar(0, '100'), bar(1, '100'), bar(2, '100')], strategy: entry(null), portfolioCurrency: 'USD', executionCalendar: getCalendar('24x7')!, initialCapital: Decimal.from(1000), sizing: { type: 'percent_equity', basisPoints: 5_000 }, costModel: zero, quality });
    expect(onlyBuy(r).quantity.eq('5')).toBe(true);
  });
});

describe('identity and determinism (O5 §15, §18, §39)', () => {
  it('changing only stopGapStressBasisPoints changes the input fingerprint and the backtest run id', () => {
    const a = run(flat(), entry('95'), risk({ stopGapStressBasisPoints: 0 }));
    const b = run(flat(), entry('95'), risk({ stopGapStressBasisPoints: 200 }));
    expect(a.inputFingerprint).not.toBe(b.inputFingerprint);
    expect(a.backtestRunId).not.toBe(b.backtestRunId);
  });

  it('repeated runs with identical input give identical quantity, audit, fills, fingerprint and run id', () => {
    const first = run(flat(), entry('95'), risk({ stopGapStressBasisPoints: 200 }), withCosts({ commissionBps: 100, minCommission: '1' }));
    const second = run(flat(), entry('95'), risk({ stopGapStressBasisPoints: 200 }), withCosts({ commissionBps: 100, minCommission: '1' }));
    expect(onlyBuy(first).riskSizing).toBeDefined();
    expect(second.fills).toEqual(first.fills);
    expect(second.inputFingerprint).toBe(first.inputFingerprint);
    expect(second.backtestRunId).toBe(first.backtestRunId);
  });
});

describe('an actual gap below the stressed exit executes at the actual open (O5 §10, §23, §25)', () => {
  it('a 200 bp stress sizes 14.492753623188; the next open 90 gaps through the stop and the realized loss exceeds the 100 budget', () => {
    const bars = [bar(0, '100'), bar(1, '100'), bar(2, '90', { high: '90', low: '90', close: '90' }), bar(3, '90')];
    const r = run(bars, entry('95'), risk({ stopGapStressBasisPoints: 200 }));
    const exit = r.trades[0]!.exit;
    expect(exit.reason).toBe('stop');
    expect(exit.executionPrice.eq('90')).toBe(true);
    expect(r.trades[0]!.pnl.eq('-144.92753623188')).toBe(true);
    expect(r.trades[0]!.pnl.lt('-100')).toBe(true);
    expect(onlyBuy(r).riskSizing!.modeledStressDownside.lte('100')).toBe(true);
  });
});
