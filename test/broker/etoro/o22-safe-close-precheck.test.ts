// O22 C2 and C3 through the real execution service, with the C1 test verdict over the stored state it leaves.
//   C2: a close reads no account safety decision (no /demo/pnl request, no valuation record), and no protection of the close changes.
//   C3: the request is built and checked before the reservation: a request that could never be sent is refused without SUBMITTING
//       and without spending the budget; from SUBMITTING on the budget stays spent and nothing is resent.
// No network: scripted broker answers (TEST DOUBLES shaped after the reference); pnl bodies are REFERENCE_SCHEMA test data.
import { describe, expect, it, vi } from 'vitest';

// TEST ONLY, for this module: the compile-time lock is opened to exercise the write path (it stays closed in the build).
vi.mock('../../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});
import { DEMO_E2E_CYCLE_POLICY } from '../../../src/broker/etoro/execution/execution-gate.js';
import { evaluateDemoCycleTest } from '../../../src/broker/etoro/execution/demo-cycle-test-verdict.js';
import type { DemoSafetySource } from '../../../src/broker/etoro/execution/etoro-demo-execution-service.js';
import type { DemoCycleSnapshot } from '../../../src/broker/etoro/execution/demo-cycle-test-verdict.js';
import { CREATOR, ETORO_AAPL_ID, HUMAN, ScriptedBroker, closeInput, inMemoryStores, lookupAnswer, normalSafety, o21Fixture, openInput, orderAccepted, type Fixture } from './o21-fixture.js';

const POSITION = 2150941015;
const CLOSE_ANSWER = { status: 200, body: { orderForClose: { positionID: POSITION, instrumentID: ETORO_AAPL_ID, orderID: 13904638, statusID: 1 } } };
const CLOSE_FILLED = { status: 200, body: { orderID: 13904638, statusID: 3, instrumentID: ETORO_AAPL_ID, positions: [{ positionID: POSITION }] } };

/** A safety source that counts its reads and can be made to throw (e.g. a database error while recording the valuation). */
function countingSource() {
  const state = { calls: 0, fail: false };
  const source: DemoSafetySource = {
    current: async (now) => {
      state.calls += 1;
      if (state.fail) throw new Error('valuation log unavailable');
      return normalSafety(now);
    },
  };
  return { state, source };
}

async function filledOpen(f: Fixture, settlementType: string | null = 'real'): Promise<string> {
  const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
  expect(created.state).toBe('RISK_APPROVED');
  await f.service.approve(created.intentId, HUMAN);
  f.broker.next(orderAccepted());
  expect((await f.service.execute(created.intentId, HUMAN)).state).toBe('SUBMITTED');
  f.broker.next(lookupAnswer(3, { positionIds: [POSITION], settlementType }));
  expect((await f.service.refresh(created.intentId)).state).toBe('FILLED');
  return created.intentId;
}

let sequence = 0;
/** A stored observation, stored one second after it was taken. */
function snapshot(observedAt: string, positionIds: number[]): DemoCycleSnapshot {
  sequence += 1;
  return {
    snapshotId: 'esnap_' + observedAt,
    observedAt,
    retrievedAt: observedAt,
    storedAt: new Date(Date.parse(observedAt) + 1000).toISOString(),
    sequence,
    content: { positions: positionIds.map((positionId) => ({ positionId, etoroInstrumentId: ETORO_AAPL_ID, direction: 'buy', units: '1', instrumentId: null })) },
  } as unknown as DemoCycleSnapshot;
}

describe('O22 C2: a close reads no account safety decision', () => {
  it('the open reads the account at create and at execute; the close reads it never, and still goes out exactly once', async () => {
    const { state, source } = countingSource();
    const f = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, safetySource: source });
    const openId = await filledOpen(f);
    expect(state.calls).toBe(2);
    const close = await f.service.create(closeInput(openId), CREATOR);
    expect(close.state).toBe('RISK_APPROVED');
    await f.service.approve(close.intentId, HUMAN);
    f.broker.next(CLOSE_ANSWER);
    expect((await f.service.execute(close.intentId, HUMAN)).state).toBe('SUBMITTED');
    expect(state.calls).toBe(2);
    expect(f.broker.writes).toHaveLength(2);
  });

  it('a failing account source blocks the open (nothing sent) but not the close of the known position', async () => {
    const { state, source } = countingSource();
    const f = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, safetySource: source });
    const openId = await filledOpen(f);
    state.fail = true;
    const close = await f.service.create(closeInput(openId), CREATOR);
    await f.service.approve(close.intentId, HUMAN);
    f.broker.next(CLOSE_ANSWER);
    expect((await f.service.execute(close.intentId, HUMAN)).state).toBe('SUBMITTED');
    const g = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, safetySource: source });
    await expect(g.service.create(openInput({ amount: '100' }), CREATOR)).rejects.toThrow('valuation log unavailable');
    expect(g.broker.writes).toEqual([]);
  });

  it('the protections of the close are unchanged: no close of an unknown target, no second close, the budget holds', async () => {
    const { source } = countingSource();
    const f = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, safetySource: source });
    // Unknown target: a close of an open that was never filled is refused at creation.
    const pending = await f.service.create(openInput({ amount: '100', strategyRunId: 'run-pending' }), CREATOR);
    await expect(f.service.create(closeInput(pending.intentId), CREATOR)).rejects.toMatchObject({ code: 'INTENT_INVALID' });
    await f.service.withdraw(pending.intentId);
    const openId = await filledOpen(f);
    const close = await f.service.create(closeInput(openId), CREATOR);
    await f.service.approve(close.intentId, HUMAN);
    f.broker.next({ throws: 'timeout' });
    expect((await f.service.execute(close.intentId, HUMAN)).state).toBe('AMBIGUOUS');
    const again = await f.service.create(closeInput(openId, { strategyRunId: 'run-close-2' }), CREATOR);
    expect(again.gateReasons).toEqual(expect.arrayContaining(['CLOSE_TARGET_ALREADY_CLOSING', 'CYCLE_CLOSE_BUDGET_EXHAUSTED']));
    expect(f.broker.writes).toHaveLength(2);
  });
});

describe('O22 C3: the request is built and checked before the reservation', () => {
  it('a request that could never be sent is refused before SUBMITTING: nothing sent, intent stays APPROVED, budget not spent', async () => {
    const f = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, requestId: () => 'not-a-uuid' });
    const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
    await f.service.approve(created.intentId, HUMAN);
    await expect(f.service.execute(created.intentId, HUMAN)).rejects.toMatchObject({ code: 'GATE_REFUSED', reasons: ['REQUEST_NOT_SENDABLE'] });
    expect(f.broker.requests).toEqual([]);
    expect((await f.service.get(created.intentId)).state).toBe('APPROVED');
    expect((await f.service.cycleBudget()).openSubmissions).toBe(0);
    const refusals = f.attempts.all().map((r) => r.payload).filter((a) => a.intentId === created.intentId);
    expect(refusals).toEqual([expect.objectContaining({ operation: 'gate', phase: 'refused', requestId: null, outcome: 'gate_refused', reasons: ['REQUEST_NOT_SENDABLE'] })]);
  });

  it('restart: another process on the same stores, with a sendable request, then writes exactly once and spends the budget', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const a = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, stores, sharedBroker: broker, requestId: () => 'not-a-uuid' });
    const created = await a.service.create(openInput({ amount: '100' }), CREATOR);
    await a.service.approve(created.intentId, HUMAN);
    await expect(a.service.execute(created.intentId, HUMAN)).rejects.toMatchObject({ code: 'GATE_REFUSED' });
    const b = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, stores, sharedBroker: broker });
    broker.next(orderAccepted());
    expect((await b.service.execute(created.intentId, HUMAN)).state).toBe('SUBMITTED');
    expect(broker.writes).toHaveLength(1);
    expect((await b.service.cycleBudget()).openSubmissions).toBe(1);
    // From SUBMITTING on, nothing is resent: a second execute of the same intent is refused in either process.
    await expect(b.service.execute(created.intentId, HUMAN)).rejects.toMatchObject({ code: 'INTENT_STATE_INVALID' });
    await expect(a.service.execute(created.intentId, HUMAN)).rejects.toMatchObject({ code: 'INTENT_STATE_INVALID' });
    expect(broker.writes).toHaveLength(1);
  });

  it('parallel: a refused and a sendable execute of the same intent at once give exactly one write', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const bad = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, stores, sharedBroker: broker, requestId: () => 'not-a-uuid' });
    const good = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, stores, sharedBroker: broker });
    const created = await good.service.create(openInput({ amount: '100' }), CREATOR);
    await good.service.approve(created.intentId, HUMAN);
    broker.next(orderAccepted());
    const results = await Promise.allSettled([bad.service.execute(created.intentId, HUMAN), good.service.execute(created.intentId, HUMAN), good.service.execute(created.intentId, HUMAN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(broker.writes).toHaveLength(1);
    expect((await good.service.cycleBudget()).openSubmissions).toBe(1);
  });

  it('an unclear send after SUBMITTING stays AMBIGUOUS, keeps the budget spent and is never resent', async () => {
    const f = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY });
    const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
    await f.service.approve(created.intentId, HUMAN);
    f.broker.next({ throws: 'timeout' });
    expect((await f.service.execute(created.intentId, HUMAN)).state).toBe('AMBIGUOUS');
    expect((await f.service.cycleBudget()).openSubmissions).toBe(1);
    await expect(f.service.execute(created.intentId, HUMAN)).rejects.toMatchObject({ code: 'INTENT_STATE_INVALID' });
    const second = await f.service.create(openInput({ amount: '100', strategyRunId: 'run-second' }), CREATOR);
    expect(second.gateReasons).toEqual(expect.arrayContaining(['CYCLE_OPEN_BUDGET_EXHAUSTED']));
    expect(f.broker.writes).toHaveLength(1);
  });
});

describe('O22 C1 over the state the real service stores (and after a restart)', () => {
  it('a full cycle with product type real is passed; a new process on the same stores reaches the same verdict', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const f = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, stores, sharedBroker: broker });
    const openId = await filledOpen(f);
    const filledAt = f.clock.now.toISOString();
    f.advance(30_000);
    const seen = snapshot(f.clock.now.toISOString(), [POSITION]);
    f.advance(30_000);
    const close = await f.service.create(closeInput(openId, { createdAt: f.clock.now.toISOString(), expiresAt: new Date(f.clock.now.getTime() + 600_000).toISOString() }), CREATOR);
    await f.service.approve(close.intentId, HUMAN);
    broker.next(CLOSE_ANSWER);
    expect((await f.service.execute(close.intentId, HUMAN)).state).toBe('SUBMITTED');
    broker.next(CLOSE_FILLED);
    expect((await f.service.refresh(close.intentId)).state).toBe('FILLED');
    const intents = await f.service.list();
    // Before a snapshot after the close: incomplete, never passed.
    expect(evaluateDemoCycleTest({ intents, snapshots: [seen] })).toMatchObject({ result: 'incomplete', pending: ['FINAL_SNAPSHOT_MISSING'] });
    f.advance(30_000);
    const final = snapshot(f.clock.now.toISOString(), []);
    const verdict = evaluateDemoCycleTest({ intents, snapshots: [seen, final] });
    expect(filledAt < seen.observedAt).toBe(true);
    expect(verdict).toMatchObject({ result: 'passed', failures: [], pending: [], positionId: POSITION, settlementType: 'real' });
    const restarted = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, stores, sharedBroker: broker });
    expect(evaluateDemoCycleTest({ intents: await restarted.service.list(), snapshots: [seen, final] })).toEqual(verdict);
  });

  it('product type cfd from the real order status: failed before the close and still failed after it, in a restarted process', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const f = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, stores, sharedBroker: broker });
    const openId = await filledOpen(f, 'cfd');
    f.advance(30_000);
    const seen = snapshot(f.clock.now.toISOString(), [POSITION]);
    expect(evaluateDemoCycleTest({ intents: await f.service.list(), snapshots: [seen] })).toMatchObject({ result: 'failed', failures: ['SETTLEMENT_TYPE_NOT_REAL'], settlementType: 'cfd' });
    // The securely bound position is still closed through the regular flow.
    const close = await f.service.create(closeInput(openId), CREATOR);
    expect(close.state).toBe('RISK_APPROVED');
    await f.service.approve(close.intentId, HUMAN);
    broker.next(CLOSE_ANSWER);
    expect((await f.service.execute(close.intentId, HUMAN)).state).toBe('SUBMITTED');
    const restarted = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, stores, sharedBroker: broker });
    f.advance(60_000);
    const after = evaluateDemoCycleTest({ intents: await restarted.service.list(), snapshots: [seen, snapshot(f.clock.now.toISOString(), [])] });
    expect(after.result).toBe('failed');
    expect(after.failures).toContain('SETTLEMENT_TYPE_NOT_REAL');
    expect(after.settlementType).toBe('cfd');
  });

  it('a product type the broker does not state fails as SETTLEMENT_TYPE_MISSING', async () => {
    const f = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY });
    await filledOpen(f, null);
    expect(evaluateDemoCycleTest({ intents: await f.service.list(), snapshots: [] }).failures).toContain('SETTLEMENT_TYPE_MISSING');
  });
});
