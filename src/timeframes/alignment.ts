// Alignment (alignment:v1): how the POSITION, SWING and INTRADAY layers relate, and the whole-chart phase that follows.
// Descriptive states only. None of them is an order, a probability or a setup name (docs/MULTITIMEFRAME_CHART_CONTEXT_V1.md §9–10).

export const ALIGNMENT_VERSION = 'alignment:v1';

/** The state of one layer. `mixed`: its usable intervals disagree. `unknown`: intervals exist but no structure is confirmed. */
export type LayerTrend = 'bullish' | 'bearish' | 'range' | 'mixed' | 'unknown' | 'unavailable';

export type AlignmentState =
  | 'FULL_BULL_ALIGNMENT'
  | 'FULL_BEAR_ALIGNMENT'
  | 'HIGHER_BULL_LOWER_PULLBACK'
  | 'HIGHER_BEAR_LOWER_RALLY'
  | 'RANGE_DOMINANT'
  | 'CONFLICTED'
  | 'INSUFFICIENT_CONTEXT';

export type PhaseState = 'impulse_up' | 'pullback_in_uptrend' | 'impulse_down' | 'relief_rally_in_downtrend' | 'range' | 'transition' | 'unknown';

function missing(t: LayerTrend): boolean {
  return t === 'unknown' || t === 'unavailable';
}

/**
 * The table of alignment:v1. Evaluated in this order; p is the POSITION trend (bullish or bearish), o its opposite.
 *  1. POSITION, SWING or INTRADAY missing (unknown or unavailable): INSUFFICIENT_CONTEXT.
 *  2. POSITION range: RANGE_DOMINANT when SWING and INTRADAY are both range, otherwise CONFLICTED. POSITION mixed: CONFLICTED.
 *  3. POSITION p: SWING p and INTRADAY p: FULL. SWING range and INTRADAY range: RANGE_DOMINANT.
 *     SWING p with INTRADAY o, mixed or range; or SWING o, mixed or range with INTRADAY p or range: the higher trend with a corrective lower layer.
 *     Otherwise (SWING o, mixed or range with INTRADAY o or mixed): CONFLICTED.
 */
export function alignmentOf(position: LayerTrend, swing: LayerTrend, intraday: LayerTrend): AlignmentState {
  if (missing(position) || missing(swing) || missing(intraday)) return 'INSUFFICIENT_CONTEXT';
  if (position === 'mixed') return 'CONFLICTED';
  if (position === 'range') return swing === 'range' && intraday === 'range' ? 'RANGE_DOMINANT' : 'CONFLICTED';
  const bullish = position === 'bullish';
  if (swing === position && intraday === position) return bullish ? 'FULL_BULL_ALIGNMENT' : 'FULL_BEAR_ALIGNMENT';
  if (swing === 'range' && intraday === 'range') return 'RANGE_DOMINANT';
  if (swing === position) return bullish ? 'HIGHER_BULL_LOWER_PULLBACK' : 'HIGHER_BEAR_LOWER_RALLY';
  if (intraday === position || intraday === 'range') return bullish ? 'HIGHER_BULL_LOWER_PULLBACK' : 'HIGHER_BEAR_LOWER_RALLY';
  return 'CONFLICTED';
}

export function phaseOf(alignment: AlignmentState): PhaseState {
  switch (alignment) {
    case 'FULL_BULL_ALIGNMENT':
      return 'impulse_up';
    case 'FULL_BEAR_ALIGNMENT':
      return 'impulse_down';
    case 'HIGHER_BULL_LOWER_PULLBACK':
      return 'pullback_in_uptrend';
    case 'HIGHER_BEAR_LOWER_RALLY':
      return 'relief_rally_in_downtrend';
    case 'RANGE_DOMINANT':
      return 'range';
    case 'CONFLICTED':
      return 'transition';
    case 'INSUFFICIENT_CONTEXT':
      return 'unknown';
  }
}
