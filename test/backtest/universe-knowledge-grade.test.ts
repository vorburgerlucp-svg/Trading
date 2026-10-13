import { describe, expect, it } from 'vitest';
import { assessBacktestQuality } from '../../src/backtest/quality.js';
import { hashOf } from '../../src/persistence/canonical-json.js';
import type { UniverseEvidence } from '../../src/universe/universe-model.js';
import { historicalSelection, sealedAfterAsOfSelection, strictSelection, unsealedSelection } from '../universe/fixtures.js';

// The backtest grade consumes database-sealed knowledge (universe-engine:v2). A claimed knowledge time never upgrades a grade.

const ASOF = '2026-10-01T08:00:00.000Z';
const context = { pointInTimeUniverse: false, dataComplete: true, corporateActions: 'modeled' as const, providerProduction: true, minimumTrades: 1 };
const bars = { total: 1, knownBeforeUse: 1, contemporaneousVintage: 1, historicalVintage: 0, legacy: 0 };

const grade = (universe: UniverseEvidence | null) => assessBacktestQuality(context, 2, 0, false, bars, [], universe);

describe('backtest grade follows database-sealed universe knowledge', () => {
  it('a strict, sealed-before-effective universe keeps grade A', () => {
    expect(grade(strictSelection('U', ['ins_a'], ASOF).evidence).grade).toBe('A');
  });

  it('a historical reconstruction (sealed after its effective instant) is grade B, never A', () => {
    const q = grade(historicalSelection('U', ['ins_a'], ASOF).evidence);
    expect(q.grade).toBe('B');
    expect(q.reasons.some((r) => r.startsWith('UNIVERSE_HISTORICAL_RECONSTRUCTION'))).toBe(true);
  });

  it('a universe revision with no timing proof is grade C, even when research can read it', () => {
    const q = grade(unsealedSelection('U', ASOF).evidence);
    expect(q.grade).toBe('C');
    expect(q.reasons.some((r) => r.startsWith('UNIVERSE_KNOWLEDGE_NOT_SEALED'))).toBe(true);
  });

  it('a revision NEXUS sealed after asOf is a reconstruction for this run: grade B, never A', () => {
    expect(grade(sealedAfterAsOfSelection('U', ASOF).evidence).grade).not.toBe('A');
  });

  it('universe-engine:v1 evidence is never graded as proven: grade C with the not-sealed reason', () => {
    const fields = { status: 'SELECTED', universeId: 'U', definitionVersion: '1', sourceId: 'fixture:universe:production', sourceProduction: true, snapshotKey: 'uk_' + 'a'.repeat(40), snapshotRevisionId: 'urev_' + 'b'.repeat(40), revision: 1, effectiveAt: '2020-01-01T00:00:00.000Z', knownAt: '2019-12-31T12:00:00.000Z', vintage: 'contemporaneous', completeness: 'COMPLETE', complete: true, decisionTimeKnowledgeProven: true, contemporaneousVintage: true, historicalReconstruction: false, strictDecisionTime: true, replayMode: 'decision_time', asOf: ASOF, memberCount: 1 };
    const legacy = { ...fields, fingerprint: hashOf({ kind: 'universe-evidence:v1', ...fields }) } as unknown as UniverseEvidence;
    const q = grade(legacy);
    expect(q.grade).toBe('C');
    expect(q.reasons.some((r) => r.startsWith('UNIVERSE_KNOWLEDGE_NOT_SEALED'))).toBe(true);
  });

  it('a caller claim alone is still not evidence: no cited universe is grade C', () => {
    const q = assessBacktestQuality({ ...context, pointInTimeUniverse: true }, 2, 0, false, bars, [], null);
    expect(q.grade).toBe('C');
    expect(q.reasons.some((r) => r.startsWith('CALLER_UNIVERSE_CLAIM_NOT_PROVEN'))).toBe(true);
  });
});
