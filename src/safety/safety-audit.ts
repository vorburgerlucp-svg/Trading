import type { AuditLog } from '../audit/audit-log.js';
import {
  verifyPortfolioSafetyDecision,
  type PortfolioSafetyDecision,
  type PortfolioSafetyRequest,
} from './portfolio-safety-envelope.js';
import {
  verifySafetyAlertBatch,
  type SafetyAlertBatch,
} from './safety-alerting.js';

export class SafetyAuditError extends Error {
  override readonly name = 'SafetyAuditError';
  constructor(readonly code: 'INVALID_DECISION' | 'INVALID_ALERT_BATCH', message: string) {
    super(code + ': ' + message);
  }
}

export class SafetyAuditService {
  constructor(readonly audit: AuditLog) {}

  async recordDecision(
    request: PortfolioSafetyRequest,
    decision: PortfolioSafetyDecision,
  ): Promise<void> {
    try {
      verifyPortfolioSafetyDecision(request, decision);
    } catch (error) {
      throw new SafetyAuditError('INVALID_DECISION', error instanceof Error ? error.message : String(error));
    }

    await this.audit.record({
      eventId: 'safety-decision:' + decision.decisionId,
      type: 'SAFETY_DECISION',
      occurredAt: decision.asOf,
      actor: { kind: 'system', id: 'o16-safety' },
      payload: {
        safetyDecisionId: decision.decisionId,
        safetyDecisionFingerprint: decision.inputFingerprint,
        engineVersion: decision.engineVersion,
        state: decision.state,
        killSwitchTripId: decision.killSwitch.tripId,
        sourceFingerprints: decision.sourceFingerprints,
      },
    });
  }

  async recordAlertBatch(
    decision: PortfolioSafetyDecision,
    batch: SafetyAlertBatch,
  ): Promise<void> {
    try {
      verifySafetyAlertBatch(decision, batch);
    } catch (error) {
      throw new SafetyAuditError('INVALID_ALERT_BATCH', error instanceof Error ? error.message : String(error));
    }

    await this.audit.record({
      eventId: 'safety-alert:' + batch.alertBatchId,
      type: 'SAFETY_ALERT_BATCH',
      occurredAt: batch.asOf,
      actor: { kind: 'system', id: 'o16-safety' },
      payload: {
        alertBatchId: batch.alertBatchId,
        batchFingerprint: batch.batchFingerprint,
        safetyDecisionId: batch.safetyDecisionId,
        safetyDecisionFingerprint: batch.safetyDecisionFingerprint,
        alerts: batch.alerts,
      },
    });
  }
}
