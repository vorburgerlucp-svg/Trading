import { describe, expect, it } from 'vitest';
import { assessBacktestQuality } from '../../src/backtest/quality.js';
import { runMarketScanner } from '../../src/scanner/market-scanner.js';
import type { ScannerDefinition } from '../../src/scanner/scanner-types.js';
import { InMemoryUniverseStore } from '../../src/universe/universe-store.js';
import { strictSelection } from './fixtures.js';

// Regressions for the caller-asserted point-in-time weakness (docs/PIT_UNIVERSE_V1.md, section 1). The defect was a boolean a caller
// could set to true. Each test states what must NOT happen, using only the derived evidence.

const ASOF = '2020-09-21T20:00:00.000Z';

describe('caller-asserted point-in-time (must not be trusted)', () => {
  it('a universe from a test-fixture source is never production evidence, however complete it looks', () => {
    const store = new InMemoryUniverseStore();
    store.registerDefinition({ universeId: 'u_test_index', definitionVersion: '1', name: 'Test index' });
    store.registerSource({ sourceId: 'hand-typed:test', provider: 'hand-typed', dataset: 'constituents', environment: 'test_fixture', license: 'unreviewed' });
    store.ingest(
      { universeId: 'u_test_index', sourceId: 'hand-typed:test', effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2019-12-31T12:00:00.000Z', knowledgeSource: 'captured_by_nexus', knownAt: '2019-12-31T12:00:00.000Z', completeness: 'COMPLETE', members: [{ sourceMemberKey: 'k:a', providerSymbol: 'ins_a' }] },
      (m) => m.providerSymbol,
    );
    const evidence = store.select({ universeId: 'u_test_index', sourceId: 'hand-typed:test', asOf: ASOF, mode: 'decision_time' }).evidence;
    expect(evidence).toMatchObject({ complete: true, sourceProduction: false, strictDecisionTime: false });
  });

  it('a scanner run cannot inherit strict universe evidence from a non-production source', () => {
    const store = new InMemoryUniverseStore();
    store.registerDefinition({ universeId: 'u_test_index', definitionVersion: '1', name: 'Test index' });
    store.registerSource({ sourceId: 'hand-typed:test', provider: 'hand-typed', dataset: 'constituents', environment: 'test_fixture', license: 'unreviewed' });
    store.ingest(
      { universeId: 'u_test_index', sourceId: 'hand-typed:test', effectiveAt: '2020-01-01T00:00:00.000Z', retrievedAt: '2019-12-31T12:00:00.000Z', knowledgeSource: 'captured_by_nexus', knownAt: '2019-12-31T12:00:00.000Z', completeness: 'COMPLETE', members: [{ sourceMemberKey: 'k:a', providerSymbol: 'ins_a' }] },
      (m) => m.providerSymbol,
    );
    const definition: ScannerDefinition = { id: 'scan_test', version: '1', universeId: 'u_test_index', interval: '1d', filters: [], ranking: [], maxCandidates: 5 };
    const selection = store.select({ universeId: 'u_test_index', sourceId: 'hand-typed:test', asOf: ASOF, mode: 'decision_time' });
    const run = runMarketScanner(definition, selection, [], ASOF);
    expect(run.universeEvidence.strictDecisionTime).toBe(false);
  });

  it('a backtest cannot reach grade A because a caller says its universe is point-in-time safe', () => {
    const quality = assessBacktestQuality(
      { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'modeled', providerProduction: true, minimumTrades: 1 },
      2,
      0,
      false,
      { total: 1, knownBeforeUse: 1, contemporaneousVintage: 1, historicalVintage: 0, legacy: 0 },
    );
    expect(quality.grade).not.toBe('A');
    expect(quality.reasons.some((r) => r.startsWith('UNIVERSE_EVIDENCE_NOT_PROVIDED'))).toBe(true);
  });

  it('a strict selection is the only thing that can make the universe strict (the helper proves the positive case)', () => {
    expect(strictSelection('u_test_index', ['ins_a'], ASOF).evidence.strictDecisionTime).toBe(true);
  });
});
