import { describe, expect, it } from 'vitest';
import { buildFinancialSourceAttestation, FINANCIAL_SOURCE_ATTESTATION_VERSION, verifyFinancialSourceAttestation } from '../../src/financial/financial-source-attestation.js';
import { AAPL_ID } from './fixtures.js';

// docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §18–§19, §22. The record is self-verifying, binds the exact evidence it was built for, and separates
// semantic identity from metadata. A changed artifact, accession, form, date, fact projection or policy is a different attestation. Acceptance metadata
// and creation time are not identity.

const H = (c: string) => c.repeat(64);

function draft(overrides: Record<string, unknown> = {}) {
  return {
    evidenceId: 'fe_' + H('a'),
    evidenceRecordHash: H('b'),
    evidenceContentHash: H('c'),
    provider: 'sec-edgar',
    connectorId: 'sec-edgar-fundamentals-rest',
    capability: 'fundamentals',
    instrumentId: AAPL_ID,
    cik: '0000320193',
    sourceId: '0000320193-24-000081',
    sourceForm: '10-K',
    sourceFilingDate: '2024-11-01',
    sourceAcceptanceRaw: '20241101060130',
    sourceArtifactHash: H('d'),
    selectedFactsHash: H('e'),
    policyVersion: 'sec-filing-date-next-ny-day:v1',
    ...overrides,
  };
}

const EXPECTED = { evidenceId: 'fe_' + H('a'), evidenceRecordHash: H('b'), evidenceContentHash: H('c'), instrumentId: AAPL_ID };

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNEXPECTED';
  }
}

describe('building and verifying (brief 21)', () => {
  it('names its schema version', () => {
    expect(FINANCIAL_SOURCE_ATTESTATION_VERSION).toBe('financial-source-attestation:v1');
  });

  it('builds a record with a fsa_ identifier and a SHA-256 attestation hash, and the fixed archive URL', () => {
    const a = buildFinancialSourceAttestation(draft());
    expect(a.attestationId).toMatch(/^fsa_[0-9a-f]{64}$/);
    expect(a.attestationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sourceArtifactUrl).toBe('https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/0000320193-24-000081-index-headers.html');
  });

  it('verifies a record it built', () => {
    const a = buildFinancialSourceAttestation(draft());
    expect(verifyFinancialSourceAttestation(a, EXPECTED)).toEqual(a);
  });

  it('a changed sourceFilingDate in the stored record fails verification: the hashes are recomputed', () => {
    const a = buildFinancialSourceAttestation(draft());
    expect(codeOf(() => verifyFinancialSourceAttestation({ ...a, sourceFilingDate: '2024-11-02' }))).toBe('SOURCE_ATTESTATION_INVALID');
  });

  it('a changed sourceArtifactHash in the stored record fails verification', () => {
    const a = buildFinancialSourceAttestation(draft());
    expect(codeOf(() => verifyFinancialSourceAttestation({ ...a, sourceArtifactHash: H('9') }))).toBe('SOURCE_ATTESTATION_INVALID');
  });

  it('a changed selectedFactsHash in the stored record fails verification', () => {
    const a = buildFinancialSourceAttestation(draft());
    expect(codeOf(() => verifyFinancialSourceAttestation({ ...a, selectedFactsHash: H('9') }))).toBe('SOURCE_ATTESTATION_INVALID');
  });

  it('a changed record JSON fails verification even when the identifier is kept', () => {
    const a = buildFinancialSourceAttestation(draft());
    expect(codeOf(() => verifyFinancialSourceAttestation({ ...a, sourceAcceptanceRaw: '20241101060131' }))).toBe('SOURCE_ATTESTATION_INVALID');
  });

  it('the record has no creation time: attested_at is a database column, outside the hashed record (§19)', () => {
    expect(Object.keys(buildFinancialSourceAttestation(draft()))).not.toContain('createdAt');
  });

  it('building does not mutate its input', () => {
    const input = draft();
    const before = JSON.stringify(input);
    buildFinancialSourceAttestation(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('semantic identity (brief 22)', () => {
  const base = buildFinancialSourceAttestation(draft());
  const differs = (changed: Record<string, unknown>) => buildFinancialSourceAttestation(draft(changed)).attestationId !== base.attestationId;

  it.each([
    ['the artifact hash', { sourceArtifactHash: H('9') }],
    ['the selected-facts hash', { selectedFactsHash: H('9') }],
    ['the source filing date', { sourceFilingDate: '2024-11-02' }],
    ['the accession', { sourceId: '0000320193-24-000099' }],
    ['the CIK', { cik: '0000320194' }],
    ['the evidence id', { evidenceId: 'fe_' + H('f') }],
    ['the evidence record hash', { evidenceRecordHash: H('8') }],
    ['the evidence content hash', { evidenceContentHash: H('7') }],
  ])('changing %s changes the identity', (_label, changed) => {
    expect(differs(changed)).toBe(true);
  });

  it('a different acceptance value is metadata: the identity is unchanged, but the record hash differs', () => {
    const other = buildFinancialSourceAttestation(draft({ sourceAcceptanceRaw: '20241101060131' }));
    expect(other.attestationId).toBe(base.attestationId);
    expect(other.attestationHash).not.toBe(base.attestationHash);
  });

  it('a null acceptance value is lawful metadata', () => {
    expect(buildFinancialSourceAttestation(draft({ sourceAcceptanceRaw: null })).attestationId).toBe(base.attestationId);
  });
});

describe('the supported scope (brief 10, 43)', () => {
  it('refuses a provider other than sec-edgar', () => {
    expect(codeOf(() => buildFinancialSourceAttestation(draft({ provider: 'massive' })))).toBe('SOURCE_ATTESTATION_UNSUPPORTED');
  });

  it('refuses a connector other than the SEC fundamentals connector', () => {
    expect(codeOf(() => buildFinancialSourceAttestation(draft({ connectorId: 'massive-news-rest' })))).toBe('SOURCE_ATTESTATION_UNSUPPORTED');
  });

  it('refuses a capability other than fundamentals', () => {
    expect(codeOf(() => buildFinancialSourceAttestation(draft({ capability: 'news' })))).toBe('SOURCE_ATTESTATION_UNSUPPORTED');
  });

  it.each(['10-Q/A', '10-K/A', '8-K', '10-KT'])('refuses the form %s, which is never a source', (form) => {
    expect(codeOf(() => buildFinancialSourceAttestation(draft({ sourceForm: form })))).toBe('SOURCE_ATTESTATION_UNSUPPORTED');
  });

  it('refuses an unknown policy version', () => {
    expect(codeOf(() => buildFinancialSourceAttestation(draft({ policyVersion: 'sec-filing-date-same-day:v1' })))).toBe('SOURCE_ATTESTATION_INVALID');
  });

  it('accepts the 10-Q and the 10-K', () => {
    expect(codeOf(() => buildFinancialSourceAttestation(draft({ sourceForm: '10-Q' })))).toBeNull();
    expect(codeOf(() => buildFinancialSourceAttestation(draft({ sourceForm: '10-K' })))).toBeNull();
  });
});

describe('binding to the evidence it is checked with (brief 19, 18)', () => {
  const a = buildFinancialSourceAttestation(draft());

  it('an attestation checked against another evidence id is refused', () => {
    expect(codeOf(() => verifyFinancialSourceAttestation(a, { ...EXPECTED, evidenceId: 'fe_' + H('f') }))).toBe('SOURCE_ATTESTATION_INVALID');
  });

  it('an attestation checked against another record hash is refused', () => {
    expect(codeOf(() => verifyFinancialSourceAttestation(a, { ...EXPECTED, evidenceRecordHash: H('6') }))).toBe('SOURCE_ATTESTATION_INVALID');
  });

  it('an attestation checked against another content hash is refused', () => {
    expect(codeOf(() => verifyFinancialSourceAttestation(a, { ...EXPECTED, evidenceContentHash: H('5') }))).toBe('SOURCE_ATTESTATION_INVALID');
  });

  it('an attestation checked against another instrument is refused', () => {
    expect(codeOf(() => verifyFinancialSourceAttestation(a, { ...EXPECTED, instrumentId: 'instrument-other' }))).toBe('SOURCE_ATTESTATION_INVALID');
  });

  it('an attestation checked against another selected-facts projection is refused', () => {
    expect(codeOf(() => verifyFinancialSourceAttestation(a, { ...EXPECTED, selectedFactsHash: H('4') }))).toBe('SOURCE_ATTESTATION_INVALID');
  });
});
