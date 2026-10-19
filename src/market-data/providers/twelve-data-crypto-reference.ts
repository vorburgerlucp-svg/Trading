// O22 B8: the quote currency of a Twelve Data crypto pair, from Twelve Data's own reference data.
//
// Why: for crypto pairs neither /symbol_search nor /quote states a currency (live 2026-10-19 for ETH/USD: `currency`,
// `currency_base` and `currency_quote` all absent). The documented reference for crypto pairs is GET /cryptocurrencies, whose
// `currency_base` / `currency_quote` are NAMES (documented example "Bitcoin" / "US Dollar"; live for ETH/USD: one row,
// "Ethereum" / "US Dollar", docs/evidence/O22_twelvedata_cryptocurrencies_ETH_USD_2026-10-19.json).
//
// Rules (docs/O22_ETORO_DEMO_TRADING_E2E_V1.md, section 15):
//   - exactly one reference row whose symbol is the requested provider symbol; none or several: unresolved;
//   - when the venue is known, it must be one of the row's available_exchanges, else unresolved;
//   - `currency_quote` becomes a currency only as an ISO code, or through the explicit name table below; any other name: unresolved;
//   - the symbol ("ETH/USD") and the instrument's display name are never parsed for a currency; `currency_base` is never used.
// Callers use it only when the provider response states no currency at all; a stated currency is never replaced by it.

import { toUtcIso } from '../time.js';
import type { CurrencyOrigin } from '../market-data-types.js';
import type { TdCryptoPair } from './twelve-data-schema.js';

/** The reviewed name table. A name not in it gives no currency; extending it is a reviewed code change with a test. */
export const TWELVE_DATA_CURRENCY_NAMES_VERSION = 'twelvedata-currency-names:v1';
export const TWELVE_DATA_CURRENCY_NAMES: Readonly<Record<string, string>> = Object.freeze({ 'US Dollar': 'USD' });

export const CRYPTO_REFERENCE_SOURCE = 'twelvedata:/cryptocurrencies#currency_quote';
const ISO_CURRENCY = /^[A-Z]{3}$/;

export type CryptoReferenceUnresolved = 'NO_REFERENCE' | 'AMBIGUOUS_REFERENCE' | 'EXCHANGE_NOT_LISTED' | 'UNKNOWN_CURRENCY_NAME';

export type CryptoReferenceCurrency =
  | { readonly kind: 'resolved'; readonly currency: string; readonly origin: Extract<CurrencyOrigin, { kind: 'reference' }> }
  | { readonly kind: 'unresolved'; readonly reason: CryptoReferenceUnresolved };

export function resolveCryptoQuoteCurrency(pairs: readonly TdCryptoPair[], providerSymbol: string, exchange: string | undefined, retrievedAtMs: number): CryptoReferenceCurrency {
  const rows = pairs.filter((p) => p.symbol.toUpperCase() === providerSymbol.toUpperCase());
  if (rows.length === 0) return { kind: 'unresolved', reason: 'NO_REFERENCE' };
  if (rows.length > 1) return { kind: 'unresolved', reason: 'AMBIGUOUS_REFERENCE' };
  const row = rows[0]!;
  if (exchange !== undefined && exchange !== '' && !row.availableExchanges.includes(exchange)) return { kind: 'unresolved', reason: 'EXCHANGE_NOT_LISTED' };
  const stated = row.currencyQuote;
  const viaIso = ISO_CURRENCY.test(stated) ? stated : undefined;
  const viaName = Object.prototype.hasOwnProperty.call(TWELVE_DATA_CURRENCY_NAMES, stated) ? TWELVE_DATA_CURRENCY_NAMES[stated] : undefined;
  const currency = viaIso ?? viaName;
  if (currency === undefined) return { kind: 'unresolved', reason: 'UNKNOWN_CURRENCY_NAME' };
  return {
    kind: 'resolved',
    currency,
    origin: { kind: 'reference', source: CRYPTO_REFERENCE_SOURCE, stated, rule: viaIso !== undefined ? 'iso_code' : TWELVE_DATA_CURRENCY_NAMES_VERSION, retrievedAt: toUtcIso(retrievedAtMs) },
  };
}
