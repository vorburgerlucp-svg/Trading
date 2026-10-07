// Append-only, hash-chained audit event store. Every step of a NEXUS decision is recorded as an
// event; a DecisionRecord references the events by id. The schema already supports order events,
// but nothing in this build emits ORDER_INTENT / ORDER_EXECUTION (execution is locked).

import { AppendOnlyLog, InMemoryAppendOnlyStore, type AppendOnlyStore, type LogAppendResult } from '../persistence/append-only-log.js';

export const AUDIT_EVENT_TYPES = [
  'TASK_CREATED',
  'MODEL_SELECTED',
  'MODEL_RESPONSE_RECEIVED',
  'BLACKBOARD_ENTRY',
  'CRITIC_STARTED',
  'CONSENSUS_CREATED',
  'QUANT_RESULT',
  'RISK_DECISION',
  'CAPITAL_PROPOSAL',
  'HUMAN_APPROVAL',
  'BROKER_SNAPSHOT',
  'ORDER_INTENT',
  'ORDER_EXECUTION',
  'OUTCOME_RECORDED',
  'DECISION_RECORDED',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditActor {
  kind: 'system' | 'human' | 'model' | 'quant';
  id: string;
}

export interface AuditEvent<P = unknown> {
  eventId: string;
  type: AuditEventType;
  occurredAt: string;
  decisionId?: string;
  taskId?: string;
  actor: AuditActor;
  payload: P;
}

export class AuditError extends Error {
  override readonly name = 'AuditError';
}

export class AuditLog {
  private constructor(private readonly log: AppendOnlyLog<AuditEvent>) {}

  static async open(store: AppendOnlyStore<AuditEvent> = new InMemoryAppendOnlyStore(), options: { clock?: () => Date } = {}): Promise<AuditLog> {
    return new AuditLog(await AppendOnlyLog.open('audit', store, options));
  }

  /** Idempotent by eventId: the same event twice is ALREADY_APPLIED, a different one with the same id is rejected. */
  async record<P>(event: AuditEvent<P>): Promise<LogAppendResult<AuditEvent>> {
    if (!AUDIT_EVENT_TYPES.includes(event.type)) throw new AuditError('unknown audit event type ' + event.type);
    if (event.eventId.trim() === '') throw new AuditError('eventId is required');
    if (Number.isNaN(Date.parse(event.occurredAt))) throw new AuditError('occurredAt must be an ISO timestamp');
    if (!['system', 'human', 'model', 'quant'].includes(event.actor.kind) || event.actor.id.trim() === '') throw new AuditError('invalid actor');
    return this.log.append(event.eventId, event as AuditEvent);
  }

  get<P = unknown>(eventId: string): AuditEvent<P> | undefined {
    return this.log.get(eventId)?.payload as AuditEvent<P> | undefined;
  }

  byDecision(decisionId: string): AuditEvent[] {
    return this.log
      .all()
      .map((r) => r.payload)
      .filter((e) => e.decisionId === decisionId);
  }

  all(): AuditEvent[] {
    return this.log.all().map((r) => r.payload);
  }

  sync(): Promise<void> {
    return this.log.sync();
  }

  verifyIntegrity() {
    return this.log.verifyIntegrity();
  }
}
