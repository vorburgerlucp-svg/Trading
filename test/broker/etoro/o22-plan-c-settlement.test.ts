// O22 Plan C review of PR #35, R5: a cycle may be reported CLOSED only when it is settled: no write in flight, no broker order still
// open or unresolved, and no position of it still open by NEXUS's records. Stopping new activity (CLOSING) is separate from that.
// R6: cancel of a pending order while the cycle is CLOSING or CLOSED. No network: scripted broker answers.
import { describe, expect, it, vi } from 'vitest';

// TEST ONLY: this module exercises the write path, so it replaces the compile-time lock for this module only.
vi.mock('../../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});
import { InMemoryAppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import { CYCLE_ACTIVATION_STATEMENT, policyHashOf, type DemoCycleRecord } from '../../../src/broker/etoro/execution/demo-cycles.js';
import { DEFAULT_DEMO_EXECUTION_POLICY, type DemoExecutionPolicy } from '../../../src/broker/etoro/execution/execution-gate.js';
import { CREATOR, ETORO_AAPL_ID, HUMAN, approvedOpen, closeInput, filledOpen, inMemoryStores, lookupAnswer, o21Fixture, orderAccepted, type Fixture } from './o21-fixture.js';
import { FaultStore, InjectedCrash } from './o22-fault-store.js';
import type { AttemptRecord } from '../../../src/broker/etoro/execution/etoro-demo-execution-service.js';

const HOUR = 60 * 60 * 1000;
const policy: DemoExecutionPolicy = Object.freeze({ ...DEFAULT_DEMO_EXECUTION_POLICY, version: 'etoro-demo-cycle-policy:settle-1' as const, maxOpenSubmissions: 1, maxCloseSubmissions: 1 });
const closeSubmitted = { status: 200, body: { orderForClose: { positionID: 2150941015, instrumentID: ETORO_AAPL_ID, orderID: 13904638, statusID: 1 }, token: '5fe065bc-f6f9-4897-a2ce-c4fccef73ff8' } };
const closeFilled = { status: 200, body: { orderID: 13904638, CID: 1, statusID: 3, orderType: 19, instrumentID: ETORO_AAPL_ID, positions: [{ positionID: 2150941015 }] } };

async function activeCycle(stores = inMemoryStores(), cycles = new InMemoryAppendOnlyStore<DemoCycleRecord>()): Promise<Fixture> {
  const f = await o21Fixture({ stores, cycles });
  await f.service.defineCycle({ cycleId: 'cycle-1', policy, maxActiveMs: HOUR }, HUMAN);
  await f.service.activateCycle('cycle-1', { policyHash: policyHashOf(policy), statement: CYCLE_ACTIVATION_STATEMENT }, HUMAN);
  return f;
}

describe('R5: CLOSED only when the cycle is settled', () => {
  it('an open whose order is SUBMITTED (no status read yet): the cycle stays CLOSING', async () => {
    const f = await activeCycle();
    const id = await approvedOpen(f);
    f.broker.next(orderAccepted());
    expect((await f.service.execute(id, HUMAN)).state).toBe('SUBMITTED');
    expect((await f.service.closeCycle('cycle-1', HUMAN)).status).toBe('closing');
  });

  it('an open order still pending at the broker (ACCEPTED): the cycle stays CLOSING', async () => {
    const f = await activeCycle();
    const id = await approvedOpen(f, { orderType: 'mit', triggerRate: '195' });
    f.broker.next(orderAccepted(), lookupAnswer(12));
    await f.service.execute(id, HUMAN);
    expect((await f.service.refresh(id)).state).toBe('ACCEPTED');
    expect((await f.service.closeCycle('cycle-1', HUMAN)).status).toBe('closing');
  });

  it('a PARTIALLY_FILLED open (not final): an unresolved order, the cycle stays CLOSING', async () => {
    const f = await activeCycle();
    const id = await approvedOpen(f);
    f.broker.next(orderAccepted(), lookupAnswer(5, { positionIds: [2150941015] }));
    await f.service.execute(id, HUMAN);
    expect((await f.service.refresh(id)).state).toBe('PARTIALLY_FILLED');
    expect(await f.service.closeCycle('cycle-1', HUMAN)).toMatchObject({ status: 'closing', settlement: { writesInFlight: 0, ordersUnresolved: 1, positionsOpen: 0 } });
  });

  it('an ambiguous broker answer: a write whose result is unclear, the cycle stays CLOSING', async () => {
    const f = await activeCycle();
    const id = await approvedOpen(f);
    f.broker.next({ throws: 'timeout' });
    expect((await f.service.execute(id, HUMAN)).state).toBe('AMBIGUOUS');
    expect(await f.service.closeCycle('cycle-1', HUMAN)).toMatchObject({ status: 'closing', settlement: { writesInFlight: 1, ordersUnresolved: 0, positionsOpen: 0 } });
  });

  it('a restart while CLOSING with an open position: the new process sees CLOSING with the same breakdown, takes no intent, and cannot close it', async () => {
    const stores = inMemoryStores();
    const cycles = new InMemoryAppendOnlyStore<DemoCycleRecord>();
    const f = await activeCycle(stores, cycles);
    const open = await filledOpen(f);
    expect((await f.service.closeCycle('cycle-1', HUMAN)).status).toBe('closing');
    const restarted = await o21Fixture({ stores, cycles, sharedBroker: f.broker });
    expect(await restarted.service.closeCycle('cycle-1', HUMAN)).toMatchObject({ status: 'closing', settlement: { writesInFlight: 0, ordersUnresolved: 0, positionsOpen: 1 } });
    // No automatic trading exception: a close of the open position is not even created while the cycle is CLOSING.
    await expect(restarted.service.create(closeInput(open), CREATOR)).rejects.toMatchObject({ reasons: ['CYCLE_NOT_ACTIVE'] });
    expect(f.broker.writes).toHaveLength(1);
  });

  it('a FILLED open whose position NEXUS did not close: the cycle stays CLOSING', async () => {
    const f = await activeCycle();
    await filledOpen(f);
    expect((await f.service.closeCycle('cycle-1', HUMAN)).status).toBe('closing');
  });

  it('a FILLED open whose position a FILLED NEXUS close closed: the cycle is CLOSED', async () => {
    const f = await activeCycle();
    const open = await filledOpen(f);
    const close = await f.service.create(closeInput(open), CREATOR);
    await f.service.approve(close.intentId, HUMAN);
    f.broker.next(closeSubmitted, closeFilled);
    await f.service.execute(close.intentId, HUMAN);
    expect((await f.service.refresh(close.intentId)).state).toBe('FILLED');
    expect((await f.service.closeCycle('cycle-1', HUMAN)).status).toBe('closed');
  });
});

describe('R6: cancel of a pending order while the cycle is CLOSING or CLOSED', () => {
  const cancelAccepted = { status: 200, body: { token: '5fe065bc-f6f9-4897-a2ce-c4fccef73ff8' } };
  const deletes = (f: Fixture) => f.broker.requests.filter((r) => r.method === 'DELETE').length;

  /** A pending (MIT, ACCEPTED) open of the active cycle, then the close begun: the cycle is CLOSING with one unresolved order. */
  async function pendingWhileClosing(stores = inMemoryStores(), cycles = new InMemoryAppendOnlyStore<DemoCycleRecord>()): Promise<{ f: Fixture; id: string }> {
    const f = await activeCycle(stores, cycles);
    const id = await approvedOpen(f, { orderType: 'mit', triggerRate: '195' });
    f.broker.next(orderAccepted(), lookupAnswer(12));
    await f.service.execute(id, HUMAN);
    expect((await f.service.refresh(id)).state).toBe('ACCEPTED');
    expect(await f.service.closeCycle('cycle-1', HUMAN)).toMatchObject({ status: 'closing', settlement: { ordersUnresolved: 1 } });
    return { f, id };
  }

  it('CLOSING: a second instance cancels the pending order once (risk-reducing, no budget); its confirmation settles the cycle, which then closes', async () => {
    const stores = inMemoryStores();
    const cycles = new InMemoryAppendOnlyStore<DemoCycleRecord>();
    const { f, id } = await pendingWhileClosing(stores, cycles);
    const budget = await f.service.cycleBudget('cycle-1');
    const second = await o21Fixture({ stores, cycles, sharedBroker: f.broker });
    f.broker.next(cancelAccepted);
    await second.service.cancel(id, HUMAN);
    expect(deletes(f)).toBe(1);
    expect(await second.service.cycleBudget('cycle-1')).toEqual(budget);
    // Still CLOSING until the broker confirms the cancellation by a status read.
    expect((await second.service.closeCycle('cycle-1', HUMAN)).status).toBe('closing');
    f.broker.next(lookupAnswer(7));
    expect((await second.service.refresh(id)).state).toBe('CANCELLED');
    expect((await second.service.closeCycle('cycle-1', HUMAN)).status).toBe('closed');
  });

  it('CLOSING: two cancels at once send at most one', async () => {
    const stores = inMemoryStores();
    const cycles = new InMemoryAppendOnlyStore<DemoCycleRecord>();
    const { f, id } = await pendingWhileClosing(stores, cycles);
    const second = await o21Fixture({ stores, cycles, sharedBroker: f.broker });
    f.broker.next(cancelAccepted, cancelAccepted);
    const results = await Promise.allSettled([f.service.cancel(id, HUMAN), second.service.cancel(id, HUMAN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(deletes(f)).toBe(1);
  });

  it('CLOSING: a crash right after the started cancel attempt (nothing sent): no second cancel, and the cycle stays CLOSING (fail closed)', async () => {
    const base = inMemoryStores();
    const attempts = new FaultStore<AttemptRecord>(base.attempts);
    const stores = { ...base, attempts };
    const cycles = new InMemoryAppendOnlyStore<DemoCycleRecord>();
    const { f, id } = await pendingWhileClosing(stores, cycles);
    attempts.crashAt((a) => a.operation === 'demo.order.cancel' && a.phase === 'started', 'after');
    await expect(f.service.cancel(id, HUMAN)).rejects.toBeInstanceOf(InjectedCrash);
    const restarted = await o21Fixture({ stores, cycles, sharedBroker: f.broker });
    await expect(restarted.service.cancel(id, HUMAN)).rejects.toMatchObject({ code: 'INTENT_STATE_INVALID' });
    expect(deletes(f)).toBe(0);
    expect(await restarted.service.closeCycle('cycle-1', HUMAN)).toMatchObject({ status: 'closing', settlement: { ordersUnresolved: 1 } });
  });

  it('CLOSED: a cancel is refused (CANCEL_CYCLE_CLOSED), recorded, and nothing is sent', async () => {
    const { f, id } = await pendingWhileClosing();
    // TEST ONLY: a CLOSED cycle with a pending order cannot arise through the service (CLOSED needs the cycle settled): written
    // directly, as an inconsistent record would be.
    await f.cycles!.append('cycle-1:closed', { schema: 'etoro-demo-cycle:v1', kind: 'closed', cycleId: 'cycle-1', closedBy: HUMAN, closedAt: f.clock.now.toISOString(), verdict: 'not_evaluated', failures: [] });
    await expect(f.service.cancel(id, HUMAN)).rejects.toMatchObject({ code: 'GATE_REFUSED', reasons: ['CANCEL_CYCLE_CLOSED'] });
    expect(deletes(f)).toBe(0);
    expect(f.attempts.all().map((r) => r.payload).filter((a) => a.phase === 'refused').at(-1)?.reasons).toEqual(['CANCEL_CYCLE_CLOSED']);
  });
});
