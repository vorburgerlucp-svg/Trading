// O22 parser fix: refresh() of a submitted open against scripted orders:lookup answers (no network). A broker answer is applied only
// when it unambiguously belongs to the intent: the stored order id, the instrument, the action "open", the intent's direction, and
// exactly one position for a fill (the same one as every earlier read). Anything else is refused before anything is recorded: the
// intent keeps its state, no confirmation is stored, and no close of the position can be prepared. A refresh never writes.
import { describe, expect, it, vi } from 'vitest';

// TEST ONLY: this module exercises the write path (one open per test), so it replaces the compile-time lock for this module only.
// The real locks are asserted without any mock in o22-order-lookup-parser.test.ts.
vi.mock('../../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});
import { DEMO_E2E_CYCLE_POLICY } from '../../../src/broker/etoro/execution/execution-gate.js';
import { DemoExecutionError } from '../../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import { reconcileDemoCycle } from '../../../src/broker/etoro/execution/demo-cycle-reconciliation.js';
import { CREATOR, ETORO_AAPL_ID, ETORO_MSFT_ID, HUMAN, MSFT, closeInput, o21Fixture, openInput, orderAccepted, type Fixture, type Scripted } from './o21-fixture.js';
import { LIVE_LIKE_ORDER_ID, LIVE_LIKE_POSITION_ID, liveLikeLookup } from './o22-order-lookup-fixture.js';

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reasons: readonly string[]; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DemoExecutionError) return { code: error.code, reasons: error.reasons, message: error.message };
    throw error;
  }
  throw new Error('expected a DemoExecutionError');
}

function answer(body: Record<string, unknown>): Scripted {
  return { status: 200, body };
}

function lookup(options: Parameters<typeof liveLikeLookup>[1] = {}, change?: (b: Record<string, unknown>) => void): Scripted {
  const body = liveLikeLookup(ETORO_AAPL_ID, options);
  change?.(body);
  return answer(body);
}

/** The cycle's open (100 USD market buy, leverage 1), submitted once and accepted under the stored order id; not yet refreshed. */
async function submittedOpen(f: Fixture, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await f.service.create(openInput({ amount: '100', ...overrides }), CREATOR);
  expect(created.state, created.gateReasons.join(',')).toBe('RISK_APPROVED');
  await f.service.approve(created.intentId, HUMAN);
  f.broker.next(orderAccepted(LIVE_LIKE_ORDER_ID));
  expect((await f.service.execute(created.intentId, HUMAN)).state).toBe('SUBMITTED');
  return created.intentId;
}

function orderStatusReads(f: Fixture, intentId: string): number {
  return f.confirmations.all().filter((r) => r.payload.intentId === intentId && r.payload.kind === 'order_status').length;
}

/** A refused refresh: the code and reason, the state unchanged, nothing recorded, a GET only, the close still impossible. */
async function expectRefused(f: Fixture, intentId: string, reason: string, stateBefore = 'SUBMITTED'): Promise<void> {
  const readsBefore = orderStatusReads(f, intentId);
  const writesBefore = f.broker.writes.length;
  const requestsBefore = f.broker.requests.length;
  const e = await refusal(f.service.refresh(intentId));
  expect(e.code).toBe('BROKER_RESPONSE_INVALID');
  expect(e.reasons).toEqual([reason]);
  expect((await f.service.get(intentId)).state).toBe(stateBefore);
  expect(orderStatusReads(f, intentId)).toBe(readsBefore);
  expect(f.broker.writes.length).toBe(writesBefore);
  expect(f.broker.requests.slice(requestsBefore).map((r) => r.method)).toEqual(['GET']);
  for (const id of [LIVE_LIKE_ORDER_ID, LIVE_LIKE_POSITION_ID]) expect(e.message + e.reasons.join()).not.toContain(String(id));
}

function cycle(): Promise<Fixture> {
  return o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY });
}

describe('O22 refresh: the confirmed live structure', () => {
  it('the live-like answer ("REAL", Filled, one position) confirms the open: FILLED, the position bound, settlement type real', async () => {
    const f = await cycle();
    const id = await submittedOpen(f);
    f.broker.next(lookup());
    const view = await f.service.refresh(id);
    expect(view.state).toBe('FILLED');
    expect(view.brokerPositionIds).toEqual([LIVE_LIKE_POSITION_ID]);
    expect(view.brokerSettlementType).toBe('real');
    expect(f.broker.writes).toHaveLength(1);
    expect(f.broker.requests.at(-1)!.method).toBe('GET');
    expect(f.broker.requests.at(-1)!.url).toContain(String(LIVE_LIKE_ORDER_ID));
  });

  it('pending stays ACCEPTED without a position; a partial fill binds its one position; the fill then confirms the same one', async () => {
    const f = await cycle();
    const id = await submittedOpen(f);
    f.broker.next(lookup({ statusId: 2, positionIds: [] }));
    expect((await f.service.refresh(id)).state).toBe('ACCEPTED');
    f.broker.next(lookup({ statusId: 5 }));
    expect((await f.service.refresh(id)).state).toBe('PARTIALLY_FILLED');
    f.broker.next(lookup({ statusId: 3 }));
    const view = await f.service.refresh(id);
    expect(view.state).toBe('FILLED');
    expect(view.brokerPositionIds).toEqual([LIVE_LIKE_POSITION_ID]);
    expect(f.broker.writes).toHaveLength(1);
  });
});

describe('O22 refresh: answers that do not unambiguously belong to the intent are refused', () => {
  const cases: [string, Scripted, string][] = [
    ['another order id', lookup({ orderId: LIVE_LIKE_ORDER_ID + 1 }), 'ORDER_ID_MISMATCH'],
    ['another instrument', lookup({ instrumentId: ETORO_MSFT_ID }), 'INSTRUMENT_MISMATCH'],
    ['action close', lookup({}, (b) => (b.action = 'close')), 'ACTION_MISMATCH'],
    ['action missing', lookup({}, (b) => delete b.action), 'ACTION_MISMATCH'],
    ['action null', lookup({}, (b) => (b.action = null)), 'ACTION_MISMATCH'],
    ['transaction sell (another direction)', lookup({}, (b) => (b.transaction = 'sell')), 'TRANSACTION_MISMATCH'],
    ['transaction sellShort (another direction)', lookup({}, (b) => (b.transaction = 'sellShort')), 'TRANSACTION_MISMATCH'],
    ['transaction missing', lookup({}, (b) => delete b.transaction), 'TRANSACTION_MISMATCH'],
    ['Filled with two positions', lookup({ positionIds: [LIVE_LIKE_POSITION_ID, LIVE_LIKE_POSITION_ID + 1] }), 'POSITION_NOT_UNIQUE'],
    ['Filled without a position (incomplete fill proof)', lookup({ positionIds: [] }), 'FILL_WITHOUT_POSITION'],
    ['Filled without positionExecutions', lookup({}, (b) => delete b.positionExecutions), 'FILL_WITHOUT_POSITION'],
    ['a partial fill without a position', lookup({ statusId: 5, positionIds: [] }), 'FILL_WITHOUT_POSITION'],
    ['a pending order that names a position', lookup({ statusId: 2 }), 'POSITION_WITHOUT_FILL'],
    ['a rejected order that names a position', lookup({ statusId: 4 }), 'POSITION_WITHOUT_FILL'],
    ['an unknown status', lookup({ statusId: 99 }), 'INVALID_STATUS_ID'],
    ['an undocumented settlement type', lookup({}, (b) => ((b.asset as Record<string, unknown>).settlementType = 'REAL_ASSET')), 'INVALID_ASSET_SETTLEMENTTYPE'],
    ['an invalid position id', lookup({ positionIds: [0] }), 'INVALID_POSITIONEXECUTIONS_POSITIONID'],
    ['an order id missing', lookup({}, (b) => delete b.orderId), 'INVALID_ORDERID'],
  ];
  for (const [name, scripted, reason] of cases) {
    it(name + ': ' + reason + ', state unchanged, nothing recorded, no close possible', async () => {
      const f = await cycle();
      const id = await submittedOpen(f);
      f.broker.next(scripted);
      await expectRefused(f, id, reason);
      // No close can be prepared for a position NEXUS has not unambiguously confirmed.
      expect((await refusal(f.service.create(closeInput(id), CREATOR))).code).toBe('INTENT_INVALID');
    });
  }

  it('a read naming another position than an earlier read is refused; the earlier binding stays the only one', async () => {
    const f = await cycle();
    const id = await submittedOpen(f);
    f.broker.next(lookup({ statusId: 5 }));
    expect((await f.service.refresh(id)).state).toBe('PARTIALLY_FILLED');
    f.broker.next(lookup({ statusId: 3, positionIds: [LIVE_LIKE_POSITION_ID + 7] }));
    await expectRefused(f, id, 'POSITION_CONTRADICTS_EARLIER_READ', 'PARTIALLY_FILLED');
    expect((await f.service.get(id)).brokerPositionIds).toEqual([LIVE_LIKE_POSITION_ID]);
  });

  it('a sell intent requires sellShort: "buy" is refused for it (default policy: the cycle policy allows buy only)', async () => {
    const f = await o21Fixture();
    const id = await submittedOpen(f, { side: 'sell', stopLoss: '230', takeProfit: '180' });
    f.broker.next(lookup());
    await expectRefused(f, id, 'TRANSACTION_MISMATCH');
    f.broker.next(lookup({}, (b) => (b.transaction = 'sellShort')));
    expect((await f.service.refresh(id)).state).toBe('FILLED');
  });
});

describe('O22 refresh: restart, repetition, budget', () => {
  it('a refused read can be repeated after a restart; the valid read then confirms once, and nothing is ever sent again', async () => {
    const first = await cycle();
    const id = await submittedOpen(first);
    first.broker.next(lookup({}, (b) => ((b.asset as Record<string, unknown>).settlementType = 'REALX')));
    await expectRefused(first, id, 'INVALID_ASSET_SETTLEMENTTYPE');

    // A second process on the same stores (a restart): the intent is still SUBMITTED, the budget still spent.
    const restarted = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, stores: first.stores, sharedBroker: first.broker });
    expect((await restarted.service.get(id)).state).toBe('SUBMITTED');
    expect(await restarted.service.cycleBudget()).toMatchObject({ openSubmissions: 1, maxOpenSubmissions: 1 });
    restarted.broker.next(lookup(), lookup());
    expect((await restarted.service.refresh(id)).state).toBe('FILLED');
    // FILLED is final: a further refresh is refused without any broker request.
    const requests = restarted.broker.requests.length;
    expect((await refusal(restarted.service.refresh(id))).code).toBe('INTENT_STATE_INVALID');
    expect(restarted.broker.requests.length).toBe(requests);

    // Exactly the one open write, ever; every refresh was a GET.
    expect(restarted.broker.writes).toHaveLength(1);
    expect(restarted.broker.requests.filter((r) => r.method !== 'GET')).toHaveLength(1);
    expect(orderStatusReads(restarted, id)).toBe(1);
  });

  it('the open budget stays spent: a refused refresh does not free it, and a new open is refused by the budget', async () => {
    const f = await cycle();
    const id = await submittedOpen(f);
    f.broker.next(lookup({ positionIds: [] }));
    await expectRefused(f, id, 'FILL_WITHOUT_POSITION');
    expect(await f.service.cycleBudget()).toMatchObject({ openSubmissions: 1, maxOpenSubmissions: 1, closeSubmissions: 0 });
    const second = await f.service.create(openInput({ amount: '100', instrumentId: MSFT.instrumentId, etoroInstrumentId: ETORO_MSFT_ID, strategyRunId: 'run-o22-second' }), CREATOR);
    expect(second.state).toBe('REJECTED');
    expect(second.gateReasons).toContain('CYCLE_OPEN_BUDGET_EXHAUSTED');
    expect(f.broker.writes).toHaveLength(1);
  });
});

describe('O22 reconciliation: an open that was never confirmed stays unresolved', () => {
  it('after a refused read the open is outcome_pending and an existing broker position is external, not taken over', async () => {
    const f = await cycle();
    const id = await submittedOpen(f);
    f.broker.next(lookup({ positionIds: [] }));
    await expectRefused(f, id, 'FILL_WITHOUT_POSITION');
    const snapshot = {
      snapshotId: 'snap_test', observedAt: '2026-10-16T14:05:00.000Z', freshness: 'fresh',
      content: { positions: [{ positionId: LIVE_LIKE_POSITION_ID, etoroInstrumentId: ETORO_AAPL_ID, direction: 'buy' }], orders: [] },
    } as unknown as Parameters<typeof reconcileDemoCycle>[1];
    const result = reconcileDemoCycle(await f.service.list(), snapshot);
    expect(result.verdict).toBe('unknown');
    expect(result.items.map((i) => i.kind)).toEqual(['outcome_pending']);
    expect(result.externalPositions.map((p) => p.positionId)).toEqual([LIVE_LIKE_POSITION_ID]);
    expect(result.reasons).toEqual(expect.arrayContaining(['OUTCOME_PENDING', 'EXTERNAL_POSITIONS_PRESENT']));
  });
});

describe('O22 AMBIGUOUS reconciliation: the whole answer is checked before the first record', () => {
  /** The cycle's open, written once; the answer is lost (timeout), so the intent is AMBIGUOUS. */
  async function ambiguousOpen(f: Fixture): Promise<string> {
    const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
    expect(created.state, created.gateReasons.join(',')).toBe('RISK_APPROVED');
    await f.service.approve(created.intentId, HUMAN);
    f.broker.next({ throws: 'timeout' });
    expect((await f.service.execute(created.intentId, HUMAN)).state).toBe('AMBIGUOUS');
    return created.intentId;
  }

  /** A refused reconciliation: no "found" record, no confirmation, no state change, a GET only, the budget unchanged. */
  async function expectAmbiguousRefused(f: Fixture, intentId: string, reason: string): Promise<void> {
    const historyBefore = (await f.service.get(intentId)).history.map((h) => h.state);
    const requestsBefore = f.broker.requests.length;
    const e = await refusal(f.service.refresh(intentId));
    expect(e.code).toBe('BROKER_RESPONSE_INVALID');
    expect(e.reasons).toEqual([reason]);
    const view = await f.service.get(intentId);
    expect(view.state).toBe('AMBIGUOUS');
    expect(view.history.map((h) => h.state)).toEqual(historyBefore);
    expect(view.brokerPositionIds).toEqual([]);
    expect(f.reconciliations.all().filter((r) => r.payload.intentId === intentId)).toHaveLength(0);
    expect(f.confirmations.all().filter((r) => r.payload.intentId === intentId)).toHaveLength(0);
    expect(f.broker.requests.slice(requestsBefore).map((r) => r.method)).toEqual(['GET']);
    expect(f.broker.writes).toHaveLength(1);
    expect(await f.service.cycleBudget()).toMatchObject({ openSubmissions: 1, maxOpenSubmissions: 1, closeSubmissions: 0 });
    expect((await refusal(f.service.create(closeInput(intentId), CREATOR))).code).toBe('INTENT_INVALID');
  }

  const cases: [string, Scripted, string][] = [
    ['Filled without a position', lookup({ positionIds: [] }), 'FILL_WITHOUT_POSITION'],
    ['Filled without positionExecutions', lookup({}, (b) => delete b.positionExecutions), 'FILL_WITHOUT_POSITION'],
    ['a partial fill without a position', lookup({ statusId: 5, positionIds: [] }), 'FILL_WITHOUT_POSITION'],
    ['Filled with two positions', lookup({ positionIds: [LIVE_LIKE_POSITION_ID, LIVE_LIKE_POSITION_ID + 1] }), 'POSITION_NOT_UNIQUE'],
    ['Filled with a contradicting positionsToClose entry', lookup({}, (b) => (b.positionsToClose = [LIVE_LIKE_POSITION_ID + 9])), 'POSITION_NOT_UNIQUE'],
    ['a pending order that names a position', lookup({ statusId: 2 }), 'POSITION_WITHOUT_FILL'],
    ['a rejected order that names a position', lookup({ statusId: 4 }), 'POSITION_WITHOUT_FILL'],
    ['an invalid position id', lookup({ positionIds: [-1] }), 'INVALID_POSITIONEXECUTIONS_POSITIONID'],
    ['another instrument', lookup({ instrumentId: ETORO_MSFT_ID }), 'ORDER_DOES_NOT_MATCH_INTENT'],
    ['another direction', lookup({}, (b) => (b.transaction = 'sellShort')), 'ORDER_DOES_NOT_MATCH_INTENT'],
  ];
  for (const [name, scripted, reason] of cases) {
    it(name + ': ' + reason + ', the intent stays AMBIGUOUS and nothing is recorded', async () => {
      const f = await cycle();
      const id = await ambiguousOpen(f);
      f.broker.next(scripted);
      await expectAmbiguousRefused(f, id, reason);
    });
  }

  it('after a refused answer a valid one still reconciles exactly once; no second order, the budget stays spent', async () => {
    const f = await cycle();
    const id = await ambiguousOpen(f);
    f.broker.next(lookup({ positionIds: [] }));
    await expectAmbiguousRefused(f, id, 'FILL_WITHOUT_POSITION');
    // A restart in between: a second process on the same stores.
    const restarted = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, stores: f.stores, sharedBroker: f.broker });
    restarted.broker.next(lookup());
    const view = await restarted.service.refresh(id);
    expect(view.state).toBe('FILLED');
    expect(view.history.map((h) => h.state)).toEqual(['CREATED', 'RISK_APPROVED', 'APPROVED', 'SUBMITTING', 'AMBIGUOUS', 'RECONCILED', 'FILLED']);
    expect(view.brokerPositionIds).toEqual([LIVE_LIKE_POSITION_ID]);
    expect(restarted.reconciliations.all().map((r) => r.payload.result)).toEqual(['found']);
    expect(orderStatusReads(restarted, id)).toBe(1);
    expect(restarted.broker.writes).toHaveLength(1);
    expect(await restarted.service.cycleBudget()).toMatchObject({ openSubmissions: 1, maxOpenSubmissions: 1, closeSubmissions: 0 });
    const second = await restarted.service.create(openInput({ amount: '100', instrumentId: MSFT.instrumentId, etoroInstrumentId: ETORO_MSFT_ID, strategyRunId: 'run-o22-second' }), CREATOR);
    expect(second.state).toBe('REJECTED');
    expect(second.gateReasons).toContain('CYCLE_OPEN_BUDGET_EXHAUSTED');
  });
});
