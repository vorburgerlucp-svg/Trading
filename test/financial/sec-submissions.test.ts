import { describe, expect, it } from 'vitest';
import { parseSecJson } from '../../src/financial/sec-edgar-json.js';
import { companyFactsOf, selectFundamentals, submissionsOf } from '../../src/financial/sec-fact-selection.js';
import { ALL_FILINGS, AS_OF, baseConcepts, companyFactsText, FILINGS, type FilingRow, LIVE_SHAPED_ROWS, submissionsText } from './sec-fixtures.js';

// docs/SEC_EDGAR_FUNDAMENTALS_V1.md §8, §27a. The live SEC submissions page contains forms that have no reporting period, so their reportDate is blank.
// Those rows are lawful and irrelevant to V1, and they must not invalidate the document. A 10-Q or a 10-K is a fundamentals source, and it stays strict.
// Structure stays strict for the whole document. No network: every page is a fixture.

const CIK = '0000320193';
const FY = FILINGS.fy2024;
const Q3 = FILINGS.q3fy2024;

// The live condition as reported: a blank reportDate on an unrelated form whose acceptance timestamp is present.
const UNRELATED: FilingRow = { accession: '0000320193-24-000050', form: '8-K', filingDate: '2024-10-30', reportDate: '', acceptanceDateTime: '2024-10-30T17:05:12.000Z' };

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNEXPECTED';
  }
}

function subs(rows: readonly FilingRow[]) {
  return submissionsOf(parseSecJson(submissionsText(rows)), CIK);
}

/** A raw submissions document with explicit columns. JSON.stringify drops an undefined column, so a test can omit one. */
function doc(recent: Record<string, unknown>): string {
  return JSON.stringify({ cik: CIK, filings: { recent } });
}

/** One 10-K row as columns. A test overrides one column to exercise one rule. */
function tenK(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accessionNumber: [FY.accession],
    form: ['10-K'],
    filingDate: [FY.filingDate],
    reportDate: [FY.reportDate],
    acceptanceDateTime: ['2024-11-01T06:01:30.000Z'],
    ...overrides,
  };
}

function factsOf() {
  return companyFactsOf(parseSecJson(companyFactsText(baseConcepts())), CIK);
}

describe('unrelated forms with blank metadata (§8, brief 1–2, 8)', () => {
  it('a blank reportDate on an unrelated form does not invalidate the document', () => {
    expect(() => subs([UNRELATED, FY])).not.toThrow();
  });

  it('an unrelated filing is not materialized, so it cannot become eligible for fundamentals', () => {
    expect(subs([UNRELATED, FY]).filings.map((f) => f.accession)).toEqual([FY.accession]);
    const selection = selectFundamentals({ period: '2024-FY', currency: 'USD', asOf: AS_OF }, subs([UNRELATED, FY]), factsOf());
    expect(selection.accession).toBe(FY.accession);
  });

  it('the live-shaped page: supported rows mixed with blank unrelated rows still yields the supported filings in order', () => {
    expect(subs(LIVE_SHAPED_ROWS).filings.map((f) => f.accession)).toEqual([FILINGS.future.accession, FY.accession, Q3.accession, FILINGS.q1fy2025.accession]);
  });

  it('the live-shaped page selects the same FY2024 record as the clean page', () => {
    const clean = selectFundamentals({ period: '2024-FY', currency: 'USD', asOf: AS_OF }, subs(ALL_FILINGS.slice()), factsOf());
    const live = selectFundamentals({ period: '2024-FY', currency: 'USD', asOf: AS_OF }, subs(LIVE_SHAPED_ROWS), factsOf());
    expect(live).toEqual(clean);
  });

  it('the live-shaped page selects the same Q3 record as the clean page', () => {
    const clean = selectFundamentals({ period: '2024-Q3', currency: 'USD', asOf: AS_OF }, subs(ALL_FILINGS.slice()), factsOf());
    const live = selectFundamentals({ period: '2024-Q3', currency: 'USD', asOf: AS_OF }, subs(LIVE_SHAPED_ROWS), factsOf());
    expect(live).toEqual(clean);
  });

  it('an unrelated form with a blank acceptanceDateTime does not invalidate the document', () => {
    expect(() => subs([{ ...UNRELATED, acceptanceDateTime: '' }, FY])).not.toThrow();
  });

  it('an unrelated form with an unused, non-date reportDate is not validated, because its metadata is not used', () => {
    expect(() => subs([{ ...UNRELATED, reportDate: 'not a date' }, FY])).not.toThrow();
  });

  it('an unrelated row whose reportDate is not a string is a structural error', () => {
    const text = doc({ ...tenK(), accessionNumber: [FY.accession, UNRELATED.accession], form: ['10-K', '8-K'], filingDate: [FY.filingDate, UNRELATED.filingDate], reportDate: [FY.reportDate, 20241030], acceptanceDateTime: ['2024-11-01T06:01:30.000Z', ''] });
    expect(codeOf(() => submissionsOf(parseSecJson(text), CIK))).toBe('SCHEMA_INVALID');
  });

  it('an unrelated row whose acceptanceDateTime is not a string is a structural error', () => {
    const text = doc({ ...tenK(), accessionNumber: [FY.accession, UNRELATED.accession], form: ['10-K', '8-K'], filingDate: [FY.filingDate, UNRELATED.filingDate], reportDate: [FY.reportDate, ''], acceptanceDateTime: ['2024-11-01T06:01:30.000Z', 7] });
    expect(codeOf(() => submissionsOf(parseSecJson(text), CIK))).toBe('SCHEMA_INVALID');
  });

  it('an unrelated row whose form is not a string is a structural error', () => {
    const text = doc({ ...tenK(), accessionNumber: [FY.accession, UNRELATED.accession], form: ['10-K', 8], filingDate: [FY.filingDate, UNRELATED.filingDate], reportDate: [FY.reportDate, ''], acceptanceDateTime: ['2024-11-01T06:01:30.000Z', ''] });
    expect(codeOf(() => submissionsOf(parseSecJson(text), CIK))).toBe('SCHEMA_INVALID');
  });

  it('an unrelated row with a malformed accession is still refused: every accession is structural', () => {
    expect(codeOf(() => subs([{ ...UNRELATED, accession: 'BAD' }, FY]))).toBe('SCHEMA_INVALID');
  });

  it('lookalike forms are unrelated, not broadened: 10-KT, 10-K405 and the amendment forms are never materialized', () => {
    const lookalikes: FilingRow[] = [
      { accession: '0000320193-24-000061', form: '10-KT', filingDate: '2024-10-10', reportDate: '', acceptanceDateTime: '' },
      { accession: '0000320193-24-000062', form: '10-K405', filingDate: '2024-10-11', reportDate: '', acceptanceDateTime: '' },
      { accession: '0000320193-24-000063', form: '10-K/A', filingDate: '2024-10-12', reportDate: '', acceptanceDateTime: '' },
      { accession: '0000320193-24-000064', form: '10-Q/A', filingDate: '2024-10-13', reportDate: '', acceptanceDateTime: '' },
    ];
    expect(subs([...lookalikes, FY]).filings.map((f) => f.accession)).toEqual([FY.accession]);
  });
});

describe('supported filings stay strict (§3, §5, brief 3, 5, 9)', () => {
  it('a 10-K with a blank reportDate is refused', () => {
    expect(codeOf(() => submissionsOf(parseSecJson(doc(tenK({ reportDate: [''] }))), CIK))).toBe('SCHEMA_INVALID');
  });

  it('a 10-Q with a blank reportDate is refused', () => {
    const text = doc({ accessionNumber: [Q3.accession], form: ['10-Q'], filingDate: [Q3.filingDate], reportDate: [''], acceptanceDateTime: [''] });
    expect(codeOf(() => submissionsOf(parseSecJson(text), CIK))).toBe('SCHEMA_INVALID');
  });

  it('a 10-K with a malformed reportDate is refused', () => {
    expect(codeOf(() => submissionsOf(parseSecJson(doc(tenK({ reportDate: ['2024/09/28'] }))), CIK))).toBe('SCHEMA_INVALID');
  });

  it('a 10-Q with an impossible reportDate is refused', () => {
    const text = doc({ accessionNumber: [Q3.accession], form: ['10-Q'], filingDate: [Q3.filingDate], reportDate: ['2024-02-30'], acceptanceDateTime: [''] });
    expect(codeOf(() => submissionsOf(parseSecJson(text), CIK))).toBe('SCHEMA_INVALID');
  });

  it('a 10-K with a malformed filingDate is refused', () => {
    expect(codeOf(() => submissionsOf(parseSecJson(doc(tenK({ filingDate: ['11/01/2024'] }))), CIK))).toBe('SCHEMA_INVALID');
  });

  it('a 10-Q with a malformed accession is refused', () => {
    const text = doc({ accessionNumber: ['BAD-ACCESSION'], form: ['10-Q'], filingDate: [Q3.filingDate], reportDate: [Q3.reportDate], acceptanceDateTime: [''] });
    expect(codeOf(() => submissionsOf(parseSecJson(text), CIK))).toBe('SCHEMA_INVALID');
  });

  it('a non-empty but malformed acceptanceDateTime on a supported filing is refused, because its syntax is checked when present', () => {
    expect(codeOf(() => submissionsOf(parseSecJson(doc(tenK({ acceptanceDateTime: ['yesterday'] }))), CIK))).toBe('SCHEMA_INVALID');
  });

  it('a blank acceptanceDateTime on a supported filing does not block it, because the value is unused in V1', () => {
    expect(subs([{ ...FY, acceptanceDateTime: '' }]).filings.map((f) => f.accession)).toEqual([FY.accession]);
  });
});

describe('parallel columns and document structure stay strict (§7, §8, brief 7–8)', () => {
  it('a reportDate column shorter than the accession column is refused, even beside unrelated rows', () => {
    const text = doc({ accessionNumber: [FY.accession, UNRELATED.accession], form: ['10-K', '8-K'], filingDate: [FY.filingDate, UNRELATED.filingDate], reportDate: [FY.reportDate], acceptanceDateTime: ['2024-11-01T06:01:30.000Z', ''] });
    expect(codeOf(() => submissionsOf(parseSecJson(text), CIK))).toBe('SCHEMA_INVALID');
  });

  it('an acceptanceDateTime column of the wrong length is refused', () => {
    const text = doc({ accessionNumber: [FY.accession, UNRELATED.accession], form: ['10-K', '8-K'], filingDate: [FY.filingDate, UNRELATED.filingDate], reportDate: [FY.reportDate, ''], acceptanceDateTime: ['2024-11-01T06:01:30.000Z'] });
    expect(codeOf(() => submissionsOf(parseSecJson(text), CIK))).toBe('SCHEMA_INVALID');
  });

  it('an absent acceptanceDateTime column is lawful, as before', () => {
    const text = doc({ accessionNumber: [FY.accession], form: ['10-K'], filingDate: [FY.filingDate], reportDate: [FY.reportDate] });
    expect(submissionsOf(parseSecJson(text), CIK).filings.map((f) => f.accession)).toEqual([FY.accession]);
  });

  it('an accession column that is not a list is refused', () => {
    expect(codeOf(() => submissionsOf(parseSecJson(doc({ ...tenK(), accessionNumber: FY.accession })), CIK))).toBe('SCHEMA_INVALID');
  });

  it('the same accession on an unrelated row and a supported row is refused', () => {
    expect(codeOf(() => subs([{ ...UNRELATED, accession: FY.accession }, FY]))).toBe('SCHEMA_INVALID');
  });
});

describe('selection regression for the supported set (§9–§12, brief 10)', () => {
  it('Q4 is still refused on the live-shaped page', () => {
    expect(codeOf(() => selectFundamentals({ period: '2024-Q4', currency: 'USD', asOf: AS_OF }, subs(LIVE_SHAPED_ROWS), factsOf()))).toBe('REQUEST_INVALID');
  });

  it('amendments are still excluded on the live-shaped page: the FY value is the original 10-K value', () => {
    const selection = selectFundamentals({ period: '2024-FY', currency: 'USD', asOf: AS_OF }, subs(LIVE_SHAPED_ROWS), factsOf());
    expect(selection.candidate.revenue).toBe('391035000000');
    expect(selection.accession).toBe(FY.accession);
  });
});
