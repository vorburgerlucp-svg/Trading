// Evidence registry: append-only, point-in-time aware. Every claim NEXUS relies on must point here.

import { AppendOnlyLog, InMemoryAppendOnlyStore, type AppendOnlyStore } from '../persistence/append-only-log.js';
import { sha256Hex } from '../persistence/canonical-json.js';
import { EXTERNAL_TEXT_TYPES, type EvidenceAssessment, type EvidenceRef } from './evidence-types.js';

export class EvidenceError extends Error {
  override readonly name = 'EvidenceError';
}

export interface EvidenceRecord {
  ref: EvidenceRef;
  /** Raw content for external text (news, web). Only ever handed to models as quoted, untrusted data. */
  content?: string;
}

export class EvidenceStore {
  private constructor(private readonly log: AppendOnlyLog<EvidenceRecord>) {}

  static async open(store: AppendOnlyStore<EvidenceRecord> = new InMemoryAppendOnlyStore(), options: { clock?: () => Date } = {}): Promise<EvidenceStore> {
    return new EvidenceStore(await AppendOnlyLog.open('evidence', store, options));
  }

  async register(ref: EvidenceRef, content?: string): Promise<EvidenceRef> {
    const errors = validateRef(ref);
    if (errors.length > 0) throw new EvidenceError('invalid evidence "' + ref.id + '": ' + errors.join('; '));
    const normalized: EvidenceRef = {
      ...ref,
      // External text is external text, whatever the caller says.
      contentKind: EXTERNAL_TEXT_TYPES.includes(ref.type) ? 'external_text' : ref.contentKind,
      ...(content !== undefined ? { contentHash: sha256Hex(content) } : {}),
    };
    const record = await this.log.append(ref.id, content === undefined ? { ref: normalized } : { ref: normalized, content });
    return record.payload.ref;
  }

  get(id: string): EvidenceRef | undefined {
    return this.log.get(id)?.payload.ref;
  }

  /** Status of a reference at decision time `asOf`. */
  assess(id: string, asOf: string): EvidenceAssessment {
    const ref = this.get(id);
    if (!ref) return { id, status: 'unknown', ageMs: null, trusted: false, ref: null };
    const asOfMs = Date.parse(asOf);
    if (Date.parse(ref.availableAt) > asOfMs) return { id, status: 'not_yet_available', ageMs: null, trusted: ref.trusted, ref };
    const ageMs = asOfMs - Date.parse(ref.observedAt);
    if (ref.freshnessMs === undefined) return { id, status: 'timeless', ageMs, trusted: ref.trusted, ref };
    return { id, status: ageMs <= ref.freshnessMs ? 'fresh' : 'stale', ageMs, trusted: ref.trusted, ref };
  }

  /** All evidence that existed for NEXUS at `asOf` (point-in-time view for replay). */
  visibleAsOf(asOf: string): EvidenceRef[] {
    const asOfMs = Date.parse(asOf);
    return this.log
      .all()
      .map((r) => r.payload.ref)
      .filter((ref) => Date.parse(ref.availableAt) <= asOfMs);
  }

  /** Content of external text evidence, only if visible at `asOf`. */
  content(id: string, asOf: string): string | undefined {
    const record = this.log.get(id);
    if (!record || this.assess(id, asOf).status === 'not_yet_available') return undefined;
    return record.payload.content;
  }

  /** Version identifier of a reference (hash of the stored record) for the audit trail. */
  version(id: string): string | undefined {
    return this.log.get(id)?.hash;
  }

  verifyIntegrity() {
    return this.log.verifyIntegrity();
  }
}

function validateRef(ref: EvidenceRef): string[] {
  const errors: string[] = [];
  if (ref.id.trim() === '') errors.push('id is required');
  if (ref.source.trim() === '') errors.push('source is required');
  const observed = Date.parse(ref.observedAt);
  const available = Date.parse(ref.availableAt);
  const retrieved = Date.parse(ref.retrievedAt);
  if ([observed, available, retrieved].some(Number.isNaN)) errors.push('observedAt, availableAt and retrievedAt must be ISO timestamps');
  if (available < observed) errors.push('availableAt cannot be before observedAt');
  if (retrieved < available) errors.push('retrievedAt cannot be before availableAt');
  if (ref.freshnessMs !== undefined && !(ref.freshnessMs > 0)) errors.push('freshnessMs must be positive');
  return errors;
}
