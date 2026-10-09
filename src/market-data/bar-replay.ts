// Bar replay and knowledge rules, shared by the in-memory store, PostgreSQL, quant, data quality and the backtest engine.
// See docs/BAR_KNOWLEDGE_EVIDENCE.md. Two questions, never one boolean:
//
//   decision-time knowledge  did NEXUS hold exactly this revision at asOf?      knownAt <= asOf, source not legacy
//   vintage                  was it already the market's value at its time?     vintage === 'contemporaneous'
//
// Replay modes (BarReplayMode):
//   historical_research: visibility by the market gate (availableAt). Revisions NEXUS held only later are used and labelled.
//   decision_time:       a bar is usable only once NEXUS held it. Legacy rows are refused.

import type { BarReplayMode, BarRevisionKnowledge, BarVintage, MarketBar } from './market-data-types.js';
import { parseUtc } from './time.js';

const LEGACY: BarRevisionKnowledge = Object.freeze({ knownAt: null, knowledgeSource: 'legacy_unproven', vintage: 'legacy_unproven', vintagePolicy: null });

/** The knowledge of a bar. A bar without it (built outside the typed API) is legacy: fail closed. */
export function knowledgeOf(bar: Pick<MarketBar, 'knowledge'>): BarRevisionKnowledge {
  const k = bar.knowledge as Partial<BarRevisionKnowledge> | undefined;
  if (!k || typeof k !== 'object' || k.knowledgeSource === undefined || k.knowledgeSource === 'legacy_unproven') return LEGACY;
  return k as BarRevisionKnowledge;
}

/** Decision-time knowledge is proven when the source proves a time and that time is present. */
export function hasKnownAt(knowledge: BarRevisionKnowledge): boolean {
  return knowledge.knowledgeSource !== 'legacy_unproven' && knowledge.knownAt !== null;
}

/** The instant NEXUS held this revision (ms), or null for legacy rows. */
export function knownAtMs(bar: Pick<MarketBar, 'knowledge'>): number | null {
  const knowledge = knowledgeOf(bar);
  return hasKnownAt(knowledge) ? parseUtc(knowledge.knownAt!) : null;
}

/** Decision-time knowledge at asOf: proven, and NEXUS held the revision no later than asOf. */
export function isKnownAt(bar: Pick<MarketBar, 'knowledge'>, asOfMs: number): boolean {
  const known = knownAtMs(bar);
  return known !== null && known <= asOfMs;
}

export function isContemporaneous(bar: Pick<MarketBar, 'knowledge'>): boolean {
  return knowledgeOf(bar).vintage === 'contemporaneous';
}

/** The floor a later revision carries in its market gate: when NEXUS held it, else when NEXUS retrieved it. */
export function revisionFloorOf(bar: Pick<MarketBar, 'knowledge' | 'retrievedAt'>): string {
  const knowledge = knowledgeOf(bar);
  return hasKnownAt(knowledge) ? knowledge.knownAt! : bar.retrievedAt;
}

/**
 * The instant (ms) from which a replay in `mode` may use this bar.
 *   historical_research: the market gate (availableAt).
 *   decision_time: the later of the market gate and the instant NEXUS held it. A legacy bar throws BarKnowledgeNotProvenError.
 */
export function replayInstantMs(bar: Pick<MarketBar, 'availableAt' | 'knowledge' | 'startTime'>, mode: BarReplayMode): number {
  const gate = parseUtc(bar.availableAt);
  if (mode === 'historical_research') return gate;
  const known = knownAtMs(bar);
  if (known === null) throw new BarKnowledgeNotProvenError([{ instrumentId: (bar as { instrumentId?: string }).instrumentId ?? '?', startTime: bar.startTime, provenance: 'legacy_unproven' }]);
  return Math.max(gate, known);
}

/** Vintage of a bar as a plain value (legacy rows are their own class). */
export function vintageOf(bar: Pick<MarketBar, 'knowledge'>): BarVintage {
  return knowledgeOf(bar).vintage;
}

export interface BarKnowledgeCounts {
  total: number;
  /** Bars whose revision NEXUS held at asOf (proven source, knownAt <= asOf). */
  knownAtAsOf: number;
  contemporaneous: number;
  historical: number;
  legacy: number;
}

/** Counts for a set of bars at a decision time. A legacy bar is never known. */
export function countBarKnowledge(bars: readonly Pick<MarketBar, 'knowledge'>[], asOfMs: number): BarKnowledgeCounts {
  const counts: BarKnowledgeCounts = { total: bars.length, knownAtAsOf: 0, contemporaneous: 0, historical: 0, legacy: 0 };
  for (const bar of bars) {
    const vintage = vintageOf(bar);
    if (vintage === 'legacy_unproven') counts.legacy++;
    else if (vintage === 'contemporaneous') counts.contemporaneous++;
    else counts.historical++;
    if (isKnownAt(bar, asOfMs)) counts.knownAtAsOf++;
  }
  return counts;
}

/** A decision-time read met a revision NEXUS cannot prove it held (legacy). Refused as a whole; nothing is substituted. */
export class BarKnowledgeNotProvenError extends Error {
  override readonly name = 'BarKnowledgeNotProvenError';
  readonly code = 'BAR_KNOWLEDGE_NOT_PROVEN' as const;
  constructor(readonly refused: ReadonlyArray<{ instrumentId: string; startTime: string; provenance: string }>) {
    super('decision-time replay refused ' + refused.length + ' bar(s) whose knowledge is not proven (BAR_KNOWLEDGE_NOT_PROVEN): ' + refused.slice(0, 3).map((r) => r.startTime + ' ' + r.provenance).join(', '));
  }
}
