import { runBacktest } from '../../src/backtest/backtest-engine.js';
import type { BacktestInput, CorporateActionInput } from '../../src/backtest/backtest-types.js';
import type { BacktestStrategy, StrategyContext, StrategyDecision } from '../../src/backtest/strategy.js';
import type { CorporateActionKnowledgeProvenance, MarketBar, StoredCorporateAction } from '../../src/market-data/market-data-types.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { toUtcIso } from '../../src/market-data/time.js';
import { Decimal } from '../../src/money/decimal.js';
import { AAPL, FIXTURE_SOURCE, dailyBars, intradayBars } from '../market-data/fixtures.js';

// Shared builders for the O2 backtest tests. Expected values in the tests are derived from the spec, not read off the engine.

export const XNAS = getCalendar('XNAS')!;
export const costs = { commissionBps: 0, spreadBps: 0, slippageBps: 0, minCommission: '5' };
export const quality = { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'not_modeled' as const, providerProduction: true, minimumTrades: 1 };
export const K0 = '2026-10-01T00:00:00.000Z';
export const warmup = { requiredBars: 1, preferredBars: 1, algorithmVersion: 'test-warmup:v1' };

export type Row = readonly [date: string, open: string, high: string, low: string, close: string];
export type Log = Array<{ asOf: string; closes: string[] }>;

/** Daily raw bars of the instrument on the XNAS calendar. Retrieved long after completion (backfill) unless `completion` is asked. */
export function series(rows: readonly Row[], retrieval: 'backfill' | 'completion' = 'backfill'): MarketBar[] {
  return rows.map(([date, o, h, l, c]) => {
    const spec = retrieval === 'completion' ? { retrievedAt: toUtcIso(XNAS.dailyBarCompletion(date)!) } : {};
    return dailyBars(XNAS, date, [{ open: o, high: h, low: l, close: c, volume: '1000' }], spec)[0]!;
  });
}

/** Intraday raw bars of the instrument, consecutive on the XNAS regular session from `firstStart`. Rows are [open, high, low, close]. */
export function intraday(firstStart: string, rows: ReadonlyArray<readonly [string, string, string, string]>): MarketBar[] {
  return intradayBars(XNAS, firstStart, '5m', rows.map(([o, h, l, c]) => ({ open: o, high: h, low: l, close: c, volume: '1000' })));
}

export function ca(p: {
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
  source?: string;
}): StoredCorporateAction {
  const knownAt = p.knownAt ?? K0;
  return {
    actionKey: p.key,
    instrumentId: AAPL.instrumentId,
    source: p.source ?? FIXTURE_SOURCE.sourceId,
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

export const withActions = (actions: readonly StoredCorporateAction[]): { corporateActions: CorporateActionInput } => ({ corporateActions: { actions, calendar: XNAS } });

export function run(bars: MarketBar[], strategy: BacktestStrategy, extra: Partial<BacktestInput> = {}) {
  return runBacktest({ bars, strategy, initialCapital: Decimal.from(10_000), portfolioCurrency: 'USD', executionCalendar: getCalendar('XNAS')!, sizing: { type: 'fixed_cash', amount: '1000' }, costModel: costs, quality, ...extra });
}

/** Enters when the history reaches `enterAt` (with attached levels when given), exits when it reaches `exitAt`. Logs what it saw. */
export function strategy(opts: { enterAt: number; exitAt: number; stop?: string; target?: string; log?: Log }): BacktestStrategy {
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
export const SPLIT_ROWS: readonly Row[] = [
  ['2026-10-05', '100', '100', '100', '100'],
  ['2026-10-06', '100', '100', '100', '100'],
  ['2026-10-07', '100', '100', '100', '100'],
  ['2026-10-08', '25', '25', '24', '25'],
  ['2026-10-09', '25', '26', '24', '25'],
  ['2026-10-12', '30', '31', '29', '30'],
];
export const SPLIT_4_1 = ca({ key: 'split:2026-10-08', type: 'split', exDate: '2026-10-08', from: '1', to: '4' });
export const HOLD = strategy({ enterAt: 2, exitAt: 100 });
