import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarketDataError } from '../../src/market-data/market-data-provider.js';
import { createRuntimeHandler, type RuntimeServices } from '../../src/runtime/app.js';

const SECRET = 'SECRETKEY9876543210ABCDEF';
const DB_PASS = 'db-password-never-shown';

function services(overrides: Partial<RuntimeServices> = {}): RuntimeServices {
  return {
    health: async () => ({
      status: 'ok',
      database: 'connected',
      marketData: 'not_configured',
      providerHealth: 'not_configured',
      tradingMode: 'paper',
      liveTrading: 'locked',
      buildLocks: { liveTrading: true, brokerOrders: true, physicalPurchase: true },
      version: 'test',
    }),
    searchInstruments: async () => [],
    registerInstrument: async (request) => ({
      instrumentId: 'ins_test',
      provider: 'twelvedata',
      providerSymbol: request.providerSymbol,
      name: 'Test Instrument',
      assetClass: 'stock',
      exchange: request.exchange ?? null,
      mic: request.mic ?? null,
      currency: 'USD',
      timezone: 'America/New_York',
    }),
    readBars: async () => ({ bars: [] }),
    quote: async () => ({ quote: null }),
    runQuant: async () => ({ status: 'insufficient_data' }),
    safetyStatus: async () => ({ liveTradingAllowed: false }),
    ...overrides,
  };
}

let server: Server;
let base: string;

async function start(s: RuntimeServices): Promise<void> {
  server = createServer(createRuntimeHandler(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  base = 'http://127.0.0.1:' + address.port;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => undefined);

describe('O18 runtime HTTP surface', () => {
  it('GET /health answers with the safety state and never a secret', async () => {
    await start(services());
    const response = await fetch(base + '/health');
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'ok', tradingMode: 'paper', liveTrading: 'locked' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('unknown routes, including every reset, unlock, arm and enable path, are not found', async () => {
    await start(services());
    for (const path of ['/reset', '/unlock', '/arm', '/enable-live', '/api/safety/reset', '/api/kill-switch/reset', '/api/broker/place']) {
      const response = await fetch(base + path, { method: 'POST' });
      expect(response.status, path).toBe(404);
    }
  });

  it('a route with the wrong method is refused, and the paper intent route is reserved, not simulated', async () => {
    await start(services());
    expect((await fetch(base + '/health', { method: 'POST' })).status).toBe(405);
    expect((await fetch(base + '/api/quant/run')).status).toBe(405);
    const paper = await fetch(base + '/api/paper/intents');
    expect(paper.status).toBe(501);
    expect(await paper.json()).toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } });
  });

  it('manipulated intervals, non-canonical timestamps and unknown instrument ids are refused before any service call', async () => {
    let calls = 0;
    await start(services({ readBars: async () => { calls += 1; return {}; } }));
    const bad = [
      '/api/market/bars?instrumentId=AAPL&interval=2m&from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z',
      '/api/market/bars?instrumentId=AAPL&interval=1h&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00.000Z',
      '/api/market/bars?instrumentId=AAPL&interval=1h&from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z',
      '/api/market/bars?instrumentId=AA%20PL&interval=1h&from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z',
      '/api/market/bars?instrumentId=AAPL&interval=1h&from=2020-01-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z',
    ];
    for (const path of bad) {
      const response = await fetch(base + path);
      expect(response.status, path).toBe(400);
      expect((await response.json() as { error: { code: string } }).error.code).toBe('REQUEST_INVALID');
    }
    expect(calls).toBe(0);
  });

  it('the bar intervals 1m 5m 15m 1h 4h 1d are accepted', async () => {
    const seen: string[] = [];
    await start(services({ readBars: async (request) => { seen.push(request.interval); return { bars: [] }; } }));
    for (const interval of ['1m', '5m', '15m', '1h', '4h', '1d']) {
      const response = await fetch(base + '/api/market/bars?instrumentId=AAPL&interval=' + interval + '&from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z');
      expect(response.status, interval).toBe(200);
    }
    expect(seen).toEqual(['1m', '5m', '15m', '1h', '4h', '1d']);
  });

  it('instrument registration is explicit and requires a canonical mapping start', async () => {
    await start(services());
    const good = await fetch(base + '/api/instruments/register', {
      method: 'POST',
      body: JSON.stringify({ providerSymbol: 'AAPL', validFrom: '1980-12-12T00:00:00.000Z', mic: 'XNAS', exchange: 'NASDAQ' }),
    });
    expect(good.status).toBe(201);
    expect(await good.json()).toMatchObject({ instrument: { instrumentId: 'ins_test', providerSymbol: 'AAPL' } });

    const bad = await fetch(base + '/api/instruments/register', {
      method: 'POST',
      body: JSON.stringify({ providerSymbol: 'AAPL', validFrom: '1980-12-12T00:00:00Z' }),
    });
    expect(bad.status).toBe(400);
  });

  it('the quant run rejects unknown body fields and non-JSON, and refuses oversized bodies', async () => {
    await start(services());
    const extra = await fetch(base + '/api/quant/run', { method: 'POST', body: JSON.stringify({ instrumentId: 'AAPL', interval: '1h', asOf: '2026-10-02T00:00:00.000Z', storedThrough: 1 }) });
    expect(extra.status).toBe(400);
    const broken = await fetch(base + '/api/quant/run', { method: 'POST', body: '{not json' });
    expect(broken.status).toBe(400);
    const huge = await fetch(base + '/api/quant/run', { method: 'POST', body: JSON.stringify({ instrumentId: 'A'.repeat(20000) }) });
    expect([400, 413]).toContain(huge.status);
  });

  it('an unconfigured market data provider is DATA NOT CONNECTED, with no substitute data', async () => {
    await start(services({ readBars: async () => { throw new MarketDataError('not_configured', 'twelvedata', 'provider is not configured'); } }));
    const response = await fetch(base + '/api/market/bars?instrumentId=AAPL&interval=1h&from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z');
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('DATA_NOT_CONNECTED');
    expect(JSON.stringify(body)).not.toMatch(/bars|quote|price/i);
  });

  it('an unknown instrument is INSTRUMENT_NOT_FOUND', async () => {
    await start(services({ quote: async () => { throw new MarketDataError('not_found', 'twelvedata', 'unknown instrument'); } }));
    const response = await fetch(base + '/api/market/quote?instrumentId=NOPE');
    expect(response.status).toBe(404);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('INSTRUMENT_NOT_FOUND');
  });

  it('an unexpected error never reaches the client: no message, no stack, no secret, no password', async () => {
    await start(services({
      runQuant: async () => { throw new Error('boom: key=' + SECRET + ' url=postgres://nexus:' + DB_PASS + '@db'); },
    }));
    const response = await fetch(base + '/api/quant/run', { method: 'POST', body: JSON.stringify({ instrumentId: 'AAPL', interval: '1h', asOf: '2026-10-02T00:00:00.000Z' }) });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('INTERNAL_ERROR');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(DB_PASS);
    expect(text).not.toContain('boom');
    expect(text).not.toContain('stack');
  });

  it('no response body carries the configured secret, even when the services return it by mistake in a field name', async () => {
    await start(services({ safetyStatus: async () => ({ liveTradingAllowed: false }) }));
    for (const path of ['/health', '/api/safety/status']) {
      const text = await (await fetch(base + path)).text();
      expect(text).not.toContain(SECRET);
    }
  });
});
