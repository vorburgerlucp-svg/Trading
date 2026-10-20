// O22 runtime: the production composition (in-memory stores) runs the demo cycle policy; GET /api/broker/etoro/demo/cycle reports
// the budget, the cycle reconciliation and the safety readiness without any broker request; and, with no mock, the build is still
// locked: no demo write is possible, the budget is not touched by a refused execute, and every lock stays closed.
import { afterEach, describe, expect, it } from 'vitest';
import { CapitalLedger } from '../../src/capital/capital-ledger.js';
import { InstrumentRegistry, type InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import { InMemoryMarketDataStore } from '../../src/market-data/market-data-store.js';
import { InMemoryQuantRunStore } from '../../src/quant/quant-run-store.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore } from '../../src/persistence/append-only-log.js';
import type { KillSwitchState } from '../../src/safety/portfolio-safety-envelope.js';
import type { EtoroReconciliationRecord, EtoroSnapshotRecord, EtoroSyncRecord } from '../../src/broker/etoro/etoro-broker-service.js';
import { HttpsDemoExecutionTransport } from '../../src/broker/etoro/execution/etoro-demo-execution-transport.js';
import { DEMO_E2E_CYCLE_POLICY_VERSION } from '../../src/broker/etoro/execution/execution-gate.js';
import type { AttemptRecord, ConfirmationRecord, IntentEvent, ReconciliationRecord } from '../../src/broker/etoro/execution/etoro-demo-execution-service.js';
import type { DemoAccountValuationRecord } from '../../src/broker/etoro/execution/demo-account-safety.js';
import { BUILD_LOCKS, loadSafetyConfig } from '../../src/nexus/safety.js';
import { createRuntimeHandler } from '../../src/runtime/app.js';
import { composeRuntime, type ComposeInput } from '../../src/runtime/compose.js';
import { OperatorAuthenticator } from '../../src/runtime/operator-auth.js';
import { startHttpServer, type RunningServer } from '../../src/runtime/server.js';
import { AAPL } from '../market-data/fixtures.js';
import { FixtureEtoroTransport } from '../broker/etoro/o20-fixture.js';
import { documentedPortfolio } from '../broker/etoro/o21a-documented-fixture.js';
import { schemaPnl, schemaPnlPosition } from '../broker/etoro/o21a1-pnl-fixture.js';
import { API_KEY_MARKER, ETORO_AAPL_ID, O21_NOW, ScriptedBroker, USER_KEY_MARKER, freshQuote, normalSafety, openInput } from '../broker/etoro/o21-fixture.js';

const TOKEN = 'O22-OPERATOR-TOKEN-MARKER-0123456789abcdef';
const AUTH = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
let server: RunningServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function runtime(execution: boolean, options: { injectSafety?: boolean } = {}) {
  const injectSafety = options.injectSafety ?? true;
  const now = () => new Date(O21_NOW);
  const instruments = new InMemoryAppendOnlyStore<InstrumentEvent>();
  const registry = await InstrumentRegistry.open(instruments, { clock: now });
  const change = { at: '2026-10-01T00:00:00.000Z', by: { kind: 'human' as const, id: 'mapping-owner' }, reason: 'O22 runtime test: governed eToro mapping' };
  await registry.register({ ...AAPL }, change);
  await registry.addMapping({ instrumentId: AAPL.instrumentId, provider: 'etoro', providerSymbol: String(ETORO_AAPL_ID), validFrom: '2026-10-01T00:00:00.000Z' }, change);
  const readOnly = new FixtureEtoroTransport();
  const broker = new ScriptedBroker();
  const etoro: NonNullable<ComposeInput['etoro']> = {
    transport: readOnly,
    ledger: await CapitalLedger.inMemory(),
    snapshots: await AppendOnlyLog.inMemory<EtoroSnapshotRecord>('etoro-snapshots', { clock: now }),
    reconciliations: await AppendOnlyLog.inMemory<EtoroReconciliationRecord>('etoro-reconciliations', { clock: now }),
    syncs: await AppendOnlyLog.inMemory<EtoroSyncRecord>('etoro-sync-events', { clock: now }),
  };
  const intents = await AppendOnlyLog.inMemory<IntentEvent>('etoro-demo-execution-intents', { clock: now });
  const services = await composeRuntime({
    instruments,
    marketData: new InMemoryMarketDataStore(),
    quantRuns: new InMemoryQuantRunStore(),
    killSwitch: new InMemoryAppendOnlyStore<KillSwitchState>(),
    provider: null,
    marketDataMode: 'not_configured',
    ping: async () => true,
    version: 'o22-test',
    clock: now,
    etoro,
    ...(execution
      ? {
          etoroDemoExecution: {
            transport: new HttpsDemoExecutionTransport({ credentials: { apiKey: API_KEY_MARKER, userKey: USER_KEY_MARKER }, fetch: broker.fetch }),
            intents,
            attempts: await AppendOnlyLog.inMemory<AttemptRecord>('etoro-demo-execution-attempts', { clock: now }),
            confirmations: await AppendOnlyLog.inMemory<ConfirmationRecord>('etoro-demo-broker-confirmations', { clock: now }),
            reconciliations: await AppendOnlyLog.inMemory<ReconciliationRecord>('etoro-demo-execution-reconciliations', { clock: now }),
            accountValuations: await AppendOnlyLog.inMemory<DemoAccountValuationRecord>('etoro-demo-account-valuations', { clock: now }),
            // TESTS ONLY (the entry point never passes them): a quote, and unless the test wants the real demo account source, a
            // safety decision, so the gate can approve at creation.
            ...(injectSafety ? { safetyForTests: { current: async () => normalSafety() } } : {}),
            quotesForTests: { latest: async () => freshQuote() },
          },
        }
      : {}),
  });
  server = await startHttpServer(createRuntimeHandler(services, { operatorAuth: new OperatorAuthenticator({ id: 'operator-o22', token: TOKEN }) }), { host: '127.0.0.1', port: 0 });
  const base = server.url;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: AUTH, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, any>) };
  };
  return { call, broker, readOnly, intents };
}

describe('O22 runtime: GET /api/broker/etoro/demo/cycle', () => {
  it('reports the cycle policy budget, an unknown reconciliation without a snapshot, and the wired safety source not yet evaluated; no broker request', async () => {
    const r = await runtime(true);
    const res = await r.call('GET', '/api/broker/etoro/demo/cycle');
    expect(res.status).toBe(200);
    expect(res.json.cycle.execution).toBe('enabled');
    expect(res.json.cycle.buildLocked).toBe(true);
    expect(res.json.cycle.budget).toEqual({ policyVersion: DEMO_E2E_CYCLE_POLICY_VERSION, maxOpenSubmissions: 1, maxCloseSubmissions: 1, openSubmissions: 0, closeSubmissions: 0 });
    expect(res.json.cycle.reconciliation.verdict).toBe('unknown');
    expect(res.json.cycle.reconciliation.reasons).toContain('SNAPSHOT_MISSING');
    expect(res.json.cycle.safetyReadiness.connected).toBe(true);
    expect(res.json.cycle.safetyReadiness.lastDecisionState).toBeNull();
    // O22 C1: the test verdict is separate from the reconciliation verdict; with nothing submitted it is incomplete, never passed.
    expect(res.json.cycle.test).toMatchObject({ schema: 'etoro-demo-cycle-test-verdict:v2', result: 'incomplete', failures: [], pending: ['NO_OPEN_SUBMITTED'] });
    expect(r.readOnly.calls).toEqual([]);
    expect(r.broker.requests).toEqual([]);
  });

  it('production wiring with recorded evidence: creating an open reads /demo/pnl once; the hand-opened position blocks it; still locked, 0 writes', async () => {
    const r = await runtime(true, { injectSafety: false });
    r.readOnly.response = { status: 200, body: schemaPnl({ positions: [schemaPnlPosition({ instrumentID: 100001, unrealizedPnL: { pnL: -1 } })] }) };
    const { createdBy: _ignored, ...intent } = openInput({ amount: '100' });
    void _ignored;
    const created = await r.call('POST', '/api/broker/etoro/demo/intents', intent);
    expect(created.json.intent.state).toBe('REJECTED');
    expect(created.json.intent.gateReasons).toEqual(expect.arrayContaining(['PORTFOLIO_SAFETY_BLOCKS_RISK_INCREASE', 'DRAWDOWN_OR_CAPACITY_LIMIT']));
    expect(r.readOnly.calls).toEqual(['pnl.demo']);
    const cycle = await r.call('GET', '/api/broker/etoro/demo/cycle');
    expect(cycle.json.cycle.safetyReadiness.connected).toBe(true);
    expect(cycle.json.cycle.safetyReadiness.lastDecisionState).toBe('CAPACITY_BLOCK');
    expect(cycle.json.cycle.safetyReadiness.reasons).toEqual(['ACCOUNT_EXPOSURE_LIMIT', 'ACCOUNT_POSITION_LIMIT']);
    expect(r.readOnly.calls).toEqual(['pnl.demo']);
    expect(r.broker.requests).toEqual([]);
  });

  it('production wiring, empty demo account: the open is risk-approved, and execute is still EXECUTION_LOCKED_IN_BUILD before any read or write', async () => {
    const r = await runtime(true, { injectSafety: false });
    r.readOnly.response = { status: 200, body: schemaPnl() };
    const { createdBy: _ignored, ...intent } = openInput({ amount: '100' });
    void _ignored;
    const created = await r.call('POST', '/api/broker/etoro/demo/intents', intent);
    expect(created.json.intent.state, JSON.stringify(created.json.intent.gateReasons)).toBe('RISK_APPROVED');
    const id = created.json.intent.intentId as string;
    await r.call('POST', '/api/broker/etoro/demo/intents/' + id + '/approve', {});
    const executed = await r.call('POST', '/api/broker/etoro/demo/intents/' + id + '/execute', {});
    expect(executed.json.error.code).toBe('EXECUTION_LOCKED_IN_BUILD');
    expect(r.readOnly.calls).toEqual(['pnl.demo']);
    expect(r.broker.requests).toEqual([]);
  });

  it('after a read-only sync, a position NEXUS did not open is reported as external; the route itself sends nothing', async () => {
    const r = await runtime(true);
    r.readOnly.response = { status: 200, body: documentedPortfolio({ orders: [] }) };
    expect((await r.call('POST', '/api/broker/etoro/sync')).status).toBe(200);
    const res = await r.call('GET', '/api/broker/etoro/demo/cycle');
    expect(res.json.cycle.reconciliation.externalPositions).toHaveLength(1);
    expect(res.json.cycle.reconciliation.reasons).toContain('EXTERNAL_POSITIONS_PRESENT');
    expect(res.json.cycle.safetyReadiness.connected).toBe(true);
    expect(r.readOnly.calls).toEqual(['portfolio.demo']);
    expect(r.broker.requests).toEqual([]);
  });

  it('with execution disabled the route still answers, with no budget and no reconciliation', async () => {
    const r = await runtime(false);
    const res = await r.call('GET', '/api/broker/etoro/demo/cycle');
    expect(res.status).toBe(200);
    expect(res.json.cycle).toMatchObject({ execution: 'disabled', buildLocked: true, budget: null, reconciliation: null, test: null });
  });

  it('is GET only and takes no query', async () => {
    const r = await runtime(true);
    expect((await r.call('POST', '/api/broker/etoro/demo/cycle')).status).toBe(405);
    expect((await r.call('GET', '/api/broker/etoro/demo/cycle?force=1')).status).toBe(400);
  });
});

describe('O22 runtime: still locked in this build (no mock)', () => {
  it('a 100 USD cycle open is risk-approved under the cycle policy, approved by the operator, and execute is refused with 0 writes; the budget is untouched', async () => {
    const r = await runtime(true);
    const { createdBy: _ignored, ...intent } = openInput({ amount: '100' });
    void _ignored;
    const created = await r.call('POST', '/api/broker/etoro/demo/intents', intent);
    expect(created.json.intent.state).toBe('RISK_APPROVED');
    const id = created.json.intent.intentId as string;
    expect((await r.call('POST', '/api/broker/etoro/demo/intents/' + id + '/approve', {})).json.intent.state).toBe('APPROVED');
    const executed = await r.call('POST', '/api/broker/etoro/demo/intents/' + id + '/execute', {});
    expect(executed.status).toBe(403);
    expect(executed.json.error.code).toBe('EXECUTION_LOCKED_IN_BUILD');
    expect(r.broker.requests).toEqual([]);
    expect(r.intents.all().some((rec) => rec.payload.state === 'SUBMITTING')).toBe(false);
    expect((await r.call('GET', '/api/broker/etoro/demo/cycle')).json.cycle.budget.openSubmissions).toBe(0);
  });

  it('an open above the cycle limit is rejected at creation', async () => {
    const r = await runtime(true);
    const { createdBy: _ignored, ...intent } = openInput({ amount: '500' });
    void _ignored;
    const created = await r.call('POST', '/api/broker/etoro/demo/intents', intent);
    expect(created.json.intent.state).toBe('REJECTED');
    expect(created.json.intent.gateReasons).toContain('ORDER_SIZE_ABOVE_LIMIT');
  });

  it('every build lock is closed and live trading stays off whatever the environment says', async () => {
    expect(BUILD_LOCKS).toEqual({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: true });
    expect(loadSafetyConfig({}).allowLiveTrading).toBe(false);
    const r = await runtime(true);
    const health = await r.call('GET', '/api/health');
    expect(health.json.buildLocks).toEqual({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: true });
    expect(health.json.tradingMode).toBe('paper');
    for (const path of ['/api/broker/etoro/real/intents', '/api/broker/etoro/real/orders']) {
      for (const method of ['GET', 'POST']) expect((await r.call(method, path, method === 'POST' ? {} : undefined)).status).toBe(404);
    }
  });
});
