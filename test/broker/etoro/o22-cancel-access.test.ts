// O22 cancel review: a cancel write is sent only for the order the broker named for the intent's one open attempt, and only when that
// attempt was sent with the configured broker access (same credentials; not a verified account). Otherwise nothing is sent, the
// refusal is recorded, and the at-most-once rule of cancel is unchanged. No network: scripted broker answers.
// Two processes on PostgreSQL: test/pg/o22-cancel-access.pg.test.ts.
import { describe, expect, it, vi } from 'vitest';

// TEST ONLY: this module exercises the write path, so it replaces the compile-time lock for this module only.
vi.mock('../../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});
import { cancelRefusals, type CancelFacts } from '../../../src/broker/etoro/execution/cancel-guard.js';
import { DemoExecutionError } from '../../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import { HUMAN, TEST_ACCESS, TEST_ACCESS_KEY, approvedOpen, lookupAnswer, o21Fixture, orderAccepted, testAccess, type Fixture } from './o21-fixture.js';

const OTHER_USER_KEY = 'O22-OTHER-ACCOUNT-USER-KEY-MARKER-000000000000000000000000003';
const K2 = Object.freeze({ id: 'test-k2', secret: 'O22-TEST-ACCESS-HMAC-KEY-MARKER-ROTATED-fedcba9876543210' });
const cancelAccepted = { status: 200, body: { token: '5fe065bc-f6f9-4897-a2ce-c4fccef73ff8' } };

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reasons: readonly string[] }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DemoExecutionError) return { code: error.code, reasons: error.reasons };
    throw error;
  }
  throw new Error('expected a refusal');
}

/** An accepted, still pending (MIT) open: the only state in which a cancel is allowed. */
async function pendingOpen(f: Fixture): Promise<string> {
  const id = await approvedOpen(f, { orderType: 'mit', triggerRate: '195' });
  f.broker.next(orderAccepted(), lookupAnswer(12));
  await f.service.execute(id, HUMAN);
  expect((await f.service.refresh(id)).state).toBe('ACCEPTED');
  return id;
}

const deletes = (f: Fixture) => f.broker.requests.filter((r) => r.method === 'DELETE').length;

describe('O22 cancel review: the cancel is bound to the open attempt and its access', () => {
  it('the same configured access: one cancel is sent, stamped; a second one is refused (at most once)', async () => {
    const f = await o21Fixture();
    const id = await pendingOpen(f);
    f.broker.next(cancelAccepted);
    await f.service.cancel(id, HUMAN);
    expect(deletes(f)).toBe(1);
    const started = f.attempts.all().map((r) => r.payload).filter((a) => a.operation === 'demo.order.cancel' && a.phase === 'started');
    expect(started.map((a) => a.access)).toEqual([TEST_ACCESS.stamp()]);
    expect((await refusal(f.service.cancel(id, HUMAN))).code).toBe('INTENT_STATE_INVALID');
    expect(deletes(f)).toBe(1);
  });

  it('a process configured with other eToro credentials (another account) sends no cancel; the refusal is recorded', async () => {
    const f = await o21Fixture();
    const id = await pendingOpen(f);
    const other = await o21Fixture({ stores: f.stores, sharedBroker: f.broker, access: testAccess({ userKey: OTHER_USER_KEY }) });
    expect(await refusal(other.service.cancel(id, HUMAN))).toEqual({ code: 'GATE_REFUSED', reasons: ['CANCEL_TARGET_OPEN_ACCESS_MISMATCH'] });
    expect(deletes(f)).toBe(0);
    const refused = other.attempts.all().map((r) => r.payload).filter((a) => a.phase === 'refused');
    expect(refused.at(-1)?.reasons).toEqual(['CANCEL_TARGET_OPEN_ACCESS_MISMATCH']);
    // The original configuration can still cancel it (the refusal spent no attempt number).
    f.broker.next(cancelAccepted);
    await f.service.cancel(id, HUMAN);
    expect(deletes(f)).toBe(1);
  });

  it('a process without an access key sends no cancel (fail closed)', async () => {
    const f = await o21Fixture();
    const id = await pendingOpen(f);
    const bare = await o21Fixture({ stores: f.stores, sharedBroker: f.broker, access: null });
    expect(await refusal(bare.service.cancel(id, HUMAN))).toEqual({ code: 'GATE_REFUSED', reasons: ['CANCEL_TARGET_OPEN_ACCESS_NOT_CONFIGURED'] });
    expect(deletes(f)).toBe(0);
  });

  it('key rotation: with the previous key the cancel is allowed; without it, it is refused (unknown key)', async () => {
    const f = await o21Fixture();
    const id = await pendingOpen(f);
    const lost = await o21Fixture({ stores: f.stores, sharedBroker: f.broker, access: testAccess({ current: K2 }) });
    expect((await refusal(lost.service.cancel(id, HUMAN))).reasons).toEqual(['CANCEL_TARGET_OPEN_ACCESS_KEY_UNKNOWN']);
    const rotated = await o21Fixture({ stores: f.stores, sharedBroker: f.broker, access: testAccess({ current: K2, previous: TEST_ACCESS_KEY }) });
    f.broker.next(cancelAccepted);
    await rotated.service.cancel(id, HUMAN);
    expect(deletes(f)).toBe(1);
    const started = rotated.attempts.all().map((r) => r.payload).filter((a) => a.operation === 'demo.order.cancel' && a.phase === 'started');
    expect(started.map((a) => a.access?.keyId)).toEqual(['test-k2']);
  });

  it('an order found by its reference after an ambiguous submission is bound to the attempt: the cancel is allowed', async () => {
    const f = await o21Fixture();
    const id = await approvedOpen(f, { orderType: 'mit', triggerRate: '195' });
    f.broker.next({ throws: 'timeout' });
    expect((await f.service.execute(id, HUMAN)).state).toBe('AMBIGUOUS');
    f.broker.next(lookupAnswer(12));
    expect((await f.service.refresh(id)).state).toBe('ACCEPTED');
    expect(f.confirmations.all().some((r) => r.payload.kind === 'open_accepted')).toBe(false);
    f.broker.next(cancelAccepted);
    await f.service.cancel(id, HUMAN);
    expect(deletes(f)).toBe(1);
  });
});

describe('O22 cancel review: the rule (pure)', () => {
  const attempt = { requestId: 'req-1', access: TEST_ACCESS.stamp() };
  const facts = (over: Partial<CancelFacts> = {}): CancelFacts => ({
    brokerOrderId: 13902598,
    openAttempts: [attempt],
    acceptedAnswers: [{ requestId: 'req-1', brokerOrderId: 13902598 }],
    foundReconciliations: [],
    checkAccess: (stamp) => TEST_ACCESS.check(stamp),
    ...over,
  });

  it.each([
    ['complete facts', {}, []],
    ['no open attempt', { openAttempts: [] }, ['CANCEL_OPEN_ATTEMPT_NOT_UNIQUE']],
    ['two open attempts', { openAttempts: [attempt, { ...attempt, requestId: 'req-2' }] }, ['CANCEL_OPEN_ATTEMPT_NOT_UNIQUE']],
    ['the accepted answer belongs to another request', { acceptedAnswers: [{ requestId: 'req-x', brokerOrderId: 13902598 }] }, ['CANCEL_ORDER_NOT_BOUND_TO_ATTEMPT']],
    ['the accepted answer names another order', { acceptedAnswers: [{ requestId: 'req-1', brokerOrderId: 1 }] }, ['CANCEL_ORDER_NOT_BOUND_TO_ATTEMPT']],
    ['no order id', { brokerOrderId: null }, ['CANCEL_ORDER_NOT_BOUND_TO_ATTEMPT']],
    ['a checked reconciliation of the reference binds it', { acceptedAnswers: [], foundReconciliations: [{ referenceId: 'req-1', brokerOrderId: 13902598, checked: true }] }, []],
    ['an unchecked reconciliation does not', { acceptedAnswers: [], foundReconciliations: [{ referenceId: 'req-1', brokerOrderId: 13902598 }] }, ['CANCEL_ORDER_NOT_BOUND_TO_ATTEMPT']],
    ['a reconciliation of another reference does not', { acceptedAnswers: [], foundReconciliations: [{ referenceId: 'req-x', brokerOrderId: 13902598, checked: true }] }, ['CANCEL_ORDER_NOT_BOUND_TO_ATTEMPT']],
    ['the attempt carries no stamp (records before the fingerprint)', { openAttempts: [{ requestId: 'req-1' }] }, ['CANCEL_TARGET_OPEN_ACCESS_NOT_SHOWN']],
    ['the attempt was sent with other credentials', { openAttempts: [{ requestId: 'req-1', access: testAccess({ userKey: OTHER_USER_KEY }).stamp() }] }, ['CANCEL_TARGET_OPEN_ACCESS_MISMATCH']],
  ] as const)('%s', (_name, over, expected) => {
    expect(cancelRefusals(facts(over as Partial<CancelFacts>))).toEqual(expected);
  });
});
