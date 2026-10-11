import { InMemoryUniverseStore } from '../../src/universe/universe-store.js';
import type { UniverseSelection, UniverseSource } from '../../src/universe/universe-model.js';

// Shared universe fixtures. Selections come from the real store, so no test hand-builds derived evidence.
// Each fixture states two things: the source's CLAIM (retrievedAt) and the store's own time (storedAt, the timing proof's clock reading).
// Strictness comes only from storedAt. A claim alone never makes a fixture strict.

export const PRODUCTION_UNIVERSE_SOURCE: UniverseSource = { sourceId: 'fixture:universe:production', provider: 'fixture', dataset: 'constituents', environment: 'production', license: 'internal_use' };

/** A test double for the store's clock: the same instant on every reading until set again. */
export function manualClock(at: string): { clock: () => string; set: (iso: string) => void } {
  let now = at;
  return { clock: () => now, set: (iso: string) => void (now = iso) };
}

/** One snapshot effective 2020-01-01, claimed retrieved at retrievedAt, stored by NEXUS at storedAt, read back with decision_time at asOf. */
function selectionOfSnapshot(
  universeId: string,
  instrumentIds: readonly string[],
  asOf: string,
  o: { completeness: 'COMPLETE' | 'PARTIAL'; retrievedAt: string; storedAt: string },
): UniverseSelection {
  const store = new InMemoryUniverseStore({ clock: () => o.storedAt });
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

/**
 * A COMPLETE snapshot effective 2020-01-01, claimed retrieved 2019-12-31 and stored by NEXUS at 2019-12-31T12:00:01Z, before it took effect:
 * the timing proof is contemporaneous and decision-time known at any later asOf.
 */
export function strictSelection(universeId: string, instrumentIds: readonly string[], asOf: string): UniverseSelection {
  return selectionOfSnapshot(universeId, instrumentIds, asOf, { completeness: 'COMPLETE', retrievedAt: '2019-12-31T12:00:00.000Z', storedAt: '2019-12-31T12:00:01.000Z' });
}

/** The same membership, but the source states it is PARTIAL: never complete, never strict. */
export function partialSelection(universeId: string, instrumentIds: readonly string[], asOf: string): UniverseSelection {
  return selectionOfSnapshot(universeId, instrumentIds, asOf, { completeness: 'PARTIAL', retrievedAt: '2019-12-31T12:00:00.000Z', storedAt: '2019-12-31T12:00:01.000Z' });
}

/**
 * A COMPLETE snapshot effective 2020-01-01 but stored by NEXUS on 2026-09-30, after it took effect: decision-time knowledge is proven
 * by 2026-10-01, yet the membership is an ex-post reconstruction, never strict.
 */
export function historicalSelection(universeId: string, instrumentIds: readonly string[], asOf: string): UniverseSelection {
  return selectionOfSnapshot(universeId, instrumentIds, asOf, { completeness: 'COMPLETE', retrievedAt: '2026-09-30T00:00:00.000Z', storedAt: '2026-09-30T00:00:01.000Z' });
}

/** Nothing ingested: the universe is not proven at asOf. */
export function unavailableSelection(universeId: string, asOf: string): UniverseSelection {
  const store = new InMemoryUniverseStore({ clock: () => '2026-10-09T12:00:00.000Z' });
  store.registerDefinition({ universeId, definitionVersion: '1', name: 'fixture universe' });
  store.registerSource(PRODUCTION_UNIVERSE_SOURCE);
  return store.select({ universeId, sourceId: PRODUCTION_UNIVERSE_SOURCE.sourceId, asOf, mode: 'decision_time' });
}

/** A revision whose commit was never sealed (a crash between commit and seal): research reads it, decision time does not. */
export function unsealedSelection(universeId: string, asOf: string): UniverseSelection {
  let crashed = false;
  const store = new InMemoryUniverseStore({
    clock: () => '2019-12-31T12:00:01.000Z',
    afterCommit: () => {
      crashed = true;
      throw new Error('crash between commit and seal');
    },
  });
  store.registerDefinition({ universeId, definitionVersion: '1', name: 'fixture universe' });
  store.registerSource(PRODUCTION_UNIVERSE_SOURCE);
  try {
    store.ingest(
      { universeId, sourceId: PRODUCTION_UNIVERSE_SOURCE.sourceId, effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2019-12-31T12:00:00.000Z', knowledgeSource: 'captured_by_nexus', knownAt: '2019-12-31T12:00:00.000Z', completeness: 'COMPLETE', members: [{ sourceMemberKey: 'key:ins_a', providerSymbol: 'ins_a' }] },
      (m) => m.providerSymbol,
    );
  } catch (error) {
    if (!crashed) throw error;
  }
  return store.select({ universeId, sourceId: PRODUCTION_UNIVERSE_SOURCE.sourceId, asOf, mode: 'historical_research' });
}

/** A revision stored by NEXUS after asOf: research reads it, and decision time at asOf does not hold it. */
export function sealedAfterAsOfSelection(universeId: string, asOf: string): UniverseSelection {
  const store = new InMemoryUniverseStore({ clock: () => '2026-10-01T09:00:00.000Z' });
  store.registerDefinition({ universeId, definitionVersion: '1', name: 'fixture universe' });
  store.registerSource(PRODUCTION_UNIVERSE_SOURCE);
  store.ingest(
    { universeId, sourceId: PRODUCTION_UNIVERSE_SOURCE.sourceId, effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2019-12-31T12:00:00.000Z', knowledgeSource: 'captured_by_nexus', knownAt: '2019-12-31T12:00:00.000Z', completeness: 'COMPLETE', members: [{ sourceMemberKey: 'key:ins_a', providerSymbol: 'ins_a' }] },
    (m) => m.providerSymbol,
  );
  return store.select({ universeId, sourceId: PRODUCTION_UNIVERSE_SOURCE.sourceId, asOf, mode: 'historical_research' });
}
