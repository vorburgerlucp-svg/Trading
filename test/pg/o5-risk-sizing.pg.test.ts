import { getCalendar } from '../../src/market-data/sessions.js';
import { afterEach, describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/backtest/backtest-engine.js';
import type { BacktestStrategy, StrategyContext, StrategyDecision } from '../../src/backtest/strategy.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { Decimal } from '../../src/money/decimal.js';
import { canonicalJson } from '../../src/persistence/canonical-json.js';
import { PostgresBacktestRunStore } from '../../src/persistence/postgres/postgres-scanner-backtest-store.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// O5 risk sizing persistence (docs/O5_EXECUTABLE_RISK_SIZING_V1.md §13, §14, §46, §47). The audit rides in the lossless JSONB run, so it must survive the round
// trip, and any privileged change to it must fail the stored hash.

const START_MS = Date.parse('2026-10-08T13:30:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function bar(index: number, price: string): MarketBar {
  const start = START_MS + index * 300_000;
  const end = start + 300_000;
  const p = Decimal.from(price);
  return {
    instrumentId: 'TEST', interval: '5m', startTime: iso(start), endTime: iso(end), open: p, high: p, low: p, close: p, volume: Decimal.from(1000),
    source: 'fixture:production', session: 'regular', adjustment: 'raw', isFinal: true,
    observedAt: iso(end), availableAt: iso(end), retrievedAt: iso(end),
    knowledge: { knownAt: iso(end), knowledgeSource: 'captured_by_nexus', vintage: 'historical_reconstruction', vintagePolicy: 'bar-vintage:v1' },
  };
}

/** Enters once, on the first evaluation, with a stop of 95. */
const entry: BacktestStrategy = {
  id: 'o5-persist',
  version: '1',
  definition: { stop: '95' },
  warmup: { requiredBars: 1, preferredBars: 1, algorithmVersion: 'test-warmup:v1' },
  evaluate(ctx: StrategyContext): StrategyDecision {
    if (!ctx.position && ctx.history.length === 1) return { action: 'ENTER_LONG', reasons: ['o5 entry'], stopLoss: Decimal.from('95') };
    return { action: 'NONE', reasons: [] };
  },
};

const quality = { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'not_modeled' as const, providerProduction: true, minimumTrades: 1 };
const sizing = { type: 'risk_per_trade' as const, riskBasisPoints: 100, maxCashBasisPoints: 10_000, stopGapStressBasisPoints: 200 };
const costs = { commissionBps: 100, spreadBps: 0, slippageBps: 0, minCommission: '0' };

function riskRun() {
  return runBacktest({
    bars: [bar(0, '100'), bar(1, '100'), bar(2, '100'), bar(3, '100')], strategy: entry, portfolioCurrency: 'USD', executionCalendar: getCalendar('XNAS')!,
    initialCapital: Decimal.from(10_000), sizing, costModel: costs, quality,
  });
}

describe.skipIf(!pgAvailable)('PostgreSQL O5 risk sizing roundtrip' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase | null = null;
  afterEach(async () => {
    await db?.drop();
    db = null;
  });

  it('the executable risk audit survives the lossless JSONB roundtrip, and the canonical form is equal', async () => {
    db = await createTestDatabase();
    const store = new PostgresBacktestRunStore(db.pool);
    const run = riskRun();
    expect(await store.save(run)).toBe('APPLIED');
    const back = await store.get(run.backtestRunId);
    expect(canonicalJson(back)).toBe(canonicalJson(run));
    const audit = back!.fills.find((f) => f.side === 'buy')!.riskSizing!;
    expect(audit.version).toBe('risk-sizing:v1');
    expect(audit.stressRawExitPrice.toString()).toBe('93.1');
    expect(audit.quantity.eq(back!.fills.find((f) => f.side === 'buy')!.quantity)).toBe(true);
  });

  it('privileged tampering with a stored audit field is caught by the stored hash', async () => {
    db = await createTestDatabase();
    const store = new PostgresBacktestRunStore(db.pool);
    const run = riskRun();
    await store.save(run);
    const privileged = await db.privilegedClient();
    try {
      await privileged.query("SET session_replication_role = 'replica'");
      const payload = (await privileged.query<{ result: Record<string, unknown> }>('SELECT result FROM backtest_runs WHERE backtest_run_id = $1', [run.backtestRunId])).rows[0]!.result;
      const fills = payload.fills as Array<{ side: string; riskSizing?: Record<string, unknown> }>;
      const buy = fills.find((f) => f.side === 'buy')!;
      buy.riskSizing!.riskBasisPoints = 99;
      await privileged.query('UPDATE backtest_runs SET result = $1::jsonb WHERE backtest_run_id = $2', [JSON.stringify(payload), run.backtestRunId]);
    } finally {
      await privileged.end();
    }
    await expect(store.get(run.backtestRunId)).rejects.toThrow(/hash mismatch/);
  });
});
