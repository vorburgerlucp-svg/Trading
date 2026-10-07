// Champion / Challenger per domain.
// Initial champions are configured preferences ("OpenAI for crypto" may be a starting point, never a
// rule). A challenger replaces the champion only with a large enough sample AND a clear score margin,
// measured point-in-time. Shadow models must first be benchmarked and activated by a human.

import type { Actor } from '../opportunities/opportunity-types.js';
import type { ModelPerformance } from './model-performance.js';
import type { ModelRegistry } from './model-registry.js';
import { modelKey, type Domain, type ModelKey } from './model-types.js';

export interface ChampionPolicy {
  minSamplesForChampion: number;
  minScoreMargin: number;
  minSamplesToLeaveShadow: number;
  minScoreToLeaveShadow: number;
}

export const DEFAULT_CHAMPION_POLICY: ChampionPolicy = Object.freeze({
  minSamplesForChampion: 50,
  minScoreMargin: 0.05,
  minSamplesToLeaveShadow: 30,
  minScoreToLeaveShadow: 0.5,
});

export interface PromotionDecision {
  domain: Domain;
  evaluatedAt: string;
  currentChampion: ModelKey | null;
  candidate: ModelKey | null;
  promote: boolean;
  championScore: number;
  candidateScore: number | null;
  reasons: string[];
}

export interface ChampionChange {
  domain: Domain;
  from: ModelKey | null;
  to: ModelKey;
  at: string;
  by: Actor;
  reason: string;
}

export class ChampionBoard {
  private readonly champions = new Map<Domain, ModelKey>();
  private readonly changeLog: ChampionChange[] = [];

  constructor(
    initialChampions: Partial<Record<Domain, ModelKey>> = {},
    readonly policy: ChampionPolicy = DEFAULT_CHAMPION_POLICY,
  ) {
    for (const [domain, key] of Object.entries(initialChampions) as [Domain, ModelKey][]) this.champions.set(domain, key);
  }

  champion(domain: Domain): ModelKey | undefined {
    return this.champions.get(domain);
  }

  history(): readonly ChampionChange[] {
    return [...this.changeLog];
  }

  /** Compares the champion with active challengers on published, point-in-time scores. */
  evaluate(domain: Domain, registry: ModelRegistry, performance: ModelPerformance, asOf: string): PromotionDecision {
    const current = this.champions.get(domain) ?? null;
    const championScore = current === null ? performance.policy.priorScore : (performance.published(current, domain, undefined, asOf)?.score ?? performance.policy.priorScore);
    const reasons: string[] = [];
    let best: { key: ModelKey; score: number } | null = null;

    for (const entry of registry.list()) {
      const key = modelKey(entry.provider, entry.model);
      if (key === current || !entry.enabled) continue;
      const stats = performance.stats(key, asOf, { domain });
      if (entry.shadowMode) {
        reasons.push(key + ': in shadow mode, needs benchmark gate and human activation first');
        continue;
      }
      if (stats.sampleSize < this.policy.minSamplesForChampion) {
        reasons.push(key + ': ' + stats.sampleSize + ' samples < ' + this.policy.minSamplesForChampion + ' required');
        continue;
      }
      const published = performance.published(key, domain, undefined, asOf);
      if (published && (best === null || published.score > best.score)) best = { key, score: published.score };
    }

    const promote = best !== null && best.score >= championScore + this.policy.minScoreMargin;
    if (best !== null && !promote) reasons.push(best.key + ': score ' + best.score.toFixed(3) + ' does not beat champion ' + championScore.toFixed(3) + ' by ' + this.policy.minScoreMargin);
    if (promote && best) reasons.push(best.key + ': score ' + best.score.toFixed(3) + ' beats champion ' + championScore.toFixed(3) + ' by at least ' + this.policy.minScoreMargin);
    return { domain, evaluatedAt: asOf, currentChampion: current, candidate: best?.key ?? null, promote, championScore, candidateScore: best?.score ?? null, reasons };
  }

  apply(decision: PromotionDecision, by: Actor): void {
    if (!decision.promote || decision.candidate === null) throw new Error('promotion decision does not promote anyone');
    this.changeLog.push({ domain: decision.domain, from: decision.currentChampion, to: decision.candidate, at: decision.evaluatedAt, by, reason: decision.reasons.join('; ') });
    this.champions.set(decision.domain, decision.candidate);
  }
}

/** Benchmark gate for leaving shadow mode (the human activation itself happens in the registry). */
export function shadowExitGate(key: ModelKey, performance: ModelPerformance, asOf: string, policy: ChampionPolicy = DEFAULT_CHAMPION_POLICY): { passed: boolean; reasons: string[] } {
  const stats = performance.stats(key, asOf);
  const reasons: string[] = [];
  if (stats.sampleSize < policy.minSamplesToLeaveShadow) reasons.push(stats.sampleSize + ' benchmark samples < ' + policy.minSamplesToLeaveShadow);
  if (stats.shrunk < policy.minScoreToLeaveShadow) reasons.push('benchmark score ' + stats.shrunk.toFixed(3) + ' < ' + policy.minScoreToLeaveShadow);
  return { passed: reasons.length === 0, reasons };
}
