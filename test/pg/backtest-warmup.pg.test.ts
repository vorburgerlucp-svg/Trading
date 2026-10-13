import { getCalendar } from '../../src/market-data/sessions.js';
import { afterEach, describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/backtest/backtest-engine.js';
import type { BacktestStrategy, StrategyContext } from '../../src/backtest/strategy.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { Decimal } from '../../src/money/decimal.js';
import { canonicalJson } from '../../src/persistence/canonical-json.js';
import { PostgresBacktestRunStore } from '../../src/persistence/postgres/postgres-scanner-backtest-store.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

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

function strategy(requiredBars: number, preferredBars: number): BacktestStrategy {
  return {
    id: 'warmup-persist',
    version: '1',
    definition: { requiredBars, preferredBars },
    warmup: { requiredBars, preferredBars, algorithmVersion: 'test-warmup:v1' },
    evaluate(ctx: StrategyContext) {
      if (!ctx.position && ctx.history.length === requiredBars) return { action: 'ENTER_LONG', reasons: ['first evaluation'] };
      return { action: 'NONE', reasons: [] };
    },
  };
}

const quality = { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'not_modeled' as const, providerProduction: true, minimumTrades: 1 };
const zeroCost = { commissionBps: 0, spreadBps: 0, slippageBps: 0, minCommission: '0' };
const run = (bars: MarketBar[], s: BacktestStrategy) => runBacktest({ bars, strategy: s, portfolioCurrency: 'USD', executionCalendar: getCalendar('XNAS')!, initialCapital: Decimal.from(1000), sizing: { type: 'fixed_cash', amount: '100' }, costModel: zeroCost, quality });

describe.skipIf(!pgAvailable)('PostgreSQL backtest warm-up roundtrip' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase | null = null;
  afterEach(async () => { await db?.drop(); db = null; });

  it('warm-up metadata survives the lossless JSONB roundtrip for an INVALID run and for a preferred-not-met run', async () => {
    db = await createTestDatabase();
    const store = new PostgresBacktestRunStore(db.pool);
    const insufficient = run([bar(0, '100'), bar(1, '101'), bar(2, '102')], strategy(5, 5));
    const preferredMissed = run(Array.from({ length: 10 }, (_, i) => bar(i, String(100 + i))), strategy(5, 20));

    expect(await store.save(insufficient)).toBe('APPLIED');
    expect(await store.save(preferredMissed)).toBe('APPLIED');
    expect(canonicalJson(await store.get(insufficient.backtestRunId))).toBe(canonicalJson(insufficient));
    expect(canonicalJson(await store.get(preferredMissed.backtestRunId))).toBe(canonicalJson(preferredMissed));

    const back = await store.get(insufficient.backtestRunId);
    expect(back?.warmup).toMatchObject({ requiredBars: 5, requiredWarmupMet: false, firstStrategyEvaluationAt: null });
    expect(back?.quality.grade).toBe('INVALID');
    const grades = await db.pool.query<{ quality_grade: string }>('SELECT quality_grade FROM backtest_runs WHERE backtest_run_id = ANY($1::text[]) ORDER BY backtest_run_id', [[insufficient.backtestRunId, preferredMissed.backtestRunId]]);
    expect(grades.rows.map((r) => r.quality_grade)).toContain('INVALID');
    expect((await store.get(preferredMissed.backtestRunId))?.warmup).toMatchObject({ preferredWarmupMet: false, requiredWarmupMet: true });
  });

  it('privileged tampering with a warm-up flag is caught by the stored hash', async () => {
    db = await createTestDatabase();
    const store = new PostgresBacktestRunStore(db.pool);
    const insufficient = run([bar(0, '100'), bar(1, '101')], strategy(5, 5));
    await store.save(insufficient);
    const privileged = await db.privilegedClient();
    try {
      await privileged.query("SET session_replication_role = 'replica'");
      const payload = (await privileged.query<{ result: Record<string, unknown> }>('SELECT result FROM backtest_runs WHERE backtest_run_id = $1', [insufficient.backtestRunId])).rows[0]!.result;
      (payload.warmup as Record<string, unknown>).requiredWarmupMet = true;
      await privileged.query('UPDATE backtest_runs SET result = $1::jsonb WHERE backtest_run_id = $2', [JSON.stringify(payload), insufficient.backtestRunId]);
    } finally {
      await privileged.end();
    }
    await expect(store.get(insufficient.backtestRunId)).rejects.toThrow(/hash mismatch/);
  });
});
