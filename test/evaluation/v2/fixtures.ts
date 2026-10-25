// R2 test fixtures: synthetic 15-minute bars with known prices, and complete trade plans. TEST ONLY.
import type { MarketBar } from '../../../src/market-data/market-data-types.js';
import { getCalendar } from '../../../src/market-data/sessions.js';
import { parseUtc, toUtcIso } from '../../../src/market-data/time.js';
import { Decimal } from '../../../src/money/decimal.js';
import type { SealedPlan } from '../../../src/evaluation/v2/plan-ledger.js';
import { OUTCOME_EVAL_V2, TRADE_PLAN_SCHEMA, tradePlanHash, type TradePlan } from '../../../src/evaluation/v2/trade-plan.js';

export const CAL = getCalendar('24x7')!;
export const XNAS = getCalendar('XNAS')!;
export const SOURCE = 'test:time_series:synthetic';
export const ENTRY_AT = '2026-10-07T10:00:00.000Z';
export const SEALED_AT = '2026-10-07T09:59:00.000Z';
export const AFTER = '2026-10-08T00:00:00.000Z';
const STEP = 15 * 60_000;

/** One final 15-minute bar starting `index` bars after `first` (default ENTRY_AT). */
export function bar(index: number, open: string, high: string, low: string, close: string, first = ENTRY_AT, overrides: Partial<MarketBar> = {}): MarketBar {
  const start = parseUtc(first) + index * STEP;
  const end = start + STEP;
  return {
    instrumentId: 'ins_test',
    interval: '15m',
    startTime: toUtcIso(start),
    endTime: toUtcIso(end),
    open: Decimal.from(open),
    high: Decimal.from(high),
    low: Decimal.from(low),
    close: Decimal.from(close),
    volume: Decimal.from('1000'),
    source: SOURCE,
    session: 'continuous',
    adjustment: 'raw',
    isFinal: true,
    observedAt: toUtcIso(end),
    availableAt: toUtcIso(end),
    retrievedAt: toUtcIso(end + 30_000),
    knowledge: { knownAt: toUtcIso(end + 30_000), knowledgeSource: 'captured_by_nexus', vintage: 'contemporaneous', vintagePolicy: 'bar-vintage:v1' },
    ...overrides,
  };
}

/** Bars from rows [open, high, low, close]. */
export function bars(rows: Array<[string, string, string, string]>, first = ENTRY_AT): MarketBar[] {
  return rows.map((r, i) => bar(i, ...r, first));
}

export const ZERO_COSTS = Object.freeze({ version: 'costs:zero', commissionBps: 0, fixedFeePerSide: '0', spreadBps: 0, spreadSource: 'modeled' as const, slippageBps: 0 });

/** A complete long plan: entry 100 (next bar open), stop 95, target 110, 4 bars, 1000 notional, no costs. */
export function plan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    schema: TRADE_PLAN_SCHEMA,
    planId: 'plan-1',
    signalId: 'sig-1',
    decisionId: 'dec-1',
    instrumentId: 'ins_test',
    source: SOURCE,
    interval: '15m',
    side: 'long',
    positionContext: 'flat',
    strategy: { id: 'ref-strategy', version: '1.0.0' },
    ruleVersion: 'rules:1',
    codeVersion: 'abc1234',
    evaluationMethod: OUTCOME_EVAL_V2,
    origin: 'historical_simulation',
    realization: 'HYPOTHETICAL',
    entry: { method: 'next_bar_open', earliestEntryAt: ENTRY_AT },
    stopLoss: '95',
    takeProfit: '110',
    maxHoldingBars: 4,
    size: { kind: 'notional', amount: '1000' },
    costs: { ...ZERO_COSTS },
    intrabarPolicy: 'conservative_stop_first',
    dataBasis: { asOf: '2026-10-07T09:45:00.000Z', storedThrough: 42, inputFingerprint: 'a'.repeat(64) },
    ...overrides,
  };
}

/** A short plan: entry 100, stop 105, target 90. */
export function shortPlan(overrides: Partial<TradePlan> = {}): TradePlan {
  return plan({ side: 'short', stopLoss: '105', takeProfit: '90', ...overrides });
}

export function sealed(p: TradePlan, sealedAt = SEALED_AT): SealedPlan {
  return { plan: p, planHash: tradePlanHash(p), sealedAt, sequence: 1 };
}
