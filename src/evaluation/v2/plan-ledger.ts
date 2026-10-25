// R2: sealing trade plans and recording v2 evaluations, each in its own append-only, hash-chained log. A plan's seal is the
// log record that stored it: its recordedAt and sequence prove when NEXUS had fixed the plan. An evaluation refuses a plan that
// was sealed at or after its earliest entry (the plan could have been written knowing part of the outcome). Evaluations are
// stored per decision, method and origin, and never overwritten: a correction is a new method version.

import { AppendOnlyLog, type AppendOnlyStore } from '../../persistence/append-only-log.js';
import { tradePlanHash, tradePlanProblems, TradePlanError, type TradePlan } from './trade-plan.js';
import type { EvaluationV2 } from './outcome-eval-v2.js';

export const TRADE_PLAN_LOG = 'trade-plans-v1';
export const EVALUATION_V2_LOG = 'evaluations-v2';

export interface SealedPlanRecord {
  plan: TradePlan;
  planHash: string;
}

export interface SealedPlan {
  plan: TradePlan;
  planHash: string;
  /** When the plan was stored (the log record's recordedAt). */
  sealedAt: string;
  /** Position of the seal in the plan log. */
  sequence: number;
}

export class TradePlanLedger {
  private constructor(private readonly log: AppendOnlyLog<SealedPlanRecord>) {}

  static async open(store: AppendOnlyStore<SealedPlanRecord>, options: { clock?: () => Date } = {}): Promise<TradePlanLedger> {
    return new TradePlanLedger(await AppendOnlyLog.open<SealedPlanRecord>(TRADE_PLAN_LOG, store, options.clock ? { clock: options.clock } : {}));
  }

  /** Seals a complete plan. The same plan again is idempotent; a different plan under the same planId is refused. */
  async seal(plan: TradePlan, referencePrice?: string): Promise<SealedPlan> {
    const problems = tradePlanProblems(plan, referencePrice);
    if (problems.length > 0) throw new TradePlanError('trade plan is not complete: ' + problems.join('; '));
    const planHash = tradePlanHash(plan);
    const { record } = await this.log.append(plan.planId, { plan, planHash });
    return { plan: record.payload.plan, planHash: record.payload.planHash, sealedAt: record.recordedAt, sequence: record.sequence };
  }

  async get(planId: string): Promise<SealedPlan | null> {
    await this.log.sync();
    const record = this.log.get(planId);
    if (!record) return null;
    if (tradePlanHash(record.payload.plan) !== record.payload.planHash) throw new TradePlanError('stored plan ' + planId + ' does not match its hash');
    return { plan: record.payload.plan, planHash: record.payload.planHash, sealedAt: record.recordedAt, sequence: record.sequence };
  }
}

/** The v2 evaluation records. Read by analysis and, later, the Learning Lab; never by routing, calibration or champions. */
export class EvaluationLedgerV2 {
  private constructor(private readonly log: AppendOnlyLog<EvaluationV2>) {}

  static async open(store: AppendOnlyStore<EvaluationV2>, options: { clock?: () => Date } = {}): Promise<EvaluationLedgerV2> {
    return new EvaluationLedgerV2(await AppendOnlyLog.open<EvaluationV2>(EVALUATION_V2_LOG, store, options.clock ? { clock: options.clock } : {}));
  }

  static idOf(evaluation: Pick<EvaluationV2, 'decisionId' | 'method' | 'origin'>): string {
    return evaluation.decisionId + ':' + evaluation.method + ':' + evaluation.origin;
  }

  /** Records an evaluation once. The same evaluation again is idempotent; a different one under the same id is refused. */
  async record(evaluation: EvaluationV2): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    return (await this.log.append(EvaluationLedgerV2.idOf(evaluation), evaluation)).status;
  }

  async all(): Promise<EvaluationV2[]> {
    await this.log.sync();
    return this.log.all().map((r) => r.payload);
  }
}
