import { InMemoryUniverseStore } from '../../src/universe/universe-store.js';
import type { UniverseSelection, UniverseSource } from '../../src/universe/universe-model.js';

// Shared universe fixtures. Selections come from the real store, so no test hand-builds derived evidence.

export const PRODUCTION_UNIVERSE_SOURCE: UniverseSource = { sourceId: 'fixture:universe:production', provider: 'fixture', dataset: 'constituents', environment: 'production', license: 'internal_use' };

/** One snapshot effective 2020-01-01, captured at retrievedAt, read back with decision_time at asOf. */
function selectionOfSnapshot(
  universeId: string,
  instrumentIds: readonly string[],
  asOf: string,
  o: { completeness: 'COMPLETE' | 'PARTIAL'; retrievedAt: string },
): UniverseSelection {
  const store = new InMemoryUniverseStore();
  store.registerDefinition({ universeId, definitionVersion: '1', name: 'fixture universe' });
  store.registerSource(PRODUCTION_UNIVERSE_SOURCE);
  store.ingest(
    {
      universeId,
      sourceId: PRODUCTION_UNIVERSE_SOURCE.sourceId,
      effectiveAt: '2020-01-01T00:00:00.000Z',
      retrievedAt: o.retrievedAt,
      knowledgeSource: 'captured_by_nexus',
      knownAt: o.retrievedAt,
      completeness: o.completeness,
      members: instrumentIds.map((id) => ({ sourceMemberKey: 'key:' + id, providerSymbol: id })),
    },
    (m) => m.providerSymbol,
  );
  return store.select({ universeId, sourceId: PRODUCTION_UNIVERSE_SOURCE.sourceId, asOf, mode: 'decision_time' });
}

/** A COMPLETE snapshot effective 2020-01-01, captured 2019-12-31 (before it took effect): contemporaneous and known at any later asOf. */
export function strictSelection(universeId: string, instrumentIds: readonly string[], asOf: string): UniverseSelection {
  return selectionOfSnapshot(universeId, instrumentIds, asOf, { completeness: 'COMPLETE', retrievedAt: '2019-12-31T12:00:00.000Z' });
}

/** The same membership, but the source states it is PARTIAL: never complete, never strict. */
export function partialSelection(universeId: string, instrumentIds: readonly string[], asOf: string): UniverseSelection {
  return selectionOfSnapshot(universeId, instrumentIds, asOf, { completeness: 'PARTIAL', retrievedAt: '2019-12-31T12:00:00.000Z' });
}

/**
 * A COMPLETE snapshot effective 2020-01-01 but learned on 2026-09-30: known before a 2026-10-01 asOf, yet learned after it took effect.
 * Decision-time knowledge is proven; the membership is an ex-post reconstruction, never strict.
 */
export function historicalSelection(universeId: string, instrumentIds: readonly string[], asOf: string): UniverseSelection {
  return selectionOfSnapshot(universeId, instrumentIds, asOf, { completeness: 'COMPLETE', retrievedAt: '2026-09-30T00:00:00.000Z' });
}

/** Nothing ingested: the universe is not proven at asOf. */
export function unavailableSelection(universeId: string, asOf: string): UniverseSelection {
  const store = new InMemoryUniverseStore();
  store.registerDefinition({ universeId, definitionVersion: '1', name: 'fixture universe' });
  store.registerSource(PRODUCTION_UNIVERSE_SOURCE);
  return store.select({ universeId, sourceId: PRODUCTION_UNIVERSE_SOURCE.sourceId, asOf, mode: 'decision_time' });
}
