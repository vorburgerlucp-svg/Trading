// The IBKR read-only adapter over the fixture gateway: account selection, session and auth errors, pagination and its cap,
// pacing, single-flight, unknown open orders, and identity by conid (never by ticker).
import { describe, expect, it } from 'vitest';
import { IbkrError } from '../../../src/broker/ibkr/ibkr-errors.js';
import { IbkrBrokerSyncAdapter, selectAccount } from '../../../src/broker/ibkr/ibkr-sync-adapter.js';
import { FixtureIbkrReadOnlyAdapter, FIXTURE_ACCOUNT, FIXTURE_CONID_AAPL, FIXTURE_CONID_SPY, FIXTURE_OTHER_ACCOUNT, FIXTURE_SESSION_TOKEN, defaultFixtureData, fixtureOrder, fixturePosition, fixtureTickle } from './o19-fixture.js';

const T0 = '2026-10-15T09:00:00.000Z';

function clockAt(iso: string) {
  let current = Date.parse(iso);
  return { now: () => new Date(current), set: (next: string) => (current = Date.parse(next)), advance: (ms: number) => (current += ms) };
}

function adapterWith(fixture: FixtureIbkrReadOnlyAdapter, options: { accountId?: string | null; clock?: ReturnType<typeof clockAt>; resolve?: (conid: string) => string | null } = {}) {
  const clock = options.clock ?? clockAt(T0);
  const resolve = options.resolve ?? ((conid: string) => (conid === FIXTURE_CONID_AAPL ? 'ins_aapl' : null));
  const adapter = new IbkrBrokerSyncAdapter({
    transport: fixture,
    accountId: options.accountId ?? null,
    clock: clock.now,
    resolveInstrument: (conid) => resolve(conid),
  });
  return { adapter, clock };
}

async function errorOf(promise: Promise<unknown>): Promise<IbkrError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IbkrError) return error;
    throw error;
  }
  throw new Error('expected an IbkrError');
}

describe('O19 IBKR adapter: account selection fails closed', () => {
  it('[2] a configured account that the session cannot read is BROKER_ACCOUNT_NOT_FOUND', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    const { adapter } = adapterWith(fixture, { accountId: 'U9999999' });
    expect((await errorOf(adapter.fetchSnapshot())).code).toBe('BROKER_ACCOUNT_NOT_FOUND');
  });

  it('[3] several readable accounts and none configured is BROKER_ACCOUNT_AMBIGUOUS, not a guess', async () => {
    const data = defaultFixtureData();
    data.accounts = [{ id: FIXTURE_ACCOUNT }, { id: FIXTURE_OTHER_ACCOUNT }];
    const { adapter } = adapterWith(new FixtureIbkrReadOnlyAdapter(data));
    expect((await errorOf(adapter.fetchSnapshot())).code).toBe('BROKER_ACCOUNT_AMBIGUOUS');
  });

  it('with several accounts, the configured one is chosen by exact match and only that account is read', async () => {
    const data = defaultFixtureData();
    data.accounts = [{ id: FIXTURE_ACCOUNT }, { id: FIXTURE_OTHER_ACCOUNT }];
    // The other account's own metadata, holdings and orders: a foreign account's data is never mixed in.
    data.meta = { id: FIXTURE_OTHER_ACCOUNT, accountId: FIXTURE_OTHER_ACCOUNT, currency: 'USD', clearingStatus: 'O' };
    data.positionPages = [[fixturePosition({ acctId: FIXTURE_OTHER_ACCOUNT, conid: 4242, contractDesc: 'OTHER' })]];
    data.orders = { orders: [] };
    const fixture = new FixtureIbkrReadOnlyAdapter(data);
    const { adapter } = adapterWith(fixture, { accountId: FIXTURE_OTHER_ACCOUNT, resolve: () => null });
    const snapshot = await adapter.fetchSnapshot();
    expect(snapshot.accountId).toBe(FIXTURE_OTHER_ACCOUNT);
    expect(fixture.calls.filter((c) => c.operation === 'account.meta').map((c) => c.params?.accountId)).toEqual([FIXTURE_OTHER_ACCOUNT]);
  });

  it('no readable account at all is BROKER_ACCOUNT_NOT_FOUND', () => {
    expect(() => selectAccount([], null)).toThrow(IbkrError);
    expect(() => selectAccount([], 'U1234567')).toThrow(IbkrError);
  });
});

describe('O19 IBKR adapter: session and authentication', () => {
  it('[7] a missing session is BROKER_AUTH_REQUIRED, the adapter reports not connected, and no token leaks', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.data.tickle = fixtureTickle({ session: undefined, ssoExpires: 0 });
    const { adapter } = adapterWith(fixture);
    const error = await errorOf(adapter.fetchSnapshot());
    expect(error.code).toBe('BROKER_AUTH_REQUIRED');
    expect(adapter.connection()).toBe('not_connected');
    expect(JSON.stringify(error) + error.message).not.toContain(FIXTURE_SESSION_TOKEN);
  });

  it('scopes the open-order read to the selected account', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    const { adapter } = adapterWith(fixture);
    await adapter.fetchSnapshot();
    expect(fixture.calls.filter((c) => c.operation === 'orders.open').map((c) => c.params?.accountId)).toEqual([FIXTURE_ACCOUNT]);
  });

  it('an unauthenticated brokerage session still reads the portfolio, but the open orders are unknown (null), never empty', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.data.tickle = fixtureTickle({ iserver: { authStatus: { authenticated: false, competing: false } } });
    const { adapter } = adapterWith(fixture);
    const snapshot = await adapter.fetchSnapshot();
    expect(snapshot.openOrders).toBeNull();
    expect(fixture.operationsCalled()).not.toContain('orders.open');
    expect(snapshot.positions).toHaveLength(1);
  });

  it('a gateway outage is BROKER_NOT_CONNECTED, and the adapter does not pretend to be connected afterwards', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.fail('session.tickle', { status: 503, body: null });
    const { adapter } = adapterWith(fixture);
    expect((await errorOf(adapter.fetchSnapshot())).code).toBe('BROKER_NOT_CONNECTED');
    expect(adapter.connection()).toBe('not_connected');
  });
});

describe('O19 IBKR adapter: pagination, pacing and single flight', () => {
  it('reads further position pages only while a page is full', async () => {
    const data = defaultFixtureData();
    const full = Array.from({ length: 100 }, (_, i) => fixturePosition({ conid: 1000 + i, contractDesc: 'S' + i }));
    data.positionPages = [full, [fixturePosition({ conid: 9999, contractDesc: 'LAST' })]];
    const fixture = new FixtureIbkrReadOnlyAdapter(data);
    const snapshot = await adapterWith(fixture, { resolve: () => null }).adapter.fetchSnapshot();
    expect(snapshot.positions).toHaveLength(101);
    expect(fixture.calls.filter((c) => c.operation === 'positions.page').map((c) => c.params?.pageId)).toEqual([0, 1]);
  });

  it('the position pages are capped: a broker that keeps answering with full pages is refused', async () => {
    const data = defaultFixtureData();
    const full = Array.from({ length: 100 }, (_, i) => fixturePosition({ conid: 1000 + i, contractDesc: 'S' + i }));
    data.positionPages = [full, full, full, full, full, full];
    const error = await errorOf(adapterWith(new FixtureIbkrReadOnlyAdapter(data)).adapter.fetchSnapshot());
    expect(error.code).toBe('BROKER_RESPONSE_INVALID');
    expect(error.message).toContain('too many position pages');
  });

  it('the account list is paced at one request per five seconds: a second sync inside that window is refused, not sent', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    const { adapter, clock } = adapterWith(fixture);
    await adapter.fetchSnapshot();
    clock.advance(1_000);
    expect((await errorOf(adapter.fetchSnapshot())).code).toBe('BROKER_RATE_LIMITED');
    expect(fixture.calls.filter((c) => c.operation === 'accounts.list')).toHaveLength(1);
    clock.advance(5_000);
    await expect(adapter.fetchSnapshot()).resolves.toBeDefined();
  });

  it('a rate-limited broker answer is not retried by the adapter', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.fail('account.meta', { status: 429, body: null });
    const { adapter } = adapterWith(fixture);
    expect((await errorOf(adapter.fetchSnapshot())).code).toBe('BROKER_RATE_LIMITED');
    expect(fixture.calls.filter((c) => c.operation === 'account.meta')).toHaveLength(1);
  });

  it('concurrent calls share one sync: the gateway is asked once, and both callers get the same snapshot', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    const { adapter } = adapterWith(fixture);
    const [first, second] = await Promise.all([adapter.fetchSnapshot(), adapter.fetchSnapshot()]);
    expect(first).toBe(second);
    expect(fixture.calls.filter((c) => c.operation === 'accounts.list')).toHaveLength(1);
  });
});

describe('O19 IBKR adapter: identity by conid, never by ticker', () => {
  it('[10] an unmapped IBKR contract is kept visibly unmapped; no NEXUS instrument is invented for it', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.data.positionPages = [[fixturePosition({ conid: Number(FIXTURE_CONID_SPY), contractDesc: 'SPY', listingExchange: 'ARCA' })]];
    const snapshot = await adapterWith(fixture, { resolve: () => null }).adapter.fetchSnapshot();
    expect(snapshot.positions[0]).toMatchObject({ instrumentId: null, brokerInstrumentId: FIXTURE_CONID_SPY, brokerSymbol: 'SPY' });
  });

  it('[11] the same ticker on another exchange is a different contract: it is not linked to the instrument of the first', async () => {
    const data = defaultFixtureData();
    data.positionPages = [[
      fixturePosition({ conid: Number(FIXTURE_CONID_AAPL), contractDesc: 'AAPL', listingExchange: 'NASDAQ' }),
      fixturePosition({ conid: 88888888, contractDesc: 'AAPL', listingExchange: 'IBIS' }),
    ]];
    const snapshot = await adapterWith(new FixtureIbkrReadOnlyAdapter(data)).adapter.fetchSnapshot();
    expect(snapshot.positions.map((p) => p.instrumentId)).toEqual(['ins_aapl', null]);
    expect(snapshot.positions.map((p) => p.brokerSymbol)).toEqual(['AAPL', 'AAPL']);
  });

  it('open orders carry the same identity rule, and their limit price is null because the payload has no reliable currency', async () => {
    const data = defaultFixtureData();
    data.orders = { orders: [fixtureOrder({ conid: FIXTURE_CONID_AAPL, orderId: 77 })] };
    const snapshot = await adapterWith(new FixtureIbkrReadOnlyAdapter(data)).adapter.fetchSnapshot();
    expect(snapshot.openOrders).toEqual([expect.objectContaining({ externalOrderId: '77', instrumentId: 'ins_aapl', side: 'buy', limitPrice: null })]);
  });
});

describe('O19 IBKR adapter: the snapshot carries the broker facts, and nothing else', () => {
  it('a full read returns the account status, cash, positions with their provenance, and the observation times', async () => {
    const { adapter } = adapterWith(new FixtureIbkrReadOnlyAdapter());
    const snapshot = await adapter.fetchSnapshot();
    expect(snapshot).toMatchObject({ broker: 'ibkr', access: 'read_only', accountStatus: 'O', observedAt: T0, retrievedAt: T0 });
    expect(snapshot.cash.map((c) => c.currency)).toEqual(['USD']);
    expect(snapshot.positions[0]).toMatchObject({ instrumentId: 'ins_aapl', brokerInstrumentId: FIXTURE_CONID_AAPL, listingExchange: 'NASDAQ', brokerSymbol: 'AAPL' });
    expect(snapshot.positions[0]?.averageCost?.value.toString()).toBe('150.5');
  });

  it('the adapter only ever calls allowlisted operations, and only the keepalive is a POST', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    await adapterWith(fixture).adapter.fetchSnapshot();
    expect(fixture.operationsCalled().sort()).toEqual(['account.ledger', 'account.meta', 'accounts.list', 'orders.open', 'positions.page', 'session.tickle']);
  });
});
