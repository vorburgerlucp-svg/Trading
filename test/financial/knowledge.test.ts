import { describe, expect, it } from 'vitest';
import { FinancialEvidenceIntegrityError } from '../../src/financial/financial-evidence.js';
import { strongO1Eligible } from '../../src/financial/financial-gateway.js';
import { FINANCIAL_KNOWLEDGE_SEAL_VERSION, financialKnowledgeAt, financialSealFor, verifyFinancialSeal, type FinancialEvidenceSeal, type SealedFinancialEvidence } from '../../src/financial/financial-knowledge.js';
import { fundamentalsEvidence } from './evidence-factory.js';

// docs/FINANCIAL_EVIDENCE_PERSISTENCE_V1.md §5–§6, §9, §11, §15. A COMMIT_SEAL brackets the commit: recordedAt is a lower bound, sealedAt an upper bound.
// A PRESENCE_ATTESTATION proves existence by sealedAt and never claims an earlier time, so it can never prove non-availability.

const EVIDENCE_ID = 'fe_' + 'a'.repeat(64);
const RECORD_HASH = 'b'.repeat(64);

function sealOf(overrides: Partial<Omit<FinancialEvidenceSeal, 'sealHash'>> = {}): FinancialEvidenceSeal {
  return financialSealFor({ proofKind: 'COMMIT_SEAL', evidenceId: EVIDENCE_ID, recordHash: RECORD_HASH, recordedAt: '2026-10-09T12:00:00.000Z', sealedAt: '2026-10-09T12:00:05.000Z', ...overrides });
}

function sealed(seal: FinancialEvidenceSeal | null): SealedFinancialEvidence {
  return { evidence: {} as never, recordHash: RECORD_HASH, semanticHash: 'a'.repeat(64), seal };
}

describe('the seal is built from canonical readings and binds its record (§11)', () => {
  it('has the version financial-knowledge-seal:v1 and a hash that changes with every bound field', () => {
    expect(FINANCIAL_KNOWLEDGE_SEAL_VERSION).toBe('financial-knowledge-seal:v1');
    const seal = sealOf();
    expect(() => verifyFinancialSeal(seal, { evidenceId: EVIDENCE_ID, recordHash: RECORD_HASH })).not.toThrow();
    const tampered: Array<Partial<FinancialEvidenceSeal>> = [
      { sealedAt: '2026-10-09T12:00:06.000Z' },
      { recordedAt: '2026-10-09T11:59:59.000Z' },
      { proofKind: 'PRESENCE_ATTESTATION' },
      { evidenceId: 'fe_' + 'c'.repeat(64) },
      { recordHash: 'd'.repeat(64) },
      { sealHash: 'e'.repeat(64) },
    ];
    for (const change of tampered) {
      expect(() => verifyFinancialSeal({ ...seal, ...change }, { evidenceId: EVIDENCE_ID, recordHash: RECORD_HASH }), JSON.stringify(change)).toThrow(FinancialEvidenceIntegrityError);
    }
  });

  it('a seal for another record fails', () => {
    expect(() => verifyFinancialSeal(sealOf(), { evidenceId: EVIDENCE_ID, recordHash: 'f'.repeat(64) })).toThrow(FinancialEvidenceIntegrityError);
  });

  it('readings must be canonical ISO UTC with milliseconds, and recordedAt must not follow sealedAt', () => {
    expect(() => sealOf({ recordedAt: '2026-10-09T12:00:00Z' })).toThrow(FinancialEvidenceIntegrityError);
    expect(() => sealOf({ recordedAt: '2026-10-09T12:00:09.000Z', sealedAt: '2026-10-09T12:00:05.000Z' })).toThrow(FinancialEvidenceIntegrityError);
  });
});

describe('financialKnowledgeAt: what NEXUS can prove about its own knowledge (§9)', () => {
  it('a COMMIT_SEAL with sealedAt at or before asOf proves availability', () => {
    expect(financialKnowledgeAt(sealed(sealOf()), '2026-10-09T12:00:05.000Z').result).toBe('PROVEN_AVAILABLE');
  });

  it('a COMMIT_SEAL with recordedAt after asOf proves non-availability', () => {
    expect(financialKnowledgeAt(sealed(sealOf()), '2026-10-09T11:59:59.999Z').result).toBe('PROVEN_NOT_AVAILABLE');
  });

  it('the bracket gap (recordedAt <= asOf < sealedAt) proves neither: the commit may have landed before or after asOf', () => {
    expect(financialKnowledgeAt(sealed(sealOf()), '2026-10-09T12:00:02.000Z').result).toBe('UNPROVEN');
  });

  it('a PRESENCE_ATTESTATION proves availability only from sealedAt', () => {
    const presence = sealOf({ proofKind: 'PRESENCE_ATTESTATION', recordedAt: '2026-10-09T12:05:00.000Z', sealedAt: '2026-10-09T12:05:01.000Z' });
    expect(financialKnowledgeAt(sealed(presence), '2026-10-09T12:05:01.000Z').result).toBe('PROVEN_AVAILABLE');
    expect(financialKnowledgeAt(sealed(presence), '2026-10-09T12:05:00.000Z').result).toBe('UNPROVEN');
  });

  it('a PRESENCE_ATTESTATION never proves non-availability: the record may have existed before the attestation began', () => {
    const presence = sealOf({ proofKind: 'PRESENCE_ATTESTATION', recordedAt: '2026-10-09T12:05:00.000Z', sealedAt: '2026-10-09T12:05:01.000Z' });
    expect(financialKnowledgeAt(sealed(presence), '2026-10-09T12:00:00.000Z').result).toBe('UNPROVEN');
    expect(financialKnowledgeAt(sealed(presence), '2026-10-09T12:00:00.000Z').result).not.toBe('PROVEN_NOT_AVAILABLE');
  });

  it('no seal is UNPROVEN, whatever the claimed times', () => {
    expect(financialKnowledgeAt(sealed(null), '2030-01-01T00:00:00.000Z').result).toBe('UNPROVEN');
  });
});

describe('O1 stays false, and the reason names the seal state (§15)', () => {
  it('without a seal the reason is UNSEALED_EXTERNAL_EVIDENCE', async () => {
    expect(strongO1Eligible(await fundamentalsEvidence())).toEqual({ eligible: false, reason: 'UNSEALED_EXTERNAL_EVIDENCE' });
  });

  it('with a proven seal the reason becomes FINANCIAL_SOURCE_NOT_PRODUCTION_VERIFIED and eligibility stays false', async () => {
    const evidence = await fundamentalsEvidence();
    expect(strongO1Eligible(evidence, sealOf({ evidenceId: evidence.evidenceId }))).toEqual({ eligible: false, reason: 'FINANCIAL_SOURCE_NOT_PRODUCTION_VERIFIED' });
  });

  it('a seal for another evidence record does not change the reason', async () => {
    const evidence = await fundamentalsEvidence();
    expect(strongO1Eligible(evidence, sealOf())).toEqual({ eligible: false, reason: 'UNSEALED_EXTERNAL_EVIDENCE' });
  });
});
