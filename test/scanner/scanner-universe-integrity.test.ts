import { describe, expect, it } from 'vitest';
import { runMarketScanner } from '../../src/scanner/market-scanner.js';
import { ScannerRunIntegrityError, verifyScannerRun } from '../../src/scanner/scanner-store.js';
import type { ScannerDefinition } from '../../src/scanner/scanner-types.js';
import { historicalSelection, partialSelection, strictSelection } from '../universe/fixtures.js';

// The universe is proven evidence, not a claim. A scanner run must not be able to say more about its universe than the evidence does.

const ASOF = '2026-10-01T08:00:00.000Z';
const definition: ScannerDefinition = { id: 'scan_u', version: '1', universeId: 'U', interval: '1d', filters: [], ranking: [], maxCandidates: 5 };

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

  it('edited evidence that keeps its fingerprint is refused: the evidence must hash to its own fingerprint', () => {
    const partial = runMarketScanner(definition, partialSelection('U', [], ASOF), [], ASOF);
    const edited = { ...partial, rankingComplete: true, coverage: { ...partial.coverage, complete: true }, universeEvidence: { ...partial.universeEvidence, complete: true } };
    expect(() => verifyScannerRun(edited)).toThrow(/edited after derivation/);
  });

  it('a historical reconstruction is never a complete live ranking; a research ranking is complete and says it is not strict', () => {
    const live = runMarketScanner(definition, historicalSelection('U', [], ASOF), [], ASOF);
    expect(live.universeEvidence).toMatchObject({ historicalReconstruction: true, strictDecisionTime: false });
    expect(live.rankingComplete).toBe(false);
    const research = runMarketScanner({ ...definition, useCase: 'research' }, historicalSelection('U', [], ASOF), [], ASOF);
    expect(research.rankingComplete).toBe(true);
    expect(research.universeEvidence.strictDecisionTime).toBe(false);
  });
});
