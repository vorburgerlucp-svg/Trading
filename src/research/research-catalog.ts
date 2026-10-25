// R1 research catalog: the small, versioned list of instruments the research instance observes. It is a file a human edits and
// reviews; the instance never adds an instrument on its own. The catalog is validated strictly and fingerprinted, and every run
// records the fingerprint, so a stored bar can always be traced to the catalog version that asked for it.

import type { AssetClass, Instrument, ProviderInstrumentMapping } from '../market-data/market-data-types.js';
import { getCalendar } from '../market-data/sessions.js';
import { assertTimeZone, parseUtc } from '../market-data/time.js';
import { hashOf } from '../persistence/canonical-json.js';

export const RESEARCH_CATALOG_VERSION = 'research-catalog:v1' as const;
/** R1 observes few instruments on purpose: a small, reliable data base over a large, incomplete one. */
export const RESEARCH_CATALOG_MAX_INSTRUMENTS = 10;
/** R1 collects 15-minute bars only. */
export const RESEARCH_INTERVAL = '15m' as const;
/** The only provider of R1. */
export const RESEARCH_PROVIDER = 'twelvedata' as const;
/** The source the provider stores its production time series under. */
export const RESEARCH_SOURCE_ID = 'twelvedata:time_series:production';
/** Raw prices as the provider delivered them: an adjusted series would change retroactively at every split. */
export const RESEARCH_ADJUSTMENT = 'raw' as const;
/** The provider's settlement delay for intraday bars (TwelveDataOptions.settleMs default): a bar is complete this long after its end. */
export const RESEARCH_SETTLE_MS = 60_000;

const ID = /^rsx_[a-z0-9_]{1,60}$/;
const SYMBOL = /^[A-Z0-9.\-/]{1,32}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MIC = /^[A-Z0-9]{4}$/;
const CATALOG_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** R1 asset classes: listed stocks and ETFs on an exchange calendar, and crypto on the 24x7 calendar. */
const ASSET_CLASSES: readonly AssetClass[] = ['stock', 'etf', 'crypto'];

export interface ResearchCatalogEntry {
  /** Permanent NEXUS identity of the instrument in the research database (prefix rsx_). */
  instrumentId: string;
  assetClass: 'stock' | 'etf' | 'crypto';
  symbol: string;
  name?: string;
  currency: string;
  exchange?: string;
  mic?: string;
  timezone: string;
  tradingCalendar: string;
  /** Twelve Data symbol, e.g. "AAPL" or "BTC/USD". */
  providerSymbol: string;
  /** Twelve Data exchange (crypto: the venue whose prices are requested). */
  providerExchange?: string;
  /** Start of the provider mapping (ISO UTC). */
  mappingValidFrom: string;
}

export interface ResearchCatalog {
  version: typeof RESEARCH_CATALOG_VERSION;
  catalogId: string;
  interval: typeof RESEARCH_INTERVAL;
  instruments: readonly ResearchCatalogEntry[];
}

export class ResearchCatalogError extends Error {
  override readonly name = 'ResearchCatalogError';
}

function fail(message: string): never {
  throw new ResearchCatalogError(message);
}

function only(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(where + ': unknown field ' + key);
}

function str(value: unknown, field: string, pattern?: RegExp, max = 200): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(field + ' must be a non-empty string of at most ' + max + ' characters');
  if (pattern && !pattern.test(value)) fail(field + ' has an invalid format');
  return value;
}

function entryOf(raw: unknown, index: number): ResearchCatalogEntry {
  const where = 'instruments[' + index + ']';
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(where + ' must be an object');
  const r = raw as Record<string, unknown>;
  only(r, ['instrumentId', 'assetClass', 'symbol', 'name', 'currency', 'exchange', 'mic', 'timezone', 'tradingCalendar', 'providerSymbol', 'providerExchange', 'mappingValidFrom'], where);
  const assetClass = r.assetClass as AssetClass;
  if (!ASSET_CLASSES.includes(assetClass)) fail(where + '.assetClass must be one of ' + ASSET_CLASSES.join(', '));
  const timezone = str(r.timezone, where + '.timezone', undefined, 64);
  try {
    assertTimeZone(timezone);
  } catch {
    fail(where + '.timezone must be an IANA zone');
  }
  const tradingCalendar = str(r.tradingCalendar, where + '.tradingCalendar', undefined, 32);
  if (!getCalendar(tradingCalendar)) fail(where + '.tradingCalendar is unknown: ' + tradingCalendar);
  if (assetClass === 'crypto' && tradingCalendar !== '24x7') fail(where + ': crypto uses the 24x7 calendar');
  if (assetClass !== 'crypto' && (r.mic === undefined || tradingCalendar === '24x7')) fail(where + ': a stock or ETF needs its MIC and an exchange calendar');
  const mappingValidFrom = str(r.mappingValidFrom, where + '.mappingValidFrom', undefined, 40);
  try {
    parseUtc(mappingValidFrom);
  } catch {
    fail(where + '.mappingValidFrom must be an ISO UTC instant');
  }
  return {
    instrumentId: str(r.instrumentId, where + '.instrumentId', ID, 64),
    assetClass: assetClass as ResearchCatalogEntry['assetClass'],
    symbol: str(r.symbol, where + '.symbol', SYMBOL, 32),
    ...(r.name !== undefined ? { name: str(r.name, where + '.name') } : {}),
    currency: str(r.currency, where + '.currency', CURRENCY, 3),
    ...(r.exchange !== undefined ? { exchange: str(r.exchange, where + '.exchange', undefined, 64) } : {}),
    ...(r.mic !== undefined ? { mic: str(r.mic, where + '.mic', MIC, 4) } : {}),
    timezone,
    tradingCalendar,
    providerSymbol: str(r.providerSymbol, where + '.providerSymbol', SYMBOL, 32),
    ...(r.providerExchange !== undefined ? { providerExchange: str(r.providerExchange, where + '.providerExchange', undefined, 64) } : {}),
    mappingValidFrom,
  };
}

/** Parses and validates a catalog (JSON text). Any unknown field, duplicate or out-of-range value refuses the whole catalog. */
export function parseResearchCatalog(text: string): ResearchCatalog {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('catalog is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('catalog must be an object');
  const r = raw as Record<string, unknown>;
  only(r, ['version', 'catalogId', 'interval', 'instruments'], 'catalog');
  if (r.version !== RESEARCH_CATALOG_VERSION) fail('catalog version must be ' + RESEARCH_CATALOG_VERSION);
  if (r.interval !== RESEARCH_INTERVAL) fail('catalog interval must be ' + RESEARCH_INTERVAL + ' (R1)');
  const catalogId = str(r.catalogId, 'catalogId', CATALOG_ID, 63);
  if (!Array.isArray(r.instruments) || r.instruments.length === 0) fail('catalog needs at least one instrument');
  if (r.instruments.length > RESEARCH_CATALOG_MAX_INSTRUMENTS) fail('catalog has more than ' + RESEARCH_CATALOG_MAX_INSTRUMENTS + ' instruments');
  const instruments = r.instruments.map(entryOf);
  const ids = new Set<string>();
  const symbols = new Set<string>();
  for (const i of instruments) {
    if (ids.has(i.instrumentId)) fail('duplicate instrumentId ' + i.instrumentId);
    const key = i.providerSymbol + '|' + (i.providerExchange ?? i.mic ?? '');
    if (symbols.has(key)) fail('duplicate provider symbol ' + i.providerSymbol);
    ids.add(i.instrumentId);
    symbols.add(key);
  }
  return Object.freeze({ version: RESEARCH_CATALOG_VERSION, catalogId, interval: RESEARCH_INTERVAL, instruments: Object.freeze(instruments) });
}

/** SHA-256 over the canonical catalog: the identity every run records. */
export function researchCatalogFingerprint(catalog: ResearchCatalog): string {
  return hashOf(catalog);
}

/** The registry instrument of a catalog entry. */
export function instrumentOf(entry: ResearchCatalogEntry): Instrument {
  return {
    instrumentId: entry.instrumentId,
    assetClass: entry.assetClass,
    symbol: entry.symbol,
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    currency: entry.currency,
    ...(entry.exchange !== undefined ? { exchange: entry.exchange } : {}),
    ...(entry.mic !== undefined ? { mic: entry.mic } : {}),
    timezone: entry.timezone,
    tradingCalendar: entry.tradingCalendar,
    active: true,
  };
}

/** The provider mapping of a catalog entry. */
export function mappingOf(entry: ResearchCatalogEntry): ProviderInstrumentMapping {
  return {
    instrumentId: entry.instrumentId,
    provider: RESEARCH_PROVIDER,
    providerSymbol: entry.providerSymbol,
    ...(entry.providerExchange !== undefined ? { exchange: entry.providerExchange } : {}),
    validFrom: entry.mappingValidFrom,
  };
}
