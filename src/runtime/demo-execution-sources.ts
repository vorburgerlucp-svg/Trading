// The trusted inputs of the O21 demo execution gate in the runtime. Both are honest about what the runtime has:
//
//   - Portfolio safety: with eToro and demo execution enabled, the runtime wires the eToro demo account safety source (O22,
//     EtoroDemoAccountSafetySource in compose.ts). NO_DEMO_SAFETY_SOURCE below is only the fallback when that source cannot be
//     built: it always answers null, and the gate then refuses every open with PORTFOLIO_SAFETY_NOT_CONNECTED. The runtime never
//     produces a safety decision of its own.
//   - Quotes: the latest stored quote of the instrument. It counts as production only when its stored source is a production
//     source and the runtime itself runs with production market data. Demo and fixture data are never usable for an order.

import type { MarketDataStore } from '../market-data/market-data-store.js';
import type { EtoroBrokerService } from '../broker/etoro/etoro-broker-service.js';
import type { DemoPositionSource, DemoQuoteSource, DemoSafetySource } from '../broker/etoro/execution/etoro-demo-execution-service.js';
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

/**
 * O22 D4: the stored broker positions a close is checked against. Every call catches up with the sync and snapshot logs in the
 * store (EtoroBrokerService.latestStoredSnapshot), so a newer snapshot stored by another process is seen. No broker request.
 * Without eToro there is no evidence, and every close is refused.
 */
export function storedPositionSource(etoro: Pick<EtoroBrokerService, 'latestStoredSnapshot'> | null): DemoPositionSource {
  return {
    latest: async () => {
      if (etoro === null) return { snapshot: null, problem: null };
      const read = await etoro.latestStoredSnapshot();
      if (read.kind === 'none') return { snapshot: null, problem: null };
      if (read.kind !== 'snapshot') return { snapshot: null, problem: read.kind };
      const { snapshot } = read;
      return {
        snapshot: {
          observedAt: snapshot.observedAt,
          freshness: snapshot.freshness,
          positionCount: snapshot.content.positionCount,
          positions: (snapshot.content.positions ?? []).map((p) => ({
            positionId: p.positionId,
            etoroInstrumentId: p.etoroInstrumentId,
            direction: p.direction,
            openOrderId: p.openOrder?.orderId ?? null,
          })),
        },
        problem: null,
      };
    },
  };
}
