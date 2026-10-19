// O22 regression tests for the independent review of C1–C3 (findings F1–F8, F10). Each test states the finding it pins down.
// Test data only (intent views, snapshot observations, scripted broker answers); nothing is sent.
import { describe, expect, it, vi } from 'vitest';

// TEST ONLY, for this module: the compile-time lock is opened to exercise the write path (it stays closed in the build).
vi.mock('../../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});
import { evaluateDemoCycleTest } from '../../../src/broker/etoro/execution/demo-cycle-test-verdict.js';
import { openOrderBody } from '../../../src/broker/etoro/execution/execution-intent.js';
import type { IntentView } from '../../../src/broker/etoro/execution/etoro-demo-execution-service.js';
import { DEMO_E2E_CYCLE_POLICY } from '../../../src/broker/etoro/execution/execution-gate.js';
import { HttpsDemoExecutionTransport } from '../../../src/broker/etoro/execution/etoro-demo-execution-transport.js';
import { EtoroBrokerService } from '../../../src/broker/etoro/etoro-broker-service.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import { CREATOR, ETORO_AAPL_ID, HUMAN, MSFT, ETORO_MSFT_ID, ScriptedBroker, inMemoryStores, o21Fixture, openInput, orderAccepted } from './o21-fixture.js';

const ETH = 100001;
const POS = 3000000001;
const OPEN_ORDER = 13902598;
const CLOSE_ORDER = 13904638;
const FOREIGN_ORDER = 99999;
const T = {
  created: '2026-10-20T10:00:00.000Z',
  submitting: '2026-10-20T10:00:01.000Z',
  filled: '2026-10-20T10:00:05.000Z',
  seen: '2026-10-20T10:01:00.000Z',
  closeSubmitting: '2026-10-20T10:20:01.000Z',
  closed: '2026-10-20T10:20:05.000Z',
  final: '2026-10-20T10:21:00.000Z',
};

type Hist = Array<[string, string, string?]>;
type Read = { confirmationId: string; kind?: string; outcome: string; settlementType: string | null; brokerPositionIds: number[]; observedAt: string };

function view(v: {
  id: string; action: 'open' | 'close'; state: string; history: Hist; positionIds?: number[]; positionId?: number | null; closesIntentId?: string | null;
  settlementType?: string | null; brokerOrderId?: number | null; statusReads?: Read[];
}): IntentView {
  return {
    intentId: v.id,
    state: v.state,
    brokerOrderId: v.brokerOrderId ?? null,
    brokerSettlementType: v.settlementType === undefined ? null : v.settlementType,
    intent: { action: v.action, etoroInstrumentId: ETH, side: 'buy', positionId: v.positionId ?? null, closesIntentId: v.closesIntentId ?? null, createdAt: T.created },
    brokerPositionIds: v.positionIds ?? [],
    statusReads: (v.statusReads ?? []).map((r) => ({ kind: 'order_status', ...r })),
    history: v.history.map(([state, at, confirmationId]) => ({ state, at, reason: 'x', ...(confirmationId ? { confirmationId } : {}) })),
  } as unknown as IntentView;
}

const FILL_READ: Read = { confirmationId: 'econf_fill', outcome: 'filled', settlementType: 'real', brokerPositionIds: [POS], observedAt: T.filled };
const OPEN_HISTORY: Hist = [['CREATED', T.created], ['RISK_APPROVED', T.created], ['APPROVED', T.created], ['SUBMITTING', T.submitting], ['SUBMITTED', T.submitting], ['FILLED', T.filled, 'econf_fill']];
const CLOSE_HISTORY: Hist = [['CREATED', '2026-10-20T10:20:00.000Z'], ['RISK_APPROVED', '2026-10-20T10:20:00.000Z'], ['APPROVED', '2026-10-20T10:20:00.000Z'], ['SUBMITTING', T.closeSubmitting], ['SUBMITTED', T.closeSubmitting], ['FILLED', T.closed]];

function openView(over: Partial<Parameters<typeof view>[0]> = {}): IntentView {
  return view({ id: 'eint_open', action: 'open', state: 'FILLED', history: OPEN_HISTORY, positionIds: [POS], settlementType: 'real', brokerOrderId: OPEN_ORDER, statusReads: [FILL_READ], ...over });
}
function closeView(over: Partial<Parameters<typeof view>[0]> = {}): IntentView {
  return view({ id: 'eint_close', action: 'close', state: 'FILLED', history: CLOSE_HISTORY, positionId: POS, closesIntentId: 'eint_open', brokerOrderId: CLOSE_ORDER, ...over });
}

let seq = 0;
/** A stored observation. storedAt defaults to two seconds after observedAt; freshness 'stale' marks how it looks to a reader much later. */
function obs(observedAt: string, positions: Array<{ positionId: number; direction?: 'buy' | 'sell' }>, o: { orderIds?: number[]; storedAt?: string; sequence?: number; freshness?: 'fresh' | 'stale' } = {}) {
  seq += 1;
  return {
    snapshotId: 'esnap_' + observedAt + '_' + seq,
    observedAt,
    retrievedAt: observedAt,
    storedAt: o.storedAt ?? new Date(Date.parse(observedAt) + 2000).toISOString(),
    sequence: o.sequence ?? seq,
    freshness: o.freshness ?? 'fresh',
    content: {
      positions: positions.map((p) => ({ positionId: p.positionId, etoroInstrumentId: ETH, direction: p.direction ?? 'buy', units: '0.04', instrumentId: null })),
      ...(o.orderIds ? { orders: o.orderIds.map((orderId) => ({ orderId })) } : {}),
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const evaluate = (intents: IntentView[], snapshots: any[]) => evaluateDemoCycleTest({ intents, snapshots } as any);

describe('F1: a proved external order stays a failure while the close is in progress', () => {
  it('a foreign pending order seen before the close was submitted stays EXTERNAL_ACTIVITY when the close is SUBMITTING or AMBIGUOUS', () => {
    const foreign = obs(T.seen, [{ positionId: POS }], { orderIds: [FOREIGN_ORDER] });
    expect(evaluate([openView()], [foreign]).failures).toContain('EXTERNAL_ACTIVITY');
    const submitting = closeView({ state: 'SUBMITTING', history: CLOSE_HISTORY.slice(0, 4), brokerOrderId: null });
    const v1 = evaluate([openView(), submitting], [foreign]);
    expect(v1.result).toBe('failed');
    expect(v1.failures).toContain('EXTERNAL_ACTIVITY');
    const ambiguous = closeView({ state: 'AMBIGUOUS', history: CLOSE_HISTORY.slice(0, 4).concat([['AMBIGUOUS', T.closeSubmitting]] as Hist), brokerOrderId: null });
    expect(evaluate([openView(), ambiguous], [foreign]).failures).toEqual(['CLOSE_AMBIGUOUS', 'EXTERNAL_ACTIVITY']);
  });

  it('an unknown order in a snapshot stored after the close was submitted, while the close order id is unknown, is pending, not failed', () => {
    const submitting = closeView({ state: 'SUBMITTING', history: CLOSE_HISTORY.slice(0, 4), brokerOrderId: null });
    const v = evaluate([openView(), submitting], [obs(T.seen, [{ positionId: POS }]), obs('2026-10-20T10:20:02.000Z', [{ positionId: POS }], { orderIds: [CLOSE_ORDER] })]);
    expect(v.failures).toEqual([]);
    expect(v.pending).toContain('ACTIVITY_NOT_YET_ATTRIBUTABLE');
  });
});

describe('F2: a passed result is historical: later time and activity after the closed test period do not change it', () => {
  it('stays passed when the final snapshot later reads as stale, and when activity appears after the closing snapshot', () => {
    const base = [obs(T.seen, [{ positionId: POS }]), obs(T.final, [])];
    expect(evaluate([openView(), closeView()], base).result).toBe('passed');
    const later = [obs(T.seen, [{ positionId: POS }]), obs(T.final, [], { freshness: 'stale' })];
    expect(evaluate([openView(), closeView()], later).result).toBe('passed');
    const afterwards = [...base, obs('2026-10-23T09:00:00.000Z', [{ positionId: 3000000777 }], { orderIds: [FOREIGN_ORDER] })];
    expect(evaluate([openView(), closeView()], afterwards).result).toBe('passed');
  });

  it('the closing snapshot must be fresh when it was taken: one stored long after its observation, or taken long after the close, does not close the test', () => {
    const lateStored = obs(T.final, [], { storedAt: '2026-10-20T10:40:00.000Z' });
    expect(evaluate([openView(), closeView()], [obs(T.seen, [{ positionId: POS }]), lateStored]).result).toBe('incomplete');
    const takenLate = obs('2026-10-20T11:30:00.000Z', []);
    expect(evaluate([openView(), closeView()], [obs(T.seen, [{ positionId: POS }]), takenLate]).result).toBe('incomplete');
  });
});

describe('F3: a missing observation of the open position is missing evidence (incomplete), never an invented failure', () => {
  it('without a snapshot showing the position, the test is incomplete, not failed, also after the close', () => {
    const v = evaluate([openView(), closeView()], [obs(T.final, [])]);
    expect(v.result).toBe('incomplete');
    expect(v.failures).toEqual([]);
    expect(v.pending).toContain('OPEN_POSITION_NOT_OBSERVED');
  });

  it('a snapshot observed after the open was submitted and before the close was filled counts, even if it was stored later', () => {
    const inFlight = obs('2026-10-20T10:20:03.000Z', [{ positionId: POS }], { storedAt: '2026-10-20T10:20:07.000Z' });
    expect(evaluate([openView(), closeView()], [inFlight, obs(T.final, [])]).result).toBe('passed');
  });
});

describe('F5: deterministic order inside the verdict, also with equal timestamps', () => {
  it('unsorted input gives the same verdict as sorted input', () => {
    const a = obs(T.seen, [{ positionId: POS }]);
    const b = obs(T.final, []);
    expect(evaluate([openView(), closeView()], [b, a])).toEqual(evaluate([openView(), closeView()], [a, b]));
    expect(evaluate([openView(), closeView()], [b, a]).result).toBe('passed');
  });

  it('with equal observedAt the later stored record (higher sequence) is the later observation', () => {
    const stillOpen = obs(T.final, [{ positionId: POS }], { sequence: 1000 });
    const gone = obs(T.final, [], { sequence: 1001 });
    const v1 = evaluate([openView(), closeView()], [obs(T.seen, [{ positionId: POS }]), gone, stillOpen]);
    const v2 = evaluate([openView(), closeView()], [obs(T.seen, [{ positionId: POS }]), stillOpen, gone]);
    expect(v1).toEqual(v2);
  });
});

describe('F6: the fill confirmation is the authoritative evidence', () => {
  it('an earlier read stating real does not cover a fill confirmation that states no product type', () => {
    const reads: Read[] = [{ confirmationId: 'econf_early', outcome: 'pending', settlementType: 'real', brokerPositionIds: [], observedAt: T.submitting }, { ...FILL_READ, settlementType: null }];
    const v = evaluate([openView({ statusReads: reads, settlementType: 'real' }), closeView()], [obs(T.seen, [{ positionId: POS }]), obs(T.final, [])]);
    expect(v.result).toBe('failed');
    expect(v.failures).toContain('SETTLEMENT_TYPE_MISSING');
  });

  it('contradicting product types across the reads of the open fail, whatever the last one says', () => {
    const reads: Read[] = [{ confirmationId: 'econf_early', outcome: 'pending', settlementType: 'cfd', brokerPositionIds: [], observedAt: T.submitting }, FILL_READ];
    const v = evaluate([openView({ statusReads: reads }), closeView()], [obs(T.seen, [{ positionId: POS }]), obs(T.final, [])]);
    expect(v.result).toBe('failed');
    expect(v.failures).toContain('SETTLEMENT_TYPE_CONTRADICTED');
  });

  it('the bound position comes from fill reads only (the rule of closePositionOf): a position named by a non-fill read is not bound', () => {
    const reads: Read[] = [{ confirmationId: 'econf_pending', outcome: 'pending', settlementType: null, brokerPositionIds: [POS + 5], observedAt: T.submitting }, FILL_READ];
    const v = evaluate([openView({ statusReads: reads, positionIds: [POS + 5, POS] }), closeView()], [obs(T.seen, [{ positionId: POS }]), obs(T.final, [])]);
    expect(v).toMatchObject({ result: 'passed', positionId: POS });
  });

  it('a second fill read naming another position breaks the unique binding', () => {
    const reads: Read[] = [{ confirmationId: 'econf_partial', outcome: 'partially_filled', settlementType: 'real', brokerPositionIds: [POS + 5], observedAt: T.submitting }, FILL_READ];
    const v = evaluate([openView({ statusReads: reads }), closeView()], [obs(T.seen, [{ positionId: POS }, { positionId: POS + 5 }]), obs(T.final, [])]);
    expect(v.result).toBe('failed');
    expect(v.failures).toContain('POSITION_BINDING_NOT_UNIQUE');
  });

  it('a fill confirmation that is not visible (inconsistent read) is incomplete, never passed', () => {
    const v = evaluate([openView({ statusReads: [] }), closeView()], [obs(T.seen, [{ positionId: POS }]), obs(T.final, [])]);
    expect(v.result).toBe('incomplete');
    expect(v.pending).toContain('FILL_CONFIRMATION_NOT_VISIBLE');
  });
});

describe('F7: partial fills', () => {
  it('an open partial fill is incomplete; a partial fill the broker states as final fails', () => {
    const partial = OPEN_HISTORY.slice(0, 5).concat([['PARTIALLY_FILLED', T.filled, 'econf_part']] as Hist);
    const open = (outcome: string) => openView({ state: 'PARTIALLY_FILLED', history: partial, statusReads: [{ confirmationId: 'econf_part', outcome, settlementType: 'real', brokerPositionIds: [POS], observedAt: T.filled }] });
    expect(evaluate([open('partially_filled')], [obs(T.seen, [{ positionId: POS }])])).toMatchObject({ result: 'incomplete', failures: [] });
    const final = evaluate([open('partially_filled_final')], [obs(T.seen, [{ positionId: POS }])]);
    expect(final.result).toBe('failed');
    expect(final.failures).toContain('OPEN_PARTIALLY_FILLED_FINAL');
  });
});

describe('F4: the stored snapshot history (EtoroBrokerService.snapshotHistory)', () => {
  async function service(records: Array<{ observedAt: string; content?: object; snapshotMissing?: boolean; failed?: boolean }>) {
    const snapshots = await AppendOnlyLog.open('etoro-snapshots', new InMemoryAppendOnlyStore());
    const syncs = await AppendOnlyLog.open('etoro-sync-events', new InMemoryAppendOnlyStore());
    let i = 0;
    for (const r of records) {
      i += 1;
      const snapshotId = 'esnap_' + i;
      if (r.failed) {
        await syncs.append('esync_f' + i, { schema: 'etoro-sync:v1', syncId: 'esync_f' + i, outcome: 'failed', errorCode: 'BROKER_TIMEOUT', attemptedAt: r.observedAt } as never);
        continue;
      }
      if (!r.snapshotMissing) await snapshots.append(snapshotId, { schema: 'etoro-snapshot:v1', snapshotId, content: r.content ?? { positionCount: 0, openOrderCount: 0 } } as never);
      await syncs.append('esync_' + i, { schema: 'etoro-sync:v1', syncId: 'esync_' + i, outcome: 'success', snapshotId, reconciliationId: 'erec_' + i, observedAt: r.observedAt, retrievedAt: r.observedAt } as never);
    }
    const s = new EtoroBrokerService({ adapter: {} as never, ledger: {} as never, snapshots: snapshots as never, reconciliations: {} as never, syncs: syncs as never, clock: () => new Date('2026-10-20T12:00:00.000Z') });
    return s;
  }

  it('orders by observedAt, breaks ties by sync sequence, leaves out failed syncs and reports missing snapshot records', async () => {
    const s = await service([
      { observedAt: '2026-10-20T10:05:00.000Z' },
      { observedAt: '2026-10-20T10:01:00.000Z' },
      { observedAt: '2026-10-20T10:05:00.000Z' },
      { observedAt: '2026-10-20T10:03:00.000Z', failed: true },
      { observedAt: '2026-10-20T10:04:00.000Z', snapshotMissing: true },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = (await s.snapshotHistory()) as any;
    expect(h.observations.map((o: { snapshotId: string }) => o.snapshotId)).toEqual(['esnap_2', 'esnap_1', 'esnap_3']);
    expect(h.observations.map((o: { sequence: number }) => o.sequence)).toEqual([2, 1, 3]);
    expect(h.observations.every((o: { storedAt: string }) => typeof o.storedAt === 'string')).toBe(true);
    expect(h.missingSnapshotRecords).toBe(1);
    // The same tie rule as the latest snapshot of the reconciliation: the later stored of two equal observations.
    expect((await s.latestSnapshot())?.snapshotId).toBe('esnap_3');
  });

  it('a missing snapshot record makes the test verdict incomplete, never passed', () => {
    const v = evaluateDemoCycleTest({ intents: [openView(), closeView()], snapshots: [obs(T.seen, [{ positionId: POS }]), obs(T.final, [])], missingSnapshotRecords: 1 } as never);
    expect(v.result).toBe('incomplete');
    expect(v.pending).toContain('SNAPSHOT_HISTORY_INCOMPLETE');
  });
});

describe('F10: the body is serialized and checked before the reservation; exactly that text is sent', () => {
  it('a body that cannot be serialized is refused locally: fetch is never called', async () => {
    const calls: string[] = [];
    const t = new HttpsDemoExecutionTransport({ credentials: { apiKey: 'K'.repeat(20), userKey: 'U'.repeat(20) }, fetch: async (url) => { calls.push(url); return new Response('{}', { status: 200 }); } });
    const request = { operation: 'demo.order.open' as const, url: 'https://public-api.etoro.com/api/v2/trading/execution/demo/orders', requestId: '00000000-0000-4000-8000-00000000abcd', body: { amount: 10n } as never };
    await expect(t.send(request)).rejects.toMatchObject({ code: 'INTENT_INVALID' });
    expect(calls).toEqual([]);
  });

  it('the text on the wire is exactly the prepared serialized body, and the x-request-id is the one stored with SUBMITTING', async () => {
    const f = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY });
    const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
    await f.service.approve(created.intentId, HUMAN);
    f.broker.next(orderAccepted());
    await f.service.execute(created.intentId, HUMAN);
    const submitting = f.intents.all().map((r) => r.payload).find((e) => e.intentId === created.intentId && e.state === 'SUBMITTING')!;
    expect(f.broker.writes).toHaveLength(1);
    const write = f.broker.writes[0]!;
    expect(write.headers['x-request-id']).toBe(submitting.requestId);
    const intent = (await f.service.get(created.intentId)).intent;
    expect(write.rawBody).toBe(JSON.stringify(openOrderBody(intent)));
    expect(write.body).toMatchObject({ action: 'open', instrumentId: ETORO_AAPL_ID, amount: 100, leverage: 1 });
  });
});

describe('F8: pacer and a real race for the reservation', () => {
  it('a REQUEST_NOT_SENDABLE refusal takes no pacer slot', async () => {
    const f = await o21Fixture({ policy: DEMO_E2E_CYCLE_POLICY, requestId: () => 'not-a-uuid' });
    const created = await f.service.create(openInput({ amount: '100' }), CREATOR);
    await f.service.approve(created.intentId, HUMAN);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pacer = (f.service as any).deps.adapter.pacer;
    const before = pacer.available(f.clock.now.getTime());
    const spy = vi.spyOn(pacer, 'tryAcquire');
    await expect(f.service.execute(created.intentId, HUMAN)).rejects.toMatchObject({ reasons: ['REQUEST_NOT_SENDABLE'] });
    expect(spy).not.toHaveBeenCalled();
    expect(pacer.available(f.clock.now.getTime())).toBe(before);
  });

  it('two processes, two different approved opens, both past the gate at once: exactly one reaches SUBMITTING and is sent', async () => {
    const stores = inMemoryStores();
    const broker = new ScriptedBroker();
    const a = await o21Fixture({ policy: { ...DEMO_E2E_CYCLE_POLICY, maxOpenPositions: 2, maxGrossExposureUsd: '200' }, stores, sharedBroker: broker });
    const b = await o21Fixture({ policy: { ...DEMO_E2E_CYCLE_POLICY, maxOpenPositions: 2, maxGrossExposureUsd: '200' }, stores, sharedBroker: broker });
    const first = await a.service.create(openInput({ amount: '100' }), CREATOR);
    const second = await b.service.create(openInput({ amount: '100', instrumentId: MSFT.instrumentId, etoroInstrumentId: ETORO_MSFT_ID, strategyRunId: 'run-race-2' }), CREATOR);
    expect([first.state, second.state]).toEqual(['RISK_APPROVED', 'RISK_APPROVED']);
    await a.service.approve(first.intentId, HUMAN);
    await b.service.approve(second.intentId, HUMAN);
    broker.next(orderAccepted());
    broker.next(orderAccepted(13902599));
    const results = await Promise.allSettled([a.service.execute(first.intentId, HUMAN), b.service.execute(second.intentId, HUMAN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'GATE_REFUSED', reasons: expect.arrayContaining(['CYCLE_OPEN_BUDGET_EXHAUSTED']) });
    expect(broker.writes).toHaveLength(1);
    expect((await a.service.cycleBudget()).openSubmissions).toBe(1);
  });
});
