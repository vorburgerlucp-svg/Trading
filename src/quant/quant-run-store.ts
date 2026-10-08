// Quant run audit store. A run is immutable; its id is derived from the input fingerprint, so
// saving the same computation twice is idempotent (ALREADY_APPLIED). The same id with a DIFFERENT
// result means the engine is not deterministic or an algorithm changed without a version bump —
// that is refused loudly (QuantRunConflictError), never overwritten.

import { decodeJson, encodeJson } from '../persistence/json-codec.js';
import { quantResultHash } from './quant-engine.js';
import type { QuantResult, QuantRunRecord } from './quant-types.js';

export class QuantRunConflictError extends Error {
  override readonly name = 'QuantRunConflictError';
  readonly code = 'QUANT_RUN_CONFLICT' as const;
}

export class QuantRunIntegrityError extends Error {
  override readonly name = 'QuantRunIntegrityError';
  readonly code = 'QUANT_RUN_INTEGRITY_ERROR' as const;
}

export interface QuantRunStore {
  save(record: QuantRunRecord): Promise<'APPLIED' | 'ALREADY_APPLIED'>;
  get(quantRunId: string): Promise<QuantRunRecord | null>;
  list(filter?: { instrumentId?: string }): Promise<QuantRunRecord[]>;
}

export function toRunRecord(result: QuantResult, storedThrough: number | null): QuantRunRecord {
  return { result, resultHash: quantResultHash(result), storedThrough, createdAt: result.createdAt };
}

/** Verifies a loaded record: the stored hash must match the stored result. */
export function verifyRunRecord(record: QuantRunRecord): QuantRunRecord {
  if (quantResultHash(record.result) !== record.resultHash) throw new QuantRunIntegrityError('quant run ' + record.result.quantRunId + ' does not match its result hash (stored data was altered)');
  return record;
}

export class InMemoryQuantRunStore implements QuantRunStore {
  private readonly runs = new Map<string, string>();

  async save(record: QuantRunRecord): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    verifyRunRecord(record);
    const existing = this.runs.get(record.result.quantRunId);
    if (existing) {
      const stored = decodeJson(JSON.parse(existing)) as QuantRunRecord;
      if (stored.resultHash !== record.resultHash) throw new QuantRunConflictError('quant run ' + record.result.quantRunId + ' already exists with a different result (non-determinism or unversioned algorithm change)');
      return 'ALREADY_APPLIED';
    }
    // Stored serialized (like the database) so callers cannot mutate the audit record afterwards.
    this.runs.set(record.result.quantRunId, JSON.stringify(encodeJson(record)));
    return 'APPLIED';
  }

  async get(quantRunId: string): Promise<QuantRunRecord | null> {
    const raw = this.runs.get(quantRunId);
    return raw ? verifyRunRecord(decodeJson(JSON.parse(raw)) as QuantRunRecord) : null;
  }

  async list(filter: { instrumentId?: string } = {}): Promise<QuantRunRecord[]> {
    const out: QuantRunRecord[] = [];
    for (const raw of this.runs.values()) {
      const r = verifyRunRecord(decodeJson(JSON.parse(raw)) as QuantRunRecord);
      if (filter.instrumentId === undefined || r.result.instrumentId === filter.instrumentId) out.push(r);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.result.quantRunId < b.result.quantRunId ? -1 : 1));
  }
}
