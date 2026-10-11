import { describe, expect, it } from 'vitest';
import { InMemoryUniverseStore } from '../../src/universe/universe-store.js';
import { assertTimingProof, timingProofFor, universeEvidenceIsConsistent, type StoredUniverseRevision, type UniverseSnapshotInput, type UniverseTimingProof } from '../../src/universe/universe-model.js';
import { PRODUCTION_UNIVERSE_SOURCE, manualClock } from './fixtures.js';

// PIT Universe V2: NEXUS's knowledge of a universe revision is a timing proof written by the store's clock. A caller's retrievedAt and knownAt
// are a claim, kept as provenance. Each test states when NEXUS stored the snapshot (the store clock) and what the caller claimed.

const SOURCE = PRODUCTION_UNIVERSE_SOURCE.sourceId;
const member = (symbol: string) => ({ sourceMemberKey: 'k:' + symbol, providerSymbol: symbol });

function storeOn(clock: ReturnType<typeof manualClock>, afterCommit?: () => void): InMemoryUniverseStore {
  const s = new InMemoryUniverseStore({ clock: clock.clock, ...(afterCommit ? { afterCommit } : {}) });
  s.registerDefinition({ universeId: 'u', definitionVersion: '1', name: 'knowledge seal' });
  s.registerSource(PRODUCTION_UNIVERSE_SOURCE);
  return s;
}

function claim(o: { effectiveAt: string; retrievedAt: string; knownAt?: string; symbols?: string[] }): UniverseSnapshotInput {
  return {
    universeId: 'u',
    sourceId: SOURCE,
    effectiveAt: o.effectiveAt,
    retrievedAt: o.retrievedAt,
    knowledgeSource: 'captured_by_nexus',
    knownAt: o.knownAt ?? o.retrievedAt,
    completeness: 'COMPLETE',
    members: (o.symbols ?? ['ins_a']).map(member),
  };
}

const select = (s: InMemoryUniverseStore, asOf: string, mode: 'decision_time' | 'historical_research' = 'decision_time') => s.select({ universeId: 'u', sourceId: SOURCE, asOf, mode });
const resolve = (m: { providerSymbol: string }) => m.providerSymbol;

describe('A. backdated claims do not prove earlier knowledge', () => {
  it('stored by NEXUS in 2026, claimed retrieved and known in 2020: not decision-time evidence in 2020, and the claim stays visible as provenance', () => {
    const clock = manualClock('2026-10-09T12:00:00.000Z');
    const s = storeOn(clock);
    s.ingest(claim({ effectiveAt: '2020-09-21T00:00:00.000Z', retrievedAt: '2020-09-18T00:00:00.000Z' }), resolve);
    const decision = select(s, '2020-09-21T20:00:00.000Z');
    expect(decision.evidence.status).toBe('UNAVAILABLE');
    expect(decision.evidence.decisionTimeKnowledgeProven).toBe(false);
    expect(decision.evidence.strictDecisionTime).toBe(false);
    const research = select(s, '2020-09-21T20:00:00.000Z', 'historical_research');
    expect(research.evidence).toMatchObject({ status: 'SELECTED', claimedKnownAt: '2020-09-18T00:00:00.000Z', claimedRetrievedAt: '2020-09-18T00:00:00.000Z', strictDecisionTime: false, decisionTimeKnowledgeProven: false });
  });

  it('a claimed retrieval after the store time is refused: a claim cannot describe a retrieval NEXUS had not performed', () => {
    const s = storeOn(manualClock('2026-10-09T10:00:00.000Z'));
    expect(() => s.ingest(claim({ effectiveAt: '2026-10-08T00:00:00.000Z', retrievedAt: '2026-10-09T11:00:00.000Z' }), resolve)).toThrow(/UNIVERSE_INVALID/);
  });
});

describe('B–E. the proof decides decision-time knowledge', () => {
  it('B. stored at 12:00, decision at 12:01 on an effective-at-12:00 revision: decision-time knowledge and contemporaneous proof hold', () => {
    const clock = manualClock('2026-10-09T12:00:00.000Z');
    const s = storeOn(clock);
    s.ingest(claim({ effectiveAt: '2026-10-09T12:00:00.000Z', retrievedAt: '2026-10-09T11:59:00.000Z' }), resolve);
    const decision = select(s, '2026-10-09T12:01:00.000Z');
    expect(decision.evidence).toMatchObject({ status: 'SELECTED', knowledgeProof: 'COMMIT_SEALED', decisionTimeKnowledgeProven: true, contemporaneousVintageProven: true, strictDecisionTime: true });
  });

  it('C. stored at 12:00, decision at 11:59 (effective at 11:00): not known yet, so unavailable; after 12:00 it is known but a reconstruction', () => {
    const clock = manualClock('2026-10-09T12:00:00.000Z');
    const s = storeOn(clock);
    s.ingest(claim({ effectiveAt: '2026-10-09T11:00:00.000Z', retrievedAt: '2026-10-09T11:00:00.000Z' }), resolve);
    expect(select(s, '2026-10-09T11:59:00.000Z').evidence).toMatchObject({ status: 'UNAVAILABLE', decisionTimeKnowledgeProven: false });
    expect(select(s, '2026-10-09T12:01:00.000Z').evidence).toMatchObject({ status: 'SELECTED', decisionTimeKnowledgeProven: true, contemporaneousVintageProven: false, historicalReconstruction: true, strictDecisionTime: false });
  });

  it('D. effective 2020, stored by NEXUS in 2026: research uses it; it is a historical reconstruction and never strict', () => {
    const s = storeOn(manualClock('2026-10-09T12:00:00.000Z'));
    s.ingest(claim({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T00:00:00.000Z' }), resolve);
    expect(select(s, '2026-10-10T00:00:00.000Z', 'historical_research').evidence).toMatchObject({ status: 'SELECTED', historicalReconstruction: true, strictDecisionTime: false });
    expect(select(s, '2026-10-10T00:00:00.000Z').evidence).toMatchObject({ status: 'SELECTED', decisionTimeKnowledgeProven: true, contemporaneousVintageProven: false, strictDecisionTime: false });
  });

  it('E. sealed on Friday for a Monday effective date: Friday does not select it, Monday does, and Monday is contemporaneous', () => {
    const clock = manualClock('2026-10-09T12:00:00.000Z');
    const s = storeOn(clock);
    s.ingest(claim({ effectiveAt: '2026-10-12T00:00:00.000Z', retrievedAt: '2026-10-09T12:00:00.000Z', symbols: ['ins_a', 'ins_d'] }), resolve);
    expect(select(s, '2026-10-09T18:00:00.000Z').evidence.status).toBe('UNAVAILABLE');
    expect(select(s, '2026-10-12T09:00:00.000Z').evidence).toMatchObject({ status: 'SELECTED', effectiveByAsOf: true, decisionTimeKnowledgeProven: true, contemporaneousVintageProven: true, strictDecisionTime: true });
  });
});

describe('F. a committed revision whose seal is missing (the crash gap)', () => {
  it('is readable for research, never strict, and a retry attests presence at the retry time only', () => {
    const clock = manualClock('2026-10-09T10:00:00.000Z');
    let crash = true;
    const s = storeOn(clock, () => {
      if (crash) throw new Error('crash between commit and seal');
    });
    const input = claim({ effectiveAt: '2026-10-09T09:00:00.000Z', retrievedAt: '2026-10-09T09:00:00.000Z' });
    expect(() => s.ingest(input, resolve)).toThrow(/crash between commit and seal/);
    expect(s.all()).toHaveLength(1);
    expect(s.timingProofOf(s.all()[0]!.snapshotRevisionId)).toBeNull();
    expect(select(s, '2026-10-09T11:00:00.000Z', 'historical_research').evidence).toMatchObject({ status: 'SELECTED', knowledgeProof: 'UNSEALED', strictDecisionTime: false });
    expect(select(s, '2026-10-09T11:00:00.000Z').evidence.status).toBe('UNAVAILABLE');

    crash = false;
    clock.set('2026-10-09T12:05:00.000Z');
    const retry = s.ingest(input, resolve);
    expect(retry.status).toBe('ALREADY_APPLIED');
    expect(retry.timingProof).toMatchObject({ proofKind: 'PRESENCE_ATTESTATION', sealedAt: '2026-10-09T12:05:00.000Z' });
    expect(select(s, '2026-10-09T12:04:00.000Z').evidence.status).toBe('UNAVAILABLE');
    expect(select(s, '2026-10-09T12:06:00.000Z').evidence).toMatchObject({ knowledgeProof: 'PRESENCE_ATTESTED', decisionTimeKnowledgeProven: true, storeSealedAt: '2026-10-09T12:05:00.000Z' });
  });
});

describe('G–I. the proof is bound to its revision', () => {
  function sealedRevision(): { revision: StoredUniverseRevision; proof: UniverseTimingProof } {
    const s = storeOn(manualClock('2026-10-09T10:00:00.000Z'));
    const stored = s.ingest(claim({ effectiveAt: '2026-10-09T09:00:00.000Z', retrievedAt: '2026-10-09T09:00:00.000Z' }), resolve);
    return { revision: stored.revision, proof: stored.timingProof };
  }

  it('H. an altered result hash, recordedAt, sealedAt, seal hash or revision id fails closed', () => {
    const { revision, proof } = sealedRevision();
    expect(() => assertTimingProof(proof, revision)).not.toThrow();
    const tampered: Partial<UniverseTimingProof>[] = [
      { resultHash: 'a'.repeat(64) },
      { recordedAt: '2026-10-09T09:59:00.000Z' },
      { sealedAt: '2026-10-09T09:59:30.000Z' },
      { sealHash: 'b'.repeat(64) },
      { snapshotRevisionId: 'urev_' + 'c'.repeat(40) },
    ];
    for (const change of tampered) {
      expect(() => assertTimingProof({ ...proof, ...change }, revision), JSON.stringify(change)).toThrow(/UNIVERSE_INTEGRITY_FAILED/);
    }
  });

  it('I. a seal written for another revision fails closed', () => {
    const { revision, proof } = sealedRevision();
    const other = { ...revision, snapshotRevisionId: 'urev_' + 'd'.repeat(40) };
    expect(() => assertTimingProof(proof, other)).toThrow(/belongs to another revision/);
  });

  it('a seal written for an altered result (the revision content changed after sealing) fails closed', () => {
    const { revision, proof } = sealedRevision();
    expect(() => assertTimingProof(proof, { ...revision, memberCount: 99 })).toThrow(/altered after sealing/);
  });

  it('a timing proof is built only from canonical, ordered readings', () => {
    expect(() => timingProofFor({ snapshotRevisionId: 'urev_' + 'e'.repeat(40), proofKind: 'COMMIT_SEAL', resultHash: 'f'.repeat(64), recordedAt: '2026-10-09T10:00:05.000Z', sealedAt: '2026-10-09T10:00:00.000Z' })).toThrow(/after sealedAt/);
    expect(() => timingProofFor({ snapshotRevisionId: 'urev_' + 'e'.repeat(40), proofKind: 'COMMIT_SEAL', resultHash: 'f'.repeat(64), recordedAt: '2026-10-09T10:00:00Z', sealedAt: '2026-10-09T10:00:00.000Z' })).toThrow(/ISO UTC/);
  });
});

describe('J–K. revision replay and storedThrough', () => {
  it('J. revision 1 stored at T, revision 2 stored at T+2: decision at T+1 sees revision 1, decision at T+3 revision 2, never leaking backwards', () => {
    const clock = manualClock('2026-10-09T10:00:00.000Z');
    const s = storeOn(clock);
    s.ingest(claim({ effectiveAt: '2026-10-08T00:00:00.000Z', retrievedAt: '2026-10-09T09:00:00.000Z', symbols: ['ins_a'] }), resolve);
    clock.set('2026-10-09T12:00:00.000Z');
    s.ingest(claim({ effectiveAt: '2026-10-08T00:00:00.000Z', retrievedAt: '2026-10-09T11:59:00.000Z', symbols: ['ins_a', 'ins_b'] }), resolve);
    expect(select(s, '2026-10-09T10:30:00.000Z').evidence.revision).toBe(1);
    expect(select(s, '2026-10-09T10:30:00.000Z').members).toEqual(['ins_a']);
    expect(select(s, '2026-10-09T12:30:00.000Z').evidence.revision).toBe(2);
    const research = select(s, '2026-10-09T10:30:00.000Z', 'historical_research');
    expect(research.evidence).toMatchObject({ revision: 2, decisionTimeKnowledgeProven: false });
  });

  it('K. a later sealed backfill cannot change a replay stored through an earlier sequence', () => {
    const clock = manualClock('2026-10-09T10:00:00.000Z');
    const s = storeOn(clock);
    s.ingest(claim({ effectiveAt: '2026-10-08T00:00:00.000Z', retrievedAt: '2026-10-09T09:00:00.000Z', symbols: ['ins_a'] }), resolve);
    const stored = s.currentIngestSeq();
    const frozen = s.select({ universeId: 'u', sourceId: SOURCE, asOf: '2026-10-09T13:01:00.000Z', mode: 'decision_time', storedThrough: stored });
    clock.set('2026-10-09T13:00:00.000Z');
    s.ingest(claim({ effectiveAt: '2026-10-08T00:00:00.000Z', retrievedAt: '2026-10-09T12:59:00.000Z', symbols: ['ins_a', 'ins_b'] }), resolve);
    const replay = s.select({ universeId: 'u', sourceId: SOURCE, asOf: '2026-10-09T13:01:00.000Z', mode: 'decision_time', storedThrough: stored });
    expect(replay.evidence.fingerprint).toBe(frozen.evidence.fingerprint);
    expect(replay.members).toEqual(['ins_a']);
    expect(select(s, '2026-10-09T13:01:00.000Z').members).toEqual(['ins_a', 'ins_b']);
  });
});

describe('the store reads the clock before and after the commit, and derived evidence is self-consistent', () => {
  it('the timing proof brackets the commit: recordedAt is read before it, sealedAt after it', () => {
    const readings = ['2026-10-09T10:00:00.000Z', '2026-10-09T10:00:05.000Z'];
    const s = new InMemoryUniverseStore({ clock: () => readings.shift()! });
    s.registerDefinition({ universeId: 'u', definitionVersion: '1', name: 'bracket' });
    s.registerSource(PRODUCTION_UNIVERSE_SOURCE);
    const proof = s.ingest(claim({ effectiveAt: '2026-10-09T09:00:00.000Z', retrievedAt: '2026-10-09T09:00:00.000Z' }), resolve).timingProof;
    expect(proof).toMatchObject({ recordedAt: '2026-10-09T10:00:00.000Z', sealedAt: '2026-10-09T10:00:05.000Z', proofKind: 'COMMIT_SEAL' });
  });

  it('caller-edited derived facts fail the self-consistency check; untouched evidence passes', () => {
    const s = storeOn(manualClock('2026-10-09T12:00:00.000Z'));
    s.ingest(claim({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2020-01-01T00:00:00.000Z' }), resolve);
    const evidence = select(s, '2026-10-10T00:00:00.000Z').evidence;
    expect(universeEvidenceIsConsistent(evidence)).toBe(true);
    expect(universeEvidenceIsConsistent({ ...evidence, strictDecisionTime: true })).toBe(false);
    expect(universeEvidenceIsConsistent({ ...evidence, contemporaneousVintageProven: true, strictDecisionTime: true, historicalReconstruction: false })).toBe(false);
  });
});
