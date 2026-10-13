// Projection of the hash-chained 'instruments' log into instrument_events (immutable history) and
// the derived current-state tables instruments / provider_instrument_mappings (caches: NEXUS
// rebuilds the real state from the log; these tables exist for queries and joins).

import type { InstrumentEvent } from '../../market-data/instrument-registry.js';
import type { Projector } from './postgres-append-only-store.js';

const INSTRUMENT_COLUMNS: Readonly<Record<string, string>> = {
  name: 'name',
  symbol: 'symbol',
  active: 'active',
  tickSize: 'tick_size',
  lotSize: 'lot_size',
  exchange: 'exchange',
  mic: 'mic',
  tradingCalendar: 'trading_calendar',
};

function instrumentIdOf(e: InstrumentEvent): string {
  switch (e.type) {
    case 'instrument_registered':
      return e.instrument.instrumentId;
    case 'mapping_added':
      return e.mapping.instrumentId;
    default:
      return e.instrumentId;
  }
}

export const instrumentProjector: Projector<InstrumentEvent> = async (client, record) => {
  const e = record.payload;
  await client.query('INSERT INTO instrument_events (event_id, type, instrument_id, at, actor_kind, actor_id, reason, record_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
    e.eventId,
    e.type,
    instrumentIdOf(e),
    e.at,
    e.by.kind,
    e.by.id,
    e.reason,
    record.hash,
  ]);
  switch (e.type) {
    case 'instrument_registered': {
      const i = e.instrument;
      await client.query(
        `INSERT INTO instruments (instrument_id, asset_class, symbol, name, currency, exchange, mic, timezone, tick_size, lot_size, trading_calendar, active, allows_negative_prices, last_event_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [i.instrumentId, i.assetClass, i.symbol, i.name ?? null, i.currency, i.exchange ?? null, i.mic ?? null, i.timezone, i.tickSize ?? null, i.lotSize ?? null, i.tradingCalendar ?? null, i.active, i.allowsNegativePrices ?? false, e.eventId, e.at],
      );
      return;
    }
    case 'instrument_updated': {
      for (const [key, value] of Object.entries(e.changes)) {
        const column = INSTRUMENT_COLUMNS[key];
        if (!column) throw new Error('unexpected instrument change ' + key);
        await client.query('UPDATE instruments SET ' + column + ' = $1, last_event_id = $2, updated_at = $3 WHERE instrument_id = $4', [value ?? null, e.eventId, e.at, e.instrumentId]);
      }
      return;
    }
    case 'mapping_added': {
      const m = e.mapping;
      await client.query(
        'INSERT INTO provider_instrument_mappings (instrument_id, provider, provider_symbol, provider_instrument_id, exchange, valid_from, valid_to) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [m.instrumentId, m.provider, m.providerSymbol, m.providerInstrumentId ?? null, m.exchange ?? null, m.validFrom, m.validTo ?? null],
      );
      return;
    }
    case 'mapping_closed':
      await client.query('UPDATE provider_instrument_mappings SET valid_to = $1 WHERE instrument_id = $2 AND provider = $3 AND provider_symbol = $4 AND valid_from = $5', [
        e.validTo,
        e.instrumentId,
        e.provider,
        e.providerSymbol,
        e.validFrom,
      ]);
      return;
    case 'symbol_changed':
      await client.query('UPDATE provider_instrument_mappings SET valid_to = $1 WHERE instrument_id = $2 AND provider = $3 AND valid_to IS NULL', [e.effectiveFrom, e.instrumentId, e.provider]);
      await client.query(
        'INSERT INTO provider_instrument_mappings (instrument_id, provider, provider_symbol, provider_instrument_id, exchange, valid_from, valid_to) VALUES ($1, $2, $3, $4, $5, $6, NULL)',
        [e.instrumentId, e.provider, e.newProviderSymbol, e.providerInstrumentId ?? null, e.exchange ?? null, e.effectiveFrom],
      );
      await client.query('UPDATE instruments SET symbol = $1, last_event_id = $2, updated_at = $3 WHERE instrument_id = $4', [e.newSymbol, e.eventId, e.at, e.instrumentId]);
      return;
  }
};
