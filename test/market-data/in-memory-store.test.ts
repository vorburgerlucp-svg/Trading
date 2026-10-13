import { InMemoryMarketDataStore } from '../../src/market-data/market-data-store.js';
import type { InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import { Decimal } from '../../src/money/decimal.js';
import { InMemoryAppendOnlyStore } from '../../src/persistence/append-only-log.js';
import { InMemoryQuantRunStore } from '../../src/quant/quant-run-store.js';
import { marketDataStoreContract } from '../contracts/market-data-store.contract.js';

marketDataStoreContract('InMemoryMarketDataStore', async () => {
  const store = new InMemoryMarketDataStore();
  const runs = new InMemoryQuantRunStore();
  const instruments = new InMemoryAppendOnlyStore<InstrumentEvent>();
  return {
    store: async () => store,
    quantRuns: async () => runs,
    instruments: async () => instruments,
    tamperBar: async (instrumentId, startTime, newClose) => store.tamperBarForTest(instrumentId, startTime, (b) => ({ ...b, close: Decimal.from(newClose), high: Decimal.from(newClose) })),
    cleanup: async () => undefined,
  };
});
