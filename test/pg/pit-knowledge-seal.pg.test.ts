import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresUniverseStore } from '../../src/persistence/postgres/postgres-universe-store.js';
import { databaseClock } from '../../src/persistence/postgres/postgres-scanner-backtest-store.js';
import type { UniverseSource, UniverseSnapshotInput } from '../../src/universe/universe-model.js';
import { manualClock } from '../universe/fixtures.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// PostgreSQL timing proof of universe revisions (migration 011). The database clock brackets each commit; the seal is append-only, bound to
// its revision, and a missing, moved or altered seal never becomes decision-time knowledge. See docs/PIT_UNIVERSE_KNOWLEDGE_SEAL.md.

const SOURCE: UniverseSource = { sourceId: 'vendor:constituents', provider: 'vendor', dataset: 'index_constituents', environment: 'production', license: 'internal_use' };
const ids = (...symbols: string[]) => symbols.map((s) => ({ sourceMemberKey: 'key:' + s, providerSymbol: s }));
const resolve = (m: { providerSymbol: string }) => m.providerSymbol;

function claim(o: { effectiveAt: string; retrievedAt: string; symbols?: string[] }): UniverseSnapshotInput {
  return { universeId: 'u', sourceId: SOURCE.sourceId, effectiveAt: o.effectiveAt, retrievedAt: o.retrievedAt, knowledgeSource: 'captured_by_nexus', knownAt: o.retrievedAt, completeness: 'COMPLETE', members: ids(...(o.symbols ?? ['ins_a'])) };
}

describe.skipIf(!pgAvailable)('PostgreSQL timing proof of universe revisions' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase;
  let clock: ReturnType<typeof manualClock>;
  let store: PostgresUniverseStore;

  beforeEach(async () => {
    db = await createTestDatabase();
    clock = manualClock('2026-10-09T12:00:00.000Z');
    store = new PostgresUniverseStore(db.pool, { clock: async () => clock.clock() });
    await store.registerSource(SOURCE);
    await store.registerDefinition({ universeId: 'u', definitionVersion: '1', name: 'seal' });
  });

  afterEach(async () => {
    await db?.drop();
  });

  /** Writes as a superuser that bypasses NEXUS's triggers (CHECK constraints still apply). */
  async function privileged(sql: string, params: unknown[] = []): Promise<void> {
    const c = await db.privilegedClient();
    try {
      await c.query("SET session_replication_role = 'replica'");
      await c.query(sql, params);
    } finally {
      await c.end();
    }
  }

  it('the seal uses the database clock: its readings lie between the database clock taken before and after the ingest, recordedAt <= sealedAt', async () => {
    const dbClockStore = new PostgresUniverseStore(db.pool);
    const before = await databaseClock(db.pool);
    const stored = await dbClockStore.ingest(claim({ effectiveAt: '2026-01-01T00:00:00.000Z', retrievedAt: '2026-01-01T00:00:00.000Z' }), resolve);
    const after = await databaseClock(db.pool);
    expect(stored.timingProof.proofKind).toBe('COMMIT_SEAL');
    expect(stored.timingProof.recordedAt >= before).toBe(true);
    expect(stored.timingProof.sealedAt <= after).toBe(true);
    expect(stored.timingProof.recordedAt <= stored.timingProof.sealedAt).toBe(true);
    expect(await dbClockStore.timingProofOf(stored.revision.snapshotRevisionId)).toEqual(stored.timingProof);
  });

  it('the seal rows are immutable: UPDATE, DELETE and TRUNCATE are rejected', async () => {
    await store.ingest(claim({ effectiveAt: '2026-10-08T00:00:00.000Z', retrievedAt: '2026-10-08T00:00:00.000Z' }), resolve);
    await expect(db.pool.query('UPDATE universe_revision_seals SET seal_hash = seal_hash')).rejects.toThrow(/NEXUS_APPEND_ONLY/);
    await expect(db.pool.query('DELETE FROM universe_revision_seals')).rejects.toThrow(/NEXUS_APPEND_ONLY/);
    await expect(db.pool.query('TRUNCATE universe_revision_seals')).rejects.toThrow(/NEXUS_APPEND_ONLY/);
  });

  it('a seal that does not bracket its revision is refused by the database: recordedAt after sealedAt, or a result hash of another revision', async () => {
    const stored = await store.ingest(claim({ effectiveAt: '2026-10-08T00:00:00.000Z', retrievedAt: '2026-10-08T00:00:00.000Z' }), resolve);
    await privileged('DELETE FROM universe_revision_seals WHERE snapshot_revision_id = $1', [stored.revision.snapshotRevisionId]);
    await expect(
      db.pool.query('INSERT INTO universe_revision_seals (snapshot_revision_id, proof_kind, result_hash, recorded_at, sealed_at, seal_hash) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6)', [
        stored.revision.snapshotRevisionId, 'COMMIT_SEAL', stored.timingProof.resultHash, '2026-10-08T00:00:02.000Z', '2026-10-08T00:00:01.000Z', 'b'.repeat(64),
      ]),
    ).rejects.toThrow(/universe_revision_seals_bounds/);
    await expect(
      db.pool.query('INSERT INTO universe_revision_seals (snapshot_revision_id, proof_kind, result_hash, recorded_at, sealed_at, seal_hash) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6)', [
        stored.revision.snapshotRevisionId, 'COMMIT_SEAL', 'a'.repeat(64), '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:01.000Z', 'b'.repeat(64),
      ]),
    ).rejects.toThrow(/does not match the stored revision/);
  });

  it('the crash gap: a committed revision without a seal is readable for research, never strict; a retry attests presence from its retry time only', async () => {
    let crash = true;
    const crashing = new PostgresUniverseStore(db.pool, {
      clock: async () => clock.clock(),
      afterCommit: async () => {
        if (crash) throw new Error('crash between commit and seal');
      },
    });
    const input = claim({ effectiveAt: '2026-10-09T09:00:00.000Z', retrievedAt: '2026-10-09T09:00:00.000Z' });
    clock.set('2026-10-09T10:00:00.000Z');
    await expect(crashing.ingest(input, resolve)).rejects.toThrow(/crash between commit and seal/);
    const [revision] = await store.all();
    expect(revision).toBeDefined();
    expect(await store.timingProofOf(revision!.snapshotRevisionId)).toBeNull();
    expect((await store.select({ universeId: 'u', sourceId: SOURCE.sourceId, asOf: '2026-10-09T11:00:00.000Z', mode: 'historical_research' })).evidence).toMatchObject({ status: 'SELECTED', knowledgeProof: 'UNSEALED', strictDecisionTime: false });
    expect((await store.select({ universeId: 'u', sourceId: SOURCE.sourceId, asOf: '2026-10-09T11:00:00.000Z', mode: 'decision_time' })).evidence.status).toBe('UNAVAILABLE');

    crash = false;
    clock.set('2026-10-09T12:05:00.000Z');
    const retry = await crashing.ingest(input, resolve);
    expect(retry.status).toBe('ALREADY_APPLIED');
    expect(retry.timingProof).toMatchObject({ proofKind: 'PRESENCE_ATTESTATION', sealedAt: '2026-10-09T12:05:00.000Z' });
    expect((await store.select({ universeId: 'u', sourceId: SOURCE.sourceId, asOf: '2026-10-09T12:04:00.000Z', mode: 'decision_time' })).evidence.status).toBe('UNAVAILABLE');
    expect((await store.select({ universeId: 'u', sourceId: SOURCE.sourceId, asOf: '2026-10-09T12:06:00.000Z', mode: 'decision_time' })).evidence).toMatchObject({ knowledgeProof: 'PRESENCE_ATTESTED', decisionTimeKnowledgeProven: true, storeSealedAt: '2026-10-09T12:05:00.000Z' });
  });

  it('a missing seal (a revision stored before migration 011, or a seal lost): decision time refuses it, research reads it, and it is never strict', async () => {
    const stored = await store.ingest(claim({ effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2019-12-31T12:00:00.000Z' }), resolve);
    clock.set('2019-12-31T12:00:01.000Z');
    await privileged('DELETE FROM universe_revision_seals WHERE snapshot_revision_id = $1', [stored.revision.snapshotRevisionId]);
    expect((await store.select({ universeId: 'u', sourceId: SOURCE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'decision_time' })).evidence.status).toBe('UNAVAILABLE');
    expect((await store.select({ universeId: 'u', sourceId: SOURCE.sourceId, asOf: '2020-06-01T00:00:00.000Z', mode: 'historical_research' })).evidence).toMatchObject({ status: 'SELECTED', knowledgeProof: 'UNSEALED', strictDecisionTime: false });
    expect(await store.revisionById(stored.revision.snapshotRevisionId)).toEqual(stored.revision);
  });

  it('a tampered seal fails closed: an altered sealed_at, recorded_at, seal_hash or result_hash is refused on read and on decision-time evidence', async () => {
    const stored = await store.ingest(claim({ effectiveAt: '2026-10-08T00:00:00.000Z', retrievedAt: '2026-10-08T00:00:00.000Z' }), resolve);
    const rid = stored.revision.snapshotRevisionId;
    const original = stored.timingProof;
    const cases: [string, string, string][] = [
      ['sealed_at', "UPDATE universe_revision_seals SET sealed_at = '2026-10-09T12:00:01Z' WHERE snapshot_revision_id = $1", 'sealed_at'],
      ['recorded_at', "UPDATE universe_revision_seals SET recorded_at = '2026-10-09T11:59:59Z' WHERE snapshot_revision_id = $1", 'recorded_at'],
      ['seal_hash', "UPDATE universe_revision_seals SET seal_hash = $2 WHERE snapshot_revision_id = $1", 'seal_hash'],
      ['result_hash', "UPDATE universe_revision_seals SET result_hash = $2 WHERE snapshot_revision_id = $1", 'result_hash'],
    ];
    for (const [field, sql, label] of cases) {
      const params: unknown[] = [rid];
      if (sql.includes('$2')) params.push(field === 'seal_hash' ? 'e'.repeat(64) : 'f'.repeat(64));
      await privileged(sql, params);
      await expect(store.timingProofOf(rid), label).rejects.toMatchObject({ code: 'UNIVERSE_INTEGRITY_FAILED' });
      await expect(store.select({ universeId: 'u', sourceId: SOURCE.sourceId, asOf: '2026-10-09T00:00:00.000Z', mode: 'decision_time' }), label).rejects.toMatchObject({ code: 'UNIVERSE_INTEGRITY_FAILED' });
      await privileged("UPDATE universe_revision_seals SET sealed_at = $2, recorded_at = $3, seal_hash = $4, result_hash = $5 WHERE snapshot_revision_id = $1", [rid, original.sealedAt, original.recordedAt, original.sealHash, original.resultHash]);
      expect(await store.timingProofOf(rid), 'restored after ' + label).toEqual(original);
    }
  });

  it('a seal moved onto another revision fails closed', async () => {
    const a = await store.ingest(claim({ effectiveAt: '2026-10-07T00:00:00.000Z', retrievedAt: '2026-10-07T00:00:00.000Z' }), resolve);
    const b = await store.ingest(claim({ effectiveAt: '2026-10-08T00:00:00.000Z', retrievedAt: '2026-10-08T00:00:00.000Z' }), resolve);
    await privileged('DELETE FROM universe_revision_seals WHERE snapshot_revision_id = $1', [b.revision.snapshotRevisionId]);
    await privileged('UPDATE universe_revision_seals SET snapshot_revision_id = $2 WHERE snapshot_revision_id = $1', [a.revision.snapshotRevisionId, b.revision.snapshotRevisionId]);
    await expect(store.timingProofOf(b.revision.snapshotRevisionId)).rejects.toMatchObject({ code: 'UNIVERSE_INTEGRITY_FAILED' });
  });

  it('a claimed retrieval after the database clock is refused: a claim cannot describe a retrieval NEXUS had not performed', async () => {
    const dbClockStore = new PostgresUniverseStore(db.pool);
    await expect(dbClockStore.ingest(claim({ effectiveAt: '2100-01-01T00:00:00.000Z', retrievedAt: '2100-01-01T00:00:00.000Z' }), resolve)).rejects.toMatchObject({ code: 'UNIVERSE_INVALID' });
  });
});

