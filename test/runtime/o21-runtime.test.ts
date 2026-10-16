// O21 runtime: the demo intent routes over real HTTP and the production composition (in-memory stores). Off by default; when on,
// every write is still refused by BUILD_LOCKS.etoroDemoExecution, and no broker request is made. No real route exists. Body and
// path input is validated strictly, and no secret reaches a response.
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
import { BUILD_LOCKS } from '../../src/nexus/safety.js';
import { createRuntimeHandler } from '../../src/runtime/app.js';
import { composeRuntime, type ComposeInput } from '../../src/runtime/compose.js';
import { startHttpServer, type RunningServer } from '../../src/runtime/server.js';
import { AAPL } from '../market-data/fixtures.js';
import { FixtureEtoroTransport } from '../broker/etoro/o20-fixture.js';
import { API_KEY_MARKER, ETORO_AAPL_ID, O21_NOW, ScriptedBroker, USER_KEY_MARKER, closeInput, freshQuote, normalSafety, openInput } from '../broker/etoro/o21-fixture.js';

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
}

async function runtime(options: { execution: boolean; injectSafety?: boolean }): Promise<Runtime> {
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
  let execution: ComposeInput['etoroDemoExecution'];
  if (options.execution) {
    intents = await AppendOnlyLog.inMemory<IntentEvent>('etoro-demo-execution-intents', { clock: now });
    execution = {
      transport: new HttpsDemoExecutionTransport({ credentials: { apiKey: API_KEY_MARKER, userKey: USER_KEY_MARKER }, fetch: broker.fetch }),
      intents,
      attempts: await AppendOnlyLog.inMemory<AttemptRecord>('etoro-demo-execution-attempts', { clock: now }),
      confirmations: await AppendOnlyLog.inMemory<ConfirmationRecord>('etoro-demo-broker-confirmations', { clock: now }),
      reconciliations: await AppendOnlyLog.inMemory<ReconciliationRecord>('etoro-demo-execution-reconciliations', { clock: now }),
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
  server = await startHttpServer(createRuntimeHandler(services), { host: '127.0.0.1', port: 0 });
  return { base: server.url, broker, readOnly, ledger, intents };
}

const texts: string[] = [];

async function call(r: Runtime, method: string, path: string, body?: unknown, raw?: string): Promise<{ status: number; json: Record<string, any> }> {
  const init: RequestInit = { method };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) init.body = JSON.stringify(body);
  if (init.body !== undefined) init.headers = { 'content-type': 'application/json' };
  const res = await fetch(r.base + path, init);
  const text = await res.text();
  texts.push(text);
  return { status: res.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, any>) };
}

const INTENTS = '/api/broker/etoro/demo/intents';
const HUMAN = { approvedBy: { kind: 'human', id: 'operator-1' } };

describe('O21 runtime: disabled by default', () => {
  it('without ETORO_DEMO_EXECUTION_ENABLED every intent route answers EXECUTION_DISABLED and nothing is sent', async () => {
    const r = await runtime({ execution: false });
    expect(await call(r, 'POST', INTENTS, openInput())).toMatchObject({ status: 403, json: { error: { code: 'EXECUTION_DISABLED' } } });
    const id = 'eint_' + 'a'.repeat(40);
    expect((await call(r, 'GET', INTENTS + '/' + id)).json.error.code).toBe('EXECUTION_DISABLED');
    expect((await call(r, 'POST', INTENTS + '/' + id + '/execute')).json.error.code).toBe('EXECUTION_DISABLED');
    expect(r.broker.requests).toHaveLength(0);
  });

  it('/health still reports paper and live trading locked', async () => {
    const r = await runtime({ execution: true });
    expect((await call(r, 'GET', '/health')).json).toMatchObject({
      tradingMode: 'paper',
      liveTrading: 'locked',
      buildLocks: { liveTrading: true, brokerOrders: true, physicalPurchase: true },
    });
    expect(BUILD_LOCKS.etoroDemoExecution).toBe(true);
  });
});

describe('O21 runtime: enabled, and still locked in build', () => {
  it('create, risk approval and approval work; execute and cancel are EXECUTION_LOCKED_IN_BUILD with 0 broker requests', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    expect((await call(r, 'POST', '/api/broker/etoro/sync')).status).toBe(200);
    const created = await call(r, 'POST', INTENTS, openInput());
    expect(created.status).toBe(201);
    expect(created.json.intent.state).toBe('RISK_APPROVED');
    const id = created.json.intent.intentId as string;
    const approved = await call(r, 'POST', INTENTS + '/' + id + '/approve', HUMAN);
    expect(approved.status).toBe(200);
    expect(approved.json.intent.state).toBe('APPROVED');

    const executed = await call(r, 'POST', INTENTS + '/' + id + '/execute');
    expect(executed).toMatchObject({ status: 403, json: { error: { code: 'EXECUTION_LOCKED_IN_BUILD' } } });
    const cancelled = await call(r, 'POST', INTENTS + '/' + id + '/cancel', {});
    expect(cancelled).toMatchObject({ status: 403, json: { error: { code: 'EXECUTION_LOCKED_IN_BUILD' } } });
    expect(r.broker.requests).toHaveLength(0);
    expect((await call(r, 'GET', INTENTS + '/' + id)).json.intent.state).toBe('APPROVED');
    // No SUBMITTING record was written: the lock refuses before the at-most-once step.
    expect(r.intents?.get(id + ':SUBMITTING')).toBeUndefined();
  });

  it('a refresh of an intent that was never submitted is refused without a broker request', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    const id = (await call(r, 'POST', INTENTS, openInput())).json.intent.intentId as string;
    expect((await call(r, 'POST', INTENTS + '/' + id + '/refresh')).json.error.code).toBe('INTENT_STATE_INVALID');
    expect(r.broker.requests).toHaveLength(0);
  });

  it('the production composition has no eToro demo safety source: every open is refused PORTFOLIO_SAFETY_NOT_CONNECTED', async () => {
    const r = await runtime({ execution: true });
    const created = await call(r, 'POST', INTENTS, openInput());
    expect(created.status).toBe(201);
    expect(created.json.intent.state).toBe('REJECTED');
    expect(created.json.intent.gateReasons).toContain('PORTFOLIO_SAFETY_NOT_CONNECTED');
    // No stored quote exists either: the runtime quote source reports none and does not invent one.
    expect(created.json.intent.gateReasons).toContain('QUOTE_STALE_OR_MISSING');
    expect(r.broker.requests).toHaveLength(0);
  });
});

describe('O21 runtime: strict input', () => {
  it('a malformed intent is INTENT_INVALID; invalid JSON is REQUEST_INVALID', async () => {
    const r = await runtime({ execution: true });
    expect((await call(r, 'POST', INTENTS, openInput({ settlementType: 'cfd' }))).json.error.code).toBe('INTENT_INVALID');
    expect((await call(r, 'POST', INTENTS, openInput({ amount: 500 }))).json.error.code).toBe('INTENT_INVALID');
    expect((await call(r, 'POST', INTENTS, undefined, '{not json'))).toMatchObject({ status: 400, json: { error: { code: 'REQUEST_INVALID' } } });
    expect((await call(r, 'POST', INTENTS, [1]))).toMatchObject({ status: 400 });
  });

  it('a close cannot carry a position id: the field is refused', async () => {
    const r = await runtime({ execution: true });
    const res = await call(r, 'POST', INTENTS, closeInput('eint_' + 'a'.repeat(40), { positionId: 2150941015 }));
    expect(res).toMatchObject({ status: 400, json: { error: { code: 'INTENT_INVALID' } } });
  });

  it('a malformed intent id is REQUEST_INVALID; an unknown one is INTENT_NOT_FOUND (404)', async () => {
    const r = await runtime({ execution: true });
    for (const id of ['abc', 'eint_' + 'A'.repeat(40), 'eint_' + 'a'.repeat(39), '..%2F..%2Freal']) {
      expect((await call(r, 'GET', INTENTS + '/' + id)).status).toBe(400);
    }
    expect(await call(r, 'GET', INTENTS + '/eint_' + 'f'.repeat(40))).toMatchObject({ status: 404, json: { error: { code: 'INTENT_NOT_FOUND' } } });
    expect((await call(r, 'POST', INTENTS + '/eint_' + 'f'.repeat(40) + '/execute')).status).toBe(403);
  });

  it('approve needs exactly { approvedBy: { kind: "human", id } }', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    const id = (await call(r, 'POST', INTENTS, openInput())).json.intent.intentId as string;
    for (const body of [{}, { approvedBy: { kind: 'strategy', id: 's' } }, { approvedBy: { kind: 'human' } }, { ...HUMAN, extra: 1 }, { approvedBy: { kind: 'human', id: 'x', role: 'admin' } }]) {
      expect((await call(r, 'POST', INTENTS + '/' + id + '/approve', body)).status).toBe(400);
    }
    expect((await call(r, 'GET', INTENTS + '/' + id)).json.intent.state).toBe('RISK_APPROVED');
  });

  it('execute, refresh and cancel take no input: no broker payload, no order id, no position id, no query', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    const id = (await call(r, 'POST', INTENTS, openInput())).json.intent.intentId as string;
    expect((await call(r, 'POST', INTENTS + '/' + id + '/execute', { body: { action: 'open' } })).json.error.code).toBe('REQUEST_INVALID');
    expect((await call(r, 'POST', INTENTS + '/' + id + '/cancel', { orderId: 13902598 })).json.error.code).toBe('REQUEST_INVALID');
    expect((await call(r, 'POST', INTENTS + '/' + id + '/cancel', { positionId: 2150941015 })).json.error.code).toBe('REQUEST_INVALID');
    expect((await call(r, 'POST', INTENTS + '/' + id + '/refresh', { referenceId: '00000000-0000-4000-8000-000000000000' })).json.error.code).toBe('REQUEST_INVALID');
    expect((await call(r, 'POST', INTENTS + '/' + id + '/execute?requestId=1')).json.error.code).toBe('REQUEST_INVALID');
    expect(r.broker.requests).toHaveLength(0);
  });

  it('an invalid transition is refused (409): a rejected intent cannot be approved', async () => {
    const r = await runtime({ execution: true });
    const rejected = await call(r, 'POST', INTENTS, openInput());
    expect(rejected.json.intent.state).toBe('REJECTED');
    expect(await call(r, 'POST', INTENTS + '/' + rejected.json.intent.intentId + '/approve', HUMAN)).toMatchObject({ status: 409, json: { error: { code: 'INTENT_STATE_INVALID' } } });
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
    expect((await call(r, 'GET', '/api/broker/etoro/status')).json.etoro).toMatchObject({ configured: true, access: 'read_only' });
    expect((await call(r, 'POST', '/api/broker/etoro/sync')).status).toBe(200);
    expect((await call(r, 'GET', '/api/broker/etoro/snapshot')).json.snapshot.content.positionCount).toBe(0);
    expect((await call(r, 'GET', '/api/broker/etoro/reconciliation')).json.reconciliation.matched).toBe(true);
    expect(r.readOnly.calls).toEqual(['portfolio.demo']);
    expect(r.broker.requests).toHaveLength(0);
  });

  it('the intent routes never touch the ledger', async () => {
    const r = await runtime({ execution: true, injectSafety: true });
    const before = r.ledger.head();
    const id = (await call(r, 'POST', INTENTS, openInput())).json.intent.intentId as string;
    await call(r, 'POST', INTENTS + '/' + id + '/approve', HUMAN);
    await call(r, 'POST', INTENTS + '/' + id + '/execute');
    expect(r.ledger.head()).toEqual(before);
    expect(r.ledger.size).toBe(0);
  });

  it('no response of any test in this file contains a key or an auth header', () => {
    const all = texts.join('\n');
    expect(texts.length).toBeGreaterThan(20);
    expect(all).not.toContain(API_KEY_MARKER);
    expect(all).not.toContain(USER_KEY_MARKER);
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
    for (const file of ['src/runtime/app.ts', 'src/runtime/services.ts', 'src/runtime/errors.ts']) {
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

  it('the entry point never injects a safety source, a quote source or the build lock', () => {
    const bootstrap = source.find((s) => s.path === 'src/runtime/bootstrap.ts')!.text;
    expect(bootstrap).not.toMatch(/safetyForTests|quotesForTests|buildLocked/);
    const compose = source.find((s) => s.path === 'src/runtime/compose.ts')!.text;
    expect(compose).not.toMatch(/buildLocked/);
    expect(compose).toMatch(/NO_DEMO_SAFETY_SOURCE/);
  });
});
