// The eToro demo execution service (O21). It is the only way to the EToroDemoExecutionAdapter, and it turns an ExecutionIntent
// into at most one broker write:
//
//   create   -> CREATED, then the risk gate -> RISK_APPROVED or REJECTED          (no broker request)
//   approve  -> APPROVED, by a named human only                                   (no broker request)
//   execute  -> the risk gate again with fresh input; then SUBMITTING is persisted (with the request id) BEFORE the one write;
//               the answer decides SUBMITTED, REJECTED or AMBIGUOUS
//   refresh  -> reads the broker status (a read, retried): ACCEPTED, FILLED, PARTIALLY_FILLED, REJECTED, CANCELLED; an AMBIGUOUS
//               intent is reconciled by its referenceId and is never resent; only positive broker evidence resolves it
//   cancel   -> one cancel write for a pending order of an accepted open intent
//   attestExternalClosure -> O22 Plan B: the operator's attestation that a FILLED open's position was closed outside NEXUS, on
//               complete stored evidence only (external-closure.ts). A separate log; no broker request, no state change.
//
// Every step is appended to four append-only logs. A state is entered at most once per intent (record id intentId:STATE). The
// SUBMITTING append is the reservation step: its precondition runs inside the intent log's storage-backed critical section, after
// catching up with every other process, and re-checks both the state and the book limits. So neither one intent twice nor two
// intents against the same old book can be submitted, in one process or in several.
// Nothing here writes to the ledger, books anything, or maps an instrument. No key, header or raw broker response is stored.

import { randomUUID } from 'node:crypto';
import { BUILD_LOCKS } from '../../../nexus/safety.js';
import { Decimal } from '../../../money/decimal.js';
import { AppendOnlyLogError, type AppendOnlyLog } from '../../../persistence/append-only-log.js';
import { hashOf } from '../../../persistence/canonical-json.js';
import type { InstrumentRegistry } from '../../../market-data/instrument-registry.js';
import type { PortfolioKillSwitchStore } from '../../../safety/portfolio-kill-switch-store.js';
import { DemoExecutionError, type DemoExecutionErrorCode } from './etoro-demo-execution-errors.js';
import type { EToroDemoExecutionAdapter, PreparedWrite, ReadOutcome, WriteOutcome } from './etoro-demo-execution-adapter.js';
import { CANCELLABLE_STATUS_IDS, ETORO_ORDER_STATUS, type BrokerOrderOutcome, type BrokerOrderStatus } from './etoro-demo-execution-validation.js';
import {
  DEFAULT_DEMO_EXECUTION_POLICY,
  ETORO_MAPPING_PROVIDER,
  bookRefusals,
  evaluateDemoExecutionGate,
  type DemoExecutionPolicy,
  type GateBook,
  type GateQuote,
  type GateSafetyDecision,
  type GateVerdict,
  closePositionRefusals,
  type ClosePositionEvidence,
  type ClosePositionEvidenceProblem,
  type ClosePositionSnapshot,
} from './execution-gate.js';
import {
  BROKER_CONFIRMED_STATES,
  LIVE_AT_BROKER_STATES,
  assertTransition,
  bindClosePosition,
  economicFingerprint,
  isIntentId,
  parseExecutionIntent,
  type ExecutionIntent,
  type IntentActor,
  type IntentState,
} from './execution-intent.js';
import type { EtoroSnapshotHistory } from '../etoro-broker-service.js';
import {
  EXTERNAL_CLOSURE_SCHEMA,
  ExternalClosureClaimError,
  externalClosureId,
  externalClosureOpenRefusals,
  externalClosureRefusals,
  parseExternalClosureClaim,
  type ExternalClosureClaim,
  type ExternalClosureFacts,
  type ExternalClosureRecord,
} from './external-closure.js';

/** A SUBMITTING intent without a recorded answer this long after the write (a crash) is AMBIGUOUS. */
export const SUBMITTING_STALE_AFTER_MS = 30_000;

export interface IntentEvent {
  readonly schema: 'etoro-demo-intent-event:v1';
  readonly intentId: string;
  readonly state: IntentState;
  readonly from: IntentState | null;
  readonly at: string;
  /** A fixed reason code of this code base. */
  readonly reason: string;
  readonly intent?: ExecutionIntent;
  readonly gate?: GateVerdict;
  /** Exposure (investment times leverage, USD) estimated at risk approval; counted against the policy limit. */
  readonly exposureUsd?: string;
  readonly approvedBy?: IntentActor;
  readonly requestId?: string;
  readonly attemptId?: string;
  readonly confirmationId?: string;
  readonly reconciliationId?: string;
}

export interface AttemptRecord {
  readonly schema: 'etoro-demo-execution-attempt:v1';
  readonly attemptId: string;
  readonly intentId: string;
  readonly operation: 'demo.order.open' | 'demo.position.close' | 'demo.order.cancel' | 'gate';
  readonly phase: 'started' | 'finished' | 'refused';
  /** The x-request-id of the broker request; null for a gate refusal, which sends nothing. */
  readonly requestId: string | null;
  readonly at: string;
  readonly outcome?: 'accepted' | 'rejected' | 'ambiguous' | 'not_sent' | 'gate_refused';
  /**
   * Who triggered the write: the validated human operator. Always present on a started execute or cancel attempt; absent only on a
   * gate refusal, which sends nothing.
   */
  readonly by?: IntentActor;
  readonly httpStatus?: number | null;
  readonly code?: string;
  readonly reasons?: readonly string[];
}

export interface ConfirmationRecord {
  readonly schema: 'etoro-demo-broker-confirmation:v1';
  readonly confirmationId: string;
  readonly intentId: string;
  readonly kind: 'open_accepted' | 'close_submitted' | 'cancel_accepted' | 'order_status' | 'close_order_status';
  readonly requestId: string | null;
  readonly brokerOrderId: number | null;
  readonly brokerPositionIds: readonly number[];
  readonly statusId: number | null;
  readonly statusName: string | null;
  readonly outcome: BrokerOrderOutcome | null;
  readonly errorCode: number | null;
  readonly observedAt: string;
  /** O22: the product type an order status read states (asset.settlementType), when it states one. */
  readonly settlementType?: BrokerOrderStatus['settlementType'];
  /**
   * O22 recovery: the intent state this status read was fully checked against, and the state it leads to from there (null: none).
   * Every status read stores both. Only such a read can carry a transition, and only from exactly that state; after a crash
   * between the confirmation and its transition, the transition is rolled forward from this record without a broker request.
   */
  readonly appliesFrom?: IntentState;
  readonly target?: IntentState | null;
}

export interface ReconciliationRecord {
  readonly schema: 'etoro-demo-execution-reconciliation:v1';
  readonly reconciliationId: string;
  readonly intentId: string;
  /** The referenceId searched: the x-request-id of the ambiguous submission. */
  readonly referenceId: string;
  /** not_found is never a conclusion: the intent stays AMBIGUOUS. */
  readonly result: 'found' | 'not_found';
  readonly brokerOrderId: number | null;
  readonly statusId: number | null;
  readonly at: string;
  /**
   * O22 recovery: true on a "found" record whose whole answer was checked before it was written (order, instrument, action,
   * direction, positions, transitions). Only such a record lets a restarted process roll AMBIGUOUS forward to RECONCILED.
   */
  readonly checked?: true;
}

/**
 * O22 D4: the newest STORED broker portfolio snapshot (no broker request). Every call reads the store anew, including what other
 * processes stored since the last call (R1); `problem` says why the store names no usable snapshot although it holds observations.
 */
export interface DemoPositionSource {
  latest(): Promise<{ readonly snapshot: ClosePositionSnapshot | null; readonly problem: ClosePositionEvidenceProblem | null }>;
}

export interface DemoSafetySource {
  /** The current portfolio safety decision from a trusted, verified source, or null when none is connected. */
  current(now: string): Promise<GateSafetyDecision | null>;
}

export interface DemoQuoteSource {
  latest(instrumentId: string, now: string): Promise<GateQuote | null>;
}

export interface DemoExecutionServiceDeps {
  adapter: EToroDemoExecutionAdapter;
  intents: AppendOnlyLog<IntentEvent>;
  attempts: AppendOnlyLog<AttemptRecord>;
  confirmations: AppendOnlyLog<ConfirmationRecord>;
  reconciliations: AppendOnlyLog<ReconciliationRecord>;
  registry: InstrumentRegistry;
  killSwitch: PortfolioKillSwitchStore;
  safety: DemoSafetySource;
  quotes: DemoQuoteSource;
  /** The O20 read-only broker status: connection and last successful sync. */
  brokerStatus: () => { connection: string; lastSuccessfulSync: string | null };
  /**
   * O22 D4: the latest STORED broker portfolio snapshot (no broker request). A close is checked against it; without it every close
   * is refused (fail-closed).
   */
  positions?: DemoPositionSource;
  /** O22 Plan B: the operator attestations of positions closed outside NEXUS. Absent: none can be recorded and none exists. */
  externalClosures?: AppendOnlyLog<ExternalClosureRecord>;
  /** O22 Plan B: the stored history of successful read-only syncs, read with every process's records (no broker request). */
  snapshotHistory?: { history(): Promise<EtoroSnapshotHistory> };
  executionEnabled: boolean;
  clock: () => Date;
  policy?: DemoExecutionPolicy;
  requestId?: () => string;
}

export interface IntentView {
  intentId: string;
  state: IntentState;
  intent: ExecutionIntent;
  approvedBy: IntentActor | null;
  brokerOrderId: number | null;
  brokerPositionIds: number[];
  lastStatusId: number | null;
  lastStatusName: string | null;
  /** O22: the product type the broker stated in an order status read (cfd, real, ...), or null. */
  brokerSettlementType: string | null;
  /**
   * O22 F6: every broker status read of this intent, in log order, each as the broker stated it (no merging). The test verdict takes
   * its product type and position binding from the one read that confirmed the fill, not from the merged fields above.
   */
  statusReads: readonly IntentStatusRead[];
  gateReasons: readonly string[];
  /** confirmationId: the stored broker confirmation a broker-confirmed state rests on (present only for those states). */
  history: { state: IntentState; at: string; reason: string; confirmationId?: string }[];
  /**
   * O22 Plan B: the operator's attestation that this open's position was closed outside NEXUS, or null. It ends the position's
   * liveness for NEXUS only; the intent stays in its state and no close, fill or booking is implied.
   */
  externalClosure: ExternalClosureView | null;
}

export interface ExternalClosureView {
  readonly closureId: string;
  readonly positionId: number;
  readonly snapshotId: string;
  readonly snapshotObservedAt: string;
  readonly attestedBy: IntentActor;
  readonly attestedAt: string;
}

/** O22 F6: one order status read of an intent, exactly as recorded. */
export interface IntentStatusRead {
  readonly confirmationId: string;
  readonly kind: 'order_status' | 'close_order_status';
  readonly outcome: BrokerOrderOutcome | null;
  readonly settlementType: string | null;
  readonly brokerPositionIds: readonly number[];
  readonly observedAt: string;
}

interface Projection {
  intent: ExecutionIntent;
  state: IntentState;
  events: IntentEvent[];
  exposureUsd: Decimal;
  approvedBy: IntentActor | null;
  submitRequestId: string | null;
  submittingAt: string | null;
  brokerOrderId: number | null;
  positionIds: number[];
  lastStatusId: number | null;
  settlementType: string | null;
  gateReasons: readonly string[];
}

const TERMINAL: ReadonlySet<IntentState> = new Set(['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED']);
/** States in which refresh reads the broker status (and in which a stored status read can be rolled forward). */
const REFRESHABLE: ReadonlySet<IntentState> = new Set(['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'RECONCILED']);
const STATUS_KINDS: ReadonlySet<ConfirmationRecord['kind']> = new Set(['order_status', 'close_order_status']);
const FILL_OUTCOMES: ReadonlySet<BrokerOrderOutcome> = new Set(['filled', 'partially_filled', 'partially_filled_final']);
const FINAL_OUTCOMES: ReadonlySet<BrokerOrderOutcome> = new Set(['filled', 'partially_filled_final', 'rejected', 'cancelled']);
const OUTCOME_STATE: Readonly<Record<BrokerOrderOutcome, IntentState>> = Object.freeze({
  pending: 'ACCEPTED',
  filled: 'FILLED',
  partially_filled: 'PARTIALLY_FILLED',
  partially_filled_final: 'PARTIALLY_FILLED',
  rejected: 'REJECTED',
  cancelled: 'CANCELLED',
});

/** A second write of a fixed record id (another process got there first) is a state refusal, never a second broker request. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppendOnlyLogError && error.code === 'idempotency_conflict') throw new DemoExecutionError('INTENT_STATE_INVALID', 'already recorded');
    throw error;
  }
}

/**
 * Positive broker evidence for an AMBIGUOUS open (found by its referenceId): instrument, action open and transaction all match.
 * A close never matches: close reconciliation by referenceId is not verified (see reconcileAmbiguous).
 */
function evidenceMatches(intent: ExecutionIntent, status: BrokerOrderStatus): boolean {
  if (intent.action !== 'open' || status.instrumentId !== intent.etoroInstrumentId) return false;
  return status.action === 'open' && status.transaction === (intent.side === 'buy' ? 'buy' : 'sellShort');
}

/** A refused broker answer with its fixed, privacy-safe reason code (no value of the answer). */
function responseInvalid(reason: string, detail: string): DemoExecutionError {
  return new DemoExecutionError('BROKER_RESPONSE_INVALID', detail, [reason]);
}

function statusName(statusId: number | null): string | null {
  if (statusId === null) return null;
  return (ETORO_ORDER_STATUS as Record<number, string>)[statusId] ?? null;
}

export class EtoroDemoExecutionService {
  private readonly policy: DemoExecutionPolicy;
  private readonly nextRequestId: () => string;

  constructor(private readonly deps: DemoExecutionServiceDeps) {
    this.policy = deps.policy ?? DEFAULT_DEMO_EXECUTION_POLICY;
    this.nextRequestId = deps.requestId ?? randomUUID;
  }

  /** The compile-time build lock, read directly each time. There is no constructor option, configuration or setter for it. */
  private get locked(): boolean {
    return BUILD_LOCKS.etoroDemoExecution;
  }

  private now(): string {
    return this.deps.clock().toISOString();
  }

  // ------------------------------------------------------------------------------------------------------------------- reads

  async get(intentId: string): Promise<IntentView> {
    await this.syncAll();
    return this.view(this.require(intentId));
  }

  async list(): Promise<IntentView[]> {
    await this.syncAll();
    return [...this.projections().values()].map((p) => this.view(p));
  }

  /** The configuration state, for the status route. No broker request. */
  status() {
    return {
      etoroDemoExecution: {
        environment: 'demo' as const,
        enabled: this.deps.executionEnabled,
        buildLocked: this.locked,
        approval: 'manual' as const,
        autonomous: false as const,
        policyVersion: this.policy.version,
      },
    };
  }

  // ------------------------------------------------------------------------------------------------------------- create

  /**
   * Validates the input, stores CREATED, and runs the risk gate. Idempotent: the same input returns the existing intent. The creator
   * is a separate argument from trusted code (the runtime passes the authenticated operator); the input cannot name it.
   */
  async create(input: unknown, createdBy: IntentActor): Promise<IntentView> {
    await this.syncAll();
    const parsed = parseExecutionIntent(input, createdBy);
    const intent = parsed.action === 'close' ? bindClosePosition(parsed, this.closePositionOf(parsed)) : parsed;
    const existing = this.projections().get(intent.intentId);
    if (existing) return this.view(existing);
    const now = this.now();
    if (Date.parse(intent.createdAt) > Date.parse(now)) throw new DemoExecutionError('INTENT_INVALID', 'createdAt is in the future');
    if (this.activeDuplicate(intent, null)) throw new DemoExecutionError('INTENT_DUPLICATE');

    await this.appendEvent({ schema: 'etoro-demo-intent-event:v1', intentId: intent.intentId, state: 'CREATED', from: null, at: now, reason: 'INTENT_CREATED', intent });
    const { verdict, exposure } = await this.runGate(intent, 'create');
    if (verdict.passed) {
      await this.transition(intent.intentId, 'RISK_APPROVED', 'RISK_GATE_PASSED', { gate: verdict, exposureUsd: exposure.toString() });
    } else {
      await this.transition(intent.intentId, 'REJECTED', 'RISK_GATE_REFUSED', { gate: verdict });
    }
    return this.get(intent.intentId);
  }

  // ------------------------------------------------------------------------------------------------------------ approve

  /** Manual approval by a named human. A strategy or a model cannot approve. */
  async approve(intentId: string, approver: unknown): Promise<IntentView> {
    const by = this.parseApprover(approver);
    await this.syncAll();
    const p = this.require(intentId);
    if (p.state === 'APPROVED' && p.approvedBy?.id === by.id) return this.view(p);
    if (p.state !== 'RISK_APPROVED') throw new DemoExecutionError('INTENT_STATE_INVALID', p.state);
    if (this.expired(p.intent)) {
      await this.transition(intentId, 'EXPIRED', 'INTENT_EXPIRED');
      throw new DemoExecutionError('INTENT_STATE_INVALID', 'EXPIRED');
    }
    await this.transition(intentId, 'APPROVED', 'MANUAL_APPROVAL', { approvedBy: by });
    return this.get(intentId);
  }

  /** Withdraws an intent that was never submitted. Nothing is sent. */
  async withdraw(intentId: string): Promise<IntentView> {
    await this.syncAll();
    const p = this.require(intentId);
    if (p.state !== 'CREATED' && p.state !== 'RISK_APPROVED' && p.state !== 'APPROVED') throw new DemoExecutionError('INTENT_STATE_INVALID', p.state);
    await this.transition(intentId, 'CANCELLED', 'WITHDRAWN_BEFORE_SUBMISSION');
    return this.get(intentId);
  }

  // ------------------------------------------------------------------------------------------------------------ execute

  /**
   * The one broker write of an approved intent. The gate runs again with fresh input; a refusal sends nothing and leaves the
   * intent APPROVED. SUBMITTING is persisted with the request id before the write, so a second execute, here or in another
   * process, is refused. The answer decides SUBMITTED, REJECTED or AMBIGUOUS. There is no retry.
   */
  async execute(intentId: string, by: IntentActor): Promise<IntentView> {
    // The write boundary does not trust its caller: a validated human operator is required here, before anything else.
    const operator = this.requireHumanOperator(by);
    if (!this.deps.executionEnabled) throw new DemoExecutionError('EXECUTION_DISABLED');
    if (this.locked) throw new DemoExecutionError('EXECUTION_LOCKED_IN_BUILD');
    await this.syncAll();
    const p = this.require(intentId);
    if (p.state !== 'APPROVED') throw new DemoExecutionError('INTENT_STATE_INVALID', p.state);
    if (this.expired(p.intent)) {
      await this.transition(intentId, 'EXPIRED', 'INTENT_EXPIRED');
      throw new DemoExecutionError('INTENT_STATE_INVALID', 'EXPIRED');
    }

    const { verdict, exposure } = await this.runGate(p.intent, 'execute');
    if (!verdict.passed) {
      await this.recordGateRefusal(intentId, verdict.reasons);
      throw new DemoExecutionError('GATE_REFUSED', verdict.reasons.join(','), verdict.reasons);
    }

    // O22 C3: the request is built and checked (body, URL, request id, the transport's own checks) BEFORE the reservation. A request
    // that could never be sent is refused like a gate refusal: nothing is sent, the intent stays APPROVED, and no budget is spent.
    const requestId = this.nextRequestId().toLowerCase();
    let prepared: PreparedWrite<{ brokerOrderId?: number; closeOrderId?: number; statusId?: number }>;
    try {
      prepared = p.intent.action === 'open' ? this.deps.adapter.prepareOpen(p.intent, requestId) : this.deps.adapter.prepareClose(p.intent, requestId);
    } catch (error) {
      if (!(error instanceof DemoExecutionError)) throw error;
      await this.recordGateRefusal(intentId, ['REQUEST_NOT_SENDABLE']);
      throw new DemoExecutionError('GATE_REFUSED', 'REQUEST_NOT_SENDABLE', ['REQUEST_NOT_SENDABLE']);
    }
    if (!this.deps.adapter.pacer.tryAcquire(this.deps.clock().getTime())) {
      await this.recordGateRefusal(intentId, ['BROKER_WRITE_PACING']);
      throw new DemoExecutionError('GATE_REFUSED', 'BROKER_WRITE_PACING', ['BROKER_WRITE_PACING']);
    }

    const operation = p.intent.action === 'open' ? 'demo.order.open' : 'demo.position.close';
    const attemptId = 'eatt_' + hashOf({ intentId, operation, requestId }).slice(0, 40);
    // O22 D4 (R2): the close's broker evidence is read again right before the reservation, from the store and with everything other
    // processes stored since the gate: a newer snapshot without the position refuses here. It is read before the intent-log lock is
    // taken, never inside it: the precondition below runs synchronously in that lock and takes no other lock, so no lock order
    // between logs (and no deadlock) can arise. A snapshot stored after this read is not seen (see O22_CLOSE_POSITION_EVIDENCE.md).
    const reservationEvidence = p.intent.action === 'close' ? await this.closeEvidence(p.intent) : null;
    // O22 Plan B: likewise for an open once an attestation exists: the newest stored snapshot must not show an attested position.
    await this.deps.externalClosures?.sync();
    const reservationExternal = await this.externalClosureInput(p.intent);
    // The reservation step and the at-most-once guard. SUBMITTING is entered once, only from APPROVED, and only if the book limits
    // still hold for the book as it is inside the critical section, after every other process's records were applied.
    let submitting;
    try {
      submitting = await guarded(() => this.deps.intents.append(intentId + ':SUBMITTING', {
        schema: 'etoro-demo-intent-event:v1', intentId, state: 'SUBMITTING', from: 'APPROVED', at: this.now(), reason: 'SUBMISSION_STARTED', requestId, attemptId,
      }, {
        precondition: () => {
          const current = this.projections().get(intentId);
          if (!current || current.state !== 'APPROVED') throw new DemoExecutionError('INTENT_STATE_INVALID', current?.state ?? 'missing');
          const refusals = bookRefusals(p.intent, this.book(p.intent), p.intent.action === 'open' ? exposure : null, this.policy);
          // O22 D4 (R2): the re-read evidence, judged at this moment (age), with the binding from the caught-up intent log.
          if (reservationEvidence !== null) refusals.push(...closePositionRefusals(p.intent, { ...reservationEvidence, ...this.bindingOf(p.intent) }, this.now(), this.policy));
          if (reservationExternal !== undefined) refusals.push(...externalClosureOpenRefusals(reservationExternal.attestedPositionIds, reservationExternal.read, this.now(), this.policy.maxBrokerSyncAgeMs));
          if (refusals.length > 0) throw new DemoExecutionError('GATE_REFUSED', refusals.join(','), refusals);
        },
      }));
    } catch (error) {
      if (error instanceof DemoExecutionError && error.code === 'GATE_REFUSED') await this.recordGateRefusal(intentId, error.reasons);
      throw error;
    }
    if (submitting.status !== 'APPLIED') throw new DemoExecutionError('INTENT_STATE_INVALID', 'SUBMITTING');
    await this.deps.attempts.append(attemptId + ':started', { schema: 'etoro-demo-execution-attempt:v1', attemptId, intentId, operation, phase: 'started', requestId, at: this.now(), by: operator });

    let outcome: WriteOutcome<{ brokerOrderId?: number; closeOrderId?: number; statusId?: number }>;
    try {
      // From SUBMITTING on the budget is spent, whatever happens: the prepared request is sent once and never repeated.
      outcome = await this.deps.adapter.submit(prepared);
    } catch (error) {
      // A local refusal before the wire: the request was not sent. (The request was checked before the reservation, so this is not
      // expected; it still spends the budget, because SUBMITTING is recorded.)
      await this.finishAttempt(attemptId, intentId, operation, requestId, { outcome: 'not_sent', httpStatus: null, code: error instanceof DemoExecutionError ? error.code : 'LOCAL_ERROR' });
      await this.transition(intentId, 'REJECTED', 'NOT_SENT_LOCAL_REFUSAL', { attemptId });
      throw error;
    }

    if (outcome.kind === 'accepted') {
      await this.finishAttempt(attemptId, intentId, operation, requestId, { outcome: 'accepted', httpStatus: outcome.httpStatus });
      const r = outcome.result;
      const confirmation = await this.confirm(intentId, {
        kind: p.intent.action === 'open' ? 'open_accepted' : 'close_submitted',
        requestId,
        brokerOrderId: r.brokerOrderId ?? r.closeOrderId ?? null,
        brokerPositionIds: p.intent.positionId !== null ? [p.intent.positionId] : [],
        statusId: r.statusId ?? null,
        outcome: null,
        errorCode: null,
      });
      await this.transition(intentId, 'SUBMITTED', 'BROKER_ACCEPTED_FOR_PROCESSING', { attemptId, confirmationId: confirmation });
    } else if (outcome.kind === 'rejected') {
      await this.finishAttempt(attemptId, intentId, operation, requestId, { outcome: 'rejected', httpStatus: outcome.httpStatus, code: outcome.code });
      await this.transition(intentId, 'REJECTED', outcome.code, { attemptId });
    } else {
      await this.finishAttempt(attemptId, intentId, operation, requestId, { outcome: 'ambiguous', httpStatus: outcome.httpStatus, code: outcome.reason });
      await this.transition(intentId, 'AMBIGUOUS', 'OUTCOME_UNKNOWN_' + outcome.reason.toUpperCase(), { attemptId });
    }
    return this.get(intentId);
  }

  // ------------------------------------------------------------------------------------------------------------ refresh

  /**
   * Reads the broker state of a submitted intent and records it. An AMBIGUOUS intent is reconciled by the referenceId of its
   * submission; it is never resent. A SUBMITTING intent without an answer (a crash) becomes AMBIGUOUS first.
   */
  async refresh(intentId: string): Promise<IntentView> {
    await this.syncAll();
    let p = this.require(intentId);
    if (p.state === 'SUBMITTING') {
      const age = Date.parse(this.now()) - Date.parse(p.submittingAt ?? this.now());
      if (age < SUBMITTING_STALE_AFTER_MS) throw new DemoExecutionError('RECONCILIATION_PENDING', 'submission in progress');
      await this.transition(intentId, 'AMBIGUOUS', 'SUBMISSION_ANSWER_NOT_RECORDED');
      p = this.require(intentId);
    }
    // O22: a status check that a crash or another process interrupted is completed from the stored evidence first (no broker
    // request). When that reaches a final state, there is nothing left to read.
    const before = p.state;
    p = await this.rollForward(p);
    if (p.state !== before && TERMINAL.has(p.state)) return this.view(p);
    if (p.state === 'AMBIGUOUS') return this.reconcileAmbiguous(p);
    if (!REFRESHABLE.has(p.state)) throw new DemoExecutionError('INTENT_STATE_INVALID', p.state);
    if (p.brokerOrderId === null) throw new DemoExecutionError('INTENT_STATE_INVALID', 'no broker order id');
    const read = p.intent.action === 'open'
      ? await this.deps.adapter.lookupOrder({ orderId: p.brokerOrderId })
      : await this.deps.adapter.closeOrderInfo(p.brokerOrderId);
    if (read.kind === 'not_found') throw new DemoExecutionError('RECONCILIATION_PENDING', 'order not yet visible');
    await this.applyStatus(p, read.status, p.intent.action === 'open' ? 'order_status' : 'close_order_status');
    return this.get(intentId);
  }

  private async reconcileAmbiguous(p: Projection): Promise<IntentView> {
    const referenceId = p.submitRequestId;
    if (referenceId === null) throw new DemoExecutionError('INTENT_STATE_INVALID', 'no request id');
    // An AMBIGUOUS close is not reconciled at all in O21: it is not verified that orders:lookup by referenceId finds close orders,
    // so neither a negative nor a positive answer of it may decide a close. It stays AMBIGUOUS; no broker request is made.
    if (p.intent.action === 'close') throw new DemoExecutionError('RECONCILIATION_PENDING', 'close reconciliation is not verified: the close stays AMBIGUOUS');
    const at = this.now();
    const read: ReadOutcome = await this.deps.adapter.lookupOrder({ referenceId });
    if (read.kind === 'not_found') {
      // A negative lookup does not prove that the write never reached the broker, however long ago it was (and for a close it is
      // not verified that this lookup finds close orders at all). It is recorded and decides nothing: the intent stays AMBIGUOUS.
      await this.reconcile(p.intent.intentId, { referenceId, result: 'not_found', brokerOrderId: null, statusId: null, at });
      throw new DemoExecutionError('RECONCILIATION_PENDING', 'no order found for the referenceId: the intent stays AMBIGUOUS');
    }
    const status = read.status;
    // Only positive evidence that unambiguously belongs to this intent resolves it.
    if (!evidenceMatches(p.intent, status)) throw responseInvalid('ORDER_DOES_NOT_MATCH_INTENT', 'the order found does not match the intent');
    // O22: the whole answer is validated before the first record: the step to RECONCILED, and the status it then applies from
    // RECONCILED (order id, instrument, action, direction, positions, transition). A refused answer leaves no "found"
    // reconciliation, no confirmation and no state change: the intent stays AMBIGUOUS.
    assertTransition(p.state, 'RECONCILED');
    this.planStatus({ ...p, brokerOrderId: status.brokerOrderId }, status, 'order_status', 'RECONCILED');
    // The "found" record is written under the reconciliation log's lock: one order per intent, whichever process writes first.
    const intentId = p.intent.intentId;
    const reconciliationId = await this.reconcile(intentId, { referenceId, result: 'found', brokerOrderId: status.brokerOrderId, statusId: status.statusId, at, checked: true }, () => {
      const found = this.foundReconciliations(intentId);
      if (found.some((r) => r.brokerOrderId !== status.brokerOrderId)) throw responseInvalid('RECONCILIATION_CONFLICT', 'another order was found for this intent');
      if (found.some((r) => r.checked === true)) throw new DemoExecutionError('RECONCILIATION_PENDING', 'the order was already found: refresh again to complete it');
    });
    await this.transition(intentId, 'RECONCILED', 'BROKER_ORDER_FOUND_BY_REFERENCE', { reconciliationId });
    await this.applyStatus(this.require(intentId), status, 'order_status');
    return this.get(intentId);
  }

  /**
   * O22: completes, from the stored evidence alone, a status check that a crash or another process interrupted. No broker request.
   *   - AMBIGUOUS with a checked "found" reconciliation: the step to RECONCILED (the order id then comes from that record).
   *   - A status read stored against the current state whose transition was not recorded: that transition.
   * Every step is an ordinary transition (fixed record id per state, precondition on the current state under the log's lock), so
   * a repeated or concurrent recovery records each step once. Contradicting "found" records stop it (RECONCILIATION_CONFLICT).
   */
  private async rollForward(start: Projection): Promise<Projection> {
    let p = start;
    const intentId = p.intent.intentId;
    for (let step = 0; step < 4; step++) {
      let next: { to: IntentState; reason: string; extra: Partial<IntentEvent> } | null = null;
      if (p.state === 'AMBIGUOUS') {
        const found = this.foundReconciliations(intentId);
        if (new Set(found.map((r) => r.brokerOrderId)).size > 1) throw responseInvalid('RECONCILIATION_CONFLICT', 'contradicting orders were found for this intent');
        const checked = found.find((r) => r.checked === true);
        if (checked !== undefined) next = { to: 'RECONCILED', reason: 'BROKER_ORDER_FOUND_BY_REFERENCE', extra: { reconciliationId: checked.reconciliationId } };
      } else if (REFRESHABLE.has(p.state)) {
        const state = p.state;
        const pending = this.deps.confirmations.all().map((r) => r.payload)
          .filter((c) => c.intentId === intentId && STATUS_KINDS.has(c.kind) && c.appliesFrom === state && c.target !== undefined && c.target !== null)
          .at(-1);
        if (pending !== undefined && pending.target) {
          next = { to: pending.target, reason: 'BROKER_STATUS_' + (statusName(pending.statusId) ?? String(pending.statusId)).toUpperCase(), extra: { confirmationId: pending.confirmationId } };
        }
      }
      if (next === null) return p;
      try {
        await this.transition(intentId, next.to, next.reason, next.extra);
      } catch (error) {
        // Another process recorded a step first: continue from what is stored now.
        if (!(error instanceof DemoExecutionError && error.code === 'INTENT_STATE_INVALID')) throw error;
        await this.syncAll();
      }
      p = this.require(intentId);
    }
    return p;
  }

  /** Recovery without any broker request: completes an interrupted status check from the stored evidence (see rollForward). */
  async recover(intentId: string): Promise<IntentView> {
    await this.syncAll();
    return this.view(await this.rollForward(this.require(intentId)));
  }

  private foundReconciliations(intentId: string): ReconciliationRecord[] {
    return this.deps.reconciliations.all().map((r) => r.payload).filter((r) => r.intentId === intentId && r.result === 'found');
  }

  /**
   * O22: a new status read must agree with every status read stored for the intent (of the same kind): the same order, the same
   * position once one is confirmed, never back from a fill to an unfilled outcome, and never another outcome once a final one is
   * stored. Runs as a pre-check and again as the precondition of the confirmation, under the confirmation log's lock after
   * catching up with every process, so a stale check of another process can never store a contradicting confirmation.
   */
  private assertConsistentWithStoredReads(intentId: string, kind: 'order_status' | 'close_order_status', read: { brokerOrderId: number; outcome: BrokerOrderOutcome; positionIds: readonly number[] }): void {
    for (const record of this.deps.confirmations.all()) {
      const c = record.payload;
      if (c.intentId !== intentId) continue;
      if (c.brokerOrderId !== null && c.brokerOrderId !== read.brokerOrderId && (c.kind === kind || c.kind === (kind === 'order_status' ? 'open_accepted' : 'close_submitted'))) {
        throw responseInvalid('ORDER_ID_CONTRADICTS_EARLIER_READ', 'the order differs from an earlier record');
      }
      if (c.kind !== kind || c.outcome === null) continue;
      if (kind === 'order_status' && read.positionIds.some((id) => c.brokerPositionIds.some((earlier) => earlier !== id))) {
        throw responseInvalid('POSITION_CONTRADICTS_EARLIER_READ', 'the position differs from an earlier read');
      }
      if (FILL_OUTCOMES.has(c.outcome) && !FILL_OUTCOMES.has(read.outcome)) throw responseInvalid('STATUS_CONTRADICTS_EARLIER_READ', 'an earlier read stated a fill');
      if (FINAL_OUTCOMES.has(c.outcome) && read.outcome !== c.outcome) throw responseInvalid('STATUS_CONTRADICTS_EARLIER_READ', 'an earlier read stated another final outcome');
    }
  }

  /**
   * O22: every check of a status read, without any write. It returns the state the read leads to from `from`, or null when it
   * changes no state. It throws when the answer does not belong to the intent or the transition is not allowed, so a caller that
   * runs it before its first record never leaves a partial record (a confirmation without its transition, a reconciliation
   * without its status).
   */
  private planStatus(p: Projection, status: BrokerOrderStatus, kind: 'order_status' | 'close_order_status', from: IntentState): IntentState | null {
    if (p.brokerOrderId !== null && status.brokerOrderId !== p.brokerOrderId) throw responseInvalid('ORDER_ID_MISMATCH', 'order id does not match the intent');
    if (status.instrumentId !== p.intent.etoroInstrumentId) throw responseInvalid('INSTRUMENT_MISMATCH', 'instrument does not match the intent');
    if (kind === 'order_status') this.assertOpenStatusBelongs(p, status);
    this.assertConsistentWithStoredReads(p.intent.intentId, kind, status);
    const target = OUTCOME_STATE[status.outcome];
    if (target === from) return null;
    // A partial fill that becomes final stays PARTIALLY_FILLED; only an allowed transition is taken.
    if (from === 'PARTIALLY_FILLED' && target !== 'FILLED') return null;
    assertTransition(from, target);
    return target;
  }

  private async applyStatus(p: Projection, status: BrokerOrderStatus, kind: 'order_status' | 'close_order_status'): Promise<void> {
    // Every check (and the transition) runs before anything is recorded: a refused answer leaves no confirmation and changes no state.
    const target = this.planStatus(p, status, kind, p.state);
    const intentId = p.intent.intentId;
    const confirmationId = await this.confirm(intentId, {
      kind,
      requestId: null,
      brokerOrderId: status.brokerOrderId,
      brokerPositionIds: [...status.positionIds],
      statusId: status.statusId,
      outcome: status.outcome,
      errorCode: status.errorCode,
      ...(status.settlementType !== null ? { settlementType: status.settlementType } : {}),
      appliesFrom: p.state,
      target,
    }, () => this.assertConsistentWithStoredReads(intentId, kind, status));
    if (target === null) return;
    await this.transition(p.intent.intentId, target, 'BROKER_STATUS_' + (statusName(status.statusId) ?? String(status.statusId)).toUpperCase(), { confirmationId });
  }

  /**
   * O22: an order status read of an open must state the open and the intent's direction (buy -> "buy", sell -> "sellShort"); a
   * missing value is not a match. Its positions must be unambiguous: a fill (also a partial one) names exactly one position; a
   * pending or rejected order names none; no read names more than one; and every read names the same position as the earlier
   * reads of this intent. Anything else is refused and the intent keeps its state, so the position stays unresolved for NEXUS
   * and no close of it can be prepared (closePositionOf needs exactly one confirmed position).
   */
  private assertOpenStatusBelongs(p: Projection, status: BrokerOrderStatus): void {
    if (status.action !== 'open') throw responseInvalid('ACTION_MISMATCH', 'action is missing or not open');
    if (status.transaction !== (p.intent.side === 'buy' ? 'buy' : 'sellShort')) throw responseInvalid('TRANSACTION_MISMATCH', 'transaction is missing or does not match the side');
    const ids = status.positionIds;
    if (ids.length > 1) throw responseInvalid('POSITION_NOT_UNIQUE', 'the order status names more than one position');
    const fill = status.outcome === 'filled' || status.outcome === 'partially_filled' || status.outcome === 'partially_filled_final';
    if (fill && ids.length !== 1) throw responseInvalid('FILL_WITHOUT_POSITION', 'a fill names no position');
    if ((status.outcome === 'pending' || status.outcome === 'rejected') && ids.length !== 0) throw responseInvalid('POSITION_WITHOUT_FILL', 'an unfilled order names a position');
    const earlier = this.brokerConfirmedPositions(p.intent.intentId);
    if (ids.length === 1 && earlier.some((id) => id !== ids[0])) throw responseInvalid('POSITION_CONTRADICTS_EARLIER_READ', 'the position differs from an earlier read');
  }

  // ------------------------------------------------------------------------------------------------------------- cancel

  /** One cancel write for a pending order of an accepted open intent. The cancellation is confirmed by a later refresh. */
  async cancel(intentId: string, by: IntentActor): Promise<IntentView> {
    const operator = this.requireHumanOperator(by);
    if (!this.deps.executionEnabled) throw new DemoExecutionError('EXECUTION_DISABLED');
    if (this.locked) throw new DemoExecutionError('EXECUTION_LOCKED_IN_BUILD');
    await this.syncAll();
    const p = this.require(intentId);
    if (p.intent.action !== 'open' || p.state !== 'ACCEPTED' || p.brokerOrderId === null) throw new DemoExecutionError('INTENT_STATE_INVALID', p.state);
    if (p.lastStatusId === null || !CANCELLABLE_STATUS_IDS.has(p.lastStatusId)) throw new DemoExecutionError('INTENT_STATE_INVALID', 'the order is not pending');
    if (!this.deps.adapter.pacer.tryAcquire(this.deps.clock().getTime())) throw new DemoExecutionError('GATE_REFUSED', 'BROKER_WRITE_PACING', ['BROKER_WRITE_PACING']);
    // A new cancel is allowed only when every earlier cancel of this intent was conclusively refused by the broker (it did not act).
    // An accepted, ambiguous or unfinished cancel blocks every further one: a cancel is never resent automatically or blindly.
    const earlier = this.cancelAttempts(intentId);
    if (earlier.some((outcome) => outcome !== 'rejected')) throw new DemoExecutionError('INTENT_STATE_INVALID', 'a cancel was sent and not conclusively refused');
    const requestId = this.nextRequestId().toLowerCase();
    const attemptId = 'eatt_' + hashOf({ intentId, operation: 'demo.order.cancel', n: earlier.length }).slice(0, 40);
    // The started record id is fixed per attempt number, and the precondition re-checks inside the critical section.
    const started = await guarded(() => this.deps.attempts.append(attemptId + ':started', { schema: 'etoro-demo-execution-attempt:v1', attemptId, intentId, operation: 'demo.order.cancel', phase: 'started', requestId, at: this.now(), by: operator }, {
      precondition: () => {
        const current = this.cancelAttempts(intentId);
        if (current.length !== earlier.length || current.some((outcome) => outcome !== 'rejected')) throw new DemoExecutionError('INTENT_STATE_INVALID', 'a cancel is in progress');
      },
    }));
    if (started.status !== 'APPLIED') throw new DemoExecutionError('INTENT_STATE_INVALID', 'cancel already sent');
    const outcome = await this.deps.adapter.cancelOrder(p.brokerOrderId, requestId);
    if (outcome.kind === 'accepted') {
      await this.finishAttempt(attemptId, intentId, 'demo.order.cancel', requestId, { outcome: 'accepted', httpStatus: outcome.httpStatus });
      await this.confirm(intentId, { kind: 'cancel_accepted', requestId, brokerOrderId: p.brokerOrderId, brokerPositionIds: [], statusId: null, outcome: null, errorCode: null });
    } else if (outcome.kind === 'rejected') {
      await this.finishAttempt(attemptId, intentId, 'demo.order.cancel', requestId, { outcome: 'rejected', httpStatus: outcome.httpStatus, code: outcome.code });
      throw new DemoExecutionError(outcome.code);
    } else {
      // The order stays what the broker says it is; a refresh decides. A cancel is never resent.
      await this.finishAttempt(attemptId, intentId, 'demo.order.cancel', requestId, { outcome: 'ambiguous', httpStatus: outcome.httpStatus, code: outcome.reason });
    }
    return this.get(intentId);
  }

  // ------------------------------------------------------------------------------------------------- external closure

  /**
   * O22 Plan B: records an authenticated human operator's attestation that the position of a FILLED open was closed outside NEXUS.
   * Only on complete stored evidence (externalClosureRefusals): a checked status read bound the order to exactly one position, the
   * newest stored complete snapshot, observed after that, no longer shows it, and no NEXUS close of it is filled or unresolved.
   * Anything missing or contradicting refuses (EXTERNAL_CLOSURE_REFUSED) and records nothing. No broker request; the intent keeps its
   * state; no confirmation, booking or budget change. One attestation per position: the record id is fixed, and the rule runs again
   * inside the attestation log's lock after catching up with every process.
   */
  async attestExternalClosure(openIntentId: string, claimInput: unknown, by: IntentActor): Promise<ExternalClosureRecord> {
    const operator = this.requireHumanOperator(by);
    let claim: ExternalClosureClaim;
    try {
      claim = parseExternalClosureClaim(claimInput);
    } catch (error) {
      if (error instanceof ExternalClosureClaimError) throw new DemoExecutionError('EXTERNAL_CLOSURE_REFUSED', 'claim', ['CLAIM_INVALID']);
      throw error;
    }
    const log = this.deps.externalClosures;
    const source = this.deps.snapshotHistory;
    if (log === undefined || source === undefined) throw new DemoExecutionError('EXTERNAL_CLOSURE_NOT_AVAILABLE');
    if (!isIntentId(openIntentId)) throw new DemoExecutionError('INTENT_NOT_FOUND');
    // The snapshot history first (it catches up with the sync and snapshot logs), the execution logs after it: every intent state
    // read is at least as recent as the newest snapshot the rule judges.
    const history = await source.history();
    await this.syncAll();
    const planned = externalClosureRefusals(claim, this.externalClosureFacts(openIntentId, history));
    if (planned.evidence === null) throw new DemoExecutionError('EXTERNAL_CLOSURE_REFUSED', planned.reasons.join(','), planned.reasons);
    const e = planned.evidence;
    const record: ExternalClosureRecord = {
      schema: EXTERNAL_CLOSURE_SCHEMA,
      closureId: externalClosureId(openIntentId, e.positionId),
      openIntentId,
      positionId: e.positionId,
      etoroInstrumentId: e.etoroInstrumentId,
      direction: e.direction,
      brokerOrderId: e.brokerOrderId,
      bindingConfirmationId: e.bindingConfirmationId,
      boundAt: e.boundAt,
      snapshotId: e.snapshot.snapshotId,
      snapshotObservedAt: e.snapshot.observedAt,
      snapshotSyncSequence: e.snapshot.sequence,
      snapshotPositionCount: e.snapshot.content.positionCount,
      evidenceHeads: {
        intents: { size: this.deps.intents.size, headHash: this.deps.intents.headHash },
        confirmations: { size: this.deps.confirmations.size, headHash: this.deps.confirmations.headHash },
        observations: history.observations.length,
      },
      statement: claim.statement,
      attestedBy: operator,
      attestedAt: this.now(),
      effect: 'liveness_ended',
    };
    try {
      const result = await log.append(record.closureId, record, {
        // Inside the attestation log's lock, after catching up with it: no other attestation of the open, and the same evidence.
        precondition: () => {
          const again = externalClosureRefusals(claim, this.externalClosureFacts(openIntentId, history));
          if (again.evidence === null) throw new DemoExecutionError('EXTERNAL_CLOSURE_REFUSED', again.reasons.join(','), again.reasons);
        },
      });
      if (result.status !== 'APPLIED') throw new DemoExecutionError('EXTERNAL_CLOSURE_REFUSED', 'ALREADY_ATTESTED', ['ALREADY_ATTESTED']);
      return result.record.payload;
    } catch (error) {
      if (error instanceof AppendOnlyLogError && error.code === 'idempotency_conflict') throw new DemoExecutionError('EXTERNAL_CLOSURE_REFUSED', 'ALREADY_ATTESTED', ['ALREADY_ATTESTED']);
      throw error;
    }
  }

  /** The stored facts the external closure rule reads, from this process's caught-up logs. */
  private externalClosureFacts(openIntentId: string, history: EtoroSnapshotHistory): ExternalClosureFacts {
    const projections = this.projections();
    const p = projections.get(openIntentId);
    const bound = p === undefined ? [] : this.brokerConfirmedPositions(openIntentId);
    return {
      open: p === undefined ? null : {
        intentId: openIntentId,
        action: p.intent.action,
        state: p.state,
        etoroInstrumentId: p.intent.etoroInstrumentId,
        side: p.intent.side,
        brokerOrderId: p.brokerOrderId,
        events: p.events.map((e) => ({ state: e.state, at: e.at, ...(e.confirmationId !== undefined ? { confirmationId: e.confirmationId } : {}) })),
      },
      confirmations: this.deps.confirmations.all().map((r) => r.payload).filter((c) => c.intentId === openIntentId),
      closes: [...projections.values()]
        .filter((c) => c.intent.action === 'close' && (c.intent.closesIntentId === openIntentId || (c.intent.positionId !== null && bound.includes(c.intent.positionId))))
        .map((c) => ({ state: c.state })),
      existing: this.externalClosureRecords().filter((r) => r.openIntentId === openIntentId || bound.includes(r.positionId)),
      history,
    };
  }

  private externalClosureRecords(): ExternalClosureRecord[] {
    return this.deps.externalClosures === undefined ? [] : this.deps.externalClosures.all().map((r) => r.payload);
  }

  /** The positions attested as closed outside NEXUS, per open intent. */
  private attestedPositions(): Map<string, Set<number>> {
    const map = new Map<string, Set<number>>();
    for (const r of this.externalClosureRecords()) {
      const set = map.get(r.openIntentId) ?? new Set<number>();
      set.add(r.positionId);
      map.set(r.openIntentId, set);
    }
    return map;
  }

  /** O22 Plan B: what an open is checked against once an attestation exists (the newest stored snapshot; no broker request). */
  private async externalClosureInput(intent: ExecutionIntent): Promise<{ attestedPositionIds: number[]; read: Awaited<ReturnType<DemoPositionSource['latest']>> | null } | undefined> {
    if (intent.action !== 'open') return undefined;
    const attestedPositionIds = this.externalClosureRecords().map((r) => r.positionId);
    if (attestedPositionIds.length === 0) return undefined;
    return { attestedPositionIds, read: this.deps.positions === undefined ? null : await this.deps.positions.latest() };
  }

  // -------------------------------------------------------------------------------------------------------- internals

  /** A broker write needs a human operator with a valid id. Anything else is OPERATOR_INVALID, and nothing is sent. */
  private requireHumanOperator(value: unknown): IntentActor {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DemoExecutionError('OPERATOR_INVALID');
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some((k) => k !== 'kind' && k !== 'id')) throw new DemoExecutionError('OPERATOR_INVALID');
    if (v.kind !== 'human' || typeof v.id !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(v.id)) throw new DemoExecutionError('OPERATOR_INVALID');
    return Object.freeze({ kind: 'human' as const, id: v.id });
  }

  private parseApprover(value: unknown): IntentActor {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DemoExecutionError('APPROVAL_INVALID');
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some((k) => k !== 'kind' && k !== 'id')) throw new DemoExecutionError('APPROVAL_INVALID');
    if (v.kind !== 'human' || typeof v.id !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(v.id)) throw new DemoExecutionError('APPROVAL_INVALID');
    return { kind: 'human', id: v.id };
  }

  /**
   * The position a close refers to, proved by stored state only: the closed intent is an open of NEXUS on the same instrument and
   * side, it is FILLED or PARTIALLY_FILLED, and an order status read from eToro confirmed exactly one position for it. Anything
   * else is refused: a position id is never taken from a request.
   */
  private closePositionOf(close: ExecutionIntent): number {
    const target = close.closesIntentId === null ? undefined : this.projections().get(close.closesIntentId);
    const confirmed = target === undefined ? [] : this.brokerConfirmedPositions(target.intent.intentId);
    if (
      target === undefined ||
      target.intent.action !== 'open' ||
      (target.state !== 'FILLED' && target.state !== 'PARTIALLY_FILLED') ||
      target.intent.instrumentId !== close.instrumentId ||
      target.intent.etoroInstrumentId !== close.etoroInstrumentId ||
      target.intent.side !== close.side ||
      confirmed.length !== 1
    ) {
      throw new DemoExecutionError('INTENT_INVALID', 'the close target is not a known, broker-confirmed position of NEXUS');
    }
    return confirmed[0]!;
  }

  /** Positions an eToro order status read confirmed for an intent. Submission answers carry no position and do not count. */
  private brokerConfirmedPositions(intentId: string): number[] {
    const ids = new Set<number>();
    for (const record of this.deps.confirmations.all()) {
      const c = record.payload;
      if (c.intentId !== intentId || c.kind !== 'order_status') continue;
      if (c.outcome !== 'filled' && c.outcome !== 'partially_filled' && c.outcome !== 'partially_filled_final') continue;
      for (const id of c.brokerPositionIds) ids.add(id);
    }
    return [...ids];
  }

  /** The outcome of every cancel attempt of an intent, in order: accepted, rejected, ambiguous, or unfinished (a crash). */
  private cancelAttempts(intentId: string): string[] {
    const started: string[] = [];
    const finished = new Map<string, string>();
    for (const record of this.deps.attempts.all()) {
      const a = record.payload;
      if (a.intentId !== intentId || a.operation !== 'demo.order.cancel') continue;
      if (a.phase === 'started') started.push(a.attemptId);
      if (a.phase === 'finished' && a.outcome !== undefined) finished.set(a.attemptId, a.outcome);
    }
    return started.map((id) => finished.get(id) ?? 'unfinished');
  }

  private async recordGateRefusal(intentId: string, reasons: readonly string[]): Promise<void> {
    const at = this.now();
    const refusalId = 'eatt_' + hashOf({ intentId, gate: at, reasons }).slice(0, 40);
    await this.deps.attempts.append(refusalId + ':refused', {
      schema: 'etoro-demo-execution-attempt:v1', attemptId: refusalId, intentId, operation: 'gate', phase: 'refused', requestId: null, at, outcome: 'gate_refused', reasons,
    });
  }

  private expired(intent: ExecutionIntent): boolean {
    return Date.parse(this.now()) >= Date.parse(intent.expiresAt);
  }

  private require(intentId: string): Projection {
    if (!isIntentId(intentId)) throw new DemoExecutionError('INTENT_NOT_FOUND');
    const p = this.projections().get(intentId);
    if (!p) throw new DemoExecutionError('INTENT_NOT_FOUND');
    return p;
  }

  private async syncAll(): Promise<void> {
    await Promise.all([
      this.deps.intents.sync(), this.deps.attempts.sync(), this.deps.confirmations.sync(), this.deps.reconciliations.sync(),
      ...(this.deps.externalClosures !== undefined ? [this.deps.externalClosures.sync()] : []),
    ]);
  }

  /** Folds the intent log into one projection per intent. The log is the only source of state. */
  private projections(): Map<string, Projection> {
    const map = new Map<string, Projection>();
    const confirmations = new Map<string, ConfirmationRecord>();
    for (const record of this.deps.confirmations.all()) confirmations.set(record.payload.confirmationId, record.payload);
    for (const record of this.deps.intents.all()) {
      const e = record.payload;
      if (e.state === 'CREATED') {
        if (!e.intent) continue;
        map.set(e.intentId, {
          intent: e.intent, state: 'CREATED', events: [e], exposureUsd: Decimal.from(0), approvedBy: null, submitRequestId: null, submittingAt: null,
          brokerOrderId: null, positionIds: [], lastStatusId: null, settlementType: null, gateReasons: [],
        });
        continue;
      }
      const p = map.get(e.intentId);
      if (!p) continue;
      p.state = e.state;
      p.events.push(e);
      if (e.exposureUsd !== undefined) p.exposureUsd = Decimal.from(e.exposureUsd);
      if (e.approvedBy) p.approvedBy = e.approvedBy;
      if (e.gate) p.gateReasons = e.gate.reasons;
      if (e.state === 'RECONCILED' && e.reconciliationId !== undefined) {
        // O22: the order found by reference is the intent's order, also before (or without) a stored status read of it.
        const found = this.deps.reconciliations.get(e.reconciliationId)?.payload;
        if (found !== undefined && found.result === 'found' && found.brokerOrderId !== null) p.brokerOrderId = found.brokerOrderId;
      }
      if (e.state === 'SUBMITTING') {
        p.submitRequestId = e.requestId ?? null;
        p.submittingAt = e.at;
      }
    }
    for (const c of confirmations.values()) {
      const p = map.get(c.intentId);
      if (!p) continue;
      if (c.brokerOrderId !== null && (c.kind === 'open_accepted' || c.kind === 'close_submitted' || c.kind === 'order_status' || c.kind === 'close_order_status')) {
        p.brokerOrderId = p.brokerOrderId ?? c.brokerOrderId;
      }
      for (const id of c.brokerPositionIds) if (!p.positionIds.includes(id)) p.positionIds.push(id);
      if (c.statusId !== null) p.lastStatusId = c.statusId;
      if (c.settlementType !== undefined && c.settlementType !== null) p.settlementType = c.settlementType;
    }
    return map;
  }

  private view(p: Projection): IntentView {
    return {
      intentId: p.intent.intentId,
      state: p.state,
      intent: p.intent,
      approvedBy: p.approvedBy,
      brokerOrderId: p.brokerOrderId,
      brokerPositionIds: [...p.positionIds],
      lastStatusId: p.lastStatusId,
      lastStatusName: statusName(p.lastStatusId),
      brokerSettlementType: p.settlementType,
      statusReads: this.statusReadsOf(p.intent.intentId),
      gateReasons: p.gateReasons,
      history: p.events.map((e) => ({ state: e.state, at: e.at, reason: e.reason, ...(e.confirmationId !== undefined ? { confirmationId: e.confirmationId } : {}) })),
      externalClosure: this.externalClosureOf(p.intent.intentId),
    };
  }

  private externalClosureOf(intentId: string): ExternalClosureView | null {
    const r = this.externalClosureRecords().find((c) => c.openIntentId === intentId);
    return r === undefined ? null : Object.freeze({ closureId: r.closureId, positionId: r.positionId, snapshotId: r.snapshotId, snapshotObservedAt: r.snapshotObservedAt, attestedBy: r.attestedBy, attestedAt: r.attestedAt });
  }

  /** O22 F6: the order status reads of an intent, in log order, unmerged. */
  private statusReadsOf(intentId: string): IntentStatusRead[] {
    const reads: IntentStatusRead[] = [];
    for (const record of this.deps.confirmations.all()) {
      const c = record.payload;
      if (c.intentId !== intentId || (c.kind !== 'order_status' && c.kind !== 'close_order_status')) continue;
      reads.push(Object.freeze({
        confirmationId: c.confirmationId,
        kind: c.kind,
        outcome: c.outcome,
        settlementType: c.settlementType ?? null,
        brokerPositionIds: Object.freeze([...c.brokerPositionIds]),
        observedAt: c.observedAt,
      }));
    }
    return reads;
  }

  private async appendEvent(event: IntentEvent): Promise<void> {
    const result = await guarded(() => this.deps.intents.append(event.intentId + ':' + event.state, event));
    if (result.status !== 'APPLIED') throw new DemoExecutionError('INTENT_STATE_INVALID', event.state + ' already recorded');
  }

  /** Appends one allowed transition. The check runs inside the log's critical section, on the state other processes left. */
  private async transition(intentId: string, to: IntentState, reason: string, extra: Partial<IntentEvent> = {}): Promise<void> {
    const current = this.projections().get(intentId);
    if (!current) throw new DemoExecutionError('INTENT_NOT_FOUND');
    const from = current.state;
    assertTransition(from, to);
    const event: IntentEvent = { schema: 'etoro-demo-intent-event:v1', intentId, state: to, from, at: this.now(), reason, ...extra };
    if (BROKER_CONFIRMED_STATES.has(to) && !this.confirmationExists(extra.confirmationId)) {
      throw new DemoExecutionError('INTENT_STATE_INVALID', 'a broker-confirmed state needs a stored broker confirmation');
    }
    // O22: a status read carries exactly the transition it was checked for: from its own state, to its own target, of its intent.
    const confirmation = extra.confirmationId === undefined ? undefined : this.deps.confirmations.get(extra.confirmationId)?.payload;
    if (confirmation !== undefined && STATUS_KINDS.has(confirmation.kind) && (confirmation.intentId !== intentId || confirmation.appliesFrom !== from || confirmation.target !== to)) {
      throw new DemoExecutionError('INTENT_STATE_INVALID', 'the status read was not checked for ' + from + ' -> ' + to);
    }
    if (to === 'RECONCILED') {
      const found = extra.reconciliationId === undefined ? undefined : this.deps.reconciliations.get(extra.reconciliationId)?.payload;
      if (found === undefined || found.intentId !== intentId || found.result !== 'found' || found.checked !== true) {
        throw new DemoExecutionError('INTENT_STATE_INVALID', 'RECONCILED needs a checked "found" reconciliation of the intent');
      }
    }
    const result = await guarded(() => this.deps.intents.append(intentId + ':' + to, event, {
      precondition: () => {
        const latest = this.projections().get(intentId);
        if (!latest || latest.state !== from) throw new DemoExecutionError('INTENT_STATE_INVALID', (latest?.state ?? 'missing') + ' -> ' + to);
      },
    }));
    if (result.status !== 'APPLIED') throw new DemoExecutionError('INTENT_STATE_INVALID', to + ' already recorded');
  }

  private confirmationExists(confirmationId: string | undefined): boolean {
    return confirmationId !== undefined && this.deps.confirmations.get(confirmationId) !== undefined;
  }

  private async confirm(intentId: string, c: Omit<ConfirmationRecord, 'schema' | 'confirmationId' | 'intentId' | 'observedAt' | 'statusName'>, precondition?: () => void): Promise<string> {
    const observedAt = this.now();
    const content = { ...c, intentId, statusName: statusName(c.statusId), observedAt };
    const confirmationId = 'econf_' + hashOf(content).slice(0, 40);
    await this.deps.confirmations.append(confirmationId, { schema: 'etoro-demo-broker-confirmation:v1', confirmationId, ...content }, precondition ? { precondition } : {});
    return confirmationId;
  }

  private async reconcile(intentId: string, r: Omit<ReconciliationRecord, 'schema' | 'reconciliationId' | 'intentId'>, precondition?: () => void): Promise<string> {
    const reconciliationId = 'erec_' + hashOf({ intentId, ...r }).slice(0, 40);
    await this.deps.reconciliations.append(reconciliationId, { schema: 'etoro-demo-execution-reconciliation:v1', reconciliationId, intentId, ...r }, precondition ? { precondition } : {});
    return reconciliationId;
  }

  private async finishAttempt(attemptId: string, intentId: string, operation: AttemptRecord['operation'], requestId: string, result: { outcome: NonNullable<AttemptRecord['outcome']>; httpStatus: number | null; code?: string }): Promise<void> {
    await this.deps.attempts.append(attemptId + ':finished', {
      schema: 'etoro-demo-execution-attempt:v1', attemptId, intentId, operation, phase: 'finished', requestId, at: this.now(), outcome: result.outcome, httpStatus: result.httpStatus, ...(result.code !== undefined ? { code: result.code } : {}),
    });
  }

  /** True when another intent with the same economic fingerprint is open (not terminal) or may be live at the broker. */
  private activeDuplicate(intent: ExecutionIntent, self: string | null): boolean {
    const fingerprint = economicFingerprint(intent);
    for (const p of this.projections().values()) {
      if (p.intent.intentId === self || p.intent.intentId === intent.intentId) continue;
      if (economicFingerprint(p.intent) !== fingerprint) continue;
      if (!TERMINAL.has(p.state) || p.state === 'FILLED') return true;
    }
    return false;
  }

  private book(intent: ExecutionIntent): GateBook {
    const all = [...this.projections().values()].filter((p) => p.intent.intentId !== intent.intentId);
    const closedPositions = new Set<number>();
    for (const p of all) if (p.intent.action === 'close' && p.state === 'FILLED' && p.intent.positionId !== null) closedPositions.add(p.intent.positionId);
    // O22 Plan B: a position attested as closed outside NEXUS no longer counts as live (only for the open it was attested for).
    const attested = this.attestedPositions();
    const settled = (p: Projection, id: number) => closedPositions.has(id) || (attested.get(p.intent.intentId)?.has(id) ?? false);
    const liveOpens = all.filter((p) => p.intent.action === 'open' && LIVE_AT_BROKER_STATES.has(p.state) && !(p.positionIds.length > 0 && p.positionIds.every((id) => settled(p, id))));
    let gross = Decimal.from(0);
    for (const p of liveOpens) gross = gross.plus(p.exposureUsd);
    let closeTargetKnown = false;
    let closeTargetAlreadyClosing = false;
    if (intent.action === 'close' && intent.positionId !== null) {
      const target = all.find((p) => p.intent.intentId === intent.closesIntentId);
      closeTargetKnown =
        target !== undefined && target.intent.action === 'open' && (target.state === 'FILLED' || target.state === 'PARTIALLY_FILLED') &&
        this.brokerConfirmedPositions(target.intent.intentId).includes(intent.positionId) && target.intent.instrumentId === intent.instrumentId && target.intent.etoroInstrumentId === intent.etoroInstrumentId &&
        target.intent.side === intent.side && !settled(target, intent.positionId);
      // Any other close of this position that is not finished (or that filled) counts, from CREATED on.
      closeTargetAlreadyClosing = all.some((p) => p.intent.action === 'close' && p.intent.positionId === intent.positionId && (!TERMINAL.has(p.state) || p.state === 'FILLED'));
    }
    return {
      liveIntentCount: liveOpens.length,
      grossExposureUsd: gross,
      instrumentHasLiveIntent: liveOpens.some((p) => p.intent.instrumentId === intent.instrumentId),
      anyAmbiguous: all.some((p) => p.state === 'AMBIGUOUS' || p.state === 'SUBMITTING'),
      activeDuplicate: this.activeDuplicate(intent, intent.intentId),
      closeTargetKnown,
      closeTargetAlreadyClosing,
      // O22 cycle budget: every intent that ever reached SUBMITTING, whatever happened after it (rejected, ambiguous, crashed).
      openSubmissions: all.filter((p) => p.intent.action === 'open' && p.submittingAt !== null).length,
      closeSubmissions: all.filter((p) => p.intent.action === 'close' && p.submittingAt !== null).length,
    };
  }

  /** O22: the cycle budget of the policy and how much of it the intent log has spent. Read only; no broker request. */
  async cycleBudget(): Promise<{ policyVersion: string; maxOpenSubmissions: number | null; maxCloseSubmissions: number | null; openSubmissions: number; closeSubmissions: number }> {
    await this.syncAll();
    const all = [...this.projections().values()];
    return {
      policyVersion: this.policy.version,
      maxOpenSubmissions: this.policy.maxOpenSubmissions,
      maxCloseSubmissions: this.policy.maxCloseSubmissions,
      openSubmissions: all.filter((p) => p.intent.action === 'open' && p.submittingAt !== null).length,
      closeSubmissions: all.filter((p) => p.intent.action === 'close' && p.submittingAt !== null).length,
    };
  }

  private async runGate(intent: ExecutionIntent, phase: 'create' | 'execute'): Promise<{ verdict: GateVerdict; exposure: Decimal }> {
    const now = this.now();
    await this.deps.killSwitch.sync();
    // O22 C2: the account safety decision is read for an open only. No gate check of a close reads it (every safety check applies to
    // opens), so a close does not depend on the account read, its broker request or its valuation log.
    const [safety, quote] = await Promise.all([
      intent.action === 'open' ? this.deps.safety.current(now) : Promise.resolve(null),
      this.deps.quotes.latest(intent.instrumentId, now),
    ]);
    const instrument = this.deps.registry.get(intent.instrumentId) ?? null;
    const mapping = instrument === null ? null : this.deps.registry.mappingAt(intent.instrumentId, ETORO_MAPPING_PROVIDER, now);
    const closeEvidence = intent.action === 'close' ? await this.closeEvidence(intent) : null;
    const externalClosures = await this.externalClosureInput(intent);
    const verdict = evaluateDemoExecutionGate({
      phase,
      intent,
      now,
      policy: this.policy,
      buildLocked: this.locked,
      executionEnabled: this.deps.executionEnabled,
      killSwitch: this.deps.killSwitch.current(),
      safety,
      instrument,
      mapping,
      quote,
      book: this.book(intent),
      broker: this.deps.brokerStatus(),
      writeSlotAvailable: this.deps.adapter.pacer.available(Date.parse(now)),
      closePosition: closeEvidence,
      ...(externalClosures !== undefined ? { externalClosures } : {}),
    });
    let exposure = Decimal.from(0);
    if (intent.action === 'open' && quote !== null && quote.last.isPositive()) {
      const investment = intent.amount !== null ? Decimal.from(intent.amount) : Decimal.from(intent.units ?? '0').times(quote.last);
      exposure = investment.times(intent.leverage);
    }
    return { verdict, exposure };
  }

  /**
   * O22 D4: the evidence a close is checked against: the latest stored broker snapshot (no broker request), when NEXUS bound the
   * position (the open's first FILLED or PARTIALLY_FILLED entry), and the open's broker order id.
   */
  private async closeEvidence(intent: ExecutionIntent): Promise<ClosePositionEvidence> {
    const read = this.deps.positions === undefined ? { snapshot: null, problem: null } : await this.deps.positions.latest();
    return { snapshot: read.snapshot, problem: read.problem, ...this.bindingOf(intent) };
  }

  /** The binding of the position a close closes, from the intent log as this process has it now. */
  private bindingOf(intent: ExecutionIntent): { boundAt: string | null; openOrderId: number | null } {
    const target = intent.closesIntentId === null ? undefined : this.projections().get(intent.closesIntentId);
    const bound = target?.events.find((e) => e.state === 'FILLED' || e.state === 'PARTIALLY_FILLED');
    return { boundAt: bound?.at ?? null, openOrderId: target?.brokerOrderId ?? null };
  }
}

export type { DemoExecutionErrorCode };
