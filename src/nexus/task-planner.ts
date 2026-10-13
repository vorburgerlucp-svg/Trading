// Planner: decides how deep a decision must be analysed and how the council collaborates.
// Depth = max(importance level, capital-at-risk level, independence need) + uncertainty/conflict bumps.
//
//   single              1 analyst
//   reviewed            1 analyst → critic                               (sequential)
//   committee           2 independent analysts (≥2 providers) → critic   (parallel, then review)
//   critical_committee  3 independent analysts (≥2 providers) + independent counter-analysis
//                       → critic; unanimity, strict risk, human approval

import { chf, type Rappen } from '../money/money.js';
import { DEPTH_ORDER, type AiTask, type DecisionDepth, type PlanStep, type TaskPlan } from './nexus-types.js';

export interface PlannerConfig {
  /** Capital at risk from which a depth level is required at minimum. */
  capitalThresholdsChf: { reviewed: Rappen; committee: Rappen; critical: Rappen };
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = Object.freeze({
  capitalThresholdsChf: Object.freeze({ reviewed: chf(100), committee: chf(1000), critical: chf(10_000) }),
});

const IMPORTANCE_LEVEL = { low: 0, medium: 1, high: 2, critical: 3 } as const;

export function decideDepth(task: AiTask, config: PlannerConfig = DEFAULT_PLANNER_CONFIG): { depth: DecisionDepth; reasons: string[] } {
  const reasons: string[] = [];
  const t = config.capitalThresholdsChf;
  const capital = task.capitalAtRiskMinor ?? 0n;
  const capitalLevel = capital >= t.critical ? 3 : capital >= t.committee ? 2 : capital >= t.reviewed ? 1 : 0;
  let level = Math.max(IMPORTANCE_LEVEL[task.importance], capitalLevel);
  reasons.push('importance ' + task.importance + ' → ' + DEPTH_ORDER[IMPORTANCE_LEVEL[task.importance]]);
  if (capitalLevel > 0) reasons.push('capital at risk ' + capital + ' Rappen → at least ' + DEPTH_ORDER[capitalLevel]);
  if (task.requiresIndependentOpinions && level < 2) {
    level = 2;
    reasons.push('independent opinions required → committee');
  }
  if (task.uncertainty === 'high') {
    level += 1;
    reasons.push('high uncertainty → one level deeper');
  }
  if (task.conflictingData) {
    level += 1;
    reasons.push('conflicting data → one level deeper');
  }
  const depth = DEPTH_ORDER[Math.min(3, level)] as DecisionDepth;
  return { depth, reasons };
}

export function planTask(task: AiTask, config: PlannerConfig = DEFAULT_PLANNER_CONFIG): TaskPlan {
  const { depth, reasons } = decideDepth(task, config);
  const analyst = (id: string, subtask: PlanStep['subtask'], models: number, minDistinctProviders: number, isolation: PlanStep['isolation']): PlanStep => ({
    id,
    role: 'analyst',
    subtask,
    models,
    minDistinctProviders,
    isolation,
  });
  const critic: PlanStep = { id: 'critic', role: 'critic', subtask: 'risk_review', models: 1, minDistinctProviders: 1, isolation: 'sees_prior_steps' };

  let steps: PlanStep[];
  let mode: TaskPlan['mode'];
  const pipeline = task.pipeline ?? [];

  if ((depth === 'single' || depth === 'reviewed') && pipeline.length > 0) {
    // Division of labour: each step builds on the previous ones.
    steps = pipeline.map((subtask, i) => analyst('pipeline-' + (i + 1) + '-' + subtask, subtask, 1, 1, i === 0 ? 'independent' : 'sees_prior_steps'));
    if (depth === 'reviewed') steps.push(critic);
    mode = 'sequential';
    reasons.push('pipeline of ' + pipeline.length + ' specialists (sequential)');
  } else if (depth === 'single') {
    steps = [analyst('analysts', task.subtask, 1, 1, 'independent')];
    mode = 'sequential';
  } else if (depth === 'reviewed') {
    steps = [analyst('analysts', task.subtask, 1, 1, 'independent'), critic];
    mode = 'sequential';
  } else if (depth === 'committee') {
    steps = [analyst('analysts', task.subtask, 2, 2, 'independent'), critic];
    mode = 'parallel';
    if (pipeline.length > 0) reasons.push('pipeline ignored: committee depth requires independent parallel opinions');
  } else {
    steps = [
      analyst('analysts', task.subtask, 3, 2, 'independent'),
      { id: 'counter-analysis', role: 'counter_analyst', subtask: 'bear_case', models: 1, minDistinctProviders: 1, isolation: 'independent' },
      critic,
    ];
    mode = 'parallel';
    if (pipeline.length > 0) reasons.push('pipeline ignored: critical depth requires independent parallel opinions');
  }

  const voting = steps.filter((s) => s.role === 'analyst');
  return {
    taskId: task.id,
    depth,
    mode,
    steps,
    minIndependentOpinions: mode === 'parallel' ? (voting[0]?.models ?? 1) : 1,
    requiresCritic: steps.some((s) => s.role === 'critic'),
    requiresCounterAnalysis: steps.some((s) => s.role === 'counter_analyst'),
    requiresHumanApproval: depth === 'critical_committee',
    requireUnanimity: true,
    strictRisk: depth === 'critical_committee',
    reasons,
  };
}
