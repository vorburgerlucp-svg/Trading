// Read-only broker errors, shared by the broker adapters. Messages are fixed text written by this code base. A detail is only ever a
// field name or a reason from this code base: never a URL, a header, a key, an account identifier or a response body.

export type BrokerErrorCode =
  | 'BROKER_NOT_CONNECTED'
  | 'BROKER_AUTH_REQUIRED'
  | 'BROKER_RESPONSE_INVALID'
  | 'BROKER_TIMEOUT'
  | 'BROKER_RATE_LIMITED'
  | 'BROKER_SNAPSHOT_STALE'
  | 'BROKER_RECONCILIATION_FAILURE';

const FIXED_MESSAGE: Readonly<Record<BrokerErrorCode, string>> = Object.freeze({
  BROKER_NOT_CONNECTED: 'the broker is not reachable, or the read-only sync is not enabled for this process',
  BROKER_AUTH_REQUIRED: 'the broker rejected the credentials or the session: check the configured keys for the demo environment',
  BROKER_RESPONSE_INVALID: 'the broker response does not match the expected read-only schema',
  BROKER_TIMEOUT: 'the broker did not answer in time',
  BROKER_RATE_LIMITED: 'the broker rate limit applies: no retry is made',
  BROKER_SNAPSHOT_STALE: 'the broker snapshot is older than the freshness limit and is not current broker state',
  BROKER_RECONCILIATION_FAILURE: 'the reconciliation could not be computed from the stored snapshot and ledger',
});

export class BrokerError extends Error {
  override readonly name = 'BrokerError';
  constructor(
    readonly code: BrokerErrorCode,
    detail?: string,
  ) {
    super(code + ': ' + FIXED_MESSAGE[code] + (detail ? ' (' + detail + ')' : ''));
  }
}
