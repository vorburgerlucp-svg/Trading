import { describe, expect, it } from 'vitest';
import { InstrumentRegistry } from '../../src/market-data/instrument-registry.js';
import { registryResolver } from '../../src/universe/instrument-identity.js';
import { InMemoryUniverseStore } from '../../src/universe/universe-store.js';
import { sequentialIds } from '../helpers.js';
import { AAPL } from '../market-data/fixtures.js';
import { PRODUCTION_UNIVERSE_SOURCE } from './fixtures.js';

// Identity of a universe member comes from the InstrumentRegistry at the effective instant. A ticker is never identity.

const HUMAN = { kind: 'human' as const, id: 'luc' };
const change = (at: string, reason: string) => ({ at, by: HUMAN, reason });
const SOURCE_ID = PRODUCTION_UNIVERSE_SOURCE.sourceId;

async function registryWithTickerChange() {
  const registry = await InstrumentRegistry.open(undefined, { newId: sequentialIds('i-') });
  await registry.register({ ...AAPL, instrumentId: 'ins_a', symbol: 'FB', name: 'Facebook' }, change('2026-01-01T00:00:00Z', 'setup'));
  await registry.addMapping({ instrumentId: 'ins_a', provider: 'fixture', providerSymbol: 'FB', validFrom: '2012-05-18T00:00:00Z' }, change('2026-01-01T00:00:00Z', 'setup'));
  await registry.changeSymbol({ instrumentId: 'ins_a', provider: 'fixture', newProviderSymbol: 'META', newSymbol: 'META', effectiveFrom: '2022-06-09T00:00:00Z' }, change('2026-01-02T00:00:00Z', 'ticker change'));
  return registry;
}

function universeWith(registry: InstrumentRegistry) {
  const store = new InMemoryUniverseStore();
  store.registerDefinition({ universeId: 'u', definitionVersion: '1', name: 'fixture universe' });
  store.registerSource(PRODUCTION_UNIVERSE_SOURCE);
  return { store, resolve: registryResolver(registry) };
}

describe('universe identity comes from the InstrumentRegistry, never from the ticker', () => {
  it('a ticker change keeps every snapshot on the same instrument, and each ticker counts only at its own time', async () => {
    const registry = await registryWithTickerChange();
    const { store, resolve } = universeWith(registry);
    store.ingest({ universeId: 'u', sourceId: SOURCE_ID, effectiveAt: '2020-01-01T00:00:00Z', retrievedAt: '2019-12-31T12:00:00Z', knowledgeSource: 'captured_by_nexus', knownAt: '2019-12-31T12:00:00Z', completeness: 'COMPLETE', members: [{ sourceMemberKey: 'k:fb', providerSymbol: 'FB' }] }, resolve);
    store.ingest({ universeId: 'u', sourceId: SOURCE_ID, effectiveAt: '2023-01-01T00:00:00Z', retrievedAt: '2022-12-31T12:00:00Z', knowledgeSource: 'captured_by_nexus', knownAt: '2022-12-31T12:00:00Z', completeness: 'COMPLETE', members: [{ sourceMemberKey: 'k:fb', providerSymbol: 'META' }] }, resolve);

    expect(store.select({ universeId: 'u', sourceId: SOURCE_ID, asOf: '2021-06-01T00:00:00Z', mode: 'decision_time' }).members).toEqual(['ins_a']);
    const after = store.select({ universeId: 'u', sourceId: SOURCE_ID, asOf: '2023-06-01T00:00:00Z', mode: 'decision_time' });
    expect(after.members).toEqual(['ins_a']);
    expect(after.revision?.members[0]).toMatchObject({ instrumentId: 'ins_a', providerSymbol: 'META' });
    // The old ticker means nothing after its change: a COMPLETE snapshot that still says FB is refused.
    expect(() => store.ingest({ universeId: 'u', sourceId: SOURCE_ID, effectiveAt: '2024-01-01T00:00:00Z', retrievedAt: '2023-12-31T12:00:00Z', knowledgeSource: 'captured_by_nexus', knownAt: '2023-12-31T12:00:00Z', completeness: 'COMPLETE', members: [{ sourceMemberKey: 'k:fb', providerSymbol: 'FB' }] }, resolve)).toThrow(/UNIVERSE_MEMBER_UNRESOLVED/);
  });

  it('the active flag is never read for historical membership: a delisted instrument still resolves for its own past', async () => {
    const registry = await registryWithTickerChange();
    await registry.update('ins_a', { active: false }, change('2026-03-01T00:00:00Z', 'delisted'));
    const resolve = registryResolver(registry);
    const member = { sourceMemberKey: 'k:fb', providerSymbol: 'FB' };
    expect(resolve(member, '2020-01-01T00:00:00Z', PRODUCTION_UNIVERSE_SOURCE)).toBe('ins_a');
    expect(resolve(member, '2026-10-01T00:00:00Z', PRODUCTION_UNIVERSE_SOURCE)).toBeNull();
  });

  it('a symbol with no mapping at the instant resolves to nothing, and a partial snapshot keeps it visible', async () => {
    const registry = await registryWithTickerChange();
    const { store, resolve } = universeWith(registry);
    const stored = store.ingest({ universeId: 'u', sourceId: SOURCE_ID, effectiveAt: '2020-01-01T00:00:00Z', retrievedAt: '2019-12-31T12:00:00Z', knowledgeSource: 'captured_by_nexus', knownAt: '2019-12-31T12:00:00Z', completeness: 'PARTIAL', members: [{ sourceMemberKey: 'k:fb', providerSymbol: 'FB' }, { sourceMemberKey: 'k:zz', providerSymbol: 'ZZZ' }] }, resolve);
    expect(stored.revision.members.map((m) => m.instrumentId)).toEqual(['ins_a']);
    expect(stored.revision.unresolvedMembers.map((u) => u.providerSymbol)).toEqual(['ZZZ']);
    expect(store.select({ universeId: 'u', sourceId: SOURCE_ID, asOf: '2021-01-01T00:00:00Z', mode: 'decision_time' }).evidence.complete).toBe(false);
  });
});
