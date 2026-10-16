// The eToro demo read-only adapter: the empty demo portfolio is a verified empty snapshot, the status mapping, no retry, one request
// per sync, and an honest coverage statement. Account identity and cash are never invented.
import { describe, expect, it } from 'vitest';
import { BrokerError } from '../../../src/broker/broker-errors.js';
import { EtoroBrokerSyncAdapter, ETORO_COVERAGE } from '../../../src/broker/etoro/etoro-sync-adapter.js';
import { emptyDemoPortfolio, FixtureEtoroTransport, fixedClock } from './o20-fixture.js';

const T0 = '2026-10-16T09:00:00.000Z';

function adapterWith(transport: FixtureEtoroTransport, clock = fixedClock(T0)) {
  return new EtoroBrokerSyncAdapter({ transport, clock: clock.now });
}

async function errorOf(promise: Promise<unknown>): Promise<BrokerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrokerError) return error;
    throw error;
  }
  throw new Error('expected a BrokerError');
}

describe('O20 eToro adapter: the empty demo portfolio', () => {
  it('a valid empty demo portfolio gives a verified empty snapshot, with broker etoro and read-only access', async () => {
    const adapter = adapterWith(new FixtureEtoroTransport());
    const snapshot = await adapter.fetchSnapshot();
    expect(snapshot).toMatchObject({ broker: 'etoro', access: 'read_only', observedAt: T0, retrievedAt: T0 });
    expect(snapshot.positions).toEqual([]);
    expect(snapshot.openOrders).toEqual([]);
    expect(snapshot.cash).toEqual([]);
    expect(adapter.connection()).toBe('connected');
  });

  it('the snapshot states its coverage: cash not read, positions and open orders verified empty, no account identity observed', async () => {
    const snapshot = await adapterWith(new FixtureEtoroTransport()).fetchSnapshot();
    expect(snapshot.coverage).toEqual(ETORO_COVERAGE);
    expect(snapshot.coverage).toEqual({ cash: 'not_read', positions: 'verified_empty', openOrders: 'verified_empty', accountIdentity: 'not_observed' });
  });

  it('no account identifier is invented: accountId is null', async () => {
    expect((await adapterWith(new FixtureEtoroTransport()).fetchSnapshot()).accountId).toBeNull();
  });

  it('no cash amount is derived from the credit field, whatever its value', async () => {
    const transport = new FixtureEtoroTransport();
    transport.response = { status: 200, body: emptyDemoPortfolio({ credit: 999999 }) };
    const snapshot = await adapterWith(transport).fetchSnapshot();
    expect(snapshot.cash).toEqual([]);
  });

  it('the observation and retrieval times come from the clock', async () => {
    const clock = fixedClock(T0);
    const transport = new FixtureEtoroTransport();
    const adapter = new EtoroBrokerSyncAdapter({
      transport,
      clock: () => {
        const now = clock.now();
        clock.advance(250);
        return now;
      },
    });
    const snapshot = await adapter.fetchSnapshot();
    expect(snapshot.observedAt).toBe(T0);
    expect(snapshot.retrievedAt).toBe('2026-10-16T09:00:00.250Z');
  });
});

describe('O20 eToro adapter: one request, the allowlisted operation only', () => {
  it('one sync sends exactly one GET of the allowlisted demo portfolio', async () => {
    const transport = new FixtureEtoroTransport();
    await adapterWith(transport).fetchSnapshot();
    expect(transport.calls).toEqual(['portfolio.demo']);
  });

  it('concurrent calls share one sync: the broker is asked once, and both callers get the same snapshot', async () => {
    const transport = new FixtureEtoroTransport();
    const adapter = adapterWith(transport);
    const [first, second] = await Promise.all([adapter.fetchSnapshot(), adapter.fetchSnapshot()]);
    expect(first).toBe(second);
    expect(transport.calls).toHaveLength(1);
  });

  it('a failed sync is not retried by the adapter', async () => {
    const transport = new FixtureEtoroTransport();
    transport.response = { status: 500, body: null };
    await errorOf(adapterWith(transport).fetchSnapshot());
    expect(transport.calls).toHaveLength(1);
  });
});

describe('O20 eToro adapter: the status mapping', () => {
  const cases: Array<[number, string]> = [
    [401, 'BROKER_AUTH_REQUIRED'],
    [403, 'BROKER_AUTH_REQUIRED'],
    [429, 'BROKER_RATE_LIMITED'],
    [500, 'BROKER_NOT_CONNECTED'],
    [503, 'BROKER_NOT_CONNECTED'],
    [404, 'BROKER_RESPONSE_INVALID'],
    [400, 'BROKER_RESPONSE_INVALID'],
  ];
  for (const [status, code] of cases) {
    it(`HTTP ${status} is ${code}, and the adapter reports not connected afterwards`, async () => {
      const transport = new FixtureEtoroTransport();
      transport.response = { status, body: null };
      const adapter = adapterWith(transport);
      expect((await errorOf(adapter.fetchSnapshot())).code).toBe(code);
      expect(adapter.connection()).toBe('not_connected');
    });
  }

  it('a timeout from the transport is BROKER_TIMEOUT and reaches the caller unchanged', async () => {
    const transport = new FixtureEtoroTransport();
    transport.error = new BrokerError('BROKER_TIMEOUT');
    expect((await errorOf(adapterWith(transport).fetchSnapshot())).code).toBe('BROKER_TIMEOUT');
  });

  it('a network failure from the transport is BROKER_NOT_CONNECTED', async () => {
    const transport = new FixtureEtoroTransport();
    transport.error = new BrokerError('BROKER_NOT_CONNECTED');
    expect((await errorOf(adapterWith(transport).fetchSnapshot())).code).toBe('BROKER_NOT_CONNECTED');
  });
});

describe('O20 eToro adapter: a non-empty portfolio is refused, never mapped', () => {
  it('a demo portfolio with a position is BROKER_RESPONSE_INVALID, and no snapshot is returned', async () => {
    const transport = new FixtureEtoroTransport();
    transport.response = { status: 200, body: emptyDemoPortfolio({ positions: [{ instrumentId: 1 }] }) };
    const adapter = adapterWith(transport);
    const error = await errorOf(adapter.fetchSnapshot());
    expect(error.code).toBe('BROKER_RESPONSE_INVALID');
    expect(adapter.connection()).toBe('not_connected');
  });

  it('a demo portfolio with an open order is refused as well', async () => {
    const transport = new FixtureEtoroTransport();
    transport.response = { status: 200, body: emptyDemoPortfolio({ ordersForOpen: [{ orderId: 7 }] }) };
    expect((await errorOf(adapterWith(transport).fetchSnapshot())).code).toBe('BROKER_RESPONSE_INVALID');
  });

  it('a body that is missing clientPortfolio is BROKER_RESPONSE_INVALID', async () => {
    const transport = new FixtureEtoroTransport();
    transport.response = { status: 200, body: { positions: [] } };
    expect((await errorOf(adapterWith(transport).fetchSnapshot())).code).toBe('BROKER_RESPONSE_INVALID');
  });
});

describe('O20 eToro adapter: the adapter has no execution capability', () => {
  it('the adapter exposes no order, modify, cancel or transfer method', () => {
    const members = Object.getOwnPropertyNames(EtoroBrokerSyncAdapter.prototype);
    expect(members.sort()).toEqual(['call', 'collect', 'connection', 'constructor', 'fetchSnapshot'].sort());
  });
});
