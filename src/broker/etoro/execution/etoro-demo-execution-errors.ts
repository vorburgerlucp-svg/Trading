// Errors of the eToro demo execution layer (O21). Messages are fixed text written by this code base. A detail is only ever a field
// name, a state name or a gate reason code from this code base: never a URL, a header, a key, an account identifier or a response body.

export type DemoExecutionErrorCode =
  | 'EXECUTION_DISABLED'
  | 'EXECUTION_LOCKED_IN_BUILD'
  | 'INTENT_INVALID'
  | 'INTENT_NOT_FOUND'
  | 'INTENT_DUPLICATE'
  | 'INTENT_STATE_INVALID'
  | 'APPROVAL_INVALID'
  | 'OPERATOR_INVALID'
  | 'GATE_REFUSED'
  | 'BROKER_AUTH_REQUIRED'
  | 'BROKER_RATE_LIMITED'
  | 'BROKER_REJECTED'
  | 'BROKER_RESPONSE_INVALID'
  | 'BROKER_NOT_CONNECTED'
  | 'EXECUTION_AMBIGUOUS'
  | 'RECONCILIATION_PENDING';

const FIXED_MESSAGE: Readonly<Record<DemoExecutionErrorCode, string>> = Object.freeze({
  EXECUTION_DISABLED: 'eToro demo execution is not enabled for this process',
  EXECUTION_LOCKED_IN_BUILD: 'eToro demo execution is locked in this build',
  INTENT_INVALID: 'the execution intent is invalid',
  INTENT_NOT_FOUND: 'no such execution intent',
  INTENT_DUPLICATE: 'an equivalent execution intent is already active',
  INTENT_STATE_INVALID: 'the execution intent is not in a state that allows this step',
  APPROVAL_INVALID: 'the approval is invalid: a named human must approve',
  OPERATOR_INVALID: 'a broker write needs an authenticated human operator: nothing was sent to the broker',
  GATE_REFUSED: 'the execution gate refused the request: nothing was sent to the broker',
  BROKER_AUTH_REQUIRED: 'the broker rejected the credentials or the scope: demo write permission is required',
  BROKER_RATE_LIMITED: 'the broker rate limit applies: no retry is made',
  BROKER_REJECTED: 'the broker rejected the request',
  BROKER_RESPONSE_INVALID: 'the broker response does not match the expected demo execution schema',
  BROKER_NOT_CONNECTED: 'the broker is not reachable',
  EXECUTION_AMBIGUOUS: 'the outcome at the broker is unknown: the intent is AMBIGUOUS and is never resent; reconcile it first',
  RECONCILIATION_PENDING: 'the broker state does not yet decide the outcome: reconcile again later',
});

export class DemoExecutionError extends Error {
  override readonly name = 'DemoExecutionError';
  constructor(
    readonly code: DemoExecutionErrorCode,
    detail?: string,
    /** Gate reason codes (fixed strings of this code base), when code is GATE_REFUSED. */
    readonly reasons: readonly string[] = [],
  ) {
    super(code + ': ' + FIXED_MESSAGE[code] + (detail ? ' (' + detail + ')' : ''));
  }
}
