// IBKR read-only errors. Messages are fixed text written by this code base. A detail is only ever a field name or a
// reason code from this code base: never a URL, a header, a cookie, a token, an account id, or a driver message.

export type IbkrErrorCode =
  | 'BROKER_NOT_CONNECTED'
  | 'BROKER_AUTH_REQUIRED'
  | 'BROKER_ACCOUNT_NOT_FOUND'
  | 'BROKER_ACCOUNT_AMBIGUOUS'
  | 'BROKER_RESPONSE_INVALID'
  | 'BROKER_TIMEOUT'
  | 'BROKER_RATE_LIMITED'
  | 'BROKER_INSTRUMENT_UNMAPPED'
  | 'BROKER_SNAPSHOT_STALE'
  | 'BROKER_RECONCILIATION_FAILURE'
  | 'BROKER_SESSION_COMPETING'
  | 'BROKER_BROKERAGE_INIT_FAILED';

const FIXED_MESSAGE: Readonly<Record<IbkrErrorCode, string>> = Object.freeze({
  BROKER_NOT_CONNECTED: 'the IBKR Client Portal Gateway is not reachable or its certificate is not trusted',
  BROKER_AUTH_REQUIRED: 'the IBKR session is not authenticated: log in to the Client Portal Gateway in the browser',
  BROKER_ACCOUNT_NOT_FOUND: 'the configured IBKR account is not among the accounts this session can read',
  BROKER_ACCOUNT_AMBIGUOUS: 'several IBKR accounts are readable and none is configured: refusing to choose one',
  BROKER_RESPONSE_INVALID: 'the IBKR response does not match the expected read-only schema',
  BROKER_TIMEOUT: 'the IBKR gateway did not answer in time',
  BROKER_RATE_LIMITED: 'the IBKR request rate limit applies: no retry is made',
  BROKER_INSTRUMENT_UNMAPPED: 'the IBKR contract cannot be linked to this NEXUS instrument: no identity-safe mapping exists',
  BROKER_SNAPSHOT_STALE: 'the broker snapshot is older than the freshness limit and is not current broker state',
  BROKER_RECONCILIATION_FAILURE: 'the reconciliation could not be computed from the stored snapshot and ledger',
  BROKER_SESSION_COMPETING: 'another IBKR brokerage session is active: this build does not take it over',
  BROKER_BROKERAGE_INIT_FAILED: 'the IBKR brokerage session could not be started and verified as authenticated and connected',
});

export class IbkrError extends Error {
  override readonly name = 'IbkrError';
  constructor(
    readonly code: IbkrErrorCode,
    detail?: string,
  ) {
    super(code + ': ' + FIXED_MESSAGE[code] + (detail ? ' (' + detail + ')' : ''));
  }
}
