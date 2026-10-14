import { hashOf } from '../persistence/canonical-json.js';
import {
  PORTFOLIO_KILL_SWITCH_VERSION,
  evaluatePortfolioSafetyEnvelope,
  type KillSwitchState,
  type PortfolioSafetyDecision,
  type PortfolioSafetyPolicy,
  type PortfolioSafetyRequest,
} from './portfolio-safety-envelope.js';

export const KILL_SWITCH_RESET_REQUEST_VERSION = 'kill-switch-reset-request:v1' as const;
export const KILL_SWITCH_RESET_APPROVAL_VERSION = 'kill-switch-reset-approval:v1' as const;
export const KILL_SWITCH_RESET_AUTHORIZATION_VERSION = 'kill-switch-reset-authorization:v1' as const;
export const KILL_SWITCH_RESET_POLICY_VERSION = 'kill-switch-reset-policy:v1' as const;

export interface HumanActor {
  kind: 'human';
  id: string;
}

export interface KillSwitchResetPolicy {
  version: typeof KILL_SWITCH_RESET_POLICY_VERSION;
  minimumCooldownMs: number;
  authorizationTtlMs: number;
  requireDistinctApprover: true;
  requireRecoveryState: 'NORMAL';
  minimumRationaleLength: number;
}

export interface KillSwitchResetRequest {
  requestId: string;
  version: typeof KILL_SWITCH_RESET_REQUEST_VERSION;
  requestedAt: string;
  requester: HumanActor;
  tripId: string;
  tripFingerprint: string;
  rationale: string;
  recoveryDecisionId: string;
  recoveryDecisionFingerprint: string;
  policyFingerprint: string;
  requestFingerprint: string;
}

export interface KillSwitchResetApproval {
  approvalId: string;
  version: typeof KILL_SWITCH_RESET_APPROVAL_VERSION;
  requestId: string;
  approvedAt: string;
  approver: HumanActor;
  decision: 'APPROVE' | 'REJECT';
  rationale: string;
  requestFingerprint: string;
  approvalFingerprint: string;
}

export interface KillSwitchResetAuthorization {
  authorizationId: string;
  version: typeof KILL_SWITCH_RESET_AUTHORIZATION_VERSION;
  requestId: string;
  approvalId: string;
  tripId: string;
  authorizedAt: string;
  expiresAt: string;
  requester: HumanActor;
  approver: HumanActor;
  recoveryDecisionId: string;
  recoveryDecisionFingerprint: string;
  authorizationFingerprint: string;
  applyAllowed: false;
  liveOrderAllowed: false;
  physicalPurchaseAllowed: false;
}

export class KillSwitchResetError extends Error {
  override readonly name = 'KillSwitchResetError';
  constructor(
    readonly code:
      | 'INVALID_SOURCE'
      | 'INVALID_POLICY'
      | 'INVALID_REQUEST'
      | 'INVALID_APPROVAL'
      | 'RECOVERY_NOT_NORMAL'
      | 'COOLDOWN_NOT_ELAPSED'
      | 'SELF_APPROVAL'
      | 'RESET_REJECTED'
      | 'INVALID_AUTHORIZATION'
      | 'AUTHORIZATION_EXPIRED',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

const ACTOR_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

function fail(code: KillSwitchResetError['code'], message: string): never {
  throw new KillSwitchResetError(code, message);
}

function canonicalMs(value: unknown, code: KillSwitchResetError['code'], label: string): number {
  if (typeof value !== 'string') fail(code, label + ' must be canonical UTC');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail(code, label + ' must be canonical UTC');
  return ms;
}

function validateActor(actor: HumanActor, code: KillSwitchResetError['code'], label: string): void {
  if (!actor || actor.kind !== 'human' || typeof actor.id !== 'string' || !ACTOR_ID.test(actor.id)) {
    fail(code, label + ' must be an authenticated lowercase human actor id');
  }
}

function validateRationale(value: unknown, minimum: number, code: KillSwitchResetError['code']): void {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < minimum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(code, 'rationale is invalid or too short');
  }
}

function validatePolicy(policy: KillSwitchResetPolicy): void {
  if (
    !policy ||
    policy.version !== KILL_SWITCH_RESET_POLICY_VERSION ||
    !Number.isSafeInteger(policy.minimumCooldownMs) ||
    policy.minimumCooldownMs <= 0 ||
    !Number.isSafeInteger(policy.authorizationTtlMs) ||
    policy.authorizationTtlMs <= 0 ||
    policy.requireDistinctApprover !== true ||
    policy.requireRecoveryState !== 'NORMAL' ||
    !Number.isSafeInteger(policy.minimumRationaleLength) ||
    policy.minimumRationaleLength <= 0
  ) {
    fail('INVALID_POLICY', 'kill-switch reset policy is invalid');
  }
}

function armedState(): KillSwitchState {
  return {
    version: PORTFOLIO_KILL_SWITCH_VERSION,
    status: 'ARMED',
    tripId: null,
    trippedAt: null,
    reasons: [],
    triggeringDecisionFingerprint: null,
  };
}

export function currentTripOf(sourceRequest: PortfolioSafetyRequest): KillSwitchState {
  let validated: PortfolioSafetyDecision;
  try {
    validated = evaluatePortfolioSafetyEnvelope(sourceRequest);
  } catch (error) {
    fail('INVALID_SOURCE', 'source safety request is invalid: ' + (error instanceof Error ? error.message : String(error)));
  }
  const trip = sourceRequest.previousKillSwitch;
  if (
    validated.state !== 'TRIPPED' ||
    trip.status !== 'TRIPPED' ||
    typeof trip.tripId !== 'string' ||
    typeof trip.triggeringDecisionFingerprint !== 'string'
  ) {
    fail('INVALID_SOURCE', 'source request does not contain the current persisted trip');
  }
  return { ...trip, reasons: [...trip.reasons] };
}

export function assessKillSwitchRecovery(
  sourceRequest: PortfolioSafetyRequest,
): PortfolioSafetyDecision {
  currentTripOf(sourceRequest);
  let recovery: PortfolioSafetyDecision;
  try {
    recovery = evaluatePortfolioSafetyEnvelope({
      ...sourceRequest,
      previousKillSwitch: armedState(),
    });
  } catch (error) {
    fail('INVALID_SOURCE', 'recovery source is invalid: ' + (error instanceof Error ? error.message : String(error)));
  }
  return recovery;
}

export function resetPolicyFingerprint(policy: PortfolioSafetyPolicy | KillSwitchResetPolicy): string {
  return hashOf(policy);
}

function requestCore(request: Omit<KillSwitchResetRequest, 'requestId' | 'requestFingerprint'>): unknown {
  return request;
}

function approvalCore(approval: Omit<KillSwitchResetApproval, 'approvalId' | 'approvalFingerprint'>): unknown {
  return approval;
}

function validateRequestArtifact(request: KillSwitchResetRequest): void {
  if (!request || request.version !== KILL_SWITCH_RESET_REQUEST_VERSION) fail('INVALID_REQUEST', 'reset request version is invalid');
  canonicalMs(request.requestedAt, 'INVALID_REQUEST', 'requestedAt');
  validateActor(request.requester, 'INVALID_REQUEST', 'requester');
  if (!/^trip_[0-9a-f]{40}$/.test(request.tripId)) fail('INVALID_REQUEST', 'tripId is invalid');
  if (!/^[0-9a-f]{64}$/.test(request.tripFingerprint)) fail('INVALID_REQUEST', 'trip fingerprint is invalid');
  if (!/^pse_[0-9a-f]{40}$/.test(request.recoveryDecisionId)) fail('INVALID_REQUEST', 'recovery decision id is invalid');
  if (!/^[0-9a-f]{64}$/.test(request.recoveryDecisionFingerprint)) fail('INVALID_REQUEST', 'recovery decision fingerprint is invalid');
  if (!/^[0-9a-f]{64}$/.test(request.policyFingerprint)) fail('INVALID_REQUEST', 'policy fingerprint is invalid');
  if (!/^[0-9a-f]{64}$/.test(request.requestFingerprint) || !/^ksrr_[0-9a-f]{40}$/.test(request.requestId)) {
    fail('INVALID_REQUEST', 'reset request identity is malformed');
  }
  const core = requestCore({
    version: request.version,
    requestedAt: request.requestedAt,
    requester: request.requester,
    tripId: request.tripId,
    tripFingerprint: request.tripFingerprint,
    rationale: request.rationale,
    recoveryDecisionId: request.recoveryDecisionId,
    recoveryDecisionFingerprint: request.recoveryDecisionFingerprint,
    policyFingerprint: request.policyFingerprint,
  });
  const fingerprint = hashOf(core);
  if (request.requestFingerprint !== fingerprint || request.requestId !== 'ksrr_' + fingerprint.slice(0, 40)) {
    fail('INVALID_REQUEST', 'reset request identity does not match its content');
  }
}

function validateApprovalArtifact(approval: KillSwitchResetApproval): void {
  if (!approval || approval.version !== KILL_SWITCH_RESET_APPROVAL_VERSION) fail('INVALID_APPROVAL', 'approval version is invalid');
  canonicalMs(approval.approvedAt, 'INVALID_APPROVAL', 'approvedAt');
  validateActor(approval.approver, 'INVALID_APPROVAL', 'approver');
  if (approval.decision !== 'APPROVE' && approval.decision !== 'REJECT') fail('INVALID_APPROVAL', 'approval decision is invalid');
  if (!/^ksrr_[0-9a-f]{40}$/.test(approval.requestId) || !/^[0-9a-f]{64}$/.test(approval.requestFingerprint)) {
    fail('INVALID_APPROVAL', 'approval request reference is invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(approval.approvalFingerprint) || !/^ksra_[0-9a-f]{40}$/.test(approval.approvalId)) {
    fail('INVALID_APPROVAL', 'approval identity is malformed');
  }
  const core = approvalCore({
    version: approval.version,
    requestId: approval.requestId,
    approvedAt: approval.approvedAt,
    approver: approval.approver,
    decision: approval.decision,
    rationale: approval.rationale,
    requestFingerprint: approval.requestFingerprint,
  });
  const fingerprint = hashOf(core);
  if (approval.approvalFingerprint !== fingerprint || approval.approvalId !== 'ksra_' + fingerprint.slice(0, 40)) {
    fail('INVALID_APPROVAL', 'approval identity does not match its content');
  }
}

export function buildKillSwitchResetRequest(
  sourceRequest: PortfolioSafetyRequest,
  input: {
    requestedAt: string;
    requester: HumanActor;
    rationale: string;
    policy: KillSwitchResetPolicy;
  },
): KillSwitchResetRequest {
  validatePolicy(input.policy);
  const trip = currentTripOf(sourceRequest);
  const requestedMs = canonicalMs(input.requestedAt, 'INVALID_REQUEST', 'requestedAt');
  const tripMs = canonicalMs(trip.trippedAt, 'INVALID_SOURCE', 'trippedAt');
  if (requestedMs < tripMs) fail('INVALID_REQUEST', 'reset request predates the trip');
  if (requestedMs < canonicalMs(sourceRequest.day.asOf, 'INVALID_SOURCE', 'source asOf')) {
    fail('INVALID_REQUEST', 'reset request cannot reference a recovery assessment from the future');
  }
  validateActor(input.requester, 'INVALID_REQUEST', 'requester');
  validateRationale(input.rationale, input.policy.minimumRationaleLength, 'INVALID_REQUEST');

  const recovery = assessKillSwitchRecovery(sourceRequest);
  if (recovery.state !== input.policy.requireRecoveryState) {
    fail('RECOVERY_NOT_NORMAL', 'current hypothetical recovery state is ' + recovery.state);
  }

  const base = {
    version: KILL_SWITCH_RESET_REQUEST_VERSION,
    requestedAt: input.requestedAt,
    requester: { ...input.requester },
    tripId: trip.tripId!,
    tripFingerprint: trip.triggeringDecisionFingerprint!,
    rationale: input.rationale,
    recoveryDecisionId: recovery.decisionId,
    recoveryDecisionFingerprint: recovery.inputFingerprint,
    policyFingerprint: hashOf(input.policy),
  };
  const requestFingerprint = hashOf(requestCore(base));
  return {
    ...base,
    requestId: 'ksrr_' + requestFingerprint.slice(0, 40),
    requestFingerprint,
  };
}

export function buildKillSwitchResetApproval(
  request: KillSwitchResetRequest,
  input: {
    approvedAt: string;
    approver: HumanActor;
    decision: 'APPROVE' | 'REJECT';
    rationale: string;
    policy: KillSwitchResetPolicy;
  },
): KillSwitchResetApproval {
  validatePolicy(input.policy);
  validateRequestArtifact(request);
  if (request.policyFingerprint !== hashOf(input.policy)) fail('INVALID_APPROVAL', 'approval policy differs from request policy');
  const approvedMs = canonicalMs(input.approvedAt, 'INVALID_APPROVAL', 'approvedAt');
  const requestedMs = canonicalMs(request.requestedAt, 'INVALID_REQUEST', 'requestedAt');
  if (approvedMs < requestedMs) fail('INVALID_APPROVAL', 'approval predates the request');
  validateActor(input.approver, 'INVALID_APPROVAL', 'approver');
  if (input.policy.requireDistinctApprover && input.approver.id === request.requester.id) {
    fail('SELF_APPROVAL', 'requester cannot approve their own reset');
  }
  if (input.decision !== 'APPROVE' && input.decision !== 'REJECT') fail('INVALID_APPROVAL', 'approval decision is invalid');
  validateRationale(input.rationale, input.policy.minimumRationaleLength, 'INVALID_APPROVAL');

  const base = {
    version: KILL_SWITCH_RESET_APPROVAL_VERSION,
    requestId: request.requestId,
    approvedAt: input.approvedAt,
    approver: { ...input.approver },
    decision: input.decision,
    rationale: input.rationale,
    requestFingerprint: request.requestFingerprint,
  };
  const approvalFingerprint = hashOf(approvalCore(base));
  return {
    ...base,
    approvalId: 'ksra_' + approvalFingerprint.slice(0, 40),
    approvalFingerprint,
  };
}

export function authorizeKillSwitchReset(
  sourceRequest: PortfolioSafetyRequest,
  request: KillSwitchResetRequest,
  approval: KillSwitchResetApproval,
  policy: KillSwitchResetPolicy,
  authorizedAt: string,
): KillSwitchResetAuthorization {
  validatePolicy(policy);

  const expectedRequest = buildKillSwitchResetRequest(sourceRequest, {
    requestedAt: request.requestedAt,
    requester: request.requester,
    rationale: request.rationale,
    policy,
  });
  if (hashOf(expectedRequest) !== hashOf(request)) fail('INVALID_REQUEST', 'reset request does not match current source');

  const expectedApproval = buildKillSwitchResetApproval(request, {
    approvedAt: approval.approvedAt,
    approver: approval.approver,
    decision: approval.decision,
    rationale: approval.rationale,
    policy,
  });
  if (hashOf(expectedApproval) !== hashOf(approval)) fail('INVALID_APPROVAL', 'approval does not match request');

  if (approval.decision === 'REJECT') fail('RESET_REJECTED', 'reset request was rejected');

  const trip = currentTripOf(sourceRequest);
  const approvalMs = canonicalMs(approval.approvedAt, 'INVALID_APPROVAL', 'approvedAt');
  const tripMs = canonicalMs(trip.trippedAt, 'INVALID_SOURCE', 'trippedAt');
  if (approvalMs - tripMs < policy.minimumCooldownMs) {
    fail('COOLDOWN_NOT_ELAPSED', 'minimum reset cooldown has not elapsed');
  }

  const authorizedMs = canonicalMs(authorizedAt, 'INVALID_AUTHORIZATION', 'authorizedAt');
  if (authorizedMs < approvalMs) fail('INVALID_AUTHORIZATION', 'authorization predates approval');
  const expiresMs = approvalMs + policy.authorizationTtlMs;
  if (!Number.isSafeInteger(expiresMs)) fail('INVALID_POLICY', 'authorization expiry exceeds safe timestamp range');
  if (authorizedMs > expiresMs) fail('AUTHORIZATION_EXPIRED', 'authorization is already expired');

  const recovery = assessKillSwitchRecovery(sourceRequest);
  if (recovery.state !== 'NORMAL') fail('RECOVERY_NOT_NORMAL', 'recovery is no longer NORMAL');

  const expiresAt = new Date(expiresMs).toISOString();
  const base = {
    version: KILL_SWITCH_RESET_AUTHORIZATION_VERSION,
    requestId: request.requestId,
    approvalId: approval.approvalId,
    tripId: trip.tripId!,
    authorizedAt,
    expiresAt,
    requester: { ...request.requester },
    approver: { ...approval.approver },
    recoveryDecisionId: recovery.decisionId,
    recoveryDecisionFingerprint: recovery.inputFingerprint,
    applyAllowed: false as const,
    liveOrderAllowed: false as const,
    physicalPurchaseAllowed: false as const,
  };
  const authorizationFingerprint = hashOf(base);
  return {
    ...base,
    authorizationId: 'ksrz_' + authorizationFingerprint.slice(0, 40),
    authorizationFingerprint,
  };
}

export function verifyKillSwitchResetAuthorization(
  sourceRequest: PortfolioSafetyRequest,
  request: KillSwitchResetRequest,
  approval: KillSwitchResetApproval,
  policy: KillSwitchResetPolicy,
  authorization: KillSwitchResetAuthorization,
  evaluatedAt: string,
): void {
  if (!authorization || authorization.version !== KILL_SWITCH_RESET_AUTHORIZATION_VERSION) {
    fail('INVALID_AUTHORIZATION', 'authorization version is invalid');
  }
  const expected = authorizeKillSwitchReset(
    sourceRequest,
    request,
    approval,
    policy,
    authorization.authorizedAt,
  );
  if (hashOf(expected) !== hashOf(authorization)) {
    fail('INVALID_AUTHORIZATION', 'authorization does not match its sources');
  }
  const evaluatedMs = canonicalMs(evaluatedAt, 'INVALID_AUTHORIZATION', 'evaluatedAt');
  const authorizedMs = canonicalMs(authorization.authorizedAt, 'INVALID_AUTHORIZATION', 'authorizedAt');
  const expiresMs = canonicalMs(authorization.expiresAt, 'INVALID_AUTHORIZATION', 'expiresAt');
  if (evaluatedMs < authorizedMs) fail('INVALID_AUTHORIZATION', 'authorization evaluated before it existed');
  if (evaluatedMs > expiresMs) fail('AUTHORIZATION_EXPIRED', 'authorization has expired');
}
