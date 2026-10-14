import type {
  KillSwitchState,
  PortfolioSafetyDecision,
  PortfolioSafetyPolicy,
  PortfolioSafetyRequest,
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

export function assessKillSwitchRecovery(
  _sourceRequest: PortfolioSafetyRequest,
): PortfolioSafetyDecision {
  throw new Error('O16 kill-switch recovery assessment not implemented');
}

export function buildKillSwitchResetRequest(
  _sourceRequest: PortfolioSafetyRequest,
  _input: {
    requestedAt: string;
    requester: HumanActor;
    rationale: string;
    policy: KillSwitchResetPolicy;
  },
): KillSwitchResetRequest {
  throw new Error('O16 reset request not implemented');
}

export function buildKillSwitchResetApproval(
  _request: KillSwitchResetRequest,
  _input: {
    approvedAt: string;
    approver: HumanActor;
    decision: 'APPROVE' | 'REJECT';
    rationale: string;
    policy: KillSwitchResetPolicy;
  },
): KillSwitchResetApproval {
  throw new Error('O16 reset approval not implemented');
}

export function authorizeKillSwitchReset(
  _sourceRequest: PortfolioSafetyRequest,
  _request: KillSwitchResetRequest,
  _approval: KillSwitchResetApproval,
  _policy: KillSwitchResetPolicy,
  _authorizedAt: string,
): KillSwitchResetAuthorization {
  throw new Error('O16 reset authorization not implemented');
}

export function verifyKillSwitchResetAuthorization(
  _sourceRequest: PortfolioSafetyRequest,
  _request: KillSwitchResetRequest,
  _approval: KillSwitchResetApproval,
  _policy: KillSwitchResetPolicy,
  _authorization: KillSwitchResetAuthorization,
  _evaluatedAt: string,
): void {
  throw new Error('O16 reset authorization verifier not implemented');
}

export function currentTripOf(_sourceRequest: PortfolioSafetyRequest): KillSwitchState {
  throw new Error('O16 current trip helper not implemented');
}

export function resetPolicyFingerprint(_policy: PortfolioSafetyPolicy | KillSwitchResetPolicy): string {
  throw new Error('O16 reset policy fingerprint not implemented');
}
