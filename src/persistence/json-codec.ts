// Lossless JSON encoding for persisted payloads (PostgreSQL JSONB).
// JSON has no bigint and no exact decimal: money (bigint minor units) and Decimal quantities are
// tagged so they round-trip exactly. Plain JSON numbers are only used for scores/ratios.
// After decoding, canonicalJson() of the value is identical to the original, so hashes still verify.

import { Decimal } from '../money/decimal.js';

const BIGINT_TAG = '$bigint';
const DECIMAL_TAG = '$decimal';

export class JsonCodecError extends Error {
  override readonly name = 'JsonCodecError';
}

export function encodeJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString() };
  if (value instanceof Decimal) return { [DECIMAL_TAG]: value.toString() };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new JsonCodecError('non-finite number cannot be persisted');
    return value;
  }
  if (typeof value === 'string') {
    // PostgreSQL text/JSONB cannot store NUL characters; refuse instead of silently altering data.
    if (value.includes('\u0000')) throw new JsonCodecError('string contains a NUL character and cannot be persisted');
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : encodeJson(v)));
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new JsonCodecError('cannot persist instance of ' + (value as object).constructor?.name);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === BIGINT_TAG || k === DECIMAL_TAG) throw new JsonCodecError('reserved key ' + k);
      if (v !== undefined) out[k] = encodeJson(v);
    }
    return out;
  }
  throw new JsonCodecError('cannot persist value of type ' + typeof value);
}

export function decodeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeJson);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === BIGINT_TAG && typeof record[BIGINT_TAG] === 'string') return BigInt(record[BIGINT_TAG]);
  if (keys.length === 1 && keys[0] === DECIMAL_TAG && typeof record[DECIMAL_TAG] === 'string') return Decimal.from(record[DECIMAL_TAG]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) out[k] = decodeJson(v);
  return out;
}
