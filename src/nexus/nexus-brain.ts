// NEXUS Brain: the coordinating system. Models are specialists inside it, never the decider.
//
//   AI proposes. Quant verifies. Risk controls. NEXUS learns and decides. Human approves critical capital movements.
//
// One decision cycle:
//   inputs (point-in-time evidence, quarantined external text) → capital truth (read-only Capital Engine)
//   → plan (depth, mode) → task manager (router + council per step, blackboard) → critic findings
//   → consensus (view vs action) → risk + capital authority (allocator + capital risk gate)
//   → human-approval rules → execution gate (locked) → audit record in memory
//
// "NEXUS decides" means: NEXUS decides the RECOMMENDATION. Nothing is executed in this build.

import { AiCouncil } from '../ai/ai-council.js';
import type { ChampionBoard } from '../ai/champion-challenger.js';
import type { AdapterMap, CapitalContext } from '../ai/model-adapter.js';
import type { ModelPerformance } from '../ai/model-performance.js';
import type { ModelRegistry } from '../ai/model-registry.js';
import { DOMAINS, SUBTASKS, type ModelOpinion } from '../ai/model-types.js';
import type { SharedBlackboard } from '../blackboard/shared-blackboard.js';
import { proposeAllocation, type AllocationPolicy } from '../capital/capital-allocator.js';
import type { CapitalEngine, SnapshotOptions } from '../capital/capital-engine.js';
import type { PortfolioSnapshot } from '../capital/capital-types.js';
import type { EvidenceStore } from '../evidence/evidence-store.js';
import type { NexusMemory } from '../memory/nexus-memory.js';
import { deepFreeze } from '../persistence/append-only-log.js';
import { formatChf, minChf, rappen, ZERO_CHF, type Rappen } from '../money/money.js';
import type { Opportunity } from '../opportunities/opportunity-types.js';
import { assessAllocationProposal } from '../risk-engine.js';
import { toUntrustedBlock } from '../security/untrusted-input.js';
import { AiRouter, DEFAULT_ROUTER_CONFIG, type RouterConfig } from './ai-router.js';
import { buildConsensus } from './consensus-engine.js';
import { assessRiskFlags } from './critic.js';
import type {
  AiTask,
  CapitalDecision,
  DecisionOutcome,
  DecisionRecord,
  NexusDecision,
  QuantAssessment,
} from './nexus-types.js';
import { executionGate, isFinancialBucket, type SafetyConfig } from './safety.js';
import { TaskManager } from './task-manager.js';
import { DEFAULT_PLANNER_CONFIG, planTask, type PlannerConfig } from './task-planner.js';

/** Read-only view of the financial truth. The brain can read capital, never write it. */
export interface CapitalReader {
  snapshot(asOf: string): PortfolioSnapshot;
}

export function readOnlyCapital(engine: Pick<CapitalEngine, 'snapshot'>, options: Omit<SnapshotOptions, 'asOf'> = {}): CapitalReader {
  return Object.freeze({ snapshot: (asOf: string) => engine.snapshot({ ...options, asOf }) });
}

export interface NexusBrainDeps {
  clock: () => Date;
  newId: () => string;
  registry: ModelRegistry;
  performance: ModelPerformance;
  champions: ChampionBoard;
  adapters: AdapterMap;
  evidence: EvidenceStore;
  blackboard: SharedBlackboard;
  memory: NexusMemory;
  capital: CapitalReader;
  allocationPolicy: AllocationPolicy;
  safety: SafetyConfig;
  planner?: PlannerConfig;
  router?: RouterConfig;
  modelTimeoutMs?: number;
}

export interface DecisionRequest {
  task: AiTask;
  /** System-authored, trusted question. External text goes into evidence, never here. */
  question: string;
  /** Decision time. Everything is evaluated point-in-time at this instant. */
  asOf: string;
  evidenceIds: string[];
  /** Evidence that must be fresh for a current trading decision (e.g. the latest price). */
  keyEvidenceIds?: string[];
  opportunity?: Opportunity;
  quant?: QuantAssessment;
  /** Default: required for financial-market opportunities. */
  requiresQuant?: boolean;
}

export class NexusBrainError extends Error {
  override readonly name = 'NexusBrainError';
}

export class NexusBrain {
  private readonly taskManager: TaskManager;
  /** Frozen private copy: nothing that happens during a decision can change the policy. */
  private readonly allocationPolicy: AllocationPolicy;

  constructor(private readonly deps: NexusBrainDeps) {
    this.allocationPolicy = deepFreeze(structuredClone(deps.allocationPolicy));
    const router = new AiRouter(deps.registry, deps.performance, deps.champions, deps.adapters, deps.router ?? DEFAULT_ROUTER_CONFIG);
    const council = new AiCouncil(deps.registry, deps.adapters, { clock: deps.clock, newId: deps.newId });
    this.taskManager = new TaskManager({ router, council, blackboard: deps.blackboard, evidence: deps.evidence });
  }

  async decide(request: DecisionRequest): Promise<NexusDecision> {
    const { task, asOf } = request;
    this.validate(request);
    const { evidence, blackboard, memory } = this.deps;
    const decisionId = 'decision:' + this.deps.newId();

    // 1. Inputs, point-in-time. Look-ahead evidence is excluded; external text is quoted / quarantined.
    const keyIds = request.keyEvidenceIds ?? [];
    const ids = [...new Set([...request.evidenceIds, ...keyIds])];
    const assessments = ids.map((id) => evidence.assess(id, asOf));
    const excludedLookAhead = assessments.filter((a) => a.status === 'not_yet_available').map((a) => a.id);
    const staleKey = keyIds.filter((id) => evidence.assess(id, asOf).status === 'stale');
    const missingKey = keyIds.filter((id) => ['unknown', 'not_yet_available'].includes(evidence.assess(id, asOf).status));
    const untrusted = assessments
      .filter((a) => a.ref?.contentKind === 'external_text' && a.status !== 'not_yet_available')
      .map((a) => toUntrustedBlock(a.id, a.ref?.source ?? 'unknown', evidence.content(a.id, asOf) ?? ''));
    const quarantined = untrusted.filter((u) => u.quarantined);

    // 2. Capital truth (read-only).
    const portfolio = this.deps.capital.snapshot(asOf);
    const c = portfolio.capital;
    const capitalEvidenceId = 'capital-state:' + decisionId;
    await evidence.register({
      id: capitalEvidenceId,
      type: 'capital_state',
      source: 'nexus-capital-engine',
      observedAt: asOf,
      availableAt: asOf,
      retrievedAt: asOf,
      trusted: true,
      contentKind: 'structured',
      metadata: { stateTimestamp: c.timestamp },
    });
    const capitalFacts: [string, Rappen][] = [
      ['Net worth', c.totalNetWorthChf],
      ['Available capital', c.availableCapitalChf],
      ['Safety reserve', c.safetyReserveChf],
      ['Reserved capital', c.reservedCapitalChf],
      ['Committed capital', c.committedCapitalChf],
      ['Invested capital', c.investedCapitalChf],
      ['Liabilities', c.liabilitiesChf],
    ];
    for (const [label, amount] of capitalFacts) {
      await blackboard.post({ taskId: task.id, author: { type: 'system' }, category: 'fact', statement: label + ': ' + formatChf(amount) + ' CHF', evidenceRefs: [capitalEvidenceId] }, asOf);
    }
    const capitalContext: CapitalContext = {
      asOf,
      netWorthChf: formatChf(c.totalNetWorthChf),
      availableChf: formatChf(c.availableCapitalChf),
      reservedChf: formatChf(c.reservedCapitalChf),
      committedChf: formatChf(c.committedCapitalChf),
      investedChf: formatChf(c.investedCapitalChf),
      liabilitiesChf: formatChf(c.liabilitiesChf),
      inventoryChf: formatChf(c.physicalInventoryCostChf),
      receivablesChf: formatChf(c.receivablesChf),
    };
    if (request.quant && request.quant.status !== 'not_available' && request.quant.evidenceRefId) {
      await blackboard.post(
        {
          taskId: task.id,
          author: { type: 'quant' },
          category: 'calculation',
          statement: 'Quant ' + request.quant.status + (request.quant.direction ? ' (' + request.quant.direction + ')' : '') + (request.quant.summary ? ': ' + request.quant.summary : ''),
          evidenceRefs: [request.quant.evidenceRefId],
        },
        asOf,
      );
    }

    // 3. Plan and run the council. The planner sees the capital actually at stake: the declared amount
    //    or what the Capital Engine would allow for this opportunity, whichever is larger (no under-declaring).
    const opportunity = request.opportunity;
    const allocation = opportunity
      ? proposeAllocation({ id: decisionId + ':allocation', at: asOf, snapshot: portfolio, opportunities: [opportunity], policy: this.allocationPolicy })
      : null;
    const allocatable = allocation?.allocations[0]?.amountChf ?? ZERO_CHF;
    const declared = task.capitalAtRiskMinor ?? ZERO_CHF;
    const plannedTask: AiTask = allocatable > declared ? { ...task, capitalAtRiskMinor: allocatable } : task;
    const plan = planTask(plannedTask, this.deps.planner ?? DEFAULT_PLANNER_CONFIG);
    if (plannedTask !== task) plan.reasons.unshift('capital at risk raised from declared ' + formatChf(declared) + ' to allocatable ' + formatChf(allocatable) + ' CHF');
    const execution = await this.taskManager.execute({
      task: plannedTask,
      plan,
      question: request.question,
      asOf,
      capital: capitalContext,
      untrusted,
      timeoutMs: this.deps.modelTimeoutMs ?? task.maximumLatencyMs ?? 30_000,
    });

    // 4. Critic findings and consensus.
    const valid = execution.attempts.filter((a) => a.status === 'ok' && !a.shadow && a.opinion);
    const analysts = valid.filter((a) => a.role === 'analyst').map((a) => ({ modelKey: a.modelKey, opinion: a.opinion as ModelOpinion }));
    const findings = assessRiskFlags(valid, evidence, asOf);
    const requiresQuant = request.requiresQuant ?? (opportunity !== undefined && isFinancialBucket(opportunity.bucket));
    const consensus = buildConsensus({
      plan,
      analysts,
      findings,
      quant: request.quant ?? null,
      requiresQuant,
      staleKeyEvidence: staleKey,
      missingKeyEvidence: missingKey,
      quarantinedEvidence: quarantined.map((q) => q.evidenceId),
      insufficientAnalysis: execution.insufficientReasons,
      entries: blackboard.entries(task.id),
    });

    // 5. Risk and capital authority: amounts come from the Capital Engine + allocation policy, never from a model.
    let capital: CapitalDecision | null = null;
    const risk = { passed: true, reasons: [] as string[] };
    const approvalReasons: string[] = [];
    if (opportunity && allocation) {
      const gate = assessAllocationProposal(allocation, c);
      const allocated = allocation.allocations[0];
      const maxAllowed = allocated?.amountChf ?? ZERO_CHF;
      const suggestions = analysts.map((a) => a.opinion.suggestedCapitalChf).filter((s): s is Rappen => s !== null);
      const aiSuggested = suggestions.length > 0 ? minChf(suggestions[0] as Rappen, ...suggestions.slice(1)) : null;
      const cappedBy: string[] = [];
      let recommended = aiSuggested === null ? maxAllowed : minChf(maxAllowed, aiSuggested);
      if (aiSuggested !== null && aiSuggested > maxAllowed) cappedBy.push('capital engine + allocation policy: max ' + formatChf(maxAllowed) + ' CHF (AI suggested ' + formatChf(aiSuggested) + ')');
      if (aiSuggested !== null && aiSuggested < maxAllowed) cappedBy.push('AI suggestion below allowed maximum');
      if (opportunity.sizing.kind === 'scalable') {
        recommended = rappen(recommended - (recommended % opportunity.sizing.lotSizeChf));
        if (recommended < opportunity.sizing.minTicketChf) recommended = ZERO_CHF;
      } else if (recommended < opportunity.requiredCapitalChf) {
        recommended = ZERO_CHF;
      }
      if (consensus.execution !== 'PROCEED_TO_RISK' || consensus.recommendation !== 'buy') recommended = ZERO_CHF;

      if (!opportunity.eligibility.eligible) risk.reasons.push(...opportunity.eligibility.reasons);
      if (!gate.passed) risk.reasons.push(...gate.reasons);
      if (maxAllowed === ZERO_CHF) risk.reasons.push('no capital can be allocated: ' + (allocation.skipped[0]?.reasons.join('; ') ?? allocation.warnings.join('; ')));
      risk.passed = risk.reasons.length === 0;

      capital = {
        availableChf: c.availableCapitalChf,
        maxAllowedChf: maxAllowed,
        aiSuggestedChf: aiSuggested,
        recommendedChf: recommended,
        cappedBy,
        allocationSkipReasons: allocation.skipped.flatMap((s) => s.reasons),
      };
      if (plan.requiresHumanApproval) approvalReasons.push('critical decision depth');
      if (allocated?.requiresHumanApproval) approvalReasons.push('amount at or above the human-approval threshold');
      if (opportunity.bucket === 'physical_trade' || opportunity.bucket === 'business') approvalReasons.push('physical purchase / business spend');
    }

    // 6. Outcome, approval, execution gate.
    let outcome: DecisionOutcome;
    if (!opportunity) outcome = 'ANALYSIS_ONLY';
    else outcome = consensus.execution === 'PROCEED_TO_RISK' && consensus.recommendation === 'buy' && risk.passed && (capital?.recommendedChf ?? 0n) > 0n ? 'RECOMMEND' : 'NO_ACTION';
    const requiresHumanApproval = outcome === 'RECOMMEND' && approvalReasons.length > 0;
    const execGate = executionGate({ outcome, bucket: opportunity?.bucket ?? null, safety: this.deps.safety });
    const reasons = [...new Set([...consensus.blockingReasons, ...(consensus.execution === 'PROCEED_TO_RISK' ? risk.reasons : [])])];

    const decision: NexusDecision = {
      decisionId,
      taskId: task.id,
      asOf,
      outcome,
      direction: consensus.direction,
      recommendation: consensus.recommendation,
      depth: plan.depth,
      mode: plan.mode,
      capital,
      requiresHumanApproval,
      humanApprovalReasons: requiresHumanApproval ? approvalReasons : [],
      execution: execGate,
      reasons,
      consensus,
    };

    // 7. Audit trail (decision memory) and failure memory.
    const record: DecisionRecord = {
      decision,
      task,
      question: request.question,
      plan,
      inputs: {
        evidence: assessments.map((a) => ({
          id: a.id,
          type: a.ref?.type ?? 'unknown',
          source: a.ref?.source ?? 'unknown',
          observedAt: a.ref?.observedAt ?? '',
          availableAt: a.ref?.availableAt ?? '',
          status: a.status,
          version: evidence.version(a.id) ?? null,
        })),
        excludedLookAhead,
        capitalStateTimestamp: c.timestamp,
        capitalEvidenceId,
        quant: request.quant ?? null,
      },
      routing: execution.steps.map((s) => ({
        stepId: s.step.id,
        primaries: s.routing.primaries.map((p) => p.modelKey),
        fallbacks: s.routing.fallbacks,
        shadow: s.routing.shadow,
        rejected: s.routing.rejected,
      })),
      attempts: execution.attempts,
      blackboardEntryIds: blackboard.entries(task.id).map((e) => e.id),
      criticFindings: findings,
      risk,
      humanApproval: { required: requiresHumanApproval, status: requiresHumanApproval ? 'pending' : 'not_required', reasons: decision.humanApprovalReasons },
      security: { quarantinedEvidence: quarantined.map((q) => ({ evidenceId: q.evidenceId, rules: q.flags.map((f) => f.rule) })) },
    };
    await memory.remember({
      id: decisionId,
      kind: 'decision',
      subject: task.id,
      tags: ['domain:' + task.domain, 'subtask:' + task.subtask, 'outcome:' + outcome, 'depth:' + plan.depth],
      content: record,
      occurredAt: asOf,
      availableAt: asOf,
      evidenceRefs: ids.filter((id) => !excludedLookAhead.includes(id)),
      source: 'nexus-brain',
    });
    let n = 0;
    for (const attempt of execution.attempts.filter((a) => a.status !== 'ok')) {
      await memory.remember({
        id: decisionId + ':failure:' + ++n,
        kind: 'failure',
        subject: attempt.modelKey,
        tags: ['status:' + attempt.status, 'step:' + attempt.stepId],
        content: { decisionId, stepId: attempt.stepId, status: attempt.status, error: attempt.error ?? null, fallbackFor: attempt.fallbackFor ?? null },
        occurredAt: asOf,
        availableAt: asOf,
        source: 'ai-council',
      });
    }
    return decision;
  }

  /** The full audit record of a decision, as known at `asOf`. */
  record(decisionId: string): DecisionRecord | undefined {
    return this.deps.memory.get<DecisionRecord>(decisionId)?.content;
  }

  private validate(request: DecisionRequest): void {
    const { task } = request;
    if (!DOMAINS.includes(task.domain)) throw new NexusBrainError('unknown domain ' + task.domain);
    if (!SUBTASKS.includes(task.subtask)) throw new NexusBrainError('unknown subtask ' + task.subtask);
    if (request.question.trim() === '') throw new NexusBrainError('question is required');
    if (Number.isNaN(Date.parse(request.asOf))) throw new NexusBrainError('asOf must be an ISO timestamp');
    if (task.capitalAtRiskMinor !== undefined && task.capitalAtRiskMinor < 0n) throw new NexusBrainError('capitalAtRiskMinor must not be negative');
    if (this.deps.blackboard.entries(task.id).length > 0) throw new NexusBrainError('task ' + task.id + ' already ran a decision cycle; use a new task id');
  }
}

