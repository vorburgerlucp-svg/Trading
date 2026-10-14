import { hashOf } from '../persistence/canonical-json.js';
import {
  PORTFOLIO_SAFETY_ENVELOPE_VERSION,
  type PortfolioSafetyDecision,
} from './portfolio-safety-envelope.js';

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

function fail(code: SafetyAlertError['code'], message: string): never {
  throw new SafetyAlertError(code, message);
}

function validatePolicy(policy: SafetyAlertPolicy): void {
  if (
    !policy ||
    policy.version !== SAFETY_ALERT_POLICY_VERSION ||
    policy.emitNormalState !== false ||
    policy.emitCapacityBlock !== true ||
    policy.emitDataHold !== true ||
    policy.emitTrip !== true ||
    policy.includeAllReasons !== true
  ) {
    fail('INVALID_POLICY', 'unsupported safety alert policy');
  }
}

function validateDecision(decision: PortfolioSafetyDecision): void {
  if (
    !decision ||
    decision.engineVersion !== PORTFOLIO_SAFETY_ENVELOPE_VERSION ||
    typeof decision.decisionId !== 'string' ||
    !/^pse_[0-9a-f]{40}$/.test(decision.decisionId) ||
    typeof decision.inputFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(decision.inputFingerprint) ||
    !['NORMAL', 'DATA_HOLD', 'CAPACITY_BLOCK', 'TRIPPED'].includes(decision.state)
  ) {
    fail('INVALID_DECISION', 'safety decision is malformed');
  }
  if (decision.liveOrderAllowed !== false || decision.physicalPurchaseAllowed !== false) {
    fail('INVALID_DECISION', 'safety decision cannot unlock execution');
  }
}

const severityRank: Record<SafetyAlert['severity'], number> = { critical: 0, warning: 1 };

function canonicalAlerts(decision: PortfolioSafetyDecision): SafetyAlert[] {
  const candidates: Array<Omit<SafetyAlert, 'alertId'>> = [];

  if (decision.state === 'CAPACITY_BLOCK') {
    for (const reason of decision.capacityBlockReasons) {
      candidates.push({ severity: 'warning', code: 'CAPACITY_BLOCK', reason });
    }
  }

  for (const descriptor of decision.alerts) {
    candidates.push({
      severity: descriptor.severity === 'trip' ? 'critical' : 'warning',
      code: descriptor.code,
      reason: descriptor.reason,
    });
  }

  if (decision.state === 'DATA_HOLD' && candidates.length === 0) {
    for (const reason of decision.dataHoldReasons) {
      candidates.push({ severity: 'warning', code: 'DATA_HOLD', reason });
    }
  }

  if (decision.state === 'TRIPPED' && !candidates.some((a) => a.severity === 'critical')) {
    const reason = decision.hardBreachReasons[0] ?? 'kill switch is tripped';
    candidates.push({ severity: 'critical', code: 'KILL_SWITCH_TRIPPED', reason });
  }

  const deduped = new Map<string, Omit<SafetyAlert, 'alertId'>>();
  for (const candidate of candidates) {
    const key = candidate.severity + '|' + candidate.code + '|' + candidate.reason;
    deduped.set(key, candidate);
  }

  return [...deduped.values()]
    .sort((a, b) => {
      const sr = severityRank[a.severity] - severityRank[b.severity];
      if (sr !== 0) return sr;
      const ak = a.code + '|' + a.reason;
      const bk = b.code + '|' + b.reason;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    })
    .map((alert) => ({
      ...alert,
      alertId: 'sa_' + hashOf({
        safetyDecisionId: decision.decisionId,
        severity: alert.severity,
        code: alert.code,
        reason: alert.reason,
      }).slice(0, 40),
    }));
}

export function buildSafetyAlertBatch(
  decision: PortfolioSafetyDecision,
  policy: SafetyAlertPolicy,
): SafetyAlertBatch {
  validatePolicy(policy);
  validateDecision(decision);

  const alerts = decision.state === 'NORMAL' ? [] : canonicalAlerts(decision);
  const core = {
    version: SAFETY_ALERT_BATCH_VERSION,
    safetyDecisionId: decision.decisionId,
    safetyDecisionFingerprint: decision.inputFingerprint,
    asOf: decision.asOf,
    alerts,
    policy,
  };
  const batchFingerprint = hashOf(core);
  return {
    alertBatchId: 'sab_' + batchFingerprint.slice(0, 40),
    version: SAFETY_ALERT_BATCH_VERSION,
    safetyDecisionId: decision.decisionId,
    safetyDecisionFingerprint: decision.inputFingerprint,
    asOf: decision.asOf,
    alerts,
    batchFingerprint,
  };
}

export function verifySafetyAlertBatch(
  decision: PortfolioSafetyDecision,
  batch: SafetyAlertBatch,
): void {
  if (!batch || typeof batch !== 'object') fail('INVALID_BATCH', 'alert batch is missing');
  // V1 has one fixed conservative policy, so verification can safely reconstruct it.
  const policy: SafetyAlertPolicy = {
    version: SAFETY_ALERT_POLICY_VERSION,
    emitNormalState: false,
    emitCapacityBlock: true,
    emitDataHold: true,
    emitTrip: true,
    includeAllReasons: true,
  };
  const expected = buildSafetyAlertBatch(decision, policy);
  if (hashOf(expected) !== hashOf(batch)) {
    fail('INVALID_BATCH', 'alert batch does not match its safety decision');
  }
}
