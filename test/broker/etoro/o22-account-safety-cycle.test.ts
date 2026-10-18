// O22 B2 variant A, as it would behave once a non-empty /demo/pnl has been observed live: the demo account safety source over a
// fixture transport (one GET per evaluation, fail closed on every read failure), its risk day, and the controlled cycle with that
// source in the gate. The hand-opened position counts and blocks the cycle open; a close never depends on the safety read.
// No network; the pnl bodies are REFERENCE_SCHEMA test data, NOT a live response.
import { describe, expect, it, vi } from 'vitest';

// TEST ONLY, for this module: the compile-time lock is opened and the evidence record says "observed", to exercise the paths that
// exist once both are released by reviewed code changes. In the build both stay closed (o22-demo-account-safety.test.ts,
// o22-runtime.test.ts).
vi.mock('../../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});
vi.mock('../../../src/broker/etoro/execution/demo-account-evidence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/broker/etoro/execution/demo-account-evidence.js')>();
  return { ...actual, DEMO_ACCOUNT_VALUATION_EVIDENCE: Object.freeze({ ...actual.DEMO_ACCOUNT_VALUATION_EVIDENCE, nonEmptyPnlLiveObserved: true, evidenceRef: 'TEST-ONLY' }) };
});
import { BrokerError } from '../../../src/broker/broker-errors.js';
import { DEMO_E2E_CYCLE_POLICY } from '../../../src/broker/etoro/execution/execution-gate.js';
import { EtoroDemoAccountSafetySource, type DemoAccountValuationRecord } from '../../../src/broker/etoro/execution/demo-account-safety.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import { PortfolioKillSwitchStore } from '../../../src/safety/portfolio-kill-switch-store.js';
import type { KillSwitchState } from '../../../src/safety/portfolio-safety-envelope.js';
import { FixtureEtoroTransport } from './o20-fixture.js';
import { CREATOR, ETORO_AAPL_ID, HUMAN, closeInput, lookupAnswer, o21Fixture, openInput, orderAccepted, trippedKillSwitch, type Fixture } from './o21-fixture.js';
import { schemaPnl, schemaPnlPosition } from './o21a1-pnl-fixture.js';

const AT = '2026-10-16T14:00:00.000Z';
const POSITION = 2150941015;
const MANUAL = schemaPnlPosition({ instrumentID: 100001, unrealizedPnL: { pnL: 0, closeRate: 2400, timestamp: '2026-10-16T13:59:58Z' } });

async function source(transport: FixtureEtoroTransport, nexusPositionIds: () => Promise<ReadonlySet<number>> = async () => new Set()) {
  const killSwitch = await PortfolioKillSwitchStore.open(new InMemoryAppendOnlyStore<KillSwitchState>());
  const valuations = await AppendOnlyLog.open<DemoAccountValuationRecord>('etoro-demo-account-valuations', new InMemoryAppendOnlyStore());
  return { s: new EtoroDemoAccountSafetySource({ transport, killSwitch, valuations, nexusPositionIds }), killSwitch, valuations };
}

function pnlTransport(body: unknown): FixtureEtoroTransport {
  const t = new FixtureEtoroTransport();
  t.response = { status: 200, body };
  return t;
}

describe('O22 demo account safety source (evidence released for this module only)', () => {
  it('one evaluation is exactly one GET of pnl.demo; an empty account is NORMAL', async () => {
    const t = pnlTransport(schemaPnl());
    const { s } = await source(t);
    const d = await s.current(AT);
    expect(d?.state).toBe('NORMAL');
    expect(d?.asOf).toBe(AT);
    expect(t.calls).toEqual(['pnl.demo']);
  });

  it('fails closed with null on HTTP errors, transport failures and a refused response; never retried', async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const t = pnlTransport(schemaPnl());
      t.response = { status, body: null };
      const { s } = await source(t);
      expect(await s.current(AT)).toBeNull();
      expect(s.status()).toEqual({ outcome: 'read_failed', at: AT, code: 'HTTP_' + status });
      expect(t.calls).toHaveLength(1);
    }
    const timeout = pnlTransport(schemaPnl());
    timeout.error = new BrokerError('BROKER_TIMEOUT');
    const a = await source(timeout);
    expect(await a.s.current(AT)).toBeNull();
    expect(a.s.status()).toMatchObject({ outcome: 'read_failed', code: 'BROKER_TIMEOUT' });
    const invalid = pnlTransport({ clientPortfolio: { credit: 1 } });
    const b = await source(invalid);
    expect(await b.s.current(AT)).toBeNull();
    expect(b.s.status()).toMatchObject({ outcome: 'response_invalid', code: 'BROKER_RESPONSE_INVALID' });
  });

  it('the risk day: start = first valuation of the UTC day, peak = highest equity so far; a fall from the peak trips', async () => {
    const t = pnlTransport(schemaPnl({ credit: 10000 }));
    const { s, valuations } = await source(t);
    expect((await s.current('2026-10-16T08:00:00.000Z'))?.riskDay).toEqual({ dayId: '2026-10-16', startEquityUsd: '10000', peakEquityUsd: '10000' });
    t.response = { status: 200, body: schemaPnl({ credit: 10080 }) };
    expect((await s.current('2026-10-16T09:00:00.000Z'))?.state).toBe('NORMAL');
    t.response = { status: 200, body: schemaPnl({ credit: 9979 }) };
    const fallen = await s.current('2026-10-16T10:00:00.000Z');
    expect(fallen?.riskDay).toEqual({ dayId: '2026-10-16', startEquityUsd: '10000', peakEquityUsd: '10080' });
    // Day loss 21 USD (below the limit); drawdown from the peak 101 USD (at or above the 100 USD limit).
    expect(fallen?.metrics).toMatchObject({ dailyLossUsd: '21', drawdownUsd: '101' });
    expect(fallen?.hardBreachReasons).toEqual(['DRAWDOWN_LIMIT']);
    expect(fallen?.canIncreaseRisk).toBe(false);
    // A new UTC day starts from its own first valuation.
    expect((await s.current('2026-10-17T00:00:01.000Z'))?.riskDay).toEqual({ dayId: '2026-10-17', startEquityUsd: '9979', peakEquityUsd: '9979' });
    expect(valuations.all().map((r) => r.payload.equityUsd)).toEqual(['10000', '10080', '9979', '9979']);
    expect(JSON.stringify(valuations.all())).not.toMatch(/2150896073|positionID|cid/i);
  });

  it('an incomplete valuation is a DATA_HOLD and is not recorded in the risk day', async () => {
    const t = pnlTransport(schemaPnl({ positions: [schemaPnlPosition({ unrealizedPnL: null })] }));
    const { s, valuations } = await source(t);
    expect((await s.current(AT))?.state).toBe('DATA_HOLD');
    expect(valuations.all()).toEqual([]);
  });

  it('a tripped kill switch is TRIPPED', async () => {
    const t = pnlTransport(schemaPnl());
    const { s, killSwitch } = await source(t);
    await killSwitch.latch(trippedKillSwitch());
    expect((await s.current(AT))?.state).toBe('TRIPPED');
  });
});

describe('O22 cycle with the demo account safety source in the gate', () => {
  async function cycle(body: unknown): Promise<{ f: Fixture; t: FixtureEtoroTransport }> {
    const t = pnlTransport(body);
    let f: Fixture | null = null;
    const { s } = await source(t, async () => new Set(f === null ? [] : (await f.service.list()).flatMap((v) => v.brokerPositionIds)));
    f = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, safetySource: s });
    return { f, t };
  }

  it('with the hand-opened position in the account, the cycle open is refused at creation; nothing is sent', async () => {
    const { f } = await cycle(schemaPnl({ positions: [MANUAL] }));
    const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
    expect(created.state).toBe('REJECTED');
    expect(created.gateReasons).toEqual(['PORTFOLIO_SAFETY_BLOCKS_RISK_INCREASE', 'DRAWDOWN_OR_CAPACITY_LIMIT']);
    expect(f.broker.requests).toEqual([]);
  });

  it('the position appears between approval and execute: the execute gate reads the account again and refuses; the budget is not spent', async () => {
    const { f, t } = await cycle(schemaPnl());
    const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
    expect(created.state).toBe('RISK_APPROVED');
    await f.service.approve(created.intentId, HUMAN);
    t.response = { status: 200, body: schemaPnl({ positions: [MANUAL] }) };
    await expect(f.service.execute(created.intentId, HUMAN)).rejects.toMatchObject({ code: 'GATE_REFUSED', reasons: ['PORTFOLIO_SAFETY_BLOCKS_RISK_INCREASE', 'DRAWDOWN_OR_CAPACITY_LIMIT'] });
    expect(f.broker.writes).toEqual([]);
    expect((await f.service.cycleBudget()).openSubmissions).toBe(0);
  });

  it('a failed account read before the write refuses the open with PORTFOLIO_SAFETY_NOT_CONNECTED', async () => {
    const { f, t } = await cycle(schemaPnl());
    const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
    await f.service.approve(created.intentId, HUMAN);
    t.error = new BrokerError('BROKER_TIMEOUT');
    await expect(f.service.execute(created.intentId, HUMAN)).rejects.toMatchObject({ code: 'GATE_REFUSED', reasons: expect.arrayContaining(['PORTFOLIO_SAFETY_NOT_CONNECTED']) });
    expect(f.broker.writes).toEqual([]);
  });

  it('empty account: one open, its position confirmed (product type real), counted as NEXUS; the close does not depend on the account read', async () => {
    const { f, t } = await cycle(schemaPnl());
    const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
    await f.service.approve(created.intentId, HUMAN);
    f.broker.next(orderAccepted());
    expect((await f.service.execute(created.intentId, HUMAN)).state).toBe('SUBMITTED');
    f.broker.next(lookupAnswer(3, { positionIds: [POSITION] }));
    const filled = await f.service.refresh(created.intentId);
    expect(filled.state).toBe('FILLED');
    expect(filled.brokerSettlementType).toBe('real');

    // The account now holds the NEXUS position: the source reports it as NEXUS, not external.
    t.response = { status: 200, body: schemaPnl({ positions: [schemaPnlPosition({ positionID: POSITION, instrumentID: ETORO_AAPL_ID, unrealizedPnL: { pnL: 1 } })] }) };
    const another = await f.service.create(openInput({ amount: '100', strategyRunId: 'run-o22-second', createdAt: '2026-10-16T13:59:40.000Z' }), CREATOR);
    expect(another.gateReasons).toEqual(expect.arrayContaining(['PORTFOLIO_SAFETY_BLOCKS_RISK_INCREASE', 'CYCLE_OPEN_BUDGET_EXHAUSTED']));

    // The close: the account read fails, and the close (risk-reducing) still goes out, exactly once.
    t.error = new BrokerError('BROKER_NOT_CONNECTED');
    const close = await f.service.create(closeInput(created.intentId), CREATOR);
    expect(close.state).toBe('RISK_APPROVED');
    await f.service.approve(close.intentId, HUMAN);
    f.broker.next({ status: 200, body: { orderForClose: { positionID: POSITION, instrumentID: ETORO_AAPL_ID, orderID: 13904638, statusID: 1 } } });
    expect((await f.service.execute(close.intentId, HUMAN)).state).toBe('SUBMITTED');
    expect(f.broker.writes).toHaveLength(2);
  });

  it('an unclear close never leads to a second close, whatever the account shows', async () => {
    const { f } = await cycle(schemaPnl());
    const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
    await f.service.approve(created.intentId, HUMAN);
    f.broker.next(orderAccepted());
    await f.service.execute(created.intentId, HUMAN);
    f.broker.next(lookupAnswer(3, { positionIds: [POSITION] }));
    await f.service.refresh(created.intentId);
    const close = await f.service.create(closeInput(created.intentId), CREATOR);
    await f.service.approve(close.intentId, HUMAN);
    f.broker.next({ throws: 'timeout' });
    expect((await f.service.execute(close.intentId, HUMAN)).state).toBe('AMBIGUOUS');
    const again = await f.service.create(closeInput(created.intentId, { strategyRunId: 'run-o22-close-2' }), CREATOR);
    expect(again.gateReasons).toEqual(expect.arrayContaining(['CLOSE_TARGET_ALREADY_CLOSING', 'CYCLE_CLOSE_BUDGET_EXHAUSTED']));
    expect(f.broker.writes).toHaveLength(2);
  });
});
