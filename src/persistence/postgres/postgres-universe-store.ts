// PostgreSQL Point-in-Time Universe store (universe-engine:v1, migration 010). It has the same semantics as InMemoryUniverseStore: both run
// the pure rules of universe-model.ts, so the two cannot disagree. Writes are append-only (the database rejects UPDATE, DELETE and
// TRUNCATE). Every read rebuilds a revision from its header and member rows, recomputes its identities and compares it with the stored
// payload. A mismatch is refused: a tampered revision never becomes evidence.

import { hashOf } from '../canonical-json.js';
import { decodeJson, encodeJson } from '../json-codec.js';
import {
  UniverseError,
  assertRevisionIntegrity,
  canonicalMembers,
  canonicalUnresolved,
  evidenceOf,
  instantOf,
  normalizeDefinition,
  normalizeSource,
  planRevision,
  prepareRevision,
  selectionOf,
  type MemberResolver,
  type StoredUniverseRevision,
  type UniverseDefinition,
  type UniverseSelection,
  type UniverseSnapshotInput,
  type UniverseSource,
} from '../../universe/universe-model.js';
import type { UniverseSelectionQuery } from '../../universe/universe-store.js';
import type { PgPool, PgClient } from './pool.js';
import type { Queryable } from './postgres-scanner-backtest-store.js';

/** Canonical ISO UTC with milliseconds, exactly as the universe model writes instants. */
const ISO_MS_SQL = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** Serialises universe ingests: the ingest sequence and the revision number are decided under this advisory lock (its own namespace). */
const UNIVERSE_INGEST_LOCK = 4_242_017_002;

/** A revision row read back with its instants as canonical ISO text (never as a JS Date). */
const REVISION_COLUMNS = `snapshot_revision_id, snapshot_key, universe_id, definition_version, source_id,
  to_char(effective_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS effective_at,
  to_char(retrieved_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS retrieved_at,
  knowledge_source,
  to_char(known_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS known_at,
  vintage, vintage_policy, completeness, revision, content_hash, provenance_hash, ingest_seq, member_count, result, result_hash`;

interface RevisionRow {
  snapshot_revision_id: string;
  snapshot_key: string;
  universe_id: string;
  definition_version: string;
  source_id: string;
  effective_at: string;
  retrieved_at: string;
  knowledge_source: StoredUniverseRevision['knowledgeSource'];
  known_at: string;
  vintage: StoredUniverseRevision['vintage'];
  vintage_policy: string;
  completeness: StoredUniverseRevision['completeness'];
  revision: number;
  content_hash: string;
  provenance_hash: string;
  ingest_seq: number;
  member_count: number;
  result: unknown;
  result_hash: string;
}

interface MemberRow {
  instrument_id: string;
  source_member_key: string;
  provider_symbol: string;
  provider_instrument_id: string | null;
}

interface UnresolvedRow {
  source_member_key: string;
  provider_symbol: string;
  provider_instrument_id: string | null;
  exchange: string | null;
}

interface SourceRow {
  source_id: string;
  provider: string;
  dataset: string;
  environment: UniverseSource['environment'];
  license: UniverseSource['license'];
  license_note: string | null;
  source_hash: string;
}

interface DefinitionRow {
  universe_id: string;
  definition_version: string;
  name: string;
  definition_hash: string;
}

async function rollbackQuietly(client: { query(sql: string): Promise<unknown> }): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* the connection may already be gone; the transaction is gone with it */
  }
}

export class PostgresUniverseStore {
  constructor(private readonly pool: PgPool) {}

  async registerSource(source: UniverseSource): Promise<void> {
    const normalized = normalizeSource(source);
    const hash = hashOf(normalized);
    const inserted = await this.pool.query(
      `INSERT INTO universe_sources (source_id, provider, dataset, environment, license, license_note, source_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (source_id) DO NOTHING`,
      [normalized.sourceId, normalized.provider, normalized.dataset, normalized.environment, normalized.license, normalized.licenseNote ?? null, hash],
    );
    if (inserted.rowCount === 1) return;
    const existing = (await this.pool.query<{ source_hash: string }>('SELECT source_hash FROM universe_sources WHERE source_id = $1', [normalized.sourceId])).rows[0];
    if (existing?.source_hash !== hash) throw new UniverseError('UNIVERSE_CONFLICT', 'source ' + normalized.sourceId + ' is already registered with different content');
  }

  async registerDefinition(definition: UniverseDefinition): Promise<void> {
    const normalized = normalizeDefinition(definition);
    const hash = hashOf(normalized);
    const inserted = await this.pool.query(
      `INSERT INTO universe_definitions (universe_id, definition_version, name, definition_hash)
       VALUES ($1, $2, $3, $4) ON CONFLICT (universe_id) DO NOTHING`,
      [normalized.universeId, normalized.definitionVersion, normalized.name, hash],
    );
    if (inserted.rowCount === 1) return;
    const existing = (await this.pool.query<{ definition_hash: string }>('SELECT definition_hash FROM universe_definitions WHERE universe_id = $1', [normalized.universeId])).rows[0];
    if (existing?.definition_hash !== hash) throw new UniverseError('UNIVERSE_CONFLICT', 'universe ' + normalized.universeId + ' is already defined with different content');
  }

  async source(sourceId: string): Promise<UniverseSource | undefined> {
    return this.loadSource(this.pool, sourceId);
  }

  /** The current ingest sequence: the stored-through anchor of a replay taken now. */
  async currentIngestSeq(): Promise<number> {
    return this.ingestSeqIn(this.pool);
  }

  /**
   * Ingests one complete (or explicitly partial) snapshot. Identical content for the same key is idempotent. Different content is the next
   * revision. A COMPLETE snapshot with an unresolved member is refused before anything is written.
   */
  async ingest(input: UniverseSnapshotInput, resolve: MemberResolver): Promise<{ status: 'APPLIED' | 'ALREADY_APPLIED'; revision: StoredUniverseRevision }> {
    const client: PgClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One ingest at a time: the ingest sequence and the revision number are decided under this lock.
      await client.query('SELECT pg_advisory_xact_lock($1)', [UNIVERSE_INGEST_LOCK]);
      const prepared = prepareRevision(input, await this.loadDefinition(client, input.universeId), await this.loadSource(client, input.sourceId), resolve);
      const existing = (
        await client.query<{ snapshot_revision_id: string; revision: number; content_hash: string; known_at: string }>(
          `SELECT snapshot_revision_id, revision, content_hash, to_char(known_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS known_at
             FROM universe_snapshot_revisions WHERE snapshot_key = $1`,
          [prepared.snapshotKey],
        )
      ).rows.map((r) => ({ snapshotRevisionId: r.snapshot_revision_id, revision: r.revision, contentHash: r.content_hash, knownAt: r.known_at }));
      const plan = planRevision(prepared, existing, await this.ingestSeqIn(client));

      if (plan.status === 'ALREADY_APPLIED') {
        const same = await this.loadVerified(client, plan.snapshotRevisionId);
        await client.query('COMMIT');
        if (!same) throw new UniverseError('UNIVERSE_INTEGRITY_FAILED', 'an identical revision is recorded but cannot be found');
        return { status: 'ALREADY_APPLIED', revision: same };
      }

      const rev = plan.revision;
      await client.query(
        `INSERT INTO universe_snapshot_revisions (snapshot_revision_id, snapshot_key, universe_id, definition_version, source_id, effective_at, retrieved_at,
           knowledge_source, known_at, vintage, vintage_policy, completeness, revision, content_hash, provenance_hash, ingest_seq, member_count, result, result_hash)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9::timestamptz, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19)`,
        [
          rev.snapshotRevisionId,
          rev.snapshotKey,
          rev.universeId,
          rev.definitionVersion,
          rev.sourceId,
          rev.effectiveAt,
          rev.retrievedAt,
          rev.knowledgeSource,
          rev.knownAt,
          rev.vintage,
          rev.vintagePolicy,
          rev.completeness,
          rev.revision,
          rev.contentHash,
          rev.provenanceHash,
          rev.ingestSeq,
          rev.memberCount,
          JSON.stringify(encodeJson(rev)),
          hashOf(rev),
        ],
      );
      // One statement per child table, whatever the member count: no per-member round trip.
      if (rev.members.length > 0) {
        await client.query(
          `INSERT INTO universe_snapshot_members (snapshot_revision_id, instrument_id, source_member_key, provider_symbol, provider_instrument_id)
           SELECT $1::text, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])`,
          [rev.snapshotRevisionId, rev.members.map((m) => m.instrumentId), rev.members.map((m) => m.sourceMemberKey), rev.members.map((m) => m.providerSymbol), rev.members.map((m) => m.providerInstrumentId)],
        );
      }
      if (rev.unresolvedMembers.length > 0) {
        await client.query(
          `INSERT INTO universe_unresolved_members (snapshot_revision_id, source_member_key, provider_symbol, provider_instrument_id, exchange)
           SELECT $1::text, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])`,
          [
            rev.snapshotRevisionId,
            rev.unresolvedMembers.map((u) => u.sourceMemberKey),
            rev.unresolvedMembers.map((u) => u.providerSymbol),
            rev.unresolvedMembers.map((u) => u.providerInstrumentId),
            rev.unresolvedMembers.map((u) => u.exchange),
          ],
        );
      }
      await client.query('COMMIT');
      return { status: 'APPLIED', revision: rev };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Selects the revision for a request and derives its evidence. The rule is the one of selectRevision: the latest effective revision, then
   * its latest revision number; decision_time gates on knownAt; storedThrough gates on the ingest sequence.
   */
  async select(q: UniverseSelectionQuery): Promise<UniverseSelection> {
    const definition = await this.loadDefinition(this.pool, q.universeId);
    if (!definition) throw new UniverseError('UNIVERSE_NOT_FOUND', 'universe ' + q.universeId + ' is not defined');
    const asOf = instantOf(q.asOf, 'asOf');
    const head = (
      await this.pool.query<{ snapshot_revision_id: string }>(
        `SELECT snapshot_revision_id FROM universe_snapshot_revisions
          WHERE universe_id = $1 AND source_id = $2
            AND effective_at <= $3::timestamptz
            AND ($4::boolean = false OR known_at <= $3::timestamptz)
            AND ($5::integer IS NULL OR ingest_seq <= $5::integer)
          ORDER BY effective_at DESC, revision DESC LIMIT 1`,
        [q.universeId, q.sourceId, asOf, q.mode === 'decision_time', q.storedThrough ?? null],
      )
    ).rows[0];
    const revision = head ? await this.loadVerified(this.pool, head.snapshot_revision_id) : null;
    const evidence = evidenceOf(revision, {
      universeId: q.universeId,
      definitionVersion: definition.definitionVersion,
      sourceId: q.sourceId,
      source: await this.loadSource(this.pool, q.sourceId),
      asOf,
      mode: q.mode,
    });
    return selectionOf(revision, evidence);
  }

  /** A stored revision, verified on the way out. null when no such revision exists. */
  async revisionById(snapshotRevisionId: string): Promise<StoredUniverseRevision | null> {
    return this.loadVerified(this.pool, snapshotRevisionId);
  }

  /** Every stored revision in ingest order, each verified. For audit. */
  async all(): Promise<readonly StoredUniverseRevision[]> {
    const ids = (await this.pool.query<{ snapshot_revision_id: string }>('SELECT snapshot_revision_id FROM universe_snapshot_revisions ORDER BY ingest_seq')).rows;
    const out: StoredUniverseRevision[] = [];
    for (const row of ids) {
      const revision = await this.loadVerified(this.pool, row.snapshot_revision_id);
      if (revision) out.push(revision);
    }
    return out;
  }

  private async ingestSeqIn(db: Queryable): Promise<number> {
    const row = (await db.query('SELECT COALESCE(MAX(ingest_seq), 0)::integer AS seq FROM universe_snapshot_revisions', [])).rows[0] as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  private async loadDefinition(db: Queryable, universeId: string): Promise<UniverseDefinition | undefined> {
    const row = (await db.query('SELECT universe_id, definition_version, name, definition_hash FROM universe_definitions WHERE universe_id = $1', [universeId])).rows[0] as
      | DefinitionRow
      | undefined;
    if (!row) return undefined;
    const definition = normalizeDefinition({ universeId: row.universe_id, definitionVersion: row.definition_version, name: row.name });
    if (hashOf(definition) !== row.definition_hash) throw new UniverseError('UNIVERSE_INTEGRITY_FAILED', 'stored universe ' + universeId + ' does not match its hash');
    return definition;
  }

  private async loadSource(db: Queryable, sourceId: string): Promise<UniverseSource | undefined> {
    const row = (await db.query('SELECT source_id, provider, dataset, environment, license, license_note, source_hash FROM universe_sources WHERE source_id = $1', [sourceId])).rows[0] as
      | SourceRow
      | undefined;
    if (!row) return undefined;
    const source = normalizeSource({
      sourceId: row.source_id,
      provider: row.provider,
      dataset: row.dataset,
      environment: row.environment,
      license: row.license,
      ...(row.license_note !== null ? { licenseNote: row.license_note } : {}),
    });
    if (hashOf(source) !== row.source_hash) throw new UniverseError('UNIVERSE_INTEGRITY_FAILED', 'stored source ' + sourceId + ' does not match its hash');
    return source;
  }

  /**
   * Rebuilds a revision from its header and member rows, then checks it against its stored payload and recomputes every identity.
   * Tampering with the payload, the header, a member or an unresolved row is refused here, never repaired.
   */
  private async loadVerified(db: Queryable, snapshotRevisionId: string): Promise<StoredUniverseRevision | null> {
    const row = (await db.query(`SELECT ${REVISION_COLUMNS} FROM universe_snapshot_revisions WHERE snapshot_revision_id = $1`, [snapshotRevisionId])).rows[0] as
      | RevisionRow
      | undefined;
    if (!row) return null;
    const payload = decodeJson(row.result) as StoredUniverseRevision;
    if (hashOf(payload) !== row.result_hash) throw new UniverseError('UNIVERSE_INTEGRITY_FAILED', 'stored revision ' + snapshotRevisionId + ' payload does not match its hash');
    const members = (
      await db.query('SELECT instrument_id, source_member_key, provider_symbol, provider_instrument_id FROM universe_snapshot_members WHERE snapshot_revision_id = $1', [snapshotRevisionId])
    ).rows as MemberRow[];
    const unresolved = (
      await db.query('SELECT source_member_key, provider_symbol, provider_instrument_id, exchange FROM universe_unresolved_members WHERE snapshot_revision_id = $1', [snapshotRevisionId])
    ).rows as UnresolvedRow[];
    const rebuilt: StoredUniverseRevision = {
      snapshotKey: row.snapshot_key,
      snapshotRevisionId: row.snapshot_revision_id,
      universeId: row.universe_id,
      definitionVersion: row.definition_version,
      sourceId: row.source_id,
      effectiveAt: row.effective_at,
      retrievedAt: row.retrieved_at,
      knowledgeSource: row.knowledge_source,
      knownAt: row.known_at,
      vintage: row.vintage,
      vintagePolicy: row.vintage_policy,
      completeness: row.completeness,
      revision: row.revision,
      contentHash: row.content_hash,
      provenanceHash: row.provenance_hash,
      ingestSeq: row.ingest_seq,
      memberCount: row.member_count,
      members: canonicalMembers(members.map((m) => ({ instrumentId: m.instrument_id, sourceMemberKey: m.source_member_key, providerSymbol: m.provider_symbol, providerInstrumentId: m.provider_instrument_id }))),
      unresolvedMembers: canonicalUnresolved(unresolved.map((u) => ({ sourceMemberKey: u.source_member_key, providerSymbol: u.provider_symbol, providerInstrumentId: u.provider_instrument_id, exchange: u.exchange }))),
    };
    assertRevisionIntegrity(rebuilt, payload);
    return rebuilt;
  }
}
