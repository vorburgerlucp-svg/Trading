// R2: deterministic simulation of sealed plans over the final bars that followed them. It never chooses an entry, an exit or a
// horizon: the plan fixes them. Rules (outcome-eval:v2, policy v2.1):
//   entry plan    enter at the open of the first expected bar at or after earliestEntryAt; half the spread and the slippage
//                 against the trade (long pays more, short receives less);
//   continuation  NO entry: the real open position (its quantity) at the decision bar. Two alternatives from the SAME bar and
//                 the SAME execution assumptions: close at the decision bar's open, or hold under the plan's current stop,
//                 target and holding limit. Costs already paid are sunk and never charged again; each alternative pays one exit.
//   stop          long: low <= stop, short: high >= stop. A bar that OPENS beyond the stop fills at its open (gap, worse than
//                 the stop); otherwise at the stop;
//   target        long: high >= target, short: low <= target; fills AT the target, also after a favourable gap (conservative);
//   both          stop and target reachable in one bar: conservative_stop_first takes the stop and flags the result;
//                 indeterminate gives INDETERMINATE;
//   time exit     at the close of the maxHoldingBars-th bar;
//   costs         commission (bps of each fill's notional) and a fixed fee per fill, on top of spread and slippage in the fills.
// Data: only final bars of the plan's series that NEXUS held at the evaluation time (knownAt <= evaluatedAt) are used. A missing
// expected bar is PENDING while the data grace period runs (a late delivery is still possible), then INSUFFICIENT_DATA. Never an
// invented fill. Assumptions every result rests on are listed in `assumptions`.
// Not modelled (and therefore never part of a plan): partial fills, scaling in or out, moving the stop or target during the
// holding window, currency conversion.

import type { MarketBar } from '../../market-data/market-data-types.js';
import type { TradingCalendar } from '../../market-data/sessions.js';
import { parseUtc, toUtcIso } from '../../market-data/time.js';
import { Decimal } from '../../money/decimal.js';
import type { AnyPlan, ContinuationPlan, TradePlan } from './trade-plan.js';

export type SimulationStatus = 'COMPLETED' | 'PENDING' | 'INSUFFICIENT_DATA' | 'INDETERMINATE';
export type ExitReason = 'stop' | 'stop_gap' | 'target' | 'target_gap' | 'time';

export interface SimulationOptions {
  /** How long after a bar's end a missing bar still counts as late (PENDING) rather than missing. Default 6 hours. */
  dataGraceMs?: number;
}

export const DEFAULT_DATA_GRACE_MS = 6 * 3_600_000;

export interface PlanSimulation {
  kind: 'entry' | 'continuation';
  status: SimulationStatus;
  reasons: string[];
  /** Assumptions the result rests on (e.g. full fills at the modelled price, a modelled spread). */
  assumptions: string[];
  /** Entry plan: the simulated entry. Continuation: null (the position exists). */
  entry: { barStart: string; referencePrice: string; fillPrice: string } | null;
  /** Continuation only: closing at the decision bar's open. */
  closeNow: { barStart: string; referencePrice: string; fillPrice: string; fees: string } | null;
  /** The plan's exit (entry plan: of the new position; continuation: of the held position). */
  exit: { barStart: string; reason: ExitReason; referencePrice: string; fillPrice: string } | null;
  quantity: string | null;
  barsHeld: number;
  ambiguousBars: number;
  /** True when the conservative intrabar assumption decided the exit (the result is then a bound, not an observation). */
  assumptionUsed: boolean;
  /** Entry plan: gross PnL after spread and slippage. Continuation: gross value of holding versus closing now. */
  grossPnl: string | null;
  /** Entry plan: commission and fees of both fills. Continuation: the hold exit's fees minus the close-now fees. */
  fees: string | null;
  /** Spread and slippage paid by the simulated fills. */
  executionCosts: string | null;
  /** Entry plan: net PnL. Continuation: net value of holding versus closing now (positive: holding was better). */
  netPnl: string | null;
  /** Entry plan: quantity × |entry fill − stop|. Continuation: quantity × |decision-bar open − stop| (the risk kept by holding). */
  riskAmount: string | null;
  netR: string | null;
  legacyBars: number;
}

const SCALE = 12;

function bp(value: number): Decimal {
  return Decimal.from(value).dividedBy(10_000, SCALE, 'half_even');
}

function base(kind: PlanSimulation['kind'], status: SimulationStatus, reasons: string[], extra: Partial<PlanSimulation> = {}): PlanSimulation {
  return { kind, status, reasons, assumptions: [], entry: null, closeNow: null, exit: null, quantity: null, barsHeld: 0, ambiguousBars: 0, assumptionUsed: false, grossPnl: null, fees: null, executionCosts: null, netPnl: null, riskAmount: null, netR: null, legacyBars: 0, ...extra };
}

function assumptionsOf(plan: AnyPlan): string[] {
  return ['FULL_FILL_AT_MODELED_PRICE', 'FIXED_STOP_AND_TARGET', ...(plan.costs.spreadSource === 'modeled' ? ['MODELED_SPREAD'] : [])];
}

interface Walk {
  /** The expected bars from the plan's start, as far as they exist (stops at the first missing one). */
  bars: MarketBar[];
  /** Why the walk ended before maxHoldingBars bars (null: complete). */
  stop: { status: 'PENDING' | 'INSUFFICIENT_DATA'; reason: string } | null;
  legacyBars: number;
}

/** The expected bars of the plan's series from `startIso`, held by NEXUS at `evaluatedAt`, up to `count` bars. */
function walk(plan: AnyPlan, bars: readonly MarketBar[], calendar: TradingCalendar, startIso: string, count: number, evaluatedAt: string, graceMs: number): Walk | { refused: string } {
  const now = parseUtc(evaluatedAt);
  for (const bar of bars) if (bar.instrumentId !== plan.instrumentId || bar.source !== plan.source || bar.interval !== plan.interval) return { refused: 'BAR_OF_ANOTHER_SERIES' };
  const byStart = new Map<number, MarketBar>();
  for (const bar of bars) {
    if (!bar.isFinal) continue;
    // A revision NEXUS received after the evaluation time is not used: the evaluation stays reproducible at its time.
    if (bar.knowledge.knownAt !== null && parseUtc(bar.knowledge.knownAt) > now) continue;
    byStart.set(parseUtc(bar.startTime), bar);
  }
  const out: Walk = { bars: [], stop: null, legacyBars: 0 };
  let start = calendar.firstBarStartAtOrAfter(parseUtc(startIso), plan.interval, 'regular');
  for (let k = 1; k <= count; k++) {
    if (start === null) return { ...out, stop: { status: 'INSUFFICIENT_DATA', reason: 'NO_EXPECTED_BAR' } };
    const window = calendar.barWindow(start, plan.interval, 'regular');
    const end = window.ok ? window.end : start;
    const bar = byStart.get(start);
    if (!bar) {
      const late = now < end + graceMs;
      return { ...out, stop: { status: late ? 'PENDING' : 'INSUFFICIENT_DATA', reason: (now < end ? 'BAR_NOT_COMPLETE ' : late ? 'BAR_NOT_YET_RECEIVED ' : 'DATA_GAP ') + toUtcIso(start) } };
    }
    if (bar.knowledge.knowledgeSource === 'legacy_unproven') out.legacyBars++;
    out.bars.push(bar);
    start = calendar.nextBarStart(start, plan.interval, 'regular');
  }
  return out;
}

/** The exit of a position held from the walk's first bar (the first bar's open is the reference at the start). */
function exitOf(plan: AnyPlan, side: 'long' | 'short', held: Walk): { exit: { k: number; bar: MarketBar; reason: ExitReason; price: Decimal } | null; ambiguous: number; assumed: boolean; indeterminate: string | null } {
  const long = side === 'long';
  const stop = Decimal.from(plan.stopLoss);
  const target = plan.takeProfit !== undefined ? Decimal.from(plan.takeProfit) : null;
  let ambiguous = 0;
  let assumed = false;
  for (let i = 0; i < held.bars.length; i++) {
    const k = i + 1;
    const bar = held.bars[i]!;
    const open = bar.open;
    if (long ? open.lte(stop) : open.gte(stop)) return { exit: { k, bar, reason: 'stop_gap', price: open }, ambiguous, assumed, indeterminate: null };
    if (target !== null && (long ? open.gte(target) : open.lte(target))) return { exit: { k, bar, reason: 'target_gap', price: k === 1 ? open : target }, ambiguous, assumed, indeterminate: null };
    const stopHit = long ? bar.low.lte(stop) : bar.high.gte(stop);
    const targetHit = target !== null && (long ? bar.high.gte(target) : bar.low.lte(target));
    if (stopHit && targetHit) {
      ambiguous++;
      if (plan.intrabarPolicy === 'indeterminate') return { exit: null, ambiguous, assumed, indeterminate: 'STOP_AND_TARGET_IN_ONE_BAR ' + bar.startTime };
      assumed = true;
      return { exit: { k, bar, reason: 'stop', price: stop }, ambiguous, assumed, indeterminate: null };
    }
    if (stopHit) return { exit: { k, bar, reason: 'stop', price: stop }, ambiguous, assumed, indeterminate: null };
    if (targetHit) return { exit: { k, bar, reason: 'target', price: target! }, ambiguous, assumed, indeterminate: null };
    if (k === plan.maxHoldingBars) return { exit: { k, bar, reason: 'time', price: bar.close }, ambiguous, assumed, indeterminate: null };
  }
  return { exit: null, ambiguous, assumed, indeterminate: null };
}

export function simulateTradePlan(plan: TradePlan, bars: readonly MarketBar[], calendar: TradingCalendar, evaluatedAt: string, options: SimulationOptions = {}): PlanSimulation {
  const w = walk(plan, bars, calendar, plan.entry.earliestEntryAt, plan.maxHoldingBars, evaluatedAt, options.dataGraceMs ?? DEFAULT_DATA_GRACE_MS);
  if ('refused' in w) return base('entry', 'INSUFFICIENT_DATA', [w.refused]);
  const long = plan.side === 'long';
  const adverse = bp(plan.costs.spreadBps).dividedBy(2, SCALE, 'half_even').plus(bp(plan.costs.slippageBps));
  const fill = (price: Decimal, buying: boolean) => (buying ? price.times(Decimal.ONE.plus(adverse)) : price.times(Decimal.ONE.minus(adverse)));
  const first = w.bars[0];
  const entryFill = first ? fill(first.open, long) : null;
  const quantity = entryFill === null ? null : plan.size.kind === 'quantity' ? Decimal.from(plan.size.quantity) : Decimal.from(plan.size.amount).dividedBy(entryFill, SCALE, 'half_even');
  const entry = first && entryFill ? { barStart: first.startTime, referencePrice: first.open.toString(), fillPrice: entryFill.toString() } : null;
  const x = exitOf(plan, plan.side, w);
  const common = { entry, quantity: quantity?.toString() ?? null, ambiguousBars: x.ambiguous, legacyBars: w.legacyBars, assumptions: assumptionsOf(plan) };
  if (x.indeterminate) return base('entry', 'INDETERMINATE', [x.indeterminate], { ...common, barsHeld: w.bars.length });
  if (!x.exit) return base('entry', w.stop?.status ?? 'INSUFFICIENT_DATA', [w.stop?.reason ?? 'NO_EXIT_REACHED'], { ...common, barsHeld: w.bars.length });
  const qty = quantity!;
  const exitFill = fill(x.exit.price, !long);
  const gross = long ? qty.times(exitFill.minus(entryFill!)) : qty.times(entryFill!.minus(exitFill));
  const commission = bp(plan.costs.commissionBps);
  const fixed = Decimal.from(plan.costs.fixedFeePerSide);
  const fees = qty.times(entryFill!).times(commission).plus(qty.times(exitFill).times(commission)).plus(fixed).plus(fixed);
  const executionCosts = qty.times(entryFill!.minus(first!.open).abs()).plus(qty.times(exitFill.minus(x.exit.price).abs()));
  const net = gross.minus(fees);
  const risk = qty.times(entryFill!.minus(Decimal.from(plan.stopLoss)).abs());
  return {
    ...base('entry', 'COMPLETED', x.assumed ? ['CONSERVATIVE_STOP_FIRST'] : [], common),
    exit: { barStart: x.exit.bar.startTime, reason: x.exit.reason, referencePrice: x.exit.price.toString(), fillPrice: exitFill.toString() },
    barsHeld: x.exit.k,
    assumptionUsed: x.assumed,
    grossPnl: gross.toString(),
    fees: fees.toString(),
    executionCosts: executionCosts.toString(),
    netPnl: net.toString(),
    riskAmount: risk.toString(),
    netR: risk.isZero() ? null : net.dividedBy(risk, 6, 'half_even').toString(),
  };
}

/**
 * Hold versus close now for an OPEN position. Both alternatives start at the decision bar (the first expected bar at or after
 * decisionAt) with the same fill model: closing now sells (long) or buys back (short) at that bar's open; holding exits under the
 * plan. Nothing is entered and the costs already paid are not charged again: the result is the DIFFERENCE between the two.
 */
export function simulateContinuation(plan: ContinuationPlan, bars: readonly MarketBar[], calendar: TradingCalendar, evaluatedAt: string, options: SimulationOptions = {}): PlanSimulation {
  const w = walk(plan, bars, calendar, plan.decisionAt, plan.maxHoldingBars, evaluatedAt, options.dataGraceMs ?? DEFAULT_DATA_GRACE_MS);
  if ('refused' in w) return base('continuation', 'INSUFFICIENT_DATA', [w.refused]);
  const side = plan.position.side;
  const long = side === 'long';
  const qty = Decimal.from(plan.position.quantity);
  const adverse = bp(plan.costs.spreadBps).dividedBy(2, SCALE, 'half_even').plus(bp(plan.costs.slippageBps));
  /** The exit fill of the position: a long sells (receives less), a short buys back (pays more). */
  const exitFillOf = (price: Decimal) => (long ? price.times(Decimal.ONE.minus(adverse)) : price.times(Decimal.ONE.plus(adverse)));
  const commission = bp(plan.costs.commissionBps);
  const fixed = Decimal.from(plan.costs.fixedFeePerSide);
  const feeOf = (fillPrice: Decimal) => qty.times(fillPrice).times(commission).plus(fixed);
  const first = w.bars[0];
  const common = { quantity: qty.toString(), legacyBars: w.legacyBars, assumptions: assumptionsOf(plan) };
  if (!first) return base('continuation', w.stop?.status ?? 'INSUFFICIENT_DATA', [w.stop?.reason ?? 'NO_EXPECTED_BAR'], common);
  const closeFill = exitFillOf(first.open);
  const closeFees = feeOf(closeFill);
  const closeNow = { barStart: first.startTime, referencePrice: first.open.toString(), fillPrice: closeFill.toString(), fees: closeFees.toString() };
  const x = exitOf(plan, side, w);
  const withClose = { ...common, closeNow, ambiguousBars: x.ambiguous };
  if (x.indeterminate) return base('continuation', 'INDETERMINATE', [x.indeterminate], { ...withClose, barsHeld: w.bars.length });
  if (!x.exit) return base('continuation', w.stop?.status ?? 'INSUFFICIENT_DATA', [w.stop?.reason ?? 'NO_EXIT_REACHED'], { ...withClose, barsHeld: w.bars.length });
  const holdFill = exitFillOf(x.exit.price);
  const holdFees = feeOf(holdFill);
  // Holding versus closing now, both exits of the same quantity: a long gains when it sells higher, a short when it buys back lower.
  const gross = long ? qty.times(holdFill.minus(closeFill)) : qty.times(closeFill.minus(holdFill));
  const fees = holdFees.minus(closeFees);
  const net = gross.minus(fees);
  const risk = qty.times(first.open.minus(Decimal.from(plan.stopLoss)).abs());
  const executionCosts = qty.times(holdFill.minus(x.exit.price).abs()).plus(qty.times(closeFill.minus(first.open).abs()));
  return {
    ...base('continuation', 'COMPLETED', x.assumed ? ['CONSERVATIVE_STOP_FIRST'] : [], withClose),
    exit: { barStart: x.exit.bar.startTime, reason: x.exit.reason, referencePrice: x.exit.price.toString(), fillPrice: holdFill.toString() },
    barsHeld: x.exit.k,
    assumptionUsed: x.assumed,
    grossPnl: gross.toString(),
    fees: fees.toString(),
    executionCosts: executionCosts.toString(),
    netPnl: net.toString(),
    riskAmount: risk.toString(),
    netR: risk.isZero() ? null : net.dividedBy(risk, 6, 'half_even').toString(),
  };
}
