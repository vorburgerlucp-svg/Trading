import { describe, expect, it } from 'vitest';
import { strongO1Eligible } from '../../src/financial/financial-gateway.js';
import { buildFinancialSourceAttestation, type FinancialSourceAttestation } from '../../src/financial/financial-source-attestation.js';
import { FinancialReplayReader } from '../../src/financial/financial-replay-reader.js';
import type { SealedFinancialEvidence } from '../../src/financial/financial-knowledge.js';
import { sha256Hex } from '../../src/persistence/canonical-json.js';
import { AAPL_ID } from './fixtures.js';
import { archiveHeaderText, CIK_PADDED, FY_ACCESSION, FY_FILING_DATE, sealedWithoutDatabase, secFyEvidence } from './sec-attestation-fixtures.js';

// docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §5, §7, §9, §15. The replay reader is tested with in-memory stores, so each rule is checked on its
// own. The fake attestation store returns a same-day attestation on purpose: the reader must apply the New York policy again, and must not trust the store.

function attestationFor(sealed: SealedFinancialEvidence, options: { acceptance?: string; sourceFilingDate?: string; artifactText?: string } = {}): FinancialSourceAttestation {
  const artifactText = options.artifactText ?? archiveHeaderText({ acceptance: options.acceptance ?? '20241101060130' });
  return buildFinancialSourceAttestation({
    evidenceId: sealed.evidence.evidenceId,
    evidenceRecordHash: sealed.recordHash,
    evidenceContentHash: sealed.evidence.contentHash,
    provider: 'sec-edgar',
    connectorId: 'sec-edgar-fundamentals-rest',
    capability: 'fundamentals',
    instrumentId: AAPL_ID,
    cik: CIK_PADDED,
    sourceId: FY_ACCESSION,
    sourceForm: '10-K',
    sourceFilingDate: options.sourceFilingDate ?? FY_FILING_DATE,
    sourceAcceptanceRaw: options.acceptance ?? '20241101060130',
    sourceArtifactHash: sha256Hex(artifactText),
    selectedFactsHash: 'e'.repeat(64),
    policyVersion: 'sec-filing-date-next-ny-day:v1',
  });
}

/** An in-memory evidence store with a DB seal that is either present or absent. */
function evidenceStore(records: SealedFinancialEvidence[], sealed: SealedFinancialEvidence[] = []) {
  return {
    readAvailable: async () => sealed,
    getSealed: async (evidenceId: string) => records.find((r) => r.evidence.evidenceId === evidenceId) ?? null,
  };
}

/** An in-memory attestation store that returns everything, unfiltered, so the reader's own policy is what decides. */
function attestationStore(attestations: FinancialSourceAttestation[]) {
  return {
    readEligible: async () => attestations,
    getForEvidence: async (evidenceId: string) => attestations.filter((a) => a.evidenceId === evidenceId),
  };
}

async function fixture() {
  const evidence = await secFyEvidence();
  const sealed = sealedWithoutDatabase(evidence);
  return { evidence, sealed, attestation: attestationFor(sealed) };
}

describe('decision_time uses the DB knowledge seal only (brief 8, 31)', () => {
  it('an attested record that the DB has not sealed by asOf is not returned', async () => {
    const { sealed, attestation } = await fixture();
    const reader = new FinancialReplayReader({ evidenceStore: evidenceStore([sealed]), attestationStore: attestationStore([attestation]) });
    expect(await reader.readForReplay({ asOf: '2025-06-01T00:00:00.000Z', useCase: 'decision_time' })).toEqual([]);
  });

  it('a record sealed by asOf is returned with the DB basis, never the attestation basis', async () => {
    const { sealed, attestation } = await fixture();
    const reader = new FinancialReplayReader({ evidenceStore: evidenceStore([sealed], [sealed]), attestationStore: attestationStore([attestation]) });
    const records = await reader.readForReplay({ asOf: '2026-06-01T00:00:00.000Z', useCase: 'decision_time' });
    expect(records.map((r) => r.basis)).toEqual(['DB_KNOWLEDGE_SEAL']);
  });
});

describe('historical_research uses a verified attestation under the New York policy (brief 29–30)', () => {
  it('an attested record is returned with the SEC basis once the next New York day has begun', async () => {
    const { sealed, attestation } = await fixture();
    const reader = new FinancialReplayReader({ evidenceStore: evidenceStore([sealed]), attestationStore: attestationStore([attestation]) });
    const records = await reader.readForReplay({ asOf: '2024-11-02T04:00:00.000Z', useCase: 'historical_research' });
    expect(records.map((r) => r.basis)).toEqual(['SEC_SOURCE_ATTESTATION']);
    expect(records[0]!.evidence.evidenceId).toBe(sealed.evidence.evidenceId);
  });

  it('the same New York day is unavailable at 09:00 and at 23:59:59 (brief 30)', async () => {
    const { sealed, attestation } = await fixture();
    const reader = new FinancialReplayReader({ evidenceStore: evidenceStore([sealed]), attestationStore: attestationStore([attestation]) });
    expect(await reader.readForReplay({ asOf: '2024-11-01T13:00:00.000Z', useCase: 'historical_research' })).toEqual([]);
    expect(await reader.readForReplay({ asOf: '2024-11-02T03:59:59.999Z', useCase: 'historical_research' })).toEqual([]);
  });

  it('the reader applies the New York policy itself, even when the store returns a same-day attestation', async () => {
    const { sealed } = await fixture();
    const sameDay = attestationFor(sealed, { sourceFilingDate: '2024-11-02' });
    const reader = new FinancialReplayReader({ evidenceStore: evidenceStore([sealed]), attestationStore: attestationStore([sameDay]) });
    expect(await reader.readForReplay({ asOf: '2024-11-02T02:00:00.000Z', useCase: 'historical_research' })).toEqual([]);
  });

  it('when the DB seal and the attestation both exist, the DB seal is the stated basis', async () => {
    const { sealed, attestation } = await fixture();
    const reader = new FinancialReplayReader({ evidenceStore: evidenceStore([sealed], [sealed]), attestationStore: attestationStore([attestation]) });
    const records = await reader.readForReplay({ asOf: '2026-06-01T00:00:00.000Z', useCase: 'historical_research' });
    expect(records.map((r) => r.basis)).toEqual(['DB_KNOWLEDGE_SEAL']);
  });

  it('two different verified attestations for the same evidence fail closed with SOURCE_ATTESTATION_CONFLICT (brief 35)', async () => {
    const { sealed, attestation } = await fixture();
    const other = attestationFor(sealed, { acceptance: '20241101060131' });
    expect(other.attestationId).not.toBe(attestation.attestationId);
    const reader = new FinancialReplayReader({ evidenceStore: evidenceStore([sealed]), attestationStore: attestationStore([attestation, other]) });
    await expect(reader.readForReplay({ asOf: '2024-11-02T04:00:00.000Z', useCase: 'historical_research' })).rejects.toMatchObject({ code: 'SOURCE_ATTESTATION_CONFLICT' });
  });

  it('an attestation bound to another evidence record is refused, never returned (brief 18)', async () => {
    const { sealed, attestation } = await fixture();
    const wrongRecord = { ...attestation, evidenceRecordHash: 'd'.repeat(64) };
    const reader = new FinancialReplayReader({ evidenceStore: evidenceStore([sealed]), attestationStore: attestationStore([wrongRecord]) });
    await expect(reader.readForReplay({ asOf: '2024-11-02T04:00:00.000Z', useCase: 'historical_research' })).rejects.toMatchObject({ code: 'SOURCE_ATTESTATION_INVALID' });
  });

  it('a record returned on source attestation is still not O1-eligible', async () => {
    const { sealed, attestation, evidence } = await fixture();
    const reader = new FinancialReplayReader({ evidenceStore: evidenceStore([sealed]), attestationStore: attestationStore([attestation]) });
    const [record] = await reader.readForReplay({ asOf: '2024-11-02T04:00:00.000Z', useCase: 'historical_research' });
    expect(strongO1Eligible(evidence, record!.sealed.seal).eligible).toBe(false);
  });

  it('an unknown use case is refused', async () => {
    const { sealed } = await fixture();
    const reader = new FinancialReplayReader({ evidenceStore: evidenceStore([sealed]), attestationStore: attestationStore([]) });
    await expect(reader.readForReplay({ asOf: '2024-11-02T04:00:00.000Z', useCase: 'paper_trading' as never })).rejects.toBeDefined();
  });
});

describe('the source vocabulary is not the DB vocabulary (brief 9)', () => {
  it('reports SOURCE_ATTESTATION_MISSING when there is no attestation', async () => {
    const { sealed } = await fixture();
    const reader = new FinancialReplayReader({ evidenceStore: evidenceStore([sealed]), attestationStore: attestationStore([]) });
    expect(await reader.sourceResultOf(sealed.evidence.evidenceId, '2024-11-02T04:00:00.000Z')).toBe('SOURCE_ATTESTATION_MISSING');
  });

  it('reports SOURCE_NOT_YET_ELIGIBLE on the same New York day', async () => {
    const { sealed, attestation } = await fixture();
    const reader = new FinancialReplayReader({ evidenceStore: evidenceStore([sealed]), attestationStore: attestationStore([attestation]) });
    expect(await reader.sourceResultOf(sealed.evidence.evidenceId, '2024-11-01T13:00:00.000Z')).toBe('SOURCE_NOT_YET_ELIGIBLE');
  });

  it('reports SOURCE_ATTESTED_RESEARCH_AVAILABLE on the next New York day, and never PROVEN_AVAILABLE', async () => {
    const { sealed, attestation } = await fixture();
    const reader = new FinancialReplayReader({ evidenceStore: evidenceStore([sealed]), attestationStore: attestationStore([attestation]) });
    expect(await reader.sourceResultOf(sealed.evidence.evidenceId, '2024-11-02T04:00:00.000Z')).toBe('SOURCE_ATTESTED_RESEARCH_AVAILABLE');
  });
});

describe('the DB knowledge path is not changed (brief 7)', () => {
  it('decision_time reads only through the evidence store readAvailable, and never asks for attestations', async () => {
    const { sealed } = await fixture();
    let attestationReads = 0;
    const reader = new FinancialReplayReader({
      evidenceStore: evidenceStore([sealed]),
      attestationStore: { readEligible: async () => (attestationReads++, []), getForEvidence: async () => (attestationReads++, []) },
    });
    await reader.readForReplay({ asOf: '2026-06-01T00:00:00.000Z', useCase: 'decision_time' });
    expect(attestationReads).toBe(0);
  });
});
