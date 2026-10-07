// Model performance from evaluated outcomes, stored in NEXUS Memory (kind "model_performance").
//
// Controlled learning:
//  - a score is only PUBLISHED (used by the router, written to the registry) once the sample size
//    reaches minSamplesForScore; a single result never changes routing
//  - published scores are shrunk toward a neutral prior, so small samples cannot look extreme
//  - every query is point-in-time: observations count only once their outcome was known (availableAt)

import type { NexusMemory } from '../memory/nexus-memory.js';
import type { ModelCapabilityScore, ModelRegistry } from './model-registry.js';
import type { CouncilRole, Domain, ModelKey, Subtask } from './model-types.js';

export interface PerformanceObservation {
  modelKey: ModelKey;
  domain: Domain;
  subtask: Subtask;
  role: CouncilRole;
  decisionId: string;
  /** 0..1 outcome-based score from the OutcomeEvaluator. */
  score: number;
  shadow: boolean;
  /** Decision time. */
  occurredAt: string;
  /** Time the outcome became known. */
  availableAt: string;
}

export interface PerformancePolicy {
  minSamplesForScore: number;
  priorScore: number;
  priorWeight: number;
}

export const DEFAULT_PERFORMANCE_POLICY: PerformancePolicy = Object.freeze({ minSamplesForScore: 20, priorScore: 0.5, priorWeight: 10 });

export interface PerformanceStats {
  sampleSize: number;
  mean: number | null;
  /** (priorWeight * prior + sum) / (priorWeight + n) */
  shrunk: number;
}

export class ModelPerformance {
  constructor(
    private readonly memory: NexusMemory,
    readonly policy: PerformancePolicy = DEFAULT_PERFORMANCE_POLICY,
  ) {}

  async record(id: string, observation: PerformanceObservation): Promise<void> {
    if (!(observation.score >= 0 && observation.score <= 1)) throw new Error('performance score must be within 0..1');
    await this.memory.remember({
      id,
      kind: 'model_performance',
      subject: observation.modelKey,
      tags: ['domain:' + observation.domain, 'subtask:' + observation.subtask, 'role:' + observation.role],
      content: observation,
      occurredAt: observation.occurredAt,
      availableAt: observation.availableAt,
      source: 'outcome-evaluator',
    });
  }

  observations(key: ModelKey, asOf: string, filter: { domain?: Domain; subtask?: Subtask } = {}): PerformanceObservation[] {
    const tags = [...(filter.domain ? ['domain:' + filter.domain] : []), ...(filter.subtask ? ['subtask:' + filter.subtask] : [])];
    return this.memory.recall<PerformanceObservation>({ kind: 'model_performance', subject: key, tags, asOf }).map((r) => r.content);
  }

  stats(key: ModelKey, asOf: string, filter: { domain?: Domain; subtask?: Subtask } = {}): PerformanceStats {
    const scores = this.observations(key, asOf, filter).map((o) => o.score);
    const sum = scores.reduce((s, x) => s + x, 0);
    const { priorScore, priorWeight } = this.policy;
    return {
      sampleSize: scores.length,
      mean: scores.length === 0 ? null : sum / scores.length,
      shrunk: (priorWeight * priorScore + sum) / (priorWeight + scores.length),
    };
  }

  /** Published score, or null while the sample is too small to be trusted. */
  published(key: ModelKey, domain: Domain, subtask: Subtask | undefined, asOf: string): ModelCapabilityScore | null {
    const stats = this.stats(key, asOf, subtask === undefined ? { domain } : { domain, subtask });
    if (stats.sampleSize < this.policy.minSamplesForScore) return null;
    return { domain, ...(subtask !== undefined ? { subtask } : {}), sampleSize: stats.sampleSize, score: stats.shrunk, updatedAt: asOf };
  }

  /** Writes all publishable scores into the registry (the only path by which registry scores change). */
  syncRegistry(registry: ModelRegistry, asOf: string): void {
    for (const entry of registry.list()) {
      const key = entry.provider + '/' + entry.model;
      const seen = new Map<string, { domain: Domain; subtask?: Subtask }>();
      for (const o of this.observations(key, asOf)) {
        seen.set(o.domain, { domain: o.domain });
        seen.set(o.domain + '|' + o.subtask, { domain: o.domain, subtask: o.subtask });
      }
      const scores = [...seen.values()]
        .map((s) => this.published(key, s.domain, s.subtask, asOf))
        .filter((s): s is ModelCapabilityScore => s !== null);
      if (scores.length > 0) registry.setDomainScores(key, scores, asOf);
    }
  }
}
