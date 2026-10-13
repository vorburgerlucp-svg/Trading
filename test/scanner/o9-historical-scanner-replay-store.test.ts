import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/money/decimal.js';
import { decodeJson, encodeJson } from '../../src/persistence/json-codec.js';
import {
  HISTORICAL_SCANNER_REPLAY_VERSION,
  runHistoricalScannerReplay,
  type HistoricalScannerQuantPort,
  type HistoricalScannerReplayDependencies,
  type HistoricalScannerReplayRequest,
  type HistoricalScannerReplayResult,
  type HistoricalScannerSnapshotPort,
} from '../../src/scanner/historical-scanner-replay.js';
import {
  HistoricalScannerReplayConflictError,
  HistoricalScannerReplayIntegrityError,
  InMemoryHistoricalScannerReplayStore,
  verifyHistoricalScannerReplayResult,
  type HistoricalScannerReplayRow,
} from '../../src/scanner/historical-scanner-replay-store.js';
import { InMemoryScannerRunStore } from '../../src/scanner/scanner-store.js';
import type { ScannerDefinition, ScannerSnapshot } from '../../src/scanner/scanner-types.js';
import type { QuantResult, QuantRunRecord } from '../../src/quant/quant-types.js';
import { InMemoryUniverseStore } from '../../src/universe/universe-store.js';
import type { UniverseSelectionQuery } from '../../src/universe/universe-store.js';

// Fixtures are the same deterministic dependencies the O9 replay tests use. A valid result comes from the real replay, so the verifier is tested
// against what the algorithm actually produces, and every forgery below changes one field of that output.

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
const CLOCK = () => new Date('2026-10-13T10:00:00.000Z');

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
    dataQuality: { valid: true, usableForBacktest: true, usableForTrading: false, severity: 'warning', issues: [] },
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
  async run(request: Parameters<HistoricalScannerQuantPort['run']>[0]) {
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
  private readonly prices = new Map<string, Array<{ ingestSeq: number; price: Decimal }>>();

  set(instrumentId: string, asOf: string, price: string, ingestSeq = 1): void {
    const key = instrumentId + '|' + asOf;
    const rows = this.prices.get(key) ?? [];
    rows.push({ ingestSeq, price: Decimal.from(price) });
    rows.sort((a, b) => a.ingestSeq - b.ingestSeq);
    this.prices.set(key, rows);
  }

  async build(input: Parameters<HistoricalScannerSnapshotPort['build']>[0]): Promise<ScannerSnapshot | null> {
    const rows = this.prices.get(input.instrumentId + '|' + input.asOf) ?? [];
    const visible = rows.filter((row) => row.ingestSeq <= input.storedThrough).at(-1);
    const price = visible?.price;
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
  return { store, ingest };
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

function dependencies(members: string[] = ['A', 'B']): HistoricalScannerReplayDependencies {
  const universe = universeFixture();
  universe.ingest('2026-01-01T00:00:00.000Z', members);
  const snapshots = new FakeSnapshots();
  for (const id of members) {
    snapshots.set(id, T1, id === 'A' ? '100' : '50');
    snapshots.set(id, T2, id === 'A' ? '101' : '51');
  }
  return {
    universe: { select: (q: UniverseSelectionQuery) => universe.store.select(q) },
    quant: new FakeQuant(),
    snapshots,
    scannerRuns: new InMemoryScannerRunStore(),
  };
}

/** A valid result from the real replay. */
async function validResult(): Promise<HistoricalScannerReplayResult> {
  return runHistoricalScannerReplay(request(), dependencies());
}

/** A deep copy through the lossless codec. Forgeries change only the copy, never the original. */
const clone = (r: HistoricalScannerReplayResult): HistoricalScannerReplayResult => decodeJson(encodeJson(r)) as HistoricalScannerReplayResult;

describe('O9 historical scanner replay store — RED', () => {
  it('1. a valid O9 result saves and reads back losslessly and verifies', async () => {
    const result = await validResult();
    const store = new InMemoryHistoricalScannerReplayStore({ clock: CLOCK });
    expect(await store.save(result)).toBe('APPLIED');
    expect(await store.get(result.replayRunId)).toEqual(result);
    expect(verifyHistoricalScannerReplayResult(result)).toBe(result);
  });

  it('2. saving the same result again is idempotent and returns the same record', async () => {
    const result = await validResult();
    const store = new InMemoryHistoricalScannerReplayStore({ clock: CLOCK });
    expect(await store.save(result)).toBe('APPLIED');
    expect(await store.save(clone(result))).toBe('ALREADY_APPLIED');
    expect(await store.get(result.replayRunId)).toEqual(result);
  });

  it('3. a mutation of the caller object after save cannot change the stored record', async () => {
    const result = await validResult();
    const store = new InMemoryHistoricalScannerReplayStore({ clock: CLOCK });
    await store.save(result);
    result.steps[0]!.candidateInstrumentIds.push('ZZZ');
    result.steps[0]!.quantRunIds[0]!.storedThrough = 999;
    (result.marketStoredThroughByInstrument as Record<string, number>).A = 999;
    const stored = await store.get(result.replayRunId);
    expect(stored!.steps[0]!.candidateInstrumentIds).not.toContain('ZZZ');
    expect(stored!.steps[0]!.quantRunIds[0]!.storedThrough).toBe(11);
    expect(stored!.marketStoredThroughByInstrument.A).toBe(11);
  });

  it('4. the same replayRunId with different content is a conflict, never an overwrite', async () => {
    const result = await validResult();
    const store = new InMemoryHistoricalScannerReplayStore({ clock: CLOCK });
    await store.save(result);
    const different = clone(result);
    different.universeStoredThrough = 2;
    await expect(store.save(different)).rejects.toBeInstanceOf(HistoricalScannerReplayConflictError);
    expect(await store.get(result.replayRunId)).toEqual(result);
  });

  it('5. a tampered input fingerprint is an integrity error', async () => {
    const result = await validResult();
    const malformed = clone(result);
    malformed.inputFingerprint = 'not-a-fingerprint';
    expect(() => verifyHistoricalScannerReplayResult(malformed)).toThrow(/invalid input fingerprint/);
    const detached = clone(result);
    detached.inputFingerprint = 'b'.repeat(64);
    expect(() => verifyHistoricalScannerReplayResult(detached)).toThrow(HistoricalScannerReplayIntegrityError);
    await expect(new InMemoryHistoricalScannerReplayStore({ clock: CLOCK }).save(detached)).rejects.toBeInstanceOf(HistoricalScannerReplayIntegrityError);
  });

  it('6. a tampered replay run id is an integrity error', async () => {
    const result = await validResult();
    const forged = clone(result);
    forged.replayRunId = 'hsr_' + 'a'.repeat(40);
    expect(() => verifyHistoricalScannerReplayResult(forged)).toThrow(/replayRunId/);
    await expect(new InMemoryHistoricalScannerReplayStore({ clock: CLOCK }).save(forged)).rejects.toBeInstanceOf(HistoricalScannerReplayIntegrityError);
  });

  it('7. an unsorted or duplicate replay schedule is an integrity error', async () => {
    const result = await validResult();
    const reversed = clone(result);
    reversed.asOf = [T2, T1];
    expect(() => verifyHistoricalScannerReplayResult(reversed)).toThrow(/strictly increasing/);
    const duplicated = clone(result);
    duplicated.asOf = [T1, T1];
    expect(() => verifyHistoricalScannerReplayResult(duplicated)).toThrow(/strictly increasing/);
  });

  it('8. a step order or asOf mismatch is an integrity error', async () => {
    const result = await validResult();
    const swapped = clone(result);
    swapped.steps.reverse();
    expect(() => verifyHistoricalScannerReplayResult(swapped)).toThrow(/asOf does not match/);
    const shifted = clone(result);
    shifted.steps[0]!.asOf = T2;
    expect(() => verifyHistoricalScannerReplayResult(shifted)).toThrow(/asOf does not match/);
    const missing = clone(result);
    missing.steps.pop();
    expect(() => verifyHistoricalScannerReplayResult(missing)).toThrow(/number of steps/);
  });

  it('9. a duplicate scannerRunId is an integrity error', async () => {
    const result = await validResult();
    const forged = clone(result);
    forged.steps[1]!.scannerRunId = forged.steps[0]!.scannerRunId;
    forged.steps[1]!.scannerInputFingerprint = forged.steps[0]!.scannerInputFingerprint;
    expect(() => verifyHistoricalScannerReplayResult(forged)).toThrow(/duplicate scannerRunId/);
  });

  it('10. a child quant storedThrough that differs from the pinned market anchor is an integrity error', async () => {
    const result = await validResult();
    const forged = clone(result);
    forged.steps[0]!.quantRunIds[0]!.storedThrough = 999;
    expect(() => verifyHistoricalScannerReplayResult(forged)).toThrow(/pinned anchor/);
  });

  it('11. a quant child whose instrument has no pinned market anchor is an integrity error', async () => {
    const result = await validResult();
    const forged = clone(result);
    delete (forged.marketStoredThroughByInstrument as Record<string, number>).B;
    expect(() => verifyHistoricalScannerReplayResult(forged)).toThrow(/no pinned market anchor/);
  });

  it('12. a duplicate instrument inside one step quantRunIds is an integrity error', async () => {
    const result = await validResult();
    const forged = clone(result);
    forged.steps[0]!.quantRunIds.push({ ...forged.steps[0]!.quantRunIds[0]! });
    expect(() => verifyHistoricalScannerReplayResult(forged)).toThrow(/appears more than once/);
  });

  it('13. malformed market anchors are integrity errors', async () => {
    const result = await validResult();
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const forged = clone(result);
      (forged.marketStoredThroughByInstrument as Record<string, number>).A = bad;
      expect(() => verifyHistoricalScannerReplayResult(forged), String(bad)).toThrow(/market anchor/);
    }
  });

  it('14. a tampered stored payload is an integrity error on read', async () => {
    const result = await validResult();
    const rows = new Map<string, HistoricalScannerReplayRow>();
    const store = new InMemoryHistoricalScannerReplayStore({ clock: CLOCK, rows });
    await store.save(result);
    const row = rows.get(result.replayRunId)!;
    const payload = JSON.parse(row.payload) as { marketStoredThroughByInstrument: Record<string, number> };
    payload.marketStoredThroughByInstrument.A = 12;
    row.payload = JSON.stringify(payload);
    await expect(store.get(result.replayRunId)).rejects.toBeInstanceOf(HistoricalScannerReplayIntegrityError);
    await expect(store.save(result)).rejects.toBeInstanceOf(HistoricalScannerReplayIntegrityError);
  });

  it('15. a tampered evidence seal is an integrity error on read', async () => {
    const result = await validResult();
    const rows = new Map<string, HistoricalScannerReplayRow>();
    const store = new InMemoryHistoricalScannerReplayStore({ clock: CLOCK, rows });
    await store.save(result);
    const row = rows.get(result.replayRunId)!;
    row.seal = { ...row.seal, sealedAt: '2026-10-13T10:00:01.000Z' };
    await expect(store.getSealed(result.replayRunId)).rejects.toBeInstanceOf(HistoricalScannerReplayIntegrityError);
  });
});

describe('verifier rules: every inconsistency fails closed (O9 persistence brief, rules 1-20)', () => {
  it('rule 1: an unknown engine version is refused', async () => {
    const forged = clone(await validResult());
    (forged as { engineVersion: string }).engineVersion = 'historical-scanner-replay:v0';
    expect(() => verifyHistoricalScannerReplayResult(forged)).toThrow(/engine version/);
    expect(HISTORICAL_SCANNER_REPLAY_VERSION).toBe('historical-scanner-replay:v1');
  });

  it('rule 4: an empty scanner definition identity is refused', async () => {
    const forged = clone(await validResult());
    forged.definitionVersion = '';
    expect(() => verifyHistoricalScannerReplayResult(forged)).toThrow(/definition identity/);
  });

  it('rule 13: a negative or non-integer universe anchor is refused', async () => {
    const result = await validResult();
    for (const bad of [-1, 2.5]) {
      const forged = clone(result);
      forged.universeStoredThrough = bad;
      expect(() => verifyHistoricalScannerReplayResult(forged), String(bad)).toThrow(/universeStoredThrough/);
    }
  });

  it('rule 15: market anchor keys that are not in canonical order are refused', async () => {
    const forged = clone(await validResult());
    forged.marketStoredThroughByInstrument = { B: 22, A: 11 };
    expect(() => verifyHistoricalScannerReplayResult(forged)).toThrow(/canonical order/);
  });

  it('rule 10: a quant schedule that is not sorted by instrumentId is refused', async () => {
    const forged = clone(await validResult());
    forged.steps[0]!.quantRunIds.reverse();
    expect(() => verifyHistoricalScannerReplayResult(forged)).toThrow(/not sorted/);
  });

  it('rule 11: duplicate candidate instruments are refused', async () => {
    const forged = clone(await validResult());
    forged.steps[0]!.candidateInstrumentIds = ['A', 'A'];
    expect(() => verifyHistoricalScannerReplayResult(forged)).toThrow(/duplicate candidate/);
  });

  it('rule 12: candidates are kept in their rank order and are not required to be alphabetical', async () => {
    const reordered = clone(await validResult());
    reordered.steps[0]!.candidateInstrumentIds = ['B', 'A'];
    expect(verifyHistoricalScannerReplayResult(reordered)).toBe(reordered);
  });

  it('a candidate with no quant run in its own step is refused', async () => {
    const forged = clone(await validResult());
    forged.steps[0]!.candidateInstrumentIds = ['Z'];
    expect(() => verifyHistoricalScannerReplayResult(forged)).toThrow(/no quant run in its step/);
  });

  it('a step scannerRunId that does not derive from its scanner input fingerprint is refused', async () => {
    const forged = clone(await validResult());
    forged.steps[0]!.scannerRunId = 'scan_' + 'c'.repeat(40);
    expect(() => verifyHistoricalScannerReplayResult(forged)).toThrow(/scannerRunId does not match/);
  });

  it('a step universe fingerprint that is not a 64-character hash is refused', async () => {
    const forged = clone(await validResult());
    forged.steps[0]!.universeFingerprint = 'short';
    expect(() => verifyHistoricalScannerReplayResult(forged)).toThrow(/universe fingerprint/);
  });
});

describe('adversarial forgeries are refused and never repaired', () => {
  it('an anchor map keyed by an inherited property name is not a pinned anchor', async () => {
    const forged = clone(await validResult());
    forged.steps[0]!.quantRunIds.push({ instrumentId: 'constructor', quantRunId: 'quant_' + 'd'.repeat(40), storedThrough: 1 });
    expect(() => verifyHistoricalScannerReplayResult(forged)).toThrow(/no pinned market anchor/);
  });

  it('an injected unknown field is not silently dropped: the stored hash no longer matches', async () => {
    const result = await validResult();
    const rows = new Map<string, HistoricalScannerReplayRow>();
    const store = new InMemoryHistoricalScannerReplayStore({ clock: CLOCK, rows });
    await store.save(result);
    const row = rows.get(result.replayRunId)!;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    payload.note = 'injected';
    row.payload = JSON.stringify(payload);
    await expect(store.get(result.replayRunId)).rejects.toBeInstanceOf(HistoricalScannerReplayIntegrityError);
  });

  it('a row stored under another replayRunId is refused on read', async () => {
    const result = await validResult();
    const rows = new Map<string, HistoricalScannerReplayRow>();
    const store = new InMemoryHistoricalScannerReplayStore({ clock: CLOCK, rows });
    await store.save(result);
    rows.set('hsr_' + 'e'.repeat(40), rows.get(result.replayRunId)!);
    await expect(store.get('hsr_' + 'e'.repeat(40))).rejects.toBeInstanceOf(HistoricalScannerReplayIntegrityError);
  });
});
