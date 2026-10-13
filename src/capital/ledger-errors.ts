export type LedgerErrorCode =
  | 'invalid_entry'
  | 'unbalanced'
  | 'unsupported_currency'
  | 'idempotency_conflict'
  | 'unknown_entry'
  | 'already_reversed'
  | 'guard_rejected'
  | 'store_rejected'
  | 'store_unavailable';

export class LedgerError extends Error {
  override readonly name = 'LedgerError';
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
  }
}
