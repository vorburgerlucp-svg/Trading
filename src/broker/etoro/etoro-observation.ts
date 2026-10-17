// The read-only observation of a demo portfolio response (O21A): a sanitized schema report, never the response. It describes the
// structure only: key names, JSON types, null/present counts, element counts per container, and coarse number classes (integer or
// not, safe integer or not, zero/positive/negative). It never copies a string, a number or an id into the report, unless the caller
// asks for ids, and then only as pseudonyms (HMAC-SHA256 with a random per-run salt that is never output), so they can be compared
// within one report and never across runs. eToro instrument ids are public market identifiers; they are listed in clear only when
// the caller asks for them explicitly (to prepare the human-governed etoro mapping).
//
// The documented schema below is the official eToro API reference of GET /api/v1/trading/info/demo/portfolio (checked 2026-10-17).
// It is used only to compare: which documented fields the observed response lacks, and which fields it has that are not documented.

import { createHmac, randomBytes } from 'node:crypto';
import { BrokerError } from '../broker-errors.js';
import { parseDemoPortfolio } from './etoro-validation.js';

/** clientPortfolio properties in the reference. */
export const DOCUMENTED_CLIENT_PORTFOLIO_FIELDS = Object.freeze([
  'positions', 'credit', 'mirrors', 'orders', 'stockOrders', 'entryOrders', 'exitOrders', 'ordersForOpen', 'ordersForClose', 'ordersForCloseMultiple', 'bonusCredit',
]);

/** TradingDemoApi_Position properties in the reference. No `required` list is documented. */
export const DOCUMENTED_POSITION_FIELDS = Object.freeze([
  'positionID', 'CID', 'openDateTime', 'openRate', 'instrumentID', 'mirrorID', 'parentPositionID', 'isBuy', 'leverage', 'takeProfitRate',
  'stopLossRate', 'amount', 'orderID', 'orderType', 'units', 'totalFees', 'initialAmountInDollars', 'isTslEnabled', 'stopLossVersion',
  'isSettled', 'redeemStatusID', 'initialUnits', 'isPartiallyAltered', 'unitsBaseValueDollars', 'isDiscounted', 'openPositionActionType',
  'settlementTypeID', 'isDetached', 'openConversionRate', 'pnlVersion', 'totalExternalFees', 'totalExternalTaxes', 'isNoTakeProfit',
  'isNoStopLoss', 'lotCount',
]);

/** Element properties of clientPortfolio.orders ("List of pending orders") in the reference. */
export const DOCUMENTED_ORDER_FIELDS = Object.freeze([
  'orderID', 'CID', 'openDateTime', 'instrumentID', 'isBuy', 'takeProfitRate', 'stopLossRate', 'rate', 'amount', 'leverage', 'units',
  'isTslEnabled', 'executionType', 'isDiscounted',
]);

/** Element properties of clientPortfolio.mirrors in the reference (copy trading; not read by NEXUS). */
export const DOCUMENTED_MIRROR_FIELDS = Object.freeze([
  'mirrorID', 'CID', 'parentCID', 'stopLossPercentage', 'isPaused', 'copyExistingPositions', 'availableAmount', 'stopLossAmount',
  'initialInvestment', 'depositSummary', 'withdrawalSummary', 'positions', 'entryOrders', 'exitOrders', 'parentUsername',
  'closedPositionsNetProfit', 'startedCopyDate', 'pendingForClosure', 'parentMirrors', 'mirrorCalculationType', 'ordersForOpen',
  'ordersForClose', 'ordersForCloseMultiple', 'delayedOrderForClose', 'delayedOrderForOpen', 'mirrorStatusID',
]);

/**
 * The element schema per container, or null where the reference gives the elements only as `{ type: object }` with no properties
 * (ordersForOpen, ordersForClose, ordersForCloseMultiple) or calls the container obsolete (stockOrders, entryOrders, exitOrders).
 */
export const DOCUMENTED_ELEMENT_FIELDS: Readonly<Record<string, readonly string[] | null>> = Object.freeze({
  positions: DOCUMENTED_POSITION_FIELDS,
  orders: DOCUMENTED_ORDER_FIELDS,
  mirrors: DOCUMENTED_MIRROR_FIELDS,
  stockOrders: null,
  entryOrders: null,
  exitOrders: null,
  ordersForOpen: null,
  ordersForClose: null,
  ordersForCloseMultiple: null,
});

/** Id fields that are pseudonymized when ids are requested. Every other field is described by type only. */
const ID_FIELDS = new Set(['positionID', 'orderID', 'CID', 'mirrorID', 'parentPositionID', 'parentCID']);
/** A key name is reported only when it looks like a schema field name; anything else could be data used as a key. */
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_KEYS = 200;

export type JsonKind =
  | 'null'
  | 'boolean'
  | 'integer'
  | 'unsafe_integer'
  | 'non_integer_number'
  | 'string_iso8601_utc_z'
  | 'string_iso8601_offset'
  | 'string_iso8601_no_zone'
  | 'string_numeric'
  | 'string_other'
  | 'array'
  | 'object';

export interface FieldReport {
  /** How many elements have this key at all. */
  present: number;
  /** JSON kind counts of the values. */
  kinds: Partial<Record<JsonKind, number>>;
  /** For numbers only: how many are zero, positive, negative. No value is reported. */
  sign?: { zero: number; positive: number; negative: number };
  /** For arrays only: the largest element count seen. */
  maxLength?: number;
}

export interface ContainerReport {
  kind: JsonKind | 'missing';
  count: number;
  /** Field name -> report, over all elements. Absent for an empty or non-array container. */
  fields?: Record<string, FieldReport>;
  /** Keys that are not reported by name because they do not look like field names. */
  unnamedKeys?: number;
  documented: 'element_schema' | 'no_element_schema';
  /** Documented fields that no element has. Only for a non-empty container with a documented element schema. */
  documentedMissing?: string[];
  /** Fields that the reference does not document. */
  undocumentedPresent?: string[];
  /** Per-run pseudonyms of the ids of each element, only when requested. */
  pseudonymousIds?: Record<string, string[]>;
  /** eToro instrument ids in clear, only when requested. */
  instrumentIds?: number[];
}

export interface ObservationReport {
  schema: 'etoro-demo-portfolio-observation:v1';
  endpoint: 'GET /api/v1/trading/info/demo/portfolio';
  topLevelKeys: string[];
  topLevelUnnamedKeys: number;
  clientPortfolio: {
    kind: JsonKind | 'missing';
    keys: string[];
    unnamedKeys: number;
    undocumentedKeys: string[];
    documentedMissing: string[];
    credit: { kind: JsonKind | 'missing'; sign?: 'zero' | 'positive' | 'negative' };
    bonusCredit: { kind: JsonKind | 'missing'; sign?: 'zero' | 'positive' | 'negative' };
  };
  containers: Record<string, ContainerReport>;
  /** What the O21A parser does with this response. The detail names a field path only, never a value. */
  parser: { outcome: 'accepted'; positions: number; orders: number } | { outcome: 'refused'; code: string; detail: string };
}

export interface ObservationOptions {
  /** Pseudonymize the id fields of every element with a per-run salt. Off by default. */
  pseudonymizeIds?: boolean;
  /** List eToro instrument ids in clear. Off by default. */
  showInstrumentIds?: boolean;
  /** Tests only: a fixed salt. The default is 32 random bytes per run, never output. */
  salt?: Buffer;
}

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:?\d{2}$/;
const ISO_NO_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const NUMERIC = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;

export function kindOf(value: unknown): JsonKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'number':
      if (!Number.isInteger(value)) return 'non_integer_number';
      return Number.isSafeInteger(value) ? 'integer' : 'unsafe_integer';
    case 'string':
      if (ISO_Z.test(value)) return 'string_iso8601_utc_z';
      if (ISO_OFFSET.test(value)) return 'string_iso8601_offset';
      if (ISO_NO_ZONE.test(value)) return 'string_iso8601_no_zone';
      if (NUMERIC.test(value)) return 'string_numeric';
      return 'string_other';
    default:
      return 'object';
  }
}

function signOf(value: number): 'zero' | 'positive' | 'negative' {
  return value === 0 ? 'zero' : value > 0 ? 'positive' : 'negative';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function namedKeys(value: Record<string, unknown>): { names: string[]; unnamed: number } {
  const keys = Object.keys(value);
  const names = keys.filter((k) => KEY_NAME.test(k)).sort().slice(0, MAX_KEYS);
  return { names, unnamed: keys.length - names.length };
}

function scalarSummary(value: unknown): { kind: JsonKind | 'missing'; sign?: 'zero' | 'positive' | 'negative' } {
  if (value === undefined) return { kind: 'missing' };
  const kind = kindOf(value);
  return typeof value === 'number' ? { kind, sign: signOf(value) } : { kind };
}

function describeContainer(name: string, value: unknown, options: ObservationOptions, pseudonym: (text: string) => string): ContainerReport {
  const documentedFields = DOCUMENTED_ELEMENT_FIELDS[name] ?? null;
  const documented = documentedFields === null ? 'no_element_schema' : 'element_schema';
  if (value === undefined) return { kind: 'missing', count: 0, documented };
  if (!Array.isArray(value)) return { kind: kindOf(value), count: 0, documented };
  const report: ContainerReport = { kind: 'array', count: value.length, documented };
  if (value.length === 0) return report;

  const fields: Record<string, FieldReport> = {};
  let unnamed = 0;
  const ids: Record<string, string[]> = {};
  const instruments = new Set<number>();
  for (const element of value) {
    if (!isObject(element)) {
      fields['<element>'] ??= { present: 0, kinds: {} };
      const f = fields['<element>'];
      f.present++;
      const kind = kindOf(element);
      f.kinds[kind] = (f.kinds[kind] ?? 0) + 1;
      continue;
    }
    const { names, unnamed: u } = namedKeys(element);
    unnamed += u;
    for (const key of names) {
      const v = element[key];
      const f = (fields[key] ??= { present: 0, kinds: {} });
      f.present++;
      const kind = kindOf(v);
      f.kinds[kind] = (f.kinds[kind] ?? 0) + 1;
      if (typeof v === 'number') {
        f.sign ??= { zero: 0, positive: 0, negative: 0 };
        f.sign[signOf(v)]++;
      }
      if (Array.isArray(v)) f.maxLength = Math.max(f.maxLength ?? 0, v.length);
      if (options.pseudonymizeIds && ID_FIELDS.has(key) && (typeof v === 'number' || typeof v === 'string')) {
        (ids[key] ??= []).push(pseudonym(String(v)));
      }
      if (options.showInstrumentIds && key === 'instrumentID' && typeof v === 'number' && Number.isSafeInteger(v)) instruments.add(v);
    }
  }
  report.fields = Object.fromEntries(Object.keys(fields).sort().map((k) => [k, fields[k]!]));
  if (unnamed > 0) report.unnamedKeys = unnamed;
  if (documentedFields !== null) {
    const seen = new Set(Object.keys(fields));
    report.documentedMissing = documentedFields.filter((f) => !seen.has(f));
    report.undocumentedPresent = [...seen].filter((f) => f !== '<element>' && !documentedFields.includes(f)).sort();
  } else {
    report.undocumentedPresent = Object.keys(fields).filter((f) => f !== '<element>').sort();
  }
  if (options.pseudonymizeIds && Object.keys(ids).length > 0) {
    report.pseudonymousIds = Object.fromEntries(Object.keys(ids).sort().map((k) => [k, ids[k]!.sort()]));
  }
  if (options.showInstrumentIds && instruments.size > 0) report.instrumentIds = [...instruments].sort((a, b) => a - b);
  return report;
}

function parserVerdict(body: unknown): ObservationReport['parser'] {
  try {
    const parsed = parseDemoPortfolio(body);
    return { outcome: 'accepted', positions: parsed.positionCount, orders: parsed.orderCount };
  } catch (error) {
    if (error instanceof BrokerError) return { outcome: 'refused', code: error.code, detail: error.message };
    return { outcome: 'refused', code: 'UNEXPECTED', detail: 'the parser failed unexpectedly' };
  }
}

/** The sanitized schema report of one demo portfolio response body. The body itself is never part of the result. */
export function observeDemoPortfolio(body: unknown, options: ObservationOptions = {}): ObservationReport {
  const salt = options.salt ?? randomBytes(32);
  const pseudonym = (text: string) => 'id_' + createHmac('sha256', salt).update(text).digest('hex').slice(0, 16);

  const top = isObject(body) ? namedKeys(body) : { names: [], unnamed: 0 };
  const cp = isObject(body) ? body.clientPortfolio : undefined;
  const cpKeys = isObject(cp) ? namedKeys(cp) : { names: [], unnamed: 0 };
  const containers: Record<string, ContainerReport> = {};
  // Every documented container, and every other array that appears in clientPortfolio.
  const containerNames = new Set<string>(Object.keys(DOCUMENTED_ELEMENT_FIELDS));
  if (isObject(cp)) for (const key of cpKeys.names) if (Array.isArray(cp[key])) containerNames.add(key);
  for (const name of [...containerNames].sort()) containers[name] = describeContainer(name, isObject(cp) ? cp[name] : undefined, options, pseudonym);

  return {
    schema: 'etoro-demo-portfolio-observation:v1',
    endpoint: 'GET /api/v1/trading/info/demo/portfolio',
    topLevelKeys: top.names,
    topLevelUnnamedKeys: top.unnamed,
    clientPortfolio: {
      kind: cp === undefined ? 'missing' : kindOf(cp),
      keys: cpKeys.names,
      unnamedKeys: cpKeys.unnamed,
      undocumentedKeys: cpKeys.names.filter((k) => !DOCUMENTED_CLIENT_PORTFOLIO_FIELDS.includes(k)),
      documentedMissing: DOCUMENTED_CLIENT_PORTFOLIO_FIELDS.filter((k) => !cpKeys.names.includes(k)),
      credit: scalarSummary(isObject(cp) ? cp.credit : undefined),
      bonusCredit: scalarSummary(isObject(cp) ? cp.bonusCredit : undefined),
    },
    containers,
    parser: parserVerdict(body),
  };
}
