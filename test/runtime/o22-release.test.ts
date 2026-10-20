// O22 B1 release (draft): the real values of this build, WITHOUT any mock. The build opens BUILD_LOCKS.etoroDemoExecution for the one
// controlled eToro demo cycle and nothing else: live trading, broker orders and physical purchases stay locked, the runtime still
// needs ETORO_DEMO_EXECUTION_ENABLED=1 (default off) and the demo mode, a real environment is still refused, and the cycle budget
// still allows exactly one open and one close. Test data only: scripted broker answers (no network), placeholder keys.
import { describe, expect, it } from 'vitest';
import { BUILD_LOCKS } from '../../src/nexus/safety.js';
import { loadRuntimeConfig, RuntimeConfigError } from '../../src/runtime/config.js';
import { DEMO_E2E_CYCLE_POLICY } from '../../src/broker/etoro/execution/execution-gate.js';
import { CREATOR, HUMAN, ETORO_AAPL_ID, closeInput, lookupAnswer, o21Fixture, openInput, orderAccepted } from '../broker/etoro/o21-fixture.js';

const BASE = { DATABASE_URL: 'postgres://nexus:pw-o22-release-hidden@127.0.0.1:5432/nexus' };
const ETORO = { ETORO_ENABLED: '1', ETORO_TRADING_MODE: 'demo', ETORO_API_KEY: 'O22-RELEASE-API-KEY', ETORO_USER_KEY: 'O22-RELEASE-USER-KEY' };
const POSITION = 2150941015;

function refusal(env: Record<string, string>): RuntimeConfigError {
  try {
    loadRuntimeConfig({ ...BASE, ...env });
  } catch (error) {
    if (error instanceof RuntimeConfigError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('O22 B1 release: the locks of this build (no mock)', () => {
  it('only the demo execution lock is open; live trading, broker orders and physical purchases stay locked; the constant is frozen', () => {
    expect(BUILD_LOCKS).toEqual({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: false });
    expect(Object.isFrozen(BUILD_LOCKS)).toBe(true);
    expect(() => {
      (BUILD_LOCKS as { liveTrading: boolean }).liveTrading = false;
    }).toThrow();
    expect(BUILD_LOCKS.liveTrading).toBe(true);
  });

  it('the configuration still refuses live trading and a real eToro environment, and execution stays off unless enabled', () => {
    expect(refusal({ TRADING_MODE: 'live' }).code).toBe('LIVE_TRADING_REFUSED');
    expect(refusal({ ALLOW_LIVE_TRADING: 'true' }).code).toBe('LIVE_TRADING_REFUSED');
    expect(refusal({ ...ETORO, ETORO_TRADING_MODE: 'real' }).code).toBe('LIVE_TRADING_REFUSED');
    expect(refusal({ ...ETORO, ETORO_ENABLED: '0', ETORO_DEMO_EXECUTION_ENABLED: '1' }).code).toBe('CONFIG_INVALID');
    expect(loadRuntimeConfig({ ...BASE, ...ETORO }).etoroDemoExecution.enabled).toBe(false);
    expect(loadRuntimeConfig({ ...BASE, ...ETORO, ETORO_DEMO_EXECUTION_ENABLED: '0' }).etoroDemoExecution.enabled).toBe(false);
  });
});

describe('O22 B1 release: the service with the real lock (no mock)', () => {
  it('with execution not enabled, execute is EXECUTION_DISABLED and nothing is sent', async () => {
    const f = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, executionEnabled: false });
    const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
    await f.service.approve(created.intentId, HUMAN);
    await expect(f.service.execute(created.intentId, HUMAN)).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    expect(f.broker.requests).toEqual([]);
  });

  it('enabled: exactly one open and one close go out; the cycle budget then refuses every further write', async () => {
    const f = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY });
    const open = await f.service.create(openInput({ amount: '100' }), CREATOR);
    expect(open.state).toBe('RISK_APPROVED');
    await f.service.approve(open.intentId, HUMAN);
    f.broker.next(orderAccepted());
    expect((await f.service.execute(open.intentId, HUMAN)).state).toBe('SUBMITTED');
    f.broker.next(lookupAnswer(3, { positionIds: [POSITION] }));
    expect((await f.service.refresh(open.intentId)).state).toBe('FILLED');
    const second = await f.service.create(openInput({ amount: '100', strategyRunId: 'run-release-second', createdAt: '2026-10-16T13:59:40.000Z' }), CREATOR);
    expect(second.gateReasons).toContain('CYCLE_OPEN_BUDGET_EXHAUSTED');

    const close = await f.service.create(closeInput(open.intentId), CREATOR);
    await f.service.approve(close.intentId, HUMAN);
    f.broker.next({ status: 200, body: { orderForClose: { positionID: POSITION, instrumentID: ETORO_AAPL_ID, orderID: 13904638, statusID: 1 } } });
    expect((await f.service.execute(close.intentId, HUMAN)).state).toBe('SUBMITTED');
    const secondClose = await f.service.create(closeInput(open.intentId, { strategyRunId: 'run-release-close-2' }), CREATOR);
    expect(secondClose.gateReasons).toContain('CYCLE_CLOSE_BUDGET_EXHAUSTED');

    expect(f.broker.writes.map((w) => w.method + ' ' + w.url)).toEqual([
      'POST https://public-api.etoro.com/api/v2/trading/execution/demo/orders',
      'POST https://public-api.etoro.com/api/v1/trading/execution/demo/market-close-orders/positions/' + POSITION,
    ]);
    expect(f.broker.writes.every((w) => w.url.includes('/demo/'))).toBe(true);
    expect(await f.service.cycleBudget()).toMatchObject({ openSubmissions: 1, closeSubmissions: 1, maxOpenSubmissions: 1, maxCloseSubmissions: 1 });
  });
});
