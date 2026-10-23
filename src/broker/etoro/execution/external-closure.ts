// O22 Plan B: the operator's attestation that a position NEXUS opened was closed OUTSIDE NEXUS (by hand in the broker app, by a
// stop-loss, ...). It is a separate append-only record (log etoro-demo-external-closures), never an intent state and never a broker
// confirmation: it does not claim a close order, a fill, a price or a P&L, it books nothing and it changes no budget. Its only
// effect is that the position no longer counts as live for NEXUS (book, reconciliation); the O22 test verdict stays NOT passed.
//
// A pure module: the rule that decides whether the stored evidence is complete (externalClosureRefusals), the record, and the checks
// that use it. The service gathers the stored facts and appends the record under the log's lock.
//
// The evidence, all from stored records (no broker request), all required (fail closed):
//   1. the open is FILLED (or PARTIALLY_FILLED with a read stating the partial fill final), and the read that confirmed that state is
//      a checked order status read of this open, of its broker order, naming exactly one position; no fill read names another one;
//   2. the operator names that position (a cross-check; the position is never taken from the claim);
//   3. no NEXUS close of the position is filled, in progress or unresolved (only REJECTED, CANCELLED or EXPIRED ones may exist);
//   4. a stored snapshot observed AFTER that read and after the binding, complete, that is the one newest successful observation
//      (no later one, none with the same time and another content, no unreadable record), does not show the position and does not
//      show the open's order as pending;
//   5. an authenticated human operator states it explicitly;
//   6. no attestation of this open exists yet (one per position, fixed record id).
// Review of PR #33:
//   R2  every stored observation is consistent (counts equal the lists, coverage agrees with them, no duplicate, id = content hash);
//   R3  account identity: NEXUS stores none (no CID, no /me identifier), so no binding of order and snapshot to one account is
//       claimed (record: accountIdentity 'not_verified'). Two fail-closed controls narrow it: continuity (a snapshot taken after the
//       order was submitted showed the position as opened by exactly that order, so the portfolio read then was of the account
//       that holds the order) and the operator's explicit statement that every read came from that same demo account;
//   R1  the effect is decided at read time: an attestation has no effect while a NEXUS close of the position may have been sent
//       (externalClosureEffective), and a close is not sent once it sees an attestation after its reservation (service).

import { hashOf } from '../../../persistence/canonical-json.js';
import { compareObservations, snapshotContentProblems, type EtoroSnapshotHistory, type EtoroSnapshotObservation } from '../etoro-broker-service.js';
import type { IntentActor, IntentSide, IntentState } from './execution-intent.js';
import type { ClosePositionEvidenceProblem, ClosePositionSnapshot } from './execution-gate.js';

export const EXTERNAL_CLOSURE_SCHEMA = 'etoro-demo-external-closure:v1' as const;
/** The one statement an operator can make; anything else is refused. */
export const EXTERNAL_CLOSURE_STATEMENT = 'POSITION_CLOSED_OUTSIDE_NEXUS' as const;
/**
 * R3: the operator's explicit statement that the order and every portfolio read come from the same eToro demo account (the same
 * configured credentials). A fail-closed operator control, not a technical proof: NEXUS stores no account identity.
 */
export const EXTERNAL_CLOSURE_ACCOUNT_STATEMENT = 'SAME_ETORO_DEMO_ACCOUNT' as const;

/**
 * R1: the states of a NEXUS close in which it may have been sent to the broker (or was filled). While a close of the position is in
 * one of them, an attestation has no effect.
 */
export const CLOSE_POSSIBLY_SENT_STATES: ReadonlySet<IntentState> = new Set(['SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'AMBIGUOUS', 'RECONCILED']);

/** The head of a log the evidence was checked against: its record count and the hash of its last record. */
export interface LogHead {
  readonly size: number;
  readonly headHash: string;
}

export interface ExternalClosureRecord {
  readonly schema: typeof EXTERNAL_CLOSURE_SCHEMA;
  /** 'eext_' + hash of the open and the position: one attestation per position, whoever writes first. */
  readonly closureId: string;
  readonly openIntentId: string;
  readonly positionId: number;
  readonly etoroInstrumentId: number;
  readonly direction: IntentSide;
  readonly brokerOrderId: number;
  /** The checked order status read that bound the order to the position, and when the open entered its fill state with it. */
  readonly bindingConfirmationId: string;
  readonly boundAt: string;
  /** The stored snapshot that no longer shows the position: the one newest successful observation when the record was made. */
  readonly snapshotId: string;
  readonly snapshotObservedAt: string;
  readonly snapshotSyncSequence: number;
  readonly snapshotPositionCount: number;
  /** R3: the earlier snapshot that showed the position as opened by exactly the open's order (continuity of the portfolio reads). */
  readonly continuitySnapshotId: string;
  readonly continuitySnapshotObservedAt: string;
  /** R3: NEXUS has no stored account identity; the binding of order and snapshots to one account is not technically verified. */
  readonly accountIdentity: 'not_verified';
  readonly accountStatement: typeof EXTERNAL_CLOSURE_ACCOUNT_STATEMENT;
  /** The heads of the logs the evidence was read from, so the check can be repeated on exactly that stored state. */
  readonly evidenceHeads: { readonly intents: LogHead; readonly confirmations: LogHead; readonly observations: number };
  readonly statement: typeof EXTERNAL_CLOSURE_STATEMENT;
  readonly attestedBy: IntentActor;
  readonly attestedAt: string;
  /** The only effect: the position no longer counts as live for NEXUS. No close, fill, booking or budget change. */
  readonly effect: 'liveness_ended';
}

/** What an operator submits. The position and the snapshot are cross-checks: both must equal what the stored evidence names. */
export interface ExternalClosureClaim {
  readonly positionId: number;
  readonly snapshotId: string;
  readonly statement: typeof EXTERNAL_CLOSURE_STATEMENT;
  readonly accountStatement: typeof EXTERNAL_CLOSURE_ACCOUNT_STATEMENT;
}

export class ExternalClosureClaimError extends Error {
  override readonly name = 'ExternalClosureClaimError';
}

const SNAPSHOT_ID = /^esnap_[0-9a-f]{40}$/;

/** Exactly { positionId, snapshotId, statement, accountStatement }, nothing else. */
export function parseExternalClosureClaim(input: unknown): ExternalClosureClaim {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ExternalClosureClaimError('the claim must be an object');
  const v = input as Record<string, unknown>;
  const keys = Object.keys(v).sort();
  if (keys.join(',') !== 'accountStatement,positionId,snapshotId,statement') throw new ExternalClosureClaimError('the claim has exactly positionId, snapshotId, statement and accountStatement');
  if (typeof v.positionId !== 'number' || !Number.isSafeInteger(v.positionId) || v.positionId <= 0) throw new ExternalClosureClaimError('positionId');
  if (typeof v.snapshotId !== 'string' || !SNAPSHOT_ID.test(v.snapshotId)) throw new ExternalClosureClaimError('snapshotId');
  if (v.statement !== EXTERNAL_CLOSURE_STATEMENT) throw new ExternalClosureClaimError('statement');
  if (v.accountStatement !== EXTERNAL_CLOSURE_ACCOUNT_STATEMENT) throw new ExternalClosureClaimError('accountStatement');
  return Object.freeze({ positionId: v.positionId, snapshotId: v.snapshotId, statement: EXTERNAL_CLOSURE_STATEMENT, accountStatement: EXTERNAL_CLOSURE_ACCOUNT_STATEMENT });
}

export function externalClosureId(openIntentId: string, positionId: number): string {
  return 'eext_' + hashOf({ openIntentId, positionId }).slice(0, 40);
}

/** The stored facts the rule reads; the service builds them from its logs. */
export interface ExternalClosureFacts {
  readonly open: {
    readonly intentId: string;
    readonly action: 'open' | 'close';
    readonly state: IntentState;
    readonly etoroInstrumentId: number;
    readonly side: IntentSide;
    readonly brokerOrderId: number | null;
    readonly events: readonly { readonly state: IntentState; readonly at: string; readonly confirmationId?: string }[];
  } | null;
  /** Every broker confirmation of the open. */
  readonly confirmations: readonly {
    readonly confirmationId: string;
    readonly kind: string;
    readonly brokerOrderId: number | null;
    readonly brokerPositionIds: readonly number[];
    readonly outcome: string | null;
    readonly observedAt: string;
    readonly appliesFrom?: IntentState;
    readonly target?: IntentState | null;
  }[];
  /** Every NEXUS close that refers to the open or to one of its positions. */
  readonly closes: readonly { readonly state: IntentState }[];
  /** Attestations already stored for the open. */
  readonly existing: readonly ExternalClosureRecord[];
  readonly history: EtoroSnapshotHistory;
}

export interface ExternalClosureEvidence {
  readonly positionId: number;
  readonly etoroInstrumentId: number;
  readonly direction: IntentSide;
  readonly brokerOrderId: number;
  readonly bindingConfirmationId: string;
  readonly boundAt: string;
  readonly snapshot: EtoroSnapshotObservation;
  readonly continuity: EtoroSnapshotObservation;
}

const FILL_OUTCOMES: ReadonlySet<string> = new Set(['filled', 'partially_filled', 'partially_filled_final']);
const CLOSE_SETTLED_UNFILLED: ReadonlySet<IntentState> = new Set(['REJECTED', 'CANCELLED', 'EXPIRED']);

function ms(at: string): number {
  return Date.parse(at);
}

/**
 * The rule. Returns the evidence when every condition holds, or the fixed reason codes of every condition that does not. Pure: the
 * same facts always give the same answer.
 */
export function externalClosureRefusals(claim: ExternalClosureClaim, facts: ExternalClosureFacts): { reasons: string[]; evidence: ExternalClosureEvidence | null } {
  const reasons: string[] = [];
  const refused = (...r: string[]) => ({ reasons: [...reasons, ...r], evidence: null });
  const open = facts.open;
  if (open === null) return refused('OPEN_NOT_FOUND');
  if (open.action !== 'open') return refused('NOT_AN_OPEN');
  if (facts.existing.length > 0) return refused('ALREADY_ATTESTED');

  // 1. The binding: a checked order status read of this open that confirmed its fill state with exactly one position.
  const finalPartial = facts.confirmations.some((c) => c.kind === 'order_status' && c.outcome === 'partially_filled_final');
  if (!(open.state === 'FILLED' || (open.state === 'PARTIALLY_FILLED' && finalPartial))) return refused('OPEN_NOT_FILLED');
  const bindingEvent = open.events.find((e) => e.state === 'FILLED' || e.state === 'PARTIALLY_FILLED');
  const binding = bindingEvent?.confirmationId === undefined ? undefined : facts.confirmations.find((c) => c.confirmationId === bindingEvent.confirmationId);
  if (bindingEvent === undefined || binding === undefined || binding.kind !== 'order_status' || binding.outcome === null || !FILL_OUTCOMES.has(binding.outcome) || binding.target !== bindingEvent.state) {
    return refused('BINDING_NOT_CHECKED');
  }
  if (open.brokerOrderId === null || binding.brokerOrderId !== open.brokerOrderId) return refused('BINDING_ORDER_MISMATCH');
  const fillPositions = new Set(facts.confirmations.filter((c) => c.kind === 'order_status' && c.outcome !== null && FILL_OUTCOMES.has(c.outcome)).flatMap((c) => [...c.brokerPositionIds]));
  if (binding.brokerPositionIds.length !== 1 || fillPositions.size !== 1) return refused('BINDING_NOT_UNIQUE');
  const positionId = binding.brokerPositionIds[0]!;

  // 2. The operator's claim names that position (never the source of it).
  if (claim.positionId !== positionId) reasons.push('POSITION_ID_MISMATCH');

  // 3. No NEXUS close of the position may be filled, in progress or unresolved.
  if (facts.closes.some((c) => c.state === 'FILLED')) reasons.push('NEXUS_CLOSE_FILLED');
  else if (facts.closes.some((c) => !CLOSE_SETTLED_UNFILLED.has(c.state))) reasons.push('NEXUS_CLOSE_UNRESOLVED');

  // 4. The snapshot: the one newest successful observation, complete, after the binding, without the position and its order.
  const boundAt = bindingEvent.at;
  // A snapshot id is the hash of its content, so the same content can be observed more than once: the evidence is always the newest
  // observation, and the operator's snapshot id must name its content.
  const observations = [...facts.history.observations].sort(compareObservations);
  if (facts.history.missingSnapshotRecords > 0) reasons.push('SNAPSHOT_HISTORY_INCOMPLETE');
  // R2: no stored observation may contradict itself (counts, coverage, duplicates, id = content hash).
  if (observations.some((o) => snapshotContentProblems(o.snapshotId, o.content).length > 0)) reasons.push('SNAPSHOT_HISTORY_INCONSISTENT');
  const snapshot = observations.at(-1);
  if (snapshot === undefined || !observations.some((o) => o.snapshotId === claim.snapshotId)) return refused('SNAPSHOT_NOT_FOUND');
  if (snapshot.snapshotId !== claim.snapshotId) return refused('SNAPSHOT_NOT_NEWEST');
  if (observations.some((o) => ms(o.observedAt) === ms(snapshot.observedAt) && o.snapshotId !== snapshot.snapshotId)) reasons.push('SNAPSHOT_AMBIGUOUS');
  if (!(ms(snapshot.observedAt) > ms(boundAt) && ms(snapshot.observedAt) > ms(binding.observedAt))) reasons.push('SNAPSHOT_PREDATES_BINDING');
  const positions = snapshot.content.positions ?? [];
  if (snapshotContentProblems(snapshot.snapshotId, snapshot.content).length > 0) reasons.push('SNAPSHOT_INCOMPLETE');
  if (positions.some((p) => p.positionId === positionId)) reasons.push('POSITION_STILL_IN_SNAPSHOT');
  if ((snapshot.content.orders ?? []).some((o) => o.orderId === open.brokerOrderId)) reasons.push('OPEN_ORDER_STILL_AT_BROKER');

  // R3 continuity: an earlier consistent snapshot, taken after the order was submitted, showed the position with the intent's
  // instrument and direction as opened by exactly the open's order. Without it, nothing shows that the portfolio reads were of the
  // account that holds the order.
  const submittedAt = open.events.find((e) => e.state === 'SUBMITTING')?.at ?? null;
  const continuity = submittedAt === null ? undefined : observations.find((o) =>
    compareObservations(o, snapshot) < 0 && ms(o.observedAt) >= ms(submittedAt) && snapshotContentProblems(o.snapshotId, o.content).length === 0 &&
    (o.content.positions ?? []).some((p) => p.positionId === positionId && p.etoroInstrumentId === open.etoroInstrumentId && p.direction === open.side && p.openOrder !== null && p.openOrder.orderId === open.brokerOrderId));
  if (continuity === undefined) reasons.push('ACCOUNT_CONTINUITY_NOT_SHOWN');

  if (reasons.length > 0 || continuity === undefined) return { reasons, evidence: null };
  return {
    reasons: [],
    evidence: { positionId, etoroInstrumentId: open.etoroInstrumentId, direction: open.side, brokerOrderId: open.brokerOrderId, bindingConfirmationId: binding.confirmationId, boundAt, snapshot, continuity },
  };
}

/**
 * R1: whether an attestation takes effect. It has none while a NEXUS close of its position (of its open, or naming the position)
 * may have been sent or was filled: the close then decides. Decided at read time from the caught-up intent log, so the order in
 * which an attestation and a close reservation were recorded does not matter. Pure.
 */
export function externalClosureEffective(record: Pick<ExternalClosureRecord, 'openIntentId' | 'positionId'>, closes: readonly { readonly closesIntentId: string | null; readonly positionId: number | null; readonly state: IntentState }[]): boolean {
  return !closes.some((c) => (c.closesIntentId === record.openIntentId || c.positionId === record.positionId) && CLOSE_POSSIBLY_SENT_STATES.has(c.state));
}

/**
 * O22 Plan B: an open must not be allowed while the newest stored snapshot shows a position that an attestation declared closed
 * outside NEXUS (the attestation would then be contradicted), or while that cannot be checked. Only applies once an attestation
 * exists. Pure.
 */
export function externalClosureOpenRefusals(attestedPositionIds: readonly number[], read: { snapshot: ClosePositionSnapshot | null; problem: ClosePositionEvidenceProblem | null } | null, now: string, maxAgeMs: number): string[] {
  if (attestedPositionIds.length === 0) return [];
  const snapshot = read?.snapshot ?? null;
  if (read === null || read.problem !== null || snapshot === null) return ['EXTERNAL_CLOSURE_NOT_VERIFIABLE'];
  const age = ms(now) - ms(snapshot.observedAt);
  if (snapshot.freshness !== 'fresh' || !(age >= 0 && age <= maxAgeMs) || snapshot.positions.length !== snapshot.positionCount) return ['EXTERNAL_CLOSURE_NOT_VERIFIABLE'];
  return snapshot.positions.some((p) => attestedPositionIds.includes(p.positionId)) ? ['EXTERNALLY_CLOSED_POSITION_SHOWN_AT_BROKER'] : [];
}
