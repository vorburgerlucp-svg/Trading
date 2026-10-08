import { describe, expect, it } from 'vitest';
import { getCalendar } from '../../src/market-data/sessions.js';
import { Decimal } from '../../src/money/decimal.js';
import { computeQuant } from '../../src/quant/quant-engine.js';
import { runMarketScanner } from '../../src/scanner/market-scanner.js';
import type { ScannerDefinition } from '../../src/scanner/scanner-types.js';
import { InMemoryInstrumentUniverseStore } from '../../src/scanner/universe.js';
import { AAPL, PRODUCTION_LIKE_SOURCE, dailyBars, randomOhlcv } from '../market-data/fixtures.js';

const XNAS = getCalendar('XNAS')!;
const AS_OF = '2026-11-20T00:00:00.000Z';

function quant() {
  const bars = dailyBars(XNAS, '2026-01-05', randomOhlcv(220, 77), { source: PRODUCTION_LIKE_SOURCE.sourceId });
  return computeQuant(
    {
      instrument: AAPL,
      calendar: XNAS,
      series: { source: PRODUCTION_LIKE_SOURCE.sourceId, interval: '1d', session: 'regular', adjustment: 'raw' },
      bars,
      asOf: AS_OF,
      sourceInfo: PRODUCTION_LIKE_SOURCE,
      useCase: 'analysis',
    },
    { createdAt: '2026-12-31T00:00:00.000Z' },
  );
}

function definition(): ScannerDefinition {
  return {
    id: 'basic',
    version: '1',
    universeId: 'U',
    interval: '1d',
    filters: [{ type: 'minimum_price', value: '0.01' }],
    ranking: [{ type: 'adx', weight: 1 }],
    maxCandidates: 10,
  };
}

describe('point-in-time universe', () => {
  it('membership is invisible before its availableAt and historical delisting is respected', () => {
    const store = new InMemoryInstrumentUniverseStore();
    store.register({ universeId: 'U', version: '1', source: 'fixture', pointInTimeSafe: true });
    store.addMembership({ universeId: 'U', instrumentId: 'A', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-06-01T00:00:00.000Z', availableAt: '2025-12-31T00:00:00.000Z', source: 'fixture' });
    store.addMembership({ universeId: 'U', instrumentId: 'B', validFrom: '2026-01-01T00:00:00.000Z', availableAt: '2026-02-01T00:00:00.000Z', source: 'fixture' });

    expect(store.snapshot('U', '2026-01-15T00:00:00.000Z').members).toEqual(['A']);
    expect(store.snapshot('U', '2026-03-01T00:00:00.000Z').members).toEqual(['A', 'B']);
    expect(store.snapshot('U', '2026-07-01T00:00:00.000Z').members).toEqual(['B']);
  });
});

describe('market scanner core', () => {
  it('accepts only universe members with trading-usable final quant data', () => {
    const q = quant();
    expect(q.dataQuality.usableForTrading).toBe(true);
    const universeStore = new InMemoryInstrumentUniverseStore();
    universeStore.register({ universeId: 'U', version: '1', source: 'fixture', pointInTimeSafe: true });
    universeStore.addMembership({ universeId: 'U', instrumentId: AAPL.instrumentId, validFrom: '2020-01-01T00:00:00.000Z', availableAt: '2020-01-01T00:00:00.000Z', source: 'fixture' });
    const universe = universeStore.snapshot('U', AS_OF);
    const run = runMarketScanner(definition(), universe, [{ instrumentId: AAPL.instrumentId, asOf: AS_OF, lastPrice: q.supportResistance.nearestSupport?.priceLevel ?? Decimal.from(100), averageVolume: Decimal.from(1_000_000), quant: q }], AS_OF);
    expect(run.candidates).toHaveLength(1);
    expect(run.candidates[0]).toMatchObject({ instrumentId: AAPL.instrumentId, rank: 1, quantRunId: q.quantRunId });
    expect(run.universePointInTimeSafe).toBe(true);
  });

  it('rejects a quant result that is not usable for trading and fingerprints the rejection', () => {
    const q = quant();
    const unsafe = { ...q, dataQuality: { ...q.dataQuality, usableForTrading: false } };
    const universeStore = new InMemoryInstrumentUniverseStore();
    universeStore.register({ universeId: 'U', version: '1', source: 'fixture', pointInTimeSafe: true });
    universeStore.addMembership({ universeId: 'U', instrumentId: AAPL.instrumentId, validFrom: '2020-01-01T00:00:00.000Z', availableAt: '2020-01-01T00:00:00.000Z', source: 'fixture' });
    const universe = universeStore.snapshot('U', AS_OF);
    const rejected = runMarketScanner(definition(), universe, [{ instrumentId: AAPL.instrumentId, asOf: AS_OF, lastPrice: Decimal.from(100), quant: unsafe }], AS_OF);
    const accepted = runMarketScanner(definition(), universe, [{ instrumentId: AAPL.instrumentId, asOf: AS_OF, lastPrice: Decimal.from(100), quant: q }], AS_OF);
    expect(rejected.candidates).toHaveLength(0);
    expect(rejected.rejected[0]?.reasons).toContain('market data not usable for trading');
    expect(rejected.scannerRunId).not.toBe(accepted.scannerRunId);
  });
});
