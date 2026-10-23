// O22 C1: the verdict of the one controlled demo cycle as a TEST, by the operator's success criterion (B6, 2026-10-19), corrected
// after the independent review (F1–F7).
//
// The cycle reconciliation (demo-cycle-reconciliation.ts) describes the CURRENT account against NEXUS's records. This module
// describes the HISTORICAL test: it reads stored state only (the intent log with each broker status read unmerged, and the stored
// history of successful read-only syncs) and never the time of reading. It sends nothing and changes nothing.
//
// passed  only when ALL of these are proved:
//   - exactly one open was submitted, and it is FILLED;
//   - the broker status read that confirmed the fill names exactly one position, and no other fill read of the open names another;
//   - that confirming read states settlementType "real", and no read of the open states another product type;
//   - a snapshot observed after the open was submitted and before the close was filled shows that position (instrument and side);
//   - exactly one close of that position was submitted, and it is FILLED;
//   - a closing snapshot: the first observation, in storage order, taken after the close was filled, at most
//     ETORO_SNAPSHOT_MAX_AGE_MS after it, stored at most that long after it was taken, and no longer showing the position;
//   - no other position and no other order in any snapshot of the test period (observed from the open's creation on, and stored
//     up to and including the closing snapshot).
// failed  as soon as a criterion is definitely broken. A failure is decided only on facts that a later event cannot change: final
//         intent states, the confirming read, and snapshots judged by their own times. An entry of a snapshot is judged external
//         only when no intent that could have owned it at that time can still turn out to own it.
// incomplete  otherwise: evidence missing, still in progress, or not readable consistently. Never "passed".
// The test period ends with the closing snapshot: later observations, and the passing of time, do not change the result.

import { compareObservations, ETORO_SNAPSHOT_MAX_AGE_MS, type EtoroSnapshotObservation } from '../etoro-broker-service.js';
import type { IntentStatusRead, IntentView } from './etoro-demo-execution-service.js';

export const DEMO_CYCLE_TEST_VERDICT_VERSION = 'etoro-demo-cycle-test-verdict:v2' as const;

/** How soon after the close the closing snapshot must be taken, and how soon after it was taken it must be stored. */
export const DEMO_CYCLE_CLOSING_SNAPSHOT_MAX_AGE_MS = ETORO_SNAPSHOT_MAX_AGE_MS;

export type DemoCycleTestFailure =
  | 'MORE_THAN_ONE_OPEN_SUBMITTED'
  | 'OPEN_REJECTED'
  | 'OPEN_NOT_FILLED'
  | 'OPEN_PARTIALLY_FILLED_FINAL'
  | 'POSITION_BINDING_NOT_UNIQUE'
  | 'SETTLEMENT_TYPE_MISSING'
  | 'SETTLEMENT_TYPE_NOT_REAL'
  | 'SETTLEMENT_TYPE_CONTRADICTED'
  | 'POSITION_MISMATCH'
  | 'EXTERNAL_ACTIVITY'
  | 'MORE_THAN_ONE_CLOSE_SUBMITTED'
  | 'CLOSE_TARGET_MISMATCH'
  | 'CLOSE_REJECTED'
  | 'CLOSE_NOT_FILLED'
  | 'CLOSE_AMBIGUOUS'
  /** O22 Plan B: the position was attested as closed outside NEXUS: a manual intervention, the test can never pass. */
  | 'POSITION_CLOSED_EXTERNALLY';

export type DemoCycleTestPending =
  | 'NO_OPEN_SUBMITTED'
  | 'OPEN_PENDING'
  | 'OPEN_AMBIGUOUS'
  | 'OPEN_PARTIALLY_FILLED'
  | 'FILL_CONFIRMATION_NOT_VISIBLE'
  | 'OPEN_POSITION_NOT_OBSERVED'
  | 'NO_CLOSE_SUBMITTED'
  | 'CLOSE_PENDING'
  | 'FINAL_SNAPSHOT_MISSING'
  | 'FINAL_SNAPSHOT_NOT_IN_TIME'
  | 'FINAL_POSITION_STILL_OPEN'
  | 'ACTIVITY_NOT_YET_ATTRIBUTABLE'
  | 'SNAPSHOT_HISTORY_INCOMPLETE';

/** What the verdict reads of a stored observation (EtoroSnapshotObservation). */
export type DemoCycleSnapshot = Pick<EtoroSnapshotObservation, 'snapshotId' | 'observedAt' | 'storedAt' | 'sequence' | 'content'>;

export interface DemoCycleTestVerdict {
  readonly schema: typeof DEMO_CYCLE_TEST_VERDICT_VERSION;
  readonly result: 'passed' | 'failed' | 'incomplete';
  /** Broken criteria, sorted. Non-empty exactly when result is failed. */
  readonly failures: readonly DemoCycleTestFailure[];
  /** Criteria not proved yet, sorted. Reported for a failed test too. */
  readonly pending: readonly DemoCycleTestPending[];
  readonly openIntentId: string | null;
  readonly closeIntentId: string | null;
  readonly positionId: number | null;
  /** The product type stated by the read that confirmed the fill (null: not stated, or no fill yet). */
  readonly settlementType: string | null;
  /** The test period: from the open's creation to the closing snapshot (null while the test is not closed). */
  readonly period: { readonly from: string | null; readonly to: string | null };
  readonly closingSnapshot: { readonly snapshotId: string; readonly observedAt: string } | null;
}

/** States in which an intent's position ids, order id and product type can no longer change. */
const FINAL_STATES: ReadonlySet<string> = new Set(['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED']);
const OPEN_PENDING_STATES: ReadonlySet<string> = new Set(['SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'RECONCILED']);
const FILL_OUTCOMES: ReadonlySet<string> = new Set(['filled', 'partially_filled', 'partially_filled_final']);

function entered(view: IntentView, state: string): { at: string; confirmationId: string | null } | null {
  const h = view.history.find((e) => e.state === state);
  return h === undefined ? null : { at: h.at, confirmationId: h.confirmationId ?? null };
}

function ms(at: string): number {
  return Date.parse(at);
}

function readsOf(view: IntentView): readonly IntentStatusRead[] {
  return view.statusReads ?? [];
}

export function evaluateDemoCycleTest(input: { intents: readonly IntentView[]; snapshots: readonly DemoCycleSnapshot[]; missingSnapshotRecords?: number }): DemoCycleTestVerdict {
  const failures = new Set<DemoCycleTestFailure>();
  const pending = new Set<DemoCycleTestPending>();
  const snapshots = [...input.snapshots].sort(compareObservations);
  if ((input.missingSnapshotRecords ?? 0) > 0) pending.add('SNAPSHOT_HISTORY_INCOMPLETE');

  const done = (open: IntentView | null, close: IntentView | null, positionId: number | null, settlementType: string | null, closing: DemoCycleSnapshot | null): DemoCycleTestVerdict =>
    Object.freeze({
      schema: DEMO_CYCLE_TEST_VERDICT_VERSION,
      result: failures.size > 0 ? 'failed' : pending.size > 0 ? 'incomplete' : 'passed',
      failures: Object.freeze([...failures].sort()),
      pending: Object.freeze([...pending].sort()),
      openIntentId: open?.intentId ?? null,
      closeIntentId: close?.intentId ?? null,
      positionId,
      settlementType,
      period: Object.freeze({ from: open === null ? null : entered(open, 'CREATED')?.at ?? open.intent.createdAt, to: closing?.observedAt ?? null }),
      closingSnapshot: closing === null ? null : Object.freeze({ snapshotId: closing.snapshotId, observedAt: closing.observedAt }),
    });

  // ---------------------------------------------------------------------------------------------------------------- the open
  const opens = input.intents.filter((v) => v.intent.action === 'open' && entered(v, 'SUBMITTING') !== null);
  if (opens.length === 0) {
    pending.add('NO_OPEN_SUBMITTED');
    return done(null, null, null, null, null);
  }
  if (opens.length > 1) failures.add('MORE_THAN_ONE_OPEN_SUBMITTED');
  const open = opens[0]!;
  const openSubmittingAt = entered(open, 'SUBMITTING')!.at;
  const openReads = readsOf(open);

  // A partial fill is final only when the broker says so (outcome partially_filled_final), never because time has passed. Once any
  // read of the open stated it, the failure stays (N2): a later read saying otherwise contradicts it and cannot undo it.
  const statedFinalPartial = openReads.some((r) => r.outcome === 'partially_filled_final');
  if (statedFinalPartial) failures.add('OPEN_PARTIALLY_FILLED_FINAL');
  if (open.state === 'REJECTED') failures.add('OPEN_REJECTED');
  else if (open.state === 'CANCELLED' || open.state === 'EXPIRED') failures.add('OPEN_NOT_FILLED');
  else if (open.state === 'AMBIGUOUS') pending.add('OPEN_AMBIGUOUS');
  else if (open.state === 'PARTIALLY_FILLED' && !statedFinalPartial) pending.add('OPEN_PARTIALLY_FILLED');
  else if (OPEN_PENDING_STATES.has(open.state)) pending.add('OPEN_PENDING');
  // The binding can still grow while the open is PARTIALLY_FILLED (a refresh is allowed there), so it is final only in a final state.
  let openBindingFinal = FINAL_STATES.has(open.state);
  // O22 Plan B: an attested external closure ends the position's liveness, never the test: it is a manual intervention (runbook).
  if (open.externalClosure !== null && open.externalClosure !== undefined) failures.add('POSITION_CLOSED_EXTERNALLY');

  // The positions the broker confirmed by fill reads (the same reads closePositionOf trusts).
  const fillReads = openReads.filter((r) => r.kind === 'order_status' && r.outcome !== null && FILL_OUTCOMES.has(r.outcome));
  const boundPositions = new Set<number>(fillReads.flatMap((r) => [...r.brokerPositionIds]));

  // F6: the authoritative evidence is the read that confirmed FILLED; an earlier or merged value never stands in for it.
  let positionId: number | null = null;
  let settlementType: string | null = null;
  if (open.state === 'FILLED') {
    const confirmationId = entered(open, 'FILLED')!.confirmationId;
    const confirming = confirmationId === null ? undefined : openReads.find((r) => r.confirmationId === confirmationId);
    if (confirming === undefined) {
      // The binding cannot be read consistently: nothing in a snapshot can be judged external against it.
      pending.add('FILL_CONFIRMATION_NOT_VISIBLE');
      openBindingFinal = false;
    } else {
      settlementType = confirming.settlementType;
      if (confirming.brokerPositionIds.length !== 1 || boundPositions.size !== 1 || !boundPositions.has(confirming.brokerPositionIds[0]!)) failures.add('POSITION_BINDING_NOT_UNIQUE');
      else positionId = confirming.brokerPositionIds[0]!;
      if (confirming.settlementType === null) failures.add('SETTLEMENT_TYPE_MISSING');
      else if (confirming.settlementType !== 'real') failures.add('SETTLEMENT_TYPE_NOT_REAL');
    }
    // Any read of the open stating another product type contradicts the evidence, whichever read came last.
    const stated = new Set(openReads.map((r) => r.settlementType).filter((t): t is string => t !== null));
    if (stated.size > 1) failures.add('SETTLEMENT_TYPE_CONTRADICTED');
  }

  // --------------------------------------------------------------------------------------------------------------- the close
  const closes = input.intents.filter((v) => v.intent.action === 'close' && entered(v, 'SUBMITTING') !== null);
  if (closes.length > 1) failures.add('MORE_THAN_ONE_CLOSE_SUBMITTED');
  const close = closes[0] ?? null;
  const closeSubmittingAt = close === null ? null : entered(close, 'SUBMITTING')!.at;
  if (close === null) {
    if (open.state === 'FILLED' || open.state === 'PARTIALLY_FILLED') pending.add('NO_CLOSE_SUBMITTED');
  } else {
    if (close.intent.closesIntentId !== open.intentId || (positionId !== null && close.intent.positionId !== positionId)) failures.add('CLOSE_TARGET_MISMATCH');
    if (close.state === 'REJECTED') failures.add('CLOSE_REJECTED');
    else if (close.state === 'CANCELLED' || close.state === 'EXPIRED') failures.add('CLOSE_NOT_FILLED');
    // An AMBIGUOUS close is never reconciled by NEXUS: the close can never be proved.
    else if (close.state === 'AMBIGUOUS') failures.add('CLOSE_AMBIGUOUS');
    else if (close.state !== 'FILLED') pending.add('CLOSE_PENDING');
  }
  const closeFilledAt = close === null ? null : entered(close, 'FILLED')?.at ?? null;

  // ------------------------------------------------------------------------------------------------- the closing snapshot (F2)
  // Judged by the snapshot's own times, never by the time of reading.
  let closing: DemoCycleSnapshot | null = null;
  if (closeFilledAt !== null) {
    const after = snapshots.filter((s) => ms(s.observedAt) >= ms(closeFilledAt));
    const inTime = after.filter((s) => ms(s.observedAt) - ms(closeFilledAt) <= DEMO_CYCLE_CLOSING_SNAPSHOT_MAX_AGE_MS && ms(s.storedAt) - ms(s.observedAt) <= DEMO_CYCLE_CLOSING_SNAPSHOT_MAX_AGE_MS);
    const showsBound = (s: DemoCycleSnapshot) => (s.content.positions ?? []).some((p) => boundPositions.has(p.positionId));
    // N1: the first qualifying observation in STORAGE order closes the test. A snapshot stored later, whatever it observed, can
    // neither replace it nor join the closed period.
    closing = [...inTime].sort((a, b) => a.sequence - b.sequence).find((s) => !showsBound(s)) ?? null;
    if (closing === null) {
      if (inTime.length > 0) pending.add('FINAL_POSITION_STILL_OPEN');
      else if (after.length > 0) pending.add('FINAL_SNAPSHOT_NOT_IN_TIME');
      else pending.add('FINAL_SNAPSHOT_MISSING');
    }
  }

  // ------------------------------------------------------------------------------------- activity within the test period (F1)
  const periodFrom = entered(open, 'CREATED')?.at ?? open.intent.createdAt;
  // The closed period is a point in the append-only sync log: every observation stored up to and including the closing one.
  const period = snapshots.filter((s) => ms(s.observedAt) >= ms(periodFrom) && (closing === null || s.sequence <= closing.sequence));
  // An intent can own an entry of a snapshot only if it was submitted before that snapshot was stored. It is still unknown whether
  // it owns an order while it may have one whose id NEXUS has not recorded (not final, no order id yet).
  const orderUnknown = (v: IntentView): boolean => v.brokerOrderId === null && !FINAL_STATES.has(v.state);
  for (const s of period) {
    const storedMs = ms(s.storedAt);
    const openCandidate = ms(openSubmittingAt) <= storedMs;
    const closeCandidate = close !== null && closeSubmittingAt !== null && ms(closeSubmittingAt) <= storedMs;
    for (const p of s.content.positions ?? []) {
      if (boundPositions.has(p.positionId)) {
        if (p.etoroInstrumentId !== open.intent.etoroInstrumentId || p.direction !== open.intent.side) failures.add('POSITION_MISMATCH');
        continue;
      }
      // Only the open can own a position; it can still turn out to own this one while its binding is not final.
      if (openCandidate && !openBindingFinal) pending.add('ACTIVITY_NOT_YET_ATTRIBUTABLE');
      else failures.add('EXTERNAL_ACTIVITY');
    }
    for (const o of s.content.orders ?? []) {
      if (o.orderId === open.brokerOrderId || (close !== null && o.orderId === close.brokerOrderId)) continue;
      const undecided = (openCandidate && orderUnknown(open)) || (closeCandidate && orderUnknown(close!));
      if (undecided) pending.add('ACTIVITY_NOT_YET_ATTRIBUTABLE');
      else failures.add('EXTERNAL_ACTIVITY');
    }
  }

  // ------------------------------------------------------------------------------- the open position observed (F3: never failed)
  if (positionId !== null) {
    // D1: only observations within the same closed period count (stored up to the closing snapshot), so a snapshot stored later can
    // neither complete this proof nor escape the activity check.
    const inClosedPeriod = (s: DemoCycleSnapshot) => closing === null || s.sequence <= closing.sequence;
    const seen = snapshots.some((s) => inClosedPeriod(s) &&
      ms(s.observedAt) >= ms(openSubmittingAt) && (closeFilledAt === null || ms(s.observedAt) < ms(closeFilledAt)) &&
      (s.content.positions ?? []).some((p) => p.positionId === positionId && p.etoroInstrumentId === open.intent.etoroInstrumentId && p.direction === open.intent.side));
    if (!seen) pending.add('OPEN_POSITION_NOT_OBSERVED');
  }

  return done(open, close, positionId, settlementType, closing);
}
