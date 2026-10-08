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
export function validateBar(bar: MarketBar, rules: PriceRules = {}): DataQualityIssue[] {
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

/** Same bar with canonical UTC timestamps. Call only after validateBar() returned no issues. */
export function normalizeBar<T extends MarketBar>(bar: T): T {
  return {
    ...bar,
    startTime: toUtcIso(parseUtc(bar.startTime)),
    endTime: toUtcIso(parseUtc(bar.endTime)),
    observedAt: toUtcIso(parseUtc(bar.observedAt)),
    availableAt: toUtcIso(parseUtc(bar.availableAt)),
    retrievedAt: toUtcIso(parseUtc(bar.retrievedAt)),
  };
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
  const available = instant(action.availableAt, 'availableAt', issues, at);
  const retrieved = instant(action.retrievedAt, 'retrievedAt', issues, at);
  if (action.announcedAt !== undefined) instant(action.announcedAt, 'announcedAt', issues, at);
  if (available !== null && retrieved !== null && available > retrieved + CLOCK_SKEW_MS) issues.push(critical('future_timestamp', 'availableAt is after retrievedAt', at));
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

export function normalizeCorporateAction(action: CorporateAction): CorporateAction {
  return {
    ...action,
    availableAt: toUtcIso(parseUtc(action.availableAt)),
    retrievedAt: toUtcIso(parseUtc(action.retrievedAt)),
    ...(action.announcedAt !== undefined ? { announcedAt: toUtcIso(parseUtc(action.announcedAt)) } : {}),
  };
}

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
