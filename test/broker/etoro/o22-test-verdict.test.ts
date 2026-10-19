// O22 C1: the test verdict of the controlled demo cycle by the operator's success criterion (B6). A pure function over stored state:
// passed only when every criterion is proved; a broken criterion is "failed" and stays failed after the close; anything unproved,
// missing or stale is "incomplete", never "passed". Test data only (intent views and snapshot views); nothing is sent.
import { describe, expect, it } from 'vitest';
import { evaluateDemoCycleTest } from '../../../src/broker/etoro/execution/demo-cycle-test-verdict.js';
import type { IntentView } from '../../../src/broker/etoro/execution/etoro-demo-execution-service.js';
import type { DemoCycleSnapshot } from '../../../src/broker/etoro/execution/demo-cycle-test-verdict.js';

const ETH = 100001;
const POS = 3000000001;
const MANUAL = 3000000999;
const OPEN_ORDER = 13902598;
const CLOSE_ORDER = 13904638;
const T = {
  created: '2026-10-20T10:00:00.000Z',
  submitting: '2026-10-20T10:00:01.000Z',
  filled: '2026-10-20T10:00:05.000Z',
  seen: '2026-10-20T10:01:00.000Z',
  closeSubmitting: '2026-10-20T10:20:01.000Z',
  closed: '2026-10-20T10:20:05.000Z',
  final: '2026-10-20T10:21:00.000Z',
};

type Hist = Array<[string, string]>;

function view(v: {
  id: string; action: 'open' | 'close'; state: string; history: Hist; positionIds?: number[]; positionId?: number | null; closesIntentId?: string | null;
  settlementType?: string | null; brokerOrderId?: number | null; side?: 'buy' | 'sell';
}): IntentView {
  return {
    intentId: v.id,
    state: v.state,
    brokerOrderId: v.brokerOrderId ?? null,
    brokerSettlementType: v.settlementType === undefined ? null : v.settlementType,
    intent: { action: v.action, etoroInstrumentId: ETH, side: v.side ?? 'buy', positionId: v.positionId ?? null, closesIntentId: v.closesIntentId ?? null, createdAt: T.created },
    brokerPositionIds: v.positionIds ?? [],
    // The fill of a FILLED open rests on one recorded status read (F6): it carries the positions and the product type.
    statusReads: v.action === 'open' && v.state === 'FILLED'
      ? [{ confirmationId: 'econf_fill', kind: 'order_status', outcome: 'filled', settlementType: v.settlementType ?? null, brokerPositionIds: v.positionIds ?? [], observedAt: T.filled }]
      : [],
    history: v.history.map(([state, at]) => ({ state, at, reason: 'x', ...(v.action === 'open' && state === 'FILLED' ? { confirmationId: 'econf_fill' } : {}) })),
  } as unknown as IntentView;
}

const OPEN_HISTORY: Hist = [['CREATED', T.created], ['RISK_APPROVED', T.created], ['APPROVED', T.created], ['SUBMITTING', T.submitting], ['SUBMITTED', T.submitting], ['FILLED', T.filled]];
const CLOSE_HISTORY: Hist = [['CREATED', '2026-10-20T10:20:00.000Z'], ['RISK_APPROVED', '2026-10-20T10:20:00.000Z'], ['APPROVED', '2026-10-20T10:20:00.000Z'], ['SUBMITTING', T.closeSubmitting], ['SUBMITTED', T.closeSubmitting], ['FILLED', T.closed]];

function openView(over: Partial<Parameters<typeof view>[0]> = {}): IntentView {
  return view({ id: 'eint_open', action: 'open', state: 'FILLED', history: OPEN_HISTORY, positionIds: [POS], settlementType: 'real', brokerOrderId: OPEN_ORDER, ...over });
}

function closeView(over: Partial<Parameters<typeof view>[0]> = {}): IntentView {
  return view({ id: 'eint_close', action: 'close', state: 'FILLED', history: CLOSE_HISTORY, positionId: POS, closesIntentId: 'eint_open', brokerOrderId: CLOSE_ORDER, ...over });
}

let sequence = 0;
/** A stored observation: storedAt two seconds after observedAt unless stated (F2: its own times decide, never the time of reading). */
function snap(observedAt: string, positions: Array<{ positionId: number; etoroInstrumentId?: number; direction?: 'buy' | 'sell' }>, options: { storedAt?: string; orderIds?: number[] } = {}): DemoCycleSnapshot {
  sequence += 1;
  return {
    snapshotId: 'esnap_' + observedAt,
    observedAt,
    retrievedAt: observedAt,
    storedAt: options.storedAt ?? new Date(Date.parse(observedAt) + 2000).toISOString(),
    sequence,
    content: {
      positions: positions.map((p) => ({ positionId: p.positionId, etoroInstrumentId: p.etoroInstrumentId ?? ETH, direction: p.direction ?? 'buy', units: '0.04', instrumentId: null })),
      ...(options.orderIds ? { orders: options.orderIds.map((orderId) => ({ orderId })) } : {}),
    },
  } as unknown as DemoCycleSnapshot;
}

const BASELINE = snap('2026-10-20T09:59:30.000Z', []);
const SEEN = snap(T.seen, [{ positionId: POS }]);
const FINAL = snap(T.final, []);

function passing() {
  return { intents: [openView(), closeView()], snapshots: [BASELINE, SEEN, FINAL] };
}

describe('O22 C1 test verdict: passed only with every criterion proved', () => {
  it('the full cycle with every proof is passed, and the open product type is kept after the close', () => {
    const v = evaluateDemoCycleTest(passing());
    expect(v).toMatchObject({ result: 'passed', failures: [], pending: [], openIntentId: 'eint_open', closeIntentId: 'eint_close', positionId: POS, settlementType: 'real', closingSnapshot: { observedAt: T.final }, period: { from: T.created, to: T.final } });
  });

  it('dropping any single proof never gives passed', () => {
    const variants: Array<[string, ReturnType<typeof passing>]> = [
      ['no open submitted', { intents: [view({ id: 'eint_open', action: 'open', state: 'APPROVED', history: OPEN_HISTORY.slice(0, 3) })], snapshots: [BASELINE] }],
      ['open still submitted', { intents: [openView({ state: 'SUBMITTED', history: OPEN_HISTORY.slice(0, 5) })], snapshots: [BASELINE] }],
      ['no position confirmed', { intents: [openView({ positionIds: [] }), closeView()], snapshots: [BASELINE, SEEN, FINAL] }],
      ['product type missing', { intents: [openView({ settlementType: null }), closeView()], snapshots: [BASELINE, SEEN, FINAL] }],
      ['position never observed', { intents: [openView(), closeView()], snapshots: [BASELINE, FINAL] }],
      ['no close', { intents: [openView()], snapshots: [BASELINE, SEEN] }],
      ['close not filled', { intents: [openView(), closeView({ state: 'SUBMITTED', history: CLOSE_HISTORY.slice(0, 5) })], snapshots: [BASELINE, SEEN, FINAL] }],
      ['no snapshot after the close', { intents: [openView(), closeView()], snapshots: [BASELINE, SEEN] }],
      ['final snapshot not fresh when taken (stored late)', { intents: [openView(), closeView()], snapshots: [BASELINE, SEEN, snap(T.final, [], { storedAt: '2026-10-20T11:00:00.000Z' })] }],
      ['position still in the final snapshot', { intents: [openView(), closeView()], snapshots: [BASELINE, SEEN, snap(T.final, [{ positionId: POS }])] }],
      ['no snapshots at all', { intents: [openView(), closeView()], snapshots: [] }],
    ];
    for (const [label, input] of variants) expect(evaluateDemoCycleTest(input).result, label).not.toBe('passed');
  });

  it('a product type other than real fails the test, and the close does not make the failure disappear', () => {
    for (const settlementType of ['cfd', 'marginTrade', 'realFutures']) {
      const beforeClose = evaluateDemoCycleTest({ intents: [openView({ settlementType })], snapshots: [BASELINE, SEEN] });
      expect(beforeClose.result).toBe('failed');
      expect(beforeClose.failures).toEqual(['SETTLEMENT_TYPE_NOT_REAL']);
      // The securely bound position is then closed through the regular flow; the test stays failed with the same criterion.
      const afterClose = evaluateDemoCycleTest({ intents: [openView({ settlementType }), closeView()], snapshots: [BASELINE, SEEN, FINAL] });
      expect(afterClose.result).toBe('failed');
      expect(afterClose.failures).toEqual(['SETTLEMENT_TYPE_NOT_REAL']);
      expect(afterClose.settlementType).toBe(settlementType);
    }
    const missing = evaluateDemoCycleTest({ intents: [openView({ settlementType: null }), closeView()], snapshots: [BASELINE, SEEN, FINAL] });
    expect(missing).toMatchObject({ result: 'failed', failures: ['SETTLEMENT_TYPE_MISSING'] });
  });

  it('more than one position (or none) from the fill fails the unique binding', () => {
    const two = evaluateDemoCycleTest({ intents: [openView({ positionIds: [POS, POS + 1] })], snapshots: [BASELINE, snap(T.seen, [{ positionId: POS }, { positionId: POS + 1 }])] });
    expect(two.result).toBe('failed');
    expect(two.failures).toContain('POSITION_BINDING_NOT_UNIQUE');
    expect(two.failures).not.toContain('EXTERNAL_ACTIVITY');
    expect(two.positionId).toBeNull();
    expect(evaluateDemoCycleTest({ intents: [openView({ positionIds: [] })], snapshots: [BASELINE] }).failures).toContain('POSITION_BINDING_NOT_UNIQUE');
  });

  it('a rejected, cancelled or expired submitted open fails; an ambiguous or pending one is incomplete', () => {
    const rejected = OPEN_HISTORY.slice(0, 4).concat([['REJECTED', T.submitting]] as Hist);
    expect(evaluateDemoCycleTest({ intents: [openView({ state: 'REJECTED', history: rejected, positionIds: [] })], snapshots: [] }).failures).toEqual(['OPEN_REJECTED']);
    expect(evaluateDemoCycleTest({ intents: [openView({ state: 'CANCELLED', history: OPEN_HISTORY.slice(0, 5).concat([['CANCELLED', T.filled]] as Hist), positionIds: [] })], snapshots: [] }).failures).toEqual(['OPEN_NOT_FILLED']);
    const ambiguous = evaluateDemoCycleTest({ intents: [openView({ state: 'AMBIGUOUS', history: OPEN_HISTORY.slice(0, 4).concat([['AMBIGUOUS', T.submitting]] as Hist), positionIds: [] })], snapshots: [] });
    expect(ambiguous).toMatchObject({ result: 'incomplete', pending: ['OPEN_AMBIGUOUS'] });
    // An intent that was created but never submitted is not the cycle's open.
    expect(evaluateDemoCycleTest({ intents: [view({ id: 'x', action: 'open', state: 'RISK_APPROVED', history: OPEN_HISTORY.slice(0, 2) })], snapshots: [] })).toMatchObject({ result: 'incomplete', pending: ['NO_OPEN_SUBMITTED'] });
  });

  it('a rejected or cancelled close fails; an ambiguous close fails, because NEXUS can never prove it', () => {
    const rejected = closeView({ state: 'REJECTED', history: CLOSE_HISTORY.slice(0, 4).concat([['REJECTED', T.closeSubmitting]] as Hist) });
    expect(evaluateDemoCycleTest({ intents: [openView(), rejected], snapshots: [BASELINE, SEEN] }).failures).toEqual(['CLOSE_REJECTED']);
    const ambiguous = closeView({ state: 'AMBIGUOUS', history: CLOSE_HISTORY.slice(0, 4).concat([['AMBIGUOUS', T.closeSubmitting]] as Hist) });
    expect(evaluateDemoCycleTest({ intents: [openView(), ambiguous], snapshots: [BASELINE, SEEN, FINAL] }).failures).toEqual(['CLOSE_AMBIGUOUS']);
  });

  it('the open position must have been observed by a sync after the open was submitted and before the close was filled (missing: incomplete, F3)', () => {
    expect(evaluateDemoCycleTest({ intents: [openView()], snapshots: [BASELINE] })).toMatchObject({ result: 'incomplete', pending: ['NO_CLOSE_SUBMITTED', 'OPEN_POSITION_NOT_OBSERVED'] });
    // A snapshot only after the close was submitted does not count; once the close is submitted this is a failure.
    const late = snap('2026-10-20T10:20:03.000Z', [{ positionId: POS }]);
    // Observed after the close was submitted but before it was filled: it counts.
    expect(evaluateDemoCycleTest({ intents: [openView(), closeView()], snapshots: [BASELINE, late, FINAL] }).result).toBe('passed');
    // Never observed before the close was filled: missing evidence, incomplete – never an invented failure.
    expect(evaluateDemoCycleTest({ intents: [openView(), closeView()], snapshots: [BASELINE, FINAL] })).toMatchObject({ result: 'incomplete', failures: [], pending: ['OPEN_POSITION_NOT_OBSERVED'] });
  });

  it('external activity during the cycle fails the test, and it stays failed after a clean close (D1)', () => {
    const external = snap(T.seen, [{ positionId: POS }, { positionId: MANUAL }]);
    const v = evaluateDemoCycleTest({ intents: [openView(), closeView()], snapshots: [BASELINE, external, FINAL] });
    expect(v.result).toBe('failed');
    expect(v.failures).toEqual(['EXTERNAL_ACTIVITY']);
    const foreignOrder = snap(T.seen, [{ positionId: POS }], { orderIds: [99999] });
    expect(evaluateDemoCycleTest({ intents: [openView(), closeView()], snapshots: [BASELINE, foreignOrder, FINAL] }).failures).toEqual(['EXTERNAL_ACTIVITY']);
    // The cycle's own orders are not external.
    const ownOrders = snap(T.seen, [{ positionId: POS }], { orderIds: [OPEN_ORDER] });
    expect(evaluateDemoCycleTest({ intents: [openView(), closeView()], snapshots: [BASELINE, ownOrders, FINAL] }).result).toBe('passed');
  });

  it('a position present before the open was created is outside the cycle window', () => {
    const before = snap('2026-10-20T09:00:00.000Z', [{ positionId: MANUAL }]);
    expect(evaluateDemoCycleTest({ intents: [openView(), closeView()], snapshots: [before, BASELINE, SEEN, FINAL] }).result).toBe('passed');
  });

  it('a snapshot taken before the fill was recorded is not a false failure: it is pending until the open is final, then attributed', () => {
    const early = snap('2026-10-20T10:00:03.000Z', [{ positionId: POS }]);
    const pendingOpen = openView({ state: 'SUBMITTED', history: OPEN_HISTORY.slice(0, 5), positionIds: [], settlementType: null });
    const v1 = evaluateDemoCycleTest({ intents: [pendingOpen], snapshots: [BASELINE, early] });
    expect(v1.result).toBe('incomplete');
    expect(v1.failures).toEqual([]);
    expect(v1.pending).toContain('ACTIVITY_NOT_YET_ATTRIBUTABLE');
    expect(evaluateDemoCycleTest({ intents: [openView(), closeView()], snapshots: [BASELINE, early, SEEN, FINAL] }).result).toBe('passed');
  });

  it('the position with another direction or instrument is a mismatch, also after the close', () => {
    const wrong = snap(T.seen, [{ positionId: POS, direction: 'sell' }]);
    const v = evaluateDemoCycleTest({ intents: [openView(), closeView()], snapshots: [BASELINE, wrong, FINAL] });
    expect(v.result).toBe('failed');
    expect(v.failures).toEqual(['POSITION_MISMATCH']);
    expect(v.pending).toEqual(['OPEN_POSITION_NOT_OBSERVED']);
  });

  it('a close of another position or of another open is a target mismatch; two submitted closes fail', () => {
    expect(evaluateDemoCycleTest({ intents: [openView(), closeView({ positionId: POS + 7 })], snapshots: [BASELINE, SEEN, FINAL] }).failures).toEqual(['CLOSE_TARGET_MISMATCH']);
    expect(evaluateDemoCycleTest({ intents: [openView(), closeView(), closeView({ id: 'eint_close2' })], snapshots: [BASELINE, SEEN, FINAL] }).failures).toEqual(['MORE_THAN_ONE_CLOSE_SUBMITTED']);
  });
});
