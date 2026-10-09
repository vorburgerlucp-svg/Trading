import { describe, expect, it } from 'vitest';
import { getCalendar } from '../../src/market-data/sessions.js';
import { parseUtc, toUtcIso } from '../../src/market-data/time.js';
import { Decimal } from '../../src/money/decimal.js';
import { computeQuant } from '../../src/quant/quant-engine.js';
import { runMarketScanner } from '../../src/scanner/market-scanner.js';
import type { ScannerDefinition, ScannerSnapshot } from '../../src/scanner/scanner-types.js';
import { AAPL, PRODUCTION_LIKE_SOURCE, dailyBars, randomOhlcv } from '../market-data/fixtures.js';
import { InMemoryUniverseStore } from '../../src/universe/universe-store.js';
import { strictSelection } from '../universe/fixtures.js';

const XNAS = getCalendar('XNAS')!;

function quant() {
  // Bars captured live: NEXUS held each revision one minute after its completion, so trading use is proven (not a backfill).
  const bars = dailyBars(XNAS, '2026-01-05', randomOhlcv(220, 77), { source: PRODUCTION_LIKE_SOURCE.sourceId }).map((b) => {
    const at = toUtcIso(parseUtc(b.observedAt) + 60_000);
    return { ...b, retrievedAt: at, knowledge: { knownAt: at, knowledgeSource: 'captured_by_nexus' as const, vintage: 'contemporaneous' as const, vintagePolicy: 'bar-vintage:v1' } };
  });
  // Trading freshness belongs to the scanner contract. Keep the fixture at the first instant after
  // the latest final bar instead of choosing a later wall-clock date that would correctly be stale.
  const asOf = toUtcIso(parseUtc(bars.at(-1)!.availableAt) + 60_000);
  const q = computeQuant(
    {
      instrument: AAPL,
      calendar: XNAS,
      series: { source: PRODUCTION_LIKE_SOURCE.sourceId, interval: '1d', session: 'regular', adjustment: 'raw' },
      bars,
      asOf,
      sourceInfo: PRODUCTION_LIKE_SOURCE,
      useCase: 'analysis',
    },
    { createdAt: '2026-12-31T00:00:00.000Z' },
  );
  return { q, asOf };
}

function definition(): ScannerDefinition {
  return {
    id: 'basic',
    version: '1',
    universeId: 'U',
    interval: '1d',
    filters: [{ type: 'minimum_price', value: '0.01' }],
    ranking: [{ type: 'adx', weight: 1 }],
    maxCandidates: 10,
  };
}

function scannerSnapshot(q: ReturnType<typeof quant>['q'], asOf: string, overrides: Partial<ScannerSnapshot> = {}): ScannerSnapshot {
  return {
    instrumentId: AAPL.instrumentId,
    asOf,
    lastPrice: q.supportResistance.nearestSupport?.priceLevel ?? Decimal.from(100),
    lastPriceAvailableAt: asOf,
    averageVolume: Decimal.from(1_000_000),
    averageVolumeAvailableAt: asOf,
    quant: q,
    ...overrides,
  };
}

function scannerUniverse(asOf: string, extraMembers: string[] = []) {
  return strictSelection('U', [AAPL.instrumentId, ...extraMembers], asOf);
}

describe('point-in-time universe', () => {
  it('a member joins and leaves by effective complete snapshots; each decision sees the list in force', () => {
    const store = new InMemoryUniverseStore();
    store.registerDefinition({ universeId: 'U', definitionVersion: '1', name: 'U' });
    store.registerSource({ sourceId: 'fixture:u:production', provider: 'fixture', dataset: 'constituents', environment: 'production', license: 'internal_use' });
    const ingest = (effectiveAt: string, retrievedAt: string, ids: string[]) =>
      store.ingest({ universeId: 'U', sourceId: 'fixture:u:production', effectiveAt, retrievedAt, knowledgeSource: 'captured_by_nexus', knownAt: retrievedAt, completeness: 'COMPLETE', members: ids.map((id) => ({ sourceMemberKey: 'k:' + id, providerSymbol: id })) }, (m) => m.providerSymbol);
    ingest('2026-01-01T00:00:00.000Z', '2025-12-31T00:00:00.000Z', ['A']);
    ingest('2026-02-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z', ['A', 'B']);
    ingest('2026-06-01T00:00:00.000Z', '2026-05-31T00:00:00.000Z', ['B']);
    const at = (asOf: string) => store.select({ universeId: 'U', sourceId: 'fixture:u:production', asOf, mode: 'decision_time' }).members;
    expect(at('2026-01-15T00:00:00.000Z')).toEqual(['A']);
    expect(at('2026-03-01T00:00:00.000Z')).toEqual(['A', 'B']);
    expect(at('2026-07-01T00:00:00.000Z')).toEqual(['B']);
  });
});

describe('market scanner core', () => {
  it('accepts only universe members with trading-usable final quant data', () => {
    const { q, asOf } = quant();
    expect(q.dataQuality.usableForTrading).toBe(true);
    const universe = scannerUniverse(asOf);
    const run = runMarketScanner(definition(), universe, [scannerSnapshot(q, asOf)], asOf);
    expect(run.candidates).toHaveLength(1);
    expect(run.candidates[0]).toMatchObject({ instrumentId: AAPL.instrumentId, rank: 1, quantRunId: q.quantRunId });
    expect(run.universeEvidence.strictDecisionTime).toBe(true);
    expect(run.coverage.complete).toBe(true);
    expect(run.rankingComplete).toBe(true);
  });

  it('rejects a quant result that is not usable for trading and fingerprints the rejection', () => {
    const { q, asOf } = quant();
    expect(q.dataQuality.usableForTrading).toBe(true);
    const unsafe = { ...q, dataQuality: { ...q.dataQuality, usableForTrading: false } };
    const universe = scannerUniverse(asOf);
    const rejected = runMarketScanner(definition(), universe, [scannerSnapshot(unsafe, asOf, { lastPrice: Decimal.from(100) })], asOf);
    const accepted = runMarketScanner(definition(), universe, [scannerSnapshot(q, asOf, { lastPrice: Decimal.from(100) })], asOf);
    expect(rejected.candidates).toHaveLength(0);
    expect(accepted.candidates).toHaveLength(1);
    expect(rejected.rejected[0]?.reasons).toContain('market data not usable for trading');
    expect(rejected.scannerRunId).not.toBe(accepted.scannerRunId);
  });

  it('marks ranking incomplete when universe members are missing', () => {
    const { q, asOf } = quant();
    const run = runMarketScanner(definition(), scannerUniverse(asOf, ['SECOND']), [scannerSnapshot(q, asOf)], asOf);
    expect(run.candidates).toHaveLength(1);
    expect(run.coverage.missingInstruments).toEqual(['SECOND']);
    expect(run.coverage.complete).toBe(false);
    expect(run.rankingComplete).toBe(false);
    expect(run.rejected).toContainEqual({ instrumentId: 'SECOND', reasons: ['missing scanner snapshot'] });
  });

  it('rejects a quant result from a different interval than the scanner definition', () => {
    const { q, asOf } = quant();
    const wrongInterval = { ...q, series: { ...q.series, interval: '5m' as const } };
    const run = runMarketScanner(definition(), scannerUniverse(asOf), [scannerSnapshot(wrongInterval, asOf)], asOf);
    expect(run.candidates).toHaveLength(0);
    expect(run.rejected[0]?.reasons).toContain('quant interval does not match scanner interval');
  });

  it('rejects recycled quant state whose asOf no longer matches the scanner time', () => {
    const { q, asOf } = quant();
    const later = toUtcIso(parseUtc(asOf) + 60_000);
    const run = runMarketScanner(definition(), scannerUniverse(later), [scannerSnapshot(q, later)], later);
    expect(run.candidates).toHaveLength(0);
    expect(run.rejected[0]?.reasons).toContain('snapshot/quant asOf does not match scanner asOf');
  });

  it('rejects market values that were not yet available at scanner asOf', () => {
    const { q, asOf } = quant();
    const run = runMarketScanner(definition(), scannerUniverse(asOf), [
      scannerSnapshot(q, asOf, { lastPriceAvailableAt: toUtcIso(parseUtc(asOf) + 1) }),
    ], asOf);
    expect(run.candidates).toHaveLength(0);
    expect(run.rejected[0]?.reasons).toContain('last price not yet available at scanner asOf');
  });

  it('rejects duplicate snapshots instead of double-ranking one instrument', () => {
    const { q, asOf } = quant();
    const snap = scannerSnapshot(q, asOf);
    const run = runMarketScanner(definition(), scannerUniverse(asOf), [snap, { ...snap }], asOf);
    expect(run.candidates).toHaveLength(0);
    expect(run.coverage.duplicateInstruments).toEqual([AAPL.instrumentId]);
    expect(run.rankingComplete).toBe(false);
  });
});

