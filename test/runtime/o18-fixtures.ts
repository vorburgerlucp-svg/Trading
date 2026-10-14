// Shared fixture of the O18 runtime tests. TEST DATA ONLY: a synthetic provider labelled with the fixture source, which is never
// a real market source. Production code never ships or invents market data.

import type { AppendOnlyStore } from '../../src/persistence/append-only-log.js';
import { InstrumentRegistry, type InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import type { MarketDataProvider } from '../../src/market-data/market-data-provider.js';
import { calendarForInstrument } from '../../src/market-data/sessions.js';
import { AAPL, FIXTURE_SOURCE, dailyBars, randomOhlcv } from '../market-data/fixtures.js';

/** The fixed clock of the runtime tests. Every fixture bar lies before it. */
export const RUNTIME_TEST_NOW = '2026-10-14T12:00:00.000Z';

const HUMAN = { kind: 'human' as const, id: 'runtime-test' };
const change = { at: RUNTIME_TEST_NOW, by: HUMAN, reason: 'runtime test fixture' };

function xnasCalendar() {
  const calendar = calendarForInstrument(AAPL);
  if (calendar === null) throw new Error('runtime test fixture needs the XNAS trading calendar');
  return calendar;
}

// Forty trading days from early August end before RUNTIME_TEST_NOW.
const CALENDAR = xnasCalendar();

export function fixtureProvider(): MarketDataProvider {
  return {
    providerId: 'twelvedata',
    searchInstruments: async () => [{
      provider: 'twelvedata',
      providerSymbol: 'AAPL',
      assetClass: 'stock',
      name: 'Apple Inc',
      currency: 'USD',
      exchange: 'NASDAQ',
      mic: 'XNAS',
      timezone: 'America/New_York',
    }],
    getInstrument: async () => null,
    getHistoricalBars: async (request) => ({
      source: FIXTURE_SOURCE,
      requests: 1,
      bars: dailyBars(CALENDAR, '2026-08-03', randomOhlcv(40, 7, 100), {
        instrument: AAPL,
        source: FIXTURE_SOURCE.sourceId,
        interval: '1d',
        session: 'regular',
        adjustment: request.adjustment,
        retrievedAt: '2026-10-14T11:00:00.000Z',
      }),
    }),
    getQuote: async () => {
      throw new Error('quotes are not part of the runtime test fixture');
    },
    health: () => ({ provider: 'twelvedata', state: 'closed', consecutiveFailures: 0 }),
  };
}

/** Registers AAPL and its Twelve Data mapping in the instrument log. The registry replays that log whenever it is opened. */
export async function registerAapl(instruments: AppendOnlyStore<InstrumentEvent>): Promise<void> {
  const registry = await InstrumentRegistry.open(instruments);
  await registry.register({ ...AAPL }, change);
  await registry.addMapping({ instrumentId: AAPL.instrumentId, provider: 'twelvedata', providerSymbol: 'AAPL', validFrom: '1980-12-12T00:00:00Z' }, change);
}
