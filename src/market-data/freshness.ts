// Freshness: is a quote / the latest bar recent enough for the intended use?
//
// There is no global "max age". A one-minute quote and a final daily bar have different lives:
//   * quotes while the market is open: short limits per asset class and use case
//   * quotes while the market is closed: fresh if they reflect the last session (observed near/after its close)
//   * bars: fresh if no more than N *expected* bars are missing according to the trading calendar,
//     so a Friday bar is still the latest stock bar on Sunday, but not the latest BTC bar.
// Limits are explicit configuration (reviewed in code), not tuned at runtime.

import type { AssetClass, BarInterval, MarketQuote } from './market-data-types.js';
import { isIntraday } from './market-data-types.js';
import type { SessionScope, TradingCalendar } from './sessions.js';
import { MINUTE_MS, HOUR_MS, parseUtc } from './time.js';

export type FreshnessUseCase = 'trading' | 'analysis' | 'backtest';

export interface FreshnessPolicy {
  /** Max quote age while the market is open. */
  quoteMaxAgeOpenMs: Readonly<Record<AssetClass, Readonly<Record<FreshnessUseCase, number>>>>;
  /** While closed, a quote counts as current if observed at most this long before the last close. */
  closedMarketQuoteGraceMs: number;
  /** Time after a bar's completion until the provider is expected to deliver it. */
  barSettleMs: { intraday: number; daily: number };
  /** Expected-but-missing complete bars tolerated before the series counts as stale. */
  allowedMissingBars: Readonly<Record<FreshnessUseCase, { intraday: number; daily: number }>>;
}

const QUOTE_LIMITS = (trading: number) => Object.freeze({ trading, analysis: 5 * MINUTE_MS, backtest: 5 * MINUTE_MS });

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = Object.freeze({
  quoteMaxAgeOpenMs: Object.freeze({
    stock: QUOTE_LIMITS(15_000),
    etf: QUOTE_LIMITS(15_000),
    index: QUOTE_LIMITS(15_000),
    commodity: QUOTE_LIMITS(15_000),
    future: QUOTE_LIMITS(15_000),
    forex: QUOTE_LIMITS(10_000),
    crypto: QUOTE_LIMITS(10_000),
  }),
  closedMarketQuoteGraceMs: 15 * MINUTE_MS,
  barSettleMs: { intraday: 2 * MINUTE_MS, daily: HOUR_MS },
  allowedMissingBars: Object.freeze({
    trading: { intraday: 1, daily: 0 },
    analysis: { intraday: 3, daily: 1 },
    backtest: { intraday: 3, daily: 1 },
  }),
});

export interface FreshnessVerdict {
  status: 'fresh' | 'stale' | 'unknown';
  fresh: boolean;
  reason: string;
  ageMs?: number;
  limitMs?: number;
  missingBars?: number;
  marketOpen: boolean | null;
  /** The answer relies on a session outside the calendar's verified coverage. */
  calendarAssumed: boolean;
}

export function assessQuoteFreshness(
  quote: Pick<MarketQuote, 'observedAt'>,
  ctx: { assetClass: AssetClass; calendar: TradingCalendar | null; asOf: string; useCase: FreshnessUseCase; policy?: FreshnessPolicy; scope?: SessionScope },
): FreshnessVerdict {
  const policy = ctx.policy ?? DEFAULT_FRESHNESS_POLICY;
  const asOf = parseUtc(ctx.asOf);
  const observed = parseUtc(quote.observedAt);
  const ageMs = asOf - observed;
  if (ageMs < 0) return { status: 'stale', fresh: false, reason: 'quote observed after asOf (look-ahead)', ageMs, marketOpen: null, calendarAssumed: false };
  if (!ctx.calendar) return { status: 'unknown', fresh: false, reason: 'no trading calendar', ageMs, marketOpen: null, calendarAssumed: false };
  const session = ctx.calendar.sessionAt(asOf, ctx.scope ?? 'regular');
  if (session) {
    const limitMs = policy.quoteMaxAgeOpenMs[ctx.assetClass][ctx.useCase];
    const fresh = ageMs <= limitMs && !(session.assumed && ctx.useCase === 'trading');
    return {
      status: fresh ? 'fresh' : 'stale',
      fresh,
      reason: ageMs <= limitMs ? (session.assumed && ctx.useCase === 'trading' ? 'session outside verified calendar coverage' : 'within limit for open market') : 'older than ' + limitMs + ' ms while the market is open',
      ageMs,
      limitMs,
      marketOpen: true,
      calendarAssumed: session.assumed,
    };
  }
  const lastClose = ctx.calendar.lastCloseAtOrBefore(asOf, ctx.scope ?? 'regular');
  if (lastClose === null) return { status: 'unknown', fresh: false, reason: 'no previous session found', ageMs, marketOpen: false, calendarAssumed: false };
  const fresh = observed >= lastClose - policy.closedMarketQuoteGraceMs;
  return { status: fresh ? 'fresh' : 'stale', fresh, reason: fresh ? 'reflects the last session' : 'older than the last session close', ageMs, marketOpen: false, calendarAssumed: false };
}

export function assessBarFreshness(
  lastBarStart: string,
  ctx: { interval: BarInterval; calendar: TradingCalendar | null; asOf: string; useCase: FreshnessUseCase; policy?: FreshnessPolicy; scope?: SessionScope },
): FreshnessVerdict {
  const policy = ctx.policy ?? DEFAULT_FRESHNESS_POLICY;
  const asOf = parseUtc(ctx.asOf);
  const start = parseUtc(lastBarStart);
  const kind = isIntraday(ctx.interval) ? 'intraday' : 'daily';
  if (!ctx.calendar) return { status: 'unknown', fresh: false, reason: 'no trading calendar', marketOpen: null, calendarAssumed: false };
  const scope = ctx.scope ?? 'regular';
  const marketOpen = ctx.calendar.isOpen(asOf, scope);
  const expected = ctx.calendar.latestCompletedBarStart(asOf, ctx.interval, scope, policy.barSettleMs[kind]);
  if (expected === null) return { status: 'unknown', fresh: false, reason: 'calendar cannot determine the latest expected bar', marketOpen, calendarAssumed: false };
  if (start >= expected) return { status: 'fresh', fresh: true, reason: 'latest expected bar present', missingBars: 0, marketOpen, calendarAssumed: false };
  const allowed = policy.allowedMissingBars[ctx.useCase][kind];
  const between = ctx.calendar.expectedStartsBetween(start, expected + 1, ctx.interval, scope, allowed + 1);
  const missingBars = between.starts.length;
  const fresh = missingBars <= allowed;
  return {
    status: fresh ? 'fresh' : 'stale',
    fresh,
    reason: fresh ? missingBars + ' expected bar(s) not yet delivered (tolerated)' : (between.truncated ? 'more than ' : '') + missingBars + ' expected bar(s) missing since the last bar',
    missingBars,
    marketOpen,
    calendarAssumed: between.assumed > 0,
  };
}
