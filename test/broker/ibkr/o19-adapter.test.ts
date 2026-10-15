// The IBKR read-only adapter over the fixture gateway: account selection, session and auth errors, the brokerage readiness rule
// and its initialization gate, pagination and its cap, pacing, single-flight, unknown open orders, and identity by conid.
import { describe, expect, it } from 'vitest';
import { IbkrError } from '../../../src/broker/ibkr/ibkr-errors.js';
import { IbkrBrokerSyncAdapter, selectAccount } from '../../../src/broker/ibkr/ibkr-sync-adapter.js';
import { FixtureIbkrReadOnlyAdapter, FIXTURE_ACCOUNT, FIXTURE_CONID_AAPL, FIXTURE_CONID_SPY, FIXTURE_OTHER_ACCOUNT, FIXTURE_SESSION_TOKEN, defaultFixtureData, fixtureOrder, fixturePosition, fixtureTickle, statusOf } from './o19-fixture.js';

const T0 = '2026-10-15T09:00:00.000Z';

function clockAt(iso: string) {
  let current = Date.parse(iso);
  return { now: () => new Date(current), set: (next: string) => (current = Date.parse(next)), advance: (ms: number) => (current += ms) };
}

function adapterWith(
  fixture: FixtureIbkrReadOnlyAdapter,
  options: { accountId?: string | null; clock?: ReturnType<typeof clockAt>; resolve?: (conid: string) => string | null; delays?: number[]; allowInit?: boolean } = {},
) {
  const clock = options.clock ?? clockAt(T0);
  const resolve = options.resolve ?? ((conid: string) => (conid === FIXTURE_CONID_AAPL ? 'ins_aapl' : null));
  const delays = options.delays ?? [];
  const adapter = new IbkrBrokerSyncAdapter({
    transport: fixture,
    accountId: options.accountId ?? null,
    clock: clock.now,
    resolveInstrument: (conid) => resolve(conid),
    allowBrokerageInit: options.allowInit ?? false,
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  return { adapter, clock, delays };
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

const initCalls = (fixture: FixtureIbkrReadOnlyAdapter) => fixture.calls.filter((c) => c.operation === 'brokerage.init');

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

describe('O19 IBKR adapter: the outer session (tickle) is a keepalive, not a readiness source', () => {
  it('[7] an expired gateway session is BROKER_AUTH_REQUIRED, the adapter reports not connected, and no token leaks', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.data.tickle = fixtureTickle({ ssoExpires: 0 });
    const { adapter } = adapterWith(fixture);
    const error = await errorOf(adapter.fetchSnapshot());
    expect(error.code).toBe('BROKER_AUTH_REQUIRED');
    expect(adapter.connection()).toBe('not_connected');
    expect(JSON.stringify(error) + error.message).not.toContain(FIXTURE_SESSION_TOKEN);
  });

  it('a tickle without a session identifier is BROKER_RESPONSE_INVALID, and no brokerage call follows it', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.data.tickle = fixtureTickle({ session: undefined });
    const error = await errorOf(adapterWith(fixture, { allowInit: true }).adapter.fetchSnapshot());
    expect(error.code).toBe('BROKER_RESPONSE_INVALID');
    expect(fixture.operationsCalled()).not.toContain('brokerage.status');
    expect(initCalls(fixture)).toHaveLength(0);
  });

  it('a tickle without a numeric expiry is BROKER_RESPONSE_INVALID, never a quiet "no session"', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.data.tickle = fixtureTickle({ ssoExpires: '460311' });
    expect((await errorOf(adapterWith(fixture).adapter.fetchSnapshot())).code).toBe('BROKER_RESPONSE_INVALID');
  });

  it('a tickle that says nothing about the brokerage is still enough for the keepalive; the status decides readiness', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.data.tickle = fixtureTickle({ iserver: undefined });
    fixture.brokerageBefore = statusOf();
    const snapshot = await adapterWith(fixture).adapter.fetchSnapshot();
    expect(snapshot.positions).toHaveLength(1);
    expect(initCalls(fixture)).toHaveLength(0);
  });

  it('scopes the open-order read to the selected account', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    const { adapter } = adapterWith(fixture);
    await adapter.fetchSnapshot();
    expect(fixture.calls.filter((c) => c.operation === 'orders.open').map((c) => c.params?.accountId)).toEqual([FIXTURE_ACCOUNT]);
  });

  it('a gateway outage is BROKER_NOT_CONNECTED, and the adapter does not pretend to be connected afterwards', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.fail('session.tickle', { status: 503, body: null });
    const { adapter } = adapterWith(fixture);
    expect((await errorOf(adapter.fetchSnapshot())).code).toBe('BROKER_NOT_CONNECTED');
    expect(adapter.connection()).toBe('not_connected');
  });
});

describe('O19 IBKR adapter: the initialization gate (default: never)', () => {
  const notReady = () => statusOf({ authenticated: false, connected: false });

  it('a ready brokerage is read without any initialization, even when the gate is open', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    const snapshot = await adapterWith(fixture, { allowInit: true }).adapter.fetchSnapshot();
    expect(snapshot.positions).toHaveLength(1);
    expect(initCalls(fixture)).toHaveLength(0);
  });

  it('a brokerage that is not ready and the gate closed: nothing is sent to start it, and the sync stops', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.brokerageBefore = notReady();
    const error = await errorOf(adapterWith(fixture, { allowInit: false }).adapter.fetchSnapshot());
    expect(error.code).toBe('BROKER_BROKERAGE_INIT_REQUIRED');
    expect(initCalls(fixture)).toHaveLength(0);
    expect(fixture.operationsCalled()).not.toContain('positions.page');
    expect(fixture.operationsCalled()).not.toContain('accounts.list');
  });

  it('a tickle that is not the readiness source: a tickle-only "ready" is not enough when the status says not ready', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.data.tickle = fixtureTickle({ iserver: { authStatus: { authenticated: true, connected: true, competing: false } } });
    fixture.brokerageBefore = notReady();
    expect((await errorOf(adapterWith(fixture).adapter.fetchSnapshot())).code).toBe('BROKER_BROKERAGE_INIT_REQUIRED');
    expect(initCalls(fixture)).toHaveLength(0);
  });

  it('the gate open and a brokerage that is not ready: exactly one initialization, the settle wait, the status again, then the accounts', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.brokerageBefore = notReady();
    const delays: number[] = [];
    const snapshot = await adapterWith(fixture, { allowInit: true, delays }).adapter.fetchSnapshot();
    const order = fixture.operationsCalled();
    expect(initCalls(fixture)).toHaveLength(1);
    expect(order.indexOf('brokerage.init')).toBeLessThan(order.indexOf('accounts.list'));
    expect(fixture.calls.filter((c) => c.operation === 'brokerage.status')).toHaveLength(2);
    expect(order.indexOf('brokerage.accounts')).toBeGreaterThan(order.indexOf('brokerage.init'));
    expect(delays).toEqual([2_000]);
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.openOrders).toHaveLength(1);
  });

  it('the initialization carries no caller parameters: its body is fixed inside the transport (compete=false)', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.brokerageBefore = notReady();
    await adapterWith(fixture, { allowInit: true }).adapter.fetchSnapshot();
    expect(initCalls(fixture)).toHaveLength(1);
    expect(initCalls(fixture)[0]?.params).toBeUndefined();
  });

  it('a refused initialization stops the sync: no portfolio is read and the start is not repeated', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.brokerageBefore = notReady();
    fixture.initOutcome = 'refused';
    const { adapter } = adapterWith(fixture, { allowInit: true });
    const error = await errorOf(adapter.fetchSnapshot());
    expect(error.code).toBe('BROKER_BROKERAGE_INIT_FAILED');
    expect(initCalls(fixture)).toHaveLength(1);
    expect(fixture.operationsCalled()).not.toContain('positions.page');
    expect(adapter.connection()).toBe('not_connected');
  });

  it('a gateway server error on the initialization is reported as a gateway error, never as a started session', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.brokerageBefore = notReady();
    fixture.initOutcome = 'server-error';
    const error = await errorOf(adapterWith(fixture, { allowInit: true }).adapter.fetchSnapshot());
    expect(error.code).toBe('BROKER_NOT_CONNECTED');
    expect(error.message).toContain('gateway returned 500');
    expect(fixture.operationsCalled()).not.toContain('positions.page');
  });

  it('one sync sends at most one initialization, even when that sync then fails; the next sync is judged on its own status', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.brokerageBefore = notReady();
    fixture.brokerageAfterInit = statusOf({ connected: false });
    const { adapter, clock } = adapterWith(fixture, { allowInit: true });
    expect((await errorOf(adapter.fetchSnapshot())).code).toBe('BROKER_BROKERAGE_INIT_FAILED');
    expect(initCalls(fixture)).toHaveLength(1);
    clock.advance(10_000);
    expect((await errorOf(adapter.fetchSnapshot())).code).toBe('BROKER_BROKERAGE_INIT_FAILED');
    // The second sync reads its own status first, sees a session that is still not connected, and may send its own single initialization.
    expect(initCalls(fixture)).toHaveLength(2);
  });
});

describe('O19 IBKR adapter: competing sessions are reported and never taken over', () => {
  it('a competing brokerage session is reported before any initialization, with the gate open or closed', async () => {
    for (const allowInit of [false, true]) {
      const fixture = new FixtureIbkrReadOnlyAdapter();
      fixture.brokerageBefore = statusOf({ competing: true });
      const error = await errorOf(adapterWith(fixture, { allowInit }).adapter.fetchSnapshot());
      expect(error.code).toBe('BROKER_SESSION_COMPETING');
      expect(initCalls(fixture)).toHaveLength(0);
      expect(fixture.operationsCalled()).not.toContain('positions.page');
    }
  });

  it('a competing session that appears after the initialization stops the sync, with no second initialization', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.brokerageBefore = statusOf({ authenticated: false, connected: false });
    fixture.brokerageAfterInit = statusOf({ competing: true });
    const error = await errorOf(adapterWith(fixture, { allowInit: true }).adapter.fetchSnapshot());
    expect(error.code).toBe('BROKER_SESSION_COMPETING');
    expect(initCalls(fixture)).toHaveLength(1);
    expect(fixture.operationsCalled()).not.toContain('positions.page');
  });
});

describe('O19 IBKR adapter: inconsistent brokerage states never lead to portfolio reads', () => {
  const inconsistent: Array<[string, Record<string, unknown>]> = [
    ['authenticated, not connected', { authenticated: true, connected: false, established: true }],
    ['authenticated, not established', { authenticated: true, connected: true, established: false }],
    ['established, not authenticated', { authenticated: false, connected: true, established: true }],
    ['connected, nothing else', { authenticated: false, connected: true, established: false }],
  ];

  for (const [name, flags] of inconsistent) {
    it(`${name}, gate closed: BROKER_BROKERAGE_INIT_REQUIRED, no initialization, no portfolio read`, async () => {
      const fixture = new FixtureIbkrReadOnlyAdapter();
      fixture.brokerageBefore = statusOf(flags);
      expect((await errorOf(adapterWith(fixture).adapter.fetchSnapshot())).code).toBe('BROKER_BROKERAGE_INIT_REQUIRED');
      expect(initCalls(fixture)).toHaveLength(0);
      expect(fixture.operationsCalled()).not.toContain('positions.page');
    });

    it(`${name}, gate open, still inconsistent after the one initialization: BROKER_BROKERAGE_INIT_FAILED, no portfolio read`, async () => {
      const fixture = new FixtureIbkrReadOnlyAdapter();
      fixture.brokerageBefore = statusOf(flags);
      fixture.brokerageAfterInit = statusOf(flags);
      expect((await errorOf(adapterWith(fixture, { allowInit: true }).adapter.fetchSnapshot())).code).toBe('BROKER_BROKERAGE_INIT_FAILED');
      expect(initCalls(fixture)).toHaveLength(1);
      expect(fixture.operationsCalled()).not.toContain('positions.page');
      expect(fixture.operationsCalled()).not.toContain('accounts.list');
    });
  }

  it('the initialization answer is not authority: an answer that claims ready, followed by a status that does not, is a failure', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.brokerageBefore = statusOf({ authenticated: false });
    fixture.initBody = { authenticated: true, connected: true, competing: false, established: true };
    fixture.brokerageAfterInit = statusOf({ established: false });
    expect((await errorOf(adapterWith(fixture, { allowInit: true }).adapter.fetchSnapshot())).code).toBe('BROKER_BROKERAGE_INIT_FAILED');
    expect(fixture.operationsCalled()).not.toContain('positions.page');
  });

  it('an incomplete status after the initialization is BROKER_RESPONSE_INVALID, and the sync does not repeat the initialization', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.brokerageBefore = statusOf({ authenticated: false });
    fixture.brokerageAfterInit = { authenticated: true, connected: true, competing: false };
    expect((await errorOf(adapterWith(fixture, { allowInit: true }).adapter.fetchSnapshot())).code).toBe('BROKER_RESPONSE_INVALID');
    expect(initCalls(fixture)).toHaveLength(1);
    expect(fixture.operationsCalled()).not.toContain('positions.page');
  });

  it('an accounts answer that is empty after the initialization is BROKER_BROKERAGE_INIT_FAILED, and no portfolio is read', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.brokerageBefore = statusOf({ authenticated: false });
    fixture.brokerageAccounts = { accounts: [] };
    const error = await errorOf(adapterWith(fixture, { allowInit: true }).adapter.fetchSnapshot());
    expect(error.code).toBe('BROKER_BROKERAGE_INIT_FAILED');
    expect(fixture.operationsCalled()).not.toContain('accounts.list');
  });
});

describe('O19 IBKR adapter: malformed brokerage status is refused, and an initialization is never sent on its basis', () => {
  it('a status without one of the four required flags is BROKER_RESPONSE_INVALID, even with the gate open, and nothing is initialized', async () => {
    for (const key of ['authenticated', 'connected', 'competing', 'established']) {
      const fixture = new FixtureIbkrReadOnlyAdapter();
      const body: Record<string, unknown> = statusOf({ authenticated: false });
      delete body[key];
      fixture.brokerageBefore = body;
      const error = await errorOf(adapterWith(fixture, { allowInit: true }).adapter.fetchSnapshot());
      expect(error.code).toBe('BROKER_RESPONSE_INVALID');
      expect(error.message).toContain('brokerage status.' + key);
      expect(initCalls(fixture)).toHaveLength(0);
    }
  });

  it('a status with a string where a flag belongs is BROKER_RESPONSE_INVALID, never read as true', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.brokerageBefore = statusOf({ authenticated: 'true' });
    expect((await errorOf(adapterWith(fixture, { allowInit: true }).adapter.fetchSnapshot())).code).toBe('BROKER_RESPONSE_INVALID');
    expect(initCalls(fixture)).toHaveLength(0);
    expect(fixture.operationsCalled()).not.toContain('positions.page');
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

  it('the adapter only ever calls allowlisted operations; the POST operations are the keepalive, the status and the one initialization', async () => {
    const fixture = new FixtureIbkrReadOnlyAdapter();
    fixture.brokerageBefore = statusOf({ authenticated: false });
    await adapterWith(fixture, { allowInit: true }).adapter.fetchSnapshot();
    expect(fixture.operationsCalled().sort()).toEqual(['account.ledger', 'account.meta', 'accounts.list', 'brokerage.accounts', 'brokerage.init', 'brokerage.status', 'orders.open', 'positions.page', 'session.tickle']);
  });
});
