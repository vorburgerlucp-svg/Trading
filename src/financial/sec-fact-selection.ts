// Validation and selection of SEC EDGAR fundamentals (sec-fact-selection:v1, sec-usgaap-fundamentals-map:v1; docs/SEC_EDGAR_FUNDAMENTALS_V1.md §8–§20, §27a).
// Pure: it takes parsed documents and makes no call. An error names the rule and never the response. Only US-GAAP is read. Unmapped concepts are not read at
// all, so one unrelated fact can never break ingestion.

import { FinancialGatewayError } from './financial-types.js';
import { isSecNumber, type SecNumber, type SecValue } from './sec-edgar-json.js';

export const SEC_FACT_SELECTION_VERSION = 'sec-fact-selection:v1';
export const SEC_CONCEPT_MAP_VERSION = 'sec-usgaap-fundamentals-map:v1';

const TAXONOMY = 'us-gaap';
const CIK = /^\d{10}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_ACCEPTANCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
/** The only forms that can source V1 fundamentals. An amendment, a registration statement or any other form is not in this set (§8, §11). */
const SOURCE_FORMS: ReadonlySet<string> = new Set(['10-Q', '10-K']);
const PERIOD = /^(\d{4})-(Q[1-4]|FY)$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const DAY_MS = 86_400_000;

type Fiscal = 'Q1' | 'Q2' | 'Q3' | 'FY';

export interface PeriodRef {
  readonly fy: string;
  readonly fp: Fiscal;
  /** The only form that can source the period: 10-Q for a quarter, 10-K for the year. Amendments are never a source. */
  readonly form: '10-Q' | '10-K';
  /** The duration window in whole days, inclusive (§10). An instant has no window. */
  readonly minDays: number;
  readonly maxDays: number;
}

function invalid(rule: string): never {
  throw new FinancialGatewayError('SCHEMA_INVALID', 'SEC response: ' + rule);
}

function incoherent(rule: string): never {
  throw new FinancialGatewayError('PROVIDER_DATA_INCOHERENT', 'SEC response: ' + rule);
}

function absent(rule: string): never {
  throw new FinancialGatewayError('PROVIDER_DATA_ABSENT', 'SEC response: ' + rule);
}

/** The fiscal period of a request. Q4 is refused: it is not a separately filed 10-Q (§9). */
export function periodOf(period: string): PeriodRef {
  const match = PERIOD.exec(period);
  if (!match) throw new FinancialGatewayError('REQUEST_INVALID', 'period must be YYYY-Qn or YYYY-FY');
  const fy = match[1] ?? '';
  const fp = match[2] ?? '';
  if (fp === 'Q4') throw new FinancialGatewayError('REQUEST_INVALID', 'Q4 is refused in V1: it is not a separately filed 10-Q (docs/SEC_EDGAR_FUNDAMENTALS_V1.md §9)');
  if (fp === 'FY') return { fy, fp: 'FY', form: '10-K', minDays: 350, maxDays: 380 };
  return { fy, fp: fp as Fiscal, form: '10-Q', minDays: 80, maxDays: 100 };
}

function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isSecNumber(value)) invalid(what + ' must be an object');
  return value as Record<string, unknown>;
}

function listOf(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) invalid(what + ' must be a list');
  return value as unknown[];
}

/** A column value that must be a string. A blank string is lawful here: it is checked only where a row needs the value. */
function stringOf(value: unknown, what: string): string {
  if (typeof value !== 'string') invalid(what + ' must be a string');
  return value;
}

function textOf(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || CONTROL.test(value)) invalid(what + ' must be printable text of at most ' + max + ' characters');
  return value;
}

function accessionOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ACCESSION.test(value)) invalid(what + ' is not an accession number');
  return value;
}

/** A calendar date, YYYY-MM-DD. Impossible dates such as 30 February are refused. */
function dateOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || !DATE.test(value)) invalid(what + ' must be YYYY-MM-DD');
  const [y = 0, m = 0, d = 0] = value.split('-').map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) invalid(what + ' is not a calendar date');
  return value;
}

const dayOf = (date: string): number => Date.parse(date + 'T00:00:00Z') / DAY_MS;

export interface SecFiling {
  readonly accession: string;
  readonly form: string;
  readonly filingDate: string;
  readonly reportDate: string;
}

export interface SecSubmissions {
  readonly cik: string;
  readonly filings: readonly SecFiling[];
}

/**
 * The submissions document. `filings.recent` is a set of parallel columns: they must have equal length, every accession must be well formed and unique, and
 * every column must have the right type on every row. Only the 10-Q and 10-K rows are materialized, and each of those is validated strictly. Unrelated
 * forms are structurally checked and then intentionally ignored, so a blank reportDate on a form with no reporting period cannot invalidate the document.
 * A document for another company fails closed.
 */
export function submissionsOf(value: SecValue, cik: string): SecSubmissions {
  const root = recordOf(value, 'submissions');
  if (typeof root.cik !== 'string' || !CIK.test(root.cik)) invalid('submissions cik must be a ten-digit string');
  if (root.cik !== cik) incoherent('the submissions document is for another company than the mapped CIK');
  const recent = recordOf(recordOf(root.filings, 'filings').recent, 'filings.recent');
  const accessions = listOf(recent.accessionNumber, 'accessionNumber');
  const forms = listOf(recent.form, 'form');
  const filed = listOf(recent.filingDate, 'filingDate');
  const reports = listOf(recent.reportDate, 'reportDate');
  const accepted = recent.acceptanceDateTime === undefined ? undefined : listOf(recent.acceptanceDateTime, 'acceptanceDateTime');
  const n = accessions.length;
  if (forms.length !== n || filed.length !== n || reports.length !== n || (accepted !== undefined && accepted.length !== n)) {
    invalid('the filings columns have unequal lengths');
  }
  const seen = new Set<string>();
  const filings: SecFiling[] = [];
  for (let i = 0; i < n; i++) {
    // Structure applies to every row: the accession identifies it, and each column must have the right type. A blank value is lawful in a column that a
    // row does not need. A supported row is validated strictly below.
    const accession = accessionOf(accessions[i], 'accessionNumber');
    if (seen.has(accession)) invalid('a filing accession appears twice');
    seen.add(accession);
    const form = stringOf(forms[i], 'form');
    const filingDate = stringOf(filed[i], 'filingDate');
    const reportDate = stringOf(reports[i], 'reportDate');
    const acceptance = accepted === undefined ? '' : stringOf(accepted[i], 'acceptanceDateTime');
    // Only the two forms that can source V1 fundamentals are materialized (docs/SEC_EDGAR_FUNDAMENTALS_V1.md §8). Every other form is unrelated: its
    // metadata is intentionally not used, so it is not validated beyond its structure, and it is never eligible.
    if (!SOURCE_FORMS.has(form)) continue;
    // The acceptance time is not used in V1, so it is checked for syntax only when present. A blank one does not block a supported filing.
    if (acceptance.trim() !== '' && !ISO_ACCEPTANCE.test(acceptance)) invalid('acceptanceDateTime is malformed');
    filings.push({ accession, form, filingDate: dateOf(filingDate, 'filingDate'), reportDate: dateOf(reportDate, 'reportDate') });
  }
  return { cik, filings: Object.freeze(filings) };
}

export interface SecFact {
  /** The start of a duration fact, or null for an instant (a balance-sheet value). */
  readonly start: string | null;
  readonly end: string;
  readonly value: SecNumber;
  readonly accession: string;
  readonly fy: string;
  readonly fp: string;
  readonly form: string;
  readonly filed: string;
}

export interface SecFacts {
  readonly cik: string;
  /** Mapped US-GAAP concepts only: concept → unit → facts. */
  readonly concepts: ReadonlyMap<string, ReadonlyMap<string, readonly SecFact[]>>;
}

/** The NEXUS fields and their US-GAAP concepts, in priority order (§14). No fuzzy matching: each entry is an exact concept name. */
const FIELDS = ['revenue', 'grossProfit', 'operatingIncome', 'netIncome', 'eps', 'cash', 'equity', 'operatingCashFlow'] as const;
type Field = (typeof FIELDS)[number];

const CONCEPTS: Readonly<Record<Field, readonly string[]>> = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss'],
  eps: ['EarningsPerShareDiluted'],
  cash: ['CashAndCashEquivalentsAtCarryingValue'],
  equity: ['StockholdersEquity'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
};

const DURATION: ReadonlySet<Field> = new Set<Field>(['revenue', 'grossProfit', 'operatingIncome', 'netIncome', 'eps', 'operatingCashFlow']);
const INCOME: readonly Field[] = ['revenue', 'grossProfit', 'operatingIncome', 'netIncome', 'eps'];
const BALANCE: readonly Field[] = ['cash', 'equity'];
const MAPPED: ReadonlySet<string> = new Set(FIELDS.flatMap((field) => CONCEPTS[field]));

function factOf(value: unknown, concept: string): SecFact {
  const f = recordOf(value, 'a fact of ' + concept);
  const end = dateOf(f.end, 'end');
  const start = f.start === undefined ? null : dateOf(f.start, 'start');
  if (start !== null && start > end) invalid('a duration ends before it starts');
  if (!isSecNumber(f.val)) invalid('val must be a JSON number');
  if (!isSecNumber(f.fy) || !/^\d{4}$/.test(f.fy.lexeme)) invalid('fy must be a JSON integer year');
  return {
    start,
    end,
    value: f.val,
    accession: accessionOf(f.accn, 'accn'),
    fy: f.fy.lexeme,
    fp: textOf(f.fp, 'fp', 4),
    form: textOf(f.form, 'form', 20),
    filed: dateOf(f.filed, 'filed'),
  };
}

/**
 * The companyfacts document. The CIK is a JSON number, so it is compared after zero-padding its lexeme to ten digits, never through a JavaScript number.
 * The mapped concepts are validated strictly in every unit. Other concepts are not read.
 */
export function companyFactsOf(value: SecValue, cik: string): SecFacts {
  const root = recordOf(value, 'companyfacts');
  if (!isSecNumber(root.cik) || !/^\d{1,10}$/.test(root.cik.lexeme)) invalid('companyfacts cik must be a JSON integer');
  if (root.cik.lexeme.padStart(10, '0') !== cik) incoherent('the companyfacts document is for another company than the mapped CIK');
  const facts = recordOf(root.facts, 'facts');
  const usGaap: Record<string, unknown> = facts[TAXONOMY] === undefined ? {} : recordOf(facts[TAXONOMY], 'us-gaap');
  const concepts = new Map<string, Map<string, SecFact[]>>();
  for (const concept of MAPPED) {
    if (usGaap[concept] === undefined) continue;
    const units = recordOf(recordOf(usGaap[concept], concept).units, concept + ' units');
    const byUnit = new Map<string, SecFact[]>();
    for (const unit of Object.keys(units)) {
      byUnit.set(
        unit,
        listOf(units[unit], concept + ' units').map((entry) => factOf(entry, concept)),
      );
    }
    concepts.set(concept, byUnit);
  }
  return { cik, concepts };
}

export interface FundamentalsInput {
  readonly period: string;
  readonly currency: string;
  /** A canonical UTC instant. Its UTC calendar day is the look-ahead boundary (§12). */
  readonly asOf: string;
}

export interface SelectedFact {
  readonly taxonomy: typeof TAXONOMY;
  readonly concept: string;
  readonly unit: string;
  readonly accession: string;
  readonly start: string | null;
  readonly end: string;
  /** The exact source text of the value, which the provenance hash binds. */
  readonly lexeme: string;
  /** The canonical decimal the record carries. */
  readonly canonical: string;
}

/** The NEXUS fundamentals fields. The four that are never mapped (ebit, debt, capex, freeCashFlow) are always null (§14). */
export interface FundamentalsCandidate {
  readonly period: string;
  readonly currency: string;
  readonly revenue: string | null;
  readonly grossProfit: string | null;
  readonly operatingIncome: string | null;
  readonly ebit: null;
  readonly netIncome: string | null;
  readonly eps: string | null;
  readonly cash: string | null;
  readonly debt: null;
  readonly equity: string | null;
  readonly operatingCashFlow: string | null;
  readonly capex: null;
  readonly freeCashFlow: null;
}

export interface FundamentalsSelection {
  readonly candidate: FundamentalsCandidate;
  /** The single filing every selected fact comes from. */
  readonly accession: string;
  readonly selectedFacts: readonly SelectedFact[];
}

function inWindow(fact: SecFact, period: PeriodRef): boolean {
  if (fact.start === null) return false;
  const days = dayOf(fact.end) - dayOf(fact.start);
  return days >= period.minDays && days <= period.maxDays;
}

/** Facts with one selection key (accession, start, end) collapse when their values agree. Differing values fail closed. */
function dedupe(facts: readonly SecFact[]): SecFact[] {
  const byKey = new Map<string, SecFact>();
  for (const fact of facts) {
    const key = fact.accession + '|' + (fact.start ?? '') + '|' + fact.end;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, fact);
      continue;
    }
    if (seen.value.value !== fact.value.value) incoherent('two facts for one period report different values');
    // The representative is the smallest lexeme, so the output never depends on the order of the response.
    if (fact.value.lexeme < seen.value.lexeme) byKey.set(key, fact);
  }
  return [...byKey.values()];
}

/** The one fact for a field: the first concept in priority order that has a candidate. Two candidates for that concept fail closed. */
function pickFor(field: Field, input: FundamentalsInput, period: PeriodRef, usable: ReadonlyMap<string, SecFiling>, facts: SecFacts): SelectedFact | null {
  const unit = field === 'eps' ? input.currency + '/shares' : input.currency;
  for (const concept of CONCEPTS[field]) {
    const entries = facts.concepts.get(concept)?.get(unit) ?? [];
    const matches: SecFact[] = [];
    for (const fact of entries) {
      const filing = usable.get(fact.accession);
      if (!filing || fact.form !== period.form || fact.fy !== period.fy || fact.fp !== period.fp || fact.end !== filing.reportDate) continue;
      if (DURATION.has(field) ? !inWindow(fact, period) : fact.start !== null) continue;
      if (fact.filed !== filing.filingDate) incoherent('a fact is filed on a different date from its filing in the submissions');
      matches.push(fact);
    }
    const deduped = dedupe(matches);
    if (deduped.length === 0) continue;
    if (deduped.length > 1) incoherent('more than one fact answers for ' + concept + ' in ' + unit);
    const fact = deduped[0]!;
    return { taxonomy: TAXONOMY, concept, unit, accession: fact.accession, start: fact.start, end: fact.end, lexeme: fact.value.lexeme, canonical: fact.value.value };
  }
  return null;
}

/**
 * The fundamentals record for one period. Only filings that were public strictly before the as-of day are used, so a later value is never filled in
 * (§12). Every selected fact comes from one accession (§8). The record needs one income value and one balance value (§18). Nothing here calls the provider.
 */
export function selectFundamentals(input: FundamentalsInput, submissions: SecSubmissions, facts: SecFacts): FundamentalsSelection {
  const period = periodOf(input.period);
  const asOfDay = input.asOf.slice(0, 10);
  const usable = new Map<string, SecFiling>();
  for (const filing of submissions.filings) {
    if (filing.form === period.form && filing.filingDate < asOfDay) usable.set(filing.accession, filing);
  }
  const chosen = new Map<Field, SelectedFact>();
  for (const field of FIELDS) {
    const fact = pickFor(field, input, period, usable, facts);
    if (fact) chosen.set(field, fact);
  }
  const selected = [...chosen.values()];
  if (selected.length === 0) absent('no usable fact for ' + input.period + ' at ' + input.asOf);
  const accessions = new Set(selected.map((fact) => fact.accession));
  if (accessions.size > 1) incoherent('the selected facts come from more than one filing');
  if (!INCOME.some((field) => chosen.has(field)) || !BALANCE.some((field) => chosen.has(field))) {
    absent('the record needs at least one income value and one balance value');
  }
  const value = (field: Field): string | null => chosen.get(field)?.canonical ?? null;
  const candidate: FundamentalsCandidate = {
    period: input.period,
    currency: input.currency,
    revenue: value('revenue'),
    grossProfit: value('grossProfit'),
    operatingIncome: value('operatingIncome'),
    ebit: null,
    netIncome: value('netIncome'),
    eps: value('eps'),
    cash: value('cash'),
    debt: null,
    equity: value('equity'),
    operatingCashFlow: value('operatingCashFlow'),
    capex: null,
    freeCashFlow: null,
  };
  const order = (fact: SelectedFact) => fact.concept + '|' + fact.unit + '|' + (fact.start ?? '') + '|' + fact.end;
  const selectedFacts = selected.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  return { candidate: Object.freeze(candidate), accession: [...accessions][0]!, selectedFacts: Object.freeze(selectedFacts) };
}
