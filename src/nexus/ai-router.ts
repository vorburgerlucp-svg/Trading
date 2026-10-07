// AI Router: picks models for one plan step from measurable criteria.
//
// Hard filters: enabled, not in shadow mode, adapter connected, circuit not open, failure rate,
// required capabilities (structured output always), latency limit, cost budget (unknown cost is
// rejected when a budget is set, because the budget could not be guaranteed).
//
// Score (weights shift with stakes: the more capital/importance, the less cost and latency matter):
//   w_perf * measured performance (domain+subtask, else domain, else neutral prior)
// + w_rel  * (1 - failure rate)
// - w_cost * relative cost  - w_lat * relative latency
//
// Selection: the domain champion leads analyst steps if eligible; then distinct providers first
// (independence), then best remaining. Shadow models are returned separately: they analyse the same
// case for benchmarking but never count.

import type { ChampionBoard } from '../ai/champion-challenger.js';
import type { AdapterMap } from '../ai/model-adapter.js';
import type { ModelPerformance } from '../ai/model-performance.js';
import type { ModelRegistry, ModelRegistryEntry } from '../ai/model-registry.js';
import { modelKey, type ModelCapability, type ModelKey } from '../ai/model-types.js';
import { rappen, type Rappen } from '../money/money.js';
import type { AiTask, Importance, PlanStep } from './nexus-types.js';

export interface RouterConfig {
  maxConsecutiveFailures: number;
  maxFailureRate: number;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = Object.freeze({ maxConsecutiveFailures: 3, maxFailureRate: 0.5 });

const STAKES_WEIGHTS: Record<Importance, { performance: number; reliability: number; cost: number; latency: number }> = {
  low: { performance: 0.4, reliability: 0.2, cost: 0.3, latency: 0.1 },
  medium: { performance: 0.5, reliability: 0.25, cost: 0.15, latency: 0.1 },
  high: { performance: 0.6, reliability: 0.3, cost: 0.05, latency: 0.05 },
  critical: { performance: 0.65, reliability: 0.35, cost: 0, latency: 0 },
};

export interface RouteRequest {
  task: AiTask;
  step: PlanStep;
  asOf: string;
  /** Effective stakes (max of task importance and planned depth). */
  stakes: Importance;
  /** Hard exclusion. */
  exclude?: readonly ModelKey[];
  /** Soft: used only if nothing else fits (e.g. the critic should not be one of the analysts). */
  preferAvoid?: readonly ModelKey[];
  remainingBudgetMinor?: Rappen;
}

export interface RoutedModel {
  modelKey: ModelKey;
  provider: string;
  score: number;
  champion: boolean;
  measured: boolean;
}

export interface RoutingDecision {
  stepId: string;
  primaries: RoutedModel[];
  fallbacks: ModelKey[];
  shadow: ModelKey[];
  rejected: { modelKey: ModelKey; reasons: string[] }[];
  satisfied: boolean;
  estimatedCostMinor: Rappen;
  reasons: string[];
}

interface Candidate extends RoutedModel {
  entry: ModelRegistryEntry;
  cost: bigint | undefined;
}

export class AiRouter {
  constructor(
    private readonly registry: ModelRegistry,
    private readonly performance: ModelPerformance,
    private readonly champions: ChampionBoard,
    private readonly adapters: AdapterMap,
    readonly config: RouterConfig = DEFAULT_ROUTER_CONFIG,
  ) {}

  route(request: RouteRequest): RoutingDecision {
    const { task, step, asOf } = request;
    const required = new Set<ModelCapability>(['structured_output', ...task.requiredCapabilities]);
    const rejected: RoutingDecision['rejected'] = [];
    const shadow: ModelKey[] = [];
    const eligible: Candidate[] = [];
    const champion = step.role === 'analyst' ? this.champions.champion(task.domain) : undefined;

    for (const entry of this.registry.list()) {
      const key = modelKey(entry.provider, entry.model);
      const reasons = this.availabilityProblems(key, entry, required, task);
      if (request.exclude?.includes(key)) reasons.push('excluded for this step');
      if (entry.shadowMode) {
        if (reasons.length === 0 && step.role === 'analyst') shadow.push(key);
        rejected.push({ modelKey: key, reasons: ['shadow mode: analyses for benchmarking only', ...reasons] });
        continue;
      }
      if (request.remainingBudgetMinor !== undefined && entry.costEmaMinor === undefined) reasons.push('cost unknown, AI budget cannot be guaranteed');
      if (reasons.length > 0) {
        rejected.push({ modelKey: key, reasons });
        continue;
      }
      const perf = this.performance.published(key, task.domain, step.subtask, asOf) ?? this.performance.published(key, task.domain, undefined, asOf);
      eligible.push({
        modelKey: key,
        provider: entry.provider,
        entry,
        cost: entry.costEmaMinor,
        champion: key === champion,
        measured: perf !== null,
        score: perf?.score ?? this.performance.policy.priorScore,
      });
    }

    const w = STAKES_WEIGHTS[request.stakes];
    const maxCost = eligible.reduce((m, c) => (c.cost !== undefined && c.cost > m ? c.cost : m), 0n);
    const maxLatency = eligible.reduce((m, c) => Math.max(m, c.entry.latencyEmaMs ?? 0), 0);
    for (const c of eligible) {
      const perf = c.score;
      const reliability = 1 - (c.entry.failureRate ?? 0);
      const cost = maxCost > 0n && c.cost !== undefined ? Number(c.cost) / Number(maxCost) : 0;
      const latency = maxLatency > 0 ? (c.entry.latencyEmaMs ?? 0) / maxLatency : 0;
      c.score = round4(w.performance * perf + w.reliability * reliability - w.cost * cost - w.latency * latency);
    }

    const avoid = new Set(request.preferAvoid ?? []);
    const ordered = [...eligible].sort((a, b) => {
      if (a.champion !== b.champion) return a.champion ? -1 : 1;
      if (avoid.has(a.modelKey) !== avoid.has(b.modelKey)) return avoid.has(a.modelKey) ? 1 : -1;
      return b.score - a.score || (a.modelKey < b.modelKey ? -1 : 1);
    });

    const picks: Candidate[] = [];
    let spent = 0n;
    const fitsBudget = (c: Candidate) => request.remainingBudgetMinor === undefined || spent + (c.cost ?? 0n) <= request.remainingBudgetMinor;
    const take = (c: Candidate) => {
      picks.push(c);
      spent += c.cost ?? 0n;
    };
    for (const c of ordered) {
      if (picks.length >= step.models) break;
      if (!picks.some((p) => p.provider === c.provider) && fitsBudget(c)) take(c);
    }
    for (const c of ordered) {
      if (picks.length >= step.models) break;
      if (!picks.includes(c) && fitsBudget(c)) take(c);
    }

    const distinctProviders = new Set(picks.map((p) => p.provider)).size;
    const reasons: string[] = [];
    if (picks.length < step.models) reasons.push('only ' + picks.length + ' of ' + step.models + ' required models are available within constraints');
    if (distinctProviders < step.minDistinctProviders) reasons.push('only ' + distinctProviders + ' distinct providers, ' + step.minDistinctProviders + ' required for independence');

    return {
      stepId: step.id,
      primaries: picks.map(({ modelKey: k, provider, score, champion: ch, measured }) => ({ modelKey: k, provider, score, champion: ch, measured })),
      fallbacks: ordered.filter((c) => !picks.includes(c)).map((c) => c.modelKey),
      shadow,
      rejected,
      satisfied: reasons.length === 0,
      estimatedCostMinor: rappen(spent),
      reasons,
    };
  }

  private availabilityProblems(key: ModelKey, entry: ModelRegistryEntry, required: Set<ModelCapability>, task: AiTask): string[] {
    const reasons: string[] = [];
    if (!entry.enabled) reasons.push('disabled');
    const adapter = this.adapters.get(key);
    if (!adapter || adapter.connection() !== 'connected') reasons.push('adapter not connected');
    const health = this.registry.health(key);
    if (health.consecutiveFailures >= this.config.maxConsecutiveFailures) reasons.push('circuit open after ' + health.consecutiveFailures + ' consecutive failures');
    if ((entry.failureRate ?? 0) > this.config.maxFailureRate) reasons.push('failure rate ' + (entry.failureRate ?? 0).toFixed(2) + ' above ' + this.config.maxFailureRate);
    const missing = [...required].filter((c) => !entry.capabilities.includes(c));
    if (missing.length > 0) reasons.push('missing capabilities: ' + missing.join(', '));
    if (task.maximumLatencyMs !== undefined && entry.latencyEmaMs !== undefined && entry.latencyEmaMs > task.maximumLatencyMs) {
      reasons.push('latency ' + Math.round(entry.latencyEmaMs) + ' ms above limit ' + task.maximumLatencyMs + ' ms');
    }
    return reasons;
  }
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
