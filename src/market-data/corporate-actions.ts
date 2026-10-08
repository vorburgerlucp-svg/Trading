// Corporate actions and point-in-time split adjustment.
//
// NEXUS keeps RAW bars as the canonical source. A split-adjusted view is derived for a given asOf:
// only splits that were known at asOf (availableAt <= asOf) and whose ex-date has been reached by
// asOf are applied. A split announced or effective after asOf can therefore never leak into a
// historical computation. The derived bars carry availableAt = max(bar, splits applied), because an
// adjusted price is only knowable once the split is known.
//
// Derived bars are never stored (no mixing with provider-adjusted series); they keep the source of
// the raw bars and say adjustment = "split_adjusted". Total-return (dividend) adjustment is NOT
// implemented in V1; dividends are stored as events only.

import { Decimal, type RoundingMode } from '../money/decimal.js';
import { DataQualityError, type CorporateAction, type MarketBar } from './market-data-types.js';
import type { TradingCalendar } from './sessions.js';
import { localDateOf, parseUtc, toUtcIso } from './time.js';

export const SPLIT_ADJUSTMENT_VERSION = 'split-adjust:pit:v1';
/** Extra decimal places kept when a price is divided by a split ratio; rounding is half-even. */
export const SPLIT_PRICE_EXTRA_SCALE = 6;
const ROUNDING: RoundingMode = 'half_even';

export interface SplitApplication {
  actionKey: string;
  exDate: string;
  ratioFrom: string;
  ratioTo: string;
  availableAt: string;
}

export interface SplitAdjustedSeries {
  bars: MarketBar[];
  applied: SplitApplication[];
  /** Splits known at asOf but not yet effective (ex-date after asOf) — informational only. */
  pending: SplitApplication[];
  version: string;
}

function application(a: CorporateAction): SplitApplication {
  return { actionKey: a.actionKey, exDate: a.exDate, ratioFrom: a.ratioFrom!.toString(), ratioTo: a.ratioTo!.toString(), availableAt: a.availableAt };
}

/** Trading date of a bar for split purposes (a split takes effect at the start of its ex-date session). */
function barTradingDate(bar: MarketBar, calendar: TradingCalendar): string {
  const start = parseUtc(bar.startTime);
  return bar.interval === '1d' ? calendar.dailyBarDate(start) : localDateOf(start, calendar.timezone);
}

export function splitAdjustBars(rawBars: readonly MarketBar[], actions: readonly CorporateAction[], ctx: { asOf: string; calendar: TradingCalendar }): SplitAdjustedSeries {
  const asOfMs = parseUtc(ctx.asOf);
  const asOfDate = localDateOf(asOfMs, ctx.calendar.timezone);
  for (const bar of rawBars) {
    if (bar.adjustment !== 'raw') {
      throw new DataQualityError('split adjustment needs raw bars; got ' + bar.adjustment, [{ code: 'mixed_series', severity: 'error', message: 'raw and adjusted bars must never be mixed', at: bar.startTime }]);
    }
  }
  const known = actions
    .filter((a) => (a.type === 'split' || a.type === 'reverse_split') && parseUtc(a.availableAt) <= asOfMs)
    .sort((a, b) => (a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : a.actionKey < b.actionKey ? -1 : 1));
  const effective = known.filter((a) => a.exDate <= asOfDate);
  const pending = known.filter((a) => a.exDate > asOfDate).map(application);

  const bars = rawBars.map((bar) => {
    const date = barTradingDate(bar, ctx.calendar);
    const later = effective.filter((a) => a.exDate > date);
    if (later.length === 0) return { ...bar, adjustment: 'split_adjusted' as const };
    // Price factor = Π from/to; volume factor = Π to/from. Exact numerator/denominator, one rounding per price.
    let num = Decimal.ONE;
    let den = Decimal.ONE;
    // The derived value exists only once bar AND splits are known: both timestamps move forward.
    let availableAt = parseUtc(bar.availableAt);
    let retrievedAt = parseUtc(bar.retrievedAt);
    for (const a of later) {
      num = num.times(a.ratioFrom!);
      den = den.times(a.ratioTo!);
      availableAt = Math.max(availableAt, parseUtc(a.availableAt));
      retrievedAt = Math.max(retrievedAt, parseUtc(a.retrievedAt));
    }
    const adjust = (p: Decimal) => p.times(num).dividedBy(den, Math.max(p.scale, 2) + SPLIT_PRICE_EXTRA_SCALE, ROUNDING);
    const adjusted: MarketBar = {
      ...bar,
      open: adjust(bar.open),
      high: adjust(bar.high),
      low: adjust(bar.low),
      close: adjust(bar.close),
      adjustment: 'split_adjusted',
      availableAt: toUtcIso(availableAt),
      retrievedAt: toUtcIso(retrievedAt),
    };
    if (bar.volume !== undefined) adjusted.volume = bar.volume.times(den).dividedBy(num, bar.volume.scale + SPLIT_PRICE_EXTRA_SCALE, ROUNDING);
    else delete adjusted.volume;
    return adjusted;
  });
  return { bars, applied: effective.map(application), pending, version: SPLIT_ADJUSTMENT_VERSION };
}
