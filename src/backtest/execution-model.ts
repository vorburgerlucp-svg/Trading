import type { MarketBar } from '../market-data/market-data-types.js';
import { parseUtc } from '../market-data/time.js';
import type { Decimal } from '../money/decimal.js';

export type IntrabarFillPolicy = 'conservative' | 'mark_ambiguous';

export interface ProtectiveExit {
  kind: 'stop' | 'take_profit' | 'ambiguous';
  rawFillPrice: Decimal | null;
  reason: string;
}

/**
 * Long-only protective exit model.
 *
 * Gap rules:
 * - open <= stop  -> stop fills at open (never magically at the stop)
 * - open >= TP    -> TP fills at open
 *
 * If both stop and TP are touched within one OHLC bar and the ordering is unknowable,
 * conservative policy chooses the adverse stop; mark_ambiguous refuses to invent an order.
 */
export function protectiveExitForLong(bar: MarketBar, stopLoss: Decimal | null, takeProfit: Decimal | null, policy: IntrabarFillPolicy): ProtectiveExit | null {
  if (stopLoss && bar.open.lte(stopLoss)) return { kind: 'stop', rawFillPrice: bar.open, reason: 'gap through stop' };
  if (takeProfit && bar.open.gte(takeProfit)) return { kind: 'take_profit', rawFillPrice: bar.open, reason: 'gap through take profit' };

  const stopTouched = stopLoss !== null && bar.low.lte(stopLoss);
  const takeTouched = takeProfit !== null && bar.high.gte(takeProfit);

  if (stopTouched && takeTouched) {
    if (policy === 'conservative') return { kind: 'stop', rawFillPrice: stopLoss, reason: 'stop and take profit touched in same OHLC bar; conservative policy chooses adverse fill' };
    return { kind: 'ambiguous', rawFillPrice: null, reason: 'stop and take profit touched in same OHLC bar; ordering is unknown' };
  }
  if (stopTouched && stopLoss) return { kind: 'stop', rawFillPrice: stopLoss, reason: 'stop touched' };
  if (takeTouched && takeProfit) return { kind: 'take_profit', rawFillPrice: takeProfit, reason: 'take profit touched' };
  return null;
}

/** A decision made from a final bar may never fill at that same bar's open/close. */
export function isEligibleNextBar(decisionBar: MarketBar, candidateBar: MarketBar): boolean {
  if (candidateBar.instrumentId !== decisionBar.instrumentId) return false;
  const candidateOpen = parseUtc(candidateBar.startTime);
  const decisionKnown = parseUtc(decisionBar.availableAt);
  // The next bar's open is executable only if it occurs at or after the decision became knowable.
  // A delayed final bar must never cause a retroactive fill at an already-passed bar open.
  return candidateOpen >= decisionKnown;
}
