// Migration 008 compatibility for bar revisions (persistence layer only). The domain never sees these values: quant, scanner,
// backtest and the brain read the knowledge model (BarRevisionKnowledge). See docs/MIGRATION_HISTORY.md.
//
// Migration 008 keeps its own meaning, which the rows written after 009 must keep too:
//   knowledge_provenance   how the revision is known (captured_by_nexus | provider_published_at | historical_bar_reconstruction)
//   revision_known_at      when it is known (retrieval for captured_by_nexus, the publication time for provider_published_at, NULL for a reconstruction)
//   provenance_hash        integrity of those values, with the rule of 008's own release (barProvenanceHashV1 below)

import { hashOf } from '../canonical-json.js';
import { barKey } from '../../market-data/bar-validation.js';
import type { BarRevisionKnowledge, StoredBar } from '../../market-data/market-data-types.js';

export type V1KnowledgeProvenance = 'captured_by_nexus' | 'provider_published_at' | 'historical_bar_reconstruction';

export interface V1Mirror {
  knowledgeProvenance: V1KnowledgeProvenance;
  revisionKnownAt: string | null;
}

/**
 * The 008 value of a revision with V2 knowledge.
 *   captured, contemporaneous  -> captured_by_nexus, known at its retrieval
 *   captured, backfill         -> historical_bar_reconstruction: 008 has no knowledge time for it (NEXUS does hold it from its retrieval, V2 says so)
 *   provider publication       -> provider_published_at, known at the publication time
 */
export function v1MirrorOf(knowledge: BarRevisionKnowledge): V1Mirror {
  if (knowledge.knowledgeSource === 'provider_published_at') return { knowledgeProvenance: 'provider_published_at', revisionKnownAt: knowledge.knownAt };
  if (knowledge.knowledgeSource === 'captured_by_nexus') {
    return knowledge.vintage === 'contemporaneous' ? { knowledgeProvenance: 'captured_by_nexus', revisionKnownAt: knowledge.knownAt } : { knowledgeProvenance: 'historical_bar_reconstruction', revisionKnownAt: null };
  }
  throw new Error('a legacy revision has no 008 value: nothing may be written for it');
}

/**
 * The integrity hash of migration 008, exactly as its release computed it (contentVersion market-bar-provenance:v1, with the
 * 008 column values). Pinned by test/persistence/bar-compat.test.ts. It must never change: rows written under that release verify
 * with it.
 */
export function barProvenanceHashV1(
  bar: Pick<StoredBar, 'instrumentId' | 'source' | 'interval' | 'session' | 'adjustment' | 'startTime' | 'contentHash' | 'retrievedAt' | 'observedAt' | 'availableAt'>,
  mirror: { knowledgeProvenance: string | null; revisionKnownAt: string | null },
): string {
  return hashOf({
    contentVersion: 'market-bar-provenance:v1',
    key: barKey(bar),
    contentHash: bar.contentHash,
    retrievedAt: bar.retrievedAt,
    observedAt: bar.observedAt,
    availableAt: bar.availableAt,
    knowledgeProvenance: mirror.knowledgeProvenance,
    revisionKnownAt: mirror.revisionKnownAt,
  });
}
