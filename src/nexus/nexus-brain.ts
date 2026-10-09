// NEXUS Brain: the coordinating system. Models are specialists inside it, never the decider.
//
//   AI proposes. Quant verifies. Risk controls. NEXUS learns and decides. Human approves critical capital movements.
//
// One decision cycle:
//   sync stores → inputs (point-in-time evidence, quarantined external text) → capital truth
//   (read-only Capital Engine, exact ledger position) → potential capital impact of THIS decision
//   → plan (depth, mode) → task manager (router + council per step, blackboard) → critic findings
//   → consensus (view vs action) → risk + capital authority (allocator + capital risk gate)
//   → human-approval rules → execution gate (locked) → audit events + normalized DecisionRecord
//
// "NEXUS decides" means: NEXUS decides the RECOMMENDATION. Nothing is executed in this build.

import { AiCouncil } from '../ai/ai-council.js';
import { calibrate, type CalibrationModel } from '../ai/calibration.js';
import type { ChampionBoard } from '../ai/champion-challenger.js';
import type { AdapterMap, CapitalContext } from '../ai/model-adapter.js';
import type { ModelPerformance } from '../ai/model-performance.js';
import type { ModelRegistry } from '../ai/model-registry.js';
import { DOMAINS, SUBTASKS, type ModelOpinion } from '../ai/model-types.js';
import { PROMPT_TEMPLATES } from '../ai/prompts.js';
import type { AuditActor, AuditEvent, AuditEventType, AuditLog } from '../audit/audit-log.js';
import type { DecisionRecord, DecisionRecordStore, FinalAction } from '../audit/decision-records.js';
import type { SharedBlackboard } from '../blackboard/shared-blackboard.js';
import { proposeAllocation, type AllocationPolicy } from '../capital/capital-allocator.js';
import type { CapitalEngine, SnapshotOptions } from '../capital/capital-engine.js';
import type { PortfolioSnapshot } from '../capital/capital-types.js';
import type { EvidenceStore } from '../evidence/evidence-store.js';
import type { NexusMemory } from '../memory/nexus-memory.js';
import { formatChf, minChf, rappen, ZERO_CHF, type Rappen } from '../money/money.js';
import type { Opportunity } from '../opportunities/opportunity-types.js';
import { deepFreeze } from '../persistence/append-only-log.js';
import { hashOf } from '../persistence/canonical-json.js';
import { assessAllocationProposal } from '../risk-engine.js';
import { toUntrustedBlock } from '../security/untrusted-input.js';
import { AiRouter, DEFAULT_ROUTER_CONFIG, type RouterConfig } from './ai-router.js';
import { buildConsensus } from './consensus-engine.js';
import { assessRiskFlags } from './critic.js';
import { EvidenceReferenceError, validateEvidenceReferences, type EvidenceReaders, type EvidenceValidation } from './evidence-validation.js';
import type { AiTask, AttemptRecord, AuthoredRiskFlag, CapitalDecision, ConsensusResult, DecisionOutcome, DecisionTrace, NexusDecision, QuantAssessment, TaskPlan } from './nexus-types.js';
import { executionGate, isFinancialBucket, type SafetyConfig } from './safety.js';
import { TaskManager } from './task-manager.js';
import { DEFAULT_PLANNER_CONFIG, planTask, type PlannerConfig } from './task-planner.js';

/** Read-only view of the financial truth. The brain can read capital, never write it. */
export interface CapitalReader {
  snapshot(asOf: string): PortfolioSnapshot;
  /** Exact ledger position the snapshot is derived from. */
  head(): { ledgerId: string; sequence: number; hash: string };
  /** Catch up with ledger entries committed by other NEXUS processes. */
  refresh?(): Promise<void>;
}

export function readOnlyCapital(engine: Pick<CapitalEngine, 'snapshot' | 'refresh' | 'ledger'>, options: Omit<SnapshotOptions, 'asOf'> = {}): CapitalReader {
  return Object.freeze({
    snapshot: (asOf: string) => engine.snapshot({ ...options, asOf }),
    head: () => engine.ledger.head(),
    refresh: () => engine.refresh(),
  });
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
  audit: AuditLog;
  decisions: DecisionRecordStore;
  capital: CapitalReader;
  allocationPolicy: AllocationPolicy;
  safety: SafetyConfig;
  planner?: PlannerConfig;
  router?: RouterConfig;
  modelTimeoutMs?: number;
  /** Documented calibration model; without one, calibratedProbability stays null. */
  calibration?: CalibrationModel | null;
  /** Read-only lookups for cited quant/scanner/backtest runs. A cited run without its reader fails closed. */
  evidenceReaders?: EvidenceReaders;
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
  /** The decision assumes a ranking of the full universe; an incomplete scanner ranking then fails closed. */
  requiresCompleteUniverse?: boolean;
}

export class NexusBrainError extends Error {
  override readonly name = 'NexusBrainError';
}

const SYSTEM_ACTOR: AuditActor = { kind: 'system', id: 'nexus-brain' };

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
    const { evidence, blackboard, memory, audit } = this.deps;

    // 0. Catch up with every store (other NEXUS processes may have written). Integrity errors fail closed here.
    // Order matters: champion promotions are re-verified against model performance (memory), so
    // memory must be caught up before the champion board.
    await this.deps.capital.refresh?.();
    await Promise.all([evidence.sync(), blackboard.sync(), memory.sync(), audit.sync(), this.deps.decisions.sync()]);
    await this.deps.registry.sync();
    await this.deps.champions.sync();
    this.validate(request);
    const decisionId = 'decision:' + this.deps.newId();
    let eventNo = 0;
    const nextEventId = (type: AuditEventType) => decisionId + ':' + String(++eventNo).padStart(3, '0') + ':' + type.toLowerCase();
    const emit = async <P>(type: AuditEventType, payload: P, actor: AuditActor = SYSTEM_ACTOR, eventId = nextEventId(type)): Promise<string> => {
      const event: AuditEvent<P> = { eventId, type, occurredAt: this.deps.clock().toISOString(), decisionId, taskId: task.id, actor, payload };
      await audit.record(event);
      return eventId;
    };

    // 0b. Referential evidence, read-only and fail closed. Cited runs are checked against their own stores before
    //     anything is written: a phantom, future, invalid or incompatible run never reaches a model or a decision.
    const evidenceValidation = await validateEvidenceReferences(
      {
        asOf,
        quantRunId: request.quant?.quantRunId,
        scannerRunId: request.quant?.scannerRunId,
        backtestRunIds: request.quant?.backtestRunIds,
        opportunityInstrumentId: request.opportunity?.links?.instrumentId,
        requiresCompleteUniverse: request.requiresCompleteUniverse === true,
      },
      this.deps.evidenceReaders ?? {},
    );
    if (!evidenceValidation.passed) {
      // Refused before any write. The task and the blocking reasons stay in the audit trail.
      await emit('TASK_CREATED', { task, question: request.question, outcome: 'REJECTED_EVIDENCE', evidenceValidation });
      throw new EvidenceReferenceError(evidenceValidation);
    }

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

    // 2. Capital truth (read-only), anchored to an exact ledger position.
    const head = this.deps.capital.head();
    const portfolio = this.deps.capital.snapshot(asOf);
    const c = portfolio.capital;
    const capitalStateRef = 'ledger:' + head.ledgerId + '@' + head.sequence + ':' + head.hash + '#asOf=' + asOf;
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
      metadata: { capitalStateRef, ledgerId: head.ledgerId, ledgerSequence: head.sequence, ledgerHash: head.hash },
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

    // 3. Potential capital impact of THIS decision: the opportunity's own capacity, bounded by what the
    //    Capital Engine and allocation policy allow for it. Never "all capital NEXUS owns".
    const opportunity = request.opportunity;
    const allocation = opportunity
      ? proposeAllocation({ id: decisionId + ':allocation', at: asOf, snapshot: portfolio, opportunities: [opportunity], policy: this.allocationPolicy })
      : null;
    const potentialCapitalImpactChf = allocation?.allocations[0]?.amountChf ?? ZERO_CHF;
    const declared = task.capitalAtRiskMinor ?? ZERO_CHF;
    const plannedTask: AiTask = potentialCapitalImpactChf > declared ? { ...task, capitalAtRiskMinor: potentialCapitalImpactChf } : task;
    const plan = planTask(plannedTask, this.deps.planner ?? DEFAULT_PLANNER_CONFIG);
    if (plannedTask !== task) plan.reasons.unshift('capital at risk raised from declared ' + formatChf(declared) + ' to the potential impact of this decision ' + formatChf(potentialCapitalImpactChf) + ' CHF');

    const inputEvidence = assessments.map((a) => ({
      id: a.id,
      type: a.ref?.type ?? 'unknown',
      source: a.ref?.source ?? 'unknown',
      observedAt: a.ref?.observedAt ?? '',
      availableAt: a.ref?.availableAt ?? '',
      status: a.status,
      version: evidence.version(a.id) ?? null,
    }));
    const security = { quarantinedEvidence: quarantined.map((q) => ({ evidenceId: q.evidenceId, rules: q.flags.map((f) => f.rule) })) };
    await emit('TASK_CREATED', {
      task,
      plannedTask,
      question: request.question,
      plan,
      inputs: { evidence: inputEvidence, excludedLookAhead, capitalStateTimestamp: c.timestamp, capitalStateRef, capitalEvidenceId },
      potentialCapitalImpactChf,
      opportunity: opportunity ? { id: opportunity.id, type: opportunity.type, bucket: opportunity.bucket, status: opportunity.status } : null,
      security,
      evidenceReferences: { lineage: evidenceValidation.lineage, warnings: evidenceValidation.warnings },
    });

    let quantResultRef: string | undefined;
    if (request.quant) {
      quantResultRef = await emit('QUANT_RESULT', request.quant, { kind: 'quant', id: 'quant-input' });
      if (request.quant.status !== 'not_available' && request.quant.evidenceRefId) {
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
    }

    // 4. Run the council (routing and critic engagement are audited before any model call).
    const execution = await this.taskManager.execute(
      { task: plannedTask, plan, question: request.question, asOf, capital: capitalContext, untrusted, timeoutMs: this.deps.modelTimeoutMs ?? task.maximumLatencyMs ?? 30_000 },
      {
        onStepRouted: async (step, routing) => {
          await emit('MODEL_SELECTED', {
            stepId: step.id,
            role: step.role,
            primaries: routing.primaries.map((p) => p.modelKey),
            fallbacks: routing.fallbacks,
            shadow: routing.shadow,
            rejected: routing.rejected,
            satisfied: routing.satisfied,
          });
          if (step.role !== 'analyst') await emit('CRITIC_STARTED', { stepId: step.id, role: step.role, models: routing.primaries.map((p) => p.modelKey) });
        },
      },
    );
    const modelRuns: string[] = [];
    const attempts: AttemptRecord[] = [];
    for (const attempt of execution.attempts) {
      const calibration = attempt.opinion ? calibrate(attempt.opinion.confidence, this.deps.calibration ?? null) : null;
      const runId = nextEventId('MODEL_RESPONSE_RECEIVED');
      const run: AttemptRecord = {
        ...attempt,
        runId,
        confidenceScore: calibration?.confidenceScore ?? null,
        calibratedProbability: calibration?.calibratedProbability ?? null,
        calibrationMethod: calibration?.calibrationMethod ?? null,
      };
      await emit('MODEL_RESPONSE_RECEIVED', run, { kind: 'model', id: attempt.modelKey }, runId);
      modelRuns.push(runId);
      attempts.push(run);
    }
    for (const entry of blackboard.entries(task.id)) {
      await emit('BLACKBOARD_ENTRY', {
        entryId: entry.id,
        author: entry.author,
        requestedCategory: entry.requestedCategory,
        category: entry.category,
        evidenceStatus: entry.evidenceStatus,
        evidenceRefs: entry.evidenceRefs,
        ...(entry.downgradeReason !== undefined ? { downgradeReason: entry.downgradeReason } : {}),
      });
    }

    // 5. Critic findings and consensus.
    const valid = attempts.filter((a) => a.status === 'ok' && !a.shadow && a.opinion);
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
    const consensusRef = await emit('CONSENSUS_CREATED', { consensus, findings });

    // 6. Risk and capital authority: amounts come from the Capital Engine + allocation policy, never from a model.
    let capital: CapitalDecision | null = null;
    const risk = { passed: true, reasons: [] as string[] };
    const approvalReasons: string[] = [];
    let riskDecisionRef: string | undefined;
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
      riskDecisionRef = await emit('RISK_DECISION', { risk, capitalGate: gate });
      await emit('CAPITAL_PROPOSAL', { capital, capitalStateRef, allocationId: allocation.id });
    }

    // 7. Outcome, approval, execution gate.
    let outcome: DecisionOutcome;
    if (!opportunity) outcome = 'ANALYSIS_ONLY';
    else outcome = consensus.execution === 'PROCEED_TO_RISK' && consensus.recommendation === 'buy' && risk.passed && (capital?.recommendedChf ?? 0n) > 0n ? 'RECOMMEND' : 'NO_ACTION';
    const requiresHumanApproval = outcome === 'RECOMMEND' && approvalReasons.length > 0;
    const execGate = executionGate({ outcome, bucket: opportunity?.bucket ?? null, safety: this.deps.safety });
    const reasons = [...new Set([...consensus.blockingReasons, ...(consensus.execution === 'PROCEED_TO_RISK' ? risk.reasons : [])])];
    const { finalAction, reasonCodes } = classify(outcome, consensus, risk, capital, requiresHumanApproval);

    let humanApprovalRef: string | undefined;
    if (requiresHumanApproval) humanApprovalRef = await emit('HUMAN_APPROVAL', { required: true, status: 'pending', reasons: approvalReasons });

    const decision: NexusDecision = {
      decisionId,
      taskId: task.id,
      asOf,
      outcome,
      finalAction,
      reasonCodes,
      potentialCapitalImpactChf,
      capitalStateRef,
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
      evidence: { lineage: evidenceValidation.lineage, warnings: evidenceValidation.warnings },
    };
    await emit('DECISION_RECORDED', decision);

    // 8. Normalized decision record (identities + references) and failure memory.
    const inputFingerprint = hashOf({
      task: plannedTask,
      question: request.question,
      asOf,
      evidence: inputEvidence.map((e) => ({ id: e.id, version: e.version, status: e.status })),
      capitalStateRef,
      quant: request.quant ?? null,
      evidenceLineage: evidenceValidation.lineage,
      opportunity: opportunity
        ? { id: opportunity.id, type: opportunity.type, requiredCapitalChf: opportunity.requiredCapitalChf, sizing: opportunity.sizing, expectedNetProfitChf: opportunity.expectedNetProfitChf, downsideChf: opportunity.downsideChf, scores: opportunity.scores }
        : null,
      prompts: Object.values(PROMPT_TEMPLATES).map((p) => p.id + '@' + p.version),
      allocationPolicy: this.allocationPolicy,
    });
    const record: DecisionRecord = {
      decisionId,
      taskId: task.id,
      createdAt: this.deps.clock().toISOString(),
      asOf,
      inputFingerprint,
      evidenceRefs: [capitalEvidenceId, ...assessments.filter((a) => a.status !== 'unknown' && a.status !== 'not_yet_available').map((a) => a.id)],
      modelRuns,
      ...(quantResultRef !== undefined ? { quantResultRef } : {}),
      consensusRef,
      ...(riskDecisionRef !== undefined ? { riskDecisionRef } : {}),
      capitalStateRef,
      ...(humanApprovalRef !== undefined ? { humanApprovalRef } : {}),
      finalAction,
      reasonCodes,
    };
    await this.deps.decisions.save(record);

    let n = 0;
    for (const attempt of attempts.filter((a) => a.status !== 'ok')) {
      await memory.remember({
        id: decisionId + ':failure:' + ++n,
        kind: 'failure',
        subject: attempt.modelKey,
        tags: ['status:' + attempt.status, 'step:' + attempt.stepId],
        content: { decisionId, runId: attempt.runId ?? null, stepId: attempt.stepId, status: attempt.status, error: attempt.error ?? null, fallbackFor: attempt.fallbackFor ?? null },
        occurredAt: asOf,
        availableAt: asOf,
        source: 'ai-council',
      });
    }
    return deepFreeze(decision);
  }

  /** The normalized decision record. */
  record(decisionId: string): DecisionRecord | undefined {
    return this.deps.decisions.get(decisionId);
  }

  /** Full reconstruction of a decision from its DecisionRecord and audit events. */
  trace(decisionId: string): DecisionTrace | undefined {
    const record = this.deps.decisions.get(decisionId);
    if (!record) return undefined;
    const events = this.deps.audit.byDecision(decisionId);
    const one = <P>(type: AuditEventType): P | undefined => events.find((e) => e.type === type)?.payload as P | undefined;
    const all = <P>(type: AuditEventType): P[] => events.filter((e) => e.type === type).map((e) => e.payload as P);
    const created = one<{ task: AiTask; question: string; plan: TaskPlan; inputs: Omit<DecisionTrace['inputs'], 'quant' | 'evidenceLineage'>; security: DecisionTrace['security']; evidenceReferences: Pick<EvidenceValidation, 'lineage' | 'warnings'> }>('TASK_CREATED');
    const decision = one<NexusDecision>('DECISION_RECORDED');
    if (!created || !decision) throw new NexusBrainError('incomplete audit trail for ' + decisionId);
    const risk = one<{ risk: DecisionTrace['risk'] }>('RISK_DECISION');
    const approval = one<{ reasons: string[] }>('HUMAN_APPROVAL');
    return {
      record,
      decision,
      task: created.task,
      question: created.question,
      plan: created.plan,
      inputs: { ...created.inputs, quant: one<QuantAssessment>('QUANT_RESULT') ?? null, evidenceLineage: created.evidenceReferences.lineage },
      routing: all<DecisionTrace['routing'][number]>('MODEL_SELECTED').map((r) => ({ stepId: r.stepId, primaries: r.primaries, fallbacks: r.fallbacks, shadow: r.shadow, rejected: r.rejected })),
      attempts: all<AttemptRecord>('MODEL_RESPONSE_RECEIVED'),
      blackboardEntryIds: all<{ entryId: string }>('BLACKBOARD_ENTRY').map((e) => e.entryId),
      criticFindings: one<{ findings: AuthoredRiskFlag[] }>('CONSENSUS_CREATED')?.findings ?? [],
      risk: risk?.risk ?? { passed: true, reasons: [] },
      humanApproval: approval ? { required: true, status: 'pending', reasons: approval.reasons } : { required: false, status: 'not_required', reasons: [] },
      security: created.security,
    };
  }

  private validate(request: DecisionRequest): void {
    const { task } = request;
    if (!DOMAINS.includes(task.domain)) throw new NexusBrainError('unknown domain ' + task.domain);
    if (!SUBTASKS.includes(task.subtask)) throw new NexusBrainError('unknown subtask ' + task.subtask);
    if (request.question.trim() === '') throw new NexusBrainError('question is required');
    if (Number.isNaN(Date.parse(request.asOf))) throw new NexusBrainError('asOf must be an ISO timestamp');
    if (task.capitalAtRiskMinor !== undefined && task.capitalAtRiskMinor < 0n) throw new NexusBrainError('capitalAtRiskMinor must not be negative');
    const quant = request.quant;
    if (quant?.quantRunId !== undefined && !/^qr_[0-9a-f]{40}$/.test(quant.quantRunId)) throw new NexusBrainError('invalid quantRunId');
    if (quant?.scannerRunId !== undefined && !/^scan_[0-9a-f]{40}$/.test(quant.scannerRunId)) throw new NexusBrainError('invalid scannerRunId');
    if (quant?.backtestRunIds !== undefined) {
      if (quant.backtestRunIds.some((id) => !/^bt_[0-9a-f]{40}$/.test(id))) throw new NexusBrainError('invalid backtestRunId');
      if (new Set(quant.backtestRunIds).size !== quant.backtestRunIds.length) throw new NexusBrainError('duplicate backtestRunId');
    }
    if (this.deps.blackboard.entries(task.id).length > 0) throw new NexusBrainError('task ' + task.id + ' already ran a decision cycle; use a new task id');
  }
}

/** Maps the decision to the persisted action class and machine-readable reason codes. */
function classify(
  outcome: DecisionOutcome,
  consensus: ConsensusResult,
  risk: { passed: boolean },
  capital: CapitalDecision | null,
  requiresHumanApproval: boolean,
): { finalAction: FinalAction; reasonCodes: string[] } {
  const codes = new Set(consensus.blockingCodes);
  if (outcome === 'ANALYSIS_ONLY') return { finalAction: 'NO_ACTION', reasonCodes: [...codes, 'ANALYSIS_ONLY'] };
  if (outcome === 'RECOMMEND') return { finalAction: 'RECOMMEND', reasonCodes: requiresHumanApproval ? ['HUMAN_APPROVAL_REQUIRED'] : [] };
  if (consensus.execution === 'PROCEED_TO_RISK' && !risk.passed) {
    codes.add('RISK_REJECTED');
    if (capital && capital.maxAllowedChf === ZERO_CHF) codes.add('NO_CAPITAL_ALLOCATABLE');
    return { finalAction: 'REJECT', reasonCodes: [...codes] };
  }
  const clearView = consensus.direction === 'bullish' || consensus.direction === 'bearish';
  const hardStop = ['INSUFFICIENT_ANALYSIS', 'CONTRADICTION_DIRECTION', 'PROMPT_INJECTION_SUSPECTED', 'NO_UNANIMOUS_ACTION'].some((code) => codes.has(code));
  return { finalAction: clearView && !hardStop ? 'WATCH' : 'NO_ACTION', reasonCodes: [...codes] };
}
