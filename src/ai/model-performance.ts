// Model performance from evaluated outcomes, stored in NEXUS Memory (kind "model_performance").
//
// Controlled learning:
//  - a score is only PUBLISHED (used by the router, written to the registry) once the sample size
//    reaches minSamplesForScore; a single result never changes routing
//  - published scores are shrunk toward a neutral prior, so small samples cannot look extreme
//  - every query is point-in-time: observations count only once their outcome was known (availableAt)
//  - `storedThrough` (a memory position) additionally pins a query to what was stored at that moment,
//    so a past evaluation can be re-derived exactly even after outcomes were back-filled
//  - learning quarantine (R2): every observation carries the scoring method that produced it (no label = outcome-eval:v1, the
//    observations written before R2). Only ACCEPTED methods reach stats(), published(), the router, the registry and the
//    champion-challenger; any other method (outcome-eval:v2 until it is validated and a human accepts it) is stored and can be
//    analysed through quarantinedObservations(), but influences nothing

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
  /** The scoring method that produced `score`. Absent: outcome-eval:v1 (every observation written before R2). */
  scoringMethod?: string;
}

export interface PerformancePolicy {
  minSamplesForScore: number;
  priorScore: number;
  priorWeight: number;
  /**
   * Scoring methods whose observations may influence anything (stats, published scores, router, registry, champions).
   * Absent: ACCEPTED_SCORING_METHODS_DEFAULT (v1 only). Adding a method is a human decision after its validation.
   */
  acceptedScoringMethods?: readonly string[];
}

/** The scoring method of observations without a label (all observations written before R2). */
export const LEGACY_SCORING_METHOD = 'outcome-eval:v1';
/**
 * The methods accepted when a policy names none: v1 only, exactly the behaviour before R2. outcome-eval:v2 is deliberately
 * NOT in this list (learning quarantine): it needs an independent validation and an explicit human decision first.
 */
export const ACCEPTED_SCORING_METHODS_DEFAULT: readonly string[] = Object.freeze([LEGACY_SCORING_METHOD]);
const SCORING_METHOD = /^outcome-eval:v[0-9]{1,3}$/;

export function scoringMethodOf(observation: Pick<PerformanceObservation, 'scoringMethod'>): string {
  return observation.scoringMethod ?? LEGACY_SCORING_METHOD;
}

export const DEFAULT_PERFORMANCE_POLICY: PerformancePolicy = Object.freeze({ minSamplesForScore: 20, priorScore: 0.5, priorWeight: 10 });

export interface PerformanceStats {
  sampleSize: number;
  mean: number | null;
  /** (priorWeight * prior + sum) / (priorWeight + n) */
  shrunk: number;
}

export interface PerformanceFilter {
  domain?: Domain;
  subtask?: Subtask;
  /** Memory position bound (see ModelPerformance.position). */
  storedThrough?: number;
}

export class ModelPerformance {
  constructor(
    private readonly memory: NexusMemory,
    readonly policy: PerformancePolicy = DEFAULT_PERFORMANCE_POLICY,
  ) {}

  /** Catches up with observations written by other NEXUS processes. */
  sync(): Promise<void> {
    return this.memory.sync();
  }

  /** Current memory position; pass it as `storedThrough` to make a query reproducible later. */
  position(): number {
    return this.memory.position;
  }

  /** The methods whose observations count (see PerformancePolicy.acceptedScoringMethods). */
  acceptedScoringMethods(): readonly string[] {
    return this.policy.acceptedScoringMethods ?? ACCEPTED_SCORING_METHODS_DEFAULT;
  }

  async record(id: string, observation: PerformanceObservation): Promise<void> {
    if (!(observation.score >= 0 && observation.score <= 1)) throw new Error('performance score must be within 0..1');
    if (observation.scoringMethod !== undefined && !SCORING_METHOD.test(observation.scoringMethod)) throw new Error('scoringMethod must be outcome-eval:v<N>');
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

  /** Observations of ACCEPTED scoring methods only: the only ones any score, routing or champion decision is built from. */
  observations(key: ModelKey, asOf: string, filter: PerformanceFilter = {}): PerformanceObservation[] {
    const accepted = this.acceptedScoringMethods();
    return this.allObservations(key, asOf, filter).filter((o) => accepted.includes(scoringMethodOf(o)));
  }

  /** ANALYSIS ONLY: observations of methods that are not accepted (quarantined). Nothing in routing or promotion reads this. */
  quarantinedObservations(key: ModelKey, asOf: string, filter: PerformanceFilter = {}): PerformanceObservation[] {
    const accepted = this.acceptedScoringMethods();
    return this.allObservations(key, asOf, filter).filter((o) => !accepted.includes(scoringMethodOf(o)));
  }

  private allObservations(key: ModelKey, asOf: string, filter: PerformanceFilter): PerformanceObservation[] {
    const tags = [...(filter.domain ? ['domain:' + filter.domain] : []), ...(filter.subtask ? ['subtask:' + filter.subtask] : [])];
    const bound = filter.storedThrough === undefined ? {} : { storedThrough: filter.storedThrough };
    return this.memory.recall<PerformanceObservation>({ kind: 'model_performance', subject: key, tags, asOf, ...bound }).map((r) => r.content);
  }

  stats(key: ModelKey, asOf: string, filter: PerformanceFilter = {}): PerformanceStats {
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
  published(key: ModelKey, domain: Domain, subtask: Subtask | undefined, asOf: string, storedThrough?: number): ModelCapabilityScore | null {
    const stats = this.stats(key, asOf, {
      domain,
      ...(subtask !== undefined ? { subtask } : {}),
      ...(storedThrough !== undefined ? { storedThrough } : {}),
    });
    if (stats.sampleSize < this.policy.minSamplesForScore) return null;
    return { domain, ...(subtask !== undefined ? { subtask } : {}), sampleSize: stats.sampleSize, score: stats.shrunk, updatedAt: asOf };
  }

  /** Writes all publishable scores into the registry (the only path by which registry scores change). */
  async syncRegistry(registry: ModelRegistry, asOf: string): Promise<void> {
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
      if (scores.length > 0) await registry.setDomainScores(key, scores, asOf);
    }
  }
}
