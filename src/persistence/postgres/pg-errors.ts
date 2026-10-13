import { LedgerError } from '../../capital/ledger-errors.js';
import { AppendOnlyLogError } from '../append-only-log.js';

/** PostgreSQL SQLSTATE codes we react to. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';
const RAISE_EXCEPTION = 'P0001';
const LOCK_NOT_AVAILABLE = '55P03';
const SERIALIZATION_FAILURE = '40001';
const DEADLOCK = '40P01';

interface PgErrorLike {
  code?: string;
  message: string;
  constraint?: string;
}

function asPg(error: unknown): PgErrorLike | null {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as PgErrorLike).code === 'string' && 'message' in error) return error as PgErrorLike;
  return null;
}

/** A database refusal of a ledger write becomes a LedgerError('store_rejected'); nothing is retried silently. */
export function mapLedgerDbError(error: unknown): unknown {
  const pgError = asPg(error);
  if (!pgError) return error;
  if ([UNIQUE_VIOLATION, FOREIGN_KEY_VIOLATION, CHECK_VIOLATION, NOT_NULL_VIOLATION, RAISE_EXCEPTION].includes(pgError.code ?? '')) {
    return new LedgerError('store_rejected', 'database rejected the ledger write (' + pgError.code + (pgError.constraint ? ' ' + pgError.constraint : '') + '): ' + pgError.message);
  }
  if ([LOCK_NOT_AVAILABLE, SERIALIZATION_FAILURE, DEADLOCK].includes(pgError.code ?? '')) {
    return new LedgerError('store_unavailable', 'ledger is busy (' + pgError.code + '); nothing was written, retry with the same idempotency key');
  }
  return error;
}

export function mapLogDbError(error: unknown): unknown {
  const pgError = asPg(error);
  if (!pgError) return error;
  if ([UNIQUE_VIOLATION, FOREIGN_KEY_VIOLATION, CHECK_VIOLATION, NOT_NULL_VIOLATION, RAISE_EXCEPTION].includes(pgError.code ?? '')) {
    return new AppendOnlyLogError('store_conflict', 'database rejected the log write (' + pgError.code + (pgError.constraint ? ' ' + pgError.constraint : '') + '): ' + pgError.message);
  }
  return error;
}
