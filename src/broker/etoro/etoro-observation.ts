// The read-only observation of a demo response (O21A, O21A.1): a sanitized schema report, never the response. Two sources, each
// one fixed GET: source=portfolio (/trading/info/demo/portfolio) and source=pnl (/trading/info/demo/pnl). It describes the
// structure only: key names, JSON types, null/present counts, element counts per container, and coarse number classes (integer or
// not, safe integer or not, zero/positive/negative). It never copies a string, a number or an id into the report, unless the caller
// asks for ids, and then only as pseudonyms (HMAC-SHA256 with a random per-run salt that is never output), so they can be compared
// within one report and never across runs. eToro instrument ids are public market identifiers; they are listed in clear only when
// the caller asks for them explicitly (to prepare the human-governed etoro mapping).
//
// Three evidence classes are kept apart. REFERENCE_SCHEMA: the property definitions of the official reference (checked 2026-10-17).
// REFERENCE_EXAMPLE: the reference's example response, which for /demo/pnl contradicts its own schema (casing, flat vs nested PnL).
// LIVE_OBSERVED: what this report describes. The report is built from the in-memory JSON first, independently of any parser; the
// parser verdict is computed afterwards and reported separately, so a live shape the parser refuses is still fully described.

import { createHmac, randomBytes } from 'node:crypto';
import { BrokerError } from '../broker-errors.js';
import { parseDemoPnl } from './etoro-pnl-validation.js';
import { parseDemoPortfolio } from './etoro-validation.js';

/** /demo/portfolio REFERENCE_SCHEMA: clientPortfolio properties. */
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

/** /demo/pnl REFERENCE_SCHEMA: clientPortfolio properties. */
export const PNL_SCHEMA_CLIENT_PORTFOLIO_FIELDS = Object.freeze([
  'positions', 'credit', 'mirrors', 'orders', 'ordersForOpen', 'ordersForClose', 'ordersForCloseMultiple', 'bonusCredit', 'unrealizedPnL',
  'accountCurrencyId', 'stockOrders', 'entryOrders', 'exitOrders',
]);

/** /demo/pnl REFERENCE_SCHEMA: position (TradingRealAdminApi_Position) = the portfolio position plus externalOperation and unrealizedPnL. */
export const PNL_SCHEMA_POSITION_FIELDS = Object.freeze([...DOCUMENTED_POSITION_FIELDS, 'externalOperation', 'unrealizedPnL']);

/** /demo/pnl REFERENCE_SCHEMA: the nested per-position unrealizedPnL object. */
export const PNL_SCHEMA_UNREALIZED_PNL_FIELDS = Object.freeze([
  'pnL', 'pnlAssetCurrency', 'exposureInAccountCurrency', 'exposureInAssetCurrency', 'marginInAccountCurrency', 'marginInAssetCurrency',
  'marginCurrencyId', 'assetCurrencyId', 'closeRate', 'closeConversionRate', 'timestamp',
]);

/** /demo/pnl REFERENCE_SCHEMA: orders (TradingRealAdminApi_Order), spelled orderId / instrumentId. */
export const PNL_SCHEMA_ORDER_FIELDS = Object.freeze([
  'orderId', 'cid', 'openDateTime', 'instrumentId', 'isBuy', 'takeProfitRate', 'stopLossRate', 'rate', 'amount', 'leverage', 'units',
  'isTslEnabled', 'executionType', 'isDiscounted', 'isNoTakeProfit', 'isNoStopLoss',
]);

/** /demo/pnl REFERENCE_SCHEMA: ordersForOpen. */
export const PNL_SCHEMA_ORDER_FOR_OPEN_FIELDS = Object.freeze([
  'orderId', 'orderType', 'statusId', 'cid', 'openDateTime', 'lastUpdate', 'instrumentId', 'amount', 'amountInUnits', 'isBuy', 'leverage',
  'stopLossRate', 'takeProfitRate', 'isTslEnabled', 'isDiscounted', 'mirrorId', 'frozenAmount', 'totalExternalCosts', 'isNoTakeProfit',
  'isNoStopLoss', 'lotCount', 'openPositionActionType', 'externalOperation',
]);

/** /demo/pnl REFERENCE_SCHEMA: ordersForClose. */
export const PNL_SCHEMA_ORDER_FOR_CLOSE_FIELDS = Object.freeze([
  'orderId', 'orderType', 'statusId', 'cid', 'openDateTime', 'lastUpdate', 'instrumentId', 'unitsToDeduct', 'lotsToDeduct', 'positionId',
]);

/** /demo/pnl REFERENCE_SCHEMA: ordersForCloseMultiple. */
export const PNL_SCHEMA_ORDER_FOR_CLOSE_MULTIPLE_FIELDS = Object.freeze([
  'orderId', 'orderType', 'statusId', 'cid', 'openDateTime', 'lastUpdate', 'instrumentId', 'unitsToDeduct', 'lotsToDeduct', 'pendingClosePositionIds',
]);

/**
 * /demo/pnl REFERENCE_EXAMPLE: the keys of the example's top-level position. They contradict the schema: other casing (positionId,
 * instrumentId, cid, ...) and flat PnL keys (pnL, closeRate, closeConversionRate, timestamp) instead of the nested unrealizedPnL.
 */
export const PNL_EXAMPLE_POSITION_FIELDS = Object.freeze([
  'positionId', 'cid', 'openDateTime', 'openRate', 'instrumentId', 'isBuy', 'takeProfitRate', 'stopLossRate', 'mirrorId', 'parentPositionId',
  'amount', 'leverage', 'orderId', 'orderType', 'units', 'totalFees', 'initialAmountInDollars', 'isTslEnabled', 'stopLossVersion', 'isSettled',
  'redeemStatusId', 'initialUnits', 'isPartiallyAltered', 'unitsBaseValueDollars', 'isDiscounted', 'openPositionActionType', 'settlementTypeId',
  'isDetached', 'openConversionRate', 'pnlVersion', 'totalExternalFees', 'totalExternalTaxes', 'isNoTakeProfit', 'isNoStopLoss', 'lotCount',
  'externalOperation', 'pnL', 'closeRate', 'closeConversionRate', 'timestamp',
]);

export type ObservationSource = 'portfolio' | 'pnl';

interface SourceSchema {
  readonly endpoint: string;
  readonly clientPortfolioFields: readonly string[];
  /** REFERENCE_SCHEMA element properties per container; null = no documented element schema (or obsolete). */
  readonly elementFields: Readonly<Record<string, readonly string[] | null>>;
  /** REFERENCE_EXAMPLE element keys per container, where the example contradicts the schema. */
  readonly exampleFields: Readonly<Record<string, readonly string[]>>;
  /** REFERENCE_SCHEMA nested object properties: container -> field -> properties. */
  readonly nestedFields: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

const SCHEMAS: Readonly<Record<ObservationSource, SourceSchema>> = Object.freeze({
  portfolio: {
    endpoint: 'GET /api/v1/trading/info/demo/portfolio',
    clientPortfolioFields: DOCUMENTED_CLIENT_PORTFOLIO_FIELDS,
    elementFields: DOCUMENTED_ELEMENT_FIELDS,
    exampleFields: {},
    nestedFields: {},
  },
  pnl: {
    endpoint: 'GET /api/v1/trading/info/demo/pnl',
    clientPortfolioFields: PNL_SCHEMA_CLIENT_PORTFOLIO_FIELDS,
    elementFields: {
      positions: PNL_SCHEMA_POSITION_FIELDS,
      orders: PNL_SCHEMA_ORDER_FIELDS,
      mirrors: DOCUMENTED_MIRROR_FIELDS,
      ordersForOpen: PNL_SCHEMA_ORDER_FOR_OPEN_FIELDS,
      ordersForClose: PNL_SCHEMA_ORDER_FOR_CLOSE_FIELDS,
      ordersForCloseMultiple: PNL_SCHEMA_ORDER_FOR_CLOSE_MULTIPLE_FIELDS,
      stockOrders: null,
      entryOrders: null,
      exitOrders: null,
    },
    exampleFields: { positions: PNL_EXAMPLE_POSITION_FIELDS },
    nestedFields: { positions: { unrealizedPnL: PNL_SCHEMA_UNREALIZED_PNL_FIELDS } },
  },
});

/** Id fields that are pseudonymized when ids are requested, in both spellings the reference uses. Every other field is described by type only. */
const ID_FIELDS = new Set([
  'positionID', 'orderID', 'CID', 'mirrorID', 'parentPositionID', 'parentCID',
  'positionId', 'orderId', 'cid', 'mirrorId', 'parentPositionId', 'parentCid',
]);
const INSTRUMENT_ID_FIELDS = new Set(['instrumentID', 'instrumentId']);
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
  /** For objects only: the key names seen inside (one level), never their values. */
  objectKeys?: string[];
  /** For an object field with a REFERENCE_SCHEMA nested definition: objectKeys compared with it. */
  nested?: { schemaMissing: string[]; undocumentedPresent: string[] };
}

export interface ContainerReport {
  kind: JsonKind | 'missing';
  count: number;
  /** Field name -> report, over all elements. Absent for an empty or non-array container. */
  fields?: Record<string, FieldReport>;
  /** Keys that are not reported by name because they do not look like field names. */
  unnamedKeys?: number;
  documented: 'element_schema' | 'no_element_schema';
  /** Observed fields that the REFERENCE_SCHEMA defines. Only for a non-empty container. */
  schemaDocumentedPresent?: string[];
  /** REFERENCE_SCHEMA fields that no element has. Only for a non-empty container with an element schema. */
  documentedMissing?: string[];
  /** Observed fields that are not in the schema but are in the REFERENCE_EXAMPLE (the schema/example contradiction). */
  exampleOnlyPresent?: string[];
  /** Observed fields that are in neither the schema nor the example. */
  undocumentedPresent?: string[];
  /** Per-run pseudonyms of the ids of each element, only when requested. */
  pseudonymousIds?: Record<string, string[]>;
  /** eToro instrument ids in clear, only when requested. */
  instrumentIds?: number[];
}

export type ParserVerdict =
  | { outcome: 'accepted'; positions: number; orders: number; ordersForOpen?: number }
  | { outcome: 'refused'; code: string; detail: string };

export interface ObservationReport {
  schema: 'etoro-demo-portfolio-observation:v1';
  source: ObservationSource;
  endpoint: string;
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
  /** O22, source pnl only: the evidence the demo account safety needs (gaps G1 and G2). Counts, kinds and signs; no amount, no id. */
  valuationEvidence?: ValuationEvidence;
  /** What the parser of this source does with the response, computed after the report. The detail names a field path, never a value. */
  parser: ParserVerdict;
}

export type PnlValueType = 'number' | 'null' | 'missing' | 'other';
export type PnlSign = 'positive' | 'negative' | 'zero' | 'not_applicable';

/**
 * O22: what a /demo/pnl response proves for the valuation of the demo account safety source.
 * - G1: every position has a nested unrealizedPnL object whose pnL is a finite JSON number (the guide formula sums it).
 * - G2: clientPortfolio.accountCurrencyId is the currency code 1 ("1 = USD").
 * Only counts, JSON types, signs and the currency code are reported: never an amount, a PnL value, an id or a key.
 */
export interface ValuationEvidence {
  readonly positions: number;
  /** positions[].unrealizedPnL: how many are an object, null, missing, or another type. */
  readonly unrealizedPnlObject: Readonly<Record<'object' | 'null' | 'missing' | 'other', number>>;
  /** positions[].unrealizedPnL.pnL, over the positions whose unrealizedPnL is an object. */
  readonly pnL: {
    readonly type: Readonly<Record<PnlValueType, number>>;
    /** How many are a finite number (an overflowing JSON literal parses to Infinity and is not finite). */
    readonly finite: number;
    readonly sign: Readonly<Record<PnlSign, number>>;
  };
  readonly accountCurrencyId: {
    readonly present: boolean;
    readonly kind: JsonKind | 'missing';
    /** The numeric currency code when it is a non-negative safe integer, else null. A currency code, not an account id. */
    readonly code: number | null;
  };
  /** The two gaps as checks. null for G1 when there is no position (nothing to prove). */
  readonly checks: {
    readonly allPositionPnlFiniteNumbers: boolean | null;
    readonly accountCurrencyIsUsd: boolean;
  };
}

/** The valuation evidence of a /demo/pnl body. Pure; reads only the two fields of the gaps. */
export function valuationEvidenceOf(body: unknown): ValuationEvidence {
  const cp = isObject(body) && isObject(body.clientPortfolio) ? body.clientPortfolio : null;
  const positions = cp !== null && Array.isArray(cp.positions) ? cp.positions : [];
  const container = { object: 0, null: 0, missing: 0, other: 0 };
  const type: Record<PnlValueType, number> = { number: 0, null: 0, missing: 0, other: 0 };
  const sign: Record<PnlSign, number> = { positive: 0, negative: 0, zero: 0, not_applicable: 0 };
  let finite = 0;
  for (const position of positions) {
    const u = isObject(position) ? position.unrealizedPnL : undefined;
    if (u === undefined) container.missing++;
    else if (u === null) container.null++;
    else if (isObject(u)) container.object++;
    else container.other++;
    if (!isObject(u)) continue;
    const v = u.pnL;
    const t: PnlValueType = v === undefined ? 'missing' : v === null ? 'null' : typeof v === 'number' ? 'number' : 'other';
    type[t]++;
    if (typeof v === 'number' && Number.isFinite(v)) {
      finite++;
      sign[signOf(v)]++;
    } else {
      sign.not_applicable++;
    }
  }
  const raw = cp === null ? undefined : cp.accountCurrencyId;
  const code = typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  return {
    positions: positions.length,
    unrealizedPnlObject: container,
    pnL: { type, finite, sign },
    accountCurrencyId: { present: raw !== undefined, kind: raw === undefined ? 'missing' : kindOf(raw), code },
    checks: {
      allPositionPnlFiniteNumbers: positions.length === 0 ? null : finite === positions.length,
      accountCurrencyIsUsd: code === 1,
    },
  };
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

function describeContainer(name: string, value: unknown, schema: SourceSchema, options: ObservationOptions, pseudonym: (text: string) => string): ContainerReport {
  const documentedFields = schema.elementFields[name] ?? null;
  const exampleFields = schema.exampleFields[name] ?? [];
  const nestedSchema = schema.nestedFields[name] ?? {};
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
      if (isObject(v)) {
        const inner = namedKeys(v);
        f.objectKeys = [...new Set([...(f.objectKeys ?? []), ...inner.names])].sort();
        unnamed += inner.unnamed;
      }
      if (options.pseudonymizeIds && ID_FIELDS.has(key) && (typeof v === 'number' || typeof v === 'string')) {
        (ids[key] ??= []).push(pseudonym(String(v)));
      }
      if (options.showInstrumentIds && INSTRUMENT_ID_FIELDS.has(key) && typeof v === 'number' && Number.isSafeInteger(v)) instruments.add(v);
    }
  }
  for (const [key, nested] of Object.entries(nestedSchema)) {
    const f = fields[key];
    const keys = f?.objectKeys;
    if (f && keys) f.nested = { schemaMissing: nested.filter((n) => !keys.includes(n)), undocumentedPresent: keys.filter((n) => !nested.includes(n)) };
  }
  report.fields = Object.fromEntries(Object.keys(fields).sort().map((k) => [k, fields[k]!]));
  if (unnamed > 0) report.unnamedKeys = unnamed;
  const seen = Object.keys(fields).filter((f) => f !== '<element>').sort();
  const schemaFields = documentedFields ?? [];
  report.schemaDocumentedPresent = seen.filter((f) => schemaFields.includes(f));
  if (documentedFields !== null) report.documentedMissing = documentedFields.filter((f) => !(f in fields));
  report.exampleOnlyPresent = seen.filter((f) => !schemaFields.includes(f) && exampleFields.includes(f));
  report.undocumentedPresent = seen.filter((f) => !schemaFields.includes(f) && !exampleFields.includes(f));
  if (options.pseudonymizeIds && Object.keys(ids).length > 0) {
    report.pseudonymousIds = Object.fromEntries(Object.keys(ids).sort().map((k) => [k, ids[k]!.sort()]));
  }
  if (options.showInstrumentIds && instruments.size > 0) report.instrumentIds = [...instruments].sort((a, b) => a - b);
  return report;
}

function parserVerdict(source: ObservationSource, body: unknown): ParserVerdict {
  try {
    if (source === 'pnl') {
      const parsed = parseDemoPnl(body);
      return { outcome: 'accepted', positions: parsed.positionCount, orders: parsed.orderCount, ordersForOpen: parsed.orderForOpenCount };
    }
    const parsed = parseDemoPortfolio(body);
    return { outcome: 'accepted', positions: parsed.positionCount, orders: parsed.orderCount };
  } catch (error) {
    if (error instanceof BrokerError) return { outcome: 'refused', code: error.code, detail: error.message };
    return { outcome: 'refused', code: 'UNEXPECTED', detail: 'the parser failed unexpectedly' };
  }
}

/**
 * The sanitized schema report of one demo response body of the given source. The structure is described first, from the in-memory
 * JSON; the parser verdict is computed afterwards and cannot prevent the report. The body itself is never part of the result.
 */
export function observeDemoResponse(source: ObservationSource, body: unknown, options: ObservationOptions = {}): ObservationReport {
  const schema = SCHEMAS[source];
  const salt = options.salt ?? randomBytes(32);
  const pseudonym = (text: string) => 'id_' + createHmac('sha256', salt).update(text).digest('hex').slice(0, 16);

  const top = isObject(body) ? namedKeys(body) : { names: [], unnamed: 0 };
  const cp = isObject(body) ? body.clientPortfolio : undefined;
  const cpKeys = isObject(cp) ? namedKeys(cp) : { names: [], unnamed: 0 };
  const containers: Record<string, ContainerReport> = {};
  // Every documented container, and every other array that appears in clientPortfolio.
  const containerNames = new Set<string>(Object.keys(schema.elementFields));
  if (isObject(cp)) for (const key of cpKeys.names) if (Array.isArray(cp[key])) containerNames.add(key);
  for (const name of [...containerNames].sort()) containers[name] = describeContainer(name, isObject(cp) ? cp[name] : undefined, schema, options, pseudonym);

  const described: Omit<ObservationReport, 'parser'> = {
    schema: 'etoro-demo-portfolio-observation:v1',
    source,
    endpoint: schema.endpoint,
    topLevelKeys: top.names,
    topLevelUnnamedKeys: top.unnamed,
    clientPortfolio: {
      kind: cp === undefined ? 'missing' : kindOf(cp),
      keys: cpKeys.names,
      unnamedKeys: cpKeys.unnamed,
      undocumentedKeys: cpKeys.names.filter((k) => !schema.clientPortfolioFields.includes(k)),
      documentedMissing: schema.clientPortfolioFields.filter((k) => !cpKeys.names.includes(k)),
      credit: scalarSummary(isObject(cp) ? cp.credit : undefined),
      bonusCredit: scalarSummary(isObject(cp) ? cp.bonusCredit : undefined),
    },
    containers,
    ...(source === 'pnl' ? { valuationEvidence: valuationEvidenceOf(body) } : {}),
  };
  return { ...described, parser: parserVerdict(source, body) };
}

/** The O21A portfolio report: observeDemoResponse('portfolio', ...). */
export function observeDemoPortfolio(body: unknown, options: ObservationOptions = {}): ObservationReport {
  return observeDemoResponse('portfolio', body, options);
}
