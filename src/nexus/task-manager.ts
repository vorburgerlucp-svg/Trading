// Task Manager: executes a TaskPlan step by step.
//  - routes each step (subtask-specific), builds the step context from the blackboard according to
//    the step's isolation, consults the council, and posts the structured results to the blackboard
//  - results are posted only after the whole step finished, so parallel members stay independent
//  - stops at the first step that cannot get enough valid answers (no decision without analysis)

import type { AiCouncil } from '../ai/ai-council.js';
import type { CapitalContext, ContextEntry, SpecialistRequest } from '../ai/model-adapter.js';
import type { ModelKey } from '../ai/model-types.js';
import { PROMPT_TEMPLATES } from '../ai/prompts.js';
import type { BlackboardEntry } from '../blackboard/blackboard-types.js';
import type { SharedBlackboard } from '../blackboard/shared-blackboard.js';
import type { EvidenceStore } from '../evidence/evidence-store.js';
import { rappen } from '../money/money.js';
import type { UntrustedBlock } from '../security/untrusted-input.js';
import type { AiRouter, RoutingDecision } from './ai-router.js';
import { DEPTH_ORDER, type AiTask, type AttemptRecord, type Importance, type PlanStep, type TaskPlan } from './nexus-types.js';

export interface StepExecution {
  step: PlanStep;
  routing: RoutingDecision;
  attempts: AttemptRecord[];
  successes: AttemptRecord[];
  satisfied: boolean;
}

export interface TaskExecution {
  steps: StepExecution[];
  attempts: AttemptRecord[];
  satisfied: boolean;
  insufficientReasons: string[];
}

export interface ExecuteInput {
  task: AiTask;
  plan: TaskPlan;
  question: string;
  asOf: string;
  capital: CapitalContext | null;
  untrusted: UntrustedBlock[];
  timeoutMs: number;
}

const IMPORTANCE_ORDER: readonly Importance[] = ['low', 'medium', 'high', 'critical'];

export class TaskManager {
  constructor(
    private readonly deps: { router: AiRouter; council: AiCouncil; blackboard: SharedBlackboard; evidence: EvidenceStore },
  ) {}

  async execute(input: ExecuteInput): Promise<TaskExecution> {
    const { task, plan, asOf } = input;
    // Stakes = max(task importance, planned depth): drives router weights (cost matters less as stakes rise).
    const stakes = IMPORTANCE_ORDER[Math.max(IMPORTANCE_ORDER.indexOf(task.importance), DEPTH_ORDER.indexOf(plan.depth))] ?? 'critical';
    const executed: StepExecution[] = [];
    const used: ModelKey[] = [];
    let spent = 0n;

    for (const step of plan.steps) {
      const remainingBudgetMinor = task.maximumAiCostMinor === undefined ? undefined : rappen(task.maximumAiCostMinor - spent);
      const routing = this.deps.router.route({
        task,
        step,
        asOf,
        stakes,
        ...(step.role === 'analyst' ? {} : { preferAvoid: used }),
        ...(remainingBudgetMinor !== undefined ? { remainingBudgetMinor } : {}),
      });
      spent += routing.estimatedCostMinor;

      const visibleSteps = step.isolation === 'independent' ? [] : executed.map((e) => e.step.id);
      const context = this.deps.blackboard.visibleTo(task.id, visibleSteps).map(toContextEntry);
      const template = PROMPT_TEMPLATES[step.role];
      const buildRequest = (requestId: string): SpecialistRequest => ({
        requestId,
        taskId: task.id,
        stepId: step.id,
        role: step.role,
        domain: task.domain,
        subtask: step.subtask,
        prompt: { id: template.id, version: template.version, instructions: template.instructions },
        question: input.question,
        context,
        capital: input.capital,
        untrusted: input.untrusted,
        outputSchema: 'nexus.opinion.v1',
        deadlineMs: input.timeoutMs,
      });

      const result = await this.deps.council.consult({
        step,
        primaries: routing.primaries.map((p) => p.modelKey),
        fallbacks: routing.fallbacks,
        shadow: routing.shadow,
        buildRequest,
        timeoutMs: input.timeoutMs,
      });
      for (const attempt of result.attempts) await this.postAttempt(task.id, attempt, asOf);
      used.push(...result.successes.map((s) => s.modelKey));

      const execution: StepExecution = { step, routing, attempts: result.attempts, successes: result.successes, satisfied: result.satisfied };
      executed.push(execution);
      if (!result.satisfied) {
        const reasons = [
          'step "' + step.id + '" (' + step.role + ') got ' + result.successes.length + ' of ' + step.models + ' required valid answers',
          ...routing.reasons,
        ];
        return { steps: executed, attempts: executed.flatMap((e) => e.attempts), satisfied: false, insufficientReasons: reasons };
      }
    }
    return { steps: executed, attempts: executed.flatMap((e) => e.attempts), satisfied: true, insufficientReasons: [] };
  }

  private async postAttempt(taskId: string, attempt: AttemptRecord, asOf: string): Promise<void> {
    if (attempt.status !== 'ok' || !attempt.opinion) return;
    const author = { type: 'model' as const, provider: attempt.provider, model: attempt.model, role: attempt.role, stepId: attempt.stepId, shadow: attempt.shadow };
    const opinion = attempt.opinion;
    await this.deps.blackboard.post(
      {
        taskId,
        author,
        category: 'recommendation',
        statement: 'stance ' + opinion.stance + ', recommends ' + opinion.recommendation + (opinion.suggestedCapitalChf !== null ? ' (suggests up to ' + opinion.suggestedCapitalChf + ' Rappen)' : ''),
        confidence: opinion.confidence,
        evidenceRefs: [],
      },
      asOf,
    );
    for (const claim of opinion.claims) {
      const refs = this.withoutLookAhead(claim.evidenceRefIds, asOf);
      await this.deps.blackboard.post(
        {
          taskId,
          author,
          category: refs.length < claim.evidenceRefIds.length ? 'hypothesis' : claim.category,
          statement: claim.statement + (refs.length < claim.evidenceRefIds.length ? ' [look-ahead references removed]' : ''),
          ...(claim.confidence !== undefined ? { confidence: claim.confidence } : {}),
          evidenceRefs: refs,
        },
        asOf,
      );
    }
    for (const flag of opinion.riskFlags) {
      await this.deps.blackboard.post(
        {
          taskId,
          author,
          category: attempt.role === 'critic' ? 'critique' : 'risk',
          statement: '[' + flag.severity + ' ' + flag.check + '] ' + flag.statement,
          evidenceRefs: this.withoutLookAhead(flag.evidenceRefIds, asOf),
        },
        asOf,
      );
    }
  }

  private withoutLookAhead(refs: readonly string[], asOf: string): string[] {
    return refs.filter((id) => this.deps.evidence.assess(id, asOf).status !== 'not_yet_available');
  }
}

export function toContextEntry(entry: BlackboardEntry): ContextEntry {
  return { id: entry.id, category: entry.category, statement: entry.statement, author: entry.author.type, evidenceStatus: entry.evidenceStatus, evidenceRefs: entry.evidenceRefs };
}

