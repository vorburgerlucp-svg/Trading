// Structural validation of single market data records. A record that fails is never repaired:
// it is refused (quarantined) with the reasons. Series-level checks live in data-quality.ts.

import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import {
  BAR_INTERVALS,
  INTERVAL_MS,
  isIntraday,
  type CorporateAction,
  type DataQualityIssue,
  type MarketBar,
  type MarketQuote,
  type StoredBar,
  type StoredCorporateAction,
} from './market-data-types.js';
import { HOUR_MS, MINUTE_MS, isLocalDate, parseUtc, toUtcIso } from './time.js';

/** Clock skew tolerated between provider timestamps and our retrieval clock. */
export const CLOCK_SKEW_MS = 5 * MINUTE_MS;

const SESSIONS = ['regular', 'extended', 'continuous'] as const;
const ADJUSTMENTS = ['raw', 'split_adjusted', 'total_return_adjusted'] as const;
const CURRENCY = /^[A-Z]{3}$/;

export interface PriceRules {
  /** Instruments that can legitimately trade at or below zero. */
  allowsNegativePrices?: boolean;
}

function critical(code: DataQualityIssue['code'], message: string, at?: string): DataQualityIssue {
  return { code, severity: 'critical', message, ...(at !== undefined ? { at } : {}) };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 200;
}

function instant(value: unknown, field: string, issues: DataQualityIssue[], at?: string): number | null {
  try {
    return parseUtc(value as string);
  } catch (error) {
    issues.push(critical('invalid_time', field + ': ' + (error instanceof Error ? error.message : 'invalid'), at));
    return null;
  }
}

function price(value: unknown, field: string, rules: PriceRules, issues: DataQualityIssue[], at?: string): Decimal | null {
  if (!(value instanceof Decimal)) {
    issues.push(critical('invalid_number', field + ' is not an exact decimal', at));
    return null;
  }
  if (!rules.allowsNegativePrices && !value.isPositive()) issues.push(critical('negative_price', field + ' is not positive (' + value.toString() + ')', at));
  return value;
}

/** Structural checks of one bar. Empty result = structurally valid. */
export function validateBar(bar: MarketBar, rules: PriceRules = {}, options: { ingest?: boolean } = {}): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  const at = typeof bar?.startTime === 'string' ? bar.startTime : undefined;
  if (!bar || typeof bar !== 'object') return [critical('invalid_number', 'bar is not an object')];
  if (!nonEmpty(bar.instrumentId)) issues.push(critical('invalid_number', 'instrumentId missing', at));
  if (!nonEmpty(bar.source)) issues.push(critical('invalid_number', 'source missing', at));
  if (!BAR_INTERVALS.includes(bar.interval)) issues.push(critical('misaligned_interval', 'unknown interval ' + String(bar.interval).slice(0, 20), at));
  if (!SESSIONS.includes(bar.session)) issues.push(critical('invalid_number', 'unknown session ' + String(bar.session).slice(0, 20), at));
  if (!ADJUSTMENTS.includes(bar.adjustment)) issues.push(critical('invalid_number', 'unknown adjustment ' + String(bar.adjustment).slice(0, 30), at));
  if (typeof bar.isFinal !== 'boolean') issues.push(critical('invalid_number', 'isFinal must be boolean', at));

  const start = instant(bar.startTime, 'startTime', issues, at);
  const end = instant(bar.endTime, 'endTime', issues, at);
  const observed = instant(bar.observedAt, 'observedAt', issues, at);
  const available = instant(bar.availableAt, 'availableAt', issues, at);
  const retrieved = instant(bar.retrievedAt, 'retrievedAt', issues, at);

  if (start !== null && end !== null && BAR_INTERVALS.includes(bar.interval)) {
    const span = end - start;
    if (span <= 0) issues.push(critical('misaligned_interval', 'endTime must be after startTime', at));
    else if (isIntraday(bar.interval) && span > INTERVAL_MS[bar.interval]) issues.push(critical('misaligned_interval', 'bar spans ' + span + ' ms, more than its interval ' + bar.interval, at));
    else if (!isIntraday(bar.interval) && (span < 22 * HOUR_MS || span > 26 * HOUR_MS)) issues.push(critical('misaligned_interval', 'daily bar must span one local day (got ' + span + ' ms)', at));
  }
  if (retrieved !== null) {
    if (start !== null && start > retrieved + CLOCK_SKEW_MS) issues.push(critical('future_timestamp', 'bar starts after it was retrieved', at));
    if (observed !== null && observed > retrieved + CLOCK_SKEW_MS) issues.push(critical('future_timestamp', 'observedAt is after retrievedAt', at));
    if (available !== null && available > retrieved + CLOCK_SKEW_MS) issues.push(critical('future_timestamp', 'availableAt is after retrievedAt', at));
    if (bar.isFinal === true && isIntraday(bar.interval) && end !== null && end > retrieved + CLOCK_SKEW_MS) issues.push(critical('future_timestamp', 'a final bar cannot end after it was retrieved', at));
  }
  if (start !== null && available !== null && available < start) issues.push(critical('invalid_time', 'availableAt before the bar started', at));
  if (observed !== null && available !== null && available < observed) issues.push(critical('invalid_time', 'availableAt before observedAt', at));
  issues.push(...barKnowledgeIssues(bar, observed, retrieved, at, options.ingest === true));
  if (bar.isFinal === true && isIntraday(bar.interval) && end !== null && available !== null && available < end) issues.push(critical('invalid_time', 'a final intraday bar cannot be available before it ended', at));

  const o = price(bar.open, 'open', rules, issues, at);
  const h = price(bar.high, 'high', rules, issues, at);
  const l = price(bar.low, 'low', rules, issues, at);
  const c = price(bar.close, 'close', rules, issues, at);
  if (o && h && l && c) {
    const problems: string[] = [];
    if (h.lt(o)) problems.push('high < open');
    if (h.lt(c)) problems.push('high < close');
    if (h.lt(l)) problems.push('high < low');
    if (l.gt(o)) problems.push('low > open');
    if (l.gt(c)) problems.push('low > close');
    if (problems.length > 0) issues.push(critical('invalid_ohlc', problems.join(', '), at));
  }
  if (bar.volume !== undefined) {
    if (!(bar.volume instanceof Decimal)) issues.push(critical('invalid_volume', 'volume is not an exact decimal', at));
    else if (bar.volume.isNegative()) issues.push(critical('invalid_volume', 'volume is negative', at));
  }
  return issues;
}

/** Provenances NEXUS may write for a bar revision. legacy_unproven exists only on rows stored before provenance existed. */
const BAR_INGEST_PROVENANCE = ['captured_by_nexus', 'provider_published_at', 'historical_bar_reconstruction'] as const;

/**
 * Revision knowledge must be proven by its provenance and must never precede what it proves. A historical reconstruction
 * has no knowledge time: NEXUS does not claim to have held that exact vintage then. A captured revision is known exactly at
 * its retrieval. Nothing can be known before a final bar was complete. A legacy row (no provenance) is readable as legacy;
 * it is refused only at ingest, where nothing may be labelled legacy.
 */
function barKnowledgeIssues(bar: MarketBar, observed: number | null, retrieved: number | null, at: string | undefined, ingest: boolean): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  const k = bar.knowledge;
  if (!k || typeof k !== 'object' || k.provenance === 'legacy_unproven') {
    if (ingest) issues.push(critical('invalid_time', 'knowledge provenance must be one of the ingest provenances (legacy_unproven cannot be ingested)', at));
    else if (k && typeof k === 'object' && k.revisionKnownAt !== null) issues.push(critical('invalid_time', 'a legacy revision has no knowledge time', at));
    return issues;
  }
  if (!(BAR_INGEST_PROVENANCE as readonly string[]).includes(k.provenance)) {
    issues.push(critical('invalid_time', 'unknown knowledge provenance', at));
    return issues;
  }
  if (k.provenance === 'historical_bar_reconstruction') {
    if (k.revisionKnownAt !== null) issues.push(critical('invalid_time', 'a historical reconstruction has no revision knowledge time', at));
    return issues;
  }
  const known = instant(k.revisionKnownAt, 'revisionKnownAt', issues, at);
  if (known === null || retrieved === null) return issues;
  if (k.provenance === 'captured_by_nexus' && known !== retrieved) issues.push(critical('invalid_time', 'a captured revision is known exactly at its retrieval', at));
  if (known > retrieved + CLOCK_SKEW_MS) issues.push(critical('future_timestamp', 'revisionKnownAt is after retrievedAt: NEXUS cannot have held what it did not yet retrieve', at));
  if (bar.isFinal === true && observed !== null && known < observed) issues.push(critical('invalid_time', 'a final bar cannot be known before it was complete (look-ahead)', at));
  return issues;
}

/** Same bar with canonical UTC timestamps. Call only after validateBar() returned no issues. */
export function normalizeBar<T extends MarketBar>(bar: T): T {
  return {
    ...bar,
    startTime: toUtcIso(parseUtc(bar.startTime)),
    endTime: toUtcIso(parseUtc(bar.endTime)),
    observedAt: toUtcIso(parseUtc(bar.observedAt)),
    availableAt: toUtcIso(parseUtc(bar.availableAt)),
    retrievedAt: toUtcIso(parseUtc(bar.retrievedAt)),
    knowledge: {
      provenance: bar.knowledge.provenance,
      revisionKnownAt: bar.knowledge.revisionKnownAt === null ? null : toUtcIso(parseUtc(bar.knowledge.revisionKnownAt)),
    },
  };
}

/**
 * Integrity of what the content hash does not cover: the bar's observability and gate, when NEXUS retrieved it, and what
 * proves its revision knowledge. Verified on every read; a privileged change of any of them fails closed.
 */
export function barProvenanceHash(bar: Pick<StoredBar, 'instrumentId' | 'source' | 'interval' | 'session' | 'adjustment' | 'startTime' | 'contentHash' | 'retrievedAt' | 'observedAt' | 'availableAt' | 'knowledge'>): string {
  return hashOf({
    contentVersion: 'market-bar-provenance:v1',
    key: barKey(bar),
    contentHash: bar.contentHash,
    retrievedAt: bar.retrievedAt,
    observedAt: bar.observedAt,
    availableAt: bar.availableAt,
    knowledgeProvenance: bar.knowledge.provenance,
    revisionKnownAt: bar.knowledge.revisionKnownAt,
  });
}

/** Identity of a bar within its series (one row per revision in storage). */
export function barKey(bar: Pick<MarketBar, 'instrumentId' | 'source' | 'interval' | 'session' | 'adjustment' | 'startTime'>): string {
  return [bar.instrumentId, bar.source, bar.interval, bar.session, bar.adjustment, bar.startTime].join('|');
}

/** Hash of what the bar SAYS (prices, volume, window, finality); retrieval timestamps are not content. */
export function barContentHash(bar: MarketBar): string {
  return hashOf({
    instrumentId: bar.instrumentId,
    source: bar.source,
    interval: bar.interval,
    session: bar.session,
    adjustment: bar.adjustment,
    startTime: bar.startTime,
    endTime: bar.endTime,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume ?? null,
    isFinal: bar.isFinal,
  });
}

export function validateQuote(quote: MarketQuote, rules: PriceRules = {}): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  if (!quote || typeof quote !== 'object') return [critical('invalid_number', 'quote is not an object')];
  const at = typeof quote.observedAt === 'string' ? quote.observedAt : undefined;
  if (!nonEmpty(quote.instrumentId) || !nonEmpty(quote.source)) issues.push(critical('invalid_number', 'instrumentId/source missing', at));
  const observed = instant(quote.observedAt, 'observedAt', issues, at);
  const available = instant(quote.availableAt, 'availableAt', issues, at);
  const retrieved = instant(quote.retrievedAt, 'retrievedAt', issues, at);
  if (retrieved !== null) {
    if (observed !== null && observed > retrieved + CLOCK_SKEW_MS) issues.push(critical('future_timestamp', 'quote observed after it was retrieved', at));
    if (available !== null && available > retrieved + CLOCK_SKEW_MS) issues.push(critical('future_timestamp', 'availableAt is after retrievedAt', at));
  }
  if (observed !== null && available !== null && available < observed) issues.push(critical('invalid_time', 'availableAt before observedAt', at));
  price(quote.last, 'last', rules, issues, at);
  for (const field of ['bid', 'ask', 'open', 'high', 'low', 'previousClose'] as const) {
    if (quote[field] !== undefined) price(quote[field], field, rules, issues, at);
  }
  if (quote.bid instanceof Decimal && quote.ask instanceof Decimal && quote.bid.gt(quote.ask)) issues.push(critical('invalid_ohlc', 'bid above ask', at));
  if (quote.high instanceof Decimal && quote.low instanceof Decimal && quote.high.lt(quote.low)) issues.push(critical('invalid_ohlc', 'high below low', at));
  if (quote.volume !== undefined && (!(quote.volume instanceof Decimal) || quote.volume.isNegative())) issues.push(critical('invalid_volume', 'volume invalid', at));
  if (quote.currency !== undefined && !CURRENCY.test(quote.currency)) issues.push(critical('invalid_number', 'currency must be ISO 4217', at));
  return issues;
}

export function normalizeQuote(quote: MarketQuote): MarketQuote {
  return { ...quote, observedAt: toUtcIso(parseUtc(quote.observedAt)), availableAt: toUtcIso(parseUtc(quote.availableAt)), retrievedAt: toUtcIso(parseUtc(quote.retrievedAt)) };
}

export function quoteContentHash(quote: MarketQuote): string {
  return hashOf({
    instrumentId: quote.instrumentId,
    source: quote.source,
    observedAt: quote.observedAt,
    last: quote.last,
    bid: quote.bid ?? null,
    ask: quote.ask ?? null,
    open: quote.open ?? null,
    high: quote.high ?? null,
    low: quote.low ?? null,
    previousClose: quote.previousClose ?? null,
    volume: quote.volume ?? null,
    currency: quote.currency ?? null,
    marketOpen: quote.marketOpen ?? null,
  });
}

const ACTION_TYPES = ['split', 'reverse_split', 'cash_dividend', 'symbol_change'] as const;

export function validateCorporateAction(action: CorporateAction): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  if (!action || typeof action !== 'object') return [critical('invalid_number', 'corporate action is not an object')];
  const at = typeof action.exDate === 'string' ? action.exDate : undefined;
  if (!nonEmpty(action.actionKey) || !nonEmpty(action.instrumentId) || !nonEmpty(action.source)) issues.push(critical('invalid_number', 'actionKey/instrumentId/source missing', at));
  if (!ACTION_TYPES.includes(action.type)) issues.push(critical('invalid_number', 'unknown corporate action type', at));
  if (typeof action.exDate !== 'string' || !isLocalDate(action.exDate)) issues.push(critical('invalid_time', 'exDate must be YYYY-MM-DD', at));
  const retrieved = instant(action.retrievedAt, 'retrievedAt', issues, at);
  if (action.announcedAt !== undefined) instant(action.announcedAt, 'announcedAt', issues, at);
  issues.push(...knowledgeIssues(action, retrieved, at));
  if (action.type === 'split' || action.type === 'reverse_split') {
    const from = action.ratioFrom;
    const to = action.ratioTo;
    if (!(from instanceof Decimal) || !(to instanceof Decimal) || !from.isPositive() || !to.isPositive()) issues.push(critical('invalid_number', 'split ratio must be two positive decimals', at));
    else if (action.type === 'split' && !to.gt(from)) issues.push(critical('invalid_number', 'a split must increase the share count (ratioTo > ratioFrom)', at));
    else if (action.type === 'reverse_split' && !to.lt(from)) issues.push(critical('invalid_number', 'a reverse split must decrease the share count (ratioTo < ratioFrom)', at));
  }
  if (action.type === 'cash_dividend') {
    if (!(action.cashAmount instanceof Decimal) || action.cashAmount.isNegative()) issues.push(critical('invalid_number', 'dividend amount must be a non-negative decimal', at));
    if (action.currency !== undefined && !CURRENCY.test(action.currency)) issues.push(critical('invalid_number', 'currency must be ISO 4217', at));
  }
  if (action.type === 'symbol_change' && (!nonEmpty(action.oldSymbol) || !nonEmpty(action.newSymbol))) issues.push(critical('invalid_number', 'symbol change needs oldSymbol and newSymbol', at));
  return issues;
}

/** Provenances NEXUS may write. legacy_unproven exists only on rows stored before provenance was introduced. */
const INGEST_PROVENANCE = ['provider_published_at', 'provider_announced_at', 'captured_by_nexus', 'historical_effective_date_inference'] as const;

/**
 * A knowledge time must be proven by its provenance. It is never a free value and never the ex-date. A provider timestamp
 * cannot lie after NEXUS retrieved the record, because NEXUS cannot hold what was not yet known.
 */
function knowledgeIssues(action: CorporateAction, retrieved: number | null, at: string | undefined): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  const k = action.knowledge;
  if (!k || typeof k !== 'object' || !(INGEST_PROVENANCE as readonly string[]).includes(k.provenance)) {
    issues.push(critical('invalid_time', 'knowledge provenance must be one of the ingest provenances (legacy_unproven cannot be ingested)', at));
    return issues;
  }
  if (k.provenance === 'historical_effective_date_inference') {
    if (k.knowledgeAt !== null) issues.push(critical('invalid_time', 'an inferred record has no knowledge time', at));
    return issues;
  }
  const known = instant(k.knowledgeAt, 'knowledgeAt', issues, at);
  if (known === null || retrieved === null) return issues;
  if (k.provenance === 'captured_by_nexus' && known !== retrieved) issues.push(critical('invalid_time', 'a captured record is known exactly at its retrieval', at));
  if (known > retrieved + CLOCK_SKEW_MS) issues.push(critical('future_timestamp', 'knowledgeAt is after retrievedAt: NEXUS cannot have retrieved what was not yet known', at));
  if (k.provenance === 'provider_announced_at' && (action.announcedAt === undefined || parseUtc(action.announcedAt) !== known)) {
    issues.push(critical('invalid_time', 'provider_announced_at needs announcedAt equal to knowledgeAt', at));
  }
  return issues;
}

export function normalizeCorporateAction(action: CorporateAction): CorporateAction {
  return {
    ...action,
    retrievedAt: toUtcIso(parseUtc(action.retrievedAt)),
    ...(action.announcedAt !== undefined ? { announcedAt: toUtcIso(parseUtc(action.announcedAt)) } : {}),
    knowledge: {
      provenance: action.knowledge.provenance,
      knowledgeAt: action.knowledge.knowledgeAt === null ? null : toUtcIso(parseUtc(action.knowledge.knowledgeAt)),
    },
  };
}

/**
 * Economic content identity: change detection between revisions. Its definition is unchanged, so rows stored before
 * provenance keep their hash. Retrieval and knowledge are deliberately NOT part of it: a re-fetch of the same economic record
 * must not become a new revision, and the first capture keeps its knowledge.
 */
export function corporateActionContentHash(action: CorporateAction): string {
  return hashOf({
    actionKey: action.actionKey,
    instrumentId: action.instrumentId,
    source: action.source,
    type: action.type,
    exDate: action.exDate,
    ratioFrom: action.ratioFrom ?? null,
    ratioTo: action.ratioTo ?? null,
    cashAmount: action.cashAmount ?? null,
    currency: action.currency ?? null,
    oldSymbol: action.oldSymbol ?? null,
    newSymbol: action.newSymbol ?? null,
    announcedAt: action.announcedAt ?? null,
  });
}

/**
 * Integrity of what the content hash does not cover: when NEXUS retrieved the record and what proves its knowledge time.
 * Verified on every read, so a privileged change of either is detected.
 */
export function corporateActionProvenanceHash(action: Pick<StoredCorporateAction, 'instrumentId' | 'source' | 'actionKey' | 'contentHash' | 'retrievedAt' | 'knowledge'>): string {
  return hashOf({
    contentVersion: 'corporate-action-provenance:v1',
    key: [action.instrumentId, action.source, action.actionKey].join('|'),
    contentHash: action.contentHash,
    retrievedAt: action.retrievedAt,
    knowledgeProvenance: action.knowledge.provenance,
    knowledgeAt: action.knowledge.knowledgeAt,
  });
}
