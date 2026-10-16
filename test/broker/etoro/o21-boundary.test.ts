// O21 boundary: the demo execution layer can reach exactly the verified eToro demo operations, nothing else. No real-account path
// exists in the source, no generic request function exists, and every request shape follows the official reference exactly.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILD_LOCKS } from '../../../src/nexus/safety.js';
import {
  ETORO_DEMO_EXECUTION_OPERATIONS,
  ETORO_DEMO_EXECUTION_ROOT,
  demoOperationUrl,
} from '../../../src/broker/etoro/execution/etoro-demo-execution-endpoints.js';
import { HttpsDemoExecutionTransport } from '../../../src/broker/etoro/execution/etoro-demo-execution-transport.js';
import { DemoExecutionError } from '../../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import { closePositionBody, openOrderBody, parseExecutionIntent, bindClosePosition } from '../../../src/broker/etoro/execution/execution-intent.js';
import { API_KEY_MARKER, ETORO_AAPL_ID, ScriptedBroker, closeInput, openInput } from './o21-fixture.js';

const DIR = join('src', 'broker', 'etoro', 'execution');
const SOURCES = readdirSync(DIR).filter((f) => f.endsWith('.ts')).map((f) => ({ file: f, text: readFileSync(join(DIR, f), 'utf8') }));
const UUID = '0b7e1a52-6f0e-4a8e-9a43-2f1c3d4e5f60';

describe('O21 boundary: the verified demo endpoints, exactly', () => {
  it('the demo execution root is the confirmed one', () => {
    expect(ETORO_DEMO_EXECUTION_ROOT).toBe('https://public-api.etoro.com/api/v2/trading/execution/demo');
  });

  it('five operations, with the methods and the v1/v2 versions of the official reference (not unified)', () => {
    expect(ETORO_DEMO_EXECUTION_OPERATIONS).toEqual({
      'demo.order.open': { method: 'POST', write: true, template: '/api/v2/trading/execution/demo/orders' },
      'demo.order.cancel': { method: 'DELETE', write: true, template: '/api/v2/trading/execution/demo/orders/{orderId}' },
      'demo.position.close': { method: 'POST', write: true, template: '/api/v1/trading/execution/demo/market-close-orders/positions/{positionId}' },
      'demo.order.lookup': { method: 'GET', write: false, template: '/api/v2/trading/info/demo/orders:lookup' },
      'demo.closeOrder.info': { method: 'GET', write: false, template: '/api/v1/trading/info/demo/close-orders/{orderId}' },
    });
  });

  it('builds each URL from validated ids only', () => {
    expect(demoOperationUrl('demo.order.open')).toBe('https://public-api.etoro.com/api/v2/trading/execution/demo/orders');
    expect(demoOperationUrl('demo.order.cancel', { orderId: 13902598 })).toBe('https://public-api.etoro.com/api/v2/trading/execution/demo/orders/13902598');
    expect(demoOperationUrl('demo.position.close', { positionId: 2150941015 })).toBe('https://public-api.etoro.com/api/v1/trading/execution/demo/market-close-orders/positions/2150941015');
    expect(demoOperationUrl('demo.order.lookup', { orderId: 13902598 })).toBe('https://public-api.etoro.com/api/v2/trading/info/demo/orders:lookup?orderId=13902598');
    expect(demoOperationUrl('demo.order.lookup', { referenceId: UUID.toUpperCase() })).toBe('https://public-api.etoro.com/api/v2/trading/info/demo/orders:lookup?referenceId=' + UUID);
    expect(demoOperationUrl('demo.closeOrder.info', { orderId: 13904638 })).toBe('https://public-api.etoro.com/api/v1/trading/info/demo/close-orders/13904638');
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])('refuses the id %s in a path', (id) => {
    expect(() => demoOperationUrl('demo.order.cancel', { orderId: id })).toThrow(RangeError);
    expect(() => demoOperationUrl('demo.position.close', { positionId: id })).toThrow(RangeError);
  });

  it('a lookup takes exactly one of orderId and referenceId, and the referenceId must be a UUID', () => {
    expect(() => demoOperationUrl('demo.order.lookup', {} as never)).toThrow(RangeError);
    expect(() => demoOperationUrl('demo.order.lookup', { orderId: 1, referenceId: UUID } as never)).toThrow(RangeError);
    expect(() => demoOperationUrl('demo.order.lookup', { referenceId: '../../real' })).toThrow(RangeError);
  });
});

describe('O21 boundary: no real path, no generic request', () => {
  it('every operation path is a demo path', () => {
    for (const spec of Object.values(ETORO_DEMO_EXECUTION_OPERATIONS)) expect(spec.template).toContain('/demo/');
  });

  it('the source of the execution layer names no real-account endpoint (real endpoints in code = 0)', () => {
    for (const { file, text } of SOURCES) {
      // A trading path without the demo segment is a real-account path.
      expect(text, file).not.toMatch(/\/trading\/execution\/(?!demo\b)/);
      expect(text, file).not.toMatch(/\/trading\/info\/(?!demo\b)/);
      expect(text, file).not.toMatch(/\/real\//);
      expect(text, file).not.toMatch(/api\/v3\//);
    }
  });

  it('there is no generic request function: no method, path or host comes from a caller', () => {
    for (const { file, text } of SOURCES) {
      expect(text, file).not.toMatch(/\brequest\s*\(\s*method/);
      expect(text, file).not.toMatch(/function\s+request\s*\(/);
    }
  });

  it('the transport refuses a URL that is not the allowlisted demo URL of its operation, before anything is sent', async () => {
    const broker = new ScriptedBroker();
    const transport = new HttpsDemoExecutionTransport({ credentials: { apiKey: API_KEY_MARKER, userKey: 'O21-USER' }, fetch: broker.fetch });
    const bad = [
      'https://public-api.etoro.com/api/v2/trading/execution/orders',
      'https://public-api.etoro.com/api/v1/trading/execution/market-close-orders/positions/1',
      'https://evil.example.com/api/v2/trading/execution/demo/orders',
      'https://public-api.etoro.com/api/v2/trading/execution/demo/orders/1',
    ];
    for (const url of bad) {
      await expect(transport.send({ operation: 'demo.order.open', url, requestId: UUID, body: {} })).rejects.toBeInstanceOf(DemoExecutionError);
    }
    await expect(transport.send({ operation: 'demo.order.cancel', url: demoOperationUrl('demo.order.open'), requestId: UUID })).rejects.toBeInstanceOf(DemoExecutionError);
    expect(broker.requests).toHaveLength(0);
  });

  it('the transport refuses a request id that is not a UUID, and a body on an operation that takes none', async () => {
    const broker = new ScriptedBroker();
    const transport = new HttpsDemoExecutionTransport({ credentials: { apiKey: API_KEY_MARKER, userKey: 'O21-USER' }, fetch: broker.fetch });
    await expect(transport.send({ operation: 'demo.order.open', url: demoOperationUrl('demo.order.open'), requestId: 'not-a-uuid', body: {} })).rejects.toBeInstanceOf(DemoExecutionError);
    await expect(transport.send({ operation: 'demo.order.cancel', url: demoOperationUrl('demo.order.cancel', { orderId: 5 }), requestId: UUID, body: {} })).rejects.toBeInstanceOf(DemoExecutionError);
    expect(broker.requests).toHaveLength(0);
  });
});

describe('O21 boundary: request bodies exactly as in the reference', () => {
  it('a market buy uses only documented fields: action, transaction, instrumentId, orderType, leverage, amount, orderCurrency, SL/TP', () => {
    expect(openOrderBody(parseExecutionIntent(openInput()))).toEqual({
      action: 'open',
      transaction: 'buy',
      instrumentId: ETORO_AAPL_ID,
      orderType: 'mkt',
      leverage: 1,
      amount: 500,
      orderCurrency: 'usd',
      stopLossRate: 180,
      stopLossType: 'fixed',
      takeProfitRate: 230,
    });
  });

  it('a sell is opened as sellShort (the reference supports buy and sellShort for an open), with units and no orderCurrency', () => {
    const body = openOrderBody(parseExecutionIntent(openInput({ side: 'sell', amount: undefined, units: '2.5', stopLoss: '220', takeProfit: '180' })));
    expect(body).toMatchObject({ transaction: 'sellShort', units: 2.5, stopLossRate: 220 });
    expect(body).not.toHaveProperty('amount');
    expect(body).not.toHaveProperty('orderCurrency');
  });

  it('a mit open carries triggerRate; settlementType is optional on v2 and is not guessed', () => {
    const body = openOrderBody(parseExecutionIntent(openInput({ orderType: 'mit', triggerRate: '195' })));
    expect(body).toMatchObject({ orderType: 'mit', triggerRate: 195 });
    expect(body).not.toHaveProperty('settlementType');
    expect(body).not.toHaveProperty('positionIds');
  });

  it('the close body uses the reference names InstrumentID and UnitsToDeduct, null for a full close', () => {
    const unbound = parseExecutionIntent(closeInput('eint_' + 'a'.repeat(40)));
    const full = bindClosePosition(unbound, 2150941015);
    expect(closePositionBody(full)).toEqual({ InstrumentID: ETORO_AAPL_ID, UnitsToDeduct: null });
    const partial = bindClosePosition(parseExecutionIntent(closeInput('eint_' + 'a'.repeat(40), { units: '1.5' })), 2150941015);
    expect(closePositionBody(partial)).toEqual({ InstrumentID: ETORO_AAPL_ID, UnitsToDeduct: 1.5 });
    expect(Object.keys(closePositionBody(full))).not.toContain('InstrumentId');
  });
});

describe('O21 boundary: the safety locks', () => {
  it('the demo execution lock is closed, and the existing locks are unchanged', () => {
    expect(BUILD_LOCKS).toEqual({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: true });
    expect(Object.isFrozen(BUILD_LOCKS)).toBe(true);
  });

  it('the execution layer never imports the ledger or the capital engine', () => {
    for (const { file, text } of SOURCES) {
      expect(text, file).not.toMatch(/from '\.\.\/\.\.\/\.\.\/capital\//);
      expect(text, file).not.toMatch(/ledger-store|capital-ledger|capital-engine/);
    }
  });
});
