import { describe, expect, it } from 'vitest';
import { InstrumentRegistry } from '../../src/market-data/instrument-registry.js';
import { InMemoryUniverseStore, type MemberResolver } from '../../src/universe/universe-store.js';
import { UniverseError, type UniverseSource, type UniverseSnapshotInput } from '../../src/universe/universe-model.js';

// Point-in-Time Universe V1 (docs/PIT_UNIVERSE_V1.md). Each block is one mandatory case from the design. The expected values come from the design,
// not from the implementation.

const CHANGE = { at: '2020-01-01T00:00:00.000Z', by: { kind: 'system' as const, id: 'pit-test' }, reason: 'fixture' };
const PRODUCTION: UniverseSource = { sourceId: 'fixture:constituents:production', provider: 'fixture', dataset: 'constituents', environment: 'production', license: 'internal_use' };
const TEST_FIXTURE: UniverseSource = { sourceId: 'fixture:constituents:test', provider: 'fixture', dataset: 'constituents', environment: 'test_fixture', license: 'unreviewed' };
const UNIVERSE = { universeId: 'u_test_index', definitionVersion: '1', name: 'Test index' };

/** Instruments A, B, C (C delists later), D (joins later). Symbols are providers' tickers; identities are the permanent instrumentIds. */
async function registry(): Promise<InstrumentRegistry> {
  const r = await InstrumentRegistry.open();
  for (const [id, symbol] of [['ins_a', 'AAA'], ['ins_b', 'BBB'], ['ins_c', 'CCC'], ['ins_d', 'DDD']] as const) {
    await r.register({ instrumentId: id, assetClass: 'stock', symbol, currency: 'USD', timezone: 'America/New_York', active: true }, CHANGE);
    await r.addMapping({ instrumentId: id, provider: 'fixture', providerSymbol: symbol, validFrom: '2000-01-01T00:00:00.000Z' }, CHANGE);
  }
  return r;
}

function resolverOf(r: InstrumentRegistry): MemberResolver {
  return (m, at, source) => r.resolve(source.provider, m.providerSymbol, at, m.exchange) ?? null;
}

function store(_registry: InstrumentRegistry, sources: UniverseSource[] = [PRODUCTION]): InMemoryUniverseStore {
  const s = new InMemoryUniverseStore();
  s.registerDefinition(UNIVERSE);
  for (const source of sources) s.registerSource(source);
  return s;
}

const member = (symbol: string) => ({ sourceMemberKey: 'key:' + symbol, providerSymbol: symbol });

function snapshot(over: Partial<UniverseSnapshotInput> & Pick<UniverseSnapshotInput, 'effectiveAt' | 'retrievedAt' | 'members'>): UniverseSnapshotInput {
  return { universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, knowledgeSource: 'captured_by_nexus', knownAt: over.retrievedAt, completeness: 'COMPLETE', ...over };
}

describe('survivorship: historical membership keeps delisted and removed members (§23)', () => {
  it('a 2020 scan returns A, B, C — not the present-day A, B, D — and C stays after it is delisted', async () => {
    const r = await registry();
    const s = store(r);
    s.ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2019-12-31T12:00:00.000Z', members: [member('AAA'), member('BBB'), member('CCC')] }), resolverOf(r));
    s.ingest(snapshot({ effectiveAt: '2026-01-01T00:00:00.000Z', retrievedAt: '2026-01-01T12:00:00.000Z', members: [member('AAA'), member('BBB'), member('DDD')] }), resolverOf(r));
    await r.update('ins_c', { active: false }, CHANGE);
    const historical = s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2020-09-21T20:00:00.000Z', mode: 'decision_time' });
    expect(historical.members).toEqual(['ins_a', 'ins_b', 'ins_c']);
    expect(historical.evidence.strictDecisionTime).toBe(true);
  });

  it('a delisted (inactive) instrument is still a historical member: the active flag is not membership truth', async () => {
    const r = await registry();
    await r.update('ins_c', { active: false }, CHANGE);
    const s = store(r);
    s.ingest(snapshot({ effectiveAt: '2018-01-01T00:00:00.000Z', retrievedAt: '2018-01-01T12:00:00.000Z', members: [member('CCC')] }), resolverOf(r));
    expect(s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2018-06-01T00:00:00.000Z', mode: 'decision_time' }).members).toEqual(['ins_c']);
  });

  it('changing today’s list does not alter the historical snapshot identity or fingerprint', async () => {
    const r = await registry();
    const s = store(r);
    const before = s.ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T12:00:00.000Z', members: [member('AAA'), member('BBB'), member('CCC')] }), resolverOf(r)).revision;
    const fingerprintBefore = s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' }).evidence.fingerprint;
    s.ingest(snapshot({ effectiveAt: '2026-01-01T00:00:00.000Z', retrievedAt: '2026-01-01T12:00:00.000Z', members: [member('AAA'), member('DDD')] }), resolverOf(r));
    const after = s.revisionById(before.snapshotRevisionId)!;
    expect(after.contentHash).toBe(before.contentHash);
    expect(s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' }).evidence.fingerprint).toBe(fingerprintBefore);
  });
});

describe('knowledge and effectiveness are separate (§3, §22, §24)', () => {
  it('a 2020 membership downloaded in 2026 is a historical reconstruction: research may use it, decision time in 2020 may not', async () => {
    const r = await registry();
    const s = store(r);
    s.ingest(snapshot({ effectiveAt: '2020-09-21T00:00:00.000Z', retrievedAt: '2026-10-09T12:00:00.000Z', members: [member('AAA'), member('BBB')] }), resolverOf(r));
    const research = s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2020-09-21T20:00:00.000Z', mode: 'historical_research' });
    expect(research.members).toEqual(['ins_a', 'ins_b']);
    expect(research.evidence).toMatchObject({ vintage: 'historical_reconstruction', historicalReconstruction: true, decisionTimeKnowledgeProven: false, strictDecisionTime: false });
    const decision2020 = s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2020-09-21T20:00:00.000Z', mode: 'decision_time' });
    expect(decision2020.evidence.status).toBe('UNAVAILABLE');
    expect(decision2020.members).toEqual([]);
  });

  it('after the 2026 retrieval, decision time may know that snapshot, but it is still a historical reconstruction', async () => {
    const r = await registry();
    const s = store(r);
    s.ingest(snapshot({ effectiveAt: '2020-09-21T00:00:00.000Z', retrievedAt: '2026-10-09T12:00:00.000Z', members: [member('AAA')] }), resolverOf(r));
    const later = s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2026-10-10T00:00:00.000Z', mode: 'decision_time' });
    expect(later.evidence).toMatchObject({ status: 'SELECTED', decisionTimeKnowledgeProven: true, historicalReconstruction: true, strictDecisionTime: false });
  });

  it('a change announced Friday and effective Monday does not activate early: Friday sees the old list, Monday the new one', async () => {
    const r = await registry();
    const s = store(r);
    s.ingest(snapshot({ effectiveAt: '2026-10-05T00:00:00.000Z', retrievedAt: '2026-10-01T00:00:00.000Z', members: [member('AAA'), member('BBB')] }), resolverOf(r));
    s.ingest(snapshot({ effectiveAt: '2026-10-12T00:00:00.000Z', retrievedAt: '2026-10-09T12:00:00.000Z', members: [member('AAA'), member('DDD')] }), resolverOf(r));
    expect(s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2026-10-09T20:00:00.000Z', mode: 'decision_time' }).members).toEqual(['ins_a', 'ins_b']);
    expect(s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2026-10-12T20:00:00.000Z', mode: 'decision_time' }).members).toEqual(['ins_a', 'ins_d']);
  });
});

describe('revisions and late corrections (§12, §25)', () => {
  it('revision 1 known at T, correction learned at T+2: decision time at T sees revision 1, at T+3 revision 2, research the newest', async () => {
    const r = await registry();
    const s = store(r);
    s.ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-02T00:00:00.000Z', members: [member('AAA')] }), resolverOf(r));
    s.ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-04T00:00:00.000Z', members: [member('AAA'), member('BBB')] }), resolverOf(r));
    const at = (asOf: string, mode: 'decision_time' | 'historical_research') => s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf, mode });
    expect(at('2020-01-02T12:00:00.000Z', 'decision_time').evidence.revision).toBe(1);
    expect(at('2020-01-02T12:00:00.000Z', 'decision_time').members).toEqual(['ins_a']);
    expect(at('2020-01-05T00:00:00.000Z', 'decision_time').evidence.revision).toBe(2);
    expect(at('2020-01-05T00:00:00.000Z', 'decision_time').members).toEqual(['ins_a', 'ins_b']);
    const research = at('2020-01-02T12:00:00.000Z', 'historical_research');
    expect(research.evidence.revision).toBe(2);
    expect(research.evidence.decisionTimeKnowledgeProven).toBe(false);
  });

  it('a stored-through replay does not see a backfill stored later', async () => {
    const r = await registry();
    const s = store(r);
    s.ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-02T00:00:00.000Z', members: [member('AAA')] }), resolverOf(r));
    const stored = s.currentIngestSeq();
    s.ingest(snapshot({ effectiveAt: '2019-01-01T00:00:00.000Z', retrievedAt: '2026-01-02T00:00:00.000Z', members: [member('BBB')] }), resolverOf(r));
    const replay = s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'historical_research', storedThrough: stored });
    expect(replay.members).toEqual(['ins_a']);
    expect(s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'historical_research' }).members).toEqual(['ins_a']);
  });

  it('identical content is idempotent; a revision learned before its predecessor is refused', async () => {
    const r = await registry();
    const s = store(r);
    const input = snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-05T00:00:00.000Z', members: [member('AAA')] });
    expect(s.ingest(input, resolverOf(r)).status).toBe('APPLIED');
    expect(s.ingest(input, resolverOf(r)).status).toBe('ALREADY_APPLIED');
    const earlier = snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-02T00:00:00.000Z', members: [member('AAA'), member('BBB')] });
    expect(() => s.ingest(earlier, resolverOf(r))).toThrow(/UNIVERSE_KNOWLEDGE_REGRESSION/);
  });
});

describe('identity and membership resolution (§8, §9)', () => {
  it('a ticker change keeps the old snapshot on the same permanent instrumentId', async () => {
    const r = await registry();
    const s = store(r);
    s.ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T12:00:00.000Z', members: [member('AAA')] }), resolverOf(r));
    await r.changeSymbol({ instrumentId: 'ins_a', provider: 'fixture', newProviderSymbol: 'AAX', newSymbol: 'AAX', effectiveFrom: '2024-01-01T00:00:00.000Z' }, CHANGE);
    s.ingest(snapshot({ effectiveAt: '2024-06-01T00:00:00.000Z', retrievedAt: '2024-06-01T12:00:00.000Z', members: [{ sourceMemberKey: 'key:AAX', providerSymbol: 'AAX' }] }), resolverOf(r));
    expect(s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' }).members).toEqual(['ins_a']);
    expect(s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2025-01-01T00:00:00.000Z', mode: 'decision_time' }).members).toEqual(['ins_a']);
  });

  it('a COMPLETE snapshot with an unresolved member is refused: nothing is stored and no member is dropped silently', async () => {
    const r = await registry();
    const s = store(r);
    expect(() => s.ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T12:00:00.000Z', members: [member('AAA'), member('ZZZ')] }), resolverOf(r))).toThrow(/UNIVERSE_MEMBER_UNRESOLVED/);
    expect(s.all()).toHaveLength(0);
  });

  it('a PARTIAL snapshot may be stored, but its unresolved member is visible and it is never strict', async () => {
    const r = await registry();
    const s = store(r);
    const partial = s.ingest(snapshot({ completeness: 'PARTIAL', effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T12:00:00.000Z', members: [member('AAA'), member('ZZZ')] }), resolverOf(r)).revision;
    expect(partial.unresolvedMembers.map((u) => u.providerSymbol)).toEqual(['ZZZ']);
    const sel = s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' });
    expect(sel.evidence).toMatchObject({ complete: false, strictDecisionTime: false });
  });

  it('a provider symbol is resolved at the effective instant: an old symbol at an old effective date still resolves', async () => {
    const r = await registry();
    await r.changeSymbol({ instrumentId: 'ins_b', provider: 'fixture', newProviderSymbol: 'BBX', newSymbol: 'BBX', effectiveFrom: '2022-01-01T00:00:00.000Z' }, CHANGE);
    const s = store(r);
    s.ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T12:00:00.000Z', members: [member('BBB')] }), resolverOf(r));
    expect(s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' }).members).toEqual(['ins_b']);
  });
});

describe('partial, sources and member order (§6, §7, §13, §14)', () => {
  it('a test-fixture source is never production evidence, even when complete', async () => {
    const r = await registry();
    const s = store(r, [TEST_FIXTURE]);
    s.ingest(snapshot({ sourceId: TEST_FIXTURE.sourceId, effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T12:00:00.000Z', members: [member('AAA')] }), resolverOf(r));
    const sel = s.select({ universeId: UNIVERSE.universeId, sourceId: TEST_FIXTURE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' });
    expect(sel.evidence).toMatchObject({ complete: true, sourceProduction: false, strictDecisionTime: false });
  });

  it('two sources are never merged: the selection names one source and sees only its revisions', async () => {
    const r = await registry();
    const s = store(r, [PRODUCTION, TEST_FIXTURE]);
    s.ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T12:00:00.000Z', members: [member('AAA')] }), resolverOf(r));
    s.ingest(snapshot({ sourceId: TEST_FIXTURE.sourceId, effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T12:00:00.000Z', members: [member('BBB')] }), resolverOf(r));
    expect(s.select({ universeId: UNIVERSE.universeId, sourceId: PRODUCTION.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' }).members).toEqual(['ins_a']);
    expect(s.select({ universeId: UNIVERSE.universeId, sourceId: TEST_FIXTURE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' }).members).toEqual(['ins_b']);
  });

  it('member order never changes the content hash or the revision identity (members are sorted before hashing)', async () => {
    const r = await registry();
    const a = store(r).ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T12:00:00.000Z', members: [member('AAA'), member('BBB'), member('CCC')] }), resolverOf(r)).revision;
    const b = store(r).ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T12:00:00.000Z', members: [member('CCC'), member('AAA'), member('BBB')] }), resolverOf(r)).revision;
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.snapshotRevisionId).toBe(a.snapshotRevisionId);
  });

  it('changing one constituent changes the content hash and the revision identity', async () => {
    const r = await registry();
    const a = store(r).ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T12:00:00.000Z', members: [member('AAA'), member('BBB')] }), resolverOf(r)).revision;
    const b = store(r).ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T12:00:00.000Z', members: [member('AAA'), member('CCC')] }), resolverOf(r)).revision;
    expect(b.contentHash).not.toBe(a.contentHash);
    expect(b.snapshotRevisionId).not.toBe(a.snapshotRevisionId);
  });

  it('a duplicate instrument inside one snapshot is refused', async () => {
    const r = await registry();
    const s = store(r);
    expect(() => s.ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T12:00:00.000Z', members: [member('AAA'), { sourceMemberKey: 'other', providerSymbol: 'AAA' }] }), resolverOf(r))).toThrow(UniverseError);
  });

  it('a universe is refused when re-registered with different content, and a source likewise', async () => {
    const r = await registry();
    const s = store(r);
    expect(() => s.registerDefinition({ ...UNIVERSE, name: 'Renamed' })).toThrow(/UNIVERSE_CONFLICT/);
    expect(() => s.registerSource({ ...PRODUCTION, provider: 'other' })).toThrow(/UNIVERSE_CONFLICT/);
  });
});
