// Runtime API errors. A client receives a stable code and a fixed message, never a stack trace, a raw provider message,
// a database detail or a secret. Domain errors are mapped here; anything unknown is INTERNAL_ERROR with no detail.

import { IndicatorError } from '../quant/indicators/common.js';
import { MarketDataError } from '../market-data/market-data-provider.js';
import { MarketDataIntegrityError, MarketDataStoreError } from '../market-data/market-data-store.js';
import { InstrumentRegistryError, InstrumentRegistryIntegrityError } from '../market-data/instrument-registry.js';
import { BrokerError } from '../broker/broker-errors.js';
import { DemoExecutionError } from '../broker/etoro/execution/etoro-demo-execution-errors.js';

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
  | 'BROKER_RESPONSE_INVALID'
  | 'BROKER_TIMEOUT'
  | 'BROKER_RATE_LIMITED'
  | 'BROKER_SNAPSHOT_STALE'
  | 'BROKER_RECONCILIATION_FAILURE'
  | 'EXECUTION_DISABLED'
  | 'EXECUTION_LOCKED_IN_BUILD'
  | 'INTENT_INVALID'
  | 'APPROVAL_INVALID'
  | 'OPERATOR_INVALID'
  | 'INTENT_NOT_FOUND'
  | 'INTENT_STATE_INVALID'
  | 'INTENT_DUPLICATE'
  | 'GATE_REFUSED'
  | 'BROKER_REJECTED'
  | 'EXECUTION_AMBIGUOUS'
  | 'RECONCILIATION_PENDING'
  | 'EXTERNAL_CLOSURE_REFUSED'
  | 'EXTERNAL_CLOSURE_NOT_AVAILABLE'
  | 'CYCLE_REFUSED'
  | 'CYCLES_NOT_AVAILABLE'
  | 'OPERATOR_AUTH_REQUIRED'
  | 'OPERATOR_AUTH_NOT_CONFIGURED'
  | 'ORIGIN_REFUSED'
  | 'UNSUPPORTED_MEDIA_TYPE';

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
  BROKER_NOT_CONNECTED: 'the broker is not connected or the read-only sync is not enabled: nothing is returned in its place',
  BROKER_AUTH_REQUIRED: 'the broker rejected the credentials: check the configured demo keys',
  BROKER_RESPONSE_INVALID: 'the broker response does not match the expected read-only schema',
  BROKER_TIMEOUT: 'the broker did not answer in time',
  BROKER_RATE_LIMITED: 'the broker rate limit applies: no retry is made',
  BROKER_SNAPSHOT_STALE: 'the broker snapshot is stale: it is not current broker state',
  BROKER_RECONCILIATION_FAILURE: 'the reconciliation could not be computed',
  EXECUTION_DISABLED: 'eToro demo execution is not enabled for this process',
  EXECUTION_LOCKED_IN_BUILD: 'eToro demo execution is locked in this build: nothing was sent to the broker',
  INTENT_INVALID: 'the execution intent is invalid',
  APPROVAL_INVALID: 'the approval is invalid: a named human must approve',
  OPERATOR_INVALID: 'a broker write needs an authenticated human operator: nothing was sent to the broker',
  INTENT_NOT_FOUND: 'no such execution intent',
  INTENT_STATE_INVALID: 'the execution intent is not in a state that allows this step',
  INTENT_DUPLICATE: 'an equivalent execution intent is already active',
  GATE_REFUSED: 'the execution gate refused the request: nothing was sent to the broker',
  BROKER_REJECTED: 'the broker rejected the request',
  EXECUTION_AMBIGUOUS: 'the outcome at the broker is unknown: the intent is never resent; reconcile it first',
  RECONCILIATION_PENDING: 'the broker state does not yet decide the outcome: refresh again later',
  EXTERNAL_CLOSURE_REFUSED: 'the evidence does not prove that the position was closed outside NEXUS: nothing was recorded',
  EXTERNAL_CLOSURE_NOT_AVAILABLE: 'external closure attestations are not available in this process: nothing was recorded',
  CYCLE_REFUSED: 'the demo cycle step was refused: nothing was recorded',
  CYCLES_NOT_AVAILABLE: 'demo cycles are not available in this process: nothing was recorded',
  OPERATOR_AUTH_REQUIRED: 'operator authentication is required for this route',
  OPERATOR_AUTH_NOT_CONFIGURED: 'operator authentication is not configured: demo execution routes that change state are refused',
  ORIGIN_REFUSED: 'requests from this origin are refused',
  UNSUPPORTED_MEDIA_TYPE: 'the request body must be application/json',
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
  BROKER_RESPONSE_INVALID: 502,
  BROKER_TIMEOUT: 504,
  BROKER_RATE_LIMITED: 429,
  BROKER_SNAPSHOT_STALE: 409,
  BROKER_RECONCILIATION_FAILURE: 500,
  EXECUTION_DISABLED: 403,
  EXECUTION_LOCKED_IN_BUILD: 403,
  INTENT_INVALID: 400,
  APPROVAL_INVALID: 400,
  OPERATOR_INVALID: 403,
  INTENT_NOT_FOUND: 404,
  INTENT_STATE_INVALID: 409,
  INTENT_DUPLICATE: 409,
  GATE_REFUSED: 409,
  BROKER_REJECTED: 502,
  EXECUTION_AMBIGUOUS: 502,
  RECONCILIATION_PENDING: 409,
  EXTERNAL_CLOSURE_REFUSED: 409,
  EXTERNAL_CLOSURE_NOT_AVAILABLE: 403,
  CYCLE_REFUSED: 409,
  CYCLES_NOT_AVAILABLE: 403,
  OPERATOR_AUTH_REQUIRED: 401,
  OPERATOR_AUTH_NOT_CONFIGURED: 403,
  ORIGIN_REFUSED: 403,
  UNSUPPORTED_MEDIA_TYPE: 415,
});

export class RuntimeApiError extends Error {
  override readonly name = 'RuntimeApiError';
  readonly status: number;
  readonly code: RuntimeErrorCode;
  /** Gate reason codes: fixed strings of this code base, never a value from a request, a broker or the environment. */
  readonly reasons: readonly string[];

  constructor(code: RuntimeErrorCode, reasons: readonly string[] = []) {
    super(FIXED_MESSAGE[code]);
    this.code = code;
    this.status = STATUS[code];
    this.reasons = reasons;
  }
}

const GATE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

const MARKET_DATA_NOT_CONNECTED = new Set(['not_configured']);
const MARKET_DATA_NOT_FOUND = new Set(['not_found']);
const MARKET_DATA_REQUEST = new Set(['invalid_symbol', 'bad_request', 'unsupported']);

/** Maps any thrown value to the client-facing error. The original message is never copied into the response. */
export function toRuntimeApiError(error: unknown): RuntimeApiError {
  if (error instanceof RuntimeApiError) return error;
  if (error instanceof BrokerError) return new RuntimeApiError(error.code);
  if (error instanceof DemoExecutionError) {
    // Broker failures keep the existing broker codes; the rest map one to one. Only fixed reason codes are passed on: the gate's,
    // and (O22) the code of a refused broker answer, which names the failed field or check and never a value of the answer.
    const passes = error.code === 'GATE_REFUSED' || error.code === 'BROKER_RESPONSE_INVALID' || error.code === 'EXTERNAL_CLOSURE_REFUSED' || error.code === 'CYCLE_REFUSED';
    return new RuntimeApiError(error.code, passes ? error.reasons.filter((r) => GATE_REASON.test(r)) : []);
  }
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
  return new RuntimeApiError('INTERNAL_ERROR');
}

export function errorBody(error: RuntimeApiError): { error: { code: RuntimeErrorCode; message: string; reasons?: readonly string[] } } {
  return { error: { code: error.code, message: error.message, ...(error.reasons.length > 0 ? { reasons: error.reasons } : {}) } };
}
