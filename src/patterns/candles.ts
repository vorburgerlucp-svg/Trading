// Deterministic candlestick catalog (candlestick-policy:v1, candle-geometry:v1, candle-context:v1; docs/PATTERN_ENGINE_V1C.md §3–§11). Every rule
// is exact Decimal arithmetic on the bars. ATR is used only as the scale of ATR-normalised thresholds. A candle group is complete when its last
// candle is a usable final bar. Context is price-only and uses only bars before the candle.

import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import { scaleAt } from './geometry.js';
import { CANDLE_IDENTITY, CANDLE_CONTEXT_VERSION, CANDLE_GEOMETRY_VERSION, CANDLESTICK_POLICY_VERSION, type PatternParameters } from './pattern-parameters.js';
import type { PitView } from './pit-view.js';
import type { CandleRecord, PatternSeries, PatternStatus, PatternType } from './pattern-types.js';
import type { PriceActionDraft } from './price-action.js';

export interface Ohlc {
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
}

type Policy = PatternParameters['candlestick'];
export type GapState = 'SESSION_GAP_REQUIRED' | 'GAP_OPTIONAL' | 'UNSUPPORTED_FOR_SERIES';
export type ContextState = 'rising' | 'falling' | 'range' | 'insufficient';

const RATIO_SCALE = 12;

export interface CandleGeometryOf {
  range: Decimal;
  body: Decimal;
  upperWick: Decimal;
  lowerWick: Decimal;
  /** The colour of the candle: bullish when close > open, bearish when close < open, neutral when equal. */
  colour: 'bullish' | 'bearish' | 'neutral';
}

/** The exact geometry of one candle (docs/PATTERN_ENGINE_V1C.md §3). Decimal throughout. */
export function candleGeometry(c: Ohlc): CandleGeometryOf {
  const range = c.high.minus(c.low);
  const top = c.open.gt(c.close) ? c.open : c.close;
  const bottom = c.open.lt(c.close) ? c.open : c.close;
  return {
    range,
    body: c.close.minus(c.open).abs(),
    upperWick: c.high.minus(top),
    lowerWick: bottom.minus(c.low),
    colour: c.close.gt(c.open) ? 'bullish' : c.close.lt(c.open) ? 'bearish' : 'neutral',
  };
}

/** The direction of a candle: neutral when its body is within the doji tolerance, otherwise its colour. */
export function candleDirection(c: Ohlc, p: Policy): 'bullish' | 'bearish' | 'neutral' {
  const g = candleGeometry(c);
  if (g.body.lte(Decimal.from(p.dojiMaxBodyToRange).times(g.range))) return 'neutral';
  return g.colour;
}

/** The doji family: the most specific name only (dragonfly, then gravestone, then the generic doji). Null if the body is not doji-sized. */
export function dojiShapeOf(c: Ohlc, p: Policy): 'doji' | 'dragonfly_doji' | 'gravestone_doji' | null {
  const g = candleGeometry(c);
  if (g.range.isZero() || g.body.gt(Decimal.from(p.dojiMaxBodyToRange).times(g.range))) return null;
  const long = Decimal.from(p.longWickMinWickToRange).times(g.range);
  const small = Decimal.from(p.smallOppositeMaxWickToRange).times(g.range);
  if (g.lowerWick.gte(long) && g.upperWick.lte(small)) return 'dragonfly_doji';
  if (g.upperWick.gte(long) && g.lowerWick.lte(small)) return 'gravestone_doji';
  return 'doji';
}

/** The hammer shapes: a long lower wick ('lower') or a long upper wick ('upper') with a body above the doji size and below the hammer size. */
export function hammerShapeOf(c: Ohlc, p: Policy): 'lower' | 'upper' | null {
  const g = candleGeometry(c);
  if (g.range.isZero()) return null;
  if (g.body.lte(Decimal.from(p.dojiMaxBodyToRange).times(g.range)) || g.body.gt(Decimal.from(p.hammerMaxBodyToRange).times(g.range))) return null;
  const long = Decimal.from(p.longWickMinWickToRange).times(g.range);
  const small = Decimal.from(p.smallOppositeMaxWickToRange).times(g.range);
  const wick = Decimal.from(p.longWickMinWickToBody).times(g.body);
  if (g.lowerWick.gte(long) && g.lowerWick.gte(wick) && g.upperWick.lte(small)) return 'lower';
  if (g.upperWick.gte(long) && g.upperWick.gte(wick) && g.lowerWick.lte(small)) return 'upper';
  return null;
}

const isBearish = (c: Ohlc) => c.close.lt(c.open);
const isBullish = (c: Ohlc) => c.close.gt(c.open);

/** Bullish engulfing: a bearish previous body, a bullish current body at least the ratio of it, and containment of the previous body (inclusive). */
export function isBullishEngulfing(prev: Ohlc, cur: Ohlc, p: Policy): boolean {
  const pb = candleGeometry(prev).body;
  return (
    isBearish(prev) &&
    isBullish(cur) &&
    pb.isPositive() &&
    candleGeometry(cur).body.gte(Decimal.from(p.engulfingMinBodyRatio).times(pb)) &&
    cur.open.lte(prev.close) &&
    cur.close.gte(prev.open)
  );
}

/** Bearish engulfing: the mirror of the bullish form. */
export function isBearishEngulfing(prev: Ohlc, cur: Ohlc, p: Policy): boolean {
  const pb = candleGeometry(prev).body;
  return (
    isBullish(prev) &&
    isBearish(cur) &&
    pb.isPositive() &&
    candleGeometry(cur).body.gte(Decimal.from(p.engulfingMinBodyRatio).times(pb)) &&
    cur.open.gte(prev.close) &&
    cur.close.lte(prev.open)
  );
}

/** Bullish harami: a bearish previous body and a strictly smaller bullish current body contained in it. */
export function isBullishHarami(prev: Ohlc, cur: Ohlc, p: Policy): boolean {
  const pb = candleGeometry(prev).body;
  return (
    isBearish(prev) &&
    isBullish(cur) &&
    pb.isPositive() &&
    candleGeometry(cur).body.lt(Decimal.from(p.haramiMaxBodyRatio).times(pb)) &&
    cur.open.gte(prev.close) &&
    cur.close.lte(prev.open)
  );
}

/** Bearish harami: a bullish previous body and a strictly smaller bearish current body contained in it. */
export function isBearishHarami(prev: Ohlc, cur: Ohlc, p: Policy): boolean {
  const pb = candleGeometry(prev).body;
  return (
    isBullish(prev) &&
    isBearish(cur) &&
    pb.isPositive() &&
    candleGeometry(cur).body.lt(Decimal.from(p.haramiMaxBodyRatio).times(pb)) &&
    cur.open.lte(prev.close) &&
    cur.close.gte(prev.open)
  );
}

/** Piercing line (optional gap form): opens below the previous close, closes at least the proportion into the previous body, below the previous open. */
export function isPiercingLine(prev: Ohlc, cur: Ohlc, p: Policy): boolean {
  const pb = candleGeometry(prev).body;
  return (
    isBearish(prev) &&
    isBullish(cur) &&
    pb.isPositive() &&
    cur.open.lt(prev.close) &&
    cur.close.gte(prev.close.plus(Decimal.from(p.piercingMinPenetration).times(pb))) &&
    cur.close.lt(prev.open)
  );
}

/** Dark cloud cover (optional gap form): the mirror of the piercing line. */
export function isDarkCloudCover(prev: Ohlc, cur: Ohlc, p: Policy): boolean {
  const pb = candleGeometry(prev).body;
  return (
    isBullish(prev) &&
    isBearish(cur) &&
    pb.isPositive() &&
    cur.open.gt(prev.close) &&
    cur.close.lte(prev.close.minus(Decimal.from(p.piercingMinPenetration).times(pb))) &&
    cur.close.gt(prev.open)
  );
}

/** Tweezer top: a bullish then a bearish candle with equal highs within the ATR tolerance (inclusive). The context requirement is checked by the caller. */
export function isTweezerTop(prev: Ohlc, cur: Ohlc, scale: Decimal, p: Policy): boolean {
  return isBullish(prev) && isBearish(cur) && prev.high.minus(cur.high).abs().lte(Decimal.from(p.tweezerMaxExtremeDifferenceAtr).times(scale));
}

/** Tweezer bottom: a bearish then a bullish candle with equal lows within the ATR tolerance (inclusive). */
export function isTweezerBottom(prev: Ohlc, cur: Ohlc, scale: Decimal, p: Policy): boolean {
  return isBearish(prev) && isBullish(cur) && prev.low.minus(cur.low).abs().lte(Decimal.from(p.tweezerMaxExtremeDifferenceAtr).times(scale));
}

/**
 * Morning star. The optional form needs the location (candle 2 at or below the first body's close) and the penetration of candle 3. The strict form
 * (SESSION_GAP_REQUIRED series only) needs the price gaps: candle 2 entirely below the first close, and candle 3 opening above candle 2's high.
 */
export function isMorningStar(c1: Ohlc, c2: Ohlc, c3: Ohlc, scale: Decimal, p: Policy, mode: 'optional' | 'strict'): boolean {
  const b1 = candleGeometry(c1).body;
  const g2 = candleGeometry(c2);
  const body1Ok = isBearish(c1) && b1.gte(Decimal.from(p.starMinFirstBodyAtr).times(scale)) && b1.isPositive();
  const smallMiddle = !g2.range.isZero() && g2.body.lte(Decimal.from(p.starMaxMiddleBodyToRange).times(g2.range));
  const location = c2.open.gt(c1.close) || c2.close.gt(c1.close) ? false : true;
  const penetration = isBullish(c3) && c3.close.gte(c1.close.plus(Decimal.from(p.starMinThirdPenetration).times(b1)));
  const strictGap = c2.high.lt(c1.close) && c3.open.gt(c2.high);
  return body1Ok && smallMiddle && location && penetration && (mode === 'optional' || strictGap);
}

/** Evening star: the mirror of the morning star (strict form: candle 2 entirely above the first close, and candle 3 opening below candle 2's low). */
export function isEveningStar(c1: Ohlc, c2: Ohlc, c3: Ohlc, scale: Decimal, p: Policy, mode: 'optional' | 'strict'): boolean {
  const b1 = candleGeometry(c1).body;
  const g2 = candleGeometry(c2);
  const body1Ok = isBullish(c1) && b1.gte(Decimal.from(p.starMinFirstBodyAtr).times(scale)) && b1.isPositive();
  const smallMiddle = !g2.range.isZero() && g2.body.lte(Decimal.from(p.starMaxMiddleBodyToRange).times(g2.range));
  const location = c2.open.lt(c1.close) || c2.close.lt(c1.close) ? false : true;
  const penetration = isBearish(c3) && c3.close.lte(c1.close.minus(Decimal.from(p.starMinThirdPenetration).times(b1)));
  const strictGap = c2.low.gt(c1.close) && c3.open.lt(c2.low);
  return body1Ok && smallMiddle && location && penetration && (mode === 'optional' || strictGap);
}

/** Three white soldiers: three bullish candles, each opening within the previous real body, with the closes progressing by the ATR minimum. */
export function isThreeWhiteSoldiers([c1, c2, c3]: [Ohlc, Ohlc, Ohlc], scale: Decimal, p: Policy): boolean {
  const step = Decimal.from(p.soldiersMinProgressionAtr).times(scale);
  return (
    [c1, c2, c3].every((c) => isBullish(c) && soldierBody(c, p) && upperWickSmall(c, p)) &&
    c2.open.gte(c1.open) &&
    c2.open.lte(c1.close) &&
    c3.open.gte(c2.open) &&
    c3.open.lte(c2.close) &&
    c2.close.minus(c1.close).gte(step) &&
    c3.close.minus(c2.close).gte(step)
  );
}

/** Three black crows: the mirror of the soldiers (bearish candles, lower wick the opposite wick, closes falling). */
export function isThreeBlackCrows([c1, c2, c3]: [Ohlc, Ohlc, Ohlc], scale: Decimal, p: Policy): boolean {
  const step = Decimal.from(p.soldiersMinProgressionAtr).times(scale);
  return (
    [c1, c2, c3].every((c) => isBearish(c) && soldierBody(c, p) && lowerWickSmall(c, p)) &&
    c2.open.lte(c1.open) &&
    c2.open.gte(c1.close) &&
    c3.open.lte(c2.open) &&
    c3.open.gte(c2.close) &&
    c1.close.minus(c2.close).gte(step) &&
    c2.close.minus(c3.close).gte(step)
  );
}

function soldierBody(c: Ohlc, p: Policy): boolean {
  const g = candleGeometry(c);
  return !g.range.isZero() && g.body.gte(Decimal.from(p.soldiersMinBodyToRange).times(g.range));
}

function upperWickSmall(c: Ohlc, p: Policy): boolean {
  const g = candleGeometry(c);
  return g.upperWick.lte(Decimal.from(p.soldiersMaxOppositeWickToRange).times(g.range));
}

function lowerWickSmall(c: Ohlc, p: Policy): boolean {
  const g = candleGeometry(c);
  return g.lowerWick.lte(Decimal.from(p.soldiersMaxOppositeWickToRange).times(g.range));
}

/**
 * The gap state of a series (candlestick-gap-policy:v1). A sessioned equity has real session gaps; a 24x7 or FX series does not, so a gap is never
 * fabricated for it.
 */
export function gapStateOf(assetClass: string, session: string): GapState {
  if (assetClass === 'crypto' || assetClass === 'forex' || session === 'continuous') return 'UNSUPPORTED_FOR_SERIES';
  if ((assetClass === 'stock' || assetClass === 'etf') && session === 'regular') return 'SESSION_GAP_REQUIRED';
  return 'GAP_OPTIONAL';
}

/**
 * The prior context of the candle at index i (candle-context:v1): the net close change over the lookback, normalised by the ATR of the bar before
 * the candle. Uses bars up to i − 1 only.
 */
export function priorContextOf(view: PitView, atrs: ReadonlyArray<number | null>, params: PatternParameters, i: number): { state: ContextState; netAtr: Decimal | null } {
  const L = params.candleContext.lookbackBars;
  if (i - 1 - L < 0) return { state: 'insufficient', netAtr: null };
  const A = scaleAt(view, atrs, params, i - 1);
  if (A === null || !A.isPositive()) return { state: 'insufficient', netAtr: null };
  const net = view.bars[i - 1]!.close.minus(view.bars[i - 1 - L]!.close);
  const netAtr = net.dividedBy(A, RATIO_SCALE, 'half_even');
  const min = Decimal.from(params.candleContext.minMoveAtr);
  const state: ContextState = netAtr.gte(min) ? 'rising' : netAtr.lte(min.negated()) ? 'falling' : 'range';
  return { state, netAtr };
}

export interface CandleScan {
  drafts: PriceActionDraft[];
  evaluations: number;
  candidates: number;
}

interface Ctx {
  instrumentId: string;
  interval: string;
  series: PatternSeries;
  gap: GapState;
}

/** One candle group as a draft: its identity, its participating candles, and its metrics on the final candle. */
function draftOf(view: PitView, ctx: Ctx, p: Policy, type: PatternType, indices: number[], role: CandleRecord['role'][], context: { state: ContextState; netAtr: Decimal | null } | null, gap: { policy: GapState; satisfied: 'optional' | 'strict' } | null): PriceActionDraft {
  const last = view.bars[indices[indices.length - 1]!]!;
  const g = candleGeometry(last);
  const records: CandleRecord[] = indices.map((k, n) => {
    const b = view.bars[k]!;
    return { role: role[n]!, barIndex: k, time: b.startTime, open: b.open.toString(), high: b.high.toString(), low: b.low.toString(), close: b.close.toString() };
  });
  const barStartTimes = indices.map((k) => view.bars[k]!.startTime);
  const patternInstanceId = 'pi_' + hashOf({ kind: 'candle-instance', engine: CANDLE_IDENTITY.engine, candlestickPolicy: CANDLESTICK_POLICY_VERSION, candleGeometry: CANDLE_GEOMETRY_VERSION, patternType: type, instrumentId: ctx.instrumentId, interval: ctx.interval, series: ctx.series, barStartTimes }).slice(0, 40);
  const metrics: Record<string, string> = {
    candleCount: String(indices.length),
    range: g.range.toString(),
    body: g.body.toString(),
    upperWick: g.upperWick.toString(),
    lowerWick: g.lowerWick.toString(),
    bodyToRange: g.range.isZero() ? '0' : g.body.dividedBy(g.range, 6, 'half_even').toFixed(6),
    upperWickToRange: g.range.isZero() ? '0' : g.upperWick.dividedBy(g.range, 6, 'half_even').toFixed(6),
    lowerWickToRange: g.range.isZero() ? '0' : g.lowerWick.dividedBy(g.range, 6, 'half_even').toFixed(6),
  };
  if (gap !== null) {
    metrics.gapPolicy = gap.policy;
    metrics.gapSatisfied = gap.satisfied;
  }
  const status: PatternStatus = 'confirmed';
  return {
    patternInstanceId,
    patternType: type,
    direction: candleDirection(last, p),
    status,
    firstSeenAt: last.instant,
    confirmedAt: last.instant,
    resolvedAt: null,
    invalidatedAt: null,
    anchors: [],
    confirmation: { direction: null, level: null, buffer: '0', confirmedByBarTime: null },
    invalidation: { rule: 'none', level: null },
    target: { method: 'none', price: null },
    boundaries: {},
    geometryMetrics: metrics,
    candles: records,
    candleContext: context === null ? null : { policy: CANDLE_CONTEXT_VERSION, state: context.state, netAtr: context.netAtr === null ? null : context.netAtr.toFixed(6) },
  } as PriceActionDraft;
}

/**
 * The candlestick catalog over the view (docs/PATTERN_ENGINE_V1C.md §5–§11). Every rule is evaluated only on the final bars of the view, and each
 * group's first-seen instant is its last candle's replay instant.
 */
export function detectCandles(view: PitView, params: PatternParameters, atrs: ReadonlyArray<number | null>, ctx: Ctx): CandleScan {
  const p = params.candlestick;
  const drafts: PriceActionDraft[] = [];
  let evaluations = 0;
  const strict = p.gapMode === 'strict';
  const gapAllowed = ctx.gap === 'SESSION_GAP_REQUIRED';
  const satisfied: 'optional' | 'strict' = strict ? 'strict' : 'optional';
  const bars = view.bars;
  const ohlc = (i: number): Ohlc => ({ open: bars[i]!.open, high: bars[i]!.high, low: bars[i]!.low, close: bars[i]!.close });
  const push = (d: PriceActionDraft) => drafts.push(d);
  for (let i = 0; i < bars.length; i++) {
    evaluations++;
    const c = ohlc(i);
    // Single candles: the doji family, then the hammer shapes named by the prior context.
    const doji = dojiShapeOf(c, p);
    if (doji !== null) push(draftOf(view, ctx, p, doji, [i], ['candle_1'], null, null));
    else {
      const shape = hammerShapeOf(c, p);
      if (shape !== null) {
        const context = priorContextOf(view, atrs, params, i);
        const name: PatternType | null =
          shape === 'lower' ? (context.state === 'falling' ? 'hammer' : context.state === 'rising' ? 'hanging_man' : null) : context.state === 'falling' ? 'inverted_hammer' : context.state === 'rising' ? 'shooting_star' : null;
        if (name !== null) push(draftOf(view, ctx, p, name, [i], ['candle_1'], context, null));
      }
    }
    // Two-candle groups: the previous and the current candle.
    if (i >= 1) {
      const prev = ohlc(i - 1);
      const roles: CandleRecord['role'][] = ['candle_1', 'candle_2'];
      if (isBullishEngulfing(prev, c, p)) push(draftOf(view, ctx, p, 'bullish_engulfing', [i - 1, i], roles, null, null));
      if (isBearishEngulfing(prev, c, p)) push(draftOf(view, ctx, p, 'bearish_engulfing', [i - 1, i], roles, null, null));
      if (isBullishHarami(prev, c, p)) push(draftOf(view, ctx, p, 'bullish_harami', [i - 1, i], roles, null, null));
      if (isBearishHarami(prev, c, p)) push(draftOf(view, ctx, p, 'bearish_harami', [i - 1, i], roles, null, null));
      // The piercing line and the dark cloud: the optional opening condition, or the strict price gap where the policy asks for it.
      const piercingGap = strict ? gapAllowed && c.open.lt(prev.low) : true;
      if (isPiercingLine(prev, c, p) && piercingGap) push(draftOf(view, ctx, p, 'piercing_line', [i - 1, i], roles, null, { policy: ctx.gap, satisfied }));
      const darkGap = strict ? gapAllowed && c.open.gt(prev.high) : true;
      if (isDarkCloudCover(prev, c, p) && darkGap) push(draftOf(view, ctx, p, 'dark_cloud_cover', [i - 1, i], roles, null, { policy: ctx.gap, satisfied }));
      // Tweezers: equal extremes within the ATR tolerance, with the prior-context requirement of the previous candle.
      const scale = scaleAt(view, atrs, params, i);
      if (scale !== null) {
        const prevContext = priorContextOf(view, atrs, params, i - 1);
        const topOk = !p.tweezerRequiresContext || prevContext.state === 'rising';
        const bottomOk = !p.tweezerRequiresContext || prevContext.state === 'falling';
        if (topOk && isTweezerTop(prev, c, scale, p)) push(draftOf(view, ctx, p, 'tweezer_top', [i - 1, i], roles, p.tweezerRequiresContext ? prevContext : null, null));
        if (bottomOk && isTweezerBottom(prev, c, scale, p)) push(draftOf(view, ctx, p, 'tweezer_bottom', [i - 1, i], roles, p.tweezerRequiresContext ? prevContext : null, null));
      }
    }
    // Three-candle groups: the stars need the candle-3 scale, the soldiers and crows the ATR progression.
    if (i >= 2) {
      const c1 = ohlc(i - 2);
      const c2 = ohlc(i - 1);
      const scale = scaleAt(view, atrs, params, i);
      const roles: CandleRecord['role'][] = ['candle_1', 'candle_2', 'candle_3'];
      if (scale !== null) {
        const starMode: 'optional' | 'strict' = strict ? 'strict' : 'optional';
        const starOk = !strict || gapAllowed;
        if (starOk && isMorningStar(c1, c2, c, scale, p, starMode)) push(draftOf(view, ctx, p, 'morning_star', [i - 2, i - 1, i], roles, null, { policy: ctx.gap, satisfied }));
        if (starOk && isEveningStar(c1, c2, c, scale, p, starMode)) push(draftOf(view, ctx, p, 'evening_star', [i - 2, i - 1, i], roles, null, { policy: ctx.gap, satisfied }));
        if (isThreeWhiteSoldiers([c1, c2, c], scale, p)) push(draftOf(view, ctx, p, 'three_white_soldiers', [i - 2, i - 1, i], roles, null, null));
        if (isThreeBlackCrows([c1, c2, c], scale, p)) push(draftOf(view, ctx, p, 'three_black_crows', [i - 2, i - 1, i], roles, null, null));
      }
    }
  }
  return { drafts, evaluations, candidates: drafts.length };
}

