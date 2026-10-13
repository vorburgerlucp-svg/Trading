import type { MarketBar } from '../market-data/market-data-types.js';
import type { Decimal } from '../money/decimal.js';

export type IntrabarFillPolicy = 'conservative' | 'mark_ambiguous';

export interface ProtectiveExit {
  kind: 'stop' | 'take_profit' | 'ambiguous';
  rawFillPrice: Decimal | null;
  reason: string;
  /**
   * OPEN_EXACT for a gap through the level (the fill executes at the session open). INTRABAR_UNKNOWN for a level touched inside the
   * bar's range: the instant is not knowable from OHLC, so it must not be recorded as an exact open (see execution-clock.ts).
   */
  timing: 'OPEN_EXACT' | 'INTRABAR_UNKNOWN';
}

/**
 * Long-only protective exit model.
 *
 * Gap rules:
 * - open <= stop  -> stop fills at open (never magically at the stop); OPEN_EXACT
 * - open >= TP    -> TP fills at open; OPEN_EXACT
 *
 * A level touched inside the bar's range fills at the level, at an instant unknown from OHLC: INTRABAR_UNKNOWN.
 *
 * If both stop and TP are touched within one OHLC bar and the ordering is unknowable,
 * conservative policy chooses the adverse stop; mark_ambiguous refuses to invent an order.
 */
export function protectiveExitForLong(bar: MarketBar, stopLoss: Decimal | null, takeProfit: Decimal | null, policy: IntrabarFillPolicy): ProtectiveExit | null {
  if (stopLoss && bar.open.lte(stopLoss)) return { kind: 'stop', rawFillPrice: bar.open, reason: 'gap through stop', timing: 'OPEN_EXACT' };
  if (takeProfit && bar.open.gte(takeProfit)) return { kind: 'take_profit', rawFillPrice: bar.open, reason: 'gap through take profit', timing: 'OPEN_EXACT' };

  const stopTouched = stopLoss !== null && bar.low.lte(stopLoss);
  const takeTouched = takeProfit !== null && bar.high.gte(takeProfit);

  if (stopTouched && takeTouched) {
    if (policy === 'conservative') {
      return { kind: 'stop', rawFillPrice: stopLoss, reason: 'stop and take profit touched in same OHLC bar; conservative policy chooses adverse fill', timing: 'INTRABAR_UNKNOWN' };
    }
    return { kind: 'ambiguous', rawFillPrice: null, reason: 'stop and take profit touched in same OHLC bar; ordering is unknown', timing: 'INTRABAR_UNKNOWN' };
  }
  if (stopTouched && stopLoss) return { kind: 'stop', rawFillPrice: stopLoss, reason: 'stop touched', timing: 'INTRABAR_UNKNOWN' };
  if (takeTouched && takeProfit) return { kind: 'take_profit', rawFillPrice: takeProfit, reason: 'take profit touched', timing: 'INTRABAR_UNKNOWN' };
  return null;
}
