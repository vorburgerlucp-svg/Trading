// O22: the one controlled demo trading cycle under DEMO_E2E_CYCLE_POLICY, end to end against scripted broker answers (no network):
// one open, its broker confirmation, one close of exactly that position, and then nothing. The cycle budget is spent by every
// submission whatever its outcome (accepted, rejected, timeout, crash), it is checked in the atomic reservation step, so it holds
// across processes, and it can never be reset. Every broker write is counted.
import { describe, expect, it, vi } from 'vitest';

// TEST ONLY: this module exercises the write path, so it replaces the compile-time lock for this module only. The locked build is
// tested without any mock (o21-build-lock.test.ts, and the runtime test of this package).
vi.mock('../../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});
import { DEFAULT_DEMO_EXECUTION_POLICY, DEMO_E2E_CYCLE_POLICY, DEMO_E2E_CYCLE_POLICY_VERSION, type GateQuote } from '../../../src/broker/etoro/execution/execution-gate.js';
import { DemoExecutionError } from '../../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import { Decimal } from '../../../src/money/decimal.js';
import { CREATOR, ETORO_AAPL_ID, ETORO_MSFT_ID, HUMAN, MSFT, ScriptedBroker, closeInput, freshQuote, inMemoryStores, lookupAnswer, o21Fixture, openInput, orderAccepted, trippedKillSwitch, type Fixture } from './o21-fixture.js';

const POSITION = 2150941015;
const MSFT_OPEN = { instrumentId: MSFT.instrumentId, etoroInstrumentId: ETORO_MSFT_ID, strategyRunId: 'run-o22-second' };

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reasons: readonly string[] }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DemoExecutionError) return { code: error.code, reasons: error.reasons };
    throw error;
  }
  throw new Error('expected a DemoExecutionError');
}

function cycle(options: Parameters<typeof o21Fixture>[0] = {}): Promise<Fixture> {
  return o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, ...options });
}

/** The cycle's open: a market buy of 100 USD at leverage 1. */
async function approvedCycleOpen(f: Fixture, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await f.service.create(openInput({ amount: '100', ...overrides }), CREATOR);
  expect(created.state, created.gateReasons.join(',')).toBe('RISK_APPROVED');
  await f.service.approve(created.intentId, HUMAN);
  return created.intentId;
}

async function filledCycleOpen(f: Fixture): Promise<string> {
  const intentId = await approvedCycleOpen(f);
  f.broker.next(orderAccepted());
  expect((await f.service.execute(intentId, HUMAN)).state).toBe('SUBMITTED');
  f.broker.next(lookupAnswer(3, { positionIds: [POSITION] }));
  expect((await f.service.refresh(intentId)).state).toBe('FILLED');
  return intentId;
}

async function approvedClose(f: Fixture, openIntentId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await f.service.create(closeInput(openIntentId, overrides), CREATOR);
  expect(created.state, created.gateReasons.join(',')).toBe('RISK_APPROVED');
  await f.service.approve(created.intentId, HUMAN);
  return created.intentId;
}

const closeSubmitted = { status: 200, body: { orderForClose: { positionID: POSITION, instrumentID: ETORO_AAPL_ID, orderID: 13904638, statusID: 1 }, token: '5fe065bc-f6f9-4897-a2ce-c4fccef73ff8' } };
const closeFilled = { status: 200, body: { orderID: 13904638, statusID: 3, instrumentID: ETORO_AAPL_ID, positions: [{ positionID: POSITION }] } };

describe('O22 cycle policy: a code constant, stricter than the O21 default in every field', () => {
  it('one open of at most 100 USD at leverage 1, one position, and a budget of one open and one close submission', () => {
    expect(DEMO_E2E_CYCLE_POLICY).toEqual({
      version: DEMO_E2E_CYCLE_POLICY_VERSION,
      maxOrderInvestmentUsd: '100',
      maxLeverage: 1,
      maxOpenPositions: 1,
      maxGrossExposureUsd: '100',
      maxQuoteAgeMs: 60_000,
      maxSafetyDecisionAgeMs: 300_000,
      maxBrokerSyncAgeMs: 300_000,
      maxTriggerDistanceBp: 1000,
      maxOpenSubmissions: 1,
      maxCloseSubmissions: 1,
    });
    expect(Object.isFrozen(DEMO_E2E_CYCLE_POLICY)).toBe(true);
    const d = DEFAULT_DEMO_EXECUTION_POLICY;
    const c = DEMO_E2E_CYCLE_POLICY;
    expect(Decimal.from(c.maxOrderInvestmentUsd).lte(d.maxOrderInvestmentUsd)).toBe(true);
    expect(Decimal.from(c.maxGrossExposureUsd).lte(d.maxGrossExposureUsd)).toBe(true);
    expect(c.maxLeverage).toBeLessThanOrEqual(d.maxLeverage);
    expect(c.maxOpenPositions).toBeLessThanOrEqual(d.maxOpenPositions);
    expect(c.maxQuoteAgeMs).toBeLessThanOrEqual(d.maxQuoteAgeMs);
    expect(c.maxSafetyDecisionAgeMs).toBeLessThanOrEqual(d.maxSafetyDecisionAgeMs);
    expect(c.maxBrokerSyncAgeMs).toBeLessThanOrEqual(d.maxBrokerSyncAgeMs);
    expect(d.maxOpenSubmissions).toBeNull();
    expect(d.maxCloseSubmissions).toBeNull();
  });

  it('an open above 100 USD is refused at creation, before anything could be sent', async () => {
    const f = await cycle();
    const created = await f.service.create(openInput({ amount: '100.01' }), CREATOR);
    expect(created.state).toBe('REJECTED');
    expect(created.gateReasons).toEqual(expect.arrayContaining(['ORDER_SIZE_ABOVE_LIMIT', 'GROSS_EXPOSURE_ABOVE_LIMIT']));
    const leveraged = await f.service.create(openInput({ amount: '50', leverage: 2, strategyRunId: 'run-lev' }), CREATOR);
    expect(leveraged.gateReasons).toContain('LEVERAGE_ABOVE_LIMIT');
    expect(f.broker.requests).toHaveLength(0);
  });

  it('the cycle budget is part of the verdict and recorded with the cycle policy version', async () => {
    const f = await cycle();
    const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
    const event = f.intents.all().find((r) => r.payload.intentId === created.intentId && r.payload.state === 'RISK_APPROVED')!.payload;
    expect(event.gate?.policyVersion).toBe(DEMO_E2E_CYCLE_POLICY_VERSION);
    expect(event.gate?.checks.cycleOpenBudget).toBe('pass');
    expect(event.gate?.checks.cycleCloseBudget).toBe('not_applicable');
  });
});

describe('O22 cycle: one open, its confirmation, one close of exactly that position, then nothing', () => {
  it('the full cycle sends exactly two writes; every later open or close is refused by the spent budget', async () => {
    const f = await cycle();
    const open = await filledCycleOpen(f);
    expect((await f.service.get(open)).brokerPositionIds).toEqual([POSITION]);

    // A second open while the first position is open: refused at creation (budget, and the one-position limit).
    const second = await f.service.create(openInput({ amount: '100', ...MSFT_OPEN }), CREATOR);
    expect(second.state).toBe('REJECTED');
    expect(second.gateReasons).toContain('CYCLE_OPEN_BUDGET_EXHAUSTED');

    // The close needs a new human approval and binds the broker-confirmed position, never one from the request.
    const close = await approvedClose(f, open);
    expect((await f.service.get(close)).intent.positionId).toBe(POSITION);
    f.broker.next(closeSubmitted);
    expect((await f.service.execute(close, HUMAN)).state).toBe('SUBMITTED');
    f.broker.next(closeFilled);
    expect((await f.service.refresh(close)).state).toBe('FILLED');

    // Test end: no further open, and no further close of anything.
    const third = await f.service.create(openInput({ amount: '100', strategyRunId: 'run-o22-after', createdAt: '2026-10-16T13:59:40.000Z' }), CREATOR);
    expect(third.state).toBe('REJECTED');
    expect(third.gateReasons).toContain('CYCLE_OPEN_BUDGET_EXHAUSTED');
    const secondClose = await f.service.create(closeInput(open, { strategyRunId: 'run-o22-close-2' }), CREATOR);
    expect(secondClose.state).toBe('REJECTED');
    expect(secondClose.gateReasons).toEqual(expect.arrayContaining(['CLOSE_TARGET_UNKNOWN', 'CLOSE_TARGET_ALREADY_CLOSING', 'CYCLE_CLOSE_BUDGET_EXHAUSTED']));
    expect(f.broker.writes.map((w) => w.method + ' ' + w.url)).toEqual([
      'POST https://public-api.etoro.com/api/v2/trading/execution/demo/orders',
      'POST https://public-api.etoro.com/api/v1/trading/execution/demo/market-close-orders/positions/' + POSITION,
    ]);
    expect(await f.service.cycleBudget()).toEqual({ policyVersion: DEMO_E2E_CYCLE_POLICY_VERSION, maxOpenSubmissions: 1, maxCloseSubmissions: 1, openSubmissions: 1, closeSubmissions: 1 });
  });

  it('the open is a market buy of the amount, at leverage 1, in USD, with a fresh x-request-id; units are not sent', async () => {
    const f = await cycle();
    const intentId = await approvedCycleOpen(f, { stopLoss: null, takeProfit: null });
    f.broker.next(orderAccepted());
    await f.service.execute(intentId, HUMAN);
    const write = f.broker.writes[0]!;
    // orderCurrency is sent as the O21 body builder writes it ("usd", as in the reference: "typically usd").
    expect(write.body).toEqual({ action: 'open', transaction: 'buy', instrumentId: ETORO_AAPL_ID, orderType: 'mkt', amount: 100, orderCurrency: 'usd', leverage: 1 });
    expect(write.headers['x-request-id']).toBe(f.requestIds.at(-1));
  });

  it('a spent open budget refuses a further open even after the first one was closed, in another process on the same stores', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const a = await cycle({ stores, sharedBroker: broker });
    const open = await filledCycleOpen(a);
    const close = await approvedClose(a, open);
    broker.next(closeSubmitted);
    await a.service.execute(close, HUMAN);
    broker.next(closeFilled);
    await a.service.refresh(close);
    const b = await cycle({ stores, sharedBroker: broker });
    const again = await b.service.create(openInput({ amount: '100', strategyRunId: 'run-o22-b', createdAt: '2026-10-16T13:59:40.000Z' }), CREATOR);
    expect(again.gateReasons).toEqual(['CYCLE_OPEN_BUDGET_EXHAUSTED']);
    expect(broker.writes).toHaveLength(2);
  });
});

describe('O22 cycle: a timeout, an unclear answer or a rejection never leads to a second order', () => {
  it('an open that times out is AMBIGUOUS; no second open is possible; a negative lookup decides nothing; 1 write in total', async () => {
    const f = await cycle();
    const open = await approvedCycleOpen(f);
    f.broker.next({ throws: 'timeout' });
    expect((await f.service.execute(open, HUMAN)).state).toBe('AMBIGUOUS');
    expect((await refusal(f.service.execute(open, HUMAN))).code).toBe('INTENT_STATE_INVALID');
    const second = await f.service.create(openInput({ amount: '100', ...MSFT_OPEN }), CREATOR);
    expect(second.gateReasons).toEqual(expect.arrayContaining(['AMBIGUOUS_INTENT_UNRESOLVED', 'CYCLE_OPEN_BUDGET_EXHAUSTED']));
    f.broker.next({ status: 404 }, { status: 404 }, { status: 404 });
    expect((await refusal(f.service.refresh(open))).code).toBe('RECONCILIATION_PENDING');
    expect((await f.service.get(open)).state).toBe('AMBIGUOUS');
    expect(f.broker.writes).toHaveLength(1);
    // The lookup is by the original request id: no new request id is ever made for the write.
    const lookups = f.broker.requests.filter((r) => r.method === 'GET');
    expect(lookups.length).toBeGreaterThan(0);
    for (const l of lookups) expect(l.url).toContain('referenceId=' + f.broker.writes[0]!.headers['x-request-id']);
  });

  it('an AMBIGUOUS open found by its referenceId takes the broker state, and the budget stays spent', async () => {
    const f = await cycle();
    const open = await approvedCycleOpen(f);
    f.broker.next({ status: 502 });
    expect((await f.service.execute(open, HUMAN)).state).toBe('AMBIGUOUS');
    f.broker.next(lookupAnswer(3, { positionIds: [POSITION] }));
    expect((await f.service.refresh(open)).state).toBe('FILLED');
    const second = await f.service.create(openInput({ amount: '100', ...MSFT_OPEN }), CREATOR);
    expect(second.gateReasons).toContain('CYCLE_OPEN_BUDGET_EXHAUSTED');
    expect(f.broker.writes).toHaveLength(1);
  });

  it('a rejected open (403: the key may lack demo write) spends the budget too: a new attempt needs a code change', async () => {
    const f = await cycle();
    const open = await approvedCycleOpen(f);
    f.broker.next({ status: 403 });
    expect((await f.service.execute(open, HUMAN)).state).toBe('REJECTED');
    const second = await f.service.create(openInput({ amount: '100', ...MSFT_OPEN }), CREATOR);
    expect(second.gateReasons).toEqual(['CYCLE_OPEN_BUDGET_EXHAUSTED']);
    expect(f.broker.writes).toHaveLength(1);
  });

  it('a close that times out stays AMBIGUOUS: it is not reconciled, and no second close can be sent', async () => {
    const f = await cycle();
    const open = await filledCycleOpen(f);
    const close = await approvedClose(f, open);
    f.broker.next({ throws: 'network' });
    expect((await f.service.execute(close, HUMAN)).state).toBe('AMBIGUOUS');
    const before = f.broker.requests.length;
    expect((await refusal(f.service.refresh(close))).code).toBe('RECONCILIATION_PENDING');
    expect(f.broker.requests.length).toBe(before);
    const again = await f.service.create(closeInput(open, { strategyRunId: 'run-o22-close-2' }), CREATOR);
    expect(again.state).toBe('REJECTED');
    expect(again.gateReasons).toEqual(expect.arrayContaining(['CLOSE_TARGET_ALREADY_CLOSING', 'CYCLE_CLOSE_BUDGET_EXHAUSTED']));
    expect(f.broker.writes).toHaveLength(2);
  });

  it('a rejected close spends the close budget: no second close attempt', async () => {
    const f = await cycle();
    const open = await filledCycleOpen(f);
    const close = await approvedClose(f, open);
    f.broker.next({ status: 400 });
    expect((await f.service.execute(close, HUMAN)).state).toBe('REJECTED');
    const again = await f.service.create(closeInput(open, { strategyRunId: 'run-o22-close-2' }), CREATOR);
    expect(again.gateReasons).toEqual(['CYCLE_CLOSE_BUDGET_EXHAUSTED']);
    expect(f.broker.writes).toHaveLength(2);
  });
});

describe('O22 cycle: the product type stated by the broker', () => {
  it('the order status keeps asset.settlementType; an undocumented value is refused and changes nothing', async () => {
    const f = await cycle();
    const open = await approvedCycleOpen(f);
    f.broker.next(orderAccepted());
    await f.service.execute(open, HUMAN);
    const bad = lookupAnswer(3, { positionIds: [POSITION] }) as { status: number; body: { asset: Record<string, unknown> } };
    bad.body.asset.settlementType = 'spot';
    f.broker.next(bad);
    expect((await refusal(f.service.refresh(open))).code).toBe('BROKER_RESPONSE_INVALID');
    expect((await f.service.get(open)).state).toBe('SUBMITTED');
    f.broker.next(lookupAnswer(3, { positionIds: [POSITION] }));
    const filled = await f.service.refresh(open);
    expect(filled.state).toBe('FILLED');
    expect(filled.brokerSettlementType).toBe('real');
    expect(f.broker.writes).toHaveLength(1);
  });
});

describe('O22 cycle: crash and restart', () => {
  it('a process that crashed after SUBMITTING leaves the budget spent; the restarted process sends nothing and treats it as AMBIGUOUS', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const a = await cycle({ stores, sharedBroker: broker });
    const open = await approvedCycleOpen(a);
    // The crash: SUBMITTING is persisted with its request id, and the process dies before the write or before recording an answer.
    await a.intents.append(open + ':SUBMITTING', { schema: 'etoro-demo-intent-event:v1', intentId: open, state: 'SUBMITTING', from: 'APPROVED', at: a.clock.now.toISOString(), reason: 'SUBMISSION_STARTED', requestId: '00000000-0000-4000-8000-00000000c0de', attemptId: 'eatt_crash' });

    const b = await cycle({ stores, sharedBroker: broker });
    expect((await refusal(b.service.execute(open, HUMAN))).code).toBe('INTENT_STATE_INVALID');
    const second = await b.service.create(openInput({ amount: '100', ...MSFT_OPEN }), CREATOR);
    expect(second.gateReasons).toEqual(expect.arrayContaining(['AMBIGUOUS_INTENT_UNRESOLVED', 'CYCLE_OPEN_BUDGET_EXHAUSTED']));
    expect((await refusal(b.service.refresh(open))).code).toBe('RECONCILIATION_PENDING');
    b.advance(31_000);
    broker.next({ status: 404 }, { status: 404 }, { status: 404 });
    expect((await refusal(b.service.refresh(open))).code).toBe('RECONCILIATION_PENDING');
    expect((await b.service.get(open)).state).toBe('AMBIGUOUS');
    expect(broker.writes).toHaveLength(0);
  });
});

describe('O22 cycle: concurrent requests across two processes', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('two approved opens on different instruments race; the first is rejected by the broker; the reservation still refuses the second by budget alone', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const reached = deferred();
    const hold = deferred();
    let holding = false;
    const quoteSource = async (): Promise<GateQuote | null> => {
      if (holding) {
        reached.resolve();
        await hold.promise;
      }
      return freshQuote();
    };
    const a = await cycle({ stores, sharedBroker: broker });
    const b = await cycle({ stores, sharedBroker: broker, quoteSource });
    const x = await approvedCycleOpen(a);
    const y = await approvedCycleOpen(b, { ...MSFT_OPEN, createdAt: '2026-10-16T13:59:30.000Z' });
    holding = true;
    const late = b.service.execute(y, HUMAN);
    await reached.promise;
    broker.next({ status: 403 });
    expect((await a.service.execute(x, HUMAN)).state).toBe('REJECTED');
    hold.resolve();
    const refused = await refusal(late);
    expect(refused.code).toBe('GATE_REFUSED');
    expect(refused.reasons).toEqual(['CYCLE_OPEN_BUDGET_EXHAUSTED']);
    expect(broker.writes).toHaveLength(1);
    expect((await b.service.get(y)).state).toBe('APPROVED');
  });

  it('the same approved open executed twice at once: exactly one write', async () => {
    const f = await cycle();
    const open = await approvedCycleOpen(f);
    f.broker.next(orderAccepted());
    const results = await Promise.allSettled([f.service.execute(open, HUMAN), f.service.execute(open, HUMAN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.broker.writes).toHaveLength(1);
  });
});

describe('O22 cycle: kill switch and safety', () => {
  it('a tripped kill switch refuses the open and still allows the close of the known position', async () => {
    const f = await cycle();
    const open = await filledCycleOpen(f);
    await f.killSwitch.latch(trippedKillSwitch());
    const blocked = await f.service.create(openInput({ amount: '100', ...MSFT_OPEN }), CREATOR);
    expect(blocked.gateReasons).toContain('KILL_SWITCH_TRIPPED');
    const close = await approvedClose(f, open);
    f.broker.next(closeSubmitted);
    expect((await f.service.execute(close, HUMAN)).state).toBe('SUBMITTED');
    expect(f.broker.writes).toHaveLength(2);
  });

  it('without a safety source every open is refused with PORTFOLIO_SAFETY_NOT_CONNECTED, whatever else holds', async () => {
    const f = await cycle({ safety: null });
    const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
    expect(created.state).toBe('REJECTED');
    expect(created.gateReasons).toEqual(['PORTFOLIO_SAFETY_NOT_CONNECTED', 'DRAWDOWN_OR_CAPACITY_LIMIT']);
    expect(f.broker.requests).toHaveLength(0);
  });
});
