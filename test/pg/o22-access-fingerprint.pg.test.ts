// O22 Plan B review R3 on a real PostgreSQL with two processes (own pools, own logs, isolated test database): the broker access
// fingerprint across processes. Another configured account in one process, a key rotation that one process has made and the other
// not yet, and a crash right after a stamped record. No network: fixture portfolio reads, scripted broker answers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import type { EtoroSyncRecord } from '../../src/broker/etoro/etoro-broker-service.js';
import type { ExternalClosureRecord } from '../../src/broker/etoro/execution/external-closure.js';
import { CREATOR, ScriptedBroker, TEST_ACCESS_KEY, openInput, testAccess, type O21Stores } from '../broker/etoro/o21-fixture.js';
import { FaultStore, InjectedCrash } from '../broker/etoro/o22-fault-store.js';
import { closureProcess, filledThenClosedByHand, type ClosureProcess, type EtoroStores } from '../broker/etoro/o22-external-closure-scenario.js';
import type { AccessVerifier } from '../../src/broker/etoro/etoro-access-fingerprint.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// TEST ONLY: filledOpen() exercises the write path, so this module replaces the compile-time lock for this module only.
vi.mock('../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});

const K2 = Object.freeze({ id: 'test-k2', secret: 'O22-TEST-ACCESS-HMAC-KEY-MARKER-ROTATED-fedcba9876543210' });
const OTHER_USER_KEY = 'O22-OTHER-ACCOUNT-USER-KEY-MARKER-000000000000000000000000003';

async function stores(pool: PgPool): Promise<{ execution: O21Stores; etoro: EtoroStores; closures: PostgresAppendOnlyStore<ExternalClosureRecord> }> {
  return {
    execution: {
      intents: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-intents'),
      attempts: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-attempts'),
      confirmations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-broker-confirmations'),
      reconciliations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-reconciliations'),
    },
    etoro: {
      snapshots: await PostgresAppendOnlyStore.open(pool, 'etoro-snapshots'),
      reconciliations: await PostgresAppendOnlyStore.open(pool, 'etoro-reconciliations'),
      syncs: await PostgresAppendOnlyStore.open(pool, 'etoro-sync-events'),
    },
    closures: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-external-closures'),
  };
}

const databases: TestDatabase[] = [];

describe.skipIf(!pgAvailable)('O22 Plan B R3 broker access fingerprint, two processes on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  async function twoProcesses(accessB: AccessVerifier, options: { faultSyncsB?: boolean } = {}): Promise<{ a: ClosureProcess; b: ClosureProcess; open: string; closedSnapshot: string; syncsB: FaultStore<EtoroSyncRecord> | null; db: TestDatabase }> {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const sa = await stores(db.pool);
    const a = await closureProcess({ stores: sa.execution, etoroStores: sa.etoro, closures: sa.closures, broker });
    const { open, closedSnapshot } = await filledThenClosedByHand(a);
    const sb = await stores(db.extraPool());
    const syncsB = options.faultSyncsB ? new FaultStore(sb.etoro.syncs) : null;
    const b = await closureProcess({ stores: sb.execution, etoroStores: { ...sb.etoro, ...(syncsB ? { syncs: syncsB } : {}) }, closures: sb.closures, broker, access: accessB, seed: false });
    b.f.clock.now = new Date(a.f.clock.now.getTime());
    return { a, b, open, closedSnapshot, syncsB, db };
  }

  const probe = (p: ClosureProcess, run: string) =>
    p.f.service.create({ ...openInput({ strategyRunId: run }), createdAt: p.f.clock.now.toISOString(), expiresAt: new Date(p.f.clock.now.getTime() + 600_000).toISOString() }, CREATOR);

  it('B is configured with another account: its newer read refuses A\'s open and A\'s attestation; B cannot attest A\'s open', async () => {
    const { a, b, open, closedSnapshot } = await twoProcesses(testAccess({ userKey: OTHER_USER_KEY }));
    expect((await b.attest(open, closedSnapshot).catch((e) => e)).reasons).toEqual(['OPEN_ATTEMPT_ACCESS_MISMATCH', 'CONTINUITY_SNAPSHOT_ACCESS_MISMATCH', 'EVIDENCE_SNAPSHOT_ACCESS_MISMATCH']);
    b.f.advance(10_000);
    const foreign = await b.sync('without_position');
    a.f.advance(10_000);
    expect((await probe(a, 'run-r3-pg-a')).gateReasons).toContain('BROKER_SNAPSHOT_ACCESS_MISMATCH');
    expect((await a.attest(open, foreign).catch((e) => e)).reasons).toEqual(['EVIDENCE_SNAPSHOT_ACCESS_MISMATCH']);
    expect(a.f.broker.writes).toHaveLength(1);
  }, 60_000);

  it('during a rotation: B (k2, k1 kept) checks A\'s k1 stamps and attests; A (k1 only) cannot check B\'s k2 read and refuses an open', async () => {
    const { a, b, open, closedSnapshot, db } = await twoProcesses(testAccess({ current: K2, previous: TEST_ACCESS_KEY }));
    const record = await b.attest(open, closedSnapshot);
    expect(record.access.evidenceSnapshot.keyId).toBe('test-k1');
    b.f.advance(10_000);
    await b.sync('without_position');
    a.f.advance(10_000);
    expect((await probe(a, 'run-r3-pg-rotation')).gateReasons).toContain('BROKER_SNAPSHOT_ACCESS_KEY_UNKNOWN');
    // Once A has rotated too (k2, k1 kept), the same read is A's own configured access.
    const a2 = await closureProcess({ stores: a.f.stores, broker: a.f.broker, access: testAccess({ current: K2, previous: TEST_ACCESS_KEY }), seed: false, etoroStores: (await stores(db.pool)).etoro });
    a2.f.clock.now = new Date(a.f.clock.now.getTime());
    expect((await probe(a2, 'run-r3-pg-rotated')).gateReasons).not.toContain('BROKER_SNAPSHOT_ACCESS_KEY_UNKNOWN');
  }, 60_000);

  it('B crashes right after its stamped read committed: the record is complete, and A (same credentials) relies on it', async () => {
    const { a, b, syncsB } = await twoProcesses(testAccess(), { faultSyncsB: true });
    b.f.advance(10_000);
    syncsB!.crashAt((s) => s.outcome === 'success', 'after');
    await expect(b.sync('without_position')).rejects.toBeInstanceOf(InjectedCrash);
    a.f.advance(10_000);
    // The newest read is B's (crashed after its commit): complete and stamped with the same configured access. No access refusal
    // (other refusals, such as A's still live position, are not the subject here).
    const opened = await probe(a, 'run-r3-pg-crash');
    expect(opened.gateReasons.filter((r) => r.includes('ACCESS'))).toEqual([]);
    expect((await a.etoro.latestStoredSnapshot())).toMatchObject({ kind: 'snapshot', snapshot: { access: testAccess().stamp() } });
  }, 60_000);
});
