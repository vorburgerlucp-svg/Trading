// The eToro demo service: append-only storage, the reconciliation before any write, failed attempts recorded, freshness, the
// ledger read without a single write, and the rule that no key appears in anything that is stored or returned.
import { describe, expect, it } from 'vitest';
import { accounts } from '../../../src/capital/accounts.js';
import { CapitalLedger } from '../../../src/capital/capital-ledger.js';
import type { AccountBalance, AccountKey } from '../../../src/capital/capital-types.js';
import { EtoroBrokerService, ETORO_SNAPSHOT_MAX_AGE_MS, type EtoroLedgerView, type EtoroReconciliationRecord, type EtoroSnapshotRecord, type EtoroSyncRecord } from '../../../src/broker/etoro/etoro-broker-service.js';
import { EtoroBrokerSyncAdapter, type EtoroSnapshot } from '../../../src/broker/etoro/etoro-sync-adapter.js';
import { HttpsEtoroTransport, type EtoroFetch } from '../../../src/broker/etoro/etoro-transport.js';
import { AppendOnlyLog } from '../../../src/persistence/append-only-log.js';
import { Decimal } from '../../../src/money/decimal.js';
import { rappen } from '../../../src/money/money.js';
import { KEY_MARKER, USER_MARKER, FixtureEtoroTransport, emptyDemoPortfolio, fixedClock } from './o20-fixture.js';

const T0 = '2026-10-16T09:00:00.000Z';

interface Harness {
  service: EtoroBrokerService;
  transport: FixtureEtoroTransport;
  ledger: CapitalLedger;
  snapshots: AppendOnlyLog<EtoroSnapshotRecord>;
  reconciliations: AppendOnlyLog<EtoroReconciliationRecord>;
  syncs: AppendOnlyLog<EtoroSyncRecord>;
  clock: ReturnType<typeof fixedClock>;
}

interface HarnessOptions {
  /** A ledger view with only balances(). Defaults to the empty in-memory ledger. */
  ledger?: EtoroLedgerView;
  /** A replacement adapter, for the cases that need a broker answer the fixture does not give. */
  adapter?: EtoroBrokerSyncAdapter;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = fixedClock(T0);
  const transport = new FixtureEtoroTransport();
  const ledger = await CapitalLedger.inMemory();
  const snapshots = await AppendOnlyLog.inMemory<EtoroSnapshotRecord>('etoro-snapshots', { clock: clock.now });
  const reconciliations = await AppendOnlyLog.inMemory<EtoroReconciliationRecord>('etoro-reconciliations', { clock: clock.now });
  const syncs = await AppendOnlyLog.inMemory<EtoroSyncRecord>('etoro-sync-events', { clock: clock.now });
  // The service sees the ledger through balances() only: nothing else of the ledger is reachable from it.
  const ledgerView: EtoroLedgerView = options.ledger ?? { balances: () => ledger.balances() };
  const service = new EtoroBrokerService({
    adapter: options.adapter ?? new EtoroBrokerSyncAdapter({ transport, clock: clock.now }),
    ledger: ledgerView,
    snapshots,
    reconciliations,
    syncs,
    clock: clock.now,
  });
  return { service, transport, ledger, snapshots, reconciliations, syncs, clock };
}

describe('O20 eToro service: a successful sync stores the snapshot, the reconciliation and the sync record', () => {
  it('an empty demo portfolio against an empty ledger is matched, and all three records are stored', async () => {
    const h = await harness();
    const result = await h.service.sync();
    expect(result.reconciliation.matched).toBe(true);
    expect(result.reconciliation.issues).toEqual([]);
    expect(result.snapshot.content).toMatchObject({ broker: 'etoro', accountId: null, access: 'read_only', positionCount: 0, openOrderCount: 0 });
    expect(h.snapshots.size).toBe(1);
    expect(h.reconciliations.size).toBe(1);
    expect(h.syncs.size).toBe(1);
    expect(h.syncs.all()[0]?.payload).toMatchObject({ outcome: 'success', observedAt: T0 });
  });

  it('the same content twice keeps one snapshot, and records each observation as its own sync', async () => {
    const h = await harness();
    const first = await h.service.sync();
    h.clock.advance(60_000);
    const second = await h.service.sync();
    expect(second.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
    expect(h.snapshots.size).toBe(1);
    expect(h.syncs.size).toBe(2);
  });

  it('the stored content carries the coverage and no account identifier', async () => {
    const h = await harness();
    await h.service.sync();
    const stored = h.snapshots.all()[0]?.payload.content;
    expect(stored?.coverage).toEqual({ cash: 'not_read', positions: 'verified_empty', openOrders: 'verified_empty', accountIdentity: 'not_observed' });
    expect(stored?.accountId).toBeNull();
  });
});

describe('O20 eToro service: the ledger is read, never written', () => {
  it('the ledger holds the same number of entries after two syncs', async () => {
    const h = await harness();
    const entriesBefore = h.ledger.size;
    await h.service.sync();
    await h.service.sync();
    expect(h.ledger.size).toBe(entriesBefore);
  });
});

describe('O20 eToro service: reconciliation before writing', () => {
  it('a ledger position of this broker that the demo portfolio does not hold is reported missing_at_broker, and the mismatch is stored', async () => {
    const balances = new Map<AccountKey, AccountBalance>([[accounts.position('etoro', 'ins_test'), { amount: rappen(0n), quantity: Decimal.from('2') }]]);
    const h = await harness({ ledger: { balances: () => balances } });
    const result = await h.service.sync();
    expect(result.reconciliation.matched).toBe(false);
    expect(result.reconciliation.issues).toEqual([expect.objectContaining({ kind: 'missing_at_broker', instrumentId: 'ins_test' })]);
    expect(h.reconciliations.size).toBe(1);
  });

  it('when the ledger cannot be read, the sync fails with BROKER_RECONCILIATION_FAILURE and stores no snapshot and no reconciliation', async () => {
    const h = await harness({
      ledger: {
        balances: () => {
          throw new Error('ledger unavailable');
        },
      },
    });
    await expect(h.service.sync()).rejects.toMatchObject({ code: 'BROKER_RECONCILIATION_FAILURE' });
    expect(h.snapshots.size).toBe(0);
    expect(h.reconciliations.size).toBe(0);
    expect(h.syncs.all()[0]?.payload).toMatchObject({ outcome: 'failed', errorCode: 'BROKER_RECONCILIATION_FAILURE' });
    expect(h.service.status().etoro.connection).toBe('error');
  });
});

describe('O20 eToro service: failed attempts are recorded, and nothing is stored', () => {
  it('a 401 from the broker is BROKER_AUTH_REQUIRED, recorded as a failed sync, and the status shows the error', async () => {
    const h = await harness();
    h.transport.response = { status: 401, body: null };
    await expect(h.service.sync()).rejects.toMatchObject({ code: 'BROKER_AUTH_REQUIRED' });
    expect(h.snapshots.size).toBe(0);
    expect(h.syncs.all()[0]?.payload).toMatchObject({ outcome: 'failed', errorCode: 'BROKER_AUTH_REQUIRED' });
    expect(h.service.status().etoro).toMatchObject({ connection: 'error', lastErrorCode: 'BROKER_AUTH_REQUIRED', lastSuccessfulSync: null });
  });

  it('a snapshot that carries entries is refused by the service as well: nothing that was not read is stored as empty', async () => {
    const entries = {
      broker: 'etoro',
      accountId: null,
      access: 'read_only',
      observedAt: T0,
      retrievedAt: T0,
      cash: [],
      positions: [{ instrumentId: 'ins_x' }],
      openOrders: [],
      coverage: { cash: 'not_read', positions: 'verified_empty', openOrders: 'verified_empty', accountIdentity: 'not_observed' },
    } as unknown as EtoroSnapshot;
    const adapter = { connection: () => 'connected', fetchSnapshot: async () => entries } as unknown as EtoroBrokerSyncAdapter;
    const h = await harness({ adapter });
    await expect(h.service.sync()).rejects.toMatchObject({ code: 'BROKER_RESPONSE_INVALID' });
    expect(h.snapshots.size).toBe(0);
    expect(h.syncs.all()[0]?.payload).toMatchObject({ outcome: 'failed', errorCode: 'BROKER_RESPONSE_INVALID' });
  });
});

describe('O20 eToro service: status, latest views and freshness', () => {
  it('before the first sync: not connected, nothing stored, latest views are null', async () => {
    const h = await harness();
    expect(h.service.status().etoro).toMatchObject({ configured: true, tradingMode: 'demo', connection: 'not_connected', lastSuccessfulSync: null, lastErrorCode: null });
    expect(await h.service.latestSnapshot()).toBeNull();
    expect(await h.service.latestReconciliation(false)).toBeNull();
  });

  it('after a success: connected, the latest snapshot and reconciliation are returned, and the status sends no request', async () => {
    const h = await harness();
    await h.service.sync();
    const callsBefore = h.transport.calls.length;
    expect(h.service.status().etoro).toMatchObject({ connection: 'connected', lastSuccessfulSync: T0 });
    expect((await h.service.latestSnapshot())?.content.positionCount).toBe(0);
    expect((await h.service.latestReconciliation(false))?.matched).toBe(true);
    expect(h.transport.calls.length).toBe(callsBefore);
  });

  it('a reconciliation older than the freshness limit is stale; requireFresh refuses it with BROKER_SNAPSHOT_STALE', async () => {
    const h = await harness();
    await h.service.sync();
    h.clock.advance(ETORO_SNAPSHOT_MAX_AGE_MS + 1);
    expect(await h.service.latestReconciliation(false)).toMatchObject({ stale: true, freshness: 'stale' });
    await expect(h.service.latestReconciliation(true)).rejects.toMatchObject({ code: 'BROKER_SNAPSHOT_STALE' });
  });

  it('a fresh reconciliation is accepted with requireFresh', async () => {
    const h = await harness();
    await h.service.sync();
    h.clock.advance(ETORO_SNAPSHOT_MAX_AGE_MS - 1_000);
    expect(await h.service.latestReconciliation(true)).toMatchObject({ stale: false, freshness: 'fresh' });
  });
});

describe('O20 eToro service: no key appears in anything stored or returned', () => {
  it('a full chain from the real transport, with marker keys, leaves no key in any record, status, or view', async () => {
    const clock = fixedClock(T0);
    const requests: string[] = [];
    const fetch: EtoroFetch = async (url, init) => {
      requests.push(url, JSON.stringify(init.headers));
      return new Response(JSON.stringify(emptyDemoPortfolio()), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const ledger = await CapitalLedger.inMemory();
    const snapshots = await AppendOnlyLog.inMemory<EtoroSnapshotRecord>('etoro-snapshots', { clock: clock.now });
    const reconciliations = await AppendOnlyLog.inMemory<EtoroReconciliationRecord>('etoro-reconciliations', { clock: clock.now });
    const syncs = await AppendOnlyLog.inMemory<EtoroSyncRecord>('etoro-sync-events', { clock: clock.now });
    const transport = new HttpsEtoroTransport({ credentials: { apiKey: KEY_MARKER, userKey: USER_MARKER }, fetch });
    const service = new EtoroBrokerService({
      adapter: new EtoroBrokerSyncAdapter({ transport, clock: clock.now }),
      ledger: { balances: () => ledger.balances() },
      snapshots,
      reconciliations,
      syncs,
      clock: clock.now,
    });
    const result = await service.sync();
    const everything = JSON.stringify({
      result,
      status: service.status(),
      latestSnapshot: await service.latestSnapshot(),
      latestReconciliation: await service.latestReconciliation(false),
      snapshots: snapshots.all(),
      reconciliations: reconciliations.all(),
      syncs: syncs.all(),
    });
    expect(everything).not.toContain(KEY_MARKER);
    expect(everything).not.toContain(USER_MARKER);
    expect(everything).not.toMatch(/x-api-key|x-user-key|x-request-id/);
    // The keys travel to the broker as request headers only: that is the one place they are allowed.
    expect(requests.join(' ')).toContain(KEY_MARKER);
  });
});
