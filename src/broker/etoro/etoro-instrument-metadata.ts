// O22: the strict parser and report of the one fixed instrument metadata read (instrument.metadata.100001), following the official
// reference "Search for Securities Instruments by ID or Symbol" (GET /api/v2/market-data/instruments, checked 2026-10-18). Untrusted
// input: fail closed, no coercion, unknown fields ignored. The report keeps exactly four public instrument fields (id, type, symbol,
// display name) and no account data. It is evidence for a human mapping decision; nothing is registered or mapped from it.

import { BrokerError } from '../broker-errors.js';

export const INSTRUMENT_METADATA_REPORT_VERSION = 'etoro-instrument-metadata-observation:v1' as const;
/** The one eToro instrument this build may look up: the instrument of the position observed in the demo portfolio (O21B/O21C). */
export const METADATA_INSTRUMENT_ID = 100001;

/** The `type` enum of the reference. */
export const ETORO_INSTRUMENT_TYPES = ['Forex', 'Commodity', 'CFD', 'Indices', 'Stocks', 'ETF', 'Bonds', 'TrustFunds', 'Options', 'Crypto'] as const;
export type EtoroInstrumentType = (typeof ETORO_INSTRUMENT_TYPES)[number];

export interface EtoroInstrumentMetadata {
  readonly instrumentId: number;
  readonly type: EtoroInstrumentType;
  readonly symbol: string;
  readonly displayName: string;
}

export type InstrumentMetadataReport =
  | { readonly schema: typeof INSTRUMENT_METADATA_REPORT_VERSION; readonly endpoint: string; readonly verdict: 'accepted'; readonly metadata: EtoroInstrumentMetadata }
  | { readonly schema: typeof INSTRUMENT_METADATA_REPORT_VERSION; readonly endpoint: string; readonly verdict: 'refused'; readonly code: string; readonly detail: string };

export const METADATA_ENDPOINT = 'GET /api/v2/market-data/instruments?instrumentsIds=' + METADATA_INSTRUMENT_ID;

const CONTROL = /[\u0000-\u001f\u007f]/;
const SYMBOL = /^[A-Za-z0-9._/-]{1,32}$/;

function invalid(detail: string): BrokerError {
  return new BrokerError('BROKER_RESPONSE_INVALID', detail);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(path + ' is not an object');
  return value as Record<string, unknown>;
}

/** Exactly one result, for exactly the requested instrument id, with a documented type and a printable symbol and display name. */
export function parseInstrumentMetadata(body: unknown, expectedInstrumentId: number = METADATA_INSTRUMENT_ID): EtoroInstrumentMetadata {
  const root = objectAt(body, 'response');
  const results = root.results;
  if (!Array.isArray(results)) throw invalid('results is not an array');
  if (results.length === 0) throw new BrokerError('BROKER_RESPONSE_INVALID', 'results is empty: the instrument was not found');
  if (results.length !== 1) throw invalid('results has more than one entry');
  const entry = objectAt(results[0], 'results[0]');
  const id = entry.instrumentId;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw invalid('results[0].instrumentId is not a positive integer id');
  if (id !== expectedInstrumentId) throw invalid('results[0].instrumentId is not the requested instrument');
  const type = entry.type;
  if (typeof type !== 'string' || !(ETORO_INSTRUMENT_TYPES as readonly string[]).includes(type)) throw invalid('results[0].type is not a documented instrument type');
  const symbol = entry.symbol;
  if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) throw invalid('results[0].symbol is not a printable symbol');
  const displayName = entry.displayName;
  if (typeof displayName !== 'string' || displayName.trim() === '' || displayName.length > 100 || CONTROL.test(displayName)) throw invalid('results[0].displayName is not a printable name');
  return Object.freeze({ instrumentId: id, type: type as EtoroInstrumentType, symbol, displayName });
}

/** The report of one metadata read. A refusal carries the fixed code and the field path, never a value. */
export function instrumentMetadataReport(body: unknown): InstrumentMetadataReport {
  try {
    return { schema: INSTRUMENT_METADATA_REPORT_VERSION, endpoint: METADATA_ENDPOINT, verdict: 'accepted', metadata: parseInstrumentMetadata(body) };
  } catch (error) {
    if (error instanceof BrokerError) return { schema: INSTRUMENT_METADATA_REPORT_VERSION, endpoint: METADATA_ENDPOINT, verdict: 'refused', code: error.code, detail: error.message };
    return { schema: INSTRUMENT_METADATA_REPORT_VERSION, endpoint: METADATA_ENDPOINT, verdict: 'refused', code: 'UNEXPECTED', detail: 'the parser failed unexpectedly' };
  }
}
