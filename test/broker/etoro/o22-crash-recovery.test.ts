// O22 crash-safe status check (in-memory stores). The intent, confirmation and reconciliation logs are separate append-only logs,
// each with its own critical section, so one status check is several records. A crash between them is completed by a restarted
// process from the stored evidence (deterministic roll-forward, each step an ordinary idempotent transition), or by one more
// read-only GET; never by a broker write. Missing or contradicting evidence stops safely. PostgreSQL: o22-crash-recovery.pg.test.ts.
import { describe, expect, it, vi } from 'vitest';

// TEST ONLY: the scenarios submit one open, so this module replaces the compile-time lock for this module only.
vi.mock('../../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});
import { ScriptedBroker, inMemoryStores } from './o21-fixture.js';
import { InjectedCrash, withFaults } from './o22-fault-store.js';
import { ORDER, POSITION, assertSettled, crashAndRestart, heldAnswer, lookup, refusal, startProcess, submitted, type Step } from './o22-recovery-scenarios.js';

const NORMAL_STEPS: Step[] = ['confirm', 'final'];
const AMBIGUOUS_STEPS: Step[] = ['found', 'reconciled', 'confirm', 'final'];

describe('O22 crash at every persistence step, then a restart (in-memory)', () => {
  for (const step of NORMAL_STEPS) {
    for (const point of ['before', 'after'] as const) {
      it('SUBMITTED path: crash ' + point + ' the ' + step + ' record; the restart completes it once, without a second order', async () => {
        const stores = inMemoryStores();
        await crashAndRestart('normal', step, point, { first: stores, restart: async () => stores });
      });
    }
  }
  for (const step of AMBIGUOUS_STEPS) {
    for (const point of ['before', 'after'] as const) {
      it('AMBIGUOUS path: crash ' + point + ' the ' + step + ' record; the restart completes it once, without a second order', async () => {
        const stores = inMemoryStores();
        await crashAndRestart('ambiguous', step, point, { first: stores, restart: async () => stores });
      });
    }
  }

  it('RECONCILED without any status read is not blocked: its order id comes from the checked "found" record', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const faults = withFaults(stores);
    const first = await startProcess(faults.stores, broker);
    const id = await submitted(first, 'ambiguous');
    faults.intents.crashAt((e) => e.state === 'RECONCILED', 'after');
    broker.next(lookup());
    await expect(first.service.refresh(id)).rejects.toBeInstanceOf(InjectedCrash);
    const second = await startProcess(stores, broker);
    expect((await second.service.get(id)).state).toBe('RECONCILED');
    broker.next(lookup());
    expect((await second.service.refresh(id)).state).toBe('FILLED');
    expect(broker.requests.at(-1)!.url).toContain('orderId=' + ORDER);
    await assertSettled(second, id, 'ambiguous');
  });

  it('repeated recover() after a crash records each step once', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const faults = withFaults(stores);
    const first = await startProcess(faults.stores, broker);
    const id = await submitted(first, 'ambiguous');
    faults.confirmations.crashAt((c) => c.kind === 'order_status', 'after');
    broker.next(lookup());
    await expect(first.service.refresh(id)).rejects.toBeInstanceOf(InjectedCrash);
    const second = await startProcess(stores, broker);
    const third = await startProcess(stores, broker);
    expect((await second.service.recover(id)).state).toBe('FILLED');
    expect((await third.service.recover(id)).state).toBe('FILLED');
    expect((await second.service.recover(id)).state).toBe('FILLED');
    expect(second.intents.all().filter((r) => r.payload.intentId === id && r.payload.state === 'FILLED')).toHaveLength(1);
    await assertSettled(third, id, 'ambiguous');
  });
});

describe('O22 recovery: missing or contradicting evidence stops safely', () => {
  it('two "found" records with different orders: RECONCILIATION_CONFLICT, the intent stays AMBIGUOUS', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const f = await startProcess(stores, broker);
    const id = await submitted(f, 'ambiguous');
    const base = { schema: 'etoro-demo-execution-reconciliation:v1' as const, intentId: id, referenceId: 'ref', result: 'found' as const, statusId: 3, at: '2026-10-16T14:01:00.000Z', checked: true as const };
    await f.reconciliations.append('erec_test_a', { ...base, reconciliationId: 'erec_test_a', brokerOrderId: ORDER });
    await f.reconciliations.append('erec_test_b', { ...base, reconciliationId: 'erec_test_b', brokerOrderId: ORDER + 1 });
    const requests = broker.requests.length;
    expect(await refusal(f.service.recover(id))).toEqual({ code: 'BROKER_RESPONSE_INVALID', reasons: ['RECONCILIATION_CONFLICT'] });
    expect(await refusal(f.service.refresh(id))).toEqual({ code: 'BROKER_RESPONSE_INVALID', reasons: ['RECONCILIATION_CONFLICT'] });
    expect(broker.requests.length).toBe(requests);
    expect((await f.service.get(id)).state).toBe('AMBIGUOUS');
  });

  it('a "found" record that was not checked (older code) never rolls AMBIGUOUS forward', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const f = await startProcess(stores, broker);
    const id = await submitted(f, 'ambiguous');
    await f.reconciliations.append('erec_legacy', { schema: 'etoro-demo-execution-reconciliation:v1', reconciliationId: 'erec_legacy', intentId: id, referenceId: 'ref', result: 'found', brokerOrderId: ORDER, statusId: 3, at: '2026-10-16T14:01:00.000Z' });
    expect((await f.service.recover(id)).state).toBe('AMBIGUOUS');
    // A new read checks the answer completely and records a checked "found" for the same order.
    broker.next(lookup());
    expect((await f.service.refresh(id)).state).toBe('FILLED');
  });

  it('a status read stored for another state never carries a transition from the current one', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const f = await startProcess(stores, broker);
    const id = await submitted(f, 'normal');
    await f.confirmations.append('econf_test_other_state', {
      schema: 'etoro-demo-broker-confirmation:v1', confirmationId: 'econf_test_other_state', intentId: id, kind: 'order_status', requestId: null,
      brokerOrderId: ORDER, brokerPositionIds: [POSITION], statusId: 3, statusName: 'Filled', outcome: 'filled', errorCode: null,
      observedAt: '2026-10-16T14:01:00.000Z', appliesFrom: 'ACCEPTED', target: 'FILLED',
    });
    expect((await f.service.recover(id)).state).toBe('SUBMITTED');
  });

  it('after a partial fill, an answer that the order is pending again is refused (STATUS_CONTRADICTS_EARLIER_READ)', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const f = await startProcess(stores, broker);
    const id = await submitted(f, 'normal');
    broker.next(lookup({ statusId: 5 }));
    expect((await f.service.refresh(id)).state).toBe('PARTIALLY_FILLED');
    broker.next(lookup({ statusId: 2, positionIds: [] }));
    expect(await refusal(f.service.refresh(id))).toEqual({ code: 'BROKER_RESPONSE_INVALID', reasons: ['STATUS_CONTRADICTS_EARLIER_READ'] });
    expect((await f.service.get(id)).state).toBe('PARTIALLY_FILLED');
  });
});

describe('O22 two processes (in-memory stores; PostgreSQL in o22-crash-recovery.pg.test.ts)', () => {
  it('a stale check cannot store a contradicting read: the second process\'s "pending" is refused after the first stored the fill', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const a = await startProcess(stores, broker);
    const b = await startProcess(stores, broker);
    const id = await submitted(a, 'normal');
    const held = heldAnswer(lookup({ statusId: 2, positionIds: [] }));
    broker.next(held.answer);
    const late = b.service.refresh(id).catch((e: unknown) => e);
    await held.reached;
    broker.next(lookup());
    expect((await a.service.refresh(id)).state).toBe('FILLED');
    held.release();
    const refused = await late;
    expect(refused).toMatchObject({ code: 'BROKER_RESPONSE_INVALID', reasons: ['STATUS_CONTRADICTS_EARLIER_READ'] });
    expect(a.confirmations.all().filter((r) => r.payload.intentId === id && r.payload.kind === 'order_status')).toHaveLength(1);
    await assertSettled(b, id, 'normal');
  });
});
