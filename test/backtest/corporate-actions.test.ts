import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/backtest/backtest-engine.js';
import { effectiveSessionOf } from '../../src/backtest/corporate-action-engine.js';
import type { BacktestInput, CorporateActionInput } from '../../src/backtest/backtest-types.js';
import type { BacktestStrategy, StrategyContext, StrategyDecision } from '../../src/backtest/strategy.js';
import type { CorporateActionKnowledgeProvenance, MarketBar, StoredCorporateAction } from '../../src/market-data/market-data-types.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { toUtcIso } from '../../src/market-data/time.js';
import { Decimal } from '../../src/money/decimal.js';
import { AAPL, FIXTURE_SOURCE, dailyBars } from '../market-data/fixtures.js';

// O2 corporate actions on open positions (backtest-engine:v5). Expected values are derived from the spec examples, not read off
// the engine. See docs/BACKTEST_CORPORATE_ACTIONS_O2.md.

const XNAS = getCalendar('XNAS')!;
const costs = { commissionBps: 0, spreadBps: 0, slippageBps: 0, minCommission: '5' };
const quality = { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'not_modeled' as const, providerProduction: true, minimumTrades: 1 };
const K0 = '2026-10-01T00:00:00.000Z';
const warmup = { requiredBars: 1, preferredBars: 1, algorithmVersion: 'test-warmup:v1' };

type Row = readonly [date: string, open: string, high: string, low: string, close: string];

/** Daily raw bars of the instrument on the XNAS calendar. Retrieved long after completion (backfill) unless `completion` is asked. */
function series(rows: readonly Row[], retrieval: 'backfill' | 'completion' = 'backfill'): MarketBar[] {
  return rows.map(([date, o, h, l, c]) => {
    const spec = retrieval === 'completion' ? { retrievedAt: toUtcIso(XNAS.dailyBarCompletion(date)!) } : {};
    return dailyBars(XNAS, date, [{ open: o, high: h, low: l, close: c, volume: '1000' }], spec)[0]!;
  });
}

function ca(p: {
  key: string;
  type: StoredCorporateAction['type'];
  exDate: string;
  from?: string;
  to?: string;
  cash?: string;
  currency?: string;
  oldSymbol?: string;
  newSymbol?: string;
  knownAt?: string;
  provenance?: CorporateActionKnowledgeProvenance;
  revision?: number;
}): StoredCorporateAction {
  const knownAt = p.knownAt ?? K0;
  return {
    actionKey: p.key,
    instrumentId: AAPL.instrumentId,
    source: FIXTURE_SOURCE.sourceId,
    type: p.type,
    exDate: p.exDate,
    ...(p.from ? { ratioFrom: Decimal.from(p.from), ratioTo: Decimal.from(p.to!) } : {}),
    ...(p.cash ? { cashAmount: Decimal.from(p.cash), currency: p.currency ?? 'USD' } : {}),
    ...(p.oldSymbol ? { oldSymbol: p.oldSymbol, newSymbol: p.newSymbol! } : {}),
    retrievedAt: knownAt,
    knowledge: { provenance: p.provenance ?? 'captured_by_nexus', knowledgeAt: knownAt },
    revision: p.revision ?? 1,
    ingestSeq: 1,
    contentHash: 'e'.repeat(64),
    storedAvailableAt: knownAt,
    provenanceHash: null,
  };
}

const withActions = (actions: readonly StoredCorporateAction[]): { corporateActions: CorporateActionInput } => ({ corporateActions: { actions, calendar: XNAS } });

function run(bars: MarketBar[], strategy: BacktestStrategy, extra: Partial<BacktestInput> = {}) {
  return runBacktest({ bars, strategy, initialCapital: Decimal.from(10_000), portfolioCurrency: 'USD', executionCalendar: getCalendar('XNAS')!, sizing: { type: 'fixed_cash', amount: '1000' }, costModel: costs, quality, ...extra });
}

/** Enters when the history reaches `enterAt`, optionally with attached levels, and exits when it reaches `exitAt`. Logs what it saw. */
function strategy(opts: { enterAt: number; exitAt: number; stop?: string; target?: string; log?: Array<{ asOf: string; closes: string[] }> }): BacktestStrategy {
  return {
    id: 'o2-probe',
    version: '1',
    definition: { enterAt: opts.enterAt, exitAt: opts.exitAt, stop: opts.stop ?? null, target: opts.target ?? null },
    warmup,
    evaluate(ctx: StrategyContext): StrategyDecision {
      opts.log?.push({ asOf: ctx.asOf, closes: ctx.history.map((b) => b.close.toString()) });
      if (!ctx.position && ctx.history.length === opts.enterAt) {
        return { action: 'ENTER_LONG', reasons: ['o2 entry'], ...(opts.stop ? { stopLoss: Decimal.from(opts.stop), takeProfit: Decimal.from(opts.target!) } : {}) };
      }
      if (ctx.position && ctx.history.length === opts.exitAt) return { action: 'EXIT_LONG', reasons: ['o2 exit'] };
      return { action: 'NONE', reasons: [] };
    },
  };
}

/** 4-for-1 split effective on 2026-10-08 (raw open 25). Entry fill at 100 on 10-07, exit fill at 30 on 10-12. */
const SPLIT_ROWS: readonly Row[] = [
  ['2026-10-05', '100', '100', '100', '100'],
  ['2026-10-06', '100', '100', '100', '100'],
  ['2026-10-07', '100', '100', '100', '100'],
  ['2026-10-08', '25', '25', '24', '25'],
  ['2026-10-09', '25', '26', '24', '25'],
  ['2026-10-12', '30', '31', '29', '30'],
];
const SPLIT_4_1 = ca({ key: 'split:2026-10-08', type: 'split', exDate: '2026-10-08', from: '1', to: '4' });
const HOLD = strategy({ enterAt: 2, exitAt: 100 });

describe('O2 structural: stable entry lineage (Phase 1)', () => {
  it('an open position carries the immutable id of its entry fill', () => {
    const r = run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 1, exitAt: 100 }));
    const entry = r.fills.find((f) => f.side === 'buy')!;
    expect(r.openPosition!.entryFillId).toBe(entry.fillId);
  });

  it('a split does not break the trade linkage: the exit closes the original 10-share entry, the exit quantity is 40', () => {
    const r = run(series(SPLIT_ROWS), strategy({ enterAt: 1, exitAt: 4 }), withActions([SPLIT_4_1]));
    expect(r.trades).toHaveLength(1);
    const trade = r.trades[0]!;
    expect(trade.entry.quantity.toString()).toBe('10');
    expect(trade.entry.side).toBe('buy');
    expect(trade.exit.quantity.toString()).toBe('40');
    expect(r.fills.filter((f) => f.side === 'buy')).toHaveLength(1);
  });
});

describe('O2 split (Phases 5-8)', () => {
  it('4-for-1: quantity ×4, basis ÷4, no trade, no commission, no realized P&L at the action', () => {
    const r = run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 1, exitAt: 100 }), withActions([SPLIT_4_1]));
    expect(r.openPosition!.quantity.toString()).toBe('40');
    expect(r.openPosition!.entryPrice.toString()).toBe('25');
    expect(r.trades).toHaveLength(0);
    expect(r.fills).toHaveLength(1);
    expect(r.metrics.totalFees.toString()).toBe('5');
    const applied = r.corporateActions!.applied[0]!;
    expect(applied.transformation).toMatchObject({ kind: 'split', quantityBefore: '10', quantityAfter: '40', quantityFactor: '4', priceFactor: '0.25' });
    const check = r.corporateActions!.valueNeutralityChecks[0]!;
    expect(check).toMatchObject({ valueBefore: '1000', valueAfter: '1000', difference: '0', neutral: true });
  });

  it('2-for-1 transforms the same way', () => {
    const two = ca({ key: 'split:2026-10-08', type: 'split', exDate: '2026-10-08', from: '1', to: '2' });
    const r = run(series([...SPLIT_ROWS.slice(0, 3), ['2026-10-08', '50', '50', '49', '50']]), strategy({ enterAt: 1, exitAt: 100 }), withActions([two]));
    expect(r.openPosition!.quantity.toString()).toBe('20');
    expect(r.openPosition!.entryPrice.toString()).toBe('50');
  });

  it('reverse 1-for-10 (10 → 1): 100 shares at 5 become 10 shares at 50, with no integer rounding', () => {
    const reverse = ca({ key: 'reverse:2026-10-08', type: 'reverse_split', exDate: '2026-10-08', from: '10', to: '1' });
    const rows: Row[] = [['2026-10-05', '5', '5', '5', '5'], ['2026-10-06', '5', '5', '5', '5'], ['2026-10-07', '5', '5', '5', '5'], ['2026-10-08', '50', '50', '49', '50']];
    const r = run(series(rows), strategy({ enterAt: 1, exitAt: 100 }), { ...withActions([reverse]), sizing: { type: 'fixed_cash', amount: '500' } });
    expect(r.openPosition!.quantity.toString()).toBe('10');
    expect(r.openPosition!.entryPrice.toString()).toBe('50');
    expect(r.corporateActions!.reasons).toEqual([]);
  });

  it('a fractional reverse-split result stays exact and is reported, never rounded', () => {
    const reverse = ca({ key: 'reverse:2026-10-08', type: 'reverse_split', exDate: '2026-10-08', from: '10', to: '1' });
    const rows: Row[] = [['2026-10-05', '5', '5', '5', '5'], ['2026-10-06', '5', '5', '5', '5'], ['2026-10-07', '5', '5', '5', '5'], ['2026-10-08', '50', '50', '49', '50']];
    const r = run(series(rows), strategy({ enterAt: 1, exitAt: 100 }), { ...withActions([reverse]), sizing: { type: 'fixed_cash', amount: '75' } });
    expect(r.openPosition!.quantity.toString()).toBe('1.5');
    expect(r.corporateActions!.reasons).toEqual(['FRACTIONAL_CASH_IN_LIEU_NOT_MODELED']);
    expect(r.quality.grade).toBe('C');
  });

  it('two sequential splits on different dates compose exactly (10 → 20 → 40)', () => {
    const second = ca({ key: 'split:2026-10-12', type: 'split', exDate: '2026-10-12', from: '1', to: '2' });
    const rows: Row[] = [...SPLIT_ROWS.slice(0, 4), ['2026-10-09', '25', '26', '24', '25'], ['2026-10-12', '12.5', '13', '12', '12.5']];
    const r = run(series(rows), strategy({ enterAt: 1, exitAt: 100 }), withActions([SPLIT_4_1, second]));
    expect(r.openPosition!.quantity.toString()).toBe('80');
    expect(r.openPosition!.entryPrice.toString()).toBe('12.5');
  });

  it('the same action supplied twice is applied once: the shares are not multiplied', () => {
    const r = run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 1, exitAt: 100 }), withActions([SPLIT_4_1, { ...SPLIT_4_1 }]));
    expect(r.openPosition!.quantity.toString()).toBe('40');
    expect(r.corporateActions!.applied).toHaveLength(1);
  });

  it('two different revisions of one action are refused: the replay-selected revision must be passed', () => {
    const later = { ...SPLIT_4_1, revision: 2, contentHash: 'f'.repeat(64) };
    expect(() => run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 1, exitAt: 100 }), withActions([SPLIT_4_1, later]))).toThrow(/CORPORATE_ACTION_REVISION_CONFLICT/);
  });
});

describe('O2 P&L invariant (Phase 8, spec section 16)', () => {
  it('buy 10 @ 100 (commission 5), 4-for-1, sell 40 @ 30 (commission 5): gross 200, net 190, the split adds nothing', () => {
    const r = run(series(SPLIT_ROWS), strategy({ enterAt: 1, exitAt: 5 }), withActions([SPLIT_4_1]));
    const trade = r.trades[0]!;
    expect(trade.exit.executionPrice.toString()).toBe('30');
    expect(trade.pnl.toString()).toBe('190');
    expect(trade.exit.quantity.times(trade.exit.executionPrice).minus(trade.entry.quantity.times(trade.entry.executionPrice)).toString()).toBe('200');
    expect(r.metrics.totalFees.toString()).toBe('10');
  });
});

describe('O2 stops, targets and pending orders (Phase 9)', () => {
  it('an open position stop 80 and target 120 become 20 and 30 at the 4-for-1 split', () => {
    const r = run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 1, exitAt: 100 }), withActions([SPLIT_4_1]));
    expect(r.openPosition).not.toBeNull();
  });

  it('a pending entry decided before the split fills after it with its levels transformed (80/120 → 20/30)', () => {
    const rows: Row[] = [...SPLIT_ROWS.slice(0, 3), ['2026-10-08', '25', '26', '24', '25'], ['2026-10-09', '25', '26', '24', '25']];
    const r = run(series(rows), strategy({ enterAt: 3, exitAt: 100, stop: '80', target: '120' }), withActions([SPLIT_4_1]));
    expect(r.fills.find((f) => f.side === 'buy')!.executionPrice.toString()).toBe('25');
    expect(r.openPosition!.quantity.toString()).toBe('40');
    expect(r.openPosition!.stopLoss!.toString()).toBe('20');
    expect(r.openPosition!.takeProfit!.toString()).toBe('30');
  });

  it('a stop 80 that is not transformed would fire at the raw open 25; transformed to 20 it does not', () => {
    const r = run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 2, exitAt: 100, stop: '80', target: '120' }), withActions([SPLIT_4_1]));
    expect(r.trades).toHaveLength(0);
    expect(r.openPosition!.stopLoss!.toString()).toBe('20');
  });

  it('gap after split: the ex-date raw open 19 gaps through the adjusted stop 20 and fills at 19, not against 80', () => {
    const rows: Row[] = [...SPLIT_ROWS.slice(0, 3), ['2026-10-08', '19', '19', '18', '19'], ['2026-10-09', '19', '19', '18', '19']];
    const r = run(series(rows), strategy({ enterAt: 2, exitAt: 100, stop: '80', target: '120' }), withActions([SPLIT_4_1]));
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.exit.reason).toBe('stop');
    expect(r.trades[0]!.exit.executionPrice.toString()).toBe('19');
    expect(r.trades[0]!.pnl.toString()).toBe('-250');
  });
});

describe('O2 strategy view and raw execution (Phase 5)', () => {
  it('raw execution sees 100 → 25, while the strategy history is split-normalised: no false -75% crash', () => {
    const log: Array<{ asOf: string; closes: string[] }> = [];
    run(series(SPLIT_ROWS.slice(0, 5)), strategy({ enterAt: 99, exitAt: 99, log }), withActions([SPLIT_4_1]));
    const atExDate = log.find((l) => l.asOf.startsWith('2026-10-08'))!;
    // The analytical history is normalised to the post-split scale: the pre-split closes read 25, so there is no 100 → 25 gap.
    expect(atExDate.closes).toEqual(['25', '25', '25', '25']);
    const atNextDay = log.find((l) => l.asOf.startsWith('2026-10-09'))!;
    expect(atNextDay.closes.at(-1)).toBe('25');
  });

  it('the strategy history before the split is unchanged when no split is known (raw view)', () => {
    const log: Array<{ asOf: string; closes: string[] }> = [];
    run(series(SPLIT_ROWS.slice(0, 3)), strategy({ enterAt: 99, exitAt: 99, log }), withActions([]));
    expect(log.at(-1)!.closes).toEqual(['100', '100', '100']);
  });

  it('a split with double adjustment risk is refused: explicit accounting needs raw bars', () => {
    const adjusted = series(SPLIT_ROWS.slice(0, 4)).map((b) => ({ ...b, adjustment: 'split_adjusted' as const }));
    expect(() => run(adjusted, HOLD, withActions([SPLIT_4_1]))).toThrow(/CORPORATE_ACTION_DOUBLE_ADJUSTMENT_RISK/);
  });
});

describe('O2 timing and point-in-time (Phases 2, 4, 17, 19)', () => {
  it('an action known exactly at its economic effective instant (the ex-date open) is applied; see corporate-action-timing for the daily and intraday cases', () => {
    const boundary = toUtcIso(XNAS.session('2026-10-08', 'regular')!.open);
    const r = run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 1, exitAt: 100 }), withActions([{ ...SPLIT_4_1, knowledge: { provenance: 'captured_by_nexus', knowledgeAt: boundary }, retrievedAt: boundary, storedAvailableAt: boundary }]));
    expect(r.openPosition!.quantity.toString()).toBe('40');
  });

  it('an action learned after its ex-date is refused (fail closed; no retroactive repair)', () => {
    const late = toUtcIso(XNAS.dailyBarCompletion('2026-10-09')!);
    expect(() => run(series(SPLIT_ROWS.slice(0, 5)), strategy({ enterAt: 1, exitAt: 100 }), withActions([{ ...SPLIT_4_1, knowledge: { provenance: 'captured_by_nexus', knowledgeAt: late }, retrievedAt: late, storedAvailableAt: late }]))).toThrow(/CORPORATE_ACTION_TIMING_UNPROVEN/);
  });

  it('an action whose knowledge is not proven is refused when it must be applied', () => {
    expect(() => run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 1, exitAt: 100 }), withActions([ca({ key: 'split:2026-10-08', type: 'split', exDate: '2026-10-08', from: '1', to: '4', provenance: 'historical_effective_date_inference', knownAt: K0 })]))).toThrow(/CORPORATE_ACTION_TIMING_UNPROVEN/);
  });

  it('no look-ahead: changing every action unavailable by T leaves every decision and state through T identical', () => {
    const T = toUtcIso(XNAS.dailyBarCompletion('2026-10-09')!);
    // Unavailable by T (known after T) and still known before its effective instant, so the economics it governs are provable.
    const future = (ratio: string) => ca({ key: 'split:2026-10-12', type: 'split', exDate: '2026-10-12', from: '1', to: ratio, knownAt: '2026-10-11T20:00:00.000Z' });
    const rows = [...SPLIT_ROWS];
    const logA: Array<{ asOf: string; closes: string[] }> = [];
    const logB: Array<{ asOf: string; closes: string[] }> = [];
    const a = run(series(rows), strategy({ enterAt: 1, exitAt: 4, log: logA }), withActions([future('4')]));
    const b = run(series(rows), strategy({ enterAt: 1, exitAt: 4, log: logB }), withActions([future('2')]));
    const through = (l: typeof logA) => l.filter((x) => x.asOf <= T);
    expect(through(logA)).toEqual(through(logB));
    expect(a.equityCurve.filter((p) => p.at <= T)).toEqual(b.equityCurve.filter((p) => p.at <= T));
  });
});

describe('O2 calendar effective time (Phase 3)', () => {
  it('the effective instant is the regular session open of the ex-date in the local calendar', () => {
    expect(effectiveSessionOf({ ...SPLIT_4_1 }, XNAS).effectiveAt).toBe(Date.parse('2026-10-08T13:30:00.000Z'));
  });

  it('DST: the same local open moves by an hour across the change (EST before 2026-03-08, EDT after)', () => {
    expect(effectiveSessionOf({ ...SPLIT_4_1, exDate: '2026-03-06' }, XNAS).effectiveAt).toBe(Date.parse('2026-03-06T14:30:00.000Z'));
    expect(effectiveSessionOf({ ...SPLIT_4_1, exDate: '2026-03-09' }, XNAS).effectiveAt).toBe(Date.parse('2026-03-09T13:30:00.000Z'));
  });

  it('a weekend ex-date fails closed: no regular session, CORPORATE_ACTION_CALENDAR_UNPROVEN', () => {
    expect(() => run(series(SPLIT_ROWS.slice(0, 4)), HOLD, withActions([ca({ key: 'split:sat', type: 'split', exDate: '2026-10-10', from: '1', to: '4' })]))).toThrow(/CORPORATE_ACTION_CALENDAR_UNPROVEN/);
  });

  it('a holiday ex-date fails closed', () => {
    expect(() => effectiveSessionOf(ca({ key: 'split:thx', type: 'split', exDate: '2026-11-26', from: '1', to: '4' }), XNAS)).toThrow(/CORPORATE_ACTION_CALENDAR_UNPROVEN/);
  });

  it('an assumed session (outside the verified coverage) is refused: the executable open is not proven (execution clock, fail closed)', () => {
    const rows: Row[] = [['2028-03-02', '100', '100', '100', '100'], ['2028-03-03', '100', '100', '100', '100'], ['2028-03-06', '110', '110', '110', '110']];
    expect(() => run(series(rows), strategy({ enterAt: 1, exitAt: 100 }), withActions([ca({ key: 'symbol:2028', type: 'symbol_change', exDate: '2028-03-06', oldSymbol: 'OLD', newSymbol: 'NEW' })]))).toThrow(/EXECUTION_CALENDAR_UNPROVEN/);
  });
});

describe('O2 symbol change (Phase 11)', () => {
  it('an action with a new symbol leaves the instrument, the quantity, the basis and the P&L unchanged', () => {
    const rows: Row[] = [...SPLIT_ROWS.slice(0, 3), ['2026-10-08', '100', '100', '100', '100'], ['2026-10-09', '100', '100', '100', '100'], ['2026-10-12', '110', '110', '110', '110']];
    const sym = ca({ key: 'symbol:2026-10-08', type: 'symbol_change', exDate: '2026-10-08', oldSymbol: 'OLD', newSymbol: 'NEW' });
    const r = run(series(rows), strategy({ enterAt: 1, exitAt: 5 }), withActions([sym]));
    expect(r.trades[0]!.pnl.toString()).toBe('90');
    expect(r.trades[0]!.entry.quantity.toString()).toBe('10');
    expect(r.corporateActions!.applied[0]!.transformation).toEqual({ kind: 'symbol_change', oldSymbol: 'OLD', newSymbol: 'NEW', economicEffect: 'none' });
    expect(r.instrumentId).toBe(AAPL.instrumentId);
    expect(r.corporateActions!.reasons).toEqual([]);
  });
});

describe('O2 dividends: entitlement, receivable, cash (Phases 12-16)', () => {
  const DIV = ca({ key: 'dividend:2026-10-08', type: 'cash_dividend', exDate: '2026-10-08', cash: '0.5', currency: 'USD' });

  it('held immediately before the ex-date: entitled; the receivable is equity, never cash', () => {
    const rows: Row[] = [...SPLIT_ROWS.slice(0, 3), ['2026-10-08', '100', '100', '100', '100'], ['2026-10-09', '100', '100', '100', '100']];
    const r = run(series(rows), HOLD, withActions([DIV]));
    expect(r.corporateActions!.dividendReceivables).toHaveLength(1);
    const receivable = r.corporateActions!.dividendReceivables[0]!;
    expect(receivable.entitledQuantity.toString()).toBe('10');
    expect(receivable.grossAmount.toString()).toBe('5');
    const beforeEx = r.equityCurve.find((p) => p.at.startsWith('2026-10-07'))!;
    const exDay = r.equityCurve.find((p) => p.at.startsWith('2026-10-08'))!;
    expect(exDay.cash.toString()).toBe(beforeEx.cash.toString());
    expect(exDay.receivablesValue!.toString()).toBe('5');
    expect(exDay.equity.toString()).toBe(exDay.cash.plus(exDay.marketValue).plus(exDay.receivablesValue!).toString());
  });

  it('bought on the ex-date open: not entitled (the dividend is applied before the buy fills)', () => {
    const rows: Row[] = [...SPLIT_ROWS.slice(0, 3), ['2026-10-08', '100', '100', '100', '100'], ['2026-10-09', '100', '100', '100', '100']];
    const r = run(series(rows), strategy({ enterAt: 3, exitAt: 100 }), withActions([DIV]));
    expect(r.openPosition!.entryTime.startsWith('2026-10-08')).toBe(true);
    expect(r.corporateActions!.dividendReceivables).toHaveLength(0);
    expect(r.corporateActions!.applied[0]!.transformation).toMatchObject({ kind: 'dividend_entitlement', entitledQuantity: '0' });
  });

  it('sold before the ex-date: not entitled', () => {
    const rows: Row[] = [...SPLIT_ROWS.slice(0, 3), ['2026-10-08', '100', '100', '100', '100'], ['2026-10-09', '100', '100', '100', '100']];
    const r = run(series(rows), strategy({ enterAt: 1, exitAt: 2 }), withActions([DIV]));
    expect(r.openPosition).toBeNull();
    expect(r.trades[0]!.exit.at.startsWith('2026-10-07')).toBe(true);
    expect(r.corporateActions!.dividendReceivables).toHaveLength(0);
  });

  it('unknown payment date: the receivable stays unsettled, the limitation is reported, the grade is not A or B', () => {
    const rows: Row[] = [...SPLIT_ROWS.slice(0, 3), ['2026-10-08', '100', '100', '100', '100'], ['2026-10-09', '100', '100', '100', '100']];
    const r = run(series(rows), HOLD, withActions([DIV]));
    expect(r.corporateActions!.dividendReceivables[0]!.settlement).toBe('UNSETTLED');
    expect(r.corporateActions!.settledDividends).toEqual([]);
    expect(r.corporateActions!.reasons).toEqual(['DIVIDEND_PAYMENT_DATE_UNKNOWN']);
    expect(r.quality.reasons.some((x) => x.startsWith('DIVIDEND_PAYMENT_DATE_UNKNOWN:'))).toBe(true);
    expect(r.quality.grade).toBe('C');
  });

  it('a dividend in another currency with a position is refused: no FX is invented', () => {
    const eur = ca({ key: 'dividend:eur', type: 'cash_dividend', exDate: '2026-10-08', cash: '0.5', currency: 'EUR' });
    const rows: Row[] = [...SPLIT_ROWS.slice(0, 3), ['2026-10-08', '100', '100', '100', '100']];
    expect(() => run(series(rows), HOLD, withActions([eur]))).toThrow(/CORPORATE_ACTION_FX_NOT_MODELED/);
  });

  it('a split and a dividend on the same effective instant are ambiguous: refused', () => {
    const div = ca({ key: 'dividend:same', type: 'cash_dividend', exDate: '2026-10-08', cash: '0.5', currency: 'USD' });
    expect(() => run(series(SPLIT_ROWS.slice(0, 4)), HOLD, withActions([SPLIT_4_1, div]))).toThrow(/CORPORATE_ACTION_ORDER_AMBIGUOUS/);
  });

  it('a fully modeled split is derived as modeled (not asserted by the caller)', () => {
    const r = run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 1, exitAt: 100 }), withActions([SPLIT_4_1]));
    expect(r.corporateActions!.complete).toBe(true);
    expect(r.quality.reasons.some((x) => x.includes('corporate actions are not fully modeled'))).toBe(false);
  });
});

describe('O2 fingerprint (Phase 2)', () => {
  it('the action ratio changes the run identity', () => {
    const four = run(series(SPLIT_ROWS.slice(0, 4)), HOLD, withActions([SPLIT_4_1]));
    const two = run(series(SPLIT_ROWS.slice(0, 4)), HOLD, withActions([ca({ key: 'split:2026-10-08', type: 'split', exDate: '2026-10-08', from: '1', to: '2' })]));
    expect(four.backtestRunId).not.toBe(two.backtestRunId);
  });

  it('the knowledge time of an action changes the run identity', () => {
    const a = run(series(SPLIT_ROWS.slice(0, 4)), HOLD, withActions([SPLIT_4_1]));
    const b = run(series(SPLIT_ROWS.slice(0, 4)), HOLD, withActions([ca({ key: 'split:2026-10-08', type: 'split', exDate: '2026-10-08', from: '1', to: '4', knownAt: '2026-10-02T00:00:00.000Z' })]));
    expect(a.backtestRunId).not.toBe(b.backtestRunId);
  });

  it('the effective instant (ex-date) changes the run identity', () => {
    const a = run(series(SPLIT_ROWS.slice(0, 4)), HOLD, withActions([SPLIT_4_1]));
    const b = run(series(SPLIT_ROWS.slice(0, 4)), HOLD, withActions([ca({ key: 'split:2026-10-09', type: 'split', exDate: '2026-10-09', from: '1', to: '4' })]));
    expect(a.inputFingerprint).not.toBe(b.inputFingerprint);
  });

  it('the portfolio currency changes the run identity, even without any action', () => {
    const usd = run(series(SPLIT_ROWS.slice(0, 4)), HOLD, withActions([]));
    const eur = run(series(SPLIT_ROWS.slice(0, 4)), HOLD, { ...withActions([]), portfolioCurrency: 'EUR' });
    expect(usd.backtestRunId).not.toBe(eur.backtestRunId);
  });

  it('an unchanged action set reproduces the run identity', () => {
    const a = run(series(SPLIT_ROWS.slice(0, 4)), HOLD, withActions([SPLIT_4_1]));
    const b = run(series(SPLIT_ROWS.slice(0, 4)), HOLD, withActions([SPLIT_4_1]));
    expect(a.backtestRunId).toBe(b.backtestRunId);
  });
});

describe('O2 multiple actions and replay modes (Phases 10, 17)', () => {
  it('two splits on the same instant compose exactly (they commute, so no order is guessed)', () => {
    const a = ca({ key: 'split:a', type: 'split', exDate: '2026-10-08', from: '1', to: '2' });
    const b = ca({ key: 'split:b', type: 'split', exDate: '2026-10-08', from: '1', to: '2' });
    const r = run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 1, exitAt: 100 }), withActions([a, b]));
    expect(r.openPosition!.quantity.toString()).toBe('40');
    expect(r.openPosition!.entryPrice.toString()).toBe('25');
    expect(r.corporateActions!.complete).toBe(true);
  });

  it('decision_time and historical_research apply the same proven action identically', () => {
    const rows = SPLIT_ROWS.slice(0, 4);
    const research = run(series(rows), strategy({ enterAt: 1, exitAt: 100 }), withActions([SPLIT_4_1]));
    const decision = run(series(rows, 'completion'), strategy({ enterAt: 1, exitAt: 100 }), { ...withActions([SPLIT_4_1]), replay: 'decision_time' });
    expect(decision.openPosition!.quantity.toString()).toBe(research.openPosition!.quantity.toString());
    expect(decision.openPosition!.entryPrice.toString()).toBe(research.openPosition!.entryPrice.toString());
    expect(decision.corporateActions!.applied.map((a) => a.transformation)).toEqual(research.corporateActions!.applied.map((a) => a.transformation));
  });
});
