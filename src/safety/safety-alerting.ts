import type { PortfolioSafetyDecision } from './portfolio-safety-envelope.js';

export const SAFETY_ALERT_BATCH_VERSION = 'safety-alert-batch:v1' as const;
export const SAFETY_ALERT_POLICY_VERSION = 'safety-alert-policy:v1' as const;

export interface SafetyAlertPolicy {
  version: typeof SAFETY_ALERT_POLICY_VERSION;
  emitNormalState: false;
  emitCapacityBlock: true;
  emitDataHold: true;
  emitTrip: true;
  includeAllReasons: true;
}

export interface SafetyAlert {
  alertId: string;
  severity: 'warning' | 'critical';
  code: string;
  reason: string;
}

export interface SafetyAlertBatch {
  alertBatchId: string;
  version: typeof SAFETY_ALERT_BATCH_VERSION;
  safetyDecisionId: string;
  safetyDecisionFingerprint: string;
  asOf: string;
  alerts: SafetyAlert[];
  batchFingerprint: string;
}

export class SafetyAlertError extends Error {
  override readonly name = 'SafetyAlertError';
  constructor(readonly code: 'INVALID_POLICY' | 'INVALID_DECISION' | 'INVALID_BATCH', message: string) {
    super(code + ': ' + message);
  }
}

export function buildSafetyAlertBatch(
  _decision: PortfolioSafetyDecision,
  _policy: SafetyAlertPolicy,
): SafetyAlertBatch {
  throw new Error('O16 safety alerting not implemented');
}

export function verifySafetyAlertBatch(
  _decision: PortfolioSafetyDecision,
  _batch: SafetyAlertBatch,
): void {
  throw new Error('O16 safety alert verifier not implemented');
}
