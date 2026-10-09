// In-memory Point-in-Time Universe store (append-only). The PostgreSQL store (persistence/postgres/postgres-universe-store.ts) implements
// the same semantics, and both run the same pure rules in universe-model.ts (prepareRevision, planRevision, selectRevision, evidenceOf),
// so they cannot disagree. Ingest is idempotent per content; a different content for the same key is the next revision. Nothing is
// overwritten and nothing is removed.

import { hashOf } from '../persistence/canonical-json.js';
import {
  UniverseError,
  evidenceOf,
  normalizeDefinition,
  normalizeSource,
  planRevision,
  prepareRevision,
  selectRevision,
  selectionOf,
  type MemberResolver,
  type StoredUniverseRevision,
  type UniverseDefinition,
  type UniverseReplayMode,
  type UniverseSelection,
  type UniverseSnapshotInput,
  type UniverseSource,
  instantOf,
} from './universe-model.js';

export type { MemberResolver } from './universe-model.js';

export interface UniverseSelectionQuery {
  universeId: string;
  sourceId: string;
  asOf: string;
  mode: UniverseReplayMode;
  /** Only revisions with ingestSeq <= storedThrough are visible: a backfill stored later cannot change this replay. */
  storedThrough?: number;
}

export class InMemoryUniverseStore {
  private readonly sources = new Map<string, UniverseSource>();
  private readonly definitions = new Map<string, UniverseDefinition>();
  private readonly revisions: StoredUniverseRevision[] = [];
  private sequence = 0;

  registerSource(source: UniverseSource): void {
    const normalized = normalizeSource(source);
    const existing = this.sources.get(normalized.sourceId);
    if (existing && hashOf(existing) !== hashOf(normalized)) {
      throw new UniverseError('UNIVERSE_CONFLICT', 'source ' + normalized.sourceId + ' is already registered with different content');
    }
    this.sources.set(normalized.sourceId, Object.freeze(normalized));
  }

  registerDefinition(definition: UniverseDefinition): void {
    const normalized = normalizeDefinition(definition);
    const existing = this.definitions.get(normalized.universeId);
    if (existing && hashOf(existing) !== hashOf(normalized)) {
      throw new UniverseError('UNIVERSE_CONFLICT', 'universe ' + normalized.universeId + ' is already defined with different content');
    }
    this.definitions.set(normalized.universeId, Object.freeze(normalized));
  }

  source(sourceId: string): UniverseSource | undefined {
    return this.sources.get(sourceId);
  }

  /** Current ingest sequence: the stored-through anchor of a replay taken now. */
  currentIngestSeq(): number {
    return this.sequence;
  }

  /**
   * Ingests one complete (or explicitly partial) snapshot. Unresolved members: refused in a complete snapshot; recorded and visible in a
   * partial one. Identical content for the same key is idempotent (the first knowledge stands). Different content is the next revision.
   */
  ingest(input: UniverseSnapshotInput, resolve: MemberResolver): { status: 'APPLIED' | 'ALREADY_APPLIED'; revision: StoredUniverseRevision } {
    const prepared = prepareRevision(input, this.definitions.get(input.universeId), this.sources.get(input.sourceId), resolve);
    const existing = this.revisions.filter((r) => r.snapshotKey === prepared.snapshotKey);
    const plan = planRevision(prepared, existing, this.sequence);
    if (plan.status === 'ALREADY_APPLIED') {
      const same = this.revisionById(plan.snapshotRevisionId);
      if (!same) throw new UniverseError('UNIVERSE_INTEGRITY_FAILED', 'an identical revision is recorded but cannot be found');
      return { status: 'ALREADY_APPLIED', revision: same };
    }
    this.sequence = plan.revision.ingestSeq;
    this.revisions.push(plan.revision);
    return { status: 'APPLIED', revision: plan.revision };
  }

  /** Selects the revision for a request and derives its evidence. The caller cannot change the evidence. */
  select(q: UniverseSelectionQuery): UniverseSelection {
    const definition = this.definitions.get(q.universeId);
    if (!definition) throw new UniverseError('UNIVERSE_NOT_FOUND', 'universe ' + q.universeId + ' is not defined');
    const asOf = instantOf(q.asOf, 'asOf');
    const revisions = this.revisions.filter((r) => r.universeId === q.universeId);
    const revision = selectRevision(revisions, { sourceId: q.sourceId, asOf, mode: q.mode, ...(q.storedThrough !== undefined ? { storedThrough: q.storedThrough } : {}) });
    const evidence = evidenceOf(revision, { universeId: q.universeId, definitionVersion: definition.definitionVersion, sourceId: q.sourceId, source: this.sources.get(q.sourceId), asOf, mode: q.mode });
    return selectionOf(revision, evidence);
  }

  revisionById(snapshotRevisionId: string): StoredUniverseRevision | null {
    return this.revisions.find((r) => r.snapshotRevisionId === snapshotRevisionId) ?? null;
  }

  /** Every stored revision, in ingest order. For audit and integrity checks. */
  all(): readonly StoredUniverseRevision[] {
    return [...this.revisions].sort((a, b) => a.ingestSeq - b.ingestSeq);
  }
}
