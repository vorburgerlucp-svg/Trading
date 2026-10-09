// Canonical market data model. Provider-neutral: no provider IDs or symbols leak into the domain
// except through ProviderInstrumentMapping.
//
// Prices are exact Decimals (never binary floats). Every instant is a UTC ISO string ("...Z").
// Every piece of market information carries point-in-time facts (see docs/MARKET_BAR_PROVENANCE.md for bars):
//   observedAt  – MARKET OBSERVABILITY: when the value was true at the source (bar completion / quote time)
//   availableAt – replay gate of the default historical reconstruction: a replay at T uses it only if availableAt <= T.
//                 For bars it is never a claim that NEXUS held the value then (that is `knowledge`).
//   retrievedAt – when NEXUS fetched it
//   knowledge   – DATA REVISION KNOWLEDGE of a bar revision: how, and from when, this exact revision is provably known

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

/**
 * How a bar REVISION is known. Market observability (observedAt) is not knowledge: a revision of a bar completed in 2020 can be
 * retrieved in 2026, and then it is a reconstruction, not proof that NEXUS held it in 2020.
 *   captured_by_nexus                NEXUS received this revision live. revisionKnownAt = retrievedAt. Strong.
 *   provider_published_at            the provider states when this revision was published. revisionKnownAt = that time. Not used by Twelve Data.
 *   historical_bar_reconstruction    a historical backfill: window, values and market existence are known; the exact vintage is not. revisionKnownAt = null.
 *   legacy_unproven                  stored before provenance existed. revisionKnownAt = null. Never invented, never strict.
 */
export type BarKnowledgeProvenance = 'captured_by_nexus' | 'provider_published_at' | 'historical_bar_reconstruction' | 'legacy_unproven';

/** Provenances that prove when a revision was known. Only these can support strict point-in-time use. */
export const PROVEN_BAR_PROVENANCE: readonly BarKnowledgeProvenance[] = ['captured_by_nexus', 'provider_published_at'];

export interface BarRevisionKnowledge {
  provenance: BarKnowledgeProvenance;
  /** ISO UTC instant from which this exact revision is provably held. null unless the provenance proves it. */
  revisionKnownAt: string | null;
}

/** How a replay reads bars. Strict replay refuses what it cannot prove (fail closed). */
export type BarReplayMode = 'historical_reconstruction' | 'strict_point_in_time';

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
  /** MARKET OBSERVABILITY: the instant the value was complete (final bar) or observed (in-progress bar) at the source. */
  observedAt: string;
  /** Historical replay gate (market observability plus the NEXUS revision floor). Not a knowledge claim: see `knowledge`. */
  availableAt: string;
  /** NEXUS capture of this revision. */
  retrievedAt: string;
  /** DATA REVISION KNOWLEDGE: how this exact revision is known. Required on every bar. */
  knowledge: BarRevisionKnowledge;
}

/** A bar as stored: every change of a bar becomes a new revision, nothing is overwritten. */
export interface StoredBar extends MarketBar {
  revision: number;
  /** Position in the per-instrument ingest sequence (reproducibility anchor, see storedThrough). */
  ingestSeq: number;
  /** Economic content identity (change detection between revisions). Excludes provenance and retrieval. */
  contentHash: string;
  /** Integrity of observability, gate, retrieval and knowledge. null for legacy rows, where there was nothing to protect. */
  provenanceHash: string | null;
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

/**
 * How NEXUS can prove when a corporate-action record was known. A knowledge time is never derived from the ex-date.
 *   provider_published_at               the provider states a publication time; knowledgeAt = that time (<= retrievedAt)
 *   provider_announced_at               the provider states an announcement time; knowledgeAt = announcedAt
 *   captured_by_nexus                   NEXUS first retrieved this record; knowledgeAt = retrievedAt
 *   historical_effective_date_inference imported without proof; knowledgeAt = null. Economic reconstruction only.
 *   legacy_unproven                     stored before provenance existed; knowledgeAt = null. Economic reconstruction only.
 */
export type CorporateActionKnowledgeProvenance = 'provider_published_at' | 'provider_announced_at' | 'captured_by_nexus' | 'historical_effective_date_inference' | 'legacy_unproven';

/** Provenances that prove a knowledge time. Only these may support information (strategy, quant, scanner) knowledge. */
export const PROVEN_KNOWLEDGE_PROVENANCE: readonly CorporateActionKnowledgeProvenance[] = ['provider_published_at', 'provider_announced_at', 'captured_by_nexus'];

export interface CorporateActionKnowledge {
  provenance: CorporateActionKnowledgeProvenance;
  /** ISO UTC instant from which the record is provably known. null unless the provenance proves it. */
  knowledgeAt: string | null;
}

export interface CorporateAction {
  /** Stable key per source, e.g. "split:2020-08-31". */
  actionKey: string;
  instrumentId: string;
  source: string;
  type: CorporateActionType;
  /** ECONOMIC effective time: the ex-date, a local trading date of the venue. Positions and prices change on it. Not evidence of knowledge. */
  exDate: string;
  /** Shares before → after (4-for-1 split: 1 → 4; 1-for-10 reverse split: 10 → 1). */
  ratioFrom?: Decimal;
  ratioTo?: Decimal;
  cashAmount?: Decimal;
  currency?: string;
  oldSymbol?: string;
  newSymbol?: string;
  /** Provider-stated announcement time when given. Data only: it proves knowledge only with provenance provider_announced_at. */
  announcedAt?: string;
  /** NEXUS capture time of this record (a retrieval fact). Not knowledge of the market. */
  retrievedAt: string;
  /** INFORMATION time: when the record is provably known. Separate from exDate and from retrievedAt. */
  knowledge: CorporateActionKnowledge;
}

export interface StoredCorporateAction extends CorporateAction {
  revision: number;
  ingestSeq: number;
  /** Economic content identity (change detection between revisions). */
  contentHash: string;
  /** Storage visibility (database available_at). Equals retrievedAt for records stored after provenance existed. Not knowledge. */
  storedAvailableAt: string;
  /** Integrity of retrievedAt and knowledge fields. null for legacy rows, where there was nothing to protect. */
  provenanceHash: string | null;
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
  | 'provider_disagreement'
  | 'vintage_not_proven'
  | 'legacy_provenance_unproven';

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
