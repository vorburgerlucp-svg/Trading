import { describe, expect, it } from 'vitest';
import { parseSecJson } from '../../src/financial/sec-edgar-json.js';
import { companyFactsOf, selectFundamentals, submissionsOf } from '../../src/financial/sec-fact-selection.js';
import { ALL_FILINGS, AS_OF, annual, baseConcepts, companyFactsText, EIGHT_K, FILINGS, FUNDAMENTALS_REQUEST, liveShapedConcepts, quarter, secGateway, standardAnswers, submissionsText, unrelatedEightK, type Concepts } from './sec-fixtures.js';

// docs/SEC_EDGAR_FUNDAMENTALS_V1.md §8, §20. The real AAPL CompanyFacts carries mapped US-GAAP concepts reported in 8-K records. Those records have null fy
// and fp, and they are not V1 fundamentals sources. Only exact 10-Q and 10-K entries are materialized, and they stay strict. Unrelated forms are ignored
// after their form is safely classified, so their null fy or fp cannot block the document. No network: every document is a fixture.

const CIK = '0000320193';
const FY = FILINGS.fy2024;

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNEXPECTED';
  }
}

function factsOf(concepts: Concepts) {
  return companyFactsOf(parseSecJson(companyFactsText(concepts)), CIK);
}

/** One raw CompanyFacts document with one entry, so a test can write what the typed builder cannot: a missing field, or a JSON string where a number belongs. */
function rawDoc(concept: string, unit: string, entry: string): string {
  return '{"cik":320193,"facts":{"us-gaap":{' + JSON.stringify(concept) + ':{"units":{' + JSON.stringify(unit) + ':[' + entry + ']}}}}}';
}

const VALID_10K = '{"start":"2023-10-01","end":"2024-09-28","val":391035000000,"accn":"' + FY.accession + '","fy":2024,"fp":"FY","form":"10-K","filed":"2024-11-01"}';

describe('the observed shape: 8-K records with null fy and fp (brief 1, 10)', () => {
  it('SalesRevenueNet: an 8-K record with null fy and fp does not block the document', () => {
    expect(codeOf(() => factsOf({ SalesRevenueNet: { USD: [unrelatedEightK('391035000000', EIGHT_K), annual('391035000000')] } }))).toBeNull();
  });

  it('GrossProfit: the same shape does not block the document', () => {
    expect(codeOf(() => factsOf({ GrossProfit: { USD: [annual('180683000000'), unrelatedEightK('180683000000', EIGHT_K)] } }))).toBeNull();
  });

  it('EarningsPerShareDiluted: the same shape does not block the document', () => {
    expect(codeOf(() => factsOf({ EarningsPerShareDiluted: { 'USD/shares': [annual('6.08'), unrelatedEightK('6.08', EIGHT_K)] } }))).toBeNull();
  });

  it('the 8-K record is ignored, and the FY2024 10-K record is materialized', () => {
    const usd = factsOf({ SalesRevenueNet: { USD: [unrelatedEightK('391035000000', EIGHT_K), annual('391035000000')] } }).concepts.get('SalesRevenueNet')!.get('USD')!;
    expect(usd).toHaveLength(1);
    expect(usd[0]).toMatchObject({ accession: FY.accession, form: '10-K', fy: '2024', fp: 'FY', end: '2024-09-28' });
  });

  it('the live-shape page ingests, and its FY2024 selection equals the clean page', () => {
    expect(codeOf(() => factsOf(liveShapedConcepts()))).toBeNull();
    const subs = submissionsOf(parseSecJson(submissionsText(ALL_FILINGS)), CIK);
    const live = selectFundamentals({ period: '2024-FY', currency: 'USD', asOf: AS_OF }, subs, factsOf(liveShapedConcepts()));
    const clean = selectFundamentals({ period: '2024-FY', currency: 'USD', asOf: AS_OF }, subs, factsOf(baseConcepts()));
    expect(live).toEqual(clean);
  });

  it('the live-shape page selects the same Q3 record as the clean page', () => {
    const subs = submissionsOf(parseSecJson(submissionsText(ALL_FILINGS)), CIK);
    const live = selectFundamentals({ period: '2024-Q3', currency: 'USD', asOf: AS_OF }, subs, factsOf(liveShapedConcepts()));
    const clean = selectFundamentals({ period: '2024-Q3', currency: 'USD', asOf: AS_OF }, subs, factsOf(baseConcepts()));
    expect(live).toEqual(clean);
  });

  it('no fiscal year or period is inferred from the unrelated record: only the 10-K accession is materialized', () => {
    const grossProfit = factsOf(liveShapedConcepts()).concepts.get('GrossProfit')!.get('USD')!;
    expect(grossProfit.map((f) => f.accession)).toEqual([FY.accession]);
  });
});

describe('exact 10-Q and 10-K entries stay strict (brief 3)', () => {
  it('a 10-Q with null fy is refused', () => {
    expect(codeOf(() => factsOf({ GrossProfit: { USD: [{ ...quarter('1'), fy: null }] } }))).toBe('SCHEMA_INVALID');
  });

  it('a 10-K with null fy is refused', () => {
    expect(codeOf(() => factsOf({ GrossProfit: { USD: [{ ...annual('1'), fy: null }] } }))).toBe('SCHEMA_INVALID');
  });

  it('a 10-Q with null fp is refused', () => {
    expect(codeOf(() => factsOf({ GrossProfit: { USD: [{ ...quarter('1'), fp: null }] } }))).toBe('SCHEMA_INVALID');
  });

  it('a 10-K with null fp is refused', () => {
    expect(codeOf(() => factsOf({ GrossProfit: { USD: [{ ...annual('1'), fp: null }] } }))).toBe('SCHEMA_INVALID');
  });

  it('a 10-Q with a malformed accession is refused', () => {
    expect(codeOf(() => factsOf({ GrossProfit: { USD: [{ ...quarter('1'), accn: 'BAD' }] } }))).toBe('SCHEMA_INVALID');
  });

  it('a 10-K with a malformed filed date is refused', () => {
    expect(codeOf(() => factsOf({ GrossProfit: { USD: [{ ...annual('1'), filed: '11/01/2024' }] } }))).toBe('SCHEMA_INVALID');
  });

  it('a 10-Q with an invalid end date is refused', () => {
    expect(codeOf(() => factsOf({ GrossProfit: { USD: [{ ...quarter('1'), end: '2024-02-30' }] } }))).toBe('SCHEMA_INVALID');
  });

  it('a 10-K with a non-numeric val is refused', () => {
    expect(codeOf(() => companyFactsOf(parseSecJson(rawDoc('GrossProfit', 'USD', VALID_10K.replace('"val":391035000000', '"val":"391035000000"'))), CIK))).toBe('SCHEMA_INVALID');
  });

  it('a 10-K whose fy is a JSON string rather than a JSON integer is refused', () => {
    expect(codeOf(() => companyFactsOf(parseSecJson(rawDoc('GrossProfit', 'USD', VALID_10K.replace('"fy":2024', '"fy":"2024"'))), CIK))).toBe('SCHEMA_INVALID');
  });
});

describe('unrelated forms are ignored once their form is classified (brief 2, 4, 6)', () => {
  it('a 10-Q/A with null fy and fp does not block the document, and is not materialized', () => {
    const concepts: Concepts = { GrossProfit: { USD: [annual('180683000000'), { ...quarter('1'), form: '10-Q/A', fy: null, fp: null }] } };
    expect(factsOf(concepts).concepts.get('GrossProfit')!.get('USD')!.map((f) => f.form)).toEqual(['10-K']);
  });

  it('a 10-K/A with null fy and fp does not block the document, and is not materialized', () => {
    const concepts: Concepts = { GrossProfit: { USD: [annual('180683000000'), { ...annual('1'), form: '10-K/A', fy: null, fp: null }] } };
    expect(factsOf(concepts).concepts.get('GrossProfit')!.get('USD')!.map((f) => f.form)).toEqual(['10-K']);
  });

  it('10-KT and 10-K405 with null fy and fp are ignored', () => {
    const concepts: Concepts = {
      GrossProfit: { USD: [annual('180683000000'), { ...annual('1'), form: '10-KT', fy: null, fp: null }, { ...annual('1'), form: '10-K405', fy: null, fp: null }] },
    };
    expect(factsOf(concepts).concepts.get('GrossProfit')!.get('USD')!.map((f) => f.form)).toEqual(['10-K']);
  });

  it('an unrelated record is not validated beyond its classified form: a bad accession, date and val do not block it', () => {
    // The val is written as a JSON string literal, so the document is valid JSON and only the unrelated record is malformed.
    const concepts: Concepts = { GrossProfit: { USD: [annual('180683000000'), { end: '2024-02-30', val: '"x"', accn: 'BAD', fy: null, fp: null, form: '8-K', filed: 'nope' }] } };
    expect(codeOf(() => factsOf(concepts))).toBeNull();
  });
});

describe('a malformed form field fails closed (brief 5)', () => {
  const entryWithout = (field: string) => {
    const all: Record<string, string> = { end: '"2024-09-28"', val: '1', accn: '"' + FY.accession + '"', fy: '2024', fp: '"FY"', form: '"10-K"', filed: '"2024-11-01"' };
    delete all[field];
    return '{' + Object.entries(all).map(([k, v]) => '"' + k + '":' + v).join(',') + '}';
  };

  it('an entry with no form is refused', () => {
    expect(codeOf(() => companyFactsOf(parseSecJson(rawDoc('GrossProfit', 'USD', entryWithout('form'))), CIK))).toBe('SCHEMA_INVALID');
  });

  it('a non-string form is refused', () => {
    expect(codeOf(() => companyFactsOf(parseSecJson(rawDoc('GrossProfit', 'USD', VALID_10K.replace('"form":"10-K"', '"form":10')) ), CIK))).toBe('SCHEMA_INVALID');
  });

  it('a form with a control character is refused', () => {
    expect(codeOf(() => companyFactsOf(parseSecJson(rawDoc('GrossProfit', 'USD', VALID_10K.replace('"form":"10-K"', '"form":"10-K\\u0007"'))), CIK))).toBe('SCHEMA_INVALID');
  });

  it('an unreasonably long form is refused', () => {
    expect(codeOf(() => companyFactsOf(parseSecJson(rawDoc('GrossProfit', 'USD', VALID_10K.replace('"form":"10-K"', '"form":"' + 'X'.repeat(21) + '"'))), CIK))).toBe('SCHEMA_INVALID');
  });

  it('an empty form is refused', () => {
    expect(codeOf(() => companyFactsOf(parseSecJson(rawDoc('GrossProfit', 'USD', VALID_10K.replace('"form":"10-K"', '"form":""'))), CIK))).toBe('SCHEMA_INVALID');
  });

  it('an entry that is not an object is refused', () => {
    expect(codeOf(() => companyFactsOf(parseSecJson(rawDoc('GrossProfit', 'USD', '"not an entry"')), CIK))).toBe('SCHEMA_INVALID');
  });
});

describe('the document structure stays strict (brief 7)', () => {
  it('a units value that is not an object is refused', () => {
    expect(codeOf(() => companyFactsOf(parseSecJson('{"cik":320193,"facts":{"us-gaap":{"GrossProfit":{"units":[]}}}}'), CIK))).toBe('SCHEMA_INVALID');
  });

  it('a unit value that is not a list is refused', () => {
    expect(codeOf(() => companyFactsOf(parseSecJson('{"cik":320193,"facts":{"us-gaap":{"GrossProfit":{"units":{"USD":"x"}}}}}'), CIK))).toBe('SCHEMA_INVALID');
  });

  it('a mapped concept without a units object is refused', () => {
    expect(codeOf(() => companyFactsOf(parseSecJson('{"cik":320193,"facts":{"us-gaap":{"GrossProfit":{}}}}'), CIK))).toBe('SCHEMA_INVALID');
  });

  it('an unrelated concept with any shape is still ignored', () => {
    expect(codeOf(() => companyFactsOf(parseSecJson('{"cik":320193,"facts":{"us-gaap":{"Goodwill":"junk","GrossProfit":{"units":{"USD":[' + VALID_10K + ']}}}}}'), CIK))).toBeNull();
  });
});

describe('evidence identity under ignored records (brief 9)', () => {
  it('an ignored 8-K record leaves the canonical data and the evidence identity unchanged, and changes the raw hash', async () => {
    const clean = await (await secGateway(standardAnswers(ALL_FILINGS, baseConcepts()))).gateway.fetch(FUNDAMENTALS_REQUEST());
    const live = await (await secGateway(standardAnswers(ALL_FILINGS, liveShapedConcepts()))).gateway.fetch(FUNDAMENTALS_REQUEST());
    expect(live.data).toEqual(clean.data);
    expect(live.evidenceId).toBe(clean.evidenceId);
    // The raw hash binds the exact CompanyFacts bytes, and those carry the 8-K records, so it changes by design.
    expect(live.rawPayloadHash).not.toBe(clean.rawPayloadHash);
  });
});
