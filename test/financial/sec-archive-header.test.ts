import { describe, expect, it } from 'vitest';
import { checkArchiveHeader, parseSecArchiveHeader, secArchiveHeaderUrl, SEC_ARCHIVE_HOST, SEC_ARCHIVE_MAX_BYTES } from '../../src/financial/sec-archive-header.js';
import { archiveHeaderText, CIK_PADDED, FY_ACCEPTANCE, FY_ACCESSION, FY_FILING_DATE } from './sec-attestation-fixtures.js';

// docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §12–§13, §16. The archive URL is built only from the mapped CIK and the selected accession. The
// header must agree with the selection on the accession, the exact form, the filing date and the CIK. The acceptance value is raw metadata only.

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNEXPECTED';
  }
}

const ARCHIVE_URL = 'https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/0000320193-24-000081-index-headers.html';

describe('the archive URL (brief 14)', () => {
  it('uses the fixed Archives path on www.sec.gov, with the CIK without leading zeros and the accession without dashes', () => {
    expect(SEC_ARCHIVE_HOST).toBe('www.sec.gov');
    expect(secArchiveHeaderUrl(CIK_PADDED, FY_ACCESSION)).toBe(ARCHIVE_URL);
  });

  it('refuses a CIK that is not ten digits', () => {
    expect(codeOf(() => secArchiveHeaderUrl('320193', FY_ACCESSION))).not.toBeNull();
  });

  it('refuses a malformed accession', () => {
    expect(codeOf(() => secArchiveHeaderUrl(CIK_PADDED, '0000320193-24-81'))).not.toBeNull();
  });

  it('bounds the header at 2 MiB', () => {
    expect(SEC_ARCHIVE_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('parsing the archive header (brief 15, 16)', () => {
  it('reads the accession, the exact submission type, the filing date, the CIK and the raw acceptance value', () => {
    expect(parseSecArchiveHeader(archiveHeaderText())).toEqual({
      accession: FY_ACCESSION,
      submissionType: '10-K',
      filedAsOfDate: FY_FILING_DATE,
      centralIndexKeys: [CIK_PADDED],
      acceptanceRaw: FY_ACCEPTANCE,
    });
  });

  it('keeps the acceptance value as raw text, with no conversion to an instant', () => {
    expect(parseSecArchiveHeader(archiveHeaderText()).acceptanceRaw).toBe('20241101060130');
  });

  it('an absent acceptance value is null, never an invented time', () => {
    expect(parseSecArchiveHeader(archiveHeaderText({ acceptance: null })).acceptanceRaw).toBeNull();
  });

  it('a header with several filers keeps every CENTRAL INDEX KEY', () => {
    expect(parseSecArchiveHeader(archiveHeaderText({ ciks: [CIK_PADDED, '0000000001'] })).centralIndexKeys).toEqual([CIK_PADDED, '0000000001']);
  });

  it('a header without an ACCESSION NUMBER is refused', () => {
    const text = archiveHeaderText().replace(/ACCESSION NUMBER:.*\n/, '');
    expect(codeOf(() => parseSecArchiveHeader(text))).toBe('SOURCE_ARTIFACT_MISMATCH');
  });

  it('an impossible filing date in the header is refused', () => {
    expect(codeOf(() => parseSecArchiveHeader(archiveHeaderText({ filed: '2024-02-30' })))).toBe('SOURCE_ARTIFACT_MISMATCH');
  });

  it('a malformed acceptance value is refused', () => {
    expect(codeOf(() => parseSecArchiveHeader(archiveHeaderText({ acceptance: '2024-11-01 06:01' })))).toBe('SOURCE_ARTIFACT_MISMATCH');
  });
});

describe('the header agrees with the selection (brief 15)', () => {
  const expected = { accession: FY_ACCESSION, form: '10-K', filingDate: FY_FILING_DATE, cik: CIK_PADDED };
  const header = (options = {}) => parseSecArchiveHeader(archiveHeaderText(options));

  it('a consistent header passes', () => {
    expect(codeOf(() => checkArchiveHeader(header(), expected))).toBeNull();
  });

  it('a different accession is a mismatch', () => {
    expect(codeOf(() => checkArchiveHeader(header({ accession: '0000320193-24-000099' }), expected))).toBe('SOURCE_ARTIFACT_MISMATCH');
  });

  it('a different form, including an amendment, is a mismatch', () => {
    expect(codeOf(() => checkArchiveHeader(header({ form: '10-K/A' }), expected))).toBe('SOURCE_ARTIFACT_MISMATCH');
  });

  it('a different filing date is a mismatch', () => {
    expect(codeOf(() => checkArchiveHeader(header({ filed: '2024-11-02' }), expected))).toBe('SOURCE_ARTIFACT_MISMATCH');
  });

  it('a header that does not name the mapped CIK is a mismatch', () => {
    expect(codeOf(() => checkArchiveHeader(header({ ciks: ['0000320194'] }), expected))).toBe('SOURCE_ARTIFACT_MISMATCH');
  });

  it('a header that names the mapped CIK among several filers passes', () => {
    expect(codeOf(() => checkArchiveHeader(header({ ciks: ['0000320194', CIK_PADDED] }), expected))).toBeNull();
  });
});
