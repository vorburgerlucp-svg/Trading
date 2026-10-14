import type { AuditLog } from '../audit/audit-log.js';
import type { PortfolioSafetyDecision, PortfolioSafetyRequest } from './portfolio-safety-envelope.js';
import type { SafetyAlertBatch } from './safety-alerting.js';

export class SafetyAuditError extends Error {
  override readonly name = 'SafetyAuditError';
  constructor(readonly code: 'INVALID_DECISION' | 'INVALID_ALERT_BATCH', message: string) {
    super(code + ': ' + message);
  }
}

export class SafetyAuditService {
  constructor(readonly audit: AuditLog) {}

  async recordDecision(
    _request: PortfolioSafetyRequest,
    _decision: PortfolioSafetyDecision,
  ): Promise<void> {
    throw new Error('O16 safety decision audit not implemented');
  }

  async recordAlertBatch(
    _decision: PortfolioSafetyDecision,
    _batch: SafetyAlertBatch,
  ): Promise<void> {
    throw new Error('O16 safety alert audit not implemented');
  }
}
