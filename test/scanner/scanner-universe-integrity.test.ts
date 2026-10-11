import { describe, expect, it } from 'vitest';
import { hashOf } from '../../src/persistence/canonical-json.js';
import { runMarketScanner } from '../../src/scanner/market-scanner.js';
import { ScannerRunIntegrityError, verifyScannerRun } from '../../src/scanner/scanner-store.js';
import type { ScannerDefinition } from '../../src/scanner/scanner-types.js';
import { isUniverseEvidenceV2 } from '../../src/universe/universe-model.js';
import { historicalSelection, partialSelection, sealedAfterAsOfSelection, strictSelection, unsealedSelection } from '../universe/fixtures.js';

// The universe is proven evidence, not a claim. A scanner run must not say more about its universe than NEXUS's proof does.

const ASOF = '2026-10-01T08:00:00.000Z';
const definition: ScannerDefinition = { id: 'scan_u', version: '1', universeId: 'U', interval: '1d', filters: [], ranking: [], maxCandidates: 5 };
const live: ScannerDefinition = { ...definition, useCase: 'live_trading' };

describe('scanner universe evidence is proven, not claimed', () => {
  it('a partial universe never gives a complete ranking, even when no member is missing', () => {
    const strict = runMarketScanner(definition, strictSelection('U', [], ASOF), [], ASOF);
    const partial = runMarketScanner(definition, partialSelection('U', [], ASOF), [], ASOF);
    expect(strict.rankingComplete).toBe(true);
    expect(partial.universeEvidence.complete).toBe(false);
    expect(partial.rankingComplete).toBe(false);
  });

  it('a stored run cannot mark a ranking complete over a partial universe', () => {
    const partial = runMarketScanner(definition, partialSelection('U', [], ASOF), [], ASOF);
    expect(() => verifyScannerRun({ ...partial, rankingComplete: true, coverage: { ...partial.coverage, complete: true } })).toThrow(ScannerRunIntegrityError);
  });

  it('the universe fingerprint must match the evidence it summarises', () => {
    const run = runMarketScanner(definition, strictSelection('U', [], ASOF), [], ASOF);
    expect(() => verifyScannerRun({ ...run, universeFingerprint: 'f'.repeat(64) })).toThrow(/universe fingerprint does not match/);
  });

  it('edited evidence that keeps its fingerprint is refused: the evidence must agree with its own fingerprint and derived facts', () => {
    const partial = runMarketScanner(definition, partialSelection('U', [], ASOF), [], ASOF);
    const edited = { ...partial, rankingComplete: true, coverage: { ...partial.coverage, complete: true }, universeEvidence: { ...partial.universeEvidence, complete: true } };
    expect(() => verifyScannerRun(edited)).toThrow(/edited after derivation/);
  });

  it('a caller who flips the strict flag of a reconstruction, with its fingerprint kept, is refused', () => {
    const historical = runMarketScanner(definition, historicalSelection('U', [], ASOF), [], ASOF);
    expect(historical.universeEvidence).toMatchObject({ historicalReconstruction: true, strictDecisionTime: false });
    const forged = { ...historical, universeEvidence: { ...historical.universeEvidence, strictDecisionTime: true } };
    expect(() => verifyScannerRun(forged)).toThrow(/edited after derivation/);
  });

  it('a historical reconstruction is never a complete live ranking; a research ranking is complete and says it is not strict', () => {
    const liveRun = runMarketScanner(definition, historicalSelection('U', [], ASOF), [], ASOF);
    expect(liveRun.universeEvidence).toMatchObject({ historicalReconstruction: true, strictDecisionTime: false });
    expect(liveRun.rankingComplete).toBe(false);
    const research = runMarketScanner({ ...definition, useCase: 'research' }, historicalSelection('U', [], ASOF), [], ASOF);
    expect(research.rankingComplete).toBe(true);
    expect(research.universeEvidence.strictDecisionTime).toBe(false);
  });

  it('a live ranking over a revision with no timing proof is not complete (UNSEALED), research may still use it', () => {
    const run = runMarketScanner(live, unsealedSelection('U', ASOF), [], ASOF);
    expect(run.universeEvidence).toMatchObject({ knowledgeProof: 'UNSEALED', decisionTimeKnowledgeProven: false, strictDecisionTime: false });
    expect(run.rankingComplete).toBe(false);
    expect(runMarketScanner({ ...definition, useCase: 'research' }, unsealedSelection('U', ASOF), [], ASOF).universeEvidence.strictDecisionTime).toBe(false);
  });

  it('a live ranking over a revision NEXUS sealed after asOf is not complete: the proof was not held at the decision time', () => {
    const run = runMarketScanner(live, sealedAfterAsOfSelection('U', ASOF), [], ASOF);
    expect(run.universeEvidence).toMatchObject({ knowledgeProof: 'COMMIT_SEALED', decisionTimeKnowledgeProven: false, strictDecisionTime: false });
    expect(run.rankingComplete).toBe(false);
  });

  it('a stored run of universe-engine:v1 is readable, but its evidence is never strong: it has no timing proof', () => {
    const v2 = strictSelection('U', [], ASOF).evidence;
    const fields = {
      status: v2.status,
      universeId: v2.universeId,
      definitionVersion: v2.definitionVersion,
      sourceId: v2.sourceId,
      sourceProduction: v2.sourceProduction,
      snapshotKey: v2.snapshotKey,
      snapshotRevisionId: v2.snapshotRevisionId,
      revision: v2.revision,
      effectiveAt: v2.effectiveAt,
      knownAt: v2.claimedKnownAt,
      vintage: v2.claimedVintage,
      completeness: v2.completeness,
      complete: v2.complete,
      decisionTimeKnowledgeProven: true,
      contemporaneousVintage: true,
      historicalReconstruction: false,
      strictDecisionTime: true,
      replayMode: v2.replayMode,
      asOf: v2.asOf,
      memberCount: v2.memberCount,
    };
    const legacy = { ...fields, fingerprint: hashOf({ kind: 'universe-evidence:v1', ...fields }) };
    const run = runMarketScanner(definition, strictSelection('U', [], ASOF), [], ASOF);
    const legacyRun = { ...run, universeEvidence: legacy, universeFingerprint: legacy.fingerprint };
    expect(() => verifyScannerRun(legacyRun)).not.toThrow();
    expect(isUniverseEvidenceV2(legacyRun.universeEvidence)).toBe(false);
  });
});
