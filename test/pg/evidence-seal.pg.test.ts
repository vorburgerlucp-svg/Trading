import { afterEach, describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/backtest/backtest-engine.js';
import type { BacktestStrategy } from '../../src/backtest/strategy.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { Decimal } from '../../src/money/decimal.js';
import { hashOf } from '../../src/persistence/canonical-json.js';
import { EvidenceSealIntegrityError } from '../../src/persistence/evidence-seal.js';
import { PostgresBacktestRunStore, PostgresScannerRunStore } from '../../src/persistence/postgres/postgres-scanner-backtest-store.js';
import type { ScannerRun } from '../../src/scanner/scanner-types.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// Fixtures follow scanner-backtest-core.pg.test.ts (same shapes, same engine path), kept local so each file stands alone.

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
  const definition = { id: 'scan-seal', version: '1', universeId: 'U', interval: '1d', filters: [], ranking: [], maxCandidates: 10 };
  const inputFingerprint = hashOf({ fixture: 'scanner-seal-v1' });
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
    candidates: [],
    rejected: [],
    inputsAvailableAt: '2026-10-08T19:59:00.000Z',
  };
}

function backtestRun() {
  const strategy: BacktestStrategy = {
    id: 'seal-fixture',
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

describe.skipIf(!pgAvailable)('PostgreSQL commit seals (evidence time proof)' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase | null = null;
  afterEach(async () => { await db?.drop(); db = null; });

  it('a committed run gets a seal: recordedAt before the commit, sealedAt after it, both inside the save window', async () => {
    db = await createTestDatabase();
    const store = new PostgresScannerRunStore(db.pool);
    const run = scannerRun();
    const windowStart = Date.now() - 1_000; // the database and the test share this machine's clock
    expect(await store.save(run)).toBe('APPLIED');
    const windowEnd = Date.now() + 1_000;

    const sealed = await store.getSealed(run.scannerRunId);
    expect(sealed?.seal).toMatchObject({ kind: 'scanner_run', recordId: run.scannerRunId, resultHash: hashOf(run) });
    const recordedMs = Date.parse(sealed!.seal!.recordedAt);
    const sealedMs = Date.parse(sealed!.seal!.sealedAt);
    expect(recordedMs).toBeGreaterThanOrEqual(windowStart);
    expect(sealedMs).toBeLessThanOrEqual(windowEnd);
    expect(recordedMs).toBeLessThanOrEqual(sealedMs);
  });

  it('the recorded_at column and the seal agree, so there is no second, conflicting recording time', async () => {
    db = await createTestDatabase();
    const store = new PostgresBacktestRunStore(db.pool);
    const run = backtestRun();
    await store.save(run);
    const sealed = await store.getSealed(run.backtestRunId);
    const row = (await db.pool.query<{ recorded_at: Date }>('SELECT recorded_at FROM backtest_runs WHERE backtest_run_id = $1', [run.backtestRunId])).rows[0]!;
    expect(row.recorded_at.toISOString()).toBe(sealed?.seal?.recordedAt);
    expect(sealed?.seal?.kind).toBe('backtest_run');
  });

  it('a repeated save keeps the original seal: no new recordedAt or sealedAt is written', async () => {
    db = await createTestDatabase();
    const store = new PostgresScannerRunStore(db.pool);
    const run = scannerRun();
    await store.save(run);
    const first = (await store.getSealed(run.scannerRunId))?.seal;
    expect(await store.save(run)).toBe('ALREADY_APPLIED');
    const again = (await store.getSealed(run.scannerRunId))?.seal;
    expect(again).toEqual(first);
    expect(Number((await db.pool.query<{ n: string }>('SELECT count(*) AS n FROM evidence_seals WHERE record_id = $1', [run.scannerRunId])).rows[0]!.n)).toBe(1);
  });

  it('the database refuses ordinary mutation of a seal', async () => {
    db = await createTestDatabase();
    const store = new PostgresScannerRunStore(db.pool);
    const run = scannerRun();
    await store.save(run);
    await expect(db.pool.query("UPDATE evidence_seals SET sealed_at = sealed_at WHERE record_id = $1", [run.scannerRunId])).rejects.toThrow(/NEXUS_APPEND_ONLY|immutable|append-only/i);
    await expect(db.pool.query("DELETE FROM evidence_seals WHERE record_id = $1", [run.scannerRunId])).rejects.toThrow(/NEXUS_APPEND_ONLY|immutable|append-only/i);
  });

  it('privileged tampering with recorded_at is detected: the seal hash no longer verifies', async () => {
    db = await createTestDatabase();
    const store = new PostgresScannerRunStore(db.pool);
    const run = scannerRun();
    await store.save(run);
    const privileged = await db.privilegedClient();
    try {
      await privileged.query("SET session_replication_role = 'replica'");
      await privileged.query("UPDATE evidence_seals SET recorded_at = recorded_at - interval '1 day' WHERE record_id = $1", [run.scannerRunId]);
    } finally {
      await privileged.end();
    }
    await expect(store.getSealed(run.scannerRunId)).rejects.toBeInstanceOf(EvidenceSealIntegrityError);
  });

  it('a run without a seal (stored before sealing, or interrupted before it) reads as unsealed, never as an invented time', async () => {
    db = await createTestDatabase();
    const store = new PostgresScannerRunStore(db.pool);
    const run = scannerRun();
    await store.save(run);
    const privileged = await db.privilegedClient();
    try {
      await privileged.query("SET session_replication_role = 'replica'");
      await privileged.query('DELETE FROM evidence_seals WHERE record_id = $1', [run.scannerRunId]);
    } finally {
      await privileged.end();
    }
    const sealed = await store.getSealed(run.scannerRunId);
    expect(sealed?.record.scannerRunId).toBe(run.scannerRunId);
    expect(sealed?.seal).toBeNull();
  });
});
