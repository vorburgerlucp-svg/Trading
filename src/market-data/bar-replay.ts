// Bar replay rules, shared by the in-memory store, PostgreSQL, quant, data quality and the backtest engine.
// See docs/MARKET_BAR_PROVENANCE.md.
//
// Two questions, never one field:
//   when may a bar REVISION be used?  barUsableFromMs: for an unproven revision (reconstruction, legacy) its historical gate
//                                     (availableAt). For a proven revision the later of that gate and the instant NEXUS held it.
//                                     So NEXUS never uses a proven revision before it held it, in any mode.
//   which revision does a replay see?  the highest revision whose historical gate is <= asOf (the "visible" revision).
//                                     Proven and held: returned. Proven but not yet held: absent. Unproven: returned in
//                                     historical reconstruction (labelled), refused in strict point-in-time (fail closed).

import { PROVEN_BAR_PROVENANCE, type BarKnowledgeProvenance, type BarRevisionKnowledge, type MarketBar } from './market-data-types.js';
import { parseUtc } from './time.js';

const LEGACY: BarRevisionKnowledge = Object.freeze({ provenance: 'legacy_unproven', revisionKnownAt: null });

/** The knowledge of a bar. A bar without it (built outside the typed API) is legacy: fail closed, never proven. */
export function knowledgeOf(bar: Pick<MarketBar, 'knowledge'>): BarRevisionKnowledge {
  return bar.knowledge ?? LEGACY;
}

/** True only when the provenance proves a knowledge time and that time is present. */
export function isProvenKnowledge(knowledge: BarRevisionKnowledge): boolean {
  return (PROVEN_BAR_PROVENANCE as readonly BarKnowledgeProvenance[]).includes(knowledge.provenance) && knowledge.revisionKnownAt !== null;
}

/** The floor a later revision carries in its historical gate: when NEXUS proved it held it, else when NEXUS retrieved it. */
export function revisionFloorOf(bar: Pick<MarketBar, 'knowledge' | 'retrievedAt'>): string {
  const knowledge = knowledgeOf(bar);
  return isProvenKnowledge(knowledge) ? knowledge.revisionKnownAt! : bar.retrievedAt;
}

/** Earliest instant (ms) a replay may use this revision. */
export function barUsableFromMs(bar: Pick<MarketBar, 'availableAt' | 'knowledge'>): number {
  const gate = parseUtc(bar.availableAt);
  const knowledge = knowledgeOf(bar);
  return isProvenKnowledge(knowledge) ? Math.max(gate, parseUtc(knowledge.revisionKnownAt!)) : gate;
}

/**
 * What a replay at `asOfMs` makes of the highest visible revision of a bar:
 *   usable       proven and held by asOf
 *   not_yet_held proven, but NEXUS held it only after asOf: the bar is absent at asOf
 *   unproven     the provenance proves nothing about when it was held
 */
export function classifyVisibleBar(bar: Pick<MarketBar, 'availableAt' | 'knowledge'>, asOfMs: number): 'usable' | 'not_yet_held' | 'unproven' {
  const knowledge = knowledgeOf(bar);
  if (!isProvenKnowledge(knowledge)) return 'unproven';
  return barUsableFromMs(bar) <= asOfMs ? 'usable' : 'not_yet_held';
}

export interface BarProvenanceCounts {
  total: number;
  /** Proven revisions (captured_by_nexus, provider_published_at). */
  proven: number;
  /** Historical reconstructions: the vintage is not proven. */
  historical: number;
  /** Rows stored before provenance existed. */
  legacy: number;
}

export function countBarProvenance(bars: readonly Pick<MarketBar, 'knowledge'>[]): BarProvenanceCounts {
  const counts: BarProvenanceCounts = { total: bars.length, proven: 0, historical: 0, legacy: 0 };
  for (const bar of bars) {
    const { provenance } = knowledgeOf(bar);
    if (provenance === 'legacy_unproven') counts.legacy++;
    else if (provenance === 'historical_bar_reconstruction') counts.historical++;
    else counts.proven++;
  }
  return counts;
}

/** A strict replay met revisions it cannot prove. Refused as a whole: nothing is silently dropped or substituted. */
export class BarVintageNotProvenError extends Error {
  override readonly name = 'BarVintageNotProvenError';
  readonly code = 'BAR_VINTAGE_NOT_PROVEN' as const;
  constructor(readonly refused: ReadonlyArray<{ instrumentId: string; startTime: string; provenance: BarKnowledgeProvenance }>) {
    super('strict point-in-time replay refused ' + refused.length + ' bar(s) whose revision is not proven (BAR_VINTAGE_NOT_PROVEN): ' + refused.slice(0, 3).map((r) => r.startTime + ' ' + r.provenance).join(', '));
  }
}
