// O22: the read-only check of the controlled demo cycle against the broker portfolio. It compares what the execution layer knows
// from broker-confirmed order status (the position ids of a FILLED open, a FILLED close of such a position) with a stored O20
// /demo/portfolio snapshot. A pure function: no broker request, no write, no booking, no correction.
//
// A position is identified by its eToro positionID from an order status read, never by its instrument: a position the operator
// opened by hand on the same instrument is reported as external, not taken for the one NEXUS opened. Only a snapshot observed after
// the confirming state can confirm it; an older one decides nothing. Anything that is not proved is "unknown", never "consistent".

import type { EtoroSnapshotView } from '../etoro-broker-service.js';
import type { IntentView } from './etoro-demo-execution-service.js';

export const DEMO_CYCLE_RECONCILIATION_VERSION = 'etoro-demo-cycle-reconciliation:v1' as const;

export type CycleItemKind =
  /** A FILLED open's position is in the snapshot, with the intent's eToro instrument and direction. */
  | 'open_position_confirmed'
  /** A FILLED open's position is not in a snapshot taken after the fill (closed outside NEXUS, by SL/TP, or not visible). */
  | 'open_position_missing'
  /** The position is in the snapshot, but with another instrument or direction. */
  | 'position_mismatch'
  /** A FILLED close's position is no longer in a snapshot taken after the close. */
  | 'close_confirmed'
  /** A FILLED close's position is still in a snapshot taken after the close. */
  | 'closed_position_still_open'
  /** The intent may be live at the broker, but its outcome is not confirmed (submitted, accepted, ambiguous, reconciled, ...). */
  | 'outcome_pending'
  /** The snapshot was observed before the state it would have to confirm. */
  | 'snapshot_predates_intent'
  /**
   * O22 Plan B: an operator attested on complete stored evidence that the FILLED open's position was closed outside NEXUS, and the
   * snapshot does not show it. Not a close by NEXUS: no close order, fill or booking is implied.
   */
  | 'closed_externally'
  /** O22 Plan B: the snapshot shows a position that was attested as closed outside NEXUS: the attestation is contradicted. */
  | 'closed_externally_contradicted';

export interface CycleItem {
  readonly intentId: string;
  readonly action: 'open' | 'close';
  readonly state: string;
  readonly kind: CycleItemKind;
  readonly positionId: number | null;
  /** The product type the broker stated in the order status of this intent (cfd, real, ...), or null when it stated none. */
  readonly settlementType: string | null;
}

export interface DemoCycleReconciliation {
  readonly schema: typeof DEMO_CYCLE_RECONCILIATION_VERSION;
  readonly verdict: 'consistent' | 'inconsistent' | 'unknown';
  readonly reasons: readonly string[];
  readonly snapshotId: string | null;
  readonly snapshotObservedAt: string | null;
  readonly items: readonly CycleItem[];
  /** Positions in the snapshot that no NEXUS intent opened (for example one the operator opened by hand). Never closed by NEXUS. */
  readonly externalPositions: readonly { readonly positionId: number; readonly etoroInstrumentId: number; readonly direction: string }[];
  /** Pending orders in the snapshot (clientPortfolio.orders). */
  readonly brokerPendingOrders: number;
}

const INCONSISTENT: ReadonlySet<CycleItemKind> = new Set(['open_position_missing', 'position_mismatch', 'closed_position_still_open', 'closed_externally_contradicted']);
const UNKNOWN: ReadonlySet<CycleItemKind> = new Set(['outcome_pending', 'snapshot_predates_intent']);
/** States in which a write may have reached the broker without a confirmed final outcome. */
const PENDING_STATES: ReadonlySet<string> = new Set(['SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'AMBIGUOUS', 'RECONCILED', 'PARTIALLY_FILLED']);

function enteredAt(view: IntentView, state: string): string | null {
  return view.history.find((h) => h.state === state)?.at ?? null;
}

export function reconcileDemoCycle(intents: readonly IntentView[], snapshot: EtoroSnapshotView | null): DemoCycleReconciliation {
  const reasons: string[] = [];
  const items: CycleItem[] = [];
  const positions = snapshot?.content.positions ?? [];
  const byId = new Map(positions.map((p) => [p.positionId, p]));
  const nexusPositions = new Set<number>();
  for (const v of intents) for (const id of v.brokerPositionIds) nexusPositions.add(id);

  if (snapshot === null) reasons.push('SNAPSHOT_MISSING');
  else if (snapshot.freshness !== 'fresh') reasons.push('SNAPSHOT_STALE');

  const closedBy = new Map<number, IntentView>();
  for (const v of intents) if (v.intent.action === 'close' && v.state === 'FILLED' && v.intent.positionId !== null) closedBy.set(v.intent.positionId, v);

  const after = (at: string | null): boolean => snapshot !== null && at !== null && Date.parse(snapshot.observedAt) >= Date.parse(at);

  for (const v of intents) {
    const base = { intentId: v.intentId, action: v.intent.action, state: v.state, settlementType: v.brokerSettlementType ?? null };
    if (PENDING_STATES.has(v.state)) {
      items.push({ ...base, kind: 'outcome_pending', positionId: v.intent.positionId });
      continue;
    }
    if (v.state !== 'FILLED') continue;
    if (v.intent.action === 'close') {
      const id = v.intent.positionId;
      if (id === null) continue;
      if (!after(enteredAt(v, 'FILLED'))) items.push({ ...base, kind: 'snapshot_predates_intent', positionId: id });
      else items.push({ ...base, kind: byId.has(id) ? 'closed_position_still_open' : 'close_confirmed', positionId: id });
      continue;
    }
    // A FILLED open: each broker-confirmed position, unless a FILLED close of NEXUS closed it.
    for (const id of v.brokerPositionIds) {
      if (closedBy.has(id)) continue;
      if (v.externalClosure?.positionId === id) {
        // Judged against the attestation's own snapshot: an older snapshot decides nothing, a newer one must not show the position.
        if (snapshot === null || Date.parse(snapshot.observedAt) < Date.parse(v.externalClosure.snapshotObservedAt)) items.push({ ...base, kind: 'snapshot_predates_intent', positionId: id });
        else items.push({ ...base, kind: byId.has(id) ? 'closed_externally_contradicted' : 'closed_externally', positionId: id });
        continue;
      }
      if (!after(enteredAt(v, 'FILLED'))) {
        items.push({ ...base, kind: 'snapshot_predates_intent', positionId: id });
        continue;
      }
      const p = byId.get(id);
      if (p === undefined) items.push({ ...base, kind: 'open_position_missing', positionId: id });
      else if (p.etoroInstrumentId !== v.intent.etoroInstrumentId || p.direction !== v.intent.side) items.push({ ...base, kind: 'position_mismatch', positionId: id });
      else items.push({ ...base, kind: 'open_position_confirmed', positionId: id });
    }
  }

  for (const item of items) {
    if (INCONSISTENT.has(item.kind) || UNKNOWN.has(item.kind) || item.kind === 'closed_externally') reasons.push(item.kind.toUpperCase());
    // The units of a CFD or margin position are not an asset quantity: a filled open that the broker did not state as "real" is flagged.
    if (item.action === 'open' && item.kind === 'open_position_confirmed' && item.settlementType !== 'real') reasons.push('PRODUCT_TYPE_NOT_CONFIRMED_REAL');
  }
  const externalPositions = positions
    .filter((p) => !nexusPositions.has(p.positionId))
    .map((p) => ({ positionId: p.positionId, etoroInstrumentId: p.etoroInstrumentId, direction: p.direction }));
  if (externalPositions.length > 0) reasons.push('EXTERNAL_POSITIONS_PRESENT');
  const brokerPendingOrders = snapshot?.content.orders?.length ?? 0;
  if (brokerPendingOrders > 0) reasons.push('BROKER_PENDING_ORDERS_PRESENT');

  const verdict: DemoCycleReconciliation['verdict'] = items.some((i) => INCONSISTENT.has(i.kind))
    ? 'inconsistent'
    : snapshot === null || snapshot.freshness !== 'fresh' || items.some((i) => UNKNOWN.has(i.kind))
      ? 'unknown'
      : 'consistent';

  return Object.freeze({
    schema: DEMO_CYCLE_RECONCILIATION_VERSION,
    verdict,
    reasons: Object.freeze([...new Set(reasons)]),
    snapshotId: snapshot?.snapshotId ?? null,
    snapshotObservedAt: snapshot?.observedAt ?? null,
    items: Object.freeze(items),
    externalPositions: Object.freeze(externalPositions),
    brokerPendingOrders,
  });
}
