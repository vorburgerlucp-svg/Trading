// O22 TEST ONLY: crash-recovery scenarios of the demo status check, shared by the in-memory tests and the PostgreSQL tests. A
// "process" is one service with its own AppendOnlyLog instances; a restart is a new service on the same stores (for PostgreSQL: on
// its own connection pool). Every broker answer is scripted; every request is counted.
import { expect } from 'vitest';
import { DEMO_E2E_CYCLE_POLICY } from '../../../src/broker/etoro/execution/execution-gate.js';
import { DemoExecutionError } from '../../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import { CREATOR, ETORO_AAPL_ID, HUMAN, ScriptedBroker, o21Fixture, openInput, orderAccepted, type Fixture, type O21Stores, type Scripted } from './o21-fixture.js';
import { InjectedCrash, withFaults } from './o22-fault-store.js';
import { LIVE_LIKE_ORDER_ID, LIVE_LIKE_POSITION_ID, liveLikeLookup } from './o22-order-lookup-fixture.js';

export const ORDER = LIVE_LIKE_ORDER_ID;
export const POSITION = LIVE_LIKE_POSITION_ID;

export function lookup(options: Parameters<typeof liveLikeLookup>[1] = {}, change?: (b: Record<string, unknown>) => void): Scripted {
  const body = liveLikeLookup(ETORO_AAPL_ID, options);
  change?.(body);
  return { status: 200, body };
}

export async function refusal(promise: Promise<unknown>): Promise<{ code: string; reasons: readonly string[] }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DemoExecutionError) return { code: error.code, reasons: error.reasons };
    throw error;
  }
  throw new Error('expected a DemoExecutionError');
}

export function startProcess(stores: O21Stores, broker: ScriptedBroker): Promise<Fixture> {
  return o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, stores, sharedBroker: broker });
}

/** The cycle's open, written once: SUBMITTED (accepted) or AMBIGUOUS (the answer of the write was lost). */
export async function submitted(f: Fixture, path: 'normal' | 'ambiguous'): Promise<string> {
  const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
  expect(created.state, created.gateReasons.join(',')).toBe('RISK_APPROVED');
  await f.service.approve(created.intentId, HUMAN);
  f.broker.next(path === 'normal' ? orderAccepted(ORDER) : { throws: 'timeout' });
  expect((await f.service.execute(created.intentId, HUMAN)).state).toBe(path === 'normal' ? 'SUBMITTED' : 'AMBIGUOUS');
  return created.intentId;
}

export type Step = 'found' | 'reconciled' | 'confirm' | 'final';

/** How many broker reads a restarted process still needs: none when the stored evidence already decides the outcome. */
function readsAfterRestart(step: Step, point: 'before' | 'after'): number {
  if (step === 'final' || (step === 'confirm' && point === 'after')) return 0;
  return 1;
}

/**
 * One crash at one persistence step of the status check (before or after its commit), then a restart: recover() completes what
 * the stored evidence proves (no broker request); refresh() reads only when it must. Asserts the end state and the invariants.
 */
export async function crashAndRestart(
  path: 'normal' | 'ambiguous',
  step: Step,
  point: 'before' | 'after',
  stores: { first: O21Stores; restart: () => Promise<O21Stores> },
): Promise<void> {
  const broker = new ScriptedBroker();
  const faults = withFaults(stores.first);
  const first = await startProcess(faults.stores, broker);
  const id = await submitted(first, path);
  if (step === 'found') faults.reconciliations.crashAt((r) => r.result === 'found', point);
  if (step === 'reconciled') faults.intents.crashAt((e) => e.state === 'RECONCILED', point);
  if (step === 'confirm') faults.confirmations.crashAt((c) => c.kind === 'order_status', point);
  if (step === 'final') faults.intents.crashAt((e) => e.state === 'FILLED', point);

  broker.next(lookup());
  await expect(first.service.refresh(id)).rejects.toBeInstanceOf(InjectedCrash);
  expect(faults.intents.fired || faults.confirmations.fired || faults.reconciliations.fired).toBe(true);

  // Restart: a new process on the same stores.
  const second = await startProcess(await stores.restart(), broker);
  const requestsBeforeRecover = broker.requests.length;
  const recovered = await second.service.recover(id);
  expect(broker.requests.length, 'recover() sends no request').toBe(requestsBeforeRecover);
  const reads = readsAfterRestart(step, point);
  if (recovered.state !== 'FILLED') {
    expect(reads).toBe(1);
    broker.next(lookup());
    expect((await second.service.refresh(id)).state).toBe('FILLED');
  } else {
    expect(reads).toBe(0);
  }
  const newRequests = broker.requests.slice(requestsBeforeRecover);
  expect(newRequests).toHaveLength(reads);
  expect(newRequests.every((r) => r.method === 'GET')).toBe(true);
  // A recovered RECONCILED intent reads its order by the order id of the "found" record.
  if (path === 'ambiguous' && reads === 1 && !(step === 'found' && point === 'before')) expect(newRequests[0]!.url).toContain('orderId=' + ORDER);

  await assertSettled(second, id, path);
}

/** The invariants of a completed status check: FILLED once, one position, exactly one write, the budget unchanged, consistent. */
export async function assertSettled(f: Fixture, id: string, path: 'normal' | 'ambiguous'): Promise<void> {
  await f.service.recover(id);
  const view = await f.service.get(id);
  expect(view.state).toBe('FILLED');
  expect(view.brokerPositionIds).toEqual([POSITION]);
  const states = view.history.map((h) => h.state);
  expect(states).toEqual(path === 'normal'
    ? ['CREATED', 'RISK_APPROVED', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'FILLED']
    : ['CREATED', 'RISK_APPROVED', 'APPROVED', 'SUBMITTING', 'AMBIGUOUS', 'RECONCILED', 'FILLED']);
  // Exactly the one original write, ever; the budget is spent once and never reset.
  expect(f.broker.writes).toHaveLength(1);
  expect(await f.service.cycleBudget()).toMatchObject({ openSubmissions: 1, maxOpenSubmissions: 1, closeSubmissions: 0 });
  // Every stored status read agrees: the same order, the same one position.
  const reads = f.confirmations.all().map((r) => r.payload).filter((c) => c.intentId === id && c.kind === 'order_status');
  expect(reads.length).toBeGreaterThanOrEqual(1);
  for (const c of reads) {
    expect(c.brokerOrderId).toBe(ORDER);
    expect(c.brokerPositionIds).toEqual([POSITION]);
  }
  // The FILLED step carries the read that was checked for exactly that step.
  const filled = f.intents.all().map((r) => r.payload).find((e) => e.intentId === id && e.state === 'FILLED')!;
  const carrying = reads.find((c) => c.confirmationId === filled.confirmationId)!;
  expect(carrying.appliesFrom).toBe(filled.from);
  expect(carrying.target).toBe('FILLED');
  const found = f.reconciliations.all().map((r) => r.payload).filter((r) => r.intentId === id && r.result === 'found');
  if (path === 'ambiguous') {
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ brokerOrderId: ORDER, checked: true });
  } else {
    expect(found).toHaveLength(0);
  }
  // FILLED is final: a further refresh sends nothing.
  const requests = f.broker.requests.length;
  expect((await refusal(f.service.refresh(id))).code).toBe('INTENT_STATE_INVALID');
  expect(f.broker.requests.length).toBe(requests);
}

/** A broker answer that is held back until released (another process acts meanwhile). */
export function heldAnswer(answer: Scripted): { answer: () => Promise<Scripted>; reached: Promise<void>; release: () => void } {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const reachedPromise = new Promise<void>((r) => (reached = r));
  return {
    answer: async () => {
      reached();
      await released;
      return answer;
    },
    reached: reachedPromise,
    release: () => release(),
  };
}
