// R2: sealing plans and recording v2 evaluations, each in its own append-only, hash-chained log. A plan's seal is the log record
// that stored it: its recordedAt and sequence say when NEXUS had fixed the plan. The ledger is the ONLY source of a verified seal:
// `getVerified` re-reads the plan from the log (whose hash chain is verified on every load) and checks the plan hash, so a caller
// cannot present a hand-made `sealedAt` as a stored one. Evaluations are stored per decision, method and origin, never overwritten,
// and only when final: a PENDING result is not recorded (it would block the later, complete evaluation).

import { AppendOnlyLog, type AppendOnlyStore } from '../../persistence/append-only-log.js';
import type { EvaluationV2 } from './outcome-eval-v2.js';
import { tradePlanHash, tradePlanProblems, TradePlanError, type AnyPlan } from './trade-plan.js';

export const TRADE_PLAN_LOG = 'trade-plans-v1';
export const EVALUATION_V2_LOG = 'evaluations-v2';

export interface SealedPlanRecord {
  plan: AnyPlan;
  planHash: string;
}

/**
 * A plan with its seal. A SealedPlan object by itself proves nothing (anyone can build one): an evaluation counts it as a stored
 * seal only when it read the plan from a TradePlanLedger itself (evaluateDecisionFromLedger).
 */
export interface SealedPlan {
  plan: AnyPlan;
  planHash: string;
  sealedAt: string;
  sequence: number;
}

export class TradePlanLedger {
  private constructor(private readonly log: AppendOnlyLog<SealedPlanRecord>) {}

  static async open(store: AppendOnlyStore<SealedPlanRecord>, options: { clock?: () => Date } = {}): Promise<TradePlanLedger> {
    return new TradePlanLedger(await AppendOnlyLog.open<SealedPlanRecord>(TRADE_PLAN_LOG, store, options.clock ? { clock: options.clock } : {}));
  }

  /** Seals a complete plan. The same plan again is idempotent; a different plan under the same planId is refused. */
  async seal(plan: AnyPlan, referencePrice?: string): Promise<SealedPlan> {
    const problems = tradePlanProblems(plan, referencePrice);
    if (problems.length > 0) throw new TradePlanError('trade plan is not complete: ' + problems.join('; '));
    const planHash = tradePlanHash(plan);
    const { record } = await this.log.append(plan.planId, { plan, planHash });
    return { plan: record.payload.plan, planHash: record.payload.planHash, sealedAt: record.recordedAt, sequence: record.sequence };
  }

  /** The stored plan and its seal, read from the log (verified hash chain) and checked against its hash. */
  async getVerified(planId: string): Promise<SealedPlan | null> {
    await this.log.sync();
    const record = this.log.get(planId);
    if (!record) return null;
    if (tradePlanHash(record.payload.plan) !== record.payload.planHash) throw new TradePlanError('stored plan ' + planId + ' does not match its hash');
    return { plan: record.payload.plan, planHash: record.payload.planHash, sealedAt: record.recordedAt, sequence: record.sequence };
  }

  /** Same as getVerified (kept for readers). */
  get(planId: string): Promise<SealedPlan | null> {
    return this.getVerified(planId);
  }
}

/** The v2 evaluation records. Read by analysis and, later, the Learning Lab; never by routing, calibration or champions. */
export class EvaluationLedgerV2 {
  private constructor(private readonly log: AppendOnlyLog<EvaluationV2>) {}

  static async open(store: AppendOnlyStore<EvaluationV2>, options: { clock?: () => Date } = {}): Promise<EvaluationLedgerV2> {
    return new EvaluationLedgerV2(await AppendOnlyLog.open<EvaluationV2>(EVALUATION_V2_LOG, store, options.clock ? { clock: options.clock } : {}));
  }

  static idOf(evaluation: Pick<EvaluationV2, 'decisionId' | 'method' | 'origin' | 'policyVersion'>): string {
    return evaluation.decisionId + ':' + evaluation.method + ':' + evaluation.policyVersion + ':' + evaluation.origin;
  }

  /** Records a FINAL evaluation once (PENDING is refused). The same evaluation again is idempotent; a different one is refused. */
  async record(evaluation: EvaluationV2): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    if (evaluation.status === 'PENDING') throw new TradePlanError('a pending evaluation is not recorded: evaluate again after its data is complete');
    return (await this.log.append(EvaluationLedgerV2.idOf(evaluation), evaluation)).status;
  }

  async all(): Promise<EvaluationV2[]> {
    await this.log.sync();
    return this.log.all().map((r) => r.payload);
  }
}
