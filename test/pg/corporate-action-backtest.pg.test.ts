import { afterEach, describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/backtest/backtest-engine.js';
import { BacktestRunIntegrityError } from '../../src/backtest/backtest-store.js';
import type { BacktestRunResult, CorporateActionInput } from '../../src/backtest/backtest-types.js';
import type { BacktestStrategy } from '../../src/backtest/strategy.js';
import type { MarketBar, StoredCorporateAction } from '../../src/market-data/market-data-types.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { Decimal } from '../../src/money/decimal.js';
import { PostgresBacktestRunStore } from '../../src/persistence/postgres/postgres-scanner-backtest-store.js';
import { AAPL, FIXTURE_SOURCE, dailyBars } from '../market-data/fixtures.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// O2 persistence: a run with corporate-action accounting round-trips losslessly, and a tampered audit is rejected on read.

const XNAS = getCalendar('XNAS')!;
const K0 = '2026-10-01T00:00:00.000Z';

function series(rows: ReadonlyArray<readonly [string, string]>): MarketBar[] {
  return rows.map(([date, price]) => dailyBars(XNAS, date, [{ open: price, high: price, low: price, close: price, volume: '1000' }])[0]!);
}

function action(p: Partial<StoredCorporateAction> & Pick<StoredCorporateAction, 'actionKey' | 'type' | 'exDate'>): StoredCorporateAction {
  return { instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, retrievedAt: K0, knowledge: { provenance: 'captured_by_nexus', knowledgeAt: K0 }, revision: 1, ingestSeq: 1, contentHash: 'e'.repeat(64), storedAvailableAt: K0, provenanceHash: null, ...p };
}

const holdStrategy: BacktestStrategy = {
  id: 'o2-pg-hold',
  version: '1',
  definition: { enterAt: 2 },
  warmup: { requiredBars: 1, preferredBars: 1, algorithmVersion: 'test-warmup:v1' },
  evaluate(ctx) {
    if (!ctx.position && ctx.history.length === 2) return { action: 'ENTER_LONG', reasons: ['entry'] };
    return { action: 'NONE', reasons: [] };
  },
};

function runWithAccounting(): BacktestRunResult {
  const bars = series([
    ['2026-10-05', '100'],
    ['2026-10-06', '100'],
    ['2026-10-07', '100'],
    ['2026-10-08', '25'],
    ['2026-10-09', '25'],
  ]);
  const input: CorporateActionInput = {
    calendar: XNAS,
    actions: [
      action({ actionKey: 'split:2026-10-08', type: 'split', exDate: '2026-10-08', ratioFrom: Decimal.from('1'), ratioTo: Decimal.from('4') }),
      // A different session from the split: a split and a cash dividend on one instant are ambiguous (refused by the engine).
      action({ actionKey: 'dividend:2026-10-09', type: 'cash_dividend', exDate: '2026-10-09', cashAmount: Decimal.from('0.25'), currency: 'USD' }),
    ],
  };
  return runBacktest({
    bars,
    strategy: holdStrategy,
    initialCapital: Decimal.from(10_000),
    portfolioCurrency: 'USD',
    executionCalendar: XNAS,
    sizing: { type: 'fixed_cash', amount: '1000' },
    costModel: { commissionBps: 0, spreadBps: 0, slippageBps: 0, minCommission: '5' },
    quality: { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'not_modeled', providerProduction: true, minimumTrades: 1 },
    corporateActions: input,
  });
}

describe.skipIf(!pgAvailable)('corporate-action backtest runs on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase | null = null;
  afterEach(async () => {
    await db?.drop();
    db = null;
  });

  it('the audit, receivables, split values, base currency and input fingerprint round-trip losslessly', async () => {
    db = await createTestDatabase();
    const run = runWithAccounting();
    expect(run.corporateActions!.dividendReceivables).toHaveLength(1);
    expect(run.corporateActions!.applied).toHaveLength(2);
    await new PostgresBacktestRunStore(db.pool).save(run);
    const back = await new PostgresBacktestRunStore(db.pool).get(run.backtestRunId);
    expect(back).not.toBeNull();
    expect(back!.corporateActions).toEqual(run.corporateActions);
    expect(back!.portfolioCurrency).toBe('USD');
    expect(back!.inputFingerprint).toBe(run.inputFingerprint);
    expect(back!.openPosition!.entryFillId).toBe(run.openPosition!.entryFillId);
    expect(back!.equityCurve).toEqual(run.equityCurve);
  });

  it('a tampered corporate-action audit is rejected on read', async () => {
    db = await createTestDatabase();
    const run = runWithAccounting();
    await new PostgresBacktestRunStore(db.pool).save(run);
    const privileged = await db.privilegedClient();
    try {
      await privileged.query("SET session_replication_role = 'replica'");
      // Change the stored split quantity without touching the hash: the payload no longer matches what was committed.
      await privileged.query(
        `UPDATE backtest_runs SET result = jsonb_set(result, '{corporateActions,applied,0,transformation,quantityAfter}', '"41"') WHERE backtest_run_id = $1`,
        [run.backtestRunId],
      );
    } finally {
      await privileged.end();
    }
    await expect(new PostgresBacktestRunStore(db.pool).get(run.backtestRunId)).rejects.toBeInstanceOf(BacktestRunIntegrityError);
  });
});
