// O22: the read-only check of the demo cycle against a stored /demo/portfolio snapshot. Positions are identified by the positionID
// of a broker order status, never by instrument; only a snapshot observed after the confirming state can confirm; anything unproved
// is "unknown", never "consistent". A pure function: nothing is sent, written or booked.
import { describe, expect, it } from 'vitest';
import { reconcileDemoCycle } from '../../../src/broker/etoro/execution/demo-cycle-reconciliation.js';
import type { IntentView } from '../../../src/broker/etoro/execution/etoro-demo-execution-service.js';
import type { EtoroSnapshotView } from '../../../src/broker/etoro/etoro-broker-service.js';

const ETH = 100001;
const NEXUS_POSITION = 3000000001;
const MANUAL_POSITION = 3000000999;
const FILLED_AT = '2026-10-20T10:00:05.000Z';
const CLOSED_AT = '2026-10-20T10:20:05.000Z';

function view(v: { id: string; action: 'open' | 'close'; state: string; positionIds?: number[]; positionId?: number | null; side?: 'buy' | 'sell'; etoroId?: number; filledAt?: string }): IntentView {
  return {
    intentId: v.id,
    state: v.state,
    intent: { action: v.action, etoroInstrumentId: v.etoroId ?? ETH, side: v.side ?? 'buy', positionId: v.positionId ?? null },
    brokerPositionIds: v.positionIds ?? [],
    history: [{ state: 'CREATED', at: '2026-10-20T09:59:00.000Z', reason: 'x' }, ...(v.state === 'FILLED' ? [{ state: 'FILLED', at: v.filledAt ?? FILLED_AT, reason: 'x' }] : [])],
  } as unknown as IntentView;
}

function snapshot(positions: Array<{ positionId: number; etoroInstrumentId?: number; direction?: 'buy' | 'sell' }>, options: { observedAt?: string; freshness?: 'fresh' | 'stale'; orders?: number } = {}): EtoroSnapshotView {
  return {
    snapshotId: 'esnap_test',
    observedAt: options.observedAt ?? '2026-10-20T10:01:00.000Z',
    retrievedAt: options.observedAt ?? '2026-10-20T10:01:00.000Z',
    freshness: options.freshness ?? 'fresh',
    content: {
      positions: positions.map((p) => ({ positionId: p.positionId, etoroInstrumentId: p.etoroInstrumentId ?? ETH, direction: p.direction ?? 'buy', units: '0.04', instrumentId: null })),
      ...(options.orders ? { orders: Array.from({ length: options.orders }, (_, i) => ({ orderId: i + 1 })) } : {}),
    },
  } as unknown as EtoroSnapshotView;
}

const open = view({ id: 'eint_open', action: 'open', state: 'FILLED', positionIds: [NEXUS_POSITION] });
const close = view({ id: 'eint_close', action: 'close', state: 'FILLED', positionId: NEXUS_POSITION, filledAt: CLOSED_AT });

describe('O22 cycle reconciliation', () => {
  it('after the open: the broker-confirmed position is in a later fresh snapshot -> consistent', () => {
    const r = reconcileDemoCycle([open], snapshot([{ positionId: NEXUS_POSITION }]));
    expect(r.verdict).toBe('consistent');
    expect(r.items).toEqual([{ intentId: 'eint_open', action: 'open', state: 'FILLED', kind: 'open_position_confirmed', positionId: NEXUS_POSITION }]);
    expect(r.externalPositions).toEqual([]);
  });

  it('a hand-opened position on the same instrument is external: it is never taken for the NEXUS position', () => {
    const missing = reconcileDemoCycle([open], snapshot([{ positionId: MANUAL_POSITION }]));
    expect(missing.verdict).toBe('inconsistent');
    expect(missing.items[0]!.kind).toBe('open_position_missing');
    expect(missing.externalPositions).toEqual([{ positionId: MANUAL_POSITION, etoroInstrumentId: ETH, direction: 'buy' }]);
    const both = reconcileDemoCycle([open], snapshot([{ positionId: NEXUS_POSITION }, { positionId: MANUAL_POSITION }]));
    expect(both.verdict).toBe('consistent');
    expect(both.reasons).toEqual(['EXTERNAL_POSITIONS_PRESENT']);
  });

  it('the position with another instrument or direction is a mismatch', () => {
    expect(reconcileDemoCycle([open], snapshot([{ positionId: NEXUS_POSITION, etoroInstrumentId: 100000 }])).items[0]!.kind).toBe('position_mismatch');
    expect(reconcileDemoCycle([open], snapshot([{ positionId: NEXUS_POSITION, direction: 'sell' }])).verdict).toBe('inconsistent');
  });

  it('after the close: the position is gone from a later snapshot -> consistent; still there -> inconsistent', () => {
    const after = '2026-10-20T10:21:00.000Z';
    const gone = reconcileDemoCycle([open, close], snapshot([], { observedAt: after }));
    expect(gone.verdict).toBe('consistent');
    expect(gone.items).toEqual([{ intentId: 'eint_close', action: 'close', state: 'FILLED', kind: 'close_confirmed', positionId: NEXUS_POSITION }]);
    const still = reconcileDemoCycle([open, close], snapshot([{ positionId: NEXUS_POSITION }], { observedAt: after }));
    expect(still.verdict).toBe('inconsistent');
    expect(still.items[0]!.kind).toBe('closed_position_still_open');
  });

  it('a snapshot older than the fill or the close decides nothing', () => {
    const early = reconcileDemoCycle([open], snapshot([], { observedAt: '2026-10-20T10:00:00.000Z' }));
    expect(early.verdict).toBe('unknown');
    expect(early.items[0]!.kind).toBe('snapshot_predates_intent');
    const beforeClose = reconcileDemoCycle([open, close], snapshot([], { observedAt: '2026-10-20T10:10:00.000Z' }));
    expect(beforeClose.verdict).toBe('unknown');
  });

  it('a missing or stale snapshot, or an unresolved intent, is unknown, never consistent', () => {
    expect(reconcileDemoCycle([open], null).verdict).toBe('unknown');
    expect(reconcileDemoCycle([open], null).reasons).toContain('SNAPSHOT_MISSING');
    expect(reconcileDemoCycle([open], snapshot([{ positionId: NEXUS_POSITION }], { freshness: 'stale' })).verdict).toBe('unknown');
    for (const state of ['SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'AMBIGUOUS', 'RECONCILED', 'PARTIALLY_FILLED']) {
      const r = reconcileDemoCycle([view({ id: 'eint_x', action: 'open', state })], snapshot([]));
      expect(r.verdict, state).toBe('unknown');
      expect(r.items[0]!.kind).toBe('outcome_pending');
    }
  });

  it('pending broker orders are reported, and terminal intents without a position add nothing', () => {
    const r = reconcileDemoCycle([view({ id: 'eint_r', action: 'open', state: 'REJECTED' })], snapshot([], { orders: 2 }));
    expect(r.items).toEqual([]);
    expect(r.brokerPendingOrders).toBe(2);
    expect(r.reasons).toEqual(['BROKER_PENDING_ORDERS_PRESENT']);
  });
});
