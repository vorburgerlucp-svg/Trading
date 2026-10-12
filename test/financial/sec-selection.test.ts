import { describe, expect, it } from 'vitest';
import { parseSecJson } from '../../src/financial/sec-edgar-json.js';
import { companyFactsOf, periodOf, selectFundamentals, submissionsOf } from '../../src/financial/sec-fact-selection.js';
import { ALL_FILINGS, AS_OF, annual, baseConcepts, companyFactsText, FILINGS, quarter, quarterInstant, reversedConcepts as reversed, submissionsText, yearEndInstant, type Concepts, type FilingRow } from './sec-fixtures.js';

// docs/SEC_EDGAR_FUNDAMENTALS_V1.md §8–§20, §27a. The selection rules over validated inputs: periods, duration windows, as-of, one accession, amendments,
// duplicates, currency units, the minimum record, concept mapping and the strict schema. No network: every input is a fixture.

const CIK = '0000320193';
const FY = FILINGS.fy2024;
const Q3 = FILINGS.q3fy2024;
const Q1 = FILINGS.q1fy2025;

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNEXPECTED';
  }
}

function load(rows: readonly FilingRow[] = ALL_FILINGS, concepts: Concepts = baseConcepts()) {
  return {
    submissions: submissionsOf(parseSecJson(submissionsText(rows)), CIK),
    facts: companyFactsOf(parseSecJson(companyFactsText(concepts)), CIK),
  };
}

interface Options {
  readonly asOf?: string;
  readonly currency?: string;
  readonly rows?: readonly FilingRow[];
  readonly concepts?: Concepts;
}

function select(period = '2024-FY', options: Options = {}) {
  const { submissions, facts } = load(options.rows, options.concepts);
  return selectFundamentals({ period, currency: options.currency ?? 'USD', asOf: options.asOf ?? AS_OF }, submissions, facts);
}

const FY2024 = {
  period: '2024-FY',
  currency: 'USD',
  revenue: '391035000000',
  grossProfit: '180683000000',
  operatingIncome: '123216000000',
  ebit: null,
  netIncome: '93736000000',
  eps: '6.08',
  cash: '29943000000',
  debt: null,
  equity: '56950000000',
  operatingCashFlow: '118254000000',
  capex: null,
  freeCashFlow: null,
};

describe('periods (§9)', () => {
  it('refuses Q4 by name, before any selection', () => {
    expect(codeOf(() => periodOf('2024-Q4'))).toBe('REQUEST_INVALID');
  });

  it('maps Q1 to Q3 to a 10-Q quarter and FY to a 10-K', () => {
    expect(periodOf('2024-Q2')).toMatchObject({ form: '10-Q', fp: 'Q2', fy: '2024' });
    expect(periodOf('2024-FY')).toMatchObject({ form: '10-K', fp: 'FY', fy: '2024' });
  });
});

describe('fiscal year 2024 from the 10-K (§8–§14)', () => {
  it('selects the annual values of the 10-K and nothing from the other filings, EUR, comparatives or year-to-date', () => {
    const result = select();
    expect(result.candidate).toEqual(FY2024);
    expect(result.accession).toBe(FY.accession);
  });

  it('every selected fact is from the one accession, with its exact source lexeme', () => {
    const { selectedFacts } = select();
    expect(selectedFacts.every((f) => f.accession === FY.accession)).toBe(true);
    expect(selectedFacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ concept: 'RevenueFromContractWithCustomerExcludingAssessedTax', unit: 'USD', start: '2023-10-01', end: '2024-09-28', lexeme: '391035000000' })]),
    );
    // A balance instant has no start.
    expect(selectedFacts).toEqual(expect.arrayContaining([expect.objectContaining({ concept: 'CashAndCashEquivalentsAtCarryingValue', start: null, end: '2024-09-28', lexeme: '29943000000' })]));
  });

  it('ebit, debt, capex and free cash flow stay null, even when an EBITDA concept is present', () => {
    const concepts = baseConcepts();
    concepts.EBITDA = { USD: [annual('150000000000')] };
    const result = select('2024-FY', { concepts });
    expect(result.candidate).toMatchObject({ ebit: null, debt: null, capex: null, freeCashFlow: null });
  });
});

describe('fiscal quarter 2024 Q3 from the 10-Q (§9, §10, §15)', () => {
  it('uses the quarter durations and the quarter instant, and never the nine-month or six-month values', () => {
    const result = select('2024-Q3');
    expect(result.candidate).toEqual({
      period: '2024-Q3',
      currency: 'USD',
      revenue: '85777000000',
      grossProfit: null,
      operatingIncome: null,
      ebit: null,
      netIncome: null,
      eps: '1.53',
      cash: '29000000000',
      debt: null,
      equity: '60000000000',
      operatingCashFlow: null,
      capex: null,
      freeCashFlow: null,
    });
    expect(result.accession).toBe(Q3.accession);
  });

  it('a directly filed 90-day quarter cash flow is used for Q1; a year-to-date value is never used', () => {
    const concepts: Concepts = {
      RevenueFromContractWithCustomerExcludingAssessedTax: { USD: [{ start: '2024-09-29', end: '2024-12-28', val: '90000000000', accn: Q1.accession, fy: 2025, fp: 'Q1', form: '10-Q', filed: Q1.filingDate }] },
      NetCashProvidedByUsedInOperatingActivities: { USD: [{ start: '2024-09-29', end: '2024-12-28', val: '31000000000', accn: Q1.accession, fy: 2025, fp: 'Q1', form: '10-Q', filed: Q1.filingDate }] },
      CashAndCashEquivalentsAtCarryingValue: { USD: [{ end: '2024-12-28', val: '25000000000', accn: Q1.accession, fy: 2025, fp: 'Q1', form: '10-Q', filed: Q1.filingDate }] },
      StockholdersEquity: { USD: [{ end: '2024-12-28', val: '55000000000', accn: Q1.accession, fy: 2025, fp: 'Q1', form: '10-Q', filed: Q1.filingDate }] },
    };
    expect(select('2025-Q1', { concepts }).candidate).toMatchObject({ operatingCashFlow: '31000000000', revenue: '90000000000' });
  });

  it('a duration outside the quarter window is not a quarter, even if it is the only revenue fact', () => {
    const concepts = baseConcepts();
    concepts.RevenueFromContractWithCustomerExcludingAssessedTax = {
      USD: [{ start: '2024-06-01', end: '2024-06-29', val: '1000', accn: Q3.accession, fy: 2024, fp: 'Q3', form: '10-Q', filed: Q3.filingDate }],
    };
    expect(select('2024-Q3', { concepts }).candidate.revenue).toBeNull();
  });
});

describe('as-of and look-ahead (§12, §22)', () => {
  it('a filing on the as-of day is excluded, because its acceptance time is not used', () => {
    expect(codeOf(() => select('2024-FY', { asOf: '2024-11-01T00:00:00.000Z' }))).toBe('PROVIDER_DATA_ABSENT');
    expect(codeOf(() => select('2024-FY', { asOf: '2024-10-31T23:59:59.999Z' }))).toBe('PROVIDER_DATA_ABSENT');
  });

  it('a filing is usable from the day after its filing date', () => {
    expect(select('2024-FY', { asOf: '2024-11-02T00:00:00.000Z' }).candidate.revenue).toBe('391035000000');
  });

  it('a filing after the as-of date is never selected, even when it is the only record for the period, and is selected once it is usable', () => {
    const concepts: Concepts = {
      RevenueFromContractWithCustomerExcludingAssessedTax: { USD: [{ start: '2024-09-29', end: '2025-09-27', val: '400000000000', accn: FILINGS.future.accession, fy: 2025, fp: 'FY', form: '10-K', filed: FILINGS.future.filingDate }] },
      GrossProfit: { USD: [{ start: '2024-09-29', end: '2025-09-27', val: '1', accn: FILINGS.future.accession, fy: 2025, fp: 'FY', form: '10-K', filed: FILINGS.future.filingDate }] },
      CashAndCashEquivalentsAtCarryingValue: { USD: [{ end: '2025-09-27', val: '30000000000', accn: FILINGS.future.accession, fy: 2025, fp: 'FY', form: '10-K', filed: FILINGS.future.filingDate }] },
      StockholdersEquity: { USD: [{ end: '2025-09-27', val: '60000000000', accn: FILINGS.future.accession, fy: 2025, fp: 'FY', form: '10-K', filed: FILINGS.future.filingDate }] },
    };
    expect(codeOf(() => select('2025-FY', { concepts, asOf: '2026-06-01T10:00:00.000Z' }))).toBe('PROVIDER_DATA_ABSENT');
    expect(select('2025-FY', { concepts, asOf: '2026-11-02T00:00:00.000Z' }).candidate.revenue).toBe('400000000000');
  });
});

describe('one accession and fact coherence (§8, §11, §19)', () => {
  it('two original 10-K filings for the same period fail closed, even with identical values', () => {
    const rows = [...ALL_FILINGS, { accession: '0000320193-24-000099', form: '10-K', filingDate: '2024-11-02', reportDate: '2024-09-28' }];
    const concepts = baseConcepts();
    concepts.RevenueFromContractWithCustomerExcludingAssessedTax = { USD: [annual('391035000000'), annual('391035000000', '0000320193-24-000099', '2024-11-02')] };
    expect(codeOf(() => select('2024-FY', { rows, concepts }))).toBe('PROVIDER_DATA_INCOHERENT');
  });

  it('facts from two filings are incoherent even when each field has exactly one candidate', () => {
    const rows = [...ALL_FILINGS, { accession: '0000320193-24-000099', form: '10-K', filingDate: '2024-11-02', reportDate: '2024-09-28' }];
    const concepts = baseConcepts();
    concepts.CashAndCashEquivalentsAtCarryingValue = { USD: [{ end: '2024-09-28', val: '29943000000', accn: '0000320193-24-000099', fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-02' }] };
    expect(codeOf(() => select('2024-FY', { rows, concepts }))).toBe('PROVIDER_DATA_INCOHERENT');
  });

  it('a fact whose accession is not a filing of this company is not selected and does not break coherence', () => {
    const concepts = baseConcepts();
    concepts.RevenueFromContractWithCustomerExcludingAssessedTax = { USD: [annual('391035000000'), annual('1', '0000999999-24-000001')] };
    expect(select('2024-FY', { concepts }).candidate.revenue).toBe('391035000000');
  });

  it('a fact with the wrong form for its accession is not selected', () => {
    const concepts = baseConcepts();
    concepts.GrossProfit = { USD: [{ ...annual('180683000000'), form: '10-Q' }] };
    expect(select('2024-FY', { concepts }).candidate.grossProfit).toBeNull();
  });

  it('a fact whose end is not the filing report date is not selected', () => {
    const concepts = baseConcepts();
    concepts.OperatingIncomeLoss = { USD: [{ ...annual('123216000000'), end: '2024-09-27' }] };
    expect(select('2024-FY', { concepts }).candidate.operatingIncome).toBeNull();
  });

  it('a filed date that disagrees with the submissions filing date is incoherent', () => {
    const concepts = baseConcepts();
    concepts.OperatingIncomeLoss = { USD: [annual('123216000000', FY.accession, '2024-11-05')] };
    expect(codeOf(() => select('2024-FY', { concepts }))).toBe('PROVIDER_DATA_INCOHERENT');
  });
});

describe('amendments (§11)', () => {
  it('a 10-K/A fact never adds or overwrites a value', () => {
    const concepts = baseConcepts();
    concepts.RevenueFromContractWithCustomerExcludingAssessedTax = {
      USD: [
        annual('391035000000'),
        { start: '2023-10-01', end: '2024-09-28', val: '1', accn: FILINGS.amendment.accession, fy: 2024, fp: 'FY', form: '10-K/A', filed: FILINGS.amendment.filingDate },
      ],
    };
    const result = select('2024-FY', { concepts });
    expect(result.candidate.revenue).toBe('391035000000');
    expect(result.accession).toBe(FY.accession);
  });

  it('an amendment alone is not a source, so the result is absent', () => {
    const amend = (val: string) => ({ start: '2023-10-01', end: '2024-09-28', val, accn: FILINGS.amendment.accession, fy: 2024, fp: 'FY', form: '10-K/A', filed: FILINGS.amendment.filingDate });
    const concepts: Concepts = {
      RevenueFromContractWithCustomerExcludingAssessedTax: { USD: [amend('1')] },
      CashAndCashEquivalentsAtCarryingValue: { USD: [{ end: '2024-09-28', val: '1', accn: FILINGS.amendment.accession, fy: 2024, fp: 'FY', form: '10-K/A', filed: FILINGS.amendment.filingDate }] },
    };
    expect(codeOf(() => select('2024-FY', { concepts }))).toBe('PROVIDER_DATA_ABSENT');
  });
});

describe('duplicates and conflicts (§19)', () => {
  it('an identical duplicate is deduplicated', () => {
    const concepts = baseConcepts();
    concepts.RevenueFromContractWithCustomerExcludingAssessedTax = { USD: [annual('391035000000'), annual('391035000000')] };
    expect(select('2024-FY', { concepts }).candidate.revenue).toBe('391035000000');
  });

  it('a duplicate with a different value fails closed', () => {
    const concepts = baseConcepts();
    concepts.RevenueFromContractWithCustomerExcludingAssessedTax = { USD: [annual('391035000000'), annual('391035000001')] };
    expect(codeOf(() => select('2024-FY', { concepts }))).toBe('PROVIDER_DATA_INCOHERENT');
  });

  it('two candidates for one field with different starts inside the window fail closed', () => {
    const concepts = baseConcepts();
    concepts.RevenueFromContractWithCustomerExcludingAssessedTax = { USD: [annual('391035000000'), { ...annual('391035000000'), start: '2023-10-03' }] };
    expect(codeOf(() => select('2024-FY', { concepts }))).toBe('PROVIDER_DATA_INCOHERENT');
  });
});

describe('order invariance (§19)', () => {
  it('reversing the submissions rows, the units and the entries gives the identical selection', () => {
    const original = select('2024-FY');
    const shuffled = select('2024-FY', { rows: [...ALL_FILINGS].reverse(), concepts: reversed(baseConcepts()) });
    expect(shuffled).toEqual(original);
  });
});

describe('null versus zero (§17)', () => {
  it('a filed zero is the string "0", not null', () => {
    const concepts = baseConcepts();
    concepts.GrossProfit = { USD: [annual('0')] };
    expect(select('2024-FY', { concepts }).candidate.grossProfit).toBe('0');
  });

  it('a missing concept is null, never zero', () => {
    const concepts = baseConcepts();
    delete concepts.OperatingIncomeLoss;
    expect(select('2024-FY', { concepts }).candidate.operatingIncome).toBeNull();
  });
});

describe('currency units (§16)', () => {
  it('a EUR request selects only EUR units, and no USD value is ever relabelled', () => {
    const concepts = baseConcepts();
    concepts.CashAndCashEquivalentsAtCarryingValue = { ...concepts.CashAndCashEquivalentsAtCarryingValue, EUR: [yearEndInstant('300000000000')] };
    const result = select('2024-FY', { currency: 'EUR', concepts });
    expect(result.candidate).toEqual({
      period: '2024-FY',
      currency: 'EUR',
      revenue: '350000000000',
      grossProfit: null,
      operatingIncome: null,
      ebit: null,
      netIncome: null,
      eps: null,
      cash: '300000000000',
      debt: null,
      equity: null,
      operatingCashFlow: null,
      capex: null,
      freeCashFlow: null,
    });
    const text = JSON.stringify(result.candidate);
    expect(text).not.toContain('391035000000');
    expect(text).not.toContain('29943000000');
  });

  it('a EUR request with no EUR balance value is absent, not filled from USD', () => {
    expect(codeOf(() => select('2024-FY', { currency: 'EUR' }))).toBe('PROVIDER_DATA_ABSENT');
  });
});

describe('minimum useful record (§18)', () => {
  it('income without any balance value is absent', () => {
    const concepts: Concepts = { RevenueFromContractWithCustomerExcludingAssessedTax: { USD: [annual('391035000000')] } };
    expect(codeOf(() => select('2024-FY', { concepts }))).toBe('PROVIDER_DATA_ABSENT');
  });

  it('a balance value without any income value is absent', () => {
    const concepts: Concepts = { CashAndCashEquivalentsAtCarryingValue: { USD: [yearEndInstant('29943000000')] } };
    expect(codeOf(() => select('2024-FY', { concepts }))).toBe('PROVIDER_DATA_ABSENT');
  });
});

describe('concept mapping (§14)', () => {
  it('revenue takes the first concept in priority, never a sum', () => {
    const concepts = baseConcepts();
    concepts.Revenues = { USD: [annual('999')] };
    expect(select('2024-FY', { concepts }).candidate.revenue).toBe('391035000000');
  });

  it('revenue falls back to Revenues, then to SalesRevenueNet', () => {
    const concepts = baseConcepts();
    delete concepts.RevenueFromContractWithCustomerExcludingAssessedTax;
    concepts.Revenues = { USD: [annual('500000000000')] };
    expect(select('2024-FY', { concepts }).candidate.revenue).toBe('500000000000');
    delete concepts.Revenues;
    concepts.SalesRevenueNet = { USD: [annual('600000000000')] };
    expect(select('2024-FY', { concepts }).candidate.revenue).toBe('600000000000');
  });

  it('equity is not substituted by the non-controlling-interest concept', () => {
    const concepts = baseConcepts();
    delete concepts.StockholdersEquity;
    concepts.StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest = { USD: [yearEndInstant('70000000000')] };
    const candidate = select('2024-FY', { concepts }).candidate;
    expect(candidate.equity).toBeNull();
    expect(candidate.cash).toBe('29943000000');
  });

  it('basic EPS is never a fallback for diluted EPS', () => {
    const concepts = baseConcepts();
    delete concepts.EarningsPerShareDiluted;
    concepts.EarningsPerShareBasic = { 'USD/shares': [annual('6.12')] };
    expect(select('2024-FY', { concepts }).candidate.eps).toBeNull();
  });

  it('a company with no us-gaap facts is absent, even when it reports under ifrs-full', () => {
    const facts = companyFactsOf(parseSecJson(companyFactsText(baseConcepts(), { taxonomy: 'ifrs-full' })), CIK);
    const submissions = submissionsOf(parseSecJson(submissionsText(ALL_FILINGS)), CIK);
    expect(codeOf(() => selectFundamentals({ period: '2024-FY', currency: 'USD', asOf: AS_OF }, submissions, facts))).toBe('PROVIDER_DATA_ABSENT');
  });

  it('an unmapped concept with a malformed shape never breaks ingestion', () => {
    const concepts = baseConcepts();
    concepts.Goodwill = { USD: 'not a list' } as unknown as Concepts[string];
    expect(select('2024-FY', { concepts }).candidate.revenue).toBe('391035000000');
  });
});

describe('strict schema of the mapped facts (§20)', () => {
  const rawFacts = (entry: string) => '{"cik":320193,"facts":{"us-gaap":{"GrossProfit":{"units":{"USD":[' + entry + ']}},"CashAndCashEquivalentsAtCarryingValue":{"units":{"USD":[{"end":"2024-09-28","val":1,"accn":"' + FY.accession + '","fy":2024,"fp":"FY","form":"10-K","filed":"2024-11-01"}]}}}}}';

  it('a mapped entry without an accession is refused', () => {
    const facts = () => companyFactsOf(parseSecJson(rawFacts('{"start":"2023-10-01","end":"2024-09-28","val":180683000000,"fy":2024,"fp":"FY","form":"10-K","filed":"2024-11-01"}')), CIK);
    expect(codeOf(facts)).toBe('SCHEMA_INVALID');
  });

  it('a value given as a JSON string is refused, because a value must be a JSON number', () => {
    const facts = () => companyFactsOf(parseSecJson(rawFacts('{"start":"2023-10-01","end":"2024-09-28","val":"180683000000","accn":"' + FY.accession + '","fy":2024,"fp":"FY","form":"10-K","filed":"2024-11-01"}')), CIK);
    expect(codeOf(facts)).toBe('SCHEMA_INVALID');
  });

  it('an impossible calendar date is refused', () => {
    const facts = () => companyFactsOf(parseSecJson(rawFacts('{"start":"2023-10-01","end":"2024-02-30","val":180683000000,"accn":"' + FY.accession + '","fy":2024,"fp":"FY","form":"10-K","filed":"2024-11-01"}')), CIK);
    expect(codeOf(facts)).toBe('SCHEMA_INVALID');
  });
});

describe('submissions and CIK (§1, §8)', () => {
  const sub = (text: string) => () => submissionsOf(parseSecJson(text), CIK);

  it('columns of unequal length are refused', () => {
    const text = '{"cik":"0000320193","filings":{"recent":{"accessionNumber":["' + FY.accession + '","' + Q3.accession + '"],"form":["10-K"],"filingDate":["2024-11-01"],"reportDate":["2024-09-28"]}}}';
    expect(codeOf(sub(text))).toBe('SCHEMA_INVALID');
  });

  it('a malformed accession is refused', () => {
    expect(codeOf(sub(submissionsText([{ ...FY, accession: 'BAD' }])))).toBe('SCHEMA_INVALID');
  });

  it('an impossible filing date is refused', () => {
    expect(codeOf(sub(submissionsText([{ ...FY, filingDate: '2024-02-30' }])))).toBe('SCHEMA_INVALID');
  });

  it('a duplicate accession is refused', () => {
    expect(codeOf(sub(submissionsText([FY, FY])))).toBe('SCHEMA_INVALID');
  });

  it('a submissions document for another company is incoherent with the mapping', () => {
    expect(codeOf(sub(submissionsText(ALL_FILINGS, '0000320194')))).toBe('PROVIDER_DATA_INCOHERENT');
  });

  it('a companyfacts document for another company is incoherent with the mapping', () => {
    expect(codeOf(() => companyFactsOf(parseSecJson(companyFactsText(baseConcepts(), { cik: '320194' })), CIK))).toBe('PROVIDER_DATA_INCOHERENT');
  });

  it('a companyfacts cik that is not an integer lexeme is refused', () => {
    expect(codeOf(() => companyFactsOf(parseSecJson(companyFactsText(baseConcepts(), { cik: '320193.0' })), CIK))).toBe('SCHEMA_INVALID');
  });

  it('the quarter-instant and annual helpers stay consistent with the filings they describe', () => {
    expect(quarterInstant('1').end).toBe(Q3.reportDate);
    expect(quarter('1').accn).toBe(Q3.accession);
    expect(annual('1').end).toBe(FY.reportDate);
  });
});
