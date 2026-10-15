// The IBKR service over the fixture gateway, with in-memory append-only logs and a real Capital Ledger: persistence and idempotency,
// reconciliation differences, freshness, the explicit conid mapping, and the proof that a sync touches no ledger and no order.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accounts } from '../../../src/capital/accounts.js';
import { IbkrBrokerService, IBKR_SNAPSHOT_MAX_AGE_MS, type ReconciliationRecord, type SnapshotRecord, type SyncRecord } from '../../../src/broker/ibkr/ibkr-broker-service.js';
import { IbkrError } from '../../../src/broker/ibkr/ibkr-errors.js';
import { IbkrBrokerSyncAdapter } from '../../../src/broker/ibkr/ibkr-sync-adapter.js';
import { IBKR_ALLOWED_OPERATIONS } from '../../../src/broker/ibkr/ibkr-readonly.js';
import { InstrumentRegistry, type InstrumentEvent } from '../../../src/market-data/instrument-registry.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import { chf } from '../../../src/money/money.js';
import { newEngine, T0 } from '../../helpers.js';
import { AAPL } from '../../market-data/fixtures.js';
import { FixtureIbkrReadOnlyAdapter, FIXTURE_ACCOUNT, FIXTURE_CONID_AAPL, FIXTURE_SESSION_TOKEN, fixturePosition } from './o19-fixture.js';

const change = { at: T0, by: { kind: 'human' as const, id: 'o19-test' }, reason: 'o19 service test fixture' };

function clockAt(iso: string) {
  let current = Date.parse(iso);
  return { now: () => new Date(current), advance: (ms: number) => (current += ms) };
}

interface Build {
  fixture?: FixtureIbkrReadOnlyAdapter;
  ledgerSetup?: (engine: Awaited<ReturnType<typeof newEngine>>['engine']) => Promise<void>;
  mapAapl?: boolean;
}

async function build(options: Build = {}) {
  const clock = clockAt(T0);
  const { engine, ledger } = await newEngine();
  if (options.ledgerSetup) await options.ledgerSetup(engine);
  const registry = await InstrumentRegistry.open(new InMemoryAppendOnlyStore<InstrumentEvent>(), { clock: clock.now });
  await registry.register({ ...AAPL }, change);
  if (options.mapAapl !== false) {
    await registry.addMapping({ instrumentId: AAPL.instrumentId, provider: 'ibkr', providerInstrumentId: FIXTURE_CONID_AAPL, providerSymbol: FIXTURE_CONID_AAPL, validFrom: '1980-12-12T00:00:00Z' }, change);
  }
  const fixture = options.fixture ?? new FixtureIbkrReadOnlyAdapter();
  const snapshots = await AppendOnlyLog.open<SnapshotRecord>('broker-snapshots', new InMemoryAppendOnlyStore<SnapshotRecord>(), { clock: clock.now });
  const syncs = await AppendOnlyLog.open<SyncRecord>('broker-sync-events', new InMemoryAppendOnlyStore<SyncRecord>(), { clock: clock.now });
  const reconciliations = await AppendOnlyLog.open<ReconciliationRecord>('broker-reconciliations', new InMemoryAppendOnlyStore<ReconciliationRecord>(), { clock: clock.now });
  const adapter = new IbkrBrokerSyncAdapter({ transport: fixture, accountId: null, clock: clock.now, resolveInstrument: (conid, at) => registry.resolve('ibkr', conid, at) });
  const service = new IbkrBrokerService({ adapter, enabled: true, accountRef: null, ledger, registry, snapshots, syncs, reconciliations, clock: clock.now });
  return { service, adapter, fixture, ledger, engine, clock, registry, snapshots, syncs, reconciliations };
}

function ledgerState(ledger: { balances(): ReadonlyMap<string, { amount: unknown; quantity: { toString(): string } }> }): string {
  return JSON.stringify([...ledger.balances().entries()].map(([key, b]) => [key, String(b.amount), b.quantity.toString()]));
}

afterEach(() => vi.restoreAllMocks());

describe('O19 IBKR service: not connected means nothing is invented', () => {
  it('[1] with IBKR disabled, status says not connected, sync is refused, and there is no snapshot', async () => {
    const b = await build();
    const disabled = new IbkrBrokerService({
      adapter: b.adapter,
      enabled: false,
      accountRef: null,
      ledger: b.ledger,
      registry: b.registry,
      snapshots: b.snapshots,
      syncs: b.syncs,
      reconciliations: b.reconciliations,
      clock: b.clock.now,
    });
    expect(await disabled.status()).toMatchObject({ ibkr: { configured: false, connection: 'not_connected', access: 'read_only' } });
    await expect(disabled.sync()).rejects.toMatchObject({ code: 'BROKER_NOT_CONNECTED' });
    expect(await disabled.latestSnapshot()).toBeNull();
    expect(b.fixture.calls).toHaveLength(0);
  });

  it('before the first sync there is no snapshot and no reconciliation: nothing is shown as current truth', async () => {
    const { service } = await build();
    expect(await service.latestSnapshot()).toBeNull();
    expect(await service.latestReconciliation()).toBeNull();
    expect(await service.status()).toMatchObject({ ibkr: { configured: true, connection: 'not_connected', lastSuccessfulSync: null } });
  });
});

describe('O19 IBKR service: a sync persists, reconciles and reports', () => {
  it('stores the snapshot, the observation and the reconciliation, and returns them with freshness', async () => {
    const { service } = await build();
    const result = await service.sync();
    expect(result.snapshot).toMatchObject({ freshness: 'fresh', observedAt: T0 });
    expect(result.snapshot.content).toMatchObject({ broker: 'ibkr', accountRef: 'U****567', access: 'read_only', accountStatus: 'O' });
    expect(result.reconciliation).toMatchObject({ stale: false, matched: false });
    expect(await service.latestSnapshot()).toMatchObject({ snapshotId: result.snapshot.snapshotId, freshness: 'fresh' });
    expect(await service.status()).toMatchObject({ ibkr: { connection: 'connected', lastSuccessfulSync: T0, lastErrorCode: null } });
  });

  it('[12] a quantity mismatch between broker and ledger is reported with both values', async () => {
    const { service } = await build({
      ledgerSetup: async (engine) => {
        await engine.deposit({ to: accounts.brokerCash('ibkr'), amountChf: chf(500) });
        await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'ins_aapl', quantity: 1, grossAmountChf: chf(150) });
      },
    });
    const { reconciliation } = await service.sync();
    expect(reconciliation.issues).toContainEqual({ kind: 'quantity_mismatch', instrumentId: 'ins_aapl', broker: '2', ledger: '1' });
  });

  it('[13] a position held only at the broker is reported as missing in the ledger', async () => {
    const { service } = await build();
    const { reconciliation } = await service.sync();
    expect(reconciliation.issues).toContainEqual({ kind: 'missing_in_ledger', instrumentId: 'ins_aapl', broker: '2' });
  });

  it('[14] a position only in the ledger is reported as missing at the broker', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.data.positionPages = [[]];
    const { service } = await build({
      fixture,
      ledgerSetup: async (engine) => {
        await engine.deposit({ to: accounts.brokerCash('ibkr'), amountChf: chf(500) });
        await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'ins_aapl', quantity: 1, grossAmountChf: chf(150) });
      },
    });
    const { reconciliation } = await service.sync();
    expect(reconciliation.issues).toContainEqual({ kind: 'missing_at_broker', instrumentId: 'ins_aapl', ledger: '1' });
  });

  it('[15] a CHF cash difference is a cash mismatch, and it is not corrected', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.data.ledger = { CHF: { cashbalance: 200, currency: 'CHF' } };
    const { service, ledger } = await build({
      fixture,
      ledgerSetup: async (engine) => {
        await engine.deposit({ to: accounts.brokerCash('ibkr'), amountChf: chf(500) });
      },
    });
    const before = ledgerState(ledger);
    const { reconciliation } = await service.sync();
    expect(reconciliation.issues.some((i) => i.kind === 'cash_mismatch')).toBe(true);
    expect(ledgerState(ledger)).toBe(before);
  });

  it('[16] non-CHF cash is reported as unsupported, never converted', async () => {
    const { service } = await build();
    const { reconciliation } = await service.sync();
    expect(reconciliation.issues).toContainEqual({ kind: 'unsupported_currency', detail: 'USD 1000.50 cannot be reconciled: ledger is CHF-only' });
  });

  it('[17] a snapshot older than the freshness limit stays visible but is flagged stale', async () => {
    const { service, clock } = await build();
    await service.sync();
    clock.advance(IBKR_SNAPSHOT_MAX_AGE_MS + 1);
    expect(await service.latestSnapshot()).toMatchObject({ freshness: 'stale' });
    expect(await service.latestReconciliation()).toMatchObject({ stale: true, freshness: 'stale' });
  });
});

describe('O19 IBKR service: history is append-only and idempotent', () => {
  it('[18] an identical state observed twice is one snapshot record and two observations: no contradiction', async () => {
    const { service, clock, snapshots, syncs, reconciliations } = await build();
    await service.sync();
    clock.advance(10_000);
    await service.sync();
    expect(snapshots.all()).toHaveLength(1);
    expect(syncs.all()).toHaveLength(2);
    expect(reconciliations.all()).toHaveLength(1);
  });

  it('[19] the history only grows: earlier records keep their sequence and the chain verifies', async () => {
    const { service, clock, syncs } = await build();
    await service.sync();
    const first = syncs.all()[0]!;
    clock.advance(10_000);
    await service.sync();
    expect(syncs.all()[0]).toEqual(first);
    expect(syncs.verifyIntegrity()).toEqual({ ok: true });
    expect(typeof (syncs as unknown as Record<string, unknown>).update).toBe('undefined');
    expect(typeof (syncs as unknown as Record<string, unknown>).delete).toBe('undefined');
  });

  it('a changed broker state is a new snapshot, and the old one stays', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    const { service, clock, snapshots } = await build({ fixture });
    await service.sync();
    clock.advance(10_000);
    fixture.data.positionPages = [[fixturePosition({ position: 3, mktValue: 510.37 })]];
    await service.sync();
    expect(snapshots.all()).toHaveLength(2);
    expect(snapshots.verifyIntegrity()).toEqual({ ok: true });
  });
});

describe('O19 IBKR service: the sync changes nothing but the broker records', () => {
  it('[20] a sync leaves the Capital Ledger exactly as it was', async () => {
    const { service, ledger } = await build({
      ledgerSetup: async (e) => {
        await e.deposit({ to: accounts.brokerCash('ibkr'), amountChf: chf(500) });
      },
    });
    const before = ledgerState(ledger);
    await service.sync();
    expect(ledgerState(ledger)).toBe(before);
  });

  it('[21] the sync calls only allowlisted read operations and the keepalive; the gateway sees no order traffic', async () => {
    const { service, fixture } = await build();
    await service.sync();
    expect(fixture.operationsCalled().every((operation) => operation in IBKR_ALLOWED_OPERATIONS)).toBe(true);
    expect(fixture.calls.filter((c) => c.operation === 'session.tickle')).toHaveLength(1);
    expect(fixture.operationsCalled()).toEqual(expect.arrayContaining(['orders.open']));
  });

  it('[9] neither the full account id nor the session token appears in logs, stored records or returned views', async () => {
    const logs: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
    }
    const { service, snapshots, syncs, reconciliations } = await build();
    const result = await service.sync();
    const stored = JSON.stringify([snapshots.all(), syncs.all(), reconciliations.all(), result, await service.status(), await service.latestSnapshot()]);
    for (const text of [...logs, stored]) {
      expect(text).not.toContain(FIXTURE_ACCOUNT);
      expect(text).not.toContain(FIXTURE_SESSION_TOKEN);
    }
    expect(stored).toContain('U****567');
  });

  it('a failed sync is recorded as an audit event and surfaces its code; the broker error carries no secret', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.fail('session.tickle', new IbkrError('BROKER_AUTH_REQUIRED'));
    const { service, syncs } = await build({ fixture });
    await expect(service.sync()).rejects.toMatchObject({ code: 'BROKER_AUTH_REQUIRED' });
    expect(syncs.all()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ outcome: 'failed', errorCode: 'BROKER_AUTH_REQUIRED' }) })]);
    expect(await service.status()).toMatchObject({ ibkr: { connection: 'error', lastErrorCode: 'BROKER_AUTH_REQUIRED' } });
  });
});

describe('O19 IBKR service: the explicit conid mapping', () => {
  it('links a conid to the NEXUS instrument only when symbol, currency and exchange agree', async () => {
    const { service, registry } = await build({ mapAapl: false });
    await service.sync();
    const result = await service.mapInstrument({ conid: FIXTURE_CONID_AAPL, instrumentId: AAPL.instrumentId, validFrom: '1980-12-12T00:00:00.000Z' });
    expect(result).toMatchObject({ status: 'MAPPED', instrumentId: 'ins_aapl' });
    expect(registry.resolve('ibkr', FIXTURE_CONID_AAPL, T0)).toBe('ins_aapl');
    expect(await service.mapInstrument({ conid: FIXTURE_CONID_AAPL, instrumentId: AAPL.instrumentId, validFrom: '1980-12-12T00:00:00.000Z' })).toMatchObject({ status: 'ALREADY_MAPPED' });
  });

  it('refuses a contract with no broker evidence in the latest snapshot', async () => {
    const { service } = await build({ mapAapl: false });
    await service.sync();
    await expect(service.mapInstrument({ conid: '999999', instrumentId: AAPL.instrumentId, validFrom: '1980-12-12T00:00:00.000Z' })).rejects.toMatchObject({ code: 'BROKER_INSTRUMENT_UNMAPPED' });
  });

  it('refuses a symbol, currency or exchange that disagrees with the instrument: no link is guessed', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.data.positionPages = [[fixturePosition({ contractDesc: 'MSFT' })]];
    const { service } = await build({ fixture, mapAapl: false });
    await service.sync();
    await expect(service.mapInstrument({ conid: FIXTURE_CONID_AAPL, instrumentId: AAPL.instrumentId, validFrom: '1980-12-12T00:00:00.000Z' })).rejects.toMatchObject({ code: 'BROKER_INSTRUMENT_UNMAPPED' });
  });

  it('refuses a mapping that would start in the future', async () => {
    const { service } = await build({ mapAapl: false });
    await service.sync();
    await expect(service.mapInstrument({ conid: FIXTURE_CONID_AAPL, instrumentId: AAPL.instrumentId, validFrom: '2030-01-01T00:00:00.000Z' })).rejects.toMatchObject({ code: 'BROKER_INSTRUMENT_UNMAPPED' });
  });

  it('refuses a conid that is already linked to another instrument', async () => {
    const { service, registry } = await build();
    await service.sync();
    await registry.register({ ...AAPL, instrumentId: 'ins_other', symbol: 'AAPL' }, change);
    await expect(service.mapInstrument({ conid: FIXTURE_CONID_AAPL, instrumentId: 'ins_other', validFrom: '1980-12-12T00:00:00.000Z' })).rejects.toMatchObject({ code: 'BROKER_INSTRUMENT_UNMAPPED' });
  });
});
