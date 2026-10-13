import { createHash } from 'node:crypto';
import { Decimal } from '../money/decimal.js';

/**
 * Deterministic JSON: sorted keys, undefined dropped, bigint and Decimal as strings.
 * The same value always yields the same bytes, so hashes are stable across processes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Decimal) return JSON.stringify(value.toString());
  if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  if (typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v));
    return '{' + fields.join(',') + '}';
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
  return JSON.stringify(value);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
