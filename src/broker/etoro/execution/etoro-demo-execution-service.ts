// The eToro demo execution service (O21). It is the only way to the EToroDemoExecutionAdapter, and it turns an ExecutionIntent
// into at most one broker write:
//
//   create   -> CREATED, then the risk gate -> RISK_APPROVED or REJECTED          (no broker request)
//   approve  -> APPROVED, by a named human only                                   (no broker request)
//   execute  -> the risk gate again with fresh input; then SUBMITTING is persisted (with the request id) BEFORE the one write;
//               the answer decides SUBMITTED, REJECTED or AMBIGUOUS
//   refresh  -> reads the broker status (a read, retried): ACCEPTED, FILLED, PARTIALLY_FILLED, REJECTED, CANCELLED; an AMBIGUOUS
//               intent is reconciled by its referenceId and is never resent
//   cancel   -> one cancel write for a pending order of an accepted open intent
//
// Every step is appended to four append-only logs. A state is entered at most once per intent (record id intentId:STATE), and the
// SUBMITTING append runs with a precondition inside the log's critical section, so two processes cannot both submit one intent.
// Nothing here writes to the ledger, books anything, or maps an instrument. No key, header or raw broker response is stored.

import { randomUUID } from 'node:crypto';
import { BUILD_LOCKS } from '../../../nexus/safety.js';
import { Decimal } from '../../../money/decimal.js';
import { AppendOnlyLogError, type AppendOnlyLog } from '../../../persistence/append-only-log.js';
import { hashOf } from '../../../persistence/canonical-json.js';
import type { InstrumentRegistry } from '../../../market-data/instrument-registry.js';
import type { PortfolioKillSwitchStore } from '../../../safety/portfolio-kill-switch-store.js';
import type { PortfolioSafetyDecision } from '../../../safety/portfolio-safety-envelope.js';
import { DemoExecutionError, type DemoExecutionErrorCode } from './etoro-demo-execution-errors.js';
import type { EToroDemoExecutionAdapter, ReadOutcome, WriteOutcome } from './etoro-demo-execution-adapter.js';
import { CANCELLABLE_STATUS_IDS, ETORO_ORDER_STATUS, type BrokerOrderOutcome, type BrokerOrderStatus } from './etoro-demo-execution-validation.js';
import {
  DEFAULT_DEMO_EXECUTION_POLICY,
  ETORO_MAPPING_PROVIDER,
  evaluateDemoExecutionGate,
  type DemoExecutionPolicy,
  type GateBook,
  type GateQuote,
  type GateVerdict,
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

/** An AMBIGUOUS submission is only concluded "not received" when the broker has no order for its referenceId this long after it. */
export const AMBIGUITY_NOT_FOUND_MIN_AGE_MS = 2 * 60_000;
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
}

export interface ReconciliationRecord {
  readonly schema: 'etoro-demo-execution-reconciliation:v1';
  readonly reconciliationId: string;
  readonly intentId: string;
  /** The referenceId searched: the x-request-id of the ambiguous submission. */
  readonly referenceId: string;
  readonly result: 'found' | 'not_found_decided' | 'not_found_pending';
  readonly brokerOrderId: number | null;
  readonly statusId: number | null;
  readonly at: string;
}

export interface DemoSafetySource {
  /** The current portfolio safety decision from a trusted, verified source, or null when none is connected. */
  current(now: string): Promise<PortfolioSafetyDecision | null>;
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
  executionEnabled: boolean;
  clock: () => Date;
  policy?: DemoExecutionPolicy;
  /** The build lock. The runtime always passes BUILD_LOCKS.etoroDemoExecution; there is no configuration for it. */
  buildLocked?: boolean;
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
  gateReasons: readonly string[];
  history: { state: IntentState; at: string; reason: string }[];
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
  gateReasons: readonly string[];
}

const TERMINAL: ReadonlySet<IntentState> = new Set(['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED']);
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

function statusName(statusId: number | null): string | null {
  if (statusId === null) return null;
  return (ETORO_ORDER_STATUS as Record<number, string>)[statusId] ?? null;
}

export class EtoroDemoExecutionService {
  private readonly policy: DemoExecutionPolicy;
  private readonly buildLocked: boolean;
  private readonly nextRequestId: () => string;

  constructor(private readonly deps: DemoExecutionServiceDeps) {
    this.policy = deps.policy ?? DEFAULT_DEMO_EXECUTION_POLICY;
    this.buildLocked = deps.buildLocked ?? BUILD_LOCKS.etoroDemoExecution;
    this.nextRequestId = deps.requestId ?? randomUUID;
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
        buildLocked: this.buildLocked,
        approval: 'manual' as const,
        autonomous: false as const,
        policyVersion: this.policy.version,
      },
    };
  }

  // ------------------------------------------------------------------------------------------------------------- create

  /** Validates the input, stores CREATED, and runs the risk gate. Idempotent: the same input returns the existing intent. */
  async create(input: unknown): Promise<IntentView> {
    await this.syncAll();
    const parsed = parseExecutionIntent(input);
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
  async execute(intentId: string): Promise<IntentView> {
    if (!this.deps.executionEnabled) throw new DemoExecutionError('EXECUTION_DISABLED');
    if (this.buildLocked) throw new DemoExecutionError('EXECUTION_LOCKED_IN_BUILD');
    await this.syncAll();
    const p = this.require(intentId);
    if (p.state !== 'APPROVED') throw new DemoExecutionError('INTENT_STATE_INVALID', p.state);
    if (this.expired(p.intent)) {
      await this.transition(intentId, 'EXPIRED', 'INTENT_EXPIRED');
      throw new DemoExecutionError('INTENT_STATE_INVALID', 'EXPIRED');
    }

    const { verdict } = await this.runGate(p.intent, 'execute');
    const nowMs = this.deps.clock().getTime();
    if (!verdict.passed || !this.deps.adapter.pacer.tryAcquire(nowMs)) {
      const reasons = verdict.passed ? ['BROKER_WRITE_PACING'] : verdict.reasons;
      const at = this.now();
      const refusalId = 'eatt_' + hashOf({ intentId, gate: at, reasons }).slice(0, 40);
      await this.deps.attempts.append(refusalId + ':refused', {
        schema: 'etoro-demo-execution-attempt:v1', attemptId: refusalId, intentId, operation: 'gate', phase: 'refused', requestId: null, at, outcome: 'gate_refused', reasons,
      });
      throw new DemoExecutionError('GATE_REFUSED', reasons.join(','), reasons);
    }

    const requestId = this.nextRequestId().toLowerCase();
    const operation = p.intent.action === 'open' ? 'demo.order.open' : 'demo.position.close';
    const attemptId = 'eatt_' + hashOf({ intentId, operation, requestId }).slice(0, 40);
    // The at-most-once guard: SUBMITTING is entered once, and only from APPROVED as seen inside the critical section.
    const submitting = await guarded(() => this.deps.intents.append(intentId + ':SUBMITTING', {
      schema: 'etoro-demo-intent-event:v1', intentId, state: 'SUBMITTING', from: 'APPROVED', at: this.now(), reason: 'SUBMISSION_STARTED', requestId, attemptId,
    }, {
      precondition: () => {
        const current = this.projections().get(intentId);
        if (!current || current.state !== 'APPROVED') throw new DemoExecutionError('INTENT_STATE_INVALID', current?.state ?? 'missing');
      },
    }));
    if (submitting.status !== 'APPLIED') throw new DemoExecutionError('INTENT_STATE_INVALID', 'SUBMITTING');
    await this.deps.attempts.append(attemptId + ':started', { schema: 'etoro-demo-execution-attempt:v1', attemptId, intentId, operation, phase: 'started', requestId, at: this.now() });

    let outcome: WriteOutcome<{ brokerOrderId?: number; closeOrderId?: number; statusId?: number }>;
    try {
      outcome = p.intent.action === 'open'
        ? await this.deps.adapter.submitOpen(p.intent, requestId)
        : await this.deps.adapter.submitClose(p.intent, requestId);
    } catch (error) {
      // A local refusal before the wire: the request was not sent.
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
    if (p.state === 'AMBIGUOUS') return this.reconcileAmbiguous(p);
    if (p.state !== 'SUBMITTED' && p.state !== 'ACCEPTED' && p.state !== 'PARTIALLY_FILLED' && p.state !== 'RECONCILED') {
      throw new DemoExecutionError('INTENT_STATE_INVALID', p.state);
    }
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
    const at = this.now();
    const read: ReadOutcome = await this.deps.adapter.lookupOrder({ referenceId });
    if (read.kind === 'not_found') {
      const age = Date.parse(at) - Date.parse(p.submittingAt ?? at);
      const decided = age >= AMBIGUITY_NOT_FOUND_MIN_AGE_MS;
      const reconciliationId = await this.reconcile(p.intent.intentId, { referenceId, result: decided ? 'not_found_decided' : 'not_found_pending', brokerOrderId: null, statusId: null, at });
      if (!decided) throw new DemoExecutionError('RECONCILIATION_PENDING', 'no order for the referenceId yet');
      await this.transition(p.intent.intentId, 'RECONCILED', 'BROKER_HAS_NO_ORDER_FOR_REFERENCE', { reconciliationId });
      await this.transition(p.intent.intentId, 'REJECTED', 'NOT_RECEIVED_BY_BROKER', { reconciliationId });
      return this.get(p.intent.intentId);
    }
    const status = read.status;
    if (status.instrumentId !== p.intent.etoroInstrumentId) throw new DemoExecutionError('BROKER_RESPONSE_INVALID', 'instrument does not match the intent');
    const reconciliationId = await this.reconcile(p.intent.intentId, { referenceId, result: 'found', brokerOrderId: status.brokerOrderId, statusId: status.statusId, at });
    await this.transition(p.intent.intentId, 'RECONCILED', 'BROKER_ORDER_FOUND_BY_REFERENCE', { reconciliationId });
    await this.applyStatus(this.require(p.intent.intentId), status, 'order_status');
    return this.get(p.intent.intentId);
  }

  private async applyStatus(p: Projection, status: BrokerOrderStatus, kind: 'order_status' | 'close_order_status'): Promise<void> {
    if (p.brokerOrderId !== null && status.brokerOrderId !== p.brokerOrderId) throw new DemoExecutionError('BROKER_RESPONSE_INVALID', 'order id does not match the intent');
    if (status.instrumentId !== p.intent.etoroInstrumentId) throw new DemoExecutionError('BROKER_RESPONSE_INVALID', 'instrument does not match the intent');
    const confirmationId = await this.confirm(p.intent.intentId, {
      kind,
      requestId: null,
      brokerOrderId: status.brokerOrderId,
      brokerPositionIds: [...status.positionIds],
      statusId: status.statusId,
      outcome: status.outcome,
      errorCode: status.errorCode,
    });
    const target = OUTCOME_STATE[status.outcome];
    if (target === p.state) return;
    // A partial fill that becomes final stays PARTIALLY_FILLED; only an allowed transition is taken.
    if (p.state === 'PARTIALLY_FILLED' && target !== 'FILLED') return;
    assertTransition(p.state, target);
    await this.transition(p.intent.intentId, target, 'BROKER_STATUS_' + (statusName(status.statusId) ?? String(status.statusId)).toUpperCase(), { confirmationId });
  }

  // ------------------------------------------------------------------------------------------------------------- cancel

  /** One cancel write for a pending order of an accepted open intent. The cancellation is confirmed by a later refresh. */
  async cancel(intentId: string): Promise<IntentView> {
    if (!this.deps.executionEnabled) throw new DemoExecutionError('EXECUTION_DISABLED');
    if (this.buildLocked) throw new DemoExecutionError('EXECUTION_LOCKED_IN_BUILD');
    await this.syncAll();
    const p = this.require(intentId);
    if (p.intent.action !== 'open' || p.state !== 'ACCEPTED' || p.brokerOrderId === null) throw new DemoExecutionError('INTENT_STATE_INVALID', p.state);
    if (p.lastStatusId === null || !CANCELLABLE_STATUS_IDS.has(p.lastStatusId)) throw new DemoExecutionError('INTENT_STATE_INVALID', 'the order is not pending');
    if (!this.deps.adapter.pacer.tryAcquire(this.deps.clock().getTime())) throw new DemoExecutionError('GATE_REFUSED', 'BROKER_WRITE_PACING', ['BROKER_WRITE_PACING']);
    const requestId = this.nextRequestId().toLowerCase();
    const attemptId = 'eatt_' + hashOf({ intentId, operation: 'demo.order.cancel' }).slice(0, 40);
    // One cancel per intent: the started record id is fixed, so a second cancel is refused before it is sent.
    const started = await guarded(() => this.deps.attempts.append(attemptId + ':started', { schema: 'etoro-demo-execution-attempt:v1', attemptId, intentId, operation: 'demo.order.cancel', phase: 'started', requestId, at: this.now() }));
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

  // -------------------------------------------------------------------------------------------------------- internals

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
    await Promise.all([this.deps.intents.sync(), this.deps.attempts.sync(), this.deps.confirmations.sync(), this.deps.reconciliations.sync()]);
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
          brokerOrderId: null, positionIds: [], lastStatusId: null, gateReasons: [],
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
      gateReasons: p.gateReasons,
      history: p.events.map((e) => ({ state: e.state, at: e.at, reason: e.reason })),
    };
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

  private async confirm(intentId: string, c: Omit<ConfirmationRecord, 'schema' | 'confirmationId' | 'intentId' | 'observedAt' | 'statusName'>): Promise<string> {
    const observedAt = this.now();
    const content = { ...c, intentId, statusName: statusName(c.statusId), observedAt };
    const confirmationId = 'econf_' + hashOf(content).slice(0, 40);
    await this.deps.confirmations.append(confirmationId, { schema: 'etoro-demo-broker-confirmation:v1', confirmationId, ...content });
    return confirmationId;
  }

  private async reconcile(intentId: string, r: Omit<ReconciliationRecord, 'schema' | 'reconciliationId' | 'intentId'>): Promise<string> {
    const reconciliationId = 'erec_' + hashOf({ intentId, ...r }).slice(0, 40);
    await this.deps.reconciliations.append(reconciliationId, { schema: 'etoro-demo-execution-reconciliation:v1', reconciliationId, intentId, ...r });
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
    const liveOpens = all.filter((p) => p.intent.action === 'open' && LIVE_AT_BROKER_STATES.has(p.state) && !(p.positionIds.length > 0 && p.positionIds.every((id) => closedPositions.has(id))));
    let gross = Decimal.from(0);
    for (const p of liveOpens) gross = gross.plus(p.exposureUsd);
    let closeTargetKnown = false;
    let closeTargetAlreadyClosing = false;
    if (intent.action === 'close' && intent.positionId !== null) {
      const target = all.find((p) => p.intent.intentId === intent.closesIntentId);
      closeTargetKnown =
        target !== undefined && target.intent.action === 'open' && (target.state === 'FILLED' || target.state === 'PARTIALLY_FILLED') &&
        this.brokerConfirmedPositions(target.intent.intentId).includes(intent.positionId) && target.intent.instrumentId === intent.instrumentId && target.intent.etoroInstrumentId === intent.etoroInstrumentId &&
        target.intent.side === intent.side && !closedPositions.has(intent.positionId);
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
    };
  }

  private async runGate(intent: ExecutionIntent, phase: 'create' | 'execute'): Promise<{ verdict: GateVerdict; exposure: Decimal }> {
    const now = this.now();
    await this.deps.killSwitch.sync();
    const [safety, quote] = await Promise.all([this.deps.safety.current(now), this.deps.quotes.latest(intent.instrumentId, now)]);
    const instrument = this.deps.registry.get(intent.instrumentId) ?? null;
    const mapping = instrument === null ? null : this.deps.registry.mappingAt(intent.instrumentId, ETORO_MAPPING_PROVIDER, now);
    const verdict = evaluateDemoExecutionGate({
      phase,
      intent,
      now,
      policy: this.policy,
      buildLocked: this.buildLocked,
      executionEnabled: this.deps.executionEnabled,
      killSwitch: this.deps.killSwitch.current(),
      safety,
      instrument,
      mapping,
      quote,
      book: this.book(intent),
      broker: this.deps.brokerStatus(),
      writeSlotAvailable: this.deps.adapter.pacer.available(Date.parse(now)),
    });
    let exposure = Decimal.from(0);
    if (intent.action === 'open' && quote !== null && quote.last.isPositive()) {
      const investment = intent.amount !== null ? Decimal.from(intent.amount) : Decimal.from(intent.units ?? '0').times(quote.last);
      exposure = investment.times(intent.leverage);
    }
    return { verdict, exposure };
  }
}

export type { DemoExecutionErrorCode };
