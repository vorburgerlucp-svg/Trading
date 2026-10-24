// O22 Plan C: independent demo cycles. A cycle is defined with its own immutable policy and budget, activated only by an explicit
// human authorization once every earlier broker state is settled, and closed with its test verdict. Every new intent belongs to the
// active cycle; its budget counts only that cycle's intents; nothing old is reset or executed again. No network: scripted answers.
// Two processes on PostgreSQL: test/pg/o22-plan-c-cycles.pg.test.ts. The build lock without the test mock: o22-plan-c-locked.test.ts.
import { describe, expect, it, vi } from 'vitest';

// TEST ONLY: this module exercises the write path, so it replaces the compile-time lock for this module only.
vi.mock('../../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});
import { InMemoryAppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import {
  CYCLE_ACTIVATION_STATEMENT,
  DEMO_CYCLE_2_MAX_ACTIVE_MS_DRAFT,
  DEMO_CYCLE_2_POLICY_DRAFT,
  MAX_CYCLE_ACTIVE_MS,
  activeCycle,
  cycleActivationRefusals,
  cycleDefinitionRefusals,
  intentCycleRefusals,
  policyHashOf,
  projectCycles,
  type CycleIntentFact,
  type DemoCycleRecord,
} from '../../../src/broker/etoro/execution/demo-cycles.js';
import { DEFAULT_DEMO_EXECUTION_POLICY, DEMO_E2E_CYCLE_POLICY, type DemoExecutionPolicy } from '../../../src/broker/etoro/execution/execution-gate.js';
import { DemoExecutionError } from '../../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import { closureProcess, filledThenClosedByHand } from './o22-external-closure-scenario.js';
import { CREATOR, ETORO_AAPL_ID, HUMAN, approvedOpen, closeInput, filledOpen, inMemoryStores, o21Fixture, openInput, orderAccepted, trippedKillSwitch, type Fixture } from './o21-fixture.js';

const NOW = '2026-10-16T14:00:00.000Z';
const OPERATOR = HUMAN;
/** A test cycle policy: the O21 default limits (the fixture opens 500 USD of AAPL) with a budget of one open and one close. */
const policyOf = (version: string, over: Partial<DemoExecutionPolicy> = {}): DemoExecutionPolicy =>
  Object.freeze({ ...DEFAULT_DEMO_EXECUTION_POLICY, version: ('etoro-demo-cycle-policy:' + version) as DemoExecutionPolicy['version'], maxOpenSubmissions: 1, maxCloseSubmissions: 1, ...over });
const HOUR = 60 * 60 * 1000;
const closeSubmitted = { status: 200, body: { orderForClose: { positionID: 2150941015, instrumentID: ETORO_AAPL_ID, orderID: 13904638, statusID: 1 }, token: '5fe065bc-f6f9-4897-a2ce-c4fccef73ff8' } };
const closeFilled = { status: 200, body: { orderID: 13904638, CID: 1, statusID: 3, orderType: 19, instrumentID: ETORO_AAPL_ID, positions: [{ positionID: 2150941015 }] } };

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reasons: readonly string[] }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DemoExecutionError) return { code: error.code, reasons: error.reasons };
    throw error;
  }
  throw new Error('expected a refusal');
}

async function withCycles(stores = inMemoryStores(), cycles = new InMemoryAppendOnlyStore<DemoCycleRecord>()): Promise<Fixture> {
  return o21Fixture({ stores, cycles });
}

async function defineAndActivate(f: Fixture, cycleId: string, policy: DemoExecutionPolicy, maxActiveMs = HOUR): Promise<void> {
  const defined = await f.service.defineCycle({ cycleId, policy, maxActiveMs }, OPERATOR);
  expect(defined.status).toBe('draft');
  const active = await f.service.activateCycle(cycleId, { policyHash: defined.policyHash, statement: CYCLE_ACTIVATION_STATEMENT }, OPERATOR);
  expect(active.status).toBe('active');
}

/** Closes the filled open's position through NEXUS (a FILLED close in the same cycle). */
async function closedByNexus(f: Fixture, open: string): Promise<string> {
  const close = await f.service.create(closeInput(open), CREATOR);
  expect(close.state, close.gateReasons.join(',')).toBe('RISK_APPROVED');
  await f.service.approve(close.intentId, HUMAN);
  f.broker.next(closeSubmitted, closeFilled);
  await f.service.execute(close.intentId, HUMAN);
  expect((await f.service.refresh(close.intentId)).state).toBe('FILLED');
  return close.intentId;
}

describe('Plan C: the rules (pure)', () => {
  const draft = (id = 'cycle-2') => projectCycles([{ schema: 'etoro-demo-cycle:v1', kind: 'defined', cycleId: id, policy: DEMO_CYCLE_2_POLICY_DRAFT, policyHash: policyHashOf(DEMO_CYCLE_2_POLICY_DRAFT), maxActiveMs: HOUR, definedBy: OPERATOR, definedAt: NOW }]);

  it('a definition needs a new id, a new policy version, a bounded budget and a bounded active time', () => {
    const none = new Map();
    expect(cycleDefinitionRefusals({ cycleId: 'cycle-2', policy: DEMO_CYCLE_2_POLICY_DRAFT, maxActiveMs: DEMO_CYCLE_2_MAX_ACTIVE_MS_DRAFT }, none)).toEqual([]);
    expect(cycleDefinitionRefusals({ cycleId: 'Cycle 2', policy: DEMO_CYCLE_2_POLICY_DRAFT, maxActiveMs: HOUR }, none)).toEqual(['CYCLE_ID_INVALID']);
    expect(cycleDefinitionRefusals({ cycleId: 'cycle-2', policy: DEMO_CYCLE_2_POLICY_DRAFT, maxActiveMs: HOUR }, draft())).toEqual(['CYCLE_ALREADY_DEFINED', 'CYCLE_POLICY_VERSION_REUSED']);
    expect(cycleDefinitionRefusals({ cycleId: 'cycle-3', policy: DEMO_CYCLE_2_POLICY_DRAFT, maxActiveMs: HOUR }, draft())).toEqual(['CYCLE_POLICY_VERSION_REUSED']);
    expect(cycleDefinitionRefusals({ cycleId: 'cycle-3', policy: DEMO_E2E_CYCLE_POLICY, maxActiveMs: HOUR }, none)).toEqual(['CYCLE_POLICY_VERSION_INVALID']);
    for (const budget of [null, 0, 4, 1.5]) {
      expect(cycleDefinitionRefusals({ cycleId: 'cycle-3', policy: policyOf('b', { maxOpenSubmissions: budget }), maxActiveMs: HOUR }, none), String(budget)).toEqual(['CYCLE_BUDGET_INVALID']);
    }
    expect(cycleDefinitionRefusals({ cycleId: 'cycle-3', policy: policyOf('c'), maxActiveMs: MAX_CYCLE_ACTIVE_MS + 1 }, none)).toEqual(['CYCLE_ACTIVE_TIME_INVALID']);
    expect(cycleDefinitionRefusals({ cycleId: 'cycle-3', policy: policyOf('c'), maxActiveMs: 0 }, none)).toEqual(['CYCLE_ACTIVE_TIME_INVALID']);
  });

  const settledFacts: CycleIntentFact[] = [
    { action: 'open', state: 'FILLED', expiresAt: NOW, positionIds: [7], positionId: null },
    { action: 'close', state: 'FILLED', expiresAt: NOW, positionIds: [7], positionId: 7 },
    { action: 'open', state: 'REJECTED', expiresAt: NOW, positionIds: [], positionId: null },
  ];
  const activation = (over: Partial<Parameters<typeof cycleActivationRefusals>[0]> = {}) => cycleActivationRefusals({
    cycleId: 'cycle-2', policyHash: policyHashOf(DEMO_CYCLE_2_POLICY_DRAFT), statement: CYCLE_ACTIVATION_STATEMENT, now: '2026-10-16T15:00:00.000Z', cycles: draft(), intents: settledFacts, killSwitchArmed: true, ...over,
  });

  it('activation: allowed only for the draft with exactly its policy, the statement, no other active cycle and an armed kill switch', () => {
    expect(activation()).toEqual([]);
    expect(activation({ cycleId: 'cycle-9' })).toEqual(['CYCLE_NOT_DEFINED']);
    expect(activation({ statement: 'yes' })).toEqual(['CYCLE_ACTIVATION_STATEMENT_MISSING']);
    expect(activation({ policyHash: policyHashOf(policyOf('other')) })).toEqual(['CYCLE_POLICY_HASH_MISMATCH']);
    expect(activation({ killSwitchArmed: false })).toEqual(['KILL_SWITCH_TRIPPED']);
    const both = projectCycles([
      { schema: 'etoro-demo-cycle:v1', kind: 'defined', cycleId: 'cycle-1', policy: policyOf('one'), policyHash: policyHashOf(policyOf('one')), maxActiveMs: HOUR, definedBy: OPERATOR, definedAt: NOW },
      { schema: 'etoro-demo-cycle:v1', kind: 'activated', cycleId: 'cycle-1', policyHash: policyHashOf(policyOf('one')), statement: CYCLE_ACTIVATION_STATEMENT, activatedBy: OPERATOR, activatedAt: NOW, activeUntil: '2026-10-16T16:00:00.000Z', checkedIntentLogSize: 0 },
      { schema: 'etoro-demo-cycle:v1', kind: 'defined', cycleId: 'cycle-2', policy: DEMO_CYCLE_2_POLICY_DRAFT, policyHash: policyHashOf(DEMO_CYCLE_2_POLICY_DRAFT), maxActiveMs: HOUR, definedBy: OPERATOR, definedAt: NOW },
    ]);
    expect(activation({ cycles: both })).toEqual(['ANOTHER_CYCLE_ACTIVE']);
    expect(activation({ cycleId: 'cycle-1', cycles: both, policyHash: policyHashOf(policyOf('one')) })).toEqual(['CYCLE_NOT_DRAFT']);
  });

  it('activation: every earlier broker state must be settled by NEXUS (the O22 open, a hand-closed position, a pending approval)', () => {
    for (const state of ['SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'AMBIGUOUS', 'RECONCILED', 'PARTIALLY_FILLED'] as const) {
      expect(activation({ intents: [...settledFacts, { action: 'open', state, expiresAt: NOW, positionIds: [], positionId: null }] }), state).toEqual(['PRIOR_INTENT_UNRESOLVED']);
    }
    // A filled open whose position NEXUS did not close (closed by hand, attested or not): not settled for a new cycle.
    expect(activation({ intents: [{ action: 'open', state: 'FILLED', expiresAt: NOW, positionIds: [8], positionId: null }] })).toEqual(['PRIOR_POSITION_NOT_CLOSED_BY_NEXUS']);
    expect(activation({ intents: [{ action: 'open', state: 'FILLED', expiresAt: NOW, positionIds: [], positionId: null }] })).toEqual(['PRIOR_POSITION_NOT_CLOSED_BY_NEXUS']);
    expect(activation({ intents: [{ action: 'open', state: 'APPROVED', expiresAt: '2026-10-16T15:10:00.000Z', positionIds: [], positionId: null }] })).toEqual(['PRIOR_INTENT_PENDING']);
    // An approval that expired by time can never be executed (execute expires it first).
    expect(activation({ intents: [{ action: 'open', state: 'APPROVED', expiresAt: '2026-10-16T14:10:00.000Z', positionIds: [], positionId: null }] })).toEqual([]);
  });

  it('the O22 history blocks the activation of cycle 2: its open is SUBMITTED', () => {
    expect(activation({ intents: [{ action: 'open', state: 'SUBMITTED', expiresAt: '2026-10-20T08:03:58.000Z', positionIds: [], positionId: null }] })).toEqual(['PRIOR_INTENT_UNRESOLVED']);
  });

  it('an intent may only be used in the active, unexpired cycle; an intent from before cycles (O22) never', () => {
    const active = projectCycles([
      { schema: 'etoro-demo-cycle:v1', kind: 'defined', cycleId: 'cycle-1', policy: policyOf('one'), policyHash: policyHashOf(policyOf('one')), maxActiveMs: HOUR, definedBy: OPERATOR, definedAt: NOW },
      { schema: 'etoro-demo-cycle:v1', kind: 'activated', cycleId: 'cycle-1', policyHash: policyHashOf(policyOf('one')), statement: CYCLE_ACTIVATION_STATEMENT, activatedBy: OPERATOR, activatedAt: NOW, activeUntil: '2026-10-16T15:00:00.000Z', checkedIntentLogSize: 0 },
    ]);
    expect(intentCycleRefusals('cycle-1', active, '2026-10-16T14:30:00.000Z')).toEqual([]);
    expect(intentCycleRefusals('cycle-1', active, '2026-10-16T15:00:00.000Z')).toEqual(['CYCLE_NOT_ACTIVE']);
    expect(intentCycleRefusals(undefined, active, '2026-10-16T14:30:00.000Z')).toEqual(['INTENT_NOT_OF_ACTIVE_CYCLE']);
    expect(intentCycleRefusals('cycle-0', active, '2026-10-16T14:30:00.000Z')).toEqual(['INTENT_NOT_OF_ACTIVE_CYCLE']);
    expect(intentCycleRefusals('cycle-1', new Map(), NOW)).toEqual(['CYCLE_NOT_ACTIVE']);
  });

  it('the projection ignores records out of order (an activation with another policy hash, a close of a draft)', () => {
    const records: DemoCycleRecord[] = [
      { schema: 'etoro-demo-cycle:v1', kind: 'closed', cycleId: 'cycle-1', closedBy: OPERATOR, closedAt: NOW, verdict: 'not_evaluated', failures: [] },
      { schema: 'etoro-demo-cycle:v1', kind: 'defined', cycleId: 'cycle-1', policy: policyOf('one'), policyHash: policyHashOf(policyOf('one')), maxActiveMs: HOUR, definedBy: OPERATOR, definedAt: NOW },
      { schema: 'etoro-demo-cycle:v1', kind: 'closed', cycleId: 'cycle-1', closedBy: OPERATOR, closedAt: NOW, verdict: 'not_evaluated', failures: [] },
      { schema: 'etoro-demo-cycle:v1', kind: 'activated', cycleId: 'cycle-1', policyHash: 'epol_other', statement: CYCLE_ACTIVATION_STATEMENT, activatedBy: OPERATOR, activatedAt: NOW, activeUntil: '2026-10-17T00:00:00.000Z', checkedIntentLogSize: 0 },
    ];
    expect(projectCycles(records).get('cycle-1')?.status).toBe('draft');
    expect(activeCycle(projectCycles(records), NOW)).toBeNull();
  });

  it('the cycle 2 draft is at least as strict as the O22 cycle policy in every limit, with a single instrument', () => {
    const d = DEMO_CYCLE_2_POLICY_DRAFT;
    const v2 = DEMO_E2E_CYCLE_POLICY;
    expect(Number(d.maxOrderInvestmentUsd)).toBeLessThanOrEqual(Number(v2.maxOrderInvestmentUsd));
    expect(Number(d.maxGrossExposureUsd)).toBeLessThanOrEqual(Number(v2.maxGrossExposureUsd));
    for (const k of ['maxLeverage', 'maxOpenPositions', 'maxQuoteAgeMs', 'maxSafetyDecisionAgeMs', 'maxBrokerSyncAgeMs', 'maxTriggerDistanceBp', 'maxOpenSubmissions', 'maxCloseSubmissions'] as const) {
      expect(d[k] as number, k).toBeLessThanOrEqual(v2[k] as number);
    }
    expect(d).toMatchObject({ maxOrderInvestmentUsd: '100', maxLeverage: 1, maxOpenPositions: 1, maxOpenSubmissions: 1, maxCloseSubmissions: 1, allowedOpenSides: ['buy'], allowedOpenOrderTypes: ['mkt'], allowedEtoroInstrumentIds: [100001] });
    expect(d.version).not.toBe(v2.version);
  });
});

describe('Plan C: the service with a cycle log', () => {
  it('without an active cycle nothing is created; a strategy cannot define, activate or close a cycle', async () => {
    const f = await withCycles();
    expect(await refusal(f.service.create(openInput(), CREATOR))).toEqual({ code: 'GATE_REFUSED', reasons: ['CYCLE_NOT_ACTIVE'] });
    expect(f.intents.size).toBe(0);
    const strategy = { kind: 'strategy' as const, id: 'auto' };
    expect((await refusal(f.service.defineCycle({ cycleId: 'cycle-1', policy: policyOf('one'), maxActiveMs: HOUR }, strategy))).code).toBe('OPERATOR_INVALID');
    await f.service.defineCycle({ cycleId: 'cycle-1', policy: policyOf('one'), maxActiveMs: HOUR }, OPERATOR);
    expect((await refusal(f.service.activateCycle('cycle-1', { policyHash: policyHashOf(policyOf('one')), statement: CYCLE_ACTIVATION_STATEMENT }, strategy))).code).toBe('OPERATOR_INVALID');
    // A defined (draft) cycle takes no intent either.
    expect((await refusal(f.service.create(openInput(), CREATOR))).reasons).toEqual(['CYCLE_NOT_ACTIVE']);
    expect(f.broker.requests).toHaveLength(0);
  });

  it('without a cycle log the cycle steps are refused (the runtime today): CYCLES_NOT_AVAILABLE', async () => {
    const f = await o21Fixture();
    expect((await refusal(f.service.defineCycle({ cycleId: 'cycle-1', policy: policyOf('one'), maxActiveMs: HOUR }, OPERATOR))).code).toBe('CYCLES_NOT_AVAILABLE');
  });

  it('an active cycle binds new intents (another id than the same input without cycles) and enforces its own budget', async () => {
    const f = await withCycles();
    const legacy = await o21Fixture();
    const legacyId = (await legacy.service.create(openInput(), CREATOR)).intentId;
    await defineAndActivate(f, 'cycle-1', policyOf('one'));
    const created = await f.service.create(openInput(), CREATOR);
    expect(created.intent.cycleId).toBe('cycle-1');
    expect(created.intentId).not.toBe(legacyId);
    await f.service.approve(created.intentId, HUMAN);
    f.broker.next(orderAccepted());
    await f.service.execute(created.intentId, HUMAN);
    expect(await f.service.cycleBudget()).toEqual({ cycleId: 'cycle-1', policyVersion: 'etoro-demo-cycle-policy:one', maxOpenSubmissions: 1, maxCloseSubmissions: 1, openSubmissions: 1, closeSubmissions: 0 });
    const second = await f.service.create(openInput({ strategyRunId: 'run-c1-second', etoroInstrumentId: ETORO_AAPL_ID }), CREATOR);
    expect(second.gateReasons).toContain('CYCLE_OPEN_BUDGET_EXHAUSTED');
  });

  it('budget isolation: cycle 2 starts with its own count; cycle 1 keeps its spent count; nothing is reset', async () => {
    const f = await withCycles();
    await defineAndActivate(f, 'cycle-1', policyOf('one'));
    const open = await filledOpen(f);
    await closedByNexus(f, open);
    await f.service.closeCycle('cycle-1', OPERATOR);
    const before = { intents: f.intents.size, attempts: f.attempts.size };
    await defineAndActivate(f, 'cycle-2', policyOf('two'));
    expect(await f.service.cycleBudget()).toMatchObject({ cycleId: 'cycle-2', openSubmissions: 0, closeSubmissions: 0 });
    expect(await f.service.cycleBudget('cycle-1')).toMatchObject({ cycleId: 'cycle-1', openSubmissions: 1, closeSubmissions: 1 });
    // Defining and activating wrote nothing to the intent or attempt logs.
    expect({ intents: f.intents.size, attempts: f.attempts.size }).toEqual(before);
    // Cycle 2 can spend its own budget once, and only once.
    const id = await approvedOpen(f, { strategyRunId: 'run-c2' });
    f.broker.next(orderAccepted(13902599));
    await f.service.execute(id, HUMAN);
    expect(await f.service.cycleBudget()).toMatchObject({ cycleId: 'cycle-2', openSubmissions: 1 });
    expect(await f.service.cycleBudget('cycle-1')).toMatchObject({ openSubmissions: 1, closeSubmissions: 1 });
  });

  it('budget isolation from the time before cycles (O22): the old spent budget stays spent, the cycle counts only its own intents', async () => {
    const stores = inMemoryStores();
    // Before cycles (like O22 under policy v2): an open reached SUBMITTING and the broker refused it, so it is settled but spent.
    const legacy = await o21Fixture({ stores, policy: DEMO_E2E_CYCLE_POLICY });
    const old = await approvedOpen(legacy, { amount: '100' });
    legacy.broker.next({ status: 400, body: { title: 'validation failed' } });
    expect((await legacy.service.execute(old, HUMAN)).state).toBe('REJECTED');
    expect(await legacy.service.cycleBudget()).toMatchObject({ openSubmissions: 1, maxOpenSubmissions: 1 });
    const oldRecords = legacy.intents.all().map((r) => r.hash);
    // A process with cycles: cycle 1 starts at 0, and the old intent is not counted, changed or executable.
    const f = await withCycles(stores);
    await defineAndActivate(f, 'cycle-1', policyOf('one'));
    expect(await f.service.cycleBudget()).toMatchObject({ cycleId: 'cycle-1', openSubmissions: 0 });
    const id = await approvedOpen(f, { strategyRunId: 'run-c1' });
    f.broker.next(orderAccepted(13902600));
    await f.service.execute(id, HUMAN);
    expect(await f.service.cycleBudget()).toMatchObject({ cycleId: 'cycle-1', openSubmissions: 1 });
    // The old records are byte for byte the same (same hashes, nothing appended to them), and the process without cycles still sees
    // its old budget spent: the new cycle gave the old policy nothing back.
    await legacy.intents.sync();
    expect(legacy.intents.all().slice(0, oldRecords.length).map((r) => r.hash)).toEqual(oldRecords);
    expect((await legacy.service.cycleBudget()).openSubmissions).toBeGreaterThanOrEqual(1);
    expect((await legacy.service.create(openInput({ amount: '100', strategyRunId: 'run-legacy-2' }), CREATOR)).gateReasons).toContain('CYCLE_OPEN_BUDGET_EXHAUSTED');
    expect((await refusal(f.service.execute(old, HUMAN))).code).toBe('INTENT_STATE_INVALID');
  });

  it('a cycle with an unsettled position blocks the next one; closing by hand (attested or not) never settles it', async () => {
    const f = await withCycles();
    await defineAndActivate(f, 'cycle-1', policyOf('one'));
    await filledOpen(f);
    await f.service.closeCycle('cycle-1', OPERATOR);
    await f.service.defineCycle({ cycleId: 'cycle-2', policy: policyOf('two'), maxActiveMs: HOUR }, OPERATOR);
    expect((await refusal(f.service.activateCycle('cycle-2', { policyHash: policyHashOf(policyOf('two')), statement: CYCLE_ACTIVATION_STATEMENT }, OPERATOR))).reasons).toEqual(['PRIOR_POSITION_NOT_CLOSED_BY_NEXUS']);
  });

  it('an intent of a closed cycle is never executed: not in the closed cycle, not in a new one', async () => {
    const f = await withCycles();
    await defineAndActivate(f, 'cycle-1', policyOf('one'));
    const old = await approvedOpen(f);
    await f.service.closeCycle('cycle-1', OPERATOR);
    expect((await refusal(f.service.execute(old, HUMAN))).reasons).toContain('CYCLE_NOT_ACTIVE');
    // The next cycle waits until the old approval has expired (it is still pending), and then still never runs it.
    await f.service.defineCycle({ cycleId: 'cycle-2', policy: policyOf('two'), maxActiveMs: HOUR }, OPERATOR);
    const authorization = { policyHash: policyHashOf(policyOf('two')), statement: CYCLE_ACTIVATION_STATEMENT };
    expect((await refusal(f.service.activateCycle('cycle-2', authorization, OPERATOR))).reasons).toEqual(['PRIOR_INTENT_PENDING']);
    f.advance(16 * 60_000);
    await f.service.activateCycle('cycle-2', authorization, OPERATOR);
    expect((await refusal(f.service.execute(old, HUMAN))).code).toBe('INTENT_STATE_INVALID'); // EXPIRED, never SUBMITTING
    expect(f.broker.requests).toHaveLength(0);
  });

  it('an intent from before cycles (as every O22 intent) is never executed by a process with cycles', async () => {
    const stores = inMemoryStores();
    const legacy = await o21Fixture({ stores });
    const old = await approvedOpen(legacy);
    const f = await withCycles(stores);
    await f.service.defineCycle({ cycleId: 'cycle-1', policy: policyOf('one'), maxActiveMs: HOUR }, OPERATOR);
    // The pending old approval blocks the activation; and it could not run in a cycle anyway.
    expect((await refusal(f.service.activateCycle('cycle-1', { policyHash: policyHashOf(policyOf('one')), statement: CYCLE_ACTIVATION_STATEMENT }, OPERATOR))).reasons).toEqual(['PRIOR_INTENT_PENDING']);
    expect((await refusal(f.service.execute(old, HUMAN))).reasons).toContain('CYCLE_NOT_ACTIVE');
    expect(f.broker.requests).toHaveLength(0);
  });

  it('the O22-like history (a SUBMITTED open from before cycles) blocks every activation', async () => {
    const stores = inMemoryStores();
    const legacy = await o21Fixture({ stores });
    const old = await approvedOpen(legacy);
    legacy.broker.next(orderAccepted());
    await legacy.service.execute(old, HUMAN);
    const f = await withCycles(stores);
    await f.service.defineCycle({ cycleId: 'cycle-2', policy: DEMO_CYCLE_2_POLICY_DRAFT, maxActiveMs: DEMO_CYCLE_2_MAX_ACTIVE_MS_DRAFT }, OPERATOR);
    expect((await refusal(f.service.activateCycle('cycle-2', { policyHash: policyHashOf(DEMO_CYCLE_2_POLICY_DRAFT), statement: CYCLE_ACTIVATION_STATEMENT }, OPERATOR))).reasons).toEqual(['PRIOR_INTENT_UNRESOLVED']);
    expect((await f.service.listCycles()).map((c) => [c.cycleId, c.status])).toEqual([['cycle-2', 'draft']]);
  });

  it('a cycle expires by itself: after activeUntil nothing is created or executed', async () => {
    const f = await withCycles();
    // The cycle ends after 5 minutes; the intent itself would live 10 (so it is the cycle that refuses, not the intent's expiry).
    await defineAndActivate(f, 'cycle-1', policyOf('one'), 5 * 60_000);
    const id = await approvedOpen(f);
    f.advance(5 * 60_000);
    expect((await refusal(f.service.create(openInput({ strategyRunId: 'run-late' }), CREATOR))).reasons).toEqual(['CYCLE_NOT_ACTIVE']);
    expect((await refusal(f.service.execute(id, HUMAN))).reasons).toContain('CYCLE_NOT_ACTIVE');
    expect(f.broker.requests).toHaveLength(0);
  });

  it('the kill switch stays in force in a cycle, and a tripped one blocks the activation of the next', async () => {
    const f = await withCycles();
    await defineAndActivate(f, 'cycle-1', policyOf('one'));
    await f.killSwitch.latch(trippedKillSwitch());
    expect((await f.service.create(openInput(), CREATOR)).gateReasons.some((r) => r.startsWith('KILL_SWITCH'))).toBe(true);
    await f.service.closeCycle('cycle-1', OPERATOR);
    await f.service.defineCycle({ cycleId: 'cycle-2', policy: policyOf('two'), maxActiveMs: HOUR }, OPERATOR);
    expect((await refusal(f.service.activateCycle('cycle-2', { policyHash: policyHashOf(policyOf('two')), statement: CYCLE_ACTIVATION_STATEMENT }, OPERATOR))).reasons).toContain('KILL_SWITCH_TRIPPED');
  });

  it('the instrument allowlist of a cycle policy refuses another instrument', async () => {
    const f = await withCycles();
    await defineAndActivate(f, 'cycle-1', policyOf('one', { allowedEtoroInstrumentIds: [100001] }));
    expect((await f.service.create(openInput(), CREATOR)).gateReasons).toContain('CYCLE_INSTRUMENT_NOT_ALLOWED');
  });

  it('a position closed by hand never makes a cycle passed: the close records failed (POSITION_CLOSED_EXTERNALLY), and the next cycle waits', async () => {
    const p = await closureProcess({ cycles: new InMemoryAppendOnlyStore<DemoCycleRecord>(), seed: false });
    await defineAndActivate(p.f, 'cycle-1', policyOf('one'));
    await p.sync('without_position');
    p.f.advance(1_000);
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    await p.attest(open, closedSnapshot);
    const closed = await p.f.service.closeCycle('cycle-1', OPERATOR);
    expect(closed.verdict).toBe('failed');
    const record = p.f.cycles!.all().map((r) => r.payload).find((r) => r.kind === 'closed')!;
    expect(record.kind === 'closed' && record.failures).toContain('POSITION_CLOSED_EXTERNALLY');
    await p.f.service.defineCycle({ cycleId: 'cycle-2', policy: policyOf('two'), maxActiveMs: HOUR }, OPERATOR);
    expect((await refusal(p.f.service.activateCycle('cycle-2', { policyHash: policyHashOf(policyOf('two')), statement: CYCLE_ACTIVATION_STATEMENT }, OPERATOR))).reasons).toEqual(['PRIOR_POSITION_NOT_CLOSED_BY_NEXUS']);
  });

  it('P16: a close in cycle 2 of an open of cycle 1 is refused by the cross-cycle rule itself (CLOSE_TARGET_UNKNOWN)', async () => {
    const f = await withCycles();
    await defineAndActivate(f, 'cycle-1', policyOf('one'));
    const open = await filledOpen(f);
    // TEST ONLY: a cycle state no service step can produce (the activation rule refuses cycle 2 while the position of cycle 1 is
    // open): cycle 1 closed and cycle 2 active, written directly to the cycle log. So nothing before the cross-cycle rule refuses.
    const two = policyOf('two');
    const at = f.clock.now.toISOString();
    await f.cycles!.append('cycle-1:closing', { schema: 'etoro-demo-cycle:v1', kind: 'closing', cycleId: 'cycle-1', closingBy: OPERATOR, closingAt: at });
    await f.cycles!.append('cycle-1:closed', { schema: 'etoro-demo-cycle:v1', kind: 'closed', cycleId: 'cycle-1', closedBy: OPERATOR, closedAt: at, verdict: 'not_evaluated', failures: [] });
    await f.cycles!.append('cycle-2:defined', { schema: 'etoro-demo-cycle:v1', kind: 'defined', cycleId: 'cycle-2', policy: two, policyHash: policyHashOf(two), maxActiveMs: HOUR, definedBy: OPERATOR, definedAt: at });
    await f.cycles!.append('cycle-2:activated', { schema: 'etoro-demo-cycle:v1', kind: 'activated', cycleId: 'cycle-2', policyHash: policyHashOf(two), statement: CYCLE_ACTIVATION_STATEMENT, activatedBy: OPERATOR, activatedAt: at, activeUntil: new Date(f.clock.now.getTime() + HOUR).toISOString(), checkedIntentLogSize: 0 });
    const close = await f.service.create(closeInput(open), CREATOR);
    expect(close.intent.cycleId).toBe('cycle-2');
    expect(close.intent.positionId).toBe(2150941015);
    // Every other rule passes (budget of cycle 2, the broker evidence, the access, the target is a FILLED open with that position):
    // the only refusal is the cross-cycle binding.
    expect(close.state).toBe('REJECTED');
    expect(close.gateReasons).toEqual(['CLOSE_TARGET_UNKNOWN']);
    expect(f.broker.writes).toHaveLength(1);
  });

  it('closing records CLOSING, then CLOSED with the verdict; a second close records nothing more; a re-activation and a draft close are refused', async () => {
    const f = await withCycles();
    await defineAndActivate(f, 'cycle-1', policyOf('one'));
    const closed = await f.service.closeCycle('cycle-1', OPERATOR);
    expect(closed).toMatchObject({ status: 'closed', verdict: 'not_evaluated', inFlight: 0 });
    expect(f.cycles!.all().map((r) => r.payload.kind)).toEqual(['defined', 'activated', 'closing', 'closed']);
    // A second close of a closed cycle is idempotent: it reports the state and records nothing (a closing cycle is completed by a
    // later call, so the call must be repeatable).
    expect(await f.service.closeCycle('cycle-1', OPERATOR)).toMatchObject({ status: 'closed', inFlight: 0 });
    expect(f.cycles!.size).toBe(4);
    await f.service.defineCycle({ cycleId: 'cycle-2', policy: policyOf('two'), maxActiveMs: HOUR }, OPERATOR);
    expect((await refusal(f.service.closeCycle('cycle-2', OPERATOR))).reasons).toEqual(['CYCLE_NOT_ACTIVE']);
    expect((await refusal(f.service.closeCycle('cycle-9', OPERATOR))).reasons).toEqual(['CYCLE_NOT_ACTIVE']);
    expect((await refusal(f.service.activateCycle('cycle-1', { policyHash: policyHashOf(policyOf('one')), statement: CYCLE_ACTIVATION_STATEMENT }, OPERATOR))).reasons).toEqual(['CYCLE_NOT_DRAFT']);
  });
});
