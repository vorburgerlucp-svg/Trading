import { afterEach, describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/backtest/backtest-engine.js';
import type { BacktestStrategy } from '../../src/backtest/strategy.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { Decimal } from '../../src/money/decimal.js';
import { canonicalJson, hashOf } from '../../src/persistence/canonical-json.js';
import { PostgresBacktestRunStore, PostgresScannerRunStore } from '../../src/persistence/postgres/postgres-scanner-backtest-store.js';
import type { ScannerRun } from '../../src/scanner/scanner-types.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

function bar(index: number, open: string, close: string): MarketBar {
  const start = Date.parse('2026-10-08T13:30:00.000Z') + index * 300_000;
  const end = start + 300_000;
  const o = Decimal.from(open);
  const c = Decimal.from(close);
  return {
    instrumentId: 'TEST',
    interval: '5m',
    startTime: new Date(start).toISOString(),
    endTime: new Date(end).toISOString(),
    open: o,
    high: o.gte(c) ? o.plus(1) : c.plus(1),
    low: o.lte(c) ? o.minus(1) : c.minus(1),
    close: c,
    volume: Decimal.from(1000),
    source: 'fixture:production',
    session: 'regular',
    adjustment: 'raw',
    isFinal: true,
    observedAt: new Date(end).toISOString(),
    availableAt: new Date(end).toISOString(),
    retrievedAt: new Date(end).toISOString(), knowledge: { knownAt: new Date(end).toISOString(), knowledgeSource: 'captured_by_nexus', vintage: 'historical_reconstruction', vintagePolicy: 'bar-vintage:v1' },
  };
}

function scannerRun(): ScannerRun {
  const definition = { id: 'scan-basic', version: '1', universeId: 'U', interval: '1d', filters: [], ranking: [], maxCandidates: 10 };
  const inputFingerprint = hashOf({ fixture: 'scanner-persistence-v1' });
  const scannerRunId = 'scan_' + inputFingerprint.slice(0, 40);
  return {
    scannerRunId,
    inputFingerprint,
    definition,
    definitionId: definition.id,
    definitionVersion: definition.version,
    universeId: definition.universeId,
    universeFingerprint: hashOf({ members: ['TEST'] }),
    universePointInTimeSafe: true,
    asOf: '2026-10-08T20:00:00.000Z',
    coverage: { universeMembers: 1, snapshotsProvided: 1, evaluatedInstruments: 1, missingInstruments: [], duplicateInstruments: [], complete: true },
    rankingComplete: true,
    candidates: [{
      scannerRunId,
      instrumentId: 'TEST',
      asOf: '2026-10-08T20:00:00.000Z',
      quantRunId: 'qr_' + 'a'.repeat(40),
      passedFilters: [],
      failedFilters: [],
      rankingScore: 12.5,
      rank: 1,
      dataQualityStatus: 'ok',
      barKnowledge: { decisionTimeKnowledgeProven: true, allBarsContemporaneousVintage: true, historicalReconstruction: false, legacyUnproven: false, latestFinalBarContemporaneous: true },
    }],
    rejected: [],
  };
}

function backtestRun() {
  const strategy: BacktestStrategy = {
    id: 'persist-fixture',
    version: '1',
    definition: { entryHistoryLength: 1, exitHistoryLength: 3 },
    warmup: { requiredBars: 1, preferredBars: 1, algorithmVersion: 'test-warmup:v1' },
    evaluate(ctx) {
      if (!ctx.position && ctx.history.length === 1) return { action: 'ENTER_LONG', reasons: ['fixture'] };
      if (ctx.position && ctx.history.length === 3) return { action: 'EXIT_LONG', reasons: ['fixture'] };
      return { action: 'NONE', reasons: [] };
    },
  };
  return runBacktest({
    bars: [bar(0, '100', '100'), bar(1, '101', '102'), bar(2, '103', '103'), bar(3, '104', '104')],
    strategy,
    portfolioCurrency: 'USD', initialCapital: Decimal.from(1000),
    sizing: { type: 'fixed_cash', amount: '500' },
    costModel: { commissionBps: 5, spreadBps: 10, slippageBps: 5, minCommission: '1' },
    quality: { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'not_modeled', providerProduction: true, minimumTrades: 1 },
  });
}

describe.skipIf(!pgAvailable)('PostgreSQL scanner/backtest audit' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase | null = null;
  afterEach(async () => { await db?.drop(); db = null; });

  it('persists scanner and backtest runs losslessly and idempotently', async () => {
    db = await createTestDatabase();
    const scannerStore = new PostgresScannerRunStore(db.pool);
    const backtestStore = new PostgresBacktestRunStore(db.pool);
    const scan = scannerRun();
    const backtest = backtestRun();

    expect(await scannerStore.save(scan)).toBe('APPLIED');
    expect(await scannerStore.save(scan)).toBe('ALREADY_APPLIED');
    expect(await backtestStore.save(backtest)).toBe('APPLIED');
    expect(await backtestStore.save(backtest)).toBe('ALREADY_APPLIED');

    expect(canonicalJson(await scannerStore.get(scan.scannerRunId))).toBe(canonicalJson(scan));
    expect(canonicalJson(await backtestStore.get(backtest.backtestRunId))).toBe(canonicalJson(backtest));

    expect(Number((await db.pool.query<{ n: string }>('SELECT count(*) AS n FROM scanner_candidates')).rows[0]!.n)).toBe(1);
    expect(Number((await db.pool.query<{ n: string }>('SELECT count(*) AS n FROM backtest_fills')).rows[0]!.n)).toBe(backtest.fills.length);
    expect(Number((await db.pool.query<{ n: string }>('SELECT count(*) AS n FROM backtest_trades')).rows[0]!.n)).toBe(backtest.trades.length);
  });

  it('detects same-id different-content conflicts', async () => {
    db = await createTestDatabase();
    const store = new PostgresScannerRunStore(db.pool);
    const original = scannerRun();
    await store.save(original);
    const changed: ScannerRun = { ...original, rejected: [{ instrumentId: 'X', reasons: ['changed after fingerprint'] }] };
    await expect(store.save(changed)).rejects.toThrow(/different content/);
  });

  it('database refuses ordinary mutation and hash verification catches privileged tampering', async () => {
    db = await createTestDatabase();
    const store = new PostgresBacktestRunStore(db.pool);
    const run = backtestRun();
    await store.save(run);

    await expect(db.pool.query('UPDATE backtest_runs SET strategy_version = $1 WHERE backtest_run_id = $2', ['forged', run.backtestRunId])).rejects.toThrow(/NEXUS_APPEND_ONLY|immutable|append-only/i);

    const privileged = await db.privilegedClient();
    try {
      await privileged.query("SET session_replication_role = 'replica'");
      const payload = (await privileged.query<{ result: unknown }>('SELECT result FROM backtest_runs WHERE backtest_run_id=$1', [run.backtestRunId])).rows[0]!.result as Record<string, unknown>;
      payload.strategyVersion = 'tampered';
      await privileged.query('UPDATE backtest_runs SET result=$1::jsonb WHERE backtest_run_id=$2', [JSON.stringify(payload), run.backtestRunId]);
    } finally {
      await privileged.end();
    }
    await expect(store.get(run.backtestRunId)).rejects.toThrow(/hash mismatch/);
  });
});
