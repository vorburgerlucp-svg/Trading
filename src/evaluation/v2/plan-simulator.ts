// R2: deterministic simulation of a sealed trade plan over the final bars that followed it. It never chooses an entry, an exit
// or a horizon: the plan fixes them. Rules (outcome-eval:v2):
//   entry      at the open of the first expected bar starting at or after earliestEntryAt, plus half the spread and the
//              slippage against the trade (long pays more, short receives less);
//   stop       long: low <= stop, short: high >= stop. A bar that OPENS beyond the stop fills at its open (gap, worse than the
//              stop); otherwise at the stop. Slippage and half the spread apply against the trade;
//   target     long: high >= target, short: low <= target; fills AT the target, also after a favourable gap (conservative: never
//              better than the target);
//   both       stop and target reachable in one bar: OHLC does not tell the order. conservative_stop_first takes the stop and
//              flags the result; indeterminate makes the result INDETERMINATE;
//   time exit  at the close of the maxHoldingBars-th bar;
//   costs      commission (bps of each side's notional) and a fixed fee per side, on top of spread and slippage in the fills.
// A missing expected bar inside the position is a data gap: INSUFFICIENT_DATA, never an invented fill. A bar that is not complete
// yet makes the result PENDING.

import type { MarketBar } from '../../market-data/market-data-types.js';
import type { TradingCalendar } from '../../market-data/sessions.js';
import { parseUtc, toUtcIso } from '../../market-data/time.js';
import { Decimal } from '../../money/decimal.js';
import type { TradePlan } from './trade-plan.js';

export type SimulationStatus = 'COMPLETED' | 'PENDING' | 'INSUFFICIENT_DATA' | 'INDETERMINATE';
export type ExitReason = 'stop' | 'stop_gap' | 'target' | 'target_gap' | 'time';

export interface PlanSimulation {
  status: SimulationStatus;
  reasons: string[];
  entry: { barStart: string; referencePrice: string; fillPrice: string } | null;
  exit: { barStart: string; reason: ExitReason; referencePrice: string; fillPrice: string } | null;
  quantity: string | null;
  barsHeld: number;
  /** Bars in which stop and target were both reachable; resolved by the plan's intrabar policy. */
  ambiguousBars: number;
  /** True when a conservative assumption decided the exit (the result is then a lower bound, not an observation). */
  assumptionUsed: boolean;
  /** Profit before commission and fees, after spread and slippage (they are in the fill prices). */
  grossPnl: string | null;
  fees: string | null;
  /** Spread and slippage paid, both sides. */
  executionCosts: string | null;
  netPnl: string | null;
  /** Planned risk: quantity × |entry fill − stop|. */
  riskAmount: string | null;
  /** netPnl / riskAmount. */
  netR: string | null;
  /** Bars whose knowledge was not proven (legacy) inside the position. */
  legacyBars: number;
}

const SCALE = 12;

function bp(value: number): Decimal {
  return Decimal.from(value).dividedBy(10_000, SCALE, 'half_even');
}

function empty(status: SimulationStatus, reasons: string[], extra: Partial<PlanSimulation> = {}): PlanSimulation {
  return { status, reasons, entry: null, exit: null, quantity: null, barsHeld: 0, ambiguousBars: 0, assumptionUsed: false, grossPnl: null, fees: null, executionCosts: null, netPnl: null, riskAmount: null, netR: null, legacyBars: 0, ...extra };
}

export function simulateTradePlan(plan: TradePlan, bars: readonly MarketBar[], calendar: TradingCalendar, evaluatedAt: string): PlanSimulation {
  const now = parseUtc(evaluatedAt);
  for (const bar of bars) {
    if (bar.instrumentId !== plan.instrumentId || bar.source !== plan.source || bar.interval !== plan.interval) return empty('INSUFFICIENT_DATA', ['BAR_OF_ANOTHER_SERIES']);
  }
  const byStart = new Map<number, MarketBar>();
  for (const bar of bars) if (bar.isFinal) byStart.set(parseUtc(bar.startTime), bar);

  const long = plan.side === 'long';
  const half = bp(plan.costs.spreadBps).dividedBy(2, SCALE, 'half_even');
  const slip = bp(plan.costs.slippageBps);
  const adverse = half.plus(slip);
  /** A fill against the trade: buying pays more, selling receives less. */
  const fill = (price: Decimal, buying: boolean) => (buying ? price.times(Decimal.ONE.plus(adverse)) : price.times(Decimal.ONE.minus(adverse)));
  const stop = Decimal.from(plan.stopLoss);
  const target = plan.takeProfit !== undefined ? Decimal.from(plan.takeProfit) : null;

  let start = calendar.firstBarStartAtOrAfter(parseUtc(plan.entry.earliestEntryAt), plan.interval, 'regular');
  let entry: PlanSimulation['entry'] = null;
  let entryFill: Decimal | null = null;
  let quantity: Decimal | null = null;
  let ambiguousBars = 0;
  let assumptionUsed = false;
  let legacyBars = 0;
  for (let k = 1; k <= plan.maxHoldingBars; k++) {
    if (start === null) return empty('INSUFFICIENT_DATA', ['NO_EXPECTED_BAR'], { entry, quantity: quantity?.toString() ?? null, barsHeld: k - 1 });
    const window = calendar.barWindow(start, plan.interval, 'regular');
    const end = window.ok ? window.end : start;
    const bar = byStart.get(start);
    if (!bar) {
      const status: SimulationStatus = now < end ? 'PENDING' : 'INSUFFICIENT_DATA';
      return empty(status, [status === 'PENDING' ? 'BAR_NOT_COMPLETE ' + toUtcIso(start) : 'DATA_GAP ' + toUtcIso(start)], { entry, quantity: quantity?.toString() ?? null, barsHeld: k - 1, ambiguousBars, legacyBars });
    }
    if (bar.knowledge.knowledgeSource === 'legacy_unproven') legacyBars++;
    const open = bar.open;
    if (k === 1) {
      entryFill = fill(open, long);
      quantity = plan.size.kind === 'quantity' ? Decimal.from(plan.size.quantity) : Decimal.from(plan.size.amount).dividedBy(entryFill, SCALE, 'half_even');
      entry = { barStart: bar.startTime, referencePrice: open.toString(), fillPrice: entryFill.toString() };
    }
    let exit: { reason: ExitReason; price: Decimal } | null = null;
    const stopAtOpen = long ? open.lte(stop) : open.gte(stop);
    const targetAtOpen = target !== null && (long ? open.gte(target) : open.lte(target));
    if (stopAtOpen) exit = { reason: 'stop_gap', price: open };
    else if (targetAtOpen) exit = { reason: 'target_gap', price: k === 1 ? open : target! };
    else {
      const stopHit = long ? bar.low.lte(stop) : bar.high.gte(stop);
      const targetHit = target !== null && (long ? bar.high.gte(target) : bar.low.lte(target));
      if (stopHit && targetHit) {
        ambiguousBars++;
        if (plan.intrabarPolicy === 'indeterminate') return empty('INDETERMINATE', ['STOP_AND_TARGET_IN_ONE_BAR ' + bar.startTime], { entry, quantity: quantity!.toString(), barsHeld: k, ambiguousBars, legacyBars });
        assumptionUsed = true;
        exit = { reason: 'stop', price: stop };
      } else if (stopHit) exit = { reason: 'stop', price: stop };
      else if (targetHit) exit = { reason: 'target', price: target! };
      else if (k === plan.maxHoldingBars) exit = { reason: 'time', price: bar.close };
    }
    if (exit) {
      const exitFill = fill(exit.price, !long);
      const qty = quantity!;
      const gross = long ? qty.times(exitFill.minus(entryFill!)) : qty.times(entryFill!.minus(exitFill));
      const commission = bp(plan.costs.commissionBps);
      const fixed = Decimal.from(plan.costs.fixedFeePerSide);
      const fees = qty.times(entryFill!).times(commission).plus(qty.times(exitFill).times(commission)).plus(fixed).plus(fixed);
      const executionCosts = qty.times(entryFill!.minus(open).abs()).plus(qty.times(exitFill.minus(exit.price).abs()));
      const net = gross.minus(fees);
      const risk = qty.times(entryFill!.minus(stop).abs());
      return {
        status: 'COMPLETED',
        reasons: assumptionUsed ? ['CONSERVATIVE_STOP_FIRST'] : [],
        entry,
        exit: { barStart: bar.startTime, reason: exit.reason, referencePrice: exit.price.toString(), fillPrice: exitFill.toString() },
        quantity: qty.toString(),
        barsHeld: k,
        ambiguousBars,
        assumptionUsed,
        grossPnl: gross.toString(),
        fees: fees.toString(),
        executionCosts: executionCosts.toString(),
        netPnl: net.toString(),
        riskAmount: risk.toString(),
        netR: risk.isZero() ? null : net.dividedBy(risk, 6, 'half_even').toString(),
        legacyBars,
      };
    }
    start = calendar.nextBarStart(start, plan.interval, 'regular');
  }
  return empty('INSUFFICIENT_DATA', ['NO_EXIT_REACHED']);
}
