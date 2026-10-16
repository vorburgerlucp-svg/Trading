// O21 eToro demo execution service: the gate, manual approval, at-most-once submission, ambiguous outcomes, reconciliation by read
// only, cancel and close, broker confirmations, and no secret anywhere. No network: every broker answer is scripted and counted.
import { describe, expect, it } from 'vitest';
import { CapitalLedger } from '../../../src/capital/capital-ledger.js';
import { DemoExecutionError } from '../../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import { AAPL } from '../../market-data/fixtures.js';
import {
  API_KEY_MARKER,
  ETORO_AAPL_ID,
  HUMAN,
  USER_KEY_MARKER,
  approvedOpen,
  closeInput,
  filledOpen,
  freshQuote,
  lookupAnswer,
  normalSafety,
  o21Fixture,
  openInput,
  orderAccepted,
  trippedKillSwitch,
  type Fixture,
} from './o21-fixture.js';

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; reasons: readonly string[] }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DemoExecutionError) return { code: error.code, reasons: error.reasons };
    throw error;
  }
  throw new Error('expected a DemoExecutionError');
}

function stored(f: Fixture): string {
  return JSON.stringify([f.intents.all(), f.attempts.all(), f.confirmations.all(), f.reconciliations.all()]);
}

describe('O21 service: create and risk approval send nothing to the broker', () => {
  it('a valid open is RISK_APPROVED, and approval needs a named human', async () => {
    const f = await o21Fixture();
    const created = await f.service.create(openInput());
    expect(created.state).toBe('RISK_APPROVED');
    expect((await codeOf(f.service.approve(created.intentId, { kind: 'strategy', id: 'strategy-a' }))).code).toBe('APPROVAL_INVALID');
    expect((await codeOf(f.service.approve(created.intentId, { kind: 'model', id: 'llm' }))).code).toBe('APPROVAL_INVALID');
    expect((await codeOf(f.service.approve(created.intentId, { kind: 'human' }))).code).toBe('APPROVAL_INVALID');
    const approved = await f.service.approve(created.intentId, HUMAN);
    expect(approved.state).toBe('APPROVED');
    expect(approved.approvedBy).toEqual(HUMAN);
    expect(f.broker.requests).toHaveLength(0);
  });

  it('manual approval is required: an unapproved intent cannot execute', async () => {
    const f = await o21Fixture();
    const created = await f.service.create(openInput());
    expect((await codeOf(f.service.execute(created.intentId))).code).toBe('INTENT_STATE_INVALID');
    expect(f.broker.requests).toHaveLength(0);
  });

  it('creating the same input twice is idempotent: one intent, one CREATED record', async () => {
    const f = await o21Fixture();
    const a = await f.service.create(openInput());
    const b = await f.service.create(openInput());
    expect(b.intentId).toBe(a.intentId);
    expect(f.intents.all().filter((r) => r.payload.state === 'CREATED')).toHaveLength(1);
  });

  it('a duplicate intent (same trade, other timestamps) is refused while the first is active', async () => {
    const f = await o21Fixture();
    await f.service.create(openInput());
    expect((await codeOf(f.service.create(openInput({ createdAt: '2026-10-16T13:59:30.000Z' })))).code).toBe('INTENT_DUPLICATE');
  });

  it('creation produces no ledger entry: the execution layer has no ledger access', async () => {
    const ledger = await CapitalLedger.inMemory();
    const before = ledger.head();
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.broker.next(orderAccepted());
    await f.service.execute(id);
    expect(ledger.head()).toEqual(before);
    expect(ledger.size).toBe(0);
  });
});

describe('O21 service: the risk gate refuses, fail closed', () => {
  const rejectedWith = async (f: Fixture, input = openInput()) => {
    const view = await f.service.create(input);
    expect(view.state).toBe('REJECTED');
    expect(f.broker.requests).toHaveLength(0);
    return view.gateReasons;
  };

  it('a tripped kill switch blocks an open', async () => {
    expect(await rejectedWith(await o21Fixture({ killSwitch: trippedKillSwitch() }))).toContain('KILL_SWITCH_TRIPPED');
  });

  it('no portfolio safety decision blocks an open', async () => {
    expect(await rejectedWith(await o21Fixture({ safety: null }))).toContain('PORTFOLIO_SAFETY_NOT_CONNECTED');
  });

  it('a safety envelope that blocks risk, or a stale decision, blocks an open', async () => {
    const hold = { ...normalSafety(), state: 'DATA_HOLD', canIncreaseRisk: false } as never;
    expect(await rejectedWith(await o21Fixture({ safety: hold }))).toContain('PORTFOLIO_SAFETY_BLOCKS_RISK_INCREASE');
    expect(await rejectedWith(await o21Fixture({ safety: normalSafety('2026-10-16T13:00:00.000Z') }))).toContain('PORTFOLIO_SAFETY_DECISION_STALE');
    const breach = { ...normalSafety(), hardBreachReasons: ['MAX_INTRADAY_DRAWDOWN'] } as never;
    expect(await rejectedWith(await o21Fixture({ safety: breach }))).toContain('DRAWDOWN_OR_CAPACITY_LIMIT');
  });

  it('a stale, missing, demo or inconsistent quote blocks an open', async () => {
    expect(await rejectedWith(await o21Fixture({ quote: freshQuote({ observedAt: '2026-10-16T13:50:00.000Z' }) }))).toContain('QUOTE_STALE_OR_MISSING');
    expect(await rejectedWith(await o21Fixture({ quote: null }))).toContain('QUOTE_STALE_OR_MISSING');
    expect(await rejectedWith(await o21Fixture({ quote: freshQuote({ production: false }) }))).toContain('MARKET_DATA_NOT_PRODUCTION');
    const crossed = freshQuote();
    expect(await rejectedWith(await o21Fixture({ quote: { ...crossed, bid: crossed.ask, ask: crossed.bid } }))).toContain('QUOTE_INVALID');
  });

  it('an invalid instrument identity blocks: no mapping, a mapping to another eToro id, an unknown instrument', async () => {
    expect(await rejectedWith(await o21Fixture({ etoroMapping: null }))).toContain('INSTRUMENT_MAPPING_MISSING_OR_MISMATCH');
    expect(await rejectedWith(await o21Fixture({ etoroMapping: '9999' }))).toContain('INSTRUMENT_MAPPING_MISSING_OR_MISMATCH');
    expect(await rejectedWith(await o21Fixture(), openInput({ instrumentId: 'UNKNOWN-1' }))).toContain('INSTRUMENT_UNKNOWN_OR_INACTIVE');
  });

  it('sizing, leverage and SL/TP sides are checked', async () => {
    expect(await rejectedWith(await o21Fixture(), openInput({ amount: '1000.01' }))).toContain('ORDER_SIZE_ABOVE_LIMIT');
    expect(await rejectedWith(await o21Fixture(), openInput({ leverage: 2 }))).toContain('LEVERAGE_ABOVE_LIMIT');
    expect(await rejectedWith(await o21Fixture(), openInput({ stopLoss: '210' }))).toContain('STOP_LOSS_OR_TAKE_PROFIT_ON_WRONG_SIDE');
    expect(await rejectedWith(await o21Fixture(), openInput({ orderType: 'mit', triggerRate: '300' }))).toContain('MIT_TRIGGER_TOO_FAR_FROM_QUOTE');
  });

  it('the gate runs again at execute: a quote that went stale after approval refuses the write and keeps the intent APPROVED', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.setQuote(freshQuote({ observedAt: '2026-10-16T13:50:00.000Z' }));
    const refused = await codeOf(f.service.execute(id));
    expect(refused.code).toBe('GATE_REFUSED');
    expect(refused.reasons).toContain('QUOTE_STALE_OR_MISSING');
    expect((await f.service.get(id)).state).toBe('APPROVED');
    expect(f.broker.requests).toHaveLength(0);
    expect(f.attempts.all().map((r) => r.payload.outcome)).toEqual(['gate_refused']);
  });

  it('a kill switch tripped after approval refuses the write', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    await f.killSwitch.latch(trippedKillSwitch());
    expect((await codeOf(f.service.execute(id))).reasons).toContain('KILL_SWITCH_TRIPPED');
    expect(f.broker.requests).toHaveLength(0);
  });

  it('a stale O20 broker sync refuses an open at execute', async () => {
    const f = await o21Fixture({ broker: { connection: 'error', lastSuccessfulSync: '2026-10-16T12:00:00.000Z' } });
    const id = await approvedOpen(f);
    expect((await codeOf(f.service.execute(id))).reasons).toContain('BROKER_NOT_CONNECTED_OR_STALE');
    expect(f.broker.requests).toHaveLength(0);
  });

  it('an expired intent is never executed: it becomes EXPIRED and nothing is sent', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.advance(11 * 60_000);
    expect((await codeOf(f.service.execute(id))).code).toBe('INTENT_STATE_INVALID');
    expect((await f.service.get(id)).state).toBe('EXPIRED');
    expect(f.broker.requests).toHaveLength(0);
  });
});

describe('O21 service: execution disabled and build lock', () => {
  it('execution is refused when ETORO_DEMO_EXECUTION_ENABLED is off', async () => {
    const f = await o21Fixture({ executionEnabled: false });
    const id = await approvedOpen(f);
    expect((await codeOf(f.service.execute(id))).code).toBe('EXECUTION_DISABLED');
    expect(f.broker.requests).toHaveLength(0);
  });

  it('without an explicit lock the service uses BUILD_LOCKS.etoroDemoExecution, which is closed: no write is possible', async () => {
    const f = await o21Fixture({ buildLocked: 'default' });
    const id = await approvedOpen(f);
    expect(f.service.status().etoroDemoExecution.buildLocked).toBe(true);
    expect((await codeOf(f.service.execute(id))).code).toBe('EXECUTION_LOCKED_IN_BUILD');
    expect(f.broker.requests).toHaveLength(0);
  });

  it('a closed lock also refuses a cancel', async () => {
    const f = await o21Fixture({ buildLocked: true });
    const id = await approvedOpen(f);
    expect((await codeOf(f.service.cancel(id))).code).toBe('EXECUTION_LOCKED_IN_BUILD');
    expect(f.broker.requests).toHaveLength(0);
  });
});

describe('O21 service: the one write', () => {
  it('sends exactly one POST to the demo order path, with the auth headers and a fresh x-request-id', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.broker.next(orderAccepted());
    const view = await f.service.execute(id);
    expect(view.state).toBe('SUBMITTED');
    expect(view.brokerOrderId).toBe(13902598);
    expect(f.broker.requests).toHaveLength(1);
    const [request] = f.broker.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('https://public-api.etoro.com/api/v2/trading/execution/demo/orders');
    expect(request?.headers['x-api-key']).toBe(API_KEY_MARKER);
    expect(request?.headers['x-user-key']).toBe(USER_KEY_MARKER);
    expect(request?.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(request?.body).toMatchObject({ action: 'open', transaction: 'buy', instrumentId: ETORO_AAPL_ID, orderType: 'mkt', amount: 500 });
  });

  it('SUBMITTING with the request id is persisted append-only BEFORE the broker write', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    let seenAtWrite: unknown = null;
    f.broker.next((request) => {
      seenAtWrite = f.intents.get(id + ':SUBMITTING')?.payload.requestId ?? 'missing';
      return { status: 200, body: { orderId: 13902598, referenceId: request.headers['x-request-id'] } };
    });
    await f.service.execute(id);
    expect(seenAtWrite).toBe(f.broker.requests[0]?.headers['x-request-id']);
    expect(f.attempts.get(f.intents.get(id + ':SUBMITTING')!.payload.attemptId + ':started')?.payload.requestId).toBe(seenAtWrite);
  });

  it('the referenceId of the answer must echo the x-request-id: another referenceId is not a confirmation (AMBIGUOUS)', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.broker.next({ status: 200, body: { orderId: 13902598, referenceId: '11111111-1111-4111-8111-111111111111' } });
    expect((await f.service.execute(id)).state).toBe('AMBIGUOUS');
  });

  it('a second execute of the same intent sends 0 broker requests', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.broker.next(orderAccepted());
    await f.service.execute(id);
    expect((await codeOf(f.service.execute(id))).code).toBe('INTENT_STATE_INVALID');
    expect(f.broker.requests).toHaveLength(1);
  });

  it('two concurrent executes of one intent send exactly one broker request', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.broker.next(orderAccepted(), orderAccepted());
    const results = await Promise.allSettled([f.service.execute(id), f.service.execute(id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.broker.writes).toHaveLength(1);
  });

  it.each([401, 403])('a %i is REJECTED (BROKER_AUTH_REQUIRED), with no retry', async (status) => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.broker.next({ status });
    const view = await f.service.execute(id);
    expect(view.state).toBe('REJECTED');
    expect(view.history.at(-1)?.reason).toBe('BROKER_AUTH_REQUIRED');
    expect(f.broker.requests).toHaveLength(1);
  });

  it('a 400 is REJECTED (BROKER_REJECTED)', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.broker.next({ status: 400, body: { title: 'validation failed' } });
    expect((await f.service.execute(id)).history.at(-1)?.reason).toBe('BROKER_REJECTED');
  });

  it('a 429 is REJECTED with no retry, and Retry-After blocks the next write locally until it has passed', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.broker.next({ status: 429, headers: { 'retry-after': '60' } });
    expect((await f.service.execute(id)).history.at(-1)?.reason).toBe('BROKER_RATE_LIMITED');
    expect(f.broker.requests).toHaveLength(1);
    const second = await approvedOpen(f, { strategyRunId: 'run-o21-2' });
    expect((await codeOf(f.service.execute(second))).reasons).toContain('BROKER_WRITE_PACING');
    expect(f.broker.requests).toHaveLength(1);
    expect((await f.service.get(second)).state).toBe('APPROVED');
  });

  it('local pacing allows at most 10 writes per minute', async () => {
    const f = await o21Fixture();
    for (let i = 0; i < 10; i++) expect(f.service['deps'].adapter.pacer.tryAcquire(Date.parse('2026-10-16T14:00:00.000Z'))).toBe(true);
    const id = await approvedOpen(f);
    expect((await codeOf(f.service.execute(id))).reasons).toContain('BROKER_WRITE_PACING');
    expect(f.broker.requests).toHaveLength(0);
  });
});

describe('O21 service: AMBIGUOUS execution, never retried', () => {
  const ambiguousAfter = async (answer: Parameters<Fixture['broker']['next']>[0]) => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.broker.next(answer);
    const view = await f.service.execute(id);
    return { f, id, view };
  };

  it('a timeout after the write is AMBIGUOUS, not failed', async () => {
    const { f, view } = await ambiguousAfter({ throws: 'timeout' });
    expect(view.state).toBe('AMBIGUOUS');
    expect(view.history.at(-1)?.reason).toBe('OUTCOME_UNKNOWN_TIMEOUT');
    expect(f.attempts.all().map((r) => r.payload.outcome).filter(Boolean)).toEqual(['ambiguous']);
  });

  it('a network failure after the write is AMBIGUOUS', async () => {
    expect((await ambiguousAfter({ throws: 'network' })).view.state).toBe('AMBIGUOUS');
  });

  it.each([500, 502, 503, 504])('a %i after the write is AMBIGUOUS', async (status) => {
    expect((await ambiguousAfter({ status })).view.state).toBe('AMBIGUOUS');
  });

  it.each([
    ['no orderId', { referenceId: '00000000-0000-4000-8000-000000000000' }],
    ['a string orderId', { orderId: '13902598' }],
    ['not an object', [1, 2]],
  ])('a malformed 2xx (%s) is AMBIGUOUS', async (_label, body) => {
    expect((await ambiguousAfter({ status: 200, body })).view.state).toBe('AMBIGUOUS');
  });

  it('a 2xx that is not JSON is AMBIGUOUS', async () => {
    expect((await ambiguousAfter({ status: 200, raw: '<html>' })).view.state).toBe('AMBIGUOUS');
  });

  it('after AMBIGUOUS there is 0 automatic write retry: execute is refused and sends nothing', async () => {
    const { f, id } = await ambiguousAfter({ throws: 'timeout' });
    expect((await codeOf(f.service.execute(id))).code).toBe('INTENT_STATE_INVALID');
    expect(f.broker.writes).toHaveLength(1);
  });

  it('while an intent is AMBIGUOUS no new open is risk-approved', async () => {
    const { f } = await ambiguousAfter({ throws: 'timeout' });
    const other = await f.service.create(openInput({ strategyRunId: 'run-o21-2', amount: '400' }));
    expect(other.state).toBe('REJECTED');
    expect(other.gateReasons).toContain('AMBIGUOUS_INTENT_UNRESOLVED');
  });

  it('reconciliation is a read by referenceId (the x-request-id of the submission); a found order decides the state', async () => {
    const { f, id } = await ambiguousAfter({ throws: 'timeout' });
    const requestId = f.broker.requests[0]!.headers['x-request-id'];
    f.broker.next(lookupAnswer(3, { positionIds: [2150941015] }));
    const view = await f.service.refresh(id);
    expect(view.state).toBe('FILLED');
    expect(view.history.map((h) => h.state)).toEqual(['CREATED', 'RISK_APPROVED', 'APPROVED', 'SUBMITTING', 'AMBIGUOUS', 'RECONCILED', 'FILLED']);
    const read = f.broker.requests[1]!;
    expect(read.method).toBe('GET');
    expect(read.url).toBe('https://public-api.etoro.com/api/v2/trading/info/demo/orders:lookup?referenceId=' + requestId);
    expect(read.headers['x-request-id']).not.toBe(requestId);
    expect(f.broker.writes).toHaveLength(1);
    expect(f.reconciliations.all().map((r) => r.payload.result)).toEqual(['found']);
  });

  it('no order for the referenceId stays AMBIGUOUS at first, and is concluded "not received" only after the minimum age', async () => {
    const { f, id } = await ambiguousAfter({ throws: 'timeout' });
    f.broker.next({ status: 404 });
    expect((await codeOf(f.service.refresh(id))).code).toBe('RECONCILIATION_PENDING');
    expect((await f.service.get(id)).state).toBe('AMBIGUOUS');
    f.advance(2 * 60_000);
    f.broker.next({ status: 404 });
    const view = await f.service.refresh(id);
    expect(view.state).toBe('REJECTED');
    expect(view.history.at(-1)?.reason).toBe('NOT_RECEIVED_BY_BROKER');
    expect(f.broker.writes).toHaveLength(1);
  });

  it('a read is retried a bounded number of times; a write never is', async () => {
    const { f, id } = await ambiguousAfter({ status: 503 });
    f.broker.next({ status: 503 }, { throws: 'network' }, lookupAnswer(1));
    expect((await f.service.refresh(id)).state).toBe('ACCEPTED');
    expect(f.broker.requests.filter((r) => r.method === 'GET')).toHaveLength(3);
    expect(f.broker.writes).toHaveLength(1);
  });

  it('a SUBMITTING intent without a recorded answer (a crash) becomes AMBIGUOUS and is reconciled, never resent', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    const requestId = '22222222-2222-4222-8222-222222222222';
    await f.intents.append(id + ':SUBMITTING', { schema: 'etoro-demo-intent-event:v1', intentId: id, state: 'SUBMITTING', from: 'APPROVED', at: '2026-10-16T14:00:00.000Z', reason: 'SUBMISSION_STARTED', requestId });
    expect((await codeOf(f.service.refresh(id))).code).toBe('RECONCILIATION_PENDING');
    f.advance(31_000);
    f.broker.next(lookupAnswer(2));
    const view = await f.service.refresh(id);
    expect(view.state).toBe('ACCEPTED');
    expect(f.broker.requests[0]?.url).toContain('referenceId=' + requestId);
    expect(f.broker.writes).toHaveLength(0);
  });
});

describe('O21 service: broker confirmation and status', () => {
  it('SUBMITTED, ACCEPTED and FILLED each point to a stored broker confirmation', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.broker.next(orderAccepted(), lookupAnswer(2), lookupAnswer(3, { positionIds: [2150941015] }));
    await f.service.execute(id);
    await f.service.refresh(id);
    const view = await f.service.refresh(id);
    expect(view.state).toBe('FILLED');
    expect(view.brokerPositionIds).toEqual([2150941015]);
    for (const state of ['SUBMITTED', 'ACCEPTED', 'FILLED'] as const) {
      const confirmationId = f.intents.get(id + ':' + state)?.payload.confirmationId;
      expect(confirmationId, state).toBeDefined();
      expect(f.confirmations.get(confirmationId!), state).toBeDefined();
    }
  });

  it('a lookup for another instrument or with an undocumented status id is refused and changes nothing', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.broker.next(orderAccepted(), lookupAnswer(3, { instrumentId: 4242 }), lookupAnswer(99));
    await f.service.execute(id);
    expect((await codeOf(f.service.refresh(id))).code).toBe('BROKER_RESPONSE_INVALID');
    expect((await codeOf(f.service.refresh(id))).code).toBe('BROKER_RESPONSE_INVALID');
    expect((await f.service.get(id)).state).toBe('SUBMITTED');
  });

  it('a partial fill that becomes final stays PARTIALLY_FILLED', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.broker.next(orderAccepted(), lookupAnswer(5, { positionIds: [1] }), lookupAnswer(9, { positionIds: [1] }));
    await f.service.execute(id);
    expect((await f.service.refresh(id)).state).toBe('PARTIALLY_FILLED');
    expect((await f.service.refresh(id)).state).toBe('PARTIALLY_FILLED');
  });
});

describe('O21 service: cancel only a pending order', () => {
  it('cancels a pending order once with DELETE on the demo path; the cancellation is confirmed by a read', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f, { orderType: 'mit', triggerRate: '195' });
    f.broker.next(orderAccepted(), lookupAnswer(12), { status: 200, body: { token: '5fe065bc-f6f9-4897-a2ce-c4fccef73ff8' } });
    await f.service.execute(id);
    expect((await f.service.refresh(id)).state).toBe('ACCEPTED');
    await f.service.cancel(id);
    const cancel = f.broker.requests[2]!;
    expect(cancel.method).toBe('DELETE');
    expect(cancel.url).toBe('https://public-api.etoro.com/api/v2/trading/execution/demo/orders/13902598');
    expect(cancel.body).toBeUndefined();
    expect((await codeOf(f.service.cancel(id))).code).toBe('INTENT_STATE_INVALID');
    expect(f.broker.writes).toHaveLength(2);
    f.broker.next(lookupAnswer(7));
    expect((await f.service.refresh(id)).state).toBe('CANCELLED');
  });

  it('a filled order cannot be cancelled', async () => {
    const f = await o21Fixture();
    const id = await filledOpen(f);
    const writes = f.broker.writes.length;
    expect((await codeOf(f.service.cancel(id))).code).toBe('INTENT_STATE_INVALID');
    expect(f.broker.writes).toHaveLength(writes);
  });

  it('an order that is pending cancel is not cancelled again', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.broker.next(orderAccepted(), lookupAnswer(6));
    await f.service.execute(id);
    await f.service.refresh(id);
    expect((await codeOf(f.service.cancel(id))).code).toBe('INTENT_STATE_INVALID');
    expect(f.broker.writes).toHaveLength(1);
  });
});

describe('O21 service: close only a known position', () => {
  it('closes the broker-confirmed position of a filled open, on the v1 demo close path with the reference body', async () => {
    const f = await o21Fixture();
    const openId = await filledOpen(f, 2150941015);
    const close = await f.service.create(closeInput(openId));
    expect(close.state).toBe('RISK_APPROVED');
    expect(close.intent.positionId).toBe(2150941015);
    await f.service.approve(close.intentId, HUMAN);
    f.broker.next({ status: 200, body: { orderForClose: { positionID: 2150941015, instrumentID: ETORO_AAPL_ID, unitsToDeduct: 2, orderID: 13904638, orderType: 19, statusID: 1, CID: 1 }, token: '5fe065bc-f6f9-4897-a2ce-c4fccef73ff8' } });
    expect((await f.service.execute(close.intentId)).state).toBe('SUBMITTED');
    const write = f.broker.requests.at(-1)!;
    expect(write.method).toBe('POST');
    expect(write.url).toBe('https://public-api.etoro.com/api/v1/trading/execution/demo/market-close-orders/positions/2150941015');
    expect(write.body).toEqual({ InstrumentID: ETORO_AAPL_ID, UnitsToDeduct: null });
    f.broker.next({ status: 200, body: { orderID: 13904638, CID: 1, statusID: 3, orderType: 19, instrumentID: ETORO_AAPL_ID, positions: [{ positionID: 2150941015 }] } });
    expect((await f.service.refresh(close.intentId)).state).toBe('FILLED');
    expect(f.broker.requests.at(-1)?.url).toBe('https://public-api.etoro.com/api/v1/trading/info/demo/close-orders/13904638');
  });

  it('a close is risk-reducing: a tripped kill switch, no safety decision and a stale O20 sync do not block it', async () => {
    const g = await o21Fixture();
    const id = await filledOpen(g);
    await g.killSwitch.latch(trippedKillSwitch());
    g.setSafety(null);
    // A non-empty demo portfolio makes the O20 sync fail: its status is error and stale. A known position stays closable.
    g.setBroker({ connection: 'error', lastSuccessfulSync: null });
    const close = await g.service.create(closeInput(id));
    expect(close.state).toBe('RISK_APPROVED');
    expect(close.gateReasons).toEqual([]);
    await g.service.approve(close.intentId, HUMAN);
    g.broker.next({ status: 200, body: { orderForClose: { positionID: 2150941015, instrumentID: ETORO_AAPL_ID, orderID: 13904638, statusID: 1 } } });
    expect((await g.service.execute(close.intentId)).state).toBe('SUBMITTED');
  });

  it('the identity checks still apply to a close: a removed mapping refuses it', async () => {
    const f = await o21Fixture();
    const id = await filledOpen(f);
    await f.service['deps'].registry.closeMapping(
      { instrumentId: AAPL.instrumentId, provider: 'etoro', providerSymbol: String(ETORO_AAPL_ID), validFrom: '2026-10-01T00:00:00.000Z', validTo: '2026-10-16T14:00:00.000Z' },
      { at: '2026-10-16T14:00:00.000Z', by: { kind: 'human', id: 'mapping-owner' }, reason: 'O21 test: mapping closed' },
    );
    const close = await f.service.create(closeInput(id));
    expect(close.state).toBe('REJECTED');
    expect(close.gateReasons).toContain('INSTRUMENT_MAPPING_MISSING_OR_MISMATCH');
  });

  it('an unknown close target is refused: a random intent, an open that is not filled, another instrument or side', async () => {
    const f = await o21Fixture();
    expect((await codeOf(f.service.create(closeInput('eint_' + 'c'.repeat(40))))).code).toBe('INTENT_INVALID');
    const submitted = await approvedOpen(f);
    f.broker.next(orderAccepted());
    await f.service.execute(submitted);
    expect((await codeOf(f.service.create(closeInput(submitted)))).code).toBe('INTENT_INVALID');
    const g = await o21Fixture();
    const filled = await filledOpen(g);
    expect((await codeOf(g.service.create(closeInput(filled, { side: 'sell' })))).code).toBe('INTENT_INVALID');
    expect((await codeOf(g.service.create(closeInput(filled, { etoroInstrumentId: 4242 })))).code).toBe('INTENT_INVALID');
    expect(g.broker.writes).toHaveLength(1);
  });

  it('a target whose position was only claimed by a submission, never confirmed by a status read, is not known', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f);
    f.broker.next(orderAccepted(), lookupAnswer(3, { positionIds: [] }));
    await f.service.execute(id);
    expect((await f.service.refresh(id)).state).toBe('FILLED');
    expect((await codeOf(f.service.create(closeInput(id)))).code).toBe('INTENT_INVALID');
  });

  it('a second close of the same position is refused while the first is active', async () => {
    const f = await o21Fixture();
    const id = await filledOpen(f);
    const first = await f.service.create(closeInput(id));
    expect(first.state).toBe('RISK_APPROVED');
    const second = await f.service.create(closeInput(id, { strategyRunId: 'run-o21-close-2' }));
    expect(second.state).toBe('REJECTED');
    expect(second.gateReasons).toContain('CLOSE_TARGET_ALREADY_CLOSING');
  });
});

describe('O21 service: no secret anywhere', () => {
  it('no key, no auth header and no raw broker text in any stored record, view or error', async () => {
    const f = await o21Fixture();
    const messages: string[] = [];
    const a = await approvedOpen(f);
    f.broker.next(orderAccepted(), { status: 200, body: { ...((lookupAnswer(4) as { body: Record<string, unknown> }).body), status: { id: 4, name: 'Rejected', errorCode: 77, errorMessage: 'BROKER-FREE-TEXT ' + API_KEY_MARKER } } });
    await f.service.execute(a);
    await f.service.refresh(a);
    const b = await approvedOpen(f, { strategyRunId: 'run-o21-2' });
    f.broker.next({ status: 401, body: { detail: 'token ' + USER_KEY_MARKER } });
    await f.service.execute(b);
    messages.push((await codeOf(f.service.execute(b))).code);
    const views = JSON.stringify(await f.service.list());
    const all = stored(f) + views + messages.join(' ');
    expect(all).not.toContain(API_KEY_MARKER);
    expect(all).not.toContain(USER_KEY_MARKER);
    expect(all.toLowerCase()).not.toContain('x-api-key');
    expect(all.toLowerCase()).not.toContain('x-user-key');
    expect(all).not.toContain('BROKER-FREE-TEXT');
    expect(all).not.toContain('accountId');
    expect(f.confirmations.all().some((r) => r.payload.errorCode === 77)).toBe(true);
    // The keys were used on the wire, and every request had its own x-request-id.
    expect(f.broker.requests.every((r) => r.headers['x-api-key'] === API_KEY_MARKER)).toBe(true);
    const ids = f.broker.requests.map((r) => r.headers['x-request-id']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a DemoExecutionError message never contains a key', async () => {
    for (const code of ['BROKER_AUTH_REQUIRED', 'EXECUTION_AMBIGUOUS', 'GATE_REFUSED'] as const) {
      const message = new DemoExecutionError(code, 'detail').message;
      expect(message).not.toContain(API_KEY_MARKER);
      expect(message).not.toContain(USER_KEY_MARKER);
    }
  });
});
