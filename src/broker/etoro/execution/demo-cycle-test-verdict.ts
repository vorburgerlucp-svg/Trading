// O22 C1: the verdict of the one controlled demo cycle as a TEST, by the operator's success criterion (B6, 2026-10-19).
//
// The cycle reconciliation (demo-cycle-reconciliation.ts) says whether NEXUS's records agree with the latest snapshot. It does not say
// whether the test passed: a product type other than "real" is only a reason there, and after the close the open's item, and with it
// the product type, is no longer shown. This module answers the test question separately, from stored state only (the intent log with
// its broker confirmations, and the stored history of successful read-only syncs). It sends nothing and changes nothing.
//
// passed  only when ALL of these are proved:
//   - exactly one open was submitted, and it is FILLED;
//   - an eToro order status read confirmed exactly one position for it;
//   - that order status stated settlementType "real";
//   - a snapshot taken after the fill and before the close was submitted shows that position with the intent's instrument and side;
//   - exactly one close of that position was submitted, and it is FILLED;
//   - the latest snapshot is fresh, was taken after the close was filled, and no longer shows the position;
//   - no other position and no other pending order appeared in any snapshot from the open's creation on (no external activity).
// failed  as soon as a criterion is definitely broken. Every failure rests on persisted facts that a later event cannot remove (the
//         open's own confirmations, terminal states, stored snapshots), so a failure found before the close is still reported after it.
// incomplete  otherwise: something is not proved yet. Missing or stale evidence is never "passed".

import type { EtoroSnapshotView } from '../etoro-broker-service.js';
import type { IntentView } from './etoro-demo-execution-service.js';

export const DEMO_CYCLE_TEST_VERDICT_VERSION = 'etoro-demo-cycle-test-verdict:v1' as const;

export type DemoCycleTestFailure =
  | 'MORE_THAN_ONE_OPEN_SUBMITTED'
  | 'OPEN_REJECTED'
  | 'OPEN_NOT_FILLED'
  | 'POSITION_BINDING_NOT_UNIQUE'
  | 'SETTLEMENT_TYPE_MISSING'
  | 'SETTLEMENT_TYPE_NOT_REAL'
  | 'POSITION_MISMATCH'
  | 'OPEN_POSITION_NOT_OBSERVED'
  | 'EXTERNAL_ACTIVITY'
  | 'MORE_THAN_ONE_CLOSE_SUBMITTED'
  | 'CLOSE_TARGET_MISMATCH'
  | 'CLOSE_REJECTED'
  | 'CLOSE_NOT_FILLED'
  | 'CLOSE_AMBIGUOUS';

export type DemoCycleTestPending =
  | 'NO_OPEN_SUBMITTED'
  | 'OPEN_PENDING'
  | 'OPEN_AMBIGUOUS'
  | 'OPEN_PARTIALLY_FILLED'
  | 'OPEN_POSITION_NOT_YET_OBSERVED'
  | 'NO_CLOSE_SUBMITTED'
  | 'CLOSE_PENDING'
  | 'FINAL_SNAPSHOT_MISSING'
  | 'FINAL_SNAPSHOT_STALE'
  | 'FINAL_POSITION_STILL_OPEN'
  | 'ACTIVITY_NOT_YET_ATTRIBUTABLE';

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
  /** The product type the open's order status stated, kept after the close. */
  readonly settlementType: string | null;
  readonly finalSnapshot: { readonly snapshotId: string; readonly observedAt: string } | null;
}

/** The states an intent can be in after its one submission without a final outcome. */
const OPEN_PENDING_STATES: ReadonlySet<string> = new Set(['SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'RECONCILED']);
/** Final states: no later broker read changes the intent's positions, order id or product type. */
const FINAL_STATES: ReadonlySet<string> = new Set(['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED']);

function enteredAt(view: IntentView, state: string): string | null {
  return view.history.find((h) => h.state === state)?.at ?? null;
}

function submitted(view: IntentView): boolean {
  return enteredAt(view, 'SUBMITTING') !== null;
}

function ms(at: string): number {
  return Date.parse(at);
}

export function evaluateDemoCycleTest(input: { intents: readonly IntentView[]; snapshots: readonly EtoroSnapshotView[] }): DemoCycleTestVerdict {
  const failures = new Set<DemoCycleTestFailure>();
  const pending = new Set<DemoCycleTestPending>();
  const done = (open: IntentView | null, close: IntentView | null, positionId: number | null, finalSnapshot: EtoroSnapshotView | null): DemoCycleTestVerdict =>
    Object.freeze({
      schema: DEMO_CYCLE_TEST_VERDICT_VERSION,
      result: failures.size > 0 ? 'failed' : pending.size > 0 ? 'incomplete' : 'passed',
      failures: Object.freeze([...failures].sort()),
      pending: Object.freeze([...pending].sort()),
      openIntentId: open?.intentId ?? null,
      closeIntentId: close?.intentId ?? null,
      positionId,
      settlementType: open?.brokerSettlementType ?? null,
      finalSnapshot: finalSnapshot === null ? null : Object.freeze({ snapshotId: finalSnapshot.snapshotId, observedAt: finalSnapshot.observedAt }),
    });

  // The open: exactly one submitted.
  const opens = input.intents.filter((v) => v.intent.action === 'open' && submitted(v));
  if (opens.length === 0) {
    pending.add('NO_OPEN_SUBMITTED');
    return done(null, null, null, null);
  }
  if (opens.length > 1) failures.add('MORE_THAN_ONE_OPEN_SUBMITTED');
  const open = opens[0]!;

  if (open.state === 'REJECTED') failures.add('OPEN_REJECTED');
  else if (open.state === 'CANCELLED' || open.state === 'EXPIRED') failures.add('OPEN_NOT_FILLED');
  else if (open.state === 'AMBIGUOUS') pending.add('OPEN_AMBIGUOUS');
  else if (open.state === 'PARTIALLY_FILLED') pending.add('OPEN_PARTIALLY_FILLED');
  else if (OPEN_PENDING_STATES.has(open.state)) pending.add('OPEN_PENDING');

  const openFilledAt = enteredAt(open, 'FILLED');
  let positionId: number | null = null;
  if (open.state === 'FILLED') {
    // FILLED is final for an open: no later read can add a position or a product type, so these failures cannot disappear.
    if (open.brokerPositionIds.length !== 1) failures.add('POSITION_BINDING_NOT_UNIQUE');
    else positionId = open.brokerPositionIds[0]!;
    if (open.brokerSettlementType === null) failures.add('SETTLEMENT_TYPE_MISSING');
    else if (open.brokerSettlementType !== 'real') failures.add('SETTLEMENT_TYPE_NOT_REAL');
  }

  // The close of that position: exactly one submitted.
  const closes = input.intents.filter((v) => v.intent.action === 'close' && submitted(v));
  if (closes.length > 1) failures.add('MORE_THAN_ONE_CLOSE_SUBMITTED');
  const close = closes[0] ?? null;
  const closeSubmittedAt = close === null ? null : enteredAt(close, 'SUBMITTING');
  if (close === null) {
    if (open.state === 'FILLED' || open.state === 'PARTIALLY_FILLED') pending.add('NO_CLOSE_SUBMITTED');
  } else {
    if (close.intent.closesIntentId !== open.intentId || (positionId !== null && close.intent.positionId !== positionId)) failures.add('CLOSE_TARGET_MISMATCH');
    if (close.state === 'REJECTED') failures.add('CLOSE_REJECTED');
    else if (close.state === 'CANCELLED' || close.state === 'EXPIRED') failures.add('CLOSE_NOT_FILLED');
    // An AMBIGUOUS close is never reconciled by NEXUS: the close cannot be proved, so the test cannot pass.
    else if (close.state === 'AMBIGUOUS') failures.add('CLOSE_AMBIGUOUS');
    else if (close.state !== 'FILLED') pending.add('CLOSE_PENDING');
  }
  const closeFilledAt = close === null ? null : enteredAt(close, 'FILLED');

  // External activity: from the open's creation on, every stored snapshot may hold only the cycle's position and the cycle's orders.
  // A position or order can be attributed only once the intents that could own it are final (their position ids and order ids can
  // no longer change). Before that an unattributed entry is pending, never a failure, so no failure can later disappear.
  const windowStart = enteredAt(open, 'CREATED') ?? open.intent.createdAt;
  const ownOrderIds = new Set<number>([open.brokerOrderId, close?.brokerOrderId ?? null].filter((id): id is number => id !== null));
  const positionsAttributable = FINAL_STATES.has(open.state);
  const ordersAttributable = positionsAttributable && (close === null || FINAL_STATES.has(close.state) || close.brokerOrderId !== null);
  const inWindow = input.snapshots.filter((s) => ms(s.observedAt) >= ms(windowStart));
  for (const s of inWindow) {
    for (const p of s.content.positions ?? []) {
      if (!open.brokerPositionIds.includes(p.positionId)) {
        if (positionsAttributable) failures.add('EXTERNAL_ACTIVITY');
        else pending.add('ACTIVITY_NOT_YET_ATTRIBUTABLE');
        continue;
      }
      if (p.etoroInstrumentId !== open.intent.etoroInstrumentId || p.direction !== open.intent.side) failures.add('POSITION_MISMATCH');
    }
    for (const o of s.content.orders ?? []) {
      if (ownOrderIds.has(o.orderId)) continue;
      if (ordersAttributable) failures.add('EXTERNAL_ACTIVITY');
      else pending.add('ACTIVITY_NOT_YET_ATTRIBUTABLE');
    }
  }

  // The position seen by a read-only sync after the fill and before the close was submitted.
  if (positionId !== null && openFilledAt !== null) {
    const seen = input.snapshots.some((s) =>
      ms(s.observedAt) >= ms(openFilledAt) && (closeSubmittedAt === null || ms(s.observedAt) < ms(closeSubmittedAt)) &&
      (s.content.positions ?? []).some((p) => p.positionId === positionId && p.etoroInstrumentId === open.intent.etoroInstrumentId && p.direction === open.intent.side));
    if (!seen) {
      if (closeSubmittedAt !== null) failures.add('OPEN_POSITION_NOT_OBSERVED');
      else pending.add('OPEN_POSITION_NOT_YET_OBSERVED');
    }
  }

  // The final reconciliation: the latest stored snapshot, fresh, taken after the close was filled, without the position.
  const latest = input.snapshots.length === 0 ? null : input.snapshots[input.snapshots.length - 1]!;
  let finalSnapshot: EtoroSnapshotView | null = null;
  if (close !== null && close.state === 'FILLED' && closeFilledAt !== null) {
    if (latest === null || ms(latest.observedAt) < ms(closeFilledAt)) pending.add('FINAL_SNAPSHOT_MISSING');
    else if (latest.freshness !== 'fresh') pending.add('FINAL_SNAPSHOT_STALE');
    else {
      finalSnapshot = latest;
      if ((latest.content.positions ?? []).some((p) => p.positionId === positionId)) pending.add('FINAL_POSITION_STILL_OPEN');
    }
  }

  return done(open, close, positionId, finalSnapshot);
}
