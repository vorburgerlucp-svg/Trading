// Small, sanitised SEC EDGAR public-data fixtures (docs/SEC_EDGAR_FUNDAMENTALS_V1.md §27b). They keep the structure of the submissions and companyfacts
// responses, with the facts the tests need. Number lexemes are written as text, so the tests control the exact source precision. No network.

import { FinancialConnectorRegistry } from '../../src/financial/financial-registry.js';
import { FinancialDataGateway } from '../../src/financial/financial-gateway.js';
import { SEC_CONNECTOR_ID, SEC_PROVIDER, SecEdgarFundamentalsConnector } from '../../src/financial/sec-edgar-fundamentals.js';
import { InstrumentRegistry, type InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import { ResilientCaller, type FetchLike, type ResiliencePolicy } from '../../src/market-data/providers/resilience.js';
import { InMemoryAppendOnlyStore } from '../../src/persistence/append-only-log.js';
import { AAPL } from '../market-data/fixtures.js';
import { sequentialIds } from '../helpers.js';
import { AAPL_ID, change, RESEARCH_ONLY } from './fixtures.js';

export const CIK = '0000320193';
export const SUBMISSIONS_URL = 'https://data.sec.gov/submissions/CIK0000320193.json';
export const COMPANYFACTS_URL = 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json';
/** A fake, obviously test-only User-Agent. It is injected directly, never read from the environment, and never used for live traffic. */
export const TEST_USER_AGENT = 'NEXUS fixture test@example.test';
export const AS_OF = '2026-06-01T10:00:00.000Z';
export const CLOCK_ISO = '2026-06-01T10:00:00.000Z';
export const clock = () => new Date(CLOCK_ISO);

export interface FilingRow {
  readonly accession: string;
  readonly form: string;
  readonly filingDate: string;
  /** Empty for a form that has no reporting period (for example an 8-K or a registration form). */
  readonly reportDate: string;
  /** The real SEC column is present on every row, and it may be empty. Defaults to a full timestamp. */
  readonly acceptanceDateTime?: string;
}

/** The submissions document: `filings.recent` as parallel columns. Rows may be permuted by the caller to test order independence. */
export function submissionsText(rows: readonly FilingRow[], cik = CIK): string {
  const column = (pick: (r: FilingRow) => string) => '[' + rows.map((r) => JSON.stringify(pick(r))).join(',') + ']';
  return (
    '{"cik":' + JSON.stringify(cik) + ',"name":"Fixture Co",' +
    '"filings":{"recent":{' +
    '"accessionNumber":' + column((r) => r.accession) + ',' +
    '"form":' + column((r) => r.form) + ',' +
    '"filingDate":' + column((r) => r.filingDate) + ',' +
    '"reportDate":' + column((r) => r.reportDate) + ',' +
    '"acceptanceDateTime":' + column((r) => r.acceptanceDateTime ?? '2024-11-01T06:01:30.000Z') +
    '}}}'
  );
}

/**
 * A sanitised, live-shaped submissions page: supported 10-Q and 10-K rows mixed with many unrelated forms whose reportDate and acceptanceDateTime are
 * empty. The shape is what the real SEC document showed (docs/SEC_EDGAR_FUNDAMENTALS_V1.md §8). It is not the live response, which is never committed.
 */
export const UNRELATED_BLANK: Omit<FilingRow, 'accession'>[] = [
  { form: '8-K', filingDate: '2024-10-30', reportDate: '', acceptanceDateTime: '2024-10-30T17:05:12.000Z' },
  { form: '4', filingDate: '2024-10-29', reportDate: '', acceptanceDateTime: '2024-10-29T16:01:44.000Z' },
  { form: '424B5', filingDate: '2024-10-28', reportDate: '', acceptanceDateTime: '2024-10-28T12:30:00.000Z' },
  { form: 'S-8', filingDate: '2024-10-25', reportDate: '', acceptanceDateTime: '2024-10-25T20:15:09.000Z' },
  { form: 'DEF 14A', filingDate: '2024-10-20', reportDate: '', acceptanceDateTime: '' },
  { form: '144', filingDate: '2024-10-18', reportDate: '', acceptanceDateTime: '' },
  { form: 'SD', filingDate: '2024-10-15', reportDate: '', acceptanceDateTime: '' },
];


export interface FactEntry {
  readonly start?: string;
  readonly end: string;
  /** The exact JSON number text, for example "391035000000" or "6.08". */
  readonly val: string;
  readonly accn: string;
  /** null is what SEC reports for an unrelated form such as an 8-K (docs/SEC_EDGAR_FUNDAMENTALS_V1.md §8). */
  readonly fy: number | null;
  readonly fp: string | null;
  readonly form: string;
  readonly filed: string;
}

const entryText = (e: FactEntry): string =>
  '{' +
  (e.start !== undefined ? '"start":' + JSON.stringify(e.start) + ',' : '') +
  '"end":' + JSON.stringify(e.end) + ',' +
  '"val":' + e.val + ',' +
  '"accn":' + JSON.stringify(e.accn) + ',' +
  '"fy":' + String(e.fy) + ',' +
  '"fp":' + JSON.stringify(e.fp) + ',' +
  '"form":' + JSON.stringify(e.form) + ',' +
  '"filed":' + JSON.stringify(e.filed) +
  '}';

export type Concepts = Record<string, Record<string, readonly FactEntry[] | unknown>>;

/** concepts: concept name → unit → entries. Entries keep the order given, so the caller can permute them. */
export function companyFactsText(concepts: Concepts, options: { cik?: string; taxonomy?: string } = {}): string {
  const taxonomy = options.taxonomy ?? 'us-gaap';
  const body = Object.entries(concepts)
    .map(([name, units]) => JSON.stringify(name) + ':{"label":"x","units":{' + Object.entries(units).map(([unit, entries]) => JSON.stringify(unit) + ':' + (Array.isArray(entries) ? '[' + entries.map((e) => entryText(e as FactEntry)).join(',') + ']' : JSON.stringify(entries))).join(',') + '}}')
    .join(',');
  return '{"cik":' + (options.cik ?? '320193') + ',"entityName":"Fixture Co","facts":{' + JSON.stringify(taxonomy) + ':{' + body + '}}}';
}

export const FILINGS = {
  fy2024: { accession: '0000320193-24-000081', form: '10-K', filingDate: '2024-11-01', reportDate: '2024-09-28' },
  q3fy2024: { accession: '0000320193-24-000069', form: '10-Q', filingDate: '2024-08-02', reportDate: '2024-06-29' },
  q1fy2025: { accession: '0000320193-25-000010', form: '10-Q', filingDate: '2025-02-01', reportDate: '2024-12-28' },
  amendment: { accession: '0000320193-24-000090', form: '10-K/A', filingDate: '2024-12-15', reportDate: '2024-09-28' },
  future: { accession: '0000320193-26-000001', form: '10-K', filingDate: '2026-11-01', reportDate: '2025-09-27' },
} as const;

export const ALL_FILINGS: readonly FilingRow[] = Object.values(FILINGS);

/** Supported filings mixed with the unrelated blank rows, in an order that is not the filing order. */
export const LIVE_SHAPED_ROWS: readonly FilingRow[] = [
  FILINGS.future,
  ...UNRELATED_BLANK.map((row, i) => ({ ...row, accession: '0000320193-24-000' + String(110 + i) })),
  FILINGS.fy2024,
  ...UNRELATED_BLANK.map((row, i) => ({ ...row, accession: '0000320193-24-000' + String(130 + i) })),
  FILINGS.q3fy2024,
  FILINGS.amendment,
  FILINGS.q1fy2025,
];

// Fact builders. Each one is a fact as the companyfacts endpoint reports it for the named filing.
const FY = FILINGS.fy2024;
const Q3 = FILINGS.q3fy2024;
/** A 363-day annual duration ending on the 10-K report date. */
export const annual = (val: string, accn: string = FY.accession, filed: string = FY.filingDate): FactEntry => ({ start: '2023-10-01', end: '2024-09-28', val, accn, fy: 2024, fp: 'FY', form: '10-K', filed });
/** A balance instant at the 10-K report date. */
export const yearEndInstant = (val: string): FactEntry => ({ end: '2024-09-28', val, accn: FY.accession, fy: 2024, fp: 'FY', form: '10-K', filed: FY.filingDate });
/** A 89-day quarter duration ending on the 10-Q report date. */
export const quarter = (val: string): FactEntry => ({ start: '2024-04-01', end: '2024-06-29', val, accn: Q3.accession, fy: 2024, fp: 'Q3', form: '10-Q', filed: Q3.filingDate });
/** A six-month year-to-date duration. It is outside the quarter window and must never be used as a quarter. */
export const sixMonths = (val: string): FactEntry => ({ start: '2023-12-31', end: '2024-06-29', val, accn: Q3.accession, fy: 2024, fp: 'Q3', form: '10-Q', filed: Q3.filingDate });
/** A balance instant at the 10-Q report date. */
export const quarterInstant = (val: string): FactEntry => ({ end: '2024-06-29', val, accn: Q3.accession, fy: 2024, fp: 'Q3', form: '10-Q', filed: Q3.filingDate });

/** A fixture with every mapped concept, the trap facts (EUR, prior-year, year-to-date, and an amendment-free set), and an unmapped concept. */
export function baseConcepts(): Concepts {
  return {
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [
        annual('391035000000'),
        // A prior-year comparative: its end date is not the report date, so it must never be selected.
        { start: '2022-09-25', end: '2023-09-30', val: '383285000000', accn: FY.accession, fy: 2024, fp: 'FY', form: '10-K', filed: FY.filingDate },
        quarter('85777000000'),
        sixMonths('167349000000'),
      ],
      EUR: [annual('350000000000')],
    },
    GrossProfit: { USD: [annual('180683000000')] },
    OperatingIncomeLoss: { USD: [annual('123216000000')] },
    NetIncomeLoss: { USD: [annual('93736000000')] },
    EarningsPerShareDiluted: { 'USD/shares': [annual('6.08'), quarter('1.53')] },
    NetCashProvidedByUsedInOperatingActivities: { USD: [annual('118254000000'), sixMonths('40000000000')] },
    CashAndCashEquivalentsAtCarryingValue: { USD: [yearEndInstant('29943000000'), quarterInstant('29000000000')] },
    StockholdersEquity: { USD: [yearEndInstant('56950000000'), quarterInstant('60000000000')] },
    AccountsPayableCurrent: { USD: [yearEndInstant('1')] },
  };
}

/** An 8-K record of a mapped concept, as the live CompanyFacts shows it: its fiscal year and fiscal period are null. It is not a V1 source. */
export const unrelatedEightK = (val: string, accn: string, filed = '2024-10-31', end = '2024-09-28'): FactEntry => ({ end, val, accn, fy: null, fp: null, form: '8-K', filed });

/** An 8-K accession that is not in the submissions fixture. Its records must be ignored, so the accession never matters. */
export const EIGHT_K = '0000320193-24-000095';

/**
 * The observed Apple condition, sanitised: several mapped concepts each carry an 8-K record with null fy and fp beside the valid 10-K facts. The 10-K
 * facts and every other value are the same as baseConcepts(), so only the unrelated records differ.
 */
export function liveShapedConcepts(): Concepts {
  return {
    ...baseConcepts(),
    SalesRevenueNet: { USD: [unrelatedEightK('391035000000', EIGHT_K), annual('391035000000')] },
    GrossProfit: { USD: [annual('180683000000'), unrelatedEightK('180683000000', EIGHT_K)] },
    EarningsPerShareDiluted: { 'USD/shares': [annual('6.08'), quarter('1.53'), unrelatedEightK('6.08', EIGHT_K)] },
  };
}

/** The mapping for the fixture company: the NEXUS identity maps to the SEC CIK, the provider-native identifier. `null` registers no mapping. */
export async function secInstruments(providerSymbol: string | null = CIK): Promise<InstrumentRegistry> {
  const registry = await InstrumentRegistry.open(new InMemoryAppendOnlyStore<InstrumentEvent>(), { newId: sequentialIds('i-') });
  await registry.register({ ...AAPL }, change());
  if (providerSymbol !== null) {
    await registry.addMapping({ instrumentId: AAPL_ID, provider: SEC_PROVIDER, providerSymbol, validFrom: '1980-12-12T00:00:00Z' }, change());
  }
  return registry;
}

/** The same facts with every key, every unit and every entry in reverse order. The selection must not depend on it. */
export function reversedConcepts(concepts: Concepts): Concepts {
  return Object.fromEntries(
    Object.entries(concepts)
      .reverse()
      .map(([name, units]) => [name, Object.fromEntries(Object.entries(units).reverse().map(([unit, entries]) => [unit, Array.isArray(entries) ? [...entries].reverse() : entries]))]),
  );
}

export async function secRegistry(): Promise<FinancialConnectorRegistry> {
  const registry = await FinancialConnectorRegistry.open();
  await registry.register({ connectorId: SEC_CONNECTOR_ID, provider: SEC_PROVIDER, transport: 'rest', capabilities: ['fundamentals'], license: RESEARCH_ONLY, mode: 'RESEARCH' }, change());
  await registry.enable(SEC_CONNECTOR_ID, change());
  return registry;
}

export const FUNDAMENTALS_REQUEST = (period = '2024-FY', asOf = AS_OF, currency = 'USD', requestId = 'r-sec') => ({
  requestId,
  capability: 'fundamentals',
  connectorId: SEC_CONNECTOR_ID,
  asOf,
  environment: 'research',
  instrumentId: AAPL_ID,
  currency,
  period,
});

/** One scripted HTTP answer. The fake client answers in order and repeats the last answer when the script runs out. */
export interface SecAnswer {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly url?: string;
  readonly text?: () => Promise<string>;
}

export const json200 = (body: string): SecAnswer => ({ status: 200, body });

export function secHttp(answers: readonly SecAnswer[]): { fetch: FetchLike; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let next = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } });
    const answer = answers[Math.min(next, answers.length - 1)]!;
    next++;
    return {
      status: answer.status,
      url: answer.url,
      headers: { get: (name: string) => (answer.headers ?? {})[name.toLowerCase()] ?? null },
      text: answer.text ?? (async () => answer.body ?? ''),
    };
  };
  return { fetch, calls };
}

/** Submissions, then companyfacts: the two answers one successful fundamentals fetch needs, in the order the connector asks for them. */
export function standardAnswers(rows: readonly FilingRow[] = ALL_FILINGS, concepts: Concepts = baseConcepts()): SecAnswer[] {
  return [json200(submissionsText(rows)), json200(companyFactsText(concepts))];
}

const noSleep = { now: () => 0, sleep: async () => undefined, random: () => 0.5 };

/** A caller with the production pacing (125 ms) and no real waiting. */
export function secCaller(overrides: Partial<ResiliencePolicy> = {}): ResilientCaller {
  return new ResilientCaller(SEC_PROVIDER, { timeoutMs: 1000, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, rateLimitFallbackMs: 1, minIntervalMs: 125, ...overrides }, noSleep);
}

/** The gateway with the SEC connector, a scripted HTTP client and the fixture mapping. Pass `userAgent: undefined` to test the not-connected path. */
export async function secGateway(
  answers: readonly SecAnswer[],
  options: { userAgent?: string | undefined; caller?: ResilientCaller; instruments?: InstrumentRegistry; fetch?: FetchLike } = {},
) {
  const http = secHttp(answers);
  const connector = new SecEdgarFundamentalsConnector({
    userAgent: 'userAgent' in options ? options.userAgent : TEST_USER_AGENT,
    fetch: options.fetch ?? http.fetch,
    caller: options.caller ?? secCaller(),
    clock,
  });
  const gateway = new FinancialDataGateway({ registry: await secRegistry(), instruments: options.instruments ?? (await secInstruments()), connectors: [connector], clock });
  return { gateway, connector, http };
}
