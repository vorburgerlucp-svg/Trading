// The trusted inputs of the O21 demo execution gate in the runtime. Both are honest about what the runtime has:
//
//   - Portfolio safety: no source exists yet for the eToro demo account, so the runtime source always answers null. The gate then
//     refuses every open with PORTFOLIO_SAFETY_NOT_CONNECTED. The runtime never produces a safety decision of its own.
//   - Quotes: the latest stored quote of the instrument. It counts as production only when its stored source is a production
//     source and the runtime itself runs with production market data. Demo and fixture data are never usable for an order.

import type { MarketDataStore } from '../market-data/market-data-store.js';
import type { DemoQuoteSource, DemoSafetySource } from '../broker/etoro/execution/etoro-demo-execution-service.js';
import type { MarketDataMode } from './services.js';

/** The runtime safety source of O21: not connected. It never invents a decision. */
export const NO_DEMO_SAFETY_SOURCE: DemoSafetySource = Object.freeze({
  current: async () => null,
});

export function storedQuoteSource(store: MarketDataStore, mode: MarketDataMode): DemoQuoteSource {
  return {
    latest: async (instrumentId, now) => {
      const quote = await store.latestQuote({ instrumentId, asOf: now });
      if (quote === null) return null;
      const source = await store.getSource(quote.source);
      return {
        last: quote.last,
        bid: quote.bid ?? null,
        ask: quote.ask ?? null,
        currency: quote.currency ?? null,
        observedAt: quote.observedAt,
        production: mode === 'production' && source !== null && source.environment === 'production',
      };
    },
  };
}
