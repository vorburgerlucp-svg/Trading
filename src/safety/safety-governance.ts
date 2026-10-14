import {
  AppendOnlyLog,
  InMemoryAppendOnlyStore,
  type AppendOnlyStore,
} from '../persistence/append-only-log.js';
import { hashOf } from '../persistence/canonical-json.js';
import type {
  KillSwitchState,
  PortfolioSafetyDecision,
  SafetyAlertDescriptor,
} from './portfolio-safety-envelope.js';

export const SAFETY_ALERT_BATCH_VERSION = 'safety-alert-batch:v1' as const;
export const SAFETY_AUDIT_EVENT_VERSION = 'safety-audit-event:v1' as const;
export const RESET_AUTHORIZATION_REQUEST_VERSION = 'reset-authorization-request:v1' as const;
export const RESET_AUTHORIZATION_VERSION = 'reset-authorization:v1' as const;

const HEX64 = /^[0-9a-f]{64}$/;
const TRIP_ID = /^trip_[0-9a-f]{40}$/;
const BATCH_ID = /^sab_[0-9a-f]{40}$/;
const REQUEST_ID = /^rar_[0-9a-f]{40}$/;
const AUTH_ID = /^raa_[0-9a-f]{40}$/;

export class SafetyGovernanceError extends Error {
  override readonly name = 'SafetyGovernanceError';

  constructor(
    readonly code:
      | 'INVALID_ALERT_BATCH'
      | 'INVALID_AUDIT_EVENT'
      | 'INVALID_RESET_REQUEST'
      | 'INVALID_RESET_AUTHORIZATION'
      | 'FOUR_EYES_REQUIRED'
      | 'KILL_SWITCH_NOT_TRIPPED'
      | 'TRIP_MISMATCH',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

function canonicalMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

function requireHumanId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length < 2) {
    throw new SafetyGovernanceError('INVALID_RESET_REQUEST', label + ' is required');
  }
}

function cloneAlerts(alerts: readonly SafetyAlertDescriptor[]): SafetyAlertDescriptor[] {
  return alerts.map((alert) => ({ ...alert }));
}

export interface SafetyAlertBatch {
  readonly version: typeof SAFETY_ALERT_BATCH_VERSION;
  readonly batchId: string;
  readonly decisionId: string;
  readonly decisionInputFingerprint: string;
  readonly asOf: string;
  readonly state: PortfolioSafetyDecision['state'];
  readonly killSwitchStatus: KillSwitchState['status'];
  readonly tripId: string | null;
  readonly alerts: readonly SafetyAlertDescriptor[];
}

export function createSafetyAlertBatch(decision: PortfolioSafetyDecision): SafetyAlertBatch {
  if (
    !decision ||
    typeof decision.decisionId !== 'string' ||
    typeof decision.inputFingerprint !== 'string' ||
    !HEX64.test(decision.inputFingerprint) ||
    canonicalMs(decision.asOf) === null ||
    !Array.isArray(decision.alerts)
  ) {
    throw new SafetyGovernanceError('INVALID_ALERT_BATCH', 'portfolio safety decision is invalid');
  }

  const payload = {
    version: SAFETY_ALERT_BATCH_VERSION,
    decisionId: decision.decisionId,
    decisionInputFingerprint: decision.inputFingerprint,
    asOf: decision.asOf,
    state: decision.state,
    killSwitchStatus: decision.killSwitch.status,
    tripId: decision.killSwitch.tripId,
    alerts: cloneAlerts(decision.alerts),
  };

  return {
    ...payload,
    batchId: 'sab_' + hashOf(payload).slice(0, 40),
  };
}

export interface ResetAuthorizationRequest {
  readonly version: typeof RESET_AUTHORIZATION_REQUEST_VERSION;
  readonly requestId: string;
  readonly tripId: string;
  readonly triggeringDecisionFingerprint: string;
  readonly requestedAt: string;
  readonly requesterId: string;
  readonly recoveryEvidenceHash: string;
  readonly justification: string;
}

export function createResetAuthorizationRequest(
  killSwitch: KillSwitchState,
  input: {
    requestedAt: string;
    requesterId: string;
    recoveryEvidenceHash: string;
    justification: string;
  },
): ResetAuthorizationRequest {
  if (killSwitch.status !== 'TRIPPED') {
    throw new SafetyGovernanceError('KILL_SWITCH_NOT_TRIPPED', 'reset authorization requires a tripped kill switch');
  }
  if (
    typeof killSwitch.tripId !== 'string' ||
    !TRIP_ID.test(killSwitch.tripId) ||
    typeof killSwitch.triggeringDecisionFingerprint !== 'string' ||
    !HEX64.test(killSwitch.triggeringDecisionFingerprint)
  ) {
    throw new SafetyGovernanceError('INVALID_RESET_REQUEST', 'persisted trip identity is invalid');
  }

  const requestedMs = canonicalMs(input.requestedAt);
  if (requestedMs === null) {
    throw new SafetyGovernanceError('INVALID_RESET_REQUEST', 'requestedAt must be canonical UTC');
  }
  requireHumanId(input.requesterId, 'requesterId');
  if (!HEX64.test(input.recoveryEvidenceHash)) {
    throw new SafetyGovernanceError('INVALID_RESET_REQUEST', 'recoveryEvidenceHash must be a lowercase sha256');
  }
  if (typeof input.justification !== 'string' || input.justification.trim().length < 10) {
    throw new SafetyGovernanceError('INVALID_RESET_REQUEST', 'justification must be meaningful');
  }

  const payload = {
    version: RESET_AUTHORIZATION_REQUEST_VERSION,
    tripId: killSwitch.tripId,
    triggeringDecisionFingerprint: killSwitch.triggeringDecisionFingerprint,
    requestedAt: input.requestedAt,
    requesterId: input.requesterId.trim(),
    recoveryEvidenceHash: input.recoveryEvidenceHash,
    justification: input.justification.trim(),
  };

  return {
    ...payload,
    requestId: 'rar_' + hashOf(payload).slice(0, 40),
  };
}

export interface ResetAuthorization {
  readonly version: typeof RESET_AUTHORIZATION_VERSION;
  readonly authorizationId: string;
  readonly requestId: string;
  readonly tripId: string;
  readonly triggeringDecisionFingerprint: string;
  readonly requesterId: string;
  readonly approverId: string;
  readonly approvedAt: string;
  readonly recoveryEvidenceHash: string;
  readonly authorizationOnly: true;
  readonly resetExecuted: false;
  readonly liveTradingUnlocked: false;
}

export function authorizeResetRequest(
  killSwitch: KillSwitchState,
  request: ResetAuthorizationRequest,
  input: { approverId: string; approvedAt: string },
): ResetAuthorization {
  if (killSwitch.status !== 'TRIPPED') {
    throw new SafetyGovernanceError('KILL_SWITCH_NOT_TRIPPED', 'authorization requires a tripped kill switch');
  }
  if (
    request.version !== RESET_AUTHORIZATION_REQUEST_VERSION ||
    !REQUEST_ID.test(request.requestId) ||
    !HEX64.test(request.recoveryEvidenceHash) ||
    canonicalMs(request.requestedAt) === null
  ) {
    throw new SafetyGovernanceError('INVALID_RESET_AUTHORIZATION', 'reset request is invalid');
  }
  if (
    request.tripId !== killSwitch.tripId ||
    request.triggeringDecisionFingerprint !== killSwitch.triggeringDecisionFingerprint
  ) {
    throw new SafetyGovernanceError('TRIP_MISMATCH', 'request does not bind to the current persisted trip');
  }

  requireHumanId(input.approverId, 'approverId');
  if (input.approverId.trim() === request.requesterId) {
    throw new SafetyGovernanceError('FOUR_EYES_REQUIRED', 'requester and approver must be different humans');
  }

  const approvedMs = canonicalMs(input.approvedAt);
  const requestedMs = canonicalMs(request.requestedAt);
  if (approvedMs === null || requestedMs === null || approvedMs < requestedMs) {
    throw new SafetyGovernanceError('INVALID_RESET_AUTHORIZATION', 'approvedAt must be canonical UTC and not predate request');
  }

  const payload = {
    version: RESET_AUTHORIZATION_VERSION,
    requestId: request.requestId,
    tripId: request.tripId,
    triggeringDecisionFingerprint: request.triggeringDecisionFingerprint,
    requesterId: request.requesterId,
    approverId: input.approverId.trim(),
    approvedAt: input.approvedAt,
    recoveryEvidenceHash: request.recoveryEvidenceHash,
    authorizationOnly: true as const,
    resetExecuted: false as const,
    liveTradingUnlocked: false as const,
  };

  return {
    ...payload,
    authorizationId: 'raa_' + hashOf(payload).slice(0, 40),
  };
}

export type SafetyAuditPayload =
  | { kind: 'ALERT_BATCH'; batch: SafetyAlertBatch }
  | { kind: 'RESET_REQUESTED'; request: ResetAuthorizationRequest }
  | { kind: 'RESET_AUTHORIZED'; authorization: ResetAuthorization };

export interface SafetyAuditEvent {
  readonly version: typeof SAFETY_AUDIT_EVENT_VERSION;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly payload: SafetyAuditPayload;
}

function eventIdentity(payload: SafetyAuditPayload): string {
  switch (payload.kind) {
    case 'ALERT_BATCH':
      return payload.batch.batchId;
    case 'RESET_REQUESTED':
      return payload.request.requestId;
    case 'RESET_AUTHORIZED':
      return payload.authorization.authorizationId;
  }
}

function validateAuditEvent(event: SafetyAuditEvent): void {
  if (
    !event ||
    event.version !== SAFETY_AUDIT_EVENT_VERSION ||
    typeof event.eventId !== 'string' ||
    event.eventId.length < 5 ||
    canonicalMs(event.occurredAt) === null ||
    !event.payload
  ) {
    throw new SafetyGovernanceError('INVALID_AUDIT_EVENT', 'audit event is invalid');
  }

  const expectedId = 'sae_' + hashOf({
    version: SAFETY_AUDIT_EVENT_VERSION,
    occurredAt: event.occurredAt,
    kind: event.payload.kind,
    identity: eventIdentity(event.payload),
  }).slice(0, 40);

  if (event.eventId !== expectedId) {
    throw new SafetyGovernanceError('INVALID_AUDIT_EVENT', 'audit event identity does not match content');
  }
}

export function createSafetyAuditEvent(occurredAt: string, payload: SafetyAuditPayload): SafetyAuditEvent {
  if (canonicalMs(occurredAt) === null) {
    throw new SafetyGovernanceError('INVALID_AUDIT_EVENT', 'occurredAt must be canonical UTC');
  }

  const eventId = 'sae_' + hashOf({
    version: SAFETY_AUDIT_EVENT_VERSION,
    occurredAt,
    kind: payload.kind,
    identity: eventIdentity(payload),
  }).slice(0, 40);

  return {
    version: SAFETY_AUDIT_EVENT_VERSION,
    eventId,
    occurredAt,
    payload,
  };
}

/** Append-only audit. It records authorization artifacts but deliberately has no reset execution API. */
export class SafetyAuditStore {
  private constructor(private readonly log: AppendOnlyLog<SafetyAuditEvent>) {}

  static async open(
    store: AppendOnlyStore<SafetyAuditEvent> = new InMemoryAppendOnlyStore<SafetyAuditEvent>(),
  ): Promise<SafetyAuditStore> {
    const instance = new SafetyAuditStore(await AppendOnlyLog.open('safety-governance-audit', store));
    instance.validateHistory();
    return instance;
  }

  async append(event: SafetyAuditEvent): Promise<SafetyAuditEvent> {
    validateAuditEvent(event);
    const result = await this.log.append(event.eventId, event);
    return result.record.payload;
  }

  all(): readonly SafetyAuditEvent[] {
    return this.log.all().map((record) => record.payload);
  }

  sync(): Promise<void> {
    return this.log.sync().then(() => this.validateHistory());
  }

  get headHash(): string {
    return this.log.headHash;
  }

  private validateHistory(): void {
    for (const record of this.log.all()) validateAuditEvent(record.payload);
  }
}

export function validateSafetyGovernanceArtifacts(input: {
  batch?: SafetyAlertBatch;
  request?: ResetAuthorizationRequest;
  authorization?: ResetAuthorization;
}): void {
  if (input.batch && !BATCH_ID.test(input.batch.batchId)) {
    throw new SafetyGovernanceError('INVALID_ALERT_BATCH', 'alert batch id is invalid');
  }
  if (input.request && !REQUEST_ID.test(input.request.requestId)) {
    throw new SafetyGovernanceError('INVALID_RESET_REQUEST', 'reset request id is invalid');
  }
  if (input.authorization && !AUTH_ID.test(input.authorization.authorizationId)) {
    throw new SafetyGovernanceError('INVALID_RESET_AUTHORIZATION', 'authorization id is invalid');
  }
}
