// O21A: a non-empty demo portfolio (DOCUMENTED fixture, not live-observed) through the read-only service. Identity is the eToro
// instrumentId, mapped only through the human-governed etoro mapping of the instrument registry; unmapped stays unmapped and is
// never registered. Snapshot and reconciliation are deterministic, cash stays not_read, the ledger is never written, and no key
// reaches anything stored or returned.
import { describe, expect, it } from 'vitest';
import { accounts } from '../../../src/capital/accounts.js';
import { CapitalLedger } from '../../../src/capital/capital-ledger.js';
import type { AccountBalance, AccountKey } from '../../../src/capital/capital-types.js';
import { ETORO_INSTRUMENT_PROVIDER, EtoroBrokerService, type EtoroInstrumentResolver, type EtoroLedgerView, type EtoroReconciliationRecord, type EtoroSnapshotRecord, type EtoroSyncRecord } from '../../../src/broker/etoro/etoro-broker-service.js';
import { ETORO_MAPPING_PROVIDER } from '../../../src/broker/etoro/execution/execution-gate.js';
import { EtoroBrokerSyncAdapter } from '../../../src/broker/etoro/etoro-sync-adapter.js';
import { HttpsEtoroTransport, type EtoroFetch } from '../../../src/broker/etoro/etoro-transport.js';
import { InstrumentRegistry } from '../../../src/market-data/instrument-registry.js';
import { AppendOnlyLog } from '../../../src/persistence/append-only-log.js';
import { Decimal } from '../../../src/money/decimal.js';
import { rappen } from '../../../src/money/money.js';
import { AAPL } from '../../market-data/fixtures.js';
import { FixtureEtoroTransport, KEY_MARKER, USER_MARKER, emptyDemoPortfolio, fixedClock } from './o20-fixture.js';
import { documentedOrder, documentedPortfolio, documentedPosition } from './o21a-documented-fixture.js';

const T0 = '2026-10-17T09:00:00.000Z';
const HUMAN = { kind: 'human' as const, id: 'mapping-owner' };
const ETORO_ID = 1002;

async function registryWithMapping(options: { exchange?: string; validFrom?: string; validTo?: string } = {}): Promise<InstrumentRegistry> {
  const registry = await InstrumentRegistry.open();
  const change = { at: '2026-10-01T00:00:00.000Z', by: HUMAN, reason: 'O21A test: governed eToro mapping' };
  await registry.register({ ...AAPL }, change);
  await registry.addMapping(
    {
      instrumentId: AAPL.instrumentId,
      provider: 'etoro',
      providerSymbol: String(ETORO_ID),
      validFrom: options.validFrom ?? '2026-10-01T00:00:00.000Z',
      ...(options.validTo ? { validTo: options.validTo } : {}),
      ...(options.exchange ? { exchange: options.exchange } : {}),
    },
    change,
  );
  return registry;
}

async function harness(options: { body?: unknown; instruments?: EtoroInstrumentResolver | null; ledger?: EtoroLedgerView } = {}) {
  const clock = fixedClock(T0);
  const transport = new FixtureEtoroTransport();
  transport.response = { status: 200, body: options.body ?? documentedPortfolio() };
  const ledger = await CapitalLedger.inMemory();
  const snapshots = await AppendOnlyLog.inMemory<EtoroSnapshotRecord>('etoro-snapshots', { clock: clock.now });
  const reconciliations = await AppendOnlyLog.inMemory<EtoroReconciliationRecord>('etoro-reconciliations', { clock: clock.now });
  const syncs = await AppendOnlyLog.inMemory<EtoroSyncRecord>('etoro-sync-events', { clock: clock.now });
  const service = new EtoroBrokerService({
    adapter: new EtoroBrokerSyncAdapter({ transport, clock: clock.now }),
    ledger: options.ledger ?? { balances: () => ledger.balances() },
    snapshots,
    reconciliations,
    syncs,
    clock: clock.now,
    instruments: options.instruments === undefined ? await registryWithMapping() : options.instruments,
  });
  return { service, transport, ledger, snapshots, reconciliations, syncs, clock };
}

function ledgerWith(instrumentId: string, quantity: string): EtoroLedgerView {
  const balances = new Map<AccountKey, AccountBalance>([[accounts.position('etoro', instrumentId), { amount: rappen(0n), quantity: Decimal.from(quantity) }]]);
  return { balances: () => balances };
}

describe('O21A service: the mapping provider is the one O21 uses', () => {
  it('etoro, with the eToro instrument id as provider symbol', () => {
    expect(ETORO_INSTRUMENT_PROVIDER).toBe(ETORO_MAPPING_PROVIDER);
  });
});

describe('O21A service: the snapshot of a non-empty portfolio', () => {
  it('stores mapped positions and pending orders with the fields NEXUS needs, coverage documented_schema, cash not_read', async () => {
    const h = await harness();
    const result = await h.service.sync();
    const content = result.snapshot.content;
    expect(content).toMatchObject({ broker: 'etoro', accountId: null, access: 'read_only', positionCount: 1, openOrderCount: 1 });
    expect(content.coverage).toEqual({ cash: 'not_read', positions: 'documented_schema', openOrders: 'documented_schema', accountIdentity: 'not_observed' });
    expect(content.positions).toEqual([expect.objectContaining({ positionId: 2150896073, etoroInstrumentId: ETORO_ID, instrumentId: AAPL.instrumentId, direction: 'buy', units: '0.049485' })]);
    // The documented order's instrument (100043) has no mapping: kept with instrumentId null, never registered.
    expect(content.orders).toEqual([expect.objectContaining({ orderId: 5669649, etoroInstrumentId: 100043, instrumentId: null })]);
  });

  it('cash is never derived from credit or bonusCredit', async () => {
    const h = await harness();
    const result = await h.service.sync();
    const text = JSON.stringify({ result, stored: h.snapshots.all() });
    expect(text).not.toMatch(/280\.35|"credit"|bonusCredit|"cash":\[/);
    expect(result.reconciliation.issues.some((i) => i.kind === 'cash_mismatch')).toBe(false);
  });

  it('no raw broker field is persisted: no CID, no fees, no unknown fields', async () => {
    const h = await harness({ body: documentedPortfolio({ positions: [documentedPosition({ privateNote: 'RAW-ONLY-VALUE' })] }) });
    await h.service.sync();
    const stored = JSON.stringify(h.snapshots.all());
    expect(stored).not.toMatch(/7765437|CID|totalFees|RAW-ONLY-VALUE|privateNote|isDiscounted/);
  });

  it('the snapshot id is deterministic: the same content in another element order keeps one snapshot', async () => {
    const positions = [documentedPosition({ positionID: 1 }), documentedPosition({ positionID: 2 })];
    const orders = [documentedOrder({ orderID: 1 }), documentedOrder({ orderID: 2 })];
    const a = await harness({ body: documentedPortfolio({ positions, orders }) });
    const b = await harness({ body: documentedPortfolio({ positions: [...positions].reverse(), orders: [...orders].reverse() }) });
    const ra = await a.service.sync();
    const rb = await b.service.sync();
    expect(rb.snapshot.snapshotId).toBe(ra.snapshot.snapshotId);
    expect(rb.reconciliation).toEqual(ra.reconciliation);
    a.clock.advance(60_000);
    expect((await a.service.sync()).snapshot.snapshotId).toBe(ra.snapshot.snapshotId);
    expect(a.snapshots.size).toBe(1);
  });

  it('the empty portfolio keeps exactly the O20 content: no positions or orders field', async () => {
    const h = await harness({ body: emptyDemoPortfolio() });
    const content = (await h.service.sync()).snapshot.content;
    expect(Object.keys(content).sort()).toEqual(['access', 'accountId', 'broker', 'coverage', 'openOrderCount', 'positionCount']);
    expect(content.coverage).toEqual({ cash: 'not_read', positions: 'verified_empty', openOrders: 'verified_empty', accountIdentity: 'not_observed' });
  });
});

describe('O21A service: identity is the eToro instrumentId through the governed mapping only', () => {
  it('mapping present: the position reconciles against the ledger position of the mapped NEXUS instrument', async () => {
    const h = await harness({ body: documentedPortfolio({ orders: [] }), ledger: ledgerWith(AAPL.instrumentId, '0.049485') });
    const result = await h.service.sync();
    expect(result.reconciliation).toMatchObject({ matched: true, issues: [] });
  });

  it('mapping present, quantity differs: quantity_mismatch', async () => {
    const h = await harness({ body: documentedPortfolio({ orders: [] }), ledger: ledgerWith(AAPL.instrumentId, '1') });
    const result = await h.service.sync();
    expect(result.reconciliation.issues).toEqual([{ kind: 'quantity_mismatch', instrumentId: AAPL.instrumentId, broker: '0.049485', ledger: '1' }]);
  });

  it('mapping missing: unmapped_broker_instrument, not matched, and nothing is registered', async () => {
    const registry = await InstrumentRegistry.open();
    const h = await harness({ body: documentedPortfolio({ orders: [] }), instruments: registry });
    const result = await h.service.sync();
    expect(result.reconciliation.matched).toBe(false);
    expect(result.reconciliation.issues).toEqual([{ kind: 'unmapped_broker_instrument', brokerInstrumentId: String(ETORO_ID), broker: '0.049485' }]);
    expect(result.snapshot.content.positions?.[0]?.instrumentId).toBeNull();
    expect(registry.list()).toEqual([]);
    expect(registry.mappings()).toEqual([]);
  });

  it('no registry at all: every instrument is unmapped', async () => {
    const h = await harness({ body: documentedPortfolio({ orders: [] }), instruments: null });
    expect((await h.service.sync()).reconciliation.issues.map((i) => i.kind)).toEqual(['unmapped_broker_instrument']);
  });

  it('an unknown instrumentId stays unmapped even when a ledger position exists for some instrument', async () => {
    const h = await harness({ body: documentedPortfolio({ positions: [documentedPosition({ instrumentID: 424242 })], orders: [] }), ledger: ledgerWith(AAPL.instrumentId, '0.049485') });
    const issues = (await h.service.sync()).reconciliation.issues;
    expect(issues).toEqual([
      { kind: 'unmapped_broker_instrument', brokerInstrumentId: '424242', broker: '0.049485' },
      { kind: 'missing_at_broker', instrumentId: AAPL.instrumentId, ledger: '0.049485' },
    ]);
  });

  it('no ticker-only identity: a mapping under the ticker symbol does not match an eToro instrument id', async () => {
    const registry = await InstrumentRegistry.open();
    const change = { at: '2026-10-01T00:00:00.000Z', by: HUMAN, reason: 'ticker mapping only' };
    await registry.register({ ...AAPL }, change);
    await registry.addMapping({ instrumentId: AAPL.instrumentId, provider: 'etoro', providerSymbol: 'AAPL', validFrom: '2026-10-01T00:00:00.000Z' }, change);
    const h = await harness({ body: documentedPortfolio({ positions: [documentedPosition({ symbol: 'AAPL', ticker: 'AAPL' })], orders: [] }), instruments: registry });
    const result = await h.service.sync();
    expect(result.snapshot.content.positions?.[0]?.instrumentId).toBeNull();
    expect(result.reconciliation.issues[0]?.kind).toBe('unmapped_broker_instrument');
  });

  it('a mapping of another provider does not match', async () => {
    const registry = await InstrumentRegistry.open();
    const change = { at: '2026-10-01T00:00:00.000Z', by: HUMAN, reason: 'other provider' };
    await registry.register({ ...AAPL }, change);
    await registry.addMapping({ instrumentId: AAPL.instrumentId, provider: 'twelve_data', providerSymbol: String(ETORO_ID), validFrom: '2026-10-01T00:00:00.000Z' }, change);
    const h = await harness({ body: documentedPortfolio({ orders: [] }), instruments: registry });
    expect((await h.service.sync()).snapshot.content.positions?.[0]?.instrumentId).toBeNull();
  });

  it('a mapping valid only before the observation time does not match', async () => {
    const h = await harness({ body: documentedPortfolio({ orders: [] }), instruments: await registryWithMapping({ validTo: '2026-10-10T00:00:00.000Z' }) });
    expect((await h.service.sync()).snapshot.content.positions?.[0]?.instrumentId).toBeNull();
  });

  it('a mapping that carries an exchange does not match: the portfolio states no exchange, so it fails closed as unmapped', async () => {
    const h = await harness({ body: documentedPortfolio({ orders: [] }), instruments: await registryWithMapping({ exchange: 'NASDAQ' }) });
    expect((await h.service.sync()).snapshot.content.positions?.[0]?.instrumentId).toBeNull();
  });

  it('buy and sell positions of one mapped instrument are netted; a pending order does not change the position', async () => {
    const body = documentedPortfolio({
      positions: [documentedPosition({ positionID: 1, units: 3 }), documentedPosition({ positionID: 2, units: 1, isBuy: false })],
      orders: [documentedOrder({ instrumentID: ETORO_ID, units: 50 })],
    });
    const h = await harness({ body, ledger: ledgerWith(AAPL.instrumentId, '2') });
    expect((await h.service.sync()).reconciliation).toMatchObject({ matched: true, issues: [] });
  });
});

describe('O21A service: malformed non-empty payloads store nothing', () => {
  it('a malformed position is BROKER_RESPONSE_INVALID: failed sync recorded, no snapshot, no reconciliation', async () => {
    const h = await harness({ body: documentedPortfolio({ positions: [documentedPosition({ positionID: 'x' })] }) });
    await expect(h.service.sync()).rejects.toMatchObject({ code: 'BROKER_RESPONSE_INVALID' });
    expect(h.snapshots.size).toBe(0);
    expect(h.reconciliations.size).toBe(0);
    expect(h.syncs.all()[0]?.payload).toMatchObject({ outcome: 'failed', errorCode: 'BROKER_RESPONSE_INVALID' });
  });
});

describe('O21A service: read only', () => {
  it('the ledger holds the same entries after syncs of a non-empty portfolio', async () => {
    const h = await harness();
    const before = h.ledger.size;
    await h.service.sync();
    await h.service.sync();
    expect(h.ledger.size).toBe(before);
    expect(h.transport.calls).toEqual(['portfolio.demo', 'portfolio.demo']);
  });

  it('no key appears in anything stored or returned, through the real transport', async () => {
    const clock = fixedClock(T0);
    const requests: Array<{ url: string; method: string }> = [];
    const fetch: EtoroFetch = async (url, init) => {
      requests.push({ url, method: String(init.method) });
      return new Response(JSON.stringify(documentedPortfolio()), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const snapshots = await AppendOnlyLog.inMemory<EtoroSnapshotRecord>('etoro-snapshots', { clock: clock.now });
    const reconciliations = await AppendOnlyLog.inMemory<EtoroReconciliationRecord>('etoro-reconciliations', { clock: clock.now });
    const syncs = await AppendOnlyLog.inMemory<EtoroSyncRecord>('etoro-sync-events', { clock: clock.now });
    const service = new EtoroBrokerService({
      adapter: new EtoroBrokerSyncAdapter({ transport: new HttpsEtoroTransport({ credentials: { apiKey: KEY_MARKER, userKey: USER_MARKER }, fetch }), clock: clock.now }),
      ledger: { balances: () => new Map() },
      snapshots,
      reconciliations,
      syncs,
      clock: clock.now,
      instruments: await registryWithMapping(),
    });
    const result = await service.sync();
    const everything = JSON.stringify({ result, status: service.status(), s: snapshots.all(), r: reconciliations.all(), y: syncs.all() });
    expect(everything).not.toContain(KEY_MARKER);
    expect(everything).not.toContain(USER_MARKER);
    expect(everything).not.toMatch(/x-api-key|x-user-key|x-request-id|authorization/i);
    expect(requests).toEqual([{ url: 'https://public-api.etoro.com/api/v1/trading/info/demo/portfolio', method: 'GET' }]);
  });
});
