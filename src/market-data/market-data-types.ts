// Canonical market data model. Provider-neutral: no provider IDs or symbols leak into the domain
// except through ProviderInstrumentMapping.
//
// Prices are exact Decimals (never binary floats). Every instant is a UTC ISO string ("...Z").
// Every piece of market information carries three timestamps (point-in-time):
//   observedAt  – when the value was true at the source (bar close / quote time)
//   availableAt – when it became available; a replay at T only sees availableAt <= T
//   retrievedAt – when NEXUS fetched it

import type { Decimal } from '../money/decimal.js';

export type AssetClass = 'stock' | 'etf' | 'crypto' | 'forex' | 'commodity' | 'future' | 'index';
export const ASSET_CLASSES: readonly AssetClass[] = ['stock', 'etf', 'crypto', 'forex', 'commodity', 'future', 'index'];

export interface Instrument {
  /** NEXUS identity. Opaque and permanent: a ticker change never changes it. */
  instrumentId: string;
  assetClass: AssetClass;
  /** Current display symbol (history lives in the provider mappings). */
  symbol: string;
  name?: string;
  currency: string;
  exchange?: string;
  /** ISO 10383 market identifier, e.g. XNAS. */
  mic?: string;
  /** IANA time zone of the trading venue (UTC for crypto). Metadata only; data is stored in UTC. */
  timezone: string;
  tickSize?: string;
  lotSize?: string;
  /** Calendar id (see sessions.ts), e.g. "XNYS", "24x7", "FX-24x5". */
  tradingCalendar?: string;
  active: boolean;
  /** A few instruments (e.g. some futures, spreads) can trade below zero. Default false. */
  allowsNegativePrices?: boolean;
}

export interface ProviderInstrumentMapping {
  instrumentId: string;
  provider: string;
  providerInstrumentId?: string;
  providerSymbol: string;
  exchange?: string;
  /** Valid for instants t with validFrom <= t < validTo. */
  validFrom: string;
  validTo?: string;
}

export type BarInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export const BAR_INTERVALS: readonly BarInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
export type IntradayInterval = Exclude<BarInterval, '1d'>;
export const INTERVAL_MS: Readonly<Record<IntradayInterval, number>> = Object.freeze({ '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 });

export function isIntraday(interval: BarInterval): interval is IntradayInterval {
  return interval !== '1d';
}

/** regular / extended: exchange sessions; continuous: 24/7 (crypto) and 24/5 (forex) markets. */
export type BarSession = 'regular' | 'extended' | 'continuous';
/** Raw and adjusted data are different series and are never mixed. */
export type PriceAdjustment = 'raw' | 'split_adjusted' | 'total_return_adjusted';

export interface MarketBar {
  instrumentId: string;
  interval: BarInterval;
  /** Bar opens at startTime (inclusive) and closes at endTime (exclusive), UTC. Daily bars span the local trading date. */
  startTime: string;
  endTime: string;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  /** Absent when the source has no (reliable) volume, e.g. many forex feeds. Never invented. */
  volume?: Decimal;
  /** Market data source id (provider + dataset + environment), see MarketDataSource. */
  source: string;
  session: BarSession;
  adjustment: PriceAdjustment;
  /** False while the bar is still forming. Signals and backtests use final bars only by default. */
  isFinal: boolean;
  observedAt: string;
  availableAt: string;
  retrievedAt: string;
}

/** A bar as stored: every change of a bar becomes a new revision, nothing is overwritten. */
export interface StoredBar extends MarketBar {
  revision: number;
  /** Position in the per-instrument ingest sequence (reproducibility anchor, see storedThrough). */
  ingestSeq: number;
  contentHash: string;
}

export interface MarketQuote {
  instrumentId: string;
  source: string;
  last: Decimal;
  bid?: Decimal;
  ask?: Decimal;
  open?: Decimal;
  high?: Decimal;
  low?: Decimal;
  previousClose?: Decimal;
  volume?: Decimal;
  currency?: string;
  /** Provider's view whether the market was open; informational, the calendar decides. */
  marketOpen?: boolean;
  observedAt: string;
  availableAt: string;
  retrievedAt: string;
}

export interface StoredQuote extends MarketQuote {
  revision: number;
  ingestSeq: number;
  contentHash: string;
}

export type CorporateActionType = 'split' | 'reverse_split' | 'cash_dividend' | 'symbol_change';

export interface CorporateAction {
  /** Stable key per source, e.g. "split:2020-08-31". */
  actionKey: string;
  instrumentId: string;
  source: string;
  type: CorporateActionType;
  /** Ex-date as local trading date of the instrument's venue. */
  exDate: string;
  /** Shares before → after (4-for-1 split: 1 → 4; 1-for-10 reverse split: 10 → 1). */
  ratioFrom?: Decimal;
  ratioTo?: Decimal;
  cashAmount?: Decimal;
  currency?: string;
  oldSymbol?: string;
  newSymbol?: string;
  announcedAt?: string;
  availableAt: string;
  retrievedAt: string;
}

export interface StoredCorporateAction extends CorporateAction {
  revision: number;
  ingestSeq: number;
  contentHash: string;
}

export type SourceEnvironment = 'production' | 'demo' | 'test_fixture';
/** What the data license allows. "unreviewed" until a human has checked the provider's terms. */
export type LicenseClass = 'internal_use' | 'display_allowed' | 'redistributable' | 'not_redistributable' | 'unreviewed';

export interface MarketDataSource {
  /** e.g. "twelvedata:time_series:production" */
  sourceId: string;
  provider: string;
  dataset: string;
  environment: SourceEnvironment;
  license: LicenseClass;
  licenseNote?: string;
}

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

export type Severity = 'ok' | 'warning' | 'error' | 'critical';

export type DataQualityCode =
  | 'invalid_number'
  | 'invalid_ohlc'
  | 'negative_price'
  | 'invalid_volume'
  | 'invalid_time'
  | 'misaligned_interval'
  | 'outside_session'
  | 'duplicate'
  | 'conflicting_duplicate'
  | 'out_of_order'
  | 'gap'
  | 'missing_bars'
  | 'partial_bar'
  | 'future_timestamp'
  | 'not_yet_available'
  | 'stale'
  | 'mixed_series'
  | 'non_production_source'
  | 'calendar_unknown'
  | 'calendar_coverage'
  | 'final_regression'
  | 'revised'
  | 'provider_disagreement';

export interface DataQualityIssue {
  code: DataQualityCode;
  severity: Exclude<Severity, 'ok'>;
  message: string;
  /** Bar start of the affected bar, if any. */
  at?: string;
  count?: number;
}

export interface DataQualityResult {
  valid: boolean;
  severity: Severity;
  issues: DataQualityIssue[];
  usableForTrading: boolean;
  usableForBacktest: boolean;
}

export class DataQualityError extends Error {
  override readonly name = 'DataQualityError';
  readonly code = 'DATA_QUALITY_ERROR' as const;
  constructor(
    message: string,
    readonly issues: readonly DataQualityIssue[],
  ) {
    super(message);
  }
}

/** A record refused at ingestion. Kept for investigation, never used as market data. */
export interface QuarantineRecord {
  kind: 'bar' | 'quote' | 'corporate_action';
  instrumentId: string;
  source: string;
  receivedAt: string;
  reasons: DataQualityIssue[];
  /** The offending record as plain data (encoded, untrusted). */
  raw: unknown;
}
