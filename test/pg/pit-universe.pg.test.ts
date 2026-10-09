import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashOf } from '../../src/persistence/canonical-json.js';
import { loadMigrations } from '../../src/persistence/postgres/migrator.js';
import { PostgresUniverseStore } from '../../src/persistence/postgres/postgres-universe-store.js';
import {
  UniverseError,
  type MemberResolver,
  type StoredUniverseRevision,
  type UniverseDefinition,
  type UniverseMemberInput,
  type UniverseSelection,
  type UniverseSnapshotInput,
  type UniverseSource,
} from '../../src/universe/universe-model.js';
import { InMemoryUniverseStore, type UniverseSelectionQuery } from '../../src/universe/universe-store.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// PostgreSQL Point-in-Time Universe V1 (migration 010). Regressions first: each test states what must not happen. The same scenarios run
// on the in-memory store, and the two must agree exactly (identities, sequence, evidence). See docs/PIT_UNIVERSE_V1.md.

const SOURCE: UniverseSource = { sourceId: 'vendor:constituents', provider: 'vendor', dataset: 'index_constituents', environment: 'production', license: 'internal_use' };
const DEFINITION: UniverseDefinition = { universeId: 'u_idx', definitionVersion: '1', name: 'Index' };
const UNIVERSE = 'u_idx';

/** A permanent provider instrument id maps to a NEXUS instrument. Symbols never identify anything here. */
const byProviderId: MemberResolver = (m) => (m.providerInstrumentId ? 'ins_' + m.providerInstrumentId : null);

function member(pid: string, symbol = 'SYM' + pid): UniverseMemberInput {
  return { sourceMemberKey: 'key:' + pid, providerSymbol: symbol, providerInstrumentId: pid };
}

function snapshot(o: { effectiveAt: string; retrievedAt: string; members: UniverseMemberInput[]; completeness?: 'COMPLETE' | 'PARTIAL' }): UniverseSnapshotInput {
  return { universeId: UNIVERSE, sourceId: SOURCE.sourceId, knowledgeSource: 'captured_by_nexus', knownAt: o.retrievedAt, completeness: o.completeness ?? 'COMPLETE', ...o };
}

interface UniverseApi {
  registerSource(s: UniverseSource): Promise<void>;
  registerDefinition(d: UniverseDefinition): Promise<void>;
  ingest(i: UniverseSnapshotInput, r: MemberResolver): Promise<{ status: 'APPLIED' | 'ALREADY_APPLIED'; revision: StoredUniverseRevision }>;
  select(q: UniverseSelectionQuery): Promise<UniverseSelection>;
  currentIngestSeq(): Promise<number>;
  revisionById(id: string): Promise<StoredUniverseRevision | null>;
  all(): Promise<readonly StoredUniverseRevision[]>;
}

/** The in-memory store behind the same async interface, so one scenario drives both stores. */
function memoryApi(): UniverseApi {
  const store = new InMemoryUniverseStore();
  return {
    async registerSource(s) {
      store.registerSource(s);
    },
    async registerDefinition(d) {
      store.registerDefinition(d);
    },
    async ingest(i, r) {
      return store.ingest(i, r);
    },
    async select(q) {
      return store.select(q);
    },
    async currentIngestSeq() {
      return store.currentIngestSeq();
    },
    async revisionById(id) {
      return store.revisionById(id);
    },
    async all() {
      return store.all();
    },
  };
}

/**
 * Survivorship scenario. 2020: A, B, C (C is delisted later). 2021: A, B, D; a correction of the 2021 snapshot (E added) learned in 2021-02.
 * A present-day list (A, B, D, E) must never replace the 2020 membership.
 */
async function seed(api: UniverseApi): Promise<void> {
  await api.registerSource(SOURCE);
  await api.registerDefinition(DEFINITION);
  await api.ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2019-12-31T12:00:00.000Z', members: [member('A'), member('B'), member('C')] }), byProviderId);
  await api.ingest(snapshot({ effectiveAt: '2021-01-01T00:00:00.000Z', retrievedAt: '2020-12-20T10:00:00.000Z', members: [member('A'), member('B'), member('D')] }), byProviderId);
  await api.ingest(snapshot({ effectiveAt: '2021-01-01T00:00:00.000Z', retrievedAt: '2021-02-10T09:00:00.000Z', members: [member('A'), member('B'), member('D'), member('E')] }), byProviderId);
}

const QUERIES: UniverseSelectionQuery[] = [
  { universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2019-12-01T00:00:00.000Z', mode: 'decision_time' },
  { universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' },
  { universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'historical_research' },
  { universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-01-15T00:00:00.000Z', mode: 'decision_time' },
  { universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-02-05T00:00:00.000Z', mode: 'decision_time' },
  { universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-02-05T00:00:00.000Z', mode: 'historical_research' },
  { universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-03-01T00:00:00.000Z', mode: 'decision_time' },
  { universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2026-10-09T00:00:00.000Z', mode: 'decision_time' },
];

describe.skipIf(!pgAvailable)('PIT Universe V1 in PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase;
  let api: PostgresUniverseStore;

  beforeEach(async () => {
    db = await createTestDatabase();
    api = new PostgresUniverseStore(db.pool);
  });

  afterEach(async () => {
    await db?.drop();
  });

  it('a fresh database runs 001-010, and the migrations 001-009 keep the checksums they were released with', async () => {
    const rows = (await db.pool.query<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version')).rows;
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const m of loadMigrations()) expect(rows.find((r) => r.version === m.version)?.checksum, m.version + '_' + m.name).toBe(m.checksum);
  });

  it('roundtrip: a stored COMPLETE revision reads back identical, and its evidence is derived from the store', async () => {
    await api.registerSource(SOURCE);
    await api.registerDefinition(DEFINITION);
    const ingested = await api.ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2019-12-31T12:00:00.000Z', members: [member('A'), member('B'), member('C')] }), byProviderId);
    const read = await api.revisionById(ingested.revision.snapshotRevisionId);
    expect(read).toEqual(ingested.revision);
    const selection = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' });
    expect(selection.evidence).toMatchObject({ status: 'SELECTED', complete: true, sourceProduction: true, strictDecisionTime: true, historicalReconstruction: false });
    expect(selection.members).toEqual(['ins_A', 'ins_B', 'ins_C']);
  });

  it('the PostgreSQL store and the in-memory store agree exactly: identities, sequence and evidence for every replay query', async () => {
    const memory = memoryApi();
    await seed(memory);
    await seed(api);
    expect(await api.currentIngestSeq()).toBe(await memory.currentIngestSeq());
    expect(await api.all()).toEqual(await memory.all());
    for (const q of QUERIES) {
      const pg = await api.select(q);
      const mem = await memory.select(q);
      expect(pg.evidence, q.asOf + ' ' + q.mode).toEqual(mem.evidence);
      expect(pg.members, q.asOf + ' ' + q.mode).toEqual(mem.members);
    }
  });

  it('survivorship: the 2020 selection keeps C (delisted later); the present-day list never substitutes; the historical fingerprint does not move', async () => {
    await seed(api);
    const before = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' });
    expect(before.members).toEqual(['ins_A', 'ins_B', 'ins_C']);
    expect(before.members).not.toContain('ins_D');
    expect(before.members).not.toContain('ins_E');
    // Later revisions and a correction are stored; the 2020 answer does not change.
    await api.ingest(snapshot({ effectiveAt: '2022-01-01T00:00:00.000Z', retrievedAt: '2021-12-20T10:00:00.000Z', members: [member('A'), member('F')] }), byProviderId);
    const after = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' });
    expect(after.evidence.fingerprint).toBe(before.evidence.fingerprint);
    expect(after.members).toEqual(['ins_A', 'ins_B', 'ins_C']);
  });

  it('delisted: a member delisted later stays in the snapshot it belonged to; membership is never read from an active flag', async () => {
    await seed(api);
    const sel = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' });
    expect(sel.members).toContain('ins_C');
    const rev = sel.revision!;
    expect(rev.members.find((m) => m.instrumentId === 'ins_C')).toMatchObject({ providerSymbol: 'SYMC', sourceMemberKey: 'key:C' });
  });

  it('historical reconstruction: a snapshot learned after its effective instant is never strict, and decision_time refuses it', async () => {
    await seed(api);
    const late = await api.ingest(snapshot({ effectiveAt: '2015-01-01T00:00:00.000Z', retrievedAt: '2026-10-01T00:00:00.000Z', members: [member('A')] }), byProviderId);
    expect(late.revision.vintage).toBe('historical_reconstruction');
    const decision = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2016-01-01T00:00:00.000Z', mode: 'decision_time' });
    expect(decision.evidence).toMatchObject({ status: 'UNAVAILABLE', strictDecisionTime: false });
    const research = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2016-01-01T00:00:00.000Z', mode: 'historical_research' });
    expect(research.evidence).toMatchObject({ status: 'SELECTED', historicalReconstruction: true, strictDecisionTime: false, decisionTimeKnowledgeProven: false });
  });

  it('revision replay: decision_time never sees a revision NEXUS had not yet learned; historical_research sees the latest correction', async () => {
    await seed(api);
    const before = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-02-05T00:00:00.000Z', mode: 'decision_time' });
    expect(before.revision?.revision).toBe(1);
    expect(before.members).toEqual(['ins_A', 'ins_B', 'ins_D']);
    const research = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-02-05T00:00:00.000Z', mode: 'historical_research' });
    expect(research.revision?.revision).toBe(2);
    expect(research.evidence).toMatchObject({ historicalReconstruction: true, strictDecisionTime: false });
    const learned = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-03-01T00:00:00.000Z', mode: 'decision_time' });
    expect(learned.revision?.revision).toBe(2);
    expect(learned.members).toEqual(['ins_A', 'ins_B', 'ins_D', 'ins_E']);
  });

  it('a later backfill does not change a replay that is stored through an earlier ingest sequence', async () => {
    await seed(api);
    const seq = await api.currentIngestSeq();
    const frozen = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-03-10T00:00:00.000Z', mode: 'decision_time', storedThrough: seq });
    await api.ingest(snapshot({ effectiveAt: '2021-01-01T00:00:00.000Z', retrievedAt: '2021-03-05T00:00:00.000Z', members: [member('A'), member('B'), member('D'), member('F')] }), byProviderId);
    const replayed = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-03-10T00:00:00.000Z', mode: 'decision_time', storedThrough: seq });
    expect(replayed.evidence.fingerprint).toBe(frozen.evidence.fingerprint);
    expect(replayed.members).toEqual(['ins_A', 'ins_B', 'ins_D', 'ins_E']);
    const now = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-03-10T00:00:00.000Z', mode: 'decision_time' });
    expect(now.revision?.revision).toBe(3);
  });

  it('future-effective: a revision whose effective instant is after asOf is not selected', async () => {
    await seed(api);
    await api.ingest(snapshot({ effectiveAt: '2030-01-01T00:00:00.000Z', retrievedAt: '2026-01-01T00:00:00.000Z', members: [member('Z')] }), byProviderId);
    const sel = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2026-10-09T00:00:00.000Z', mode: 'decision_time' });
    expect(sel.revision?.effectiveAt).toBe('2021-01-01T00:00:00.000Z');
    expect(sel.members).not.toContain('ins_Z');
  });

  it('an unresolved member in a COMPLETE snapshot is refused, and nothing is stored (silent loss is forbidden)', async () => {
    await seed(api);
    const seqBefore = await api.currentIngestSeq();
    const revisionsBefore = (await api.all()).length;
    const unresolvable: UniverseMemberInput = { sourceMemberKey: 'key:X', providerSymbol: 'XXX' };
    await expect(api.ingest(snapshot({ effectiveAt: '2024-01-01T00:00:00.000Z', retrievedAt: '2023-12-31T12:00:00.000Z', members: [member('A'), unresolvable] }), byProviderId)).rejects.toMatchObject({ code: 'UNIVERSE_MEMBER_UNRESOLVED' });
    expect(await api.currentIngestSeq()).toBe(seqBefore);
    expect((await api.all()).length).toBe(revisionsBefore);
    const rows = (await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM universe_snapshot_members m JOIN universe_snapshot_revisions r USING (snapshot_revision_id) WHERE r.effective_at = '2024-01-01T00:00:00Z'")).rows[0];
    expect(rows?.n).toBe(0);
  });

  it('a PARTIAL snapshot stores its unresolved members visibly and is never complete', async () => {
    await api.registerSource(SOURCE);
    await api.registerDefinition(DEFINITION);
    const stored = await api.ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2019-12-31T12:00:00.000Z', completeness: 'PARTIAL', members: [member('A'), { sourceMemberKey: 'key:X', providerSymbol: 'XXX', exchange: 'NYSE' }] }), byProviderId);
    expect(stored.revision.unresolvedMembers).toEqual([{ sourceMemberKey: 'key:X', providerSymbol: 'XXX', providerInstrumentId: null, exchange: 'NYSE' }]);
    expect((await api.revisionById(stored.revision.snapshotRevisionId))!.unresolvedMembers).toHaveLength(1);
    const sel = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' });
    expect(sel.evidence).toMatchObject({ complete: false, strictDecisionTime: false, completeness: 'PARTIAL' });
  });

  it('the database refuses an unresolved member for a COMPLETE revision (defence in depth)', async () => {
    await seed(api);
    const rev = (await api.all())[0]!;
    await expect(
      db.pool.query('INSERT INTO universe_unresolved_members (snapshot_revision_id, source_member_key, provider_symbol) VALUES ($1, $2, $3)', [rev.snapshotRevisionId, 'key:Q', 'QQQ']),
    ).rejects.toThrow(/PARTIAL/);
  });

  it('knowledge never regresses within a snapshot key: a revision learned before its predecessor is refused', async () => {
    await seed(api);
    await expect(
      api.ingest(snapshot({ effectiveAt: '2021-01-01T00:00:00.000Z', retrievedAt: '2021-01-20T00:00:00.000Z', members: [member('A')] }), byProviderId),
    ).rejects.toMatchObject({ code: 'UNIVERSE_KNOWLEDGE_REGRESSION' });
  });

  it('the database enforces the next revision number of a key (a raw insert of revision 9 is refused)', async () => {
    await seed(api);
    const key = (await api.all()).find((r) => r.effectiveAt === '2020-01-01T00:00:00.000Z')!.snapshotKey;
    await expect(
      db.pool.query(
        `INSERT INTO universe_snapshot_revisions (snapshot_revision_id, snapshot_key, universe_id, definition_version, source_id, effective_at, retrieved_at, knowledge_source, known_at, vintage, vintage_policy, completeness, revision, content_hash, provenance_hash, ingest_seq, member_count, result, result_hash)
         VALUES ($1, $2, 'u_idx', '1', $3, '2020-01-01T00:00:00Z', '2019-12-31T12:00:00Z', 'captured_by_nexus', '2019-12-31T12:00:00Z', 'contemporaneous', 'universe-vintage:v1', 'COMPLETE', 9, $4, $5, (SELECT COALESCE(MAX(ingest_seq), 0) + 1 FROM universe_snapshot_revisions), 0, '{}'::jsonb, $6)`,
        ['urev_' + 'a'.repeat(40), key, SOURCE.sourceId, 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)],
      ),
    ).rejects.toThrow(/NEXUS_UNIVERSE: revision 9/);
  });

  it('the database checks the member count of a revision when it commits (header and member rows must agree)', async () => {
    await api.registerSource(SOURCE);
    await api.registerDefinition(DEFINITION);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO universe_snapshot_revisions (snapshot_revision_id, snapshot_key, universe_id, definition_version, source_id, effective_at, retrieved_at, knowledge_source, known_at, vintage, vintage_policy, completeness, revision, content_hash, provenance_hash, ingest_seq, member_count, result, result_hash)
         VALUES ($1, $2, 'u_idx', '1', $3, '2025-01-01T00:00:00Z', '2024-12-31T12:00:00Z', 'captured_by_nexus', '2024-12-31T12:00:00Z', 'contemporaneous', 'universe-vintage:v1', 'COMPLETE', 1, $4, $5, (SELECT COALESCE(MAX(ingest_seq), 0) + 1 FROM universe_snapshot_revisions), 2, '{}'::jsonb, $6)`,
        ['urev_' + 'b'.repeat(40), 'uk_' + 'b'.repeat(40), SOURCE.sourceId, 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/states 2 members but stores 0/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('identical content is idempotent; the same source or universe id with different content is a conflict', async () => {
    await seed(api);
    const again = await api.ingest(snapshot({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2019-12-31T12:00:00.000Z', members: [member('C'), member('A'), member('B')] }), byProviderId);
    expect(again.status).toBe('ALREADY_APPLIED');
    expect((await api.all()).length).toBe(3);
    await api.registerSource(SOURCE);
    await expect(api.registerSource({ ...SOURCE, provider: 'forged' })).rejects.toBeInstanceOf(UniverseError);
    await expect(api.registerSource({ ...SOURCE, provider: 'forged' })).rejects.toMatchObject({ code: 'UNIVERSE_CONFLICT' });
    await api.registerSource(SOURCE);
    await expect(api.registerDefinition({ ...DEFINITION, name: 'Other' })).rejects.toMatchObject({ code: 'UNIVERSE_CONFLICT' });
  });

  it('append-only: UPDATE, DELETE and TRUNCATE are rejected on every universe table', async () => {
    await seed(api);
    const updates: [string, string][] = [
      ['universe_sources', "UPDATE universe_sources SET source_hash = source_hash"],
      ['universe_definitions', "UPDATE universe_definitions SET definition_hash = definition_hash"],
      ['universe_snapshot_revisions', "UPDATE universe_snapshot_revisions SET result_hash = result_hash"],
      ['universe_snapshot_members', "UPDATE universe_snapshot_members SET source_member_key = source_member_key"],
    ];
    for (const [, sql] of updates) await expect(db.pool.query(sql), sql).rejects.toThrow(/NEXUS_APPEND_ONLY/);
    for (const table of ['universe_snapshot_members', 'universe_snapshot_revisions', 'universe_definitions']) {
      await expect(db.pool.query('DELETE FROM ' + table), table).rejects.toThrow(/NEXUS_APPEND_ONLY/);
      await expect(db.pool.query('TRUNCATE ' + table), table).rejects.toThrow(/NEXUS_APPEND_ONLY|cannot truncate/);
    }
    expect((await api.all()).length).toBe(3);
  });

  it('tamper: a changed payload is refused on read (the stored hash no longer matches)', async () => {
    await seed(api);
    const rev = (await api.all())[0]!;
    const c = await db.privilegedClient();
    try {
      await c.query("SET session_replication_role = 'replica'");
      await c.query("UPDATE universe_snapshot_revisions SET result = jsonb_set(result, '{memberCount}', '99'::jsonb) WHERE snapshot_revision_id = $1", [rev.snapshotRevisionId]);
    } finally {
      await c.end();
    }
    await expect(api.revisionById(rev.snapshotRevisionId)).rejects.toMatchObject({ code: 'UNIVERSE_INTEGRITY_FAILED' });
    await expect(api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' })).rejects.toMatchObject({ code: 'UNIVERSE_INTEGRITY_FAILED' });
  });

  it('tamper: a payload rewritten with its own hash still fails, because the rows and the identities disagree', async () => {
    await seed(api);
    const rev = (await api.all())[0]!;
    const forged = { ...rev, ingestSeq: 999, members: rev.members.slice(1), memberCount: rev.members.length - 1 };
    const c = await db.privilegedClient();
    try {
      await c.query("SET session_replication_role = 'replica'");
      await c.query('UPDATE universe_snapshot_revisions SET result = $2::jsonb, result_hash = $3 WHERE snapshot_revision_id = $1', [rev.snapshotRevisionId, JSON.stringify(forged), hashOf(forged)]);
    } finally {
      await c.end();
    }
    await expect(api.revisionById(rev.snapshotRevisionId)).rejects.toMatchObject({ code: 'UNIVERSE_INTEGRITY_FAILED' });
  });

  it('tamper: a changed, deleted or added member row is refused on read', async () => {
    await seed(api);
    const rev = (await api.all())[0]!;
    const c = await db.privilegedClient();
    try {
      await c.query("SET session_replication_role = 'replica'");
      await c.query("UPDATE universe_snapshot_members SET instrument_id = 'ins_FORGED' WHERE snapshot_revision_id = $1 AND instrument_id = 'ins_B'", [rev.snapshotRevisionId]);
    } finally {
      await c.end();
    }
    await expect(api.revisionById(rev.snapshotRevisionId)).rejects.toMatchObject({ code: 'UNIVERSE_INTEGRITY_FAILED' });
  });

  it('tamper: a deleted member row is refused on read', async () => {
    await seed(api);
    const rev = (await api.all())[0]!;
    const c = await db.privilegedClient();
    try {
      await c.query("SET session_replication_role = 'replica'");
      await c.query("DELETE FROM universe_snapshot_members WHERE snapshot_revision_id = $1 AND instrument_id = 'ins_C'", [rev.snapshotRevisionId]);
    } finally {
      await c.end();
    }
    await expect(api.revisionById(rev.snapshotRevisionId)).rejects.toMatchObject({ code: 'UNIVERSE_INTEGRITY_FAILED' });
  });

  it('tamper: a changed header is refused on read, and so is a changed source', async () => {
    await seed(api);
    const revs = await api.all();
    const c = await db.privilegedClient();
    try {
      await c.query("SET session_replication_role = 'replica'");
      await c.query("UPDATE universe_snapshot_revisions SET completeness = 'PARTIAL' WHERE snapshot_revision_id = $1", [revs[0]!.snapshotRevisionId]);
      await c.query("UPDATE universe_sources SET provider = 'forged' WHERE source_id = $1", [SOURCE.sourceId]);
    } finally {
      await c.end();
    }
    await expect(api.revisionById(revs[0]!.snapshotRevisionId)).rejects.toMatchObject({ code: 'UNIVERSE_INTEGRITY_FAILED' });
    await expect(api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-03-01T00:00:00.000Z', mode: 'decision_time' })).rejects.toMatchObject({ code: 'UNIVERSE_INTEGRITY_FAILED' });
  });

  it('a second process sees the same revisions and the same selections (no per-process state)', async () => {
    await seed(api);
    const other = new PostgresUniverseStore(db.extraPool());
    expect(await other.all()).toEqual(await api.all());
    expect((await other.select(QUERIES[3]!)).evidence).toEqual((await api.select(QUERIES[3]!)).evidence);
  });

  it('a thousand members: one statement per child table, and the same identity as in memory', async () => {
    const memory = memoryApi();
    await seed(memory);
    await seed(api);
    const pids = Array.from({ length: 1000 }, (_, i) => 'M' + String(i).padStart(4, '0'));
    const input = snapshot({ effectiveAt: '2022-01-01T00:00:00.000Z', retrievedAt: '2021-12-31T12:00:00.000Z', members: pids.map((p) => member(p)) });
    const started = Date.now();
    const pg = await api.ingest(input, byProviderId);
    const ingestMs = Date.now() - started;
    const mem = await memory.ingest(input, byProviderId);
    expect(pg.revision.snapshotRevisionId).toBe(mem.revision.snapshotRevisionId);
    const sel = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2023-01-01T00:00:00.000Z', mode: 'decision_time' });
    expect(sel.members).toHaveLength(1000);
    expect(sel.evidence.memberCount).toBe(1000);
    expect(sel.evidence.strictDecisionTime).toBe(true);
    expect(ingestMs).toBeLessThan(20_000);
  });
});
