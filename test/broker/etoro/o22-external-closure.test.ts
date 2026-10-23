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
import {
  EXTERNAL_CLOSURE_STATEMENT,
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
    });
    expect(record.bindingConfirmationId).toMatch(/^econf_/);
    expect(record.evidenceHeads.intents.size).toBe(before.intents);
    expect(record.evidenceHeads.observations).toBe(2);
    expect(untouched(p)).toEqual(before);
    expect(await p.f.service.cycleBudget()).toEqual(budget);
    const view = await p.f.service.get(open);
    expect(view.state).toBe('FILLED');
    expect(view.externalClosure).toMatchObject({ positionId: POSITION, snapshotId: closedSnapshot, attestedBy: HUMAN });
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
    expect((await refusal(p.attest(open, snapshot))).reasons).toEqual(['POSITION_STILL_IN_SNAPSHOT']);
  });

  it('the only snapshot without the position was observed before the binding', async () => {
    const p = await closureProcess();
    const empty = await p.sync('without_position');
    const open = await filledOpen(p.f, POSITION);
    expect((await refusal(p.attest(open, empty))).reasons).toEqual(['SNAPSHOT_PREDATES_BINDING']);
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
    for (const overrides of [{ statement: 'closed' }, { statement: undefined }, { extra: 1 }, { attestedBy: HUMAN }, { positionId: '2150941015' }]) {
      expect(await refusal(p.attest(open, closedSnapshot, overrides))).toEqual({ code: 'EXTERNAL_CLOSURE_REFUSED', reasons: ['CLAIM_INVALID'] });
    }
    expect(() => parseExternalClosureClaim({ positionId: POSITION, snapshotId: 'esnap_x', statement: EXTERNAL_CLOSURE_STATEMENT })).toThrow();
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
    expect((await refusal(bare.service.attestExternalClosure(open, { positionId: POSITION, snapshotId: closedSnapshot, statement: EXTERNAL_CLOSURE_STATEMENT }, HUMAN))).code).toBe('EXTERNAL_CLOSURE_NOT_AVAILABLE');
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
  function observation(over: Partial<EtoroSnapshotObservation> & { positions?: unknown[]; orders?: unknown[]; positionCount?: number }): EtoroSnapshotObservation {
    const positions = (over.positions ?? []) as never[];
    return {
      snapshotId: over.snapshotId ?? 'esnap_' + 'b'.repeat(40),
      observedAt: over.observedAt ?? '2026-10-16T14:05:00.000Z',
      retrievedAt: over.observedAt ?? '2026-10-16T14:05:00.000Z',
      storedAt: over.observedAt ?? '2026-10-16T14:05:00.000Z',
      sequence: over.sequence ?? 2,
      content: {
        broker: 'etoro', accountId: null, access: 'read_only', coverage: { cash: 'not_read', positions: 'verified_empty', openOrders: 'verified_empty', accountIdentity: 'not_observed' },
        positionCount: over.positionCount ?? positions.length, openOrderCount: (over.orders ?? []).length,
        ...(positions.length > 0 ? { positions } : {}), ...((over.orders ?? []).length > 0 ? { orders: over.orders as never[] } : {}),
      },
    };
  }
  const facts = (over: Partial<ExternalClosureFacts> = {}): ExternalClosureFacts => ({
    open: {
      intentId: 'eint_' + 'a'.repeat(40), action: 'open', state: 'FILLED', etoroInstrumentId: 1001, side: 'buy', brokerOrderId: OPEN_ORDER,
      events: [{ state: 'SUBMITTED', at: '2026-10-16T14:00:00.000Z' }, { state: 'FILLED', at: '2026-10-16T14:01:00.000Z', confirmationId: 'econf_fill' }],
    },
    confirmations: [{ confirmationId: 'econf_fill', kind: 'order_status', brokerOrderId: OPEN_ORDER, brokerPositionIds: [POSITION], outcome: 'filled', observedAt: '2026-10-16T14:01:00.000Z', appliesFrom: 'SUBMITTED', target: 'FILLED' }],
    closes: [],
    existing: [],
    history: { observations: [observation({})], missingSnapshotRecords: 0 },
    ...over,
  });
  const claim = { positionId: POSITION, snapshotId: 'esnap_' + 'b'.repeat(40), statement: EXTERNAL_CLOSURE_STATEMENT } as const;

  it('complete facts give the evidence', () => {
    expect(externalClosureRefusals(claim, facts()).reasons).toEqual([]);
  });

  it.each([
    ['the binding read is not a fill', { confirmations: [{ ...facts().confirmations[0]!, outcome: 'pending' }] }, ['BINDING_NOT_CHECKED']],
    ['the binding read is of another order', { confirmations: [{ ...facts().confirmations[0]!, brokerOrderId: 1 }] }, ['BINDING_ORDER_MISMATCH']],
    ['the binding read names two positions', { confirmations: [{ ...facts().confirmations[0]!, brokerPositionIds: [POSITION, 7] }] }, ['BINDING_NOT_UNIQUE']],
    ['another fill read names another position', { confirmations: [...facts().confirmations, { ...facts().confirmations[0]!, confirmationId: 'econf_2', brokerPositionIds: [7] }] }, ['BINDING_NOT_UNIQUE']],
    ['the FILLED entry carries no confirmation', { open: { ...facts().open!, events: [{ state: 'FILLED', at: '2026-10-16T14:01:00.000Z' }] } }, ['BINDING_NOT_CHECKED']],
    ['a NEXUS close filled', { closes: [{ state: 'FILLED' }] }, ['NEXUS_CLOSE_FILLED']],
    ['a NEXUS close is ambiguous', { closes: [{ state: 'AMBIGUOUS' }] }, ['NEXUS_CLOSE_UNRESOLVED']],
    ['a refused NEXUS close does not block', { closes: [{ state: 'REJECTED' }, { state: 'EXPIRED' }, { state: 'CANCELLED' }] }, []],
    ['incomplete snapshot (count without the list)', { history: { observations: [observation({ positionCount: 1 })], missingSnapshotRecords: 0 } }, ['SNAPSHOT_INCOMPLETE']],
    ['snapshot at the binding time (not after)', { history: { observations: [observation({ observedAt: '2026-10-16T14:01:00.000Z' })], missingSnapshotRecords: 0 } }, ['SNAPSHOT_PREDATES_BINDING']],
    ['a partial fill that is not final', { open: { ...facts().open!, state: 'PARTIALLY_FILLED' } }, ['OPEN_NOT_FILLED']],
    ['a close intent', { open: { ...facts().open!, action: 'close' } }, ['NOT_AN_OPEN']],
    ['an attestation exists', { existing: [{} as ExternalClosureRecord] }, ['ALREADY_ATTESTED']],
  ] as const)('%s', (_name, over, expected) => {
    expect(externalClosureRefusals(claim, facts(over as Partial<ExternalClosureFacts>)).reasons).toEqual(expected);
  });

  it('a final partial fill is accepted like a fill', () => {
    const f = facts({
      open: { ...facts().open!, state: 'PARTIALLY_FILLED', events: [{ state: 'PARTIALLY_FILLED', at: '2026-10-16T14:01:00.000Z', confirmationId: 'econf_fill' }] },
      confirmations: [{ ...facts().confirmations[0]!, outcome: 'partially_filled_final', target: 'PARTIALLY_FILLED' }],
    });
    expect(externalClosureRefusals(claim, f).reasons).toEqual([]);
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
