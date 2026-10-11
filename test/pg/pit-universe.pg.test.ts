import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashOf } from '../../src/persistence/canonical-json.js';
import { loadMigrations } from '../../src/persistence/postgres/migrator.js';
import { PostgresUniverseStore } from '../../src/persistence/postgres/postgres-universe-store.js';
import {
  type MemberResolver,
  type StoredUniverseRevision,
  type UniverseDefinition,
  type UniverseMemberInput,
  type UniverseSelection,
  type UniverseSnapshotInput,
  type UniverseSource,
  type UniverseTimingProof,
} from '../../src/universe/universe-model.js';
import { InMemoryUniverseStore, type UniverseSelectionQuery } from '../../src/universe/universe-store.js';
import { manualClock } from '../universe/fixtures.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// PostgreSQL Point-in-Time Universe (migrations 010 and 011). Regressions first: each test states what must not happen. The same scenarios run on
// the in-memory store and on PostgreSQL, on the same clock readings, and the two must agree exactly. See docs/PIT_UNIVERSE_KNOWLEDGE_SEAL.md.

const SOURCE: UniverseSource = { sourceId: 'vendor:constituents', provider: 'vendor', dataset: 'index_constituents', environment: 'production', license: 'internal_use' };
const DEFINITION: UniverseDefinition = { universeId: 'u_idx', definitionVersion: '1', name: 'Index' };
const UNIVERSE = 'u_idx';

/** A permanent provider instrument id maps to a NEXUS instrument. Symbols never identify anything here. */
const byProviderId: MemberResolver = (m) => (m.providerInstrumentId ? 'ins_' + m.providerInstrumentId : null);

function member(pid: string, symbol = 'SYM' + pid): UniverseMemberInput {
  return { sourceMemberKey: 'key:' + pid, providerSymbol: symbol, providerInstrumentId: pid };
}

function claim(o: { effectiveAt: string; retrievedAt: string; members: UniverseMemberInput[]; completeness?: 'COMPLETE' | 'PARTIAL' }): UniverseSnapshotInput {
  return { universeId: UNIVERSE, sourceId: SOURCE.sourceId, knowledgeSource: 'captured_by_nexus', knownAt: o.retrievedAt, completeness: o.completeness ?? 'COMPLETE', ...o };
}

interface UniverseApi {
  registerSource(s: UniverseSource): Promise<void>;
  registerDefinition(d: UniverseDefinition): Promise<void>;
  ingest(i: UniverseSnapshotInput, r: MemberResolver): Promise<{ status: 'APPLIED' | 'ALREADY_APPLIED'; revision: StoredUniverseRevision; timingProof: UniverseTimingProof }>;
  select(q: UniverseSelectionQuery): Promise<UniverseSelection>;
  currentIngestSeq(): Promise<number>;
  revisionById(id: string): Promise<StoredUniverseRevision | null>;
  timingProofOf(id: string): Promise<UniverseTimingProof | null>;
  all(): Promise<readonly StoredUniverseRevision[]>;
}

/** The in-memory store behind the same async interface, on the same clock. */
function memoryApi(clock: ReturnType<typeof manualClock>): UniverseApi {
  const store = new InMemoryUniverseStore({ clock: clock.clock });
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
    async timingProofOf(id) {
      return store.timingProofOf(id);
    },
    async all() {
      return store.all();
    },
  };
}

/** The survivorship scenario. Each snapshot is stored by NEXUS at storedAt, after its claimed retrieval. */
async function seed(api: UniverseApi, clock: ReturnType<typeof manualClock>): Promise<void> {
  await api.registerSource(SOURCE);
  await api.registerDefinition(DEFINITION);
  clock.set('2019-12-31T12:00:01.000Z');
  await api.ingest(claim({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2019-12-31T12:00:00.000Z', members: [member('A'), member('B'), member('C')] }), byProviderId);
  clock.set('2020-12-20T10:00:01.000Z');
  await api.ingest(claim({ effectiveAt: '2021-01-01T00:00:00.000Z', retrievedAt: '2020-12-20T10:00:00.000Z', members: [member('A'), member('B'), member('D')] }), byProviderId);
  clock.set('2021-02-10T09:00:01.000Z');
  await api.ingest(claim({ effectiveAt: '2021-01-01T00:00:00.000Z', retrievedAt: '2021-02-10T09:00:00.000Z', members: [member('A'), member('B'), member('D'), member('E')] }), byProviderId);
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

describe.skipIf(!pgAvailable)('PIT Universe in PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase;
  let clock: ReturnType<typeof manualClock>;
  let api: PostgresUniverseStore;

  beforeEach(async () => {
    db = await createTestDatabase();
    clock = manualClock('2026-10-09T12:00:00.000Z');
    api = new PostgresUniverseStore(db.pool, { clock: async () => clock.clock() });
  });

  afterEach(async () => {
    await db?.drop();
  });

  it('a fresh database runs 001-011, and the migrations 001-010 keep the checksums they were released with', async () => {
    const rows = (await db.pool.query<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version')).rows;
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const m of loadMigrations()) expect(rows.find((r) => r.version === m.version)?.checksum, m.version + '_' + m.name).toBe(m.checksum);
  });

  it('roundtrip: a stored COMPLETE revision reads back identical, and its evidence and timing proof are derived from the store', async () => {
    await api.registerSource(SOURCE);
    await api.registerDefinition(DEFINITION);
    clock.set('2019-12-31T12:00:01.000Z');
    const ingested = await api.ingest(claim({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2019-12-31T12:00:00.000Z', members: [member('A'), member('B'), member('C')] }), byProviderId);
    expect(await api.revisionById(ingested.revision.snapshotRevisionId)).toEqual(ingested.revision);
    expect(await api.timingProofOf(ingested.revision.snapshotRevisionId)).toEqual(ingested.timingProof);
    const selection = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' });
    expect(selection.evidence).toMatchObject({ status: 'SELECTED', knowledgeProof: 'COMMIT_SEALED', complete: true, sourceProduction: true, decisionTimeKnowledgeProven: true, contemporaneousVintageProven: true, strictDecisionTime: true });
    expect(selection.members).toEqual(['ins_A', 'ins_B', 'ins_C']);
  });

  it('the PostgreSQL store and the in-memory store agree exactly: identities, sequence, timing proofs and evidence for every replay query', async () => {
    const memClock = manualClock('2019-12-31T12:00:01.000Z');
    const memorySeeded = memoryApi(memClock);
    await seed(memorySeeded, memClock);
    await seed(api, clock);
    expect(await api.currentIngestSeq()).toBe(await memorySeeded.currentIngestSeq());
    expect(await api.all()).toEqual(await memorySeeded.all());
    for (const rev of await api.all()) expect(await api.timingProofOf(rev.snapshotRevisionId)).toEqual(await memorySeeded.timingProofOf(rev.snapshotRevisionId));
    for (const q of QUERIES) {
      const pg = await api.select(q);
      const mem = await memorySeeded.select(q);
      expect(pg.evidence, q.asOf + ' ' + q.mode).toEqual(mem.evidence);
      expect(pg.members, q.asOf + ' ' + q.mode).toEqual(mem.members);
      expect(pg.timingProof, q.asOf + ' ' + q.mode).toEqual(mem.timingProof);
    }
  });

  it('survivorship: the 2020 selection keeps C (delisted later) and never substitutes the present-day list; its fingerprint does not move', async () => {
    await seed(api, clock);
    const before = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' });
    expect(before.members).toEqual(['ins_A', 'ins_B', 'ins_C']);
    expect(before.evidence.strictDecisionTime).toBe(true);
    clock.set('2022-01-01T00:00:01.000Z');
    await api.ingest(claim({ effectiveAt: '2022-01-01T00:00:00.000Z', retrievedAt: '2021-12-20T10:00:00.000Z', members: [member('A'), member('F')] }), byProviderId);
    const after = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' });
    expect(after.evidence.fingerprint).toBe(before.evidence.fingerprint);
    expect(after.members).toEqual(['ins_A', 'ins_B', 'ins_C']);
  });

  it('historical reconstruction: a 2015 membership stored by NEXUS in 2026 is never decision-time evidence in 2016', async () => {
    await seed(api, clock);
    clock.set('2026-10-01T00:00:01.000Z');
    const late = await api.ingest(claim({ effectiveAt: '2015-01-01T00:00:00.000Z', retrievedAt: '2026-10-01T00:00:00.000Z', members: [member('A')] }), byProviderId);
    expect(late.revision.vintage).toBe('historical_reconstruction');
    expect((await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2016-01-01T00:00:00.000Z', mode: 'decision_time' })).evidence).toMatchObject({ status: 'UNAVAILABLE', strictDecisionTime: false });
    expect((await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2016-01-01T00:00:00.000Z', mode: 'historical_research' })).evidence).toMatchObject({ status: 'SELECTED', historicalReconstruction: true, strictDecisionTime: false });
  });

  it('revision replay: decision time sees only the sealed revision; the correction stored later is not visible before its seal', async () => {
    await seed(api, clock);
    expect((await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-02-05T00:00:00.000Z', mode: 'decision_time' })).evidence.revision).toBe(1);
    expect((await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-02-05T00:00:00.000Z', mode: 'historical_research' })).evidence).toMatchObject({ revision: 2, decisionTimeKnowledgeProven: false });
    expect((await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-03-01T00:00:00.000Z', mode: 'decision_time' })).members).toEqual(['ins_A', 'ins_B', 'ins_D', 'ins_E']);
  });

  it('storedThrough: a later sealed backfill cannot change a replay stored through an earlier sequence', async () => {
    await seed(api, clock);
    const seq = await api.currentIngestSeq();
    const frozen = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-03-10T00:00:00.000Z', mode: 'decision_time', storedThrough: seq });
    clock.set('2021-03-05T00:00:01.000Z');
    await api.ingest(claim({ effectiveAt: '2021-01-01T00:00:00.000Z', retrievedAt: '2021-03-05T00:00:00.000Z', members: [member('A'), member('B'), member('D'), member('F')] }), byProviderId);
    const replayed = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-03-10T00:00:00.000Z', mode: 'decision_time', storedThrough: seq });
    expect(replayed.evidence.fingerprint).toBe(frozen.evidence.fingerprint);
    expect(replayed.members).toEqual(['ins_A', 'ins_B', 'ins_D', 'ins_E']);
    expect((await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2021-03-10T00:00:00.000Z', mode: 'decision_time' })).evidence.revision).toBe(3);
  });

  it('an unresolved member in a COMPLETE snapshot is refused, and nothing is stored (silent loss is forbidden)', async () => {
    await seed(api, clock);
    const seqBefore = await api.currentIngestSeq();
    const revisionsBefore = (await api.all()).length;
    clock.set('2023-12-31T12:00:01.000Z');
    const unresolvable: UniverseMemberInput = { sourceMemberKey: 'key:X', providerSymbol: 'XXX' };
    await expect(api.ingest(claim({ effectiveAt: '2024-01-01T00:00:00.000Z', retrievedAt: '2023-12-31T12:00:00.000Z', members: [member('A'), unresolvable] }), byProviderId)).rejects.toMatchObject({ code: 'UNIVERSE_MEMBER_UNRESOLVED' });
    expect(await api.currentIngestSeq()).toBe(seqBefore);
    expect((await api.all()).length).toBe(revisionsBefore);
    const rows = (await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM universe_snapshot_members m JOIN universe_snapshot_revisions r USING (snapshot_revision_id) WHERE r.effective_at = '2024-01-01T00:00:00Z'")).rows[0];
    expect(rows?.n).toBe(0);
  });

  it('a PARTIAL snapshot stores its unresolved members visibly and is never complete', async () => {
    await api.registerSource(SOURCE);
    await api.registerDefinition(DEFINITION);
    clock.set('2019-12-31T12:00:01.000Z');
    const stored = await api.ingest(claim({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2019-12-31T12:00:00.000Z', completeness: 'PARTIAL', members: [member('A'), { sourceMemberKey: 'key:X', providerSymbol: 'XXX', exchange: 'NYSE' }] }), byProviderId);
    expect(stored.revision.unresolvedMembers).toEqual([{ sourceMemberKey: 'key:X', providerSymbol: 'XXX', providerInstrumentId: null, exchange: 'NYSE' }]);
    expect((await api.revisionById(stored.revision.snapshotRevisionId))!.unresolvedMembers).toHaveLength(1);
    expect((await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' })).evidence).toMatchObject({ complete: false, strictDecisionTime: false, completeness: 'PARTIAL' });
  });

  it('the database refuses an unresolved member for a COMPLETE revision (defence in depth)', async () => {
    await seed(api, clock);
    const rev = (await api.all())[0]!;
    await expect(db.pool.query('INSERT INTO universe_unresolved_members (snapshot_revision_id, source_member_key, provider_symbol) VALUES ($1, $2, $3)', [rev.snapshotRevisionId, 'key:Q', 'QQQ'])).rejects.toThrow(/PARTIAL/);
  });

  it('knowledge never regresses within a snapshot key: a revision claimed known before its predecessor is refused', async () => {
    await seed(api, clock);
    clock.set('2021-02-10T10:00:01.000Z');
    await expect(api.ingest(claim({ effectiveAt: '2021-01-01T00:00:00.000Z', retrievedAt: '2021-01-20T00:00:00.000Z', members: [member('A')] }), byProviderId)).rejects.toMatchObject({ code: 'UNIVERSE_KNOWLEDGE_REGRESSION' });
  });

  it('the database enforces the next revision number of a key (a raw insert of revision 9 is refused)', async () => {
    await seed(api, clock);
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
    await seed(api, clock);
    const again = await api.ingest(claim({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2019-12-31T12:00:00.000Z', members: [member('C'), member('A'), member('B')] }), byProviderId);
    expect(again.status).toBe('ALREADY_APPLIED');
    expect((await api.all()).length).toBe(3);
    await expect(api.registerSource({ ...SOURCE, provider: 'forged' })).rejects.toMatchObject({ code: 'UNIVERSE_CONFLICT' });
    await expect(api.registerDefinition({ ...DEFINITION, name: 'Other' })).rejects.toMatchObject({ code: 'UNIVERSE_CONFLICT' });
    await api.registerSource(SOURCE);
  });

  it('append-only: UPDATE, DELETE and TRUNCATE are rejected on every universe table, the seals included', async () => {
    await seed(api, clock);
    const updates: string[] = [
      'UPDATE universe_sources SET source_hash = source_hash',
      'UPDATE universe_definitions SET definition_hash = definition_hash',
      'UPDATE universe_snapshot_revisions SET result_hash = result_hash',
      'UPDATE universe_snapshot_members SET source_member_key = source_member_key',
      'UPDATE universe_revision_seals SET seal_hash = seal_hash',
    ];
    for (const sql of updates) await expect(db.pool.query(sql), sql).rejects.toThrow(/NEXUS_APPEND_ONLY/);
    for (const table of ['universe_revision_seals', 'universe_snapshot_members', 'universe_snapshot_revisions', 'universe_definitions']) {
      await expect(db.pool.query('DELETE FROM ' + table), table).rejects.toThrow(/NEXUS_APPEND_ONLY/);
      await expect(db.pool.query('TRUNCATE ' + table), table).rejects.toThrow(/NEXUS_APPEND_ONLY|cannot truncate/);
    }
    expect((await api.all()).length).toBe(3);
  });

  it('tamper: a changed payload is refused on read (the stored hash no longer matches)', async () => {
    await seed(api, clock);
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
    await seed(api, clock);
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

  it('tamper: a changed or deleted member row is refused on read', async () => {
    await seed(api, clock);
    const rev = (await api.all())[0]!;
    const c = await db.privilegedClient();
    try {
      await c.query("SET session_replication_role = 'replica'");
      await c.query("UPDATE universe_snapshot_members SET instrument_id = 'ins_FORGED' WHERE snapshot_revision_id = $1 AND instrument_id = 'ins_B'", [rev.snapshotRevisionId]);
    } finally {
      await c.end();
    }
    await expect(api.revisionById(rev.snapshotRevisionId)).rejects.toMatchObject({ code: 'UNIVERSE_INTEGRITY_FAILED' });
    const d = await db.privilegedClient();
    try {
      await d.query("SET session_replication_role = 'replica'");
      await d.query("DELETE FROM universe_snapshot_members WHERE snapshot_revision_id = $1 AND instrument_id = 'ins_C'", [rev.snapshotRevisionId]);
    } finally {
      await d.end();
    }
    await expect(api.revisionById(rev.snapshotRevisionId)).rejects.toMatchObject({ code: 'UNIVERSE_INTEGRITY_FAILED' });
  });

  it('tamper: a changed header and a changed source are refused on read', async () => {
    await seed(api, clock);
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

  it('a second process sees the same revisions, seals and selections (no per-process state)', async () => {
    await seed(api, clock);
    const other = new PostgresUniverseStore(db.extraPool(), { clock: async () => clock.clock() });
    expect(await other.all()).toEqual(await api.all());
    expect((await other.select(QUERIES[3]!)).evidence).toEqual((await api.select(QUERIES[3]!)).evidence);
  });

  it('a thousand members: one statement per child table, and the same identity as in memory', async () => {
    await seed(api, clock);
    const memClock = manualClock('2019-12-31T12:00:01.000Z');
    const memory = memoryApi(memClock);
    await seed(memory, memClock);
    const pids = Array.from({ length: 1000 }, (_, i) => 'M' + String(i).padStart(4, '0'));
    const input = claim({ effectiveAt: '2022-01-01T00:00:00.000Z', retrievedAt: '2021-12-31T12:00:00.000Z', members: pids.map((p) => member(p)) });
    clock.set('2021-12-31T12:00:01.000Z');
    const started = Date.now();
    const pg = await api.ingest(input, byProviderId);
    const ingestMs = Date.now() - started;
    memClock.set('2021-12-31T12:00:01.000Z');
    const mem = await memory.ingest(input, byProviderId);
    expect(pg.revision.snapshotRevisionId).toBe(mem.revision.snapshotRevisionId);
    const sel = await api.select({ universeId: UNIVERSE, sourceId: SOURCE.sourceId, asOf: '2023-01-01T00:00:00.000Z', mode: 'decision_time' });
    expect(sel.members).toHaveLength(1000);
    expect(sel.evidence.memberCount).toBe(1000);
    expect(sel.evidence.strictDecisionTime).toBe(true);
    expect(ingestMs).toBeLessThan(20_000);
  });
});

