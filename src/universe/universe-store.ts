// In-memory Point-in-Time Universe store (append-only). The PostgreSQL store (persistence/postgres/postgres-universe-store.ts) implements
// the same semantics, and both run the same pure rules in universe-model.ts, so they cannot disagree. Ingest is idempotent per content;
// a different content for the same key is the next revision. Nothing is overwritten and nothing is removed.
//
// The clock is injected. It is a TEST DOUBLE for the database clock: production uses PostgreSQL. The store reads it twice per ingest,
// exactly as the PostgreSQL store reads the database clock: recordedAt before the commit, sealedAt after it.

import { hashOf } from '../persistence/canonical-json.js';
import {
  UniverseError,
  assertTimingProof,
  evidenceOf,
  instantOf,
  normalizeDefinition,
  normalizeSource,
  planRevision,
  prepareRevision,
  selectRevision,
  selectionOf,
  timingProofFor,
  type MemberResolver,
  type StoredUniverseRevision,
  type UniverseClock,
  type UniverseDefinition,
  type UniverseReplayMode,
  type UniverseSelection,
  type UniverseSnapshotInput,
  type UniverseSource,
  type UniverseTimingProof,
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

export interface InMemoryUniverseStoreOptions {
  /** The store's clock (a test double for the database clock). */
  clock: UniverseClock;
  /** Test hook between the commit and the seal. A throw here leaves a committed revision without a timing proof (a crash in that gap). */
  afterCommit?: () => void;
}

export class InMemoryUniverseStore {
  private readonly sources = new Map<string, UniverseSource>();
  private readonly definitions = new Map<string, UniverseDefinition>();
  private readonly revisions: StoredUniverseRevision[] = [];
  private readonly proofs = new Map<string, UniverseTimingProof>();
  private sequence = 0;

  constructor(private readonly options: InMemoryUniverseStoreOptions) {}

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
   * Ingests one complete (or explicitly partial) snapshot and seals it. Unresolved members: refused in a complete snapshot; recorded and
   * visible in a partial one. Identical content for the same key is idempotent. Different content is the next revision.
   * An already-stored revision without a timing proof (a crash between commit and seal) gets a PRESENCE_ATTESTATION here, at this time.
   */
  ingest(
    input: UniverseSnapshotInput,
    resolve: MemberResolver,
  ): { status: 'APPLIED' | 'ALREADY_APPLIED'; revision: StoredUniverseRevision; timingProof: UniverseTimingProof } {
    const recordedAt = instantOf(this.options.clock(), 'store clock');
    const prepared = prepareRevision(input, this.definitions.get(input.universeId), this.sources.get(input.sourceId), resolve, recordedAt);
    const existing = this.revisions.filter((r) => r.snapshotKey === prepared.snapshotKey);
    const plan = planRevision(prepared, existing, this.sequence);
    if (plan.status === 'ALREADY_APPLIED') {
      const same = this.revisionById(plan.snapshotRevisionId);
      if (!same) throw new UniverseError('UNIVERSE_INTEGRITY_FAILED', 'an identical revision is recorded but cannot be found');
      const existingProof = this.proofs.get(same.snapshotRevisionId);
      if (existingProof) return { status: 'ALREADY_APPLIED', revision: same, timingProof: existingProof };
      const attestedAt = instantOf(this.options.clock(), 'store clock');
      return { status: 'ALREADY_APPLIED', revision: same, timingProof: this.seal(same, attestedAt, 'PRESENCE_ATTESTATION') };
    }
    // The commit.
    this.sequence = plan.revision.ingestSeq;
    this.revisions.push(plan.revision);
    this.options.afterCommit?.();
    return { status: 'APPLIED', revision: plan.revision, timingProof: this.seal(plan.revision, recordedAt, 'COMMIT_SEAL') };
  }

  /** The seal, read after the commit. Its sealedAt is an upper bound on the commit time. */
  private seal(revision: StoredUniverseRevision, recordedAt: string, proofKind: UniverseTimingProof['proofKind']): UniverseTimingProof {
    const sealedAt = instantOf(this.options.clock(), 'store clock');
    const proof = timingProofFor({ snapshotRevisionId: revision.snapshotRevisionId, proofKind, resultHash: hashOf(revision), recordedAt, sealedAt });
    this.proofs.set(revision.snapshotRevisionId, proof);
    return proof;
  }

  /** Selects the revision for a request and derives its evidence. The caller cannot change the evidence. */
  select(q: UniverseSelectionQuery): UniverseSelection {
    const definition = this.definitions.get(q.universeId);
    if (!definition) throw new UniverseError('UNIVERSE_NOT_FOUND', 'universe ' + q.universeId + ' is not defined');
    const asOf = instantOf(q.asOf, 'asOf');
    const revisions = this.revisions.filter((r) => r.universeId === q.universeId);
    const selected = selectRevision(revisions, { sourceId: q.sourceId, asOf, mode: q.mode, ...(q.storedThrough !== undefined ? { storedThrough: q.storedThrough } : {}) }, (id) => this.proofs.get(id) ?? null);
    if (selected?.proof) assertTimingProof(selected.proof, selected.revision);
    const evidence = evidenceOf(selected, { universeId: q.universeId, definitionVersion: definition.definitionVersion, sourceId: q.sourceId, source: this.sources.get(q.sourceId), asOf, mode: q.mode });
    return selectionOf(selected, evidence);
  }

  revisionById(snapshotRevisionId: string): StoredUniverseRevision | null {
    return this.revisions.find((r) => r.snapshotRevisionId === snapshotRevisionId) ?? null;
  }

  /** NEXUS's timing proof of a revision, or null when none was written (a crash gap, or a revision before sealing). */
  timingProofOf(snapshotRevisionId: string): UniverseTimingProof | null {
    return this.proofs.get(snapshotRevisionId) ?? null;
  }

  /** Every stored revision, in ingest order. For audit and integrity checks. */
  all(): readonly StoredUniverseRevision[] {
    return [...this.revisions].sort((a, b) => a.ingestSeq - b.ingestSeq);
  }
}
