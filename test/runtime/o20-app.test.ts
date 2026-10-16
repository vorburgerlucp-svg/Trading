// The eToro routes of the runtime (O20): the four read-only routes answer, every order-like path is a 404, a wrong method is a 405, and
// a broker error becomes a stable code with a fixed message. The handler is tested over real HTTP, with fake services.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrokerError, type BrokerErrorCode } from '../../src/broker/broker-errors.js';
import { createRuntimeHandler, type RuntimeServices } from '../../src/runtime/app.js';

interface Calls {
  sync: number;
  requireFresh: boolean[];
}

let server: Server;
let base: string;
let calls: Calls;
let failWith: BrokerErrorCode | null;

function fakeServices(): RuntimeServices {
  return {
    etoroStatus: async () => ({ etoro: { configured: true, tradingMode: 'demo', connection: 'connected', access: 'read_only' } }),
    etoroSync: async () => {
      calls.sync++;
      if (failWith !== null) throw new BrokerError(failWith);
      return { snapshot: { snapshotId: 'esnap_fake' }, reconciliation: { matched: true } };
    },
    etoroSnapshot: async () => ({ snapshot: null }),
    etoroReconciliation: async (requireFresh: boolean) => {
      calls.requireFresh.push(requireFresh);
      if (failWith !== null) throw new BrokerError(failWith);
      return { reconciliation: null };
    },
  } as unknown as RuntimeServices;
}

async function call(method: string, path: string): Promise<{ status: number; text: string; json: unknown }> {
  const res = await fetch(base + path, { method, headers: { accept: 'application/json' } });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

beforeEach(async () => {
  calls = { sync: 0, requireFresh: [] };
  failWith = null;
  server = createServer(createRuntimeHandler(fakeServices()));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('O20 eToro routes: the read-only routes answer', () => {
  it('GET status answers 200', async () => {
    expect((await call('GET', '/api/broker/etoro/status')).status).toBe(200);
  });

  it('POST sync answers 200 and runs one sync', async () => {
    const response = await call('POST', '/api/broker/etoro/sync');
    expect(response.status).toBe(200);
    expect(calls.sync).toBe(1);
  });

  it('GET snapshot answers 200', async () => {
    expect((await call('GET', '/api/broker/etoro/snapshot')).status).toBe(200);
  });

  it('GET reconciliation passes requireFresh=0 as false and requireFresh=1 as true', async () => {
    await call('GET', '/api/broker/etoro/reconciliation');
    await call('GET', '/api/broker/etoro/reconciliation?requireFresh=0');
    await call('GET', '/api/broker/etoro/reconciliation?requireFresh=1');
    expect(calls.requireFresh).toEqual([false, false, true]);
  });

  it('any other requireFresh value is REQUEST_INVALID, and the service is not called', async () => {
    const response = await call('GET', '/api/broker/etoro/reconciliation?requireFresh=2');
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ error: { code: 'REQUEST_INVALID' } });
    expect(calls.requireFresh).toHaveLength(0);
  });
});

describe('O20 eToro routes: there is no order route', () => {
  it('POST /api/broker/etoro/order is 404', async () => {
    const response = await call('POST', '/api/broker/etoro/order');
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('POST /api/broker/etoro/place is 404', async () => {
    expect((await call('POST', '/api/broker/etoro/place')).status).toBe(404);
  });

  it('no order-like path answers anything but 404, for any method', async () => {
    for (const path of ['/api/broker/etoro/orders', '/api/broker/etoro/cancel', '/api/broker/etoro/modify', '/api/broker/etoro/close']) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        expect((await call(method, path)).status).toBe(404);
      }
    }
  });

  it('a wrong method on a read route is 405, and nothing is sent to the broker', async () => {
    expect((await call('GET', '/api/broker/etoro/sync')).status).toBe(405);
    expect((await call('DELETE', '/api/broker/etoro/status')).status).toBe(405);
    expect(calls.sync).toBe(0);
  });
});

describe('O20 eToro routes: broker errors become stable codes', () => {
  const cases: Array<[BrokerErrorCode, number]> = [
    ['BROKER_NOT_CONNECTED', 503],
    ['BROKER_AUTH_REQUIRED', 503],
    ['BROKER_RESPONSE_INVALID', 502],
    ['BROKER_TIMEOUT', 504],
    ['BROKER_RATE_LIMITED', 429],
    ['BROKER_RECONCILIATION_FAILURE', 500],
  ];
  for (const [code, status] of cases) {
    it(`${code} is HTTP ${status} with the same code, and a fixed message`, async () => {
      failWith = code;
      const response = await call('POST', '/api/broker/etoro/sync');
      expect(response.status).toBe(status);
      expect(response.json).toMatchObject({ error: { code } });
      expect((response.json as { error: { message: string } }).error.message.length).toBeGreaterThan(0);
    });
  }

  it('a stale reconciliation requested with requireFresh=1 is BROKER_SNAPSHOT_STALE (409)', async () => {
    failWith = 'BROKER_SNAPSHOT_STALE';
    const response = await call('GET', '/api/broker/etoro/reconciliation?requireFresh=1');
    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({ error: { code: 'BROKER_SNAPSHOT_STALE' } });
  });

  it('an error body never carries a key, a header name, or a raw broker message', async () => {
    failWith = 'BROKER_AUTH_REQUIRED';
    const response = await call('POST', '/api/broker/etoro/sync');
    expect(response.text).not.toMatch(/x-api-key|x-user-key|x-request-id|ETORO-/i);
  });
});
