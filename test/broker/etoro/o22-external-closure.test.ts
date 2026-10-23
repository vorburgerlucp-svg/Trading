// O22 Plan B: the operator's attestation that a position NEXUS opened was closed outside NEXUS. Recorded only on complete stored
// evidence (fail closed); it ends the position's liveness for NEXUS and nothing else: no close, fill, confirmation, booking, budget
// change or intent state change, and the O22 test verdict stays NOT passed. No network: fixture transports, scripted broker answers.
// Two processes on PostgreSQL: test/pg/o22-external-closure.pg.test.ts.
import { describe, expect, it, vi } from 'vitest';

// TEST ONLY: filledOpen() exercises the write path, so this module replaces the compile-time lock for this module only.
vi.mock('../../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});
import { InMemoryAppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import type { EtoroSnapshotObservation } from '../../../src/broker/etoro/etoro-broker-service.js';
import { DemoExecutionError } from '../../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import { reconcileDemoCycle } from '../../../src/broker/etoro/execution/demo-cycle-reconciliation.js';
import { evaluateDemoCycleTest } from '../../../src/broker/etoro/execution/demo-cycle-test-verdict.js';
import { hashOf } from '../../../src/persistence/canonical-json.js';
import { snapshotContentProblems } from '../../../src/broker/etoro/etoro-broker-service.js';
import {
  EXTERNAL_CLOSURE_ACCOUNT_STATEMENT,
  EXTERNAL_CLOSURE_STATEMENT,
  externalClosureEffective,
  externalClosureOpenRefusals,
  externalClosureRefusals,
  parseExternalClosureClaim,
  type ExternalClosureFacts,
  type ExternalClosureRecord,
} from '../../../src/broker/etoro/execution/external-closure.js';
import { CREATOR, HUMAN, approvedOpen, closeInput, filledOpen, openInput, orderAccepted } from './o21-fixture.js';
import { FaultStore, InjectedCrash } from './o22-fault-store.js';
import { OPEN_ORDER, POSITION, closureProcess, filledThenClosedByHand, inMemoryEtoroStores, type ClosureProcess } from './o22-external-closure-scenario.js';

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reasons: readonly string[] }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DemoExecutionError) return { code: error.code, reasons: error.reasons };
    throw error;
  }
  throw new Error('expected a refusal');
}

/** Everything the attestation must not touch, as record counts. */
function untouched(p: ClosureProcess) {
  return { intents: p.f.intents.size, attempts: p.f.attempts.size, confirmations: p.f.confirmations.size, reconciliations: p.f.reconciliations.size, brokerRequests: p.f.broker.requests.length };
}

describe('O22 Plan B: a complete attestation', () => {
  it('is recorded with every evidence reference; it changes no intent, confirmation, attempt, budget or broker request', async () => {
    const p = await closureProcess();
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    const before = untouched(p);
    const budget = await p.f.service.cycleBudget();
    const record = await p.attest(open, closedSnapshot);
    expect(record).toMatchObject({
      schema: 'etoro-demo-external-closure:v1',
      openIntentId: open,
      positionId: POSITION,
      brokerOrderId: OPEN_ORDER,
      direction: 'buy',
      snapshotId: closedSnapshot,
      snapshotPositionCount: 0,
      statement: EXTERNAL_CLOSURE_STATEMENT,
      attestedBy: HUMAN,
      effect: 'liveness_ended',
      // R3: no account identity is claimed; the operator's statement and the continuity snapshot are recorded instead.
      accountIdentity: 'not_verified',
      accountStatement: EXTERNAL_CLOSURE_ACCOUNT_STATEMENT,
    });
    expect(record.continuitySnapshotId).toMatch(/^esnap_/);
    expect(record.continuitySnapshotId).not.toBe(closedSnapshot);
    expect(record.bindingConfirmationId).toMatch(/^econf_/);
    expect(record.evidenceHeads.intents.size).toBe(before.intents);
    expect(record.evidenceHeads.observations).toBe(2);
    expect(untouched(p)).toEqual(before);
    expect(await p.f.service.cycleBudget()).toEqual(budget);
    const view = await p.f.service.get(open);
    expect(view.state).toBe('FILLED');
    expect(view.externalClosure).toMatchObject({ positionId: POSITION, snapshotId: closedSnapshot, attestedBy: HUMAN, effective: true });
    expect(p.f.externalClosures!.size).toBe(1);
  });

  it('ends the liveness: a new open is no longer refused for the old position; a close of the attested position is refused', async () => {
    const p = await closureProcess();
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    const second = { ...openInput({ strategyRunId: 'run-o22-second' }), createdAt: p.f.clock.now.toISOString(), expiresAt: new Date(p.f.clock.now.getTime() + 600_000).toISOString() };
    const blocked = await p.f.service.create(second, CREATOR);
    expect(blocked.gateReasons).toContain('INSTRUMENT_HAS_LIVE_POSITION_OR_ORDER');
    await p.attest(open, closedSnapshot);
    const next = await p.f.service.create({ ...second, strategyRunId: 'run-o22-third' }, CREATOR);
    expect(next.gateReasons).not.toContain('INSTRUMENT_HAS_LIVE_POSITION_OR_ORDER');
    expect(next.gateReasons).not.toContain('OPEN_POSITIONS_ABOVE_LIMIT');
    expect(next.gateReasons).not.toContain('GROSS_EXPOSURE_ABOVE_LIMIT');
    const close = await p.f.service.create({ ...closeInput(open), createdAt: p.f.clock.now.toISOString(), expiresAt: new Date(p.f.clock.now.getTime() + 600_000).toISOString() }, CREATOR);
    expect(close.state).toBe('REJECTED');
    expect(close.gateReasons).toContain('CLOSE_TARGET_UNKNOWN');
  });

  it('reconciliation: closed_externally (not a NEXUS close); test verdict: failed with POSITION_CLOSED_EXTERNALLY', async () => {
    const p = await closureProcess();
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    const views = await p.f.service.list();
    expect(reconcileDemoCycle(views, await p.etoro.latestSnapshot()).items.map((i) => i.kind)).toEqual(['open_position_missing']);
    await p.attest(open, closedSnapshot);
    const after = await p.f.service.list();
    const reconciliation = reconcileDemoCycle(after, await p.etoro.latestSnapshot());
    expect(reconciliation.items.map((i) => i.kind)).toEqual(['closed_externally']);
    expect(reconciliation.reasons).toContain('CLOSED_EXTERNALLY');
    expect(reconciliation.verdict).not.toBe('inconsistent');
    const history = await p.etoro.snapshotHistory();
    const verdict = evaluateDemoCycleTest({ intents: after, snapshots: history.observations, missingSnapshotRecords: history.missingSnapshotRecords });
    expect(verdict.result).toBe('failed');
    expect(verdict.failures).toContain('POSITION_CLOSED_EXTERNALLY');
  });
});

describe('O22 Plan B: missing evidence refuses (nothing recorded)', () => {
  it('the O22 case: the open is SUBMITTED (no status read bound the order to a position)', async () => {
    const p = await closureProcess();
    const open = await approvedOpen(p.f);
    p.f.broker.next(orderAccepted());
    await p.f.service.execute(open, HUMAN);
    p.f.advance(60_000);
    const snapshot = await p.sync('without_position');
    expect(await refusal(p.attest(open, snapshot))).toEqual({ code: 'EXTERNAL_CLOSURE_REFUSED', reasons: ['OPEN_NOT_FILLED'] });
    expect(p.f.externalClosures!.size).toBe(0);
  });

  it('no snapshot at all, or a snapshot id that was never observed', async () => {
    const p = await closureProcess();
    const open = await filledOpen(p.f, POSITION);
    expect((await refusal(p.attest(open, 'esnap_' + '0'.repeat(40)))).reasons).toEqual(['SNAPSHOT_NOT_FOUND']);
    p.f.advance(60_000);
    await p.sync('without_position');
    expect((await refusal(p.attest(open, 'esnap_' + '0'.repeat(40)))).reasons).toEqual(['SNAPSHOT_NOT_FOUND']);
  });

  it('the newest snapshot still shows the position', async () => {
    const p = await closureProcess();
    const open = await filledOpen(p.f, POSITION);
    p.f.advance(10_000);
    const snapshot = await p.sync('with_position');
    // R3: the snapshot that still shows the position is the only one, so no earlier one shows the continuity either.
    expect((await refusal(p.attest(open, snapshot))).reasons).toEqual(['POSITION_STILL_IN_SNAPSHOT', 'ACCOUNT_CONTINUITY_NOT_SHOWN']);
  });

  it('the only snapshot without the position was observed before the binding', async () => {
    const p = await closureProcess();
    const empty = await p.sync('without_position');
    const open = await filledOpen(p.f, POSITION);
    expect((await refusal(p.attest(open, empty))).reasons).toEqual(['SNAPSHOT_PREDATES_BINDING', 'ACCOUNT_CONTINUITY_NOT_SHOWN']);
  });

  it('a successful sync whose snapshot record cannot be read makes the history incomplete', async () => {
    const p = await closureProcess();
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    const at = new Date(p.f.clock.now.getTime() - 1_000).toISOString();
    await p.syncs.append('esync_lost', { schema: 'etoro-sync:v1', syncId: 'esync_lost', outcome: 'success', snapshotId: 'esnap_' + 'f'.repeat(40), reconciliationId: 'erec_lost', observedAt: at, retrievedAt: at });
    expect((await refusal(p.attest(open, closedSnapshot))).reasons).toEqual(['SNAPSHOT_HISTORY_INCOMPLETE']);
  });

  it('a snapshot record without its sync record (a crash between the two) is not an observation', async () => {
    const p = await closureProcess();
    const open = await filledOpen(p.f, POSITION);
    p.f.advance(60_000);
    // The sync appends the snapshot, then the reconciliation, then the sync record: crash after the snapshot.
    const etoroStores = inMemoryEtoroStores();
    const syncs = new FaultStore(etoroStores.syncs);
    const q = await closureProcess({ stores: p.f.stores, etoroStores: { ...etoroStores, syncs }, broker: p.f.broker });
    q.f.clock.now = new Date(p.f.clock.now.getTime());
    syncs.crashAt(() => true, 'before');
    await expect(q.sync('without_position')).rejects.toBeInstanceOf(InjectedCrash);
    const snapshotId = (await etoroStores.snapshots.loadAll())[0]!.payload.snapshotId;
    expect((await refusal(q.attest(open, snapshotId))).reasons).toEqual(['SNAPSHOT_NOT_FOUND']);
  });
});

describe('O22 Plan B: contradicting evidence refuses', () => {
  it('a later snapshot shows the position again: the earlier snapshot without it is not the newest', async () => {
    const p = await closureProcess();
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    p.f.advance(30_000);
    await p.sync('with_position');
    expect((await refusal(p.attest(open, closedSnapshot))).reasons).toEqual(['SNAPSHOT_NOT_NEWEST']);
  });

  it('two observations at the same time with different contents: ambiguous', async () => {
    const etoroStores = inMemoryEtoroStores();
    const p = await closureProcess({ etoroStores });
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    const q = await closureProcess({ stores: p.f.stores, etoroStores, broker: p.f.broker });
    q.f.clock.now = new Date(p.f.clock.now.getTime());
    await q.sync('other_position');
    // Equal observedAt: the storage order puts q's observation last, so the claim of p's snapshot is not the newest either way.
    expect((await refusal(p.attest(open, closedSnapshot))).reasons).toEqual(['SNAPSHOT_NOT_NEWEST']);
    const other = (await p.etoro.snapshotHistory()).observations.at(-1)!.snapshotId;
    expect((await refusal(p.attest(open, other))).reasons).toEqual(['SNAPSHOT_AMBIGUOUS']);
  });

  it('the open order is still pending at the broker', async () => {
    const p = await closureProcess();
    const open = await filledOpen(p.f, POSITION);
    p.f.advance(10_000);
    await p.sync('with_position');
    p.f.advance(60_000);
    const snapshot = await p.sync('with_open_order');
    expect((await refusal(p.attest(open, snapshot))).reasons).toEqual(['OPEN_ORDER_STILL_AT_BROKER']);
  });

  it('a NEXUS close of the position is approved (unresolved): refused until it is withdrawn', async () => {
    const p = await closureProcess();
    const open = await filledOpen(p.f, POSITION);
    p.f.advance(10_000);
    await p.sync('with_position');
    const close = await p.f.service.create({ ...closeInput(open), createdAt: p.f.clock.now.toISOString(), expiresAt: new Date(p.f.clock.now.getTime() + 600_000).toISOString() }, CREATOR);
    expect(close.state, close.gateReasons.join(',')).toBe('RISK_APPROVED');
    await p.f.service.approve(close.intentId, HUMAN);
    p.f.advance(60_000);
    const empty = await p.sync('without_position');
    expect((await refusal(p.attest(open, empty))).reasons).toEqual(['NEXUS_CLOSE_UNRESOLVED']);
    await p.f.service.withdraw(close.intentId);
    expect((await p.attest(open, empty)).positionId).toBe(POSITION);
  });
});

describe('O22 Plan B: the claim and the operator', () => {
  it('another position id in the claim (manipulation) is refused; the position is never taken from the claim', async () => {
    const p = await closureProcess();
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    expect((await refusal(p.attest(open, closedSnapshot, { positionId: POSITION + 1 }))).reasons).toEqual(['POSITION_ID_MISMATCH']);
    expect(p.f.externalClosures!.size).toBe(0);
  });

  it('an invalid claim: missing statement, other statement, extra field, an actor in the body', async () => {
    const p = await closureProcess();
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    for (const overrides of [{ statement: 'closed' }, { statement: undefined }, { accountStatement: undefined }, { accountStatement: 'ANOTHER_ACCOUNT' }, { extra: 1 }, { attestedBy: HUMAN }, { positionId: '2150941015' }]) {
      expect(await refusal(p.attest(open, closedSnapshot, overrides))).toEqual({ code: 'EXTERNAL_CLOSURE_REFUSED', reasons: ['CLAIM_INVALID'] });
    }
    expect(() => parseExternalClosureClaim({ positionId: POSITION, snapshotId: 'esnap_x', statement: EXTERNAL_CLOSURE_STATEMENT, accountStatement: EXTERNAL_CLOSURE_ACCOUNT_STATEMENT })).toThrow();
  });

  it('only an authenticated human operator: a strategy or a malformed actor is refused', async () => {
    const p = await closureProcess();
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    for (const by of [{ kind: 'strategy', id: 'auto' }, { kind: 'human' }, null, { kind: 'human', id: 'x', extra: 1 }]) {
      expect((await refusal(p.attest(open, closedSnapshot, {}, by))).code).toBe('OPERATOR_INVALID');
    }
    expect(p.f.externalClosures!.size).toBe(0);
  });

  it('an unknown or malformed open id, or a close intent', async () => {
    const p = await closureProcess();
    const { closedSnapshot } = await filledThenClosedByHand(p);
    expect((await refusal(p.attest('eint_' + 'a'.repeat(40), closedSnapshot))).reasons).toEqual(['OPEN_NOT_FOUND']);
    expect((await refusal(p.attest('not-an-id', closedSnapshot))).code).toBe('INTENT_NOT_FOUND');
  });

  it('without the attestation log or the sync history the process refuses: nothing can be recorded', async () => {
    const p = await closureProcess();
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    const { o21Fixture } = await import('./o21-fixture.js');
    const bare = await o21Fixture({ stores: p.f.stores, sharedBroker: p.f.broker });
    expect((await refusal(bare.service.attestExternalClosure(open, { positionId: POSITION, snapshotId: closedSnapshot, statement: EXTERNAL_CLOSURE_STATEMENT, accountStatement: EXTERNAL_CLOSURE_ACCOUNT_STATEMENT }, HUMAN))).code).toBe('EXTERNAL_CLOSURE_NOT_AVAILABLE');
  });
});

describe('O22 Plan B: once per position, crashes and late snapshots', () => {
  it('a second attestation of the same open is refused (ALREADY_ATTESTED); one record stays', async () => {
    const p = await closureProcess();
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    await p.attest(open, closedSnapshot);
    p.f.advance(1_000);
    expect((await refusal(p.attest(open, closedSnapshot))).reasons).toEqual(['ALREADY_ATTESTED']);
    expect((await refusal(p.attest(open, closedSnapshot, {}, { kind: 'human', id: 'operator-2' }))).reasons).toEqual(['ALREADY_ATTESTED']);
    expect(p.f.externalClosures!.size).toBe(1);
  });

  it('a crash before the record commits: nothing recorded, still live; the restart can attest', async () => {
    const closures = new FaultStore(new InMemoryAppendOnlyStore<ExternalClosureRecord>());
    const etoroStores = inMemoryEtoroStores();
    const p = await closureProcess({ closures, etoroStores });
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    closures.crashAt(() => true, 'before');
    await expect(p.attest(open, closedSnapshot)).rejects.toBeInstanceOf(InjectedCrash);
    const restarted = await closureProcess({ stores: p.f.stores, closures, etoroStores, broker: p.f.broker });
    restarted.f.clock.now = new Date(p.f.clock.now.getTime());
    expect((await restarted.f.service.get(open)).externalClosure).toBeNull();
    expect((await restarted.attest(open, closedSnapshot)).positionId).toBe(POSITION);
  });

  it('a crash after the record commits: the restart sees it (liveness ended) and refuses a second one', async () => {
    const closures = new FaultStore(new InMemoryAppendOnlyStore<ExternalClosureRecord>());
    const etoroStores = inMemoryEtoroStores();
    const p = await closureProcess({ closures, etoroStores });
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    closures.crashAt(() => true, 'after');
    await expect(p.attest(open, closedSnapshot)).rejects.toBeInstanceOf(InjectedCrash);
    const restarted = await closureProcess({ stores: p.f.stores, closures, etoroStores, broker: p.f.broker });
    restarted.f.clock.now = new Date(p.f.clock.now.getTime());
    expect((await restarted.f.service.get(open)).externalClosure?.positionId).toBe(POSITION);
    expect((await refusal(restarted.attest(open, closedSnapshot))).reasons).toEqual(['ALREADY_ATTESTED']);
  });

  it('R1: a broker status read of the open after the attestation cannot change its binding (FILLED is final): no record, no broker request', async () => {
    const p = await closureProcess();
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    await p.attest(open, closedSnapshot);
    const before = untouched(p);
    expect((await refusal(p.f.service.refresh(open))).code).toBe('INTENT_STATE_INVALID');
    expect(untouched(p)).toEqual(before);
    expect((await p.f.service.get(open)).externalClosure?.effective).toBe(true);
  });

  it('a later snapshot shows the attested position again: reconciliation inconsistent, every open refused', async () => {
    const p = await closureProcess();
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    await p.attest(open, closedSnapshot);
    p.f.advance(30_000);
    await p.sync('with_position');
    const reconciliation = reconcileDemoCycle(await p.f.service.list(), await p.etoro.latestSnapshot());
    expect(reconciliation.items.map((i) => i.kind)).toEqual(['closed_externally_contradicted']);
    expect(reconciliation.verdict).toBe('inconsistent');
    const next = await p.f.service.create({ ...openInput({ strategyRunId: 'run-o22-next' }), createdAt: p.f.clock.now.toISOString(), expiresAt: new Date(p.f.clock.now.getTime() + 600_000).toISOString() }, CREATOR);
    expect(next.state).toBe('REJECTED');
    expect(next.gateReasons).toContain('EXTERNALLY_CLOSED_POSITION_SHOWN_AT_BROKER');
  });

  it('a snapshot stored late but observed before the attested one does not change the result', async () => {
    const etoroStores = inMemoryEtoroStores();
    const p = await closureProcess({ etoroStores });
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    await p.attest(open, closedSnapshot);
    // Another process stores, only now, a read it took 30 s before the attested snapshot (it still showed the position then).
    const late = await closureProcess({ stores: p.f.stores, etoroStores, broker: p.f.broker });
    late.f.clock.now = new Date(p.f.clock.now.getTime() - 30_000);
    await late.sync('with_position');
    const reconciliation = reconcileDemoCycle(await p.f.service.list(), await p.etoro.latestSnapshot());
    expect(reconciliation.items.map((i) => i.kind)).toEqual(['closed_externally']);
  });

  it('a late snapshot newer than the claimed one, stored before the attestation, refuses it', async () => {
    const etoroStores = inMemoryEtoroStores();
    const p = await closureProcess({ etoroStores });
    const { open, closedSnapshot } = await filledThenClosedByHand(p);
    const late = await closureProcess({ stores: p.f.stores, etoroStores, broker: p.f.broker });
    late.f.clock.now = new Date(p.f.clock.now.getTime() + 5_000);
    await late.sync('with_position');
    expect((await refusal(p.attest(open, closedSnapshot))).reasons).toEqual(['SNAPSHOT_NOT_NEWEST']);
  });
});

describe('O22 Plan B: the rule and the open check (pure)', () => {
  const SUBMITTED_AT = '2026-10-16T14:00:00.000Z';
  const BOUND_AT = '2026-10-16T14:01:00.000Z';
  const heldPosition = { positionId: POSITION, etoroInstrumentId: 1001, direction: 'buy', openOrder: { orderId: OPEN_ORDER, orderType: 17 } };

  /** A stored observation whose content is consistent and whose id is its content hash, unless a test breaks it on purpose. */
  function observation(over: { observedAt?: string; sequence?: number; positions?: unknown[]; orders?: unknown[]; content?: Record<string, unknown>; snapshotId?: string } = {}): EtoroSnapshotObservation {
    const positions = (over.positions ?? []) as never[];
    const orders = (over.orders ?? []) as never[];
    const content = {
      broker: 'etoro', accountId: null, access: 'read_only',
      coverage: { cash: 'not_read', positions: positions.length === 0 ? 'verified_empty' : 'documented_schema', openOrders: orders.length === 0 ? 'verified_empty' : 'documented_schema', accountIdentity: 'not_observed' },
      positionCount: positions.length, openOrderCount: orders.length,
      ...(positions.length > 0 ? { positions } : {}), ...(orders.length > 0 ? { orders } : {}),
      ...(over.content ?? {}),
    };
    const at = over.observedAt ?? '2026-10-16T14:05:00.000Z';
    return { snapshotId: over.snapshotId ?? 'esnap_' + hashOf(content).slice(0, 40), observedAt: at, retrievedAt: at, storedAt: at, sequence: over.sequence ?? 2, content: content as unknown as EtoroSnapshotObservation['content'] };
  }
  const continuity = observation({ observedAt: '2026-10-16T14:02:00.000Z', sequence: 1, positions: [heldPosition] });
  const closed = observation({});
  const facts = (over: Partial<ExternalClosureFacts> = {}): ExternalClosureFacts => ({
    open: {
      intentId: 'eint_' + 'a'.repeat(40), action: 'open', state: 'FILLED', etoroInstrumentId: 1001, side: 'buy', brokerOrderId: OPEN_ORDER,
      events: [{ state: 'SUBMITTING', at: SUBMITTED_AT }, { state: 'SUBMITTED', at: SUBMITTED_AT }, { state: 'FILLED', at: BOUND_AT, confirmationId: 'econf_fill' }],
    },
    confirmations: [{ confirmationId: 'econf_fill', kind: 'order_status', brokerOrderId: OPEN_ORDER, brokerPositionIds: [POSITION], outcome: 'filled', observedAt: BOUND_AT, appliesFrom: 'SUBMITTED', target: 'FILLED' }],
    closes: [],
    existing: [],
    history: { observations: [continuity, closed], missingSnapshotRecords: 0 },
    ...over,
  });
  const claim = { positionId: POSITION, snapshotId: closed.snapshotId, statement: EXTERNAL_CLOSURE_STATEMENT, accountStatement: EXTERNAL_CLOSURE_ACCOUNT_STATEMENT } as const;
  const withNewest = (o: EtoroSnapshotObservation) => ({ history: { observations: [continuity, o], missingSnapshotRecords: 0 } });
  const earlier = (positions: unknown[], observedAt = '2026-10-16T14:02:00.000Z') => ({ history: { observations: [observation({ observedAt, sequence: 1, positions }), closed], missingSnapshotRecords: 0 } });

  it('complete facts give the evidence, with the continuity snapshot', () => {
    const r = externalClosureRefusals(claim, facts());
    expect(r.reasons).toEqual([]);
    expect(r.evidence?.continuity.snapshotId).toBe(continuity.snapshotId);
  });

  it.each([
    ['the binding read is not a fill', { confirmations: [{ ...facts().confirmations[0]!, outcome: 'pending' }] }, ['BINDING_NOT_CHECKED']],
    ['the binding read is of another order', { confirmations: [{ ...facts().confirmations[0]!, brokerOrderId: 1 }] }, ['BINDING_ORDER_MISMATCH']],
    ['the binding read names two positions', { confirmations: [{ ...facts().confirmations[0]!, brokerPositionIds: [POSITION, 7] }] }, ['BINDING_NOT_UNIQUE']],
    ['another fill read names another position', { confirmations: [...facts().confirmations, { ...facts().confirmations[0]!, confirmationId: 'econf_2', brokerPositionIds: [7] }] }, ['BINDING_NOT_UNIQUE']],
    ['the FILLED entry carries no confirmation', { open: { ...facts().open!, events: [{ state: 'SUBMITTING', at: SUBMITTED_AT }, { state: 'FILLED', at: BOUND_AT }] } }, ['BINDING_NOT_CHECKED']],
    ['a NEXUS close filled', { closes: [{ state: 'FILLED' }] }, ['NEXUS_CLOSE_FILLED']],
    ['a NEXUS close is ambiguous', { closes: [{ state: 'AMBIGUOUS' }] }, ['NEXUS_CLOSE_UNRESOLVED']],
    ['a refused NEXUS close does not block', { closes: [{ state: 'REJECTED' }, { state: 'EXPIRED' }, { state: 'CANCELLED' }] }, []],
    // The continuity snapshot may lie before the binding (as on 20.10.: the position was seen before any status read).
    ['snapshot at the binding time (not after)', { history: { observations: [observation({ observedAt: '2026-10-16T14:00:30.000Z', sequence: 1, positions: [heldPosition] }), observation({ observedAt: BOUND_AT })], missingSnapshotRecords: 0 } }, ['SNAPSHOT_PREDATES_BINDING']],
    ['a partial fill that is not final', { open: { ...facts().open!, state: 'PARTIALLY_FILLED' } }, ['OPEN_NOT_FILLED']],
    ['a close intent', { open: { ...facts().open!, action: 'close' } }, ['NOT_AN_OPEN']],
    ['an attestation exists', { existing: [{} as ExternalClosureRecord] }, ['ALREADY_ATTESTED']],
    // R3: continuity of the portfolio reads with the account that holds the order.
    ['no earlier snapshot showed the position', { history: { observations: [closed], missingSnapshotRecords: 0 } }, ['ACCOUNT_CONTINUITY_NOT_SHOWN']],
    ['the earlier snapshot shows it opened by another order', earlier([{ ...heldPosition, openOrder: { orderId: 999, orderType: 17 } }]), ['ACCOUNT_CONTINUITY_NOT_SHOWN']],
    ['the earlier snapshot states no opening order', earlier([{ ...heldPosition, openOrder: null }]), ['ACCOUNT_CONTINUITY_NOT_SHOWN']],
    ['the earlier snapshot shows another direction', earlier([{ ...heldPosition, direction: 'sell' }]), ['ACCOUNT_CONTINUITY_NOT_SHOWN']],
    ['the earlier snapshot was taken before the order was submitted', earlier([heldPosition], '2026-10-16T13:59:00.000Z'), ['ACCOUNT_CONTINUITY_NOT_SHOWN']],
  ] as const)('%s', (_name, over, expected) => {
    expect(externalClosureRefusals(claim, facts(over as Partial<ExternalClosureFacts>)).reasons).toEqual(expected);
  });

  describe('R2: incomplete or contradicting snapshot data refuses', () => {
    it.each([
      ['positionCount above the stored positions', { content: { positionCount: 1 } }],
      ['openOrderCount above the stored orders', { content: { openOrderCount: 1 } }],
      ['openOrderCount below the stored orders', { orders: [{ orderId: 5, etoroInstrumentId: 1001 }], content: { openOrderCount: 0 } }],
      ['coverage says verified_empty, but a position is stored', { positions: [{ ...heldPosition, positionId: 8 }], content: { coverage: { cash: 'not_read', positions: 'verified_empty', openOrders: 'verified_empty', accountIdentity: 'not_observed' } } }],
      ['coverage says entries were read, but none is stored', { content: { coverage: { cash: 'not_read', positions: 'documented_schema', openOrders: 'verified_empty', accountIdentity: 'not_observed' } } }],
      ['a position stored twice', { positions: [{ ...heldPosition, positionId: 8 }, { ...heldPosition, positionId: 8 }] }],
      ['an order stored twice', { orders: [{ orderId: 5, etoroInstrumentId: 1001 }, { orderId: 5, etoroInstrumentId: 1001 }] }],
    ] as const)('the claimed snapshot: %s', (_name, over) => {
      const broken = observation(over as never);
      const reasons = externalClosureRefusals({ ...claim, snapshotId: broken.snapshotId }, facts(withNewest(broken))).reasons;
      expect(reasons).toContain('SNAPSHOT_INCOMPLETE');
      expect(reasons).toContain('SNAPSHOT_HISTORY_INCONSISTENT');
    });

    it('a snapshot whose id is not the hash of its content', () => {
      const forged = observation({ snapshotId: 'esnap_' + 'c'.repeat(40) });
      expect(externalClosureRefusals({ ...claim, snapshotId: forged.snapshotId }, facts(withNewest(forged))).reasons).toEqual(['SNAPSHOT_HISTORY_INCONSISTENT', 'SNAPSHOT_INCOMPLETE']);
    });

    it('an inconsistent older observation refuses too (the whole history must be consistent)', () => {
      const brokenOld = observation({ observedAt: '2026-10-16T13:00:00.000Z', sequence: 0, content: { positionCount: 3 } });
      expect(externalClosureRefusals(claim, facts({ history: { observations: [brokenOld, continuity, closed], missingSnapshotRecords: 0 } })).reasons).toEqual(['SNAPSHOT_HISTORY_INCONSISTENT']);
    });

    it('snapshotContentProblems names every problem; a consistent content has none', () => {
      expect(snapshotContentProblems(closed.snapshotId, closed.content)).toEqual([]);
      const broken = observation({ positions: [{ ...heldPosition, positionId: 8 }, { ...heldPosition, positionId: 8 }], content: { openOrderCount: 2 } });
      expect(snapshotContentProblems('esnap_' + 'd'.repeat(40), broken.content)).toEqual(['ORDER_COUNT_MISMATCH', 'DUPLICATE_POSITION', 'CONTENT_HASH_MISMATCH']);
    });
  });

  it('R1: an attestation has no effect while a NEXUS close of its position may have been sent', () => {
    const record = { openIntentId: 'eint_' + 'a'.repeat(40), positionId: POSITION };
    expect(externalClosureEffective(record, [])).toBe(true);
    for (const state of ['SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'AMBIGUOUS', 'RECONCILED'] as const) {
      expect(externalClosureEffective(record, [{ closesIntentId: record.openIntentId, positionId: POSITION, state }]), state).toBe(false);
      expect(externalClosureEffective(record, [{ closesIntentId: 'eint_' + 'b'.repeat(40), positionId: POSITION, state }]), state).toBe(false);
    }
    for (const state of ['CREATED', 'RISK_APPROVED', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'] as const) {
      expect(externalClosureEffective(record, [{ closesIntentId: record.openIntentId, positionId: POSITION, state }]), state).toBe(true);
    }
    expect(externalClosureEffective(record, [{ closesIntentId: 'eint_' + 'b'.repeat(40), positionId: 7, state: 'SUBMITTED' }])).toBe(true);
  });

  it('the open check: only once an attestation exists; fail closed without a fresh complete snapshot', () => {
    const now = '2026-10-16T14:10:00.000Z';
    const fresh = { observedAt: '2026-10-16T14:09:00.000Z', freshness: 'fresh' as const, positionCount: 0, positions: [] };
    expect(externalClosureOpenRefusals([], null, now, 300_000)).toEqual([]);
    expect(externalClosureOpenRefusals([POSITION], null, now, 300_000)).toEqual(['EXTERNAL_CLOSURE_NOT_VERIFIABLE']);
    expect(externalClosureOpenRefusals([POSITION], { snapshot: null, problem: 'ambiguous' }, now, 300_000)).toEqual(['EXTERNAL_CLOSURE_NOT_VERIFIABLE']);
    expect(externalClosureOpenRefusals([POSITION], { snapshot: { ...fresh, observedAt: '2026-10-16T14:00:00.000Z' }, problem: null }, now, 300_000)).toEqual(['EXTERNAL_CLOSURE_NOT_VERIFIABLE']);
    expect(externalClosureOpenRefusals([POSITION], { snapshot: { ...fresh, positionCount: 1 }, problem: null }, now, 300_000)).toEqual(['EXTERNAL_CLOSURE_NOT_VERIFIABLE']);
    expect(externalClosureOpenRefusals([POSITION], { snapshot: fresh, problem: null }, now, 300_000)).toEqual([]);
    const shown = { ...fresh, positionCount: 1, positions: [{ positionId: POSITION, etoroInstrumentId: 1001, direction: 'buy', openOrderId: null }] };
    expect(externalClosureOpenRefusals([POSITION], { snapshot: shown, problem: null }, now, 300_000)).toEqual(['EXTERNALLY_CLOSED_POSITION_SHOWN_AT_BROKER']);
  });
});
