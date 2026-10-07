// Champion / Challenger per domain.
// Initial champions are configured preferences (reviewed config, never the database): "OpenAI for
// crypto" may be a starting point, never a rule. A challenger replaces the champion only with a large
// enough sample AND a clear score margin, measured point-in-time.
//
// Promotions are persisted as events in a hash-chained log. On load (and on catch-up) every
// promotion is RE-VERIFIED against the measured performance at its evaluation time. A promotion
// written directly into the database without supporting measurements fails that check
// (GOVERNANCE_INTEGRITY_ERROR, fail closed): a DB change alone cannot make a model champion.

import { randomUUID } from 'node:crypto';
import type { Actor } from '../opportunities/opportunity-types.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore, type AppendOnlyStore } from '../persistence/append-only-log.js';
import type { ModelPerformance } from './model-performance.js';
import { GovernanceIntegrityError, type ModelRegistry } from './model-registry.js';
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

export interface ChampionEvent {
  type: 'promoted';
  eventId: string;
  domain: Domain;
  from: ModelKey | null;
  to: ModelKey;
  /** Evaluation time; the promotion is re-verified against performance known at this instant. */
  at: string;
  by: Actor;
  reason: string;
}

export class ChampionBoard {
  private readonly champions = new Map<Domain, ModelKey>();
  private readonly changeLog: ChampionChange[] = [];
  private log!: AppendOnlyLog<ChampionEvent>;

  private constructor(
    private readonly performance: ModelPerformance,
    readonly policy: ChampionPolicy,
    private readonly newId: () => string,
  ) {}

  static async open(options: {
    performance: ModelPerformance;
    initialChampions?: Partial<Record<Domain, ModelKey>>;
    store?: AppendOnlyStore<ChampionEvent>;
    policy?: ChampionPolicy;
    clock?: () => Date;
    newId?: () => string;
  }): Promise<ChampionBoard> {
    const board = new ChampionBoard(options.performance, options.policy ?? DEFAULT_CHAMPION_POLICY, options.newId ?? randomUUID);
    for (const [domain, key] of Object.entries(options.initialChampions ?? {}) as [Domain, ModelKey][]) board.champions.set(domain, key);
    board.log = await AppendOnlyLog.open<ChampionEvent>('champions', options.store ?? new InMemoryAppendOnlyStore(), {
      ...(options.clock ? { clock: options.clock } : {}),
      onApply: (record) => board.applyPromotion(record.payload),
    });
    return board;
  }

  champion(domain: Domain): ModelKey | undefined {
    return this.champions.get(domain);
  }

  history(): readonly ChampionChange[] {
    return [...this.changeLog];
  }

  sync(): Promise<void> {
    return this.log.sync();
  }

  verifyIntegrity() {
    return this.log.verifyIntegrity();
  }

  /** Compares the champion with active challengers on published, point-in-time scores. */
  evaluate(domain: Domain, registry: ModelRegistry, asOf: string): PromotionDecision {
    const current = this.champions.get(domain) ?? null;
    const championScore = this.scoreOf(current, domain, asOf);
    const reasons: string[] = [];
    let best: { key: ModelKey; score: number } | null = null;

    for (const entry of registry.list()) {
      const key = modelKey(entry.provider, entry.model);
      if (key === current || !entry.enabled) continue;
      const stats = this.performance.stats(key, asOf, { domain });
      if (entry.shadowMode) {
        reasons.push(key + ': in shadow mode, needs benchmark gate and human activation first');
        continue;
      }
      if (stats.sampleSize < this.policy.minSamplesForChampion) {
        reasons.push(key + ': ' + stats.sampleSize + ' samples < ' + this.policy.minSamplesForChampion + ' required');
        continue;
      }
      const published = this.performance.published(key, domain, undefined, asOf);
      if (published && (best === null || published.score > best.score)) best = { key, score: published.score };
    }

    const promote = best !== null && best.score >= championScore + this.policy.minScoreMargin;
    if (best !== null && !promote) reasons.push(best.key + ': score ' + best.score.toFixed(3) + ' does not beat champion ' + championScore.toFixed(3) + ' by ' + this.policy.minScoreMargin);
    if (promote && best) reasons.push(best.key + ': score ' + best.score.toFixed(3) + ' beats champion ' + championScore.toFixed(3) + ' by at least ' + this.policy.minScoreMargin);
    return { domain, evaluatedAt: asOf, currentChampion: current, candidate: best?.key ?? null, promote, championScore, candidateScore: best?.score ?? null, reasons };
  }

  /** Persists a promotion. It is verified again inside the log's critical section. */
  async apply(decision: PromotionDecision, by: Actor): Promise<void> {
    if (!decision.promote || decision.candidate === null) throw new Error('promotion decision does not promote anyone');
    const event: ChampionEvent = {
      type: 'promoted',
      eventId: this.newId(),
      domain: decision.domain,
      from: decision.currentChampion,
      to: decision.candidate,
      at: decision.evaluatedAt,
      by,
      reason: decision.reasons.join('; '),
    };
    await this.log.append(event.eventId, event, { precondition: () => this.verify(event) });
  }

  private scoreOf(key: ModelKey | null, domain: Domain, asOf: string): number {
    return key === null ? this.performance.policy.priorScore : (this.performance.published(key, domain, undefined, asOf)?.score ?? this.performance.policy.priorScore);
  }

  /** Re-derives the promotion from measured performance; anything else is a governance integrity failure. */
  private verify(event: ChampionEvent): void {
    const fail = (message: string): never => {
      throw new GovernanceIntegrityError('promotion ' + event.eventId + ' (' + event.domain + ' → ' + event.to + ') is not supported by measured performance: ' + message);
    };
    const current = this.champions.get(event.domain) ?? null;
    if (event.from !== current) fail('recorded previous champion ' + event.from + ' differs from ' + current);
    if (event.to === current) fail('candidate is already champion');
    const candidate = this.performance.published(event.to, event.domain, undefined, event.at);
    if (!candidate) fail('no published score at ' + event.at);
    if (candidate && candidate.sampleSize < this.policy.minSamplesForChampion) fail(candidate.sampleSize + ' samples < ' + this.policy.minSamplesForChampion);
    const championScore = this.scoreOf(current, event.domain, event.at);
    if (candidate && candidate.score < championScore + this.policy.minScoreMargin) fail('score ' + candidate.score.toFixed(3) + ' does not beat ' + championScore.toFixed(3) + ' by ' + this.policy.minScoreMargin);
  }

  private applyPromotion(event: ChampionEvent): void {
    this.verify(event);
    this.changeLog.push({ domain: event.domain, from: event.from, to: event.to, at: event.at, by: event.by, reason: event.reason });
    this.champions.set(event.domain, event.to);
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
