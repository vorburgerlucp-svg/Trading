// Runtime API errors. A client receives a stable code and a fixed message, never a stack trace, a raw provider message,
// a database detail or a secret. Domain errors are mapped here; anything unknown is INTERNAL_ERROR with no detail.

import { IndicatorError } from '../quant/indicators/common.js';
import { MarketDataError } from '../market-data/market-data-provider.js';
import { MarketDataIntegrityError, MarketDataStoreError } from '../market-data/market-data-store.js';
import { InstrumentRegistryError, InstrumentRegistryIntegrityError } from '../market-data/instrument-registry.js';
import { IbkrError } from '../broker/ibkr/ibkr-errors.js';

export type RuntimeErrorCode =
  | 'DATA_NOT_CONNECTED'
  | 'REQUEST_INVALID'
  | 'INSTRUMENT_NOT_FOUND'
  | 'MARKET_DATA_ERROR'
  | 'DATA_QUALITY_ERROR'
  | 'DATABASE_ERROR'
  | 'SAFETY_BLOCK'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'PAYLOAD_TOO_LARGE'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR'
  | 'BROKER_NOT_CONNECTED'
  | 'BROKER_AUTH_REQUIRED'
  | 'BROKER_ACCOUNT_NOT_FOUND'
  | 'BROKER_ACCOUNT_AMBIGUOUS'
  | 'BROKER_RESPONSE_INVALID'
  | 'BROKER_TIMEOUT'
  | 'BROKER_RATE_LIMITED'
  | 'BROKER_INSTRUMENT_UNMAPPED'
  | 'BROKER_SNAPSHOT_STALE'
  | 'BROKER_RECONCILIATION_FAILURE';

const FIXED_MESSAGE: Readonly<Record<RuntimeErrorCode, string>> = Object.freeze({
  DATA_NOT_CONNECTED: 'market data is not connected; no data is returned in its place',
  REQUEST_INVALID: 'the request is invalid',
  INSTRUMENT_NOT_FOUND: 'the instrument is unknown or has no mapping for this provider',
  MARKET_DATA_ERROR: 'the market data provider could not serve the request',
  DATA_QUALITY_ERROR: 'the stored data does not pass the quality checks for this request',
  DATABASE_ERROR: 'the database is unavailable or the stored data failed an integrity check',
  SAFETY_BLOCK: 'a safety rule blocks this request',
  NOT_FOUND: 'no such route',
  METHOD_NOT_ALLOWED: 'the method is not allowed on this route',
  PAYLOAD_TOO_LARGE: 'the request body is too large',
  NOT_IMPLEMENTED: 'this capability is not available in this build',
  INTERNAL_ERROR: 'internal error',
  BROKER_NOT_CONNECTED: 'the broker is not connected: nothing is returned in its place',
  BROKER_AUTH_REQUIRED: 'the broker session is not authenticated: log in to the gateway in the browser',
  BROKER_ACCOUNT_NOT_FOUND: 'the configured broker account is not readable in this session',
  BROKER_ACCOUNT_AMBIGUOUS: 'several broker accounts are readable and none is configured: refusing to choose',
  BROKER_RESPONSE_INVALID: 'the broker response does not match the expected read-only schema',
  BROKER_TIMEOUT: 'the broker gateway did not answer in time',
  BROKER_RATE_LIMITED: 'the broker request rate limit applies: no retry is made',
  BROKER_INSTRUMENT_UNMAPPED: 'the broker contract cannot be linked to a NEXUS instrument without guessing',
  BROKER_SNAPSHOT_STALE: 'the broker snapshot is stale: it is not current broker state',
  BROKER_RECONCILIATION_FAILURE: 'the reconciliation could not be computed',
});

const STATUS: Readonly<Record<RuntimeErrorCode, number>> = Object.freeze({
  DATA_NOT_CONNECTED: 503,
  REQUEST_INVALID: 400,
  INSTRUMENT_NOT_FOUND: 404,
  MARKET_DATA_ERROR: 502,
  DATA_QUALITY_ERROR: 422,
  DATABASE_ERROR: 503,
  SAFETY_BLOCK: 409,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  NOT_IMPLEMENTED: 501,
  INTERNAL_ERROR: 500,
  BROKER_NOT_CONNECTED: 503,
  BROKER_AUTH_REQUIRED: 503,
  BROKER_ACCOUNT_NOT_FOUND: 409,
  BROKER_ACCOUNT_AMBIGUOUS: 409,
  BROKER_RESPONSE_INVALID: 502,
  BROKER_TIMEOUT: 504,
  BROKER_RATE_LIMITED: 429,
  BROKER_INSTRUMENT_UNMAPPED: 409,
  BROKER_SNAPSHOT_STALE: 409,
  BROKER_RECONCILIATION_FAILURE: 500,
});

export class RuntimeApiError extends Error {
  override readonly name = 'RuntimeApiError';
  readonly status: number;
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode) {
    super(FIXED_MESSAGE[code]);
    this.code = code;
    this.status = STATUS[code];
  }
}

const MARKET_DATA_NOT_CONNECTED = new Set(['not_configured']);
const MARKET_DATA_NOT_FOUND = new Set(['not_found']);
const MARKET_DATA_REQUEST = new Set(['invalid_symbol', 'bad_request', 'unsupported']);

/** Maps any thrown value to the client-facing error. The original message is never copied into the response. */
export function toRuntimeApiError(error: unknown): RuntimeApiError {
  if (error instanceof RuntimeApiError) return error;
  if (error instanceof MarketDataError) {
    if (MARKET_DATA_NOT_CONNECTED.has(error.code)) return new RuntimeApiError('DATA_NOT_CONNECTED');
    if (MARKET_DATA_NOT_FOUND.has(error.code)) return new RuntimeApiError('INSTRUMENT_NOT_FOUND');
    if (MARKET_DATA_REQUEST.has(error.code)) return new RuntimeApiError('REQUEST_INVALID');
    return new RuntimeApiError('MARKET_DATA_ERROR');
  }
  if (error instanceof MarketDataIntegrityError) return new RuntimeApiError('DATA_QUALITY_ERROR');
  if (error instanceof IndicatorError) return new RuntimeApiError('DATA_QUALITY_ERROR');
  if (error instanceof InstrumentRegistryIntegrityError) return new RuntimeApiError('DATABASE_ERROR');
  if (error instanceof InstrumentRegistryError) {
    if (error.code === 'not_found') return new RuntimeApiError('INSTRUMENT_NOT_FOUND');
    return new RuntimeApiError('REQUEST_INVALID');
  }
  if (error instanceof MarketDataStoreError) return new RuntimeApiError('DATABASE_ERROR');
  // Broker errors carry the same code names as the client-facing codes, and their messages are fixed text of this code base.
  if (error instanceof IbkrError) return new RuntimeApiError(error.code);
  return new RuntimeApiError('INTERNAL_ERROR');
}

export function errorBody(error: RuntimeApiError): { error: { code: RuntimeErrorCode; message: string } } {
  return { error: { code: error.code, message: error.message } };
}
