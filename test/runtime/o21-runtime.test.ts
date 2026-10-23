// O21 runtime: the demo intent routes over real HTTP and the production composition (in-memory stores). Off by default; when on,
// every mutating route needs the authenticated operator (loopback is not authentication), the operator identity comes from the
// server, and every write is still refused by BUILD_LOCKS.etoroDemoExecution: no broker request is made. No real route exists.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CapitalLedger } from '../../src/capital/capital-ledger.js';
import { InstrumentRegistry, type InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import { InMemoryMarketDataStore } from '../../src/market-data/market-data-store.js';
import { InMemoryQuantRunStore } from '../../src/quant/quant-run-store.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore } from '../../src/persistence/append-only-log.js';
import type { KillSwitchState } from '../../src/safety/portfolio-safety-envelope.js';
import type { EtoroReconciliationRecord, EtoroSnapshotRecord, EtoroSyncRecord } from '../../src/broker/etoro/etoro-broker-service.js';
import { HttpsDemoExecutionTransport } from '../../src/broker/etoro/execution/etoro-demo-execution-transport.js';
import type { AttemptRecord, ConfirmationRecord, IntentEvent, ReconciliationRecord } from '../../src/broker/etoro/execution/etoro-demo-execution-service.js';
import type { ExternalClosureRecord } from '../../src/broker/etoro/execution/external-closure.js';
import { BUILD_LOCKS } from '../../src/nexus/safety.js';
import { createRuntimeHandler } from '../../src/runtime/app.js';
import { composeRuntime, type ComposeInput } from '../../src/runtime/compose.js';
import { OperatorAuthenticator } from '../../src/runtime/operator-auth.js';
import { startHttpServer, type RunningServer } from '../../src/runtime/server.js';
import { AAPL } from '../market-data/fixtures.js';
import { FixtureEtoroTransport } from '../broker/etoro/o20-fixture.js';
import { API_KEY_MARKER, ETORO_AAPL_ID, O21_NOW, ScriptedBroker, USER_KEY_MARKER, closeInput, freshQuote, normalSafety, openInput } from '../broker/etoro/o21-fixture.js';

const OPERATOR_ID = 'operator-real';
const OPERATOR_TOKEN = 'O21-OPERATOR-TOKEN-MARKER-0123456789abcdef';
const AUTH = { authorization: 'Bearer ' + OPERATOR_TOKEN };

let server: RunningServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

interface Runtime {
  base: string;
  broker: ScriptedBroker;
  readOnly: FixtureEtoroTransport;
  ledger: CapitalLedger;
  intents: AppendOnlyLog<IntentEvent> | null;
  attempts: AppendOnlyLog<AttemptRecord> | null;
}

async function runtime(options: { execution: boolean; injectSafety?: boolean; auth?: boolean }): Promise<Runtime> {
  const now = () => new Date(O21_NOW);
  const instruments = new InMemoryAppendOnlyStore<InstrumentEvent>();
  const registry = await InstrumentRegistry.open(instruments, { clock: now });
  const change = { at: '2026-10-01T00:00:00.000Z', by: { kind: 'human' as const, id: 'mapping-owner' }, reason: 'O21 runtime test: governed eToro mapping' };
  await registry.register({ ...AAPL }, change);
  await registry.addMapping({ instrumentId: AAPL.instrumentId, provider: 'etoro', providerSymbol: String(ETORO_AAPL_ID), validFrom: '2026-10-01T00:00:00.000Z' }, change);

  const ledger = await CapitalLedger.inMemory();
  const readOnly = new FixtureEtoroTransport();
  const broker = new ScriptedBroker();
  const etoro: NonNullable<ComposeInput['etoro']> = {
    transport: readOnly,
    ledger,
    snapshots: await AppendOnlyLog.inMemory<EtoroSnapshotRecord>('etoro-snapshots', { clock: now }),
    reconciliations: await AppendOnlyLog.inMemory<EtoroReconciliationRecord>('etoro-reconciliations', { clock: now }),
    syncs: await AppendOnlyLog.inMemory<EtoroSyncRecord>('etoro-sync-events', { clock: now }),
  };
  let intents: AppendOnlyLog<IntentEvent> | null = null;
  let attempts: AppendOnlyLog<AttemptRecord> | null = null;
  let execution: ComposeInput['etoroDemoExecution'];
  if (options.execution) {
    intents = await AppendOnlyLog.inMemory<IntentEvent>('etoro-demo-execution-intents', { clock: now });
    attempts = await AppendOnlyLog.inMemory<AttemptRecord>('etoro-demo-execution-attempts', { clock: now });
    execution = {
      transport: new HttpsDemoExecutionTransport({ credentials: { apiKey: API_KEY_MARKER, userKey: USER_KEY_MARKER }, fetch: broker.fetch }),
      intents,
      attempts,
      confirmations: await AppendOnlyLog.inMemory<ConfirmationRecord>('etoro-demo-broker-confirmations', { clock: now }),
      reconciliations: await AppendOnlyLog.inMemory<ReconciliationRecord>('etoro-demo-execution-reconciliations', { clock: now }),
      externalClosures: await AppendOnlyLog.inMemory<ExternalClosureRecord>('etoro-demo-external-closures', { clock: now }),
      ...(options.injectSafety ? { safetyForTests: { current: async () => normalSafety() }, quotesForTests: { latest: async () => freshQuote() } } : {}),
    };
  }
  const services = await composeRuntime({
    instruments,
    marketData: new InMemoryMarketDataStore(),
    quantRuns: new InMemoryQuantRunStore(),
    killSwitch: new InMemoryAppendOnlyStore<KillSwitchState>(),
    provider: null,
    marketDataMode: 'not_configured',
    ping: async () => true,
    version: 'o21-test',
    clock: now,
    etoro,
    ...(execution ? { etoroDemoExecution: execution } : {}),
  });
  const operatorAuth = options.auth === false ? null : new OperatorAuthenticator({ id: OPERATOR_ID, token: OPERATOR_TOKEN });
  server = await startHttpServer(createRuntimeHandler(services, { operatorAuth }), { host: '127.0.0.1', port: 0 });
  return { base: server.url, broker, readOnly, ledger, intents, attempts };
}

const texts: string[] = [];

interface CallOptions {
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
  /** Default true: send the operator token. */
  auth?: boolean;
}

async function call(r: Runtime, method: string, path: string, options: CallOptions = {}): Promise<{ status: number; json: Record<string, any> }> {
  const headers: Record<string, string> = { ...(options.auth === false ? {} : AUTH) };
  const init: RequestInit = { method };
  if (options.raw !== undefined) init.body = options.raw;
  else if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  init.headers = { ...headers, ...(options.headers ?? {}) };
  const res = await fetch(r.base + path, init);
  const text = await res.text();
  texts.push(text);
  return { status: res.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, any>) };
}

const INTENTS = '/api/broker/etoro/demo/intents';

/**
 * The route takes the intent without createdBy: the creator is the authenticated operator. Since O22 the runtime uses the cycle
 * policy (at most 100 USD per open), so the route intent invests 100 USD.
 */
function routeIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { createdBy: _ignored, ...intent } = openInput({ amount: '100', ...overrides });
  void _ignored;
  return intent;
}

async function createdAndApproved(r: Runtime): Promise<string> {
  const created = await call(r, 'POST', INTENTS, { body: routeIntent() });
  expect(created.json.intent?.state, JSON.stringify(created.json)).toBe('RISK_APPROVED');
  const id = created.json.intent.intentId as string;
  expect((await call(r, 'POST', INTENTS + '/' + id + '/approve')).json.intent.state).toBe('APPROVED');
  return id;
}

describe('O21 runtime: disabled by default', () => {
  it('without ETORO_DEMO_EXECUTION_ENABLED every intent route answers EXECUTION_DISABLED and nothing is sent', async () => {
    const r = await runtime({ execution: false });
    expect(await call(r, 'POST', INTENTS, { body: routeIntent() })).toMatchObject({ status: 403, json: { error: { code: 'EXECUTION_DISABLED' } } });
    const id = 'eint_' + 'a'.repeat(40);
    expect((await call(r, 'GET', INTENTS + '/' + id)).json.error.code).toBe('EXECUTION_DISABLED');
    expect((await call(r, 'POST', INTENTS + '/' + id + '/execute')).json.error.code).toBe('EXECUTION_DISABLED');
    expect(r.broker.requests).toHaveLength(0);
  });

  it('/health and /api/health report paper, live trading locked, and every build lock including etoroDemoExecution', async () => {
    const r = await runtime({ execution: true });
    for (const path of ['/health', '/api/health']) {
      expect((await call(r, 'GET', path, { auth: false })).json).toMatchObject({
        tradingMode: 'paper',
        liveTrading: 'locked',
        buildLocks: { liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: true },
      });
    }
    expect(BUILD_LOCKS.etoroDemoExecution).toBe(true);
  });
});

describe('O21 runtime: enabled, authenticated, and still locked in build', () => {
  it('create, risk approval and approval work; execute and cancel are EXECUTION_LOCKED_IN_BUILD with 0 broker requests', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    expect((await call(r, 'POST', '/api/broker/etoro/sync', { auth: false })).status).toBe(200);
    const id = await createdAndApproved(r);
    expect(await call(r, 'POST', INTENTS + '/' + id + '/execute')).toMatchObject({ status: 403, json: { error: { code: 'EXECUTION_LOCKED_IN_BUILD' } } });
    expect(await call(r, 'POST', INTENTS + '/' + id + '/cancel', { body: {} })).toMatchObject({ status: 403, json: { error: { code: 'EXECUTION_LOCKED_IN_BUILD' } } });
    expect(r.broker.requests).toHaveLength(0);
    expect((await call(r, 'GET', INTENTS + '/' + id, { auth: false })).json.intent.state).toBe('APPROVED');
    expect(r.intents?.get(id + ':SUBMITTING')).toBeUndefined();
  });

  it('the creator and the approver are the authenticated operator; nothing in the body can name them', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    const id = await createdAndApproved(r);
    const view = (await call(r, 'GET', INTENTS + '/' + id, { auth: false })).json.intent;
    expect(view.intent.createdBy).toEqual({ kind: 'human', id: OPERATOR_ID });
    expect(view.approvedBy).toEqual({ kind: 'human', id: OPERATOR_ID });
    expect(r.intents?.get(id + ':APPROVED')?.payload.approvedBy).toEqual({ kind: 'human', id: OPERATOR_ID });
  });

  it('a refresh of an intent that was never submitted is refused without a broker request', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    const id = (await call(r, 'POST', INTENTS, { body: routeIntent() })).json.intent.intentId as string;
    expect((await call(r, 'POST', INTENTS + '/' + id + '/refresh')).json.error.code).toBe('INTENT_STATE_INVALID');
    expect(r.broker.requests).toHaveLength(0);
  });

  it('the production composition has no eToro demo safety source: every open is refused PORTFOLIO_SAFETY_NOT_CONNECTED', async () => {
    const r = await runtime({ execution: true });
    const created = await call(r, 'POST', INTENTS, { body: routeIntent() });
    expect(created.status).toBe(201);
    expect(created.json.intent.state).toBe('REJECTED');
    expect(created.json.intent.gateReasons).toContain('PORTFOLIO_SAFETY_NOT_CONNECTED');
    expect(created.json.intent.gateReasons).toContain('QUOTE_STALE_OR_MISSING');
    expect(r.broker.requests).toHaveLength(0);
  });
});

describe('O21 runtime: operator authentication (loopback is not authentication)', () => {
  const steps = ['approve', 'execute', 'refresh', 'cancel'];

  it('without operator configuration every mutating route is refused; reads keep working', async () => {
    const r = await runtime({ execution: true, injectSafety: true, auth: false });
    expect(await call(r, 'POST', INTENTS, { body: routeIntent() })).toMatchObject({ status: 403, json: { error: { code: 'OPERATOR_AUTH_NOT_CONFIGURED' } } });
    for (const step of steps) {
      expect((await call(r, 'POST', INTENTS + '/eint_' + 'a'.repeat(40) + '/' + step)).json.error.code).toBe('OPERATOR_AUTH_NOT_CONFIGURED');
    }
    expect((await call(r, 'GET', INTENTS + '/eint_' + 'a'.repeat(40), { auth: false })).json.error.code).toBe('INTENT_NOT_FOUND');
    expect((await call(r, 'GET', '/api/broker/etoro/status', { auth: false })).status).toBe(200);
    expect(r.broker.requests).toHaveLength(0);
  });

  it.each([
    ['no Authorization header', {}],
    ['a wrong token', { authorization: 'Bearer O21-WRONG-TOKEN-0000000000000000000000000' }],
    ['a token prefix', { authorization: 'Bearer ' + OPERATOR_TOKEN.slice(0, -1) }],
    ['the token with a suffix', { authorization: 'Bearer ' + OPERATOR_TOKEN + 'x' }],
    ['another scheme', { authorization: 'Basic ' + OPERATOR_TOKEN }],
    ['the token without a scheme', { authorization: OPERATOR_TOKEN }],
    ['a lower-case scheme', { authorization: 'bearer ' + OPERATOR_TOKEN }],
  ])('%s is OPERATOR_AUTH_REQUIRED (401) on create and on every step, with 0 broker requests', async (_label, headers) => {
    const r = await runtime({ execution: true, injectSafety: true });
    const id = await createdAndApproved(r);
    expect(await call(r, 'POST', INTENTS, { body: routeIntent({ strategyRunId: 'run-x' }), auth: false, headers })).toMatchObject({ status: 401, json: { error: { code: 'OPERATOR_AUTH_REQUIRED' } } });
    for (const step of steps) {
      expect((await call(r, 'POST', INTENTS + '/' + id + '/' + step, { auth: false, headers })).status, step).toBe(401);
    }
    expect(r.broker.requests).toHaveLength(0);
    expect((await call(r, 'GET', INTENTS + '/' + id, { auth: false })).json.intent.state).toBe('APPROVED');
  });

  it('a claimed approvedBy or createdBy in the body is refused, and another name cannot override the operator', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    expect((await call(r, 'POST', INTENTS, { body: { ...routeIntent(), createdBy: { kind: 'human', id: 'someone-else' } } })).json.error.code).toBe('REQUEST_INVALID');
    expect((await call(r, 'POST', INTENTS, { body: { ...routeIntent(), approvedBy: { kind: 'human', id: 'someone-else' } } })).json.error.code).toBe('REQUEST_INVALID');
    const id = (await call(r, 'POST', INTENTS, { body: routeIntent() })).json.intent.intentId as string;
    for (const body of [{ approvedBy: { kind: 'human', id: 'someone-else' } }, { approvedBy: { kind: 'human', id: OPERATOR_ID } }, { operator: 'x' }]) {
      expect((await call(r, 'POST', INTENTS + '/' + id + '/approve', { body })).json.error.code).toBe('REQUEST_INVALID');
    }
    expect((await call(r, 'GET', INTENTS + '/' + id, { auth: false })).json.intent.state).toBe('RISK_APPROVED');
    expect((await call(r, 'POST', INTENTS + '/' + id + '/approve', { body: {} })).json.intent.approvedBy).toEqual({ kind: 'human', id: OPERATOR_ID });
  });

  it('a browser request from a foreign origin is refused before authentication; a loopback origin is allowed', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    for (const origin of ['https://evil.example', 'null', 'http://localhost.evil.example', 'file://', 'http://192.168.1.10:3000']) {
      expect((await call(r, 'POST', INTENTS, { body: routeIntent(), headers: { origin } })).json.error.code, origin).toBe('ORIGIN_REFUSED');
    }
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:5173', 'http://[::1]:8080']) {
      expect((await call(r, 'POST', INTENTS, { body: routeIntent({ strategyRunId: 'run-' + origin.length }), headers: { origin } })).status, origin).toBe(201);
    }
    expect(r.broker.requests).toHaveLength(0);
  });

  it('a body that is not declared application/json is refused (no text/plain or form request)', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/json-patch+json']) {
      expect((await call(r, 'POST', INTENTS, { raw: JSON.stringify(routeIntent()), headers: { 'content-type': type } })).json.error.code, type).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
    const id = (await call(r, 'POST', INTENTS, { body: routeIntent() })).json.intent.intentId as string;
    expect((await call(r, 'POST', INTENTS + '/' + id + '/approve', { raw: '{}', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await call(r, 'GET', INTENTS + '/' + id, { auth: false })).json.intent.state).toBe('RISK_APPROVED');
  });

  it('the operator token appears in no response and no stored record', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    const id = await createdAndApproved(r);
    await call(r, 'POST', INTENTS + '/' + id + '/execute');
    await call(r, 'POST', INTENTS + '/' + id + '/execute', { auth: false, headers: { authorization: 'Bearer ' + OPERATOR_TOKEN + 'z' } });
    const stored = JSON.stringify([r.intents?.all(), r.attempts?.all()]);
    expect(stored + texts.join('\n')).not.toContain(OPERATOR_TOKEN);
    expect(stored + texts.join('\n')).not.toContain('Bearer');
  });
});

describe('O21 runtime: strict input', () => {
  it('a malformed intent is INTENT_INVALID; invalid JSON is REQUEST_INVALID', async () => {
    const r = await runtime({ execution: true });
    expect((await call(r, 'POST', INTENTS, { body: routeIntent({ settlementType: 'cfd' }) })).json.error.code).toBe('INTENT_INVALID');
    expect((await call(r, 'POST', INTENTS, { body: routeIntent({ amount: 500 }) })).json.error.code).toBe('INTENT_INVALID');
    expect(await call(r, 'POST', INTENTS, { raw: '{not json' })).toMatchObject({ status: 400, json: { error: { code: 'REQUEST_INVALID' } } });
    expect((await call(r, 'POST', INTENTS, { body: [1] })).status).toBe(400);
    expect((await call(r, 'POST', INTENTS)).status).toBe(400);
  });

  it('a close cannot carry a position id: the field is refused', async () => {
    const r = await runtime({ execution: true });
    const { createdBy: _c, ...close } = closeInput('eint_' + 'a'.repeat(40), { positionId: 2150941015 });
    void _c;
    expect(await call(r, 'POST', INTENTS, { body: close })).toMatchObject({ status: 400, json: { error: { code: 'INTENT_INVALID' } } });
  });

  it('a malformed intent id is REQUEST_INVALID; an unknown one is INTENT_NOT_FOUND (404)', async () => {
    const r = await runtime({ execution: true });
    for (const id of ['abc', 'eint_' + 'A'.repeat(40), 'eint_' + 'a'.repeat(39), '..%2F..%2Freal']) {
      expect((await call(r, 'GET', INTENTS + '/' + id, { auth: false })).status).toBe(400);
    }
    expect(await call(r, 'GET', INTENTS + '/eint_' + 'f'.repeat(40), { auth: false })).toMatchObject({ status: 404, json: { error: { code: 'INTENT_NOT_FOUND' } } });
    expect((await call(r, 'POST', INTENTS + '/eint_' + 'f'.repeat(40) + '/execute')).status).toBe(403);
  });

  it('execute, refresh and cancel take no input: no broker payload, no order id, no position id, no query', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    const id = (await call(r, 'POST', INTENTS, { body: routeIntent() })).json.intent.intentId as string;
    expect((await call(r, 'POST', INTENTS + '/' + id + '/execute', { body: { body: { action: 'open' } } })).json.error.code).toBe('REQUEST_INVALID');
    expect((await call(r, 'POST', INTENTS + '/' + id + '/cancel', { body: { orderId: 13902598 } })).json.error.code).toBe('REQUEST_INVALID');
    expect((await call(r, 'POST', INTENTS + '/' + id + '/cancel', { body: { positionId: 2150941015 } })).json.error.code).toBe('REQUEST_INVALID');
    expect((await call(r, 'POST', INTENTS + '/' + id + '/refresh', { body: { referenceId: '00000000-0000-4000-8000-000000000000' } })).json.error.code).toBe('REQUEST_INVALID');
    expect((await call(r, 'POST', INTENTS + '/' + id + '/execute?requestId=1')).json.error.code).toBe('REQUEST_INVALID');
    expect(r.broker.requests).toHaveLength(0);
  });

  it('an invalid transition is refused (409): a rejected intent cannot be approved', async () => {
    const r = await runtime({ execution: true });
    const rejected = await call(r, 'POST', INTENTS, { body: routeIntent() });
    expect(rejected.json.intent.state).toBe('REJECTED');
    expect(await call(r, 'POST', INTENTS + '/' + rejected.json.intent.intentId + '/approve')).toMatchObject({ status: 409, json: { error: { code: 'INTENT_STATE_INVALID' } } });
  });

  it('O22 Plan B: closed-externally needs the authenticated operator and a claim without an actor; refusals carry their reasons', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    const id = (await call(r, 'POST', INTENTS, { body: routeIntent() })).json.intent.intentId as string;
    const path = INTENTS + '/' + id + '/closed-externally';
    const claim = { positionId: 2150941015, snapshotId: 'esnap_' + 'b'.repeat(40), statement: 'POSITION_CLOSED_OUTSIDE_NEXUS' };
    expect(await call(r, 'POST', path, { body: claim, auth: false })).toMatchObject({ status: 401, json: { error: { code: 'OPERATOR_AUTH_REQUIRED' } } });
    expect((await call(r, 'POST', path)).json.error.code).toBe('REQUEST_INVALID');
    expect((await call(r, 'POST', path, { body: { ...claim, attestedBy: { kind: 'human', id: 'someone-else' } } })).json.error.code).toBe('REQUEST_INVALID');
    expect(await call(r, 'POST', path, { body: { ...claim, statement: 'closed' } })).toMatchObject({ status: 409, json: { error: { code: 'EXTERNAL_CLOSURE_REFUSED', reasons: ['CLAIM_INVALID'] } } });
    // The open was never filled (and cannot be in this build): fail closed, nothing recorded, no broker request.
    expect(await call(r, 'POST', path, { body: claim })).toMatchObject({ status: 409, json: { error: { code: 'EXTERNAL_CLOSURE_REFUSED', reasons: ['OPEN_NOT_FILLED'] } } });
    expect((await call(r, 'GET', INTENTS + '/' + id, { auth: false })).json.intent.externalClosure).toBeNull();
    expect((await call(r, 'GET', path)).status).toBe(405);
    expect(r.broker.requests).toHaveLength(0);
  });

  it('O22 Plan B: without operator configuration closed-externally is refused', async () => {
    const r = await runtime({ execution: true, auth: false });
    const claim = { positionId: 2150941015, snapshotId: 'esnap_' + 'b'.repeat(40), statement: 'POSITION_CLOSED_OUTSIDE_NEXUS' };
    expect((await call(r, 'POST', INTENTS + '/eint_' + 'a'.repeat(40) + '/closed-externally', { body: claim })).json.error.code).toBe('OPERATOR_AUTH_NOT_CONFIGURED');
  });

  it('a wrong method is 405, an unknown step is 404', async () => {
    const r = await runtime({ execution: true });
    expect((await call(r, 'GET', INTENTS)).status).toBe(405);
    expect((await call(r, 'DELETE', INTENTS + '/eint_' + 'a'.repeat(40))).status).toBe(405);
    expect((await call(r, 'GET', INTENTS + '/eint_' + 'a'.repeat(40) + '/execute')).status).toBe(405);
    expect((await call(r, 'POST', INTENTS + '/eint_' + 'a'.repeat(40) + '/submit')).status).toBe(404);
    expect((await call(r, 'POST', INTENTS + '/eint_' + 'a'.repeat(40) + '/execute/again')).status).toBe(404);
  });
});

describe('O21 runtime: no real route, no generic order route', () => {
  it.each(['GET', 'POST', 'PUT', 'DELETE'])('%s on every real, order or request path is 404', async (method) => {
    const r = await runtime({ execution: true, injectSafety: true });
    for (const path of [
      '/api/broker/etoro/real',
      '/api/broker/etoro/real/intents',
      '/api/broker/etoro/real/orders',
      '/api/broker/etoro/real/intents/eint_' + 'a'.repeat(40) + '/execute',
      '/api/broker/etoro/order',
      '/api/broker/etoro/place',
      '/api/broker/etoro/request',
      '/api/broker/etoro/demo/orders',
      '/api/broker/etoro/demo/order',
      '/api/broker/etoro/demo/request',
      '/api/broker/etoro/demo/positions/1/close',
    ]) {
      expect((await call(r, method, path)).status, method + ' ' + path).toBe(404);
    }
    expect(r.broker.requests).toHaveLength(0);
  });
});

describe('O21 runtime: O20 unchanged, no ledger mutation, no secret', () => {
  it('the O20 read-only routes answer as before', async () => {
    const r = await runtime({ execution: true });
    expect((await call(r, 'GET', '/api/broker/etoro/status', { auth: false })).json.etoro).toMatchObject({ configured: true, access: 'read_only' });
    expect((await call(r, 'POST', '/api/broker/etoro/sync', { auth: false })).status).toBe(200);
    expect((await call(r, 'GET', '/api/broker/etoro/snapshot', { auth: false })).json.snapshot.content.positionCount).toBe(0);
    expect((await call(r, 'GET', '/api/broker/etoro/reconciliation', { auth: false })).json.reconciliation.matched).toBe(true);
    expect(r.readOnly.calls).toEqual(['portfolio.demo']);
    expect(r.broker.requests).toHaveLength(0);
  });

  it('the intent routes never touch the ledger', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    const before = r.ledger.head();
    const id = await createdAndApproved(r);
    await call(r, 'POST', INTENTS + '/' + id + '/execute');
    expect(r.ledger.head()).toEqual(before);
    expect(r.ledger.size).toBe(0);
  });

  it('no response of any test in this file contains a broker key, the operator token or an auth header', () => {
    const all = texts.join('\n');
    expect(texts.length).toBeGreaterThan(40);
    expect(all).not.toContain(API_KEY_MARKER);
    expect(all).not.toContain(USER_KEY_MARKER);
    expect(all).not.toContain(OPERATOR_TOKEN);
    expect(all.toLowerCase()).not.toContain('x-api-key');
    expect(all.toLowerCase()).not.toContain('x-user-key');
  });
});

describe('O21 runtime: no bypass of the service', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
    });
  const source = files('src').map((path) => ({ path: path.replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }));

  it('routes and runtime services reach neither the adapter nor the transport', () => {
    for (const file of ['src/runtime/app.ts', 'src/runtime/services.ts', 'src/runtime/errors.ts', 'src/runtime/operator-auth.ts']) {
      const text = source.find((s) => s.path === file)!.text;
      expect(text, file).not.toMatch(/etoro-demo-execution-adapter|etoro-demo-execution-transport|EToroDemoExecutionAdapter|HttpsDemoExecutionTransport/);
    }
  });

  it('only the execution layer and the composition root construct the adapter or the transport', () => {
    const allowed = new Set(['src/runtime/compose.ts', 'src/runtime/bootstrap.ts']);
    for (const { path, text } of source) {
      if (path.startsWith('src/broker/etoro/execution/') || allowed.has(path)) continue;
      expect(text, path).not.toMatch(/etoro-demo-execution-adapter|etoro-demo-execution-transport/);
    }
    expect(source.find((s) => s.path === 'src/runtime/bootstrap.ts')!.text).not.toMatch(/EToroDemoExecutionAdapter/);
  });

  it('no AI, quant, scanner, learning or pattern module imports the execution layer', () => {
    for (const { path, text } of source) {
      if (!/^src\/(ai|quant|scanner|learning|patterns|nexus|opportunities|evaluation|backtest)\//.test(path) && path !== 'src/ai-adapter.ts') continue;
      expect(text, path).not.toMatch(/broker\/etoro\/execution/);
    }
  });

  it('the entry point never injects a safety source, a quote source or a lock; no source declares a lock option', () => {
    const bootstrap = source.find((s) => s.path === 'src/runtime/bootstrap.ts')!.text;
    expect(bootstrap).not.toMatch(/safetyForTests|quotesForTests|buildLocked/);
    const compose = source.find((s) => s.path === 'src/runtime/compose.ts')!.text;
    expect(compose).not.toMatch(/buildLocked/);
    expect(compose).toMatch(/NO_DEMO_SAFETY_SOURCE/);
    for (const { path, text } of source) expect(text, path).not.toMatch(/buildLocked\?:|etoroDemoExecution\s*=\s*false|etoroDemoExecution:\s*false/);
  });
});
