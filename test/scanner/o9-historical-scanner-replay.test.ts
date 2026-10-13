import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/money/decimal.js';
import {
  HISTORICAL_SCANNER_REPLAY_VERSION,
  HistoricalScannerReplayError,
  runHistoricalScannerReplay,
  type HistoricalScannerQuantPort,
  type HistoricalScannerReplayDependencies,
  type HistoricalScannerReplayRequest,
  type HistoricalScannerSnapshotPort,
} from '../../src/scanner/historical-scanner-replay.js';
import { InMemoryScannerRunStore } from '../../src/scanner/scanner-store.js';
import type { ScannerDefinition, ScannerSnapshot } from '../../src/scanner/scanner-types.js';
import type { QuantResult, QuantRunRecord } from '../../src/quant/quant-types.js';
import { InMemoryUniverseStore } from '../../src/universe/universe-store.js';
import type { UniverseSelectionQuery } from '../../src/universe/universe-store.js';

const SOURCE = 'fixture:bars:production';
const UNIVERSE_SOURCE = {
  sourceId: 'fixture:universe:production',
  provider: 'fixture',
  dataset: 'constituents',
  environment: 'production' as const,
  license: 'internal_use' as const,
};
const T1 = '2026-10-08T20:00:00.000Z';
const T2 = '2026-10-09T20:00:00.000Z';

function definition(): ScannerDefinition {
  return {
    id: 'o9-basic',
    version: '1',
    universeId: 'U',
    interval: '1d',
    filters: [{ type: 'minimum_price', value: '1' }],
    ranking: [],
    maxCandidates: 10,
    useCase: 'research',
  };
}

function fakeQuantResult(instrumentId: string, asOf: string, storedThrough: number): QuantResult {
  const fingerprint = (instrumentId.charCodeAt(0).toString(16) + storedThrough.toString(16) + asOf.replace(/\D/g, '')).padEnd(64, '0').slice(0, 64);
  return {
    quantRunId: 'quant_' + fingerprint.slice(0, 40),
    engineVersion: 'quant-engine:test',
    instrumentId,
    series: { source: SOURCE, interval: '1d', session: 'regular', adjustment: 'raw' },
    asOf,
    mode: 'final_only',
    useCase: 'analysis',
    inputStart: null,
    inputEnd: asOf,
    barCount: 100,
    inputFingerprint: fingerprint,
    dataQuality: { valid: true, usableForTrading: false, severity: 'warning', issues: [] },
    barDataProvenance: {
      decisionTimeKnowledgeProven: false,
      allBarsContemporaneousVintage: false,
      historicalReconstruction: true,
      legacyUnproven: false,
      latestFinalBarContemporaneous: false,
      barCount: 100,
      knownBars: 100,
      contemporaneousBars: 0,
      historicalBars: 100,
      legacyBars: 0,
    },
    barReplay: 'historical_research',
    algorithmVersions: {},
    parameters: {} as QuantResult['parameters'],
    indicators: {} as QuantResult['indicators'],
    pivots: { status: 'insufficient_data' },
    swings: { confirmedCount: 0, recent: [] },
    supportResistance: { status: 'insufficient_data', levels: [] },
    marketStructure: { trend: 'unknown', lastHighLabel: null, lastLowLabel: null, reason: 'fixture', points: [] },
    insufficientData: false,
    warmupStatus: {},
    createdAt: '2026-12-31T00:00:00.000Z',
  };
}

class FakeQuant implements HistoricalScannerQuantPort {
  readonly calls: Array<{ instrumentId: string; asOf: string; storedThrough?: number; replay?: string }> = [];

  async run(request: Parameters<HistoricalScannerQuantPort['run']>[0]) {
    this.calls.push({ instrumentId: request.instrumentId, asOf: request.asOf, storedThrough: request.storedThrough, replay: request.replay });
    const storedThrough = request.storedThrough;
    if (storedThrough === undefined) throw new Error('fixture requires storedThrough');
    const result = fakeQuantResult(request.instrumentId, request.asOf, storedThrough);
    result.barReplay = request.replay ?? 'historical_research';
    return {
      record: { result, resultHash: result.inputFingerprint, storedThrough, createdAt: result.createdAt } satisfies QuantRunRecord,
      status: 'APPLIED' as const,
    };
  }
}

class FakeSnapshots implements HistoricalScannerSnapshotPort {
  readonly calls: Array<{ instrumentId: string; asOf: string; storedThrough: number; replay: string }> = [];
  private readonly prices = new Map<string, Decimal>();

  set(instrumentId: string, asOf: string, price: string): void {
    this.prices.set(instrumentId + '|' + asOf, Decimal.from(price));
  }

  async build(input: Parameters<HistoricalScannerSnapshotPort['build']>[0]): Promise<ScannerSnapshot | null> {
    this.calls.push({ instrumentId: input.instrumentId, asOf: input.asOf, storedThrough: input.storedThrough, replay: input.replay });
    const price = this.prices.get(input.instrumentId + '|' + input.asOf);
    if (!price) return null;
    return {
      instrumentId: input.instrumentId,
      asOf: input.asOf,
      lastPrice: price,
      lastPriceAvailableAt: input.asOf,
      quant: input.quant.result,
    };
  }
}

function universeFixture() {
  let now = '2025-12-31T12:00:01.000Z';
  const store = new InMemoryUniverseStore({ clock: () => now });
  store.registerDefinition({ universeId: 'U', definitionVersion: '1', name: 'O9 universe' });
  store.registerSource(UNIVERSE_SOURCE);
  const ingest = (effectiveAt: string, members: string[], storedAt = now) => {
    now = storedAt;
    return store.ingest(
      {
        universeId: 'U',
        sourceId: UNIVERSE_SOURCE.sourceId,
        effectiveAt,
        retrievedAt: storedAt,
        knowledgeSource: 'captured_by_nexus',
        knownAt: storedAt,
        completeness: 'COMPLETE',
        members: members.map((id) => ({ sourceMemberKey: 'k:' + id, providerSymbol: id })),
      },
      (m) => m.providerSymbol,
    );
  };
  return { store, ingest, setNow: (value: string) => (now = value) };
}

function request(overrides: Partial<HistoricalScannerReplayRequest> = {}): HistoricalScannerReplayRequest {
  return {
    definition: definition(),
    asOf: [T1, T2],
    universeId: 'U',
    universeSourceId: UNIVERSE_SOURCE.sourceId,
    universeStoredThrough: 1,
    marketStoredThroughByInstrument: { A: 11, B: 22 },
    series: { source: SOURCE, interval: '1d', session: 'regular', adjustment: 'raw' },
    replay: 'historical_research',
    ...overrides,
  };
}

function depsWithMembers(members: string[] = ['A', 'B']): {
  deps: HistoricalScannerReplayDependencies;
  quant: FakeQuant;
  snapshots: FakeSnapshots;
  universe: ReturnType<typeof universeFixture>;
} {
  const universe = universeFixture();
  universe.ingest('2026-01-01T00:00:00.000Z', members);
  const quant = new FakeQuant();
  const snapshots = new FakeSnapshots();
  for (const id of members) {
    snapshots.set(id, T1, id === 'A' ? '100' : '50');
    snapshots.set(id, T2, id === 'A' ? '101' : '51');
  }
  return {
    universe,
    quant,
    snapshots,
    deps: {
      universe: { select: (q: UniverseSelectionQuery) => universe.store.select(q) },
      quant,
      snapshots,
      scannerRuns: new InMemoryScannerRunStore(),
    },
  };
}

describe('O9 historical scanner replay — RED', () => {
  it('has an explicit replay engine identity', () => {
    expect(HISTORICAL_SCANNER_REPLAY_VERSION).toBe('historical-scanner-replay:v1');
  });

  it('produces one ordered scanner step per explicit replay instant', async () => {
    const { deps } = depsWithMembers();
    const result = await runHistoricalScannerReplay(request(), deps);

    expect(result.asOf).toEqual([T1, T2]);
    expect(result.steps.map((s) => s.asOf)).toEqual([T1, T2]);
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every((s) => s.candidateInstrumentIds.length === 2)).toBe(true);
  });

  it('passes the exact universe and market storedThrough anchors to every dependency', async () => {
    const { deps, quant, snapshots } = depsWithMembers();
    await runHistoricalScannerReplay(request(), deps);

    expect(quant.calls.map((c) => [c.instrumentId, c.asOf, c.storedThrough])).toEqual([
      ['A', T1, 11],
      ['B', T1, 22],
      ['A', T2, 11],
      ['B', T2, 22],
    ]);
    expect(snapshots.calls.map((c) => [c.instrumentId, c.asOf, c.storedThrough])).toEqual([
      ['A', T1, 11],
      ['B', T1, 22],
      ['A', T2, 11],
      ['B', T2, 22],
    ]);
  });

  it('is independent of market-anchor map insertion order', async () => {
    const a = depsWithMembers();
    const b = depsWithMembers();
    const ab = await runHistoricalScannerReplay(request({ marketStoredThroughByInstrument: { A: 11, B: 22 } }), a.deps);
    const ba = await runHistoricalScannerReplay(request({ marketStoredThroughByInstrument: { B: 22, A: 11 } }), b.deps);

    expect(ba.inputFingerprint).toBe(ab.inputFingerprint);
    expect(ba.replayRunId).toBe(ab.replayRunId);
    expect(ba.steps).toEqual(ab.steps);
  });

  it('a later universe revision above the pinned anchor cannot rewrite an old replay', async () => {
    const fixture = depsWithMembers(['A']);
    const before = await runHistoricalScannerReplay(request({ marketStoredThroughByInstrument: { A: 11 } }), fixture.deps);

    fixture.universe.ingest('2026-06-01T00:00:00.000Z', ['A', 'B'], '2026-06-01T00:00:01.000Z');
    fixture.snapshots.set('B', T1, '50');
    fixture.snapshots.set('B', T2, '51');
    const after = await runHistoricalScannerReplay(request({ marketStoredThroughByInstrument: { A: 11 } }), fixture.deps);

    expect(after.replayRunId).toBe(before.replayRunId);
    expect(after.steps).toEqual(before.steps);
    expect(after.steps.every((s) => s.candidateInstrumentIds).every((ids) => ids.length === 1 && ids[0] === 'A')).toBe(true);
  });

  it('a later market backfill above the pinned anchor cannot rewrite an old replay', async () => {
    const first = depsWithMembers(['A']);
    const before = await runHistoricalScannerReplay(request({ marketStoredThroughByInstrument: { A: 11 } }), first.deps);

    // Simulate a newer storage head existing elsewhere. The pinned replay still has to send 11.
    const second = depsWithMembers(['A']);
    second.snapshots.set('A', T1, '999');
    second.snapshots.set('A', T2, '999');
    const after = await runHistoricalScannerReplay(request({ marketStoredThroughByInstrument: { A: 11 } }), second.deps);

    expect(after.steps.map((s) => s.quantRunIds.map((q) => q.storedThrough))).toEqual([[11], [11]]);
    expect(second.quant.calls.every((c) => c.storedThrough === 11)).toBe(true);
  });

  it('decision_time passes the same strict replay mode to universe, Quant and snapshots', async () => {
    const fixture = depsWithMembers(['A']);
    const universeQueries: UniverseSelectionQuery[] = [];
    fixture.deps.universe = {
      select(q) {
        universeQueries.push(q);
        return fixture.universe.store.select(q);
      },
    };

    await runHistoricalScannerReplay(
      request({ replay: 'decision_time', marketStoredThroughByInstrument: { A: 11 } }),
      fixture.deps,
    );

    expect(universeQueries.every((q) => q.mode === 'decision_time')).toBe(true);
    expect(fixture.quant.calls.every((c) => c.replay === 'decision_time')).toBe(true);
    expect(fixture.snapshots.calls.every((c) => c.replay === 'decision_time')).toBe(true);
  });

  it('keeps a missing member visible as incomplete scanner coverage instead of shrinking the universe', async () => {
    const fixture = depsWithMembers(['A', 'B']);
    // B has no snapshot at T2.
    (fixture.snapshots as any).prices.delete('B|' + T2);
    const result = await runHistoricalScannerReplay(request(), fixture.deps);

    expect(result.steps[0]!.rankingComplete).toBe(true);
    expect(result.steps[1]!.rankingComplete).toBe(false);
    expect(result.steps[1]!.candidateInstrumentIds).toEqual(['A']);
  });

  it('changing only a future step changes replay identity but leaves the earlier scanner step unchanged', async () => {
    const a = depsWithMembers(['A']);
    const b = depsWithMembers(['A']);
    b.snapshots.set('A', T2, '0.5');

    const first = await runHistoricalScannerReplay(request({ marketStoredThroughByInstrument: { A: 11 } }), a.deps);
    const changed = await runHistoricalScannerReplay(request({ marketStoredThroughByInstrument: { A: 11 } }), b.deps);

    expect(changed.steps[0]!.scannerRunId).toBe(first.steps[0]!.scannerRunId);
    expect(changed.steps[0]!.candidateInstrumentIds).toEqual(first.steps[0]!.candidateInstrumentIds);
    expect(changed.steps[1]!.scannerRunId).not.toBe(first.steps[1]!.scannerRunId);
  });

  it('repeating the same pinned replay is deterministic', async () => {
    const a = depsWithMembers();
    const b = depsWithMembers();
    const one = await runHistoricalScannerReplay(request(), a.deps);
    const two = await runHistoricalScannerReplay(request(), b.deps);

    expect(two.replayRunId).toBe(one.replayRunId);
    expect(two.inputFingerprint).toBe(one.inputFingerprint);
    expect(two.steps).toEqual(one.steps);
  });

  it('fails closed when a selected member has no market storedThrough anchor', async () => {
    const fixture = depsWithMembers(['A', 'B']);
    await expect(
      runHistoricalScannerReplay(request({ marketStoredThroughByInstrument: { A: 11 } }), fixture.deps),
    ).rejects.toMatchObject({ code: 'MARKET_ANCHOR_REQUIRED' } satisfies Partial<HistoricalScannerReplayError>);
  });

  it('rejects duplicate or non-increasing replay schedules before reading dependencies', async () => {
    const fixture = depsWithMembers(['A']);
    await expect(
      runHistoricalScannerReplay(request({ asOf: [T1, T1], marketStoredThroughByInstrument: { A: 11 } }), fixture.deps),
    ).rejects.toMatchObject({ code: 'INVALID_REPLAY_SCHEDULE' } satisfies Partial<HistoricalScannerReplayError>);

    await expect(
      runHistoricalScannerReplay(request({ asOf: [T2, T1], marketStoredThroughByInstrument: { A: 11 } }), fixture.deps),
    ).rejects.toMatchObject({ code: 'INVALID_REPLAY_SCHEDULE' } satisfies Partial<HistoricalScannerReplayError>);

    expect(fixture.quant.calls).toHaveLength(0);
  });
});
