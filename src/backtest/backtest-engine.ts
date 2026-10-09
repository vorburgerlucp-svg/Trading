// Single-instrument deterministic Backtest Engine core (backtest-engine:v5).
//
// Event convention per final bar becoming usable (its usable instant: its gate, or for a proven revision the instant NEXUS held it):
//   0. corporate actions effective at this bar's open are applied (corporate-action-engine:v1), when accounting is enabled
//   1. process a market order created from an earlier bar at this bar's OPEN
//   2. process protective stop/take-profit over this bar
//   3. mark the portfolio at this bar's CLOSE, now that the bar is available
//   4. warm-up gate: while fewer than requiredBars bars are available at this event, stop here.
//      The strategy is not called, so warm-up can create no decision, no order and no fill.
//   5. evaluate the strategy using only bars whose usable instant is <= this event time, on the split-normalised view
//   6. create (but never fill) new market orders for a later bar
//
// This intentionally forbids same-bar execution from final-close decisions.

import { knownAtMs, replayInstantMs, vintageOf } from '../market-data/bar-replay.js';
import type { BarReplayMode, MarketBar } from '../market-data/market-data-types.js';
import { parseUtc, toUtcIso } from '../market-data/time.js';
import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import { DeterministicCostModel } from './cost-model.js';
import { CORPORATE_ACTION_REASON_TEXT, CorporateActionLedger, type AttachedLevels } from './corporate-action-engine.js';
import { executionClockIdentity, executionOpenOf, isEligibleAtOpen } from './execution-clock.js';
import { protectiveExitForLong } from './execution-model.js';
import { backtestMetrics } from './performance.js';
import { PointInTimeBarState, buildBarAvailabilityQueue } from './point-in-time.js';
import { assessBacktestQuality } from './quality.js';
import { desiredLongQuantity } from './sizing.js';
import type {
  BacktestBarKnowledge,
  BacktestFill,
  BacktestInput,
  BacktestPosition,
  BacktestQuality,
  BacktestRunResult,
  BacktestTrade,
  BacktestWarmupResult,
  CorporateActionReasonCode,
  FillTiming,
} from './backtest-types.js';
import type { BacktestStrategy, StrategyDecision } from './strategy.js';
import { validateWarmupPlan, type WarmupPlan } from './warmup.js';

/**
 * v8: the grade uses derived universe evidence (universe-engine:v1), never the caller's pointInTimeUniverse flag. v7 and earlier runs are not reinterpreted.
 * v7: fills execute at the executable market open (execution-clock:v1), not at a daily bar's window start; a signal fills at an open only
 * if it was usable by then; fills carry explicit timing (OPEN_EXACT or INTRABAR_UNKNOWN). v6 and earlier runs are not reinterpreted.
 */
export const BACKTEST_ENGINE_VERSION = 'backtest-engine:v8';

interface PendingOrder {
  side: 'buy' | 'sell';
  /** The instant the signal became usable (the event that created it), in ms. An executable open must be at or after it. */
  decidedAt: number;
  stopLoss: Decimal | null;
  takeProfit: Decimal | null;
}

/** The price levels attached to a pending entry, as the corporate-action engine transforms them. */
function levelsOf(order: PendingOrder | null): AttachedLevels | null {
  return order === null ? null : { stopLoss: order.stopLoss, takeProfit: order.takeProfit };
}

/** The pending entry with the levels the corporate-action engine transformed (a split changes its price levels). */
function withLevels(order: PendingOrder | null, levels: AttachedLevels | null): PendingOrder | null {
  if (order === null || levels === null) return order;
  return { ...order, stopLoss: levels.stopLoss, takeProfit: levels.takeProfit };
}

function minDecimal(a: Decimal, b: Decimal): Decimal {
  return a.lte(b) ? a : b;
}

function barFingerprint(bar: MarketBar): unknown[] {
  const k = bar.knowledge;
  return [bar.instrumentId, bar.startTime, bar.endTime, bar.open, bar.high, bar.low, bar.close, bar.volume ?? null, bar.observedAt, bar.availableAt, bar.retrievedAt, k.knownAt, k.knowledgeSource, k.vintage, k.vintagePolicy, bar.isFinal, bar.source, bar.adjustment];
}

/**
 * Per bar: was the revision NEXUS held at the simulated use time, and was it contemporaneous with its market time. A legacy bar is
 * never known. These counts are the input of the provenance grading (quality.ts).
 */
function barKnowledgeAtUse(bars: readonly MarketBar[], mode: BarReplayMode): BacktestBarKnowledge {
  const out: BacktestBarKnowledge = { total: bars.length, knownBeforeUse: 0, contemporaneousVintage: 0, historicalVintage: 0, legacy: 0 };
  for (const bar of bars) {
    const vintage = vintageOf(bar);
    if (vintage === 'legacy_unproven') out.legacy++;
    else if (vintage === 'contemporaneous') out.contemporaneousVintage++;
    else out.historicalVintage++;
    const known = knownAtMs(bar);
    if (known !== null && known <= replayInstantMs(bar, mode)) out.knownBeforeUse++;
  }
  return out;
}

function decisionToPending(decision: StrategyDecision, decidedAt: number): PendingOrder | null {
  if (decision.action === 'ENTER_LONG') {
    return { side: 'buy', decidedAt, stopLoss: decision.stopLoss ?? null, takeProfit: decision.takeProfit ?? null };
  }
  if (decision.action === 'EXIT_LONG') {
    return { side: 'sell', decidedAt, stopLoss: null, takeProfit: null };
  }
  return null;
}

/** The economic execution instant of a fill: the open for an exact fill; for an intrabar touch, the bar window start (never an execution time). */
function fillAt(timing: FillTiming): string {
  return timing.kind === 'OPEN_EXACT' ? timing.executionAt : timing.barStart;
}

function assertChronologicalAvailability(bars: readonly MarketBar[], mode: BarReplayMode): void {
  const ordered = [...bars].sort((a, b) => parseUtc(a.startTime) - parseUtc(b.startTime));
  let previousAvailable = Number.NEGATIVE_INFINITY;
  for (const bar of ordered) {
    const available = replayInstantMs(bar, mode);
    if (available < previousAvailable) {
      throw new Error('V1 backtest does not support per-instrument availability inversion; an older bar arrived after a newer bar');
    }
    previousAvailable = available;
  }
}

/** The warm-up plan as it enters the input fingerprint: exactly these fields, nothing the strategy adds. */
function warmupPlanOf(plan: WarmupPlan): WarmupPlan {
  return { algorithmVersion: plan.algorithmVersion, requiredBars: plan.requiredBars, preferredBars: plan.preferredBars };
}

/**
 * Warm-up never widens a result. Too little history makes the run INVALID (fail closed, still stored for audit).
 * A reached requiredBars with an unmet preferredBars is a visible hint only: the grade is not changed, because the
 * preferred history is a stability goal and not a validity rule.
 */
function applyWarmupToQuality(base: BacktestQuality, w: { requiredWarmupMet: boolean; preferredWarmupMet: boolean; barsProcessed: number; requiredBars: number; preferredBars: number; strategyEvaluations: number; evaluationsBelowPreferred: number }): BacktestQuality {
  if (!w.requiredWarmupMet) {
    return {
      grade: 'INVALID',
      reasons: ['INSUFFICIENT_WARMUP_HISTORY: ' + w.barsProcessed + ' bar(s) available, requiredBars ' + w.requiredBars + '; the strategy was never evaluated, so no order or fill exists', ...base.reasons],
      insufficientSample: base.insufficientSample,
      dataProvenance: base.dataProvenance,
      barKnowledge: base.barKnowledge,
    };
  }
  if (!w.preferredWarmupMet) {
    return {
      ...base,
      reasons: [...base.reasons, 'PREFERRED_WARMUP_NOT_MET: ' + w.evaluationsBelowPreferred + ' of ' + w.strategyEvaluations + ' evaluation(s) had fewer than preferredBars ' + w.preferredBars + ' bars'],
    };
  }
  return base;
}

const ISO_CURRENCY = /^[A-Z]{3}$/;

export function runBacktest(rawInput: BacktestInput & { strategy: BacktestStrategy }): BacktestRunResult {
  // The engine owns its data. Bars are copied into frozen objects before any strategy sees them, so a strategy can
  // neither change the input nor change the identity computed from it.
  const input = { ...rawInput, bars: rawInput.bars.map((b) => Object.freeze({ ...b })) };
  if (!input.initialCapital.isPositive()) throw new Error('initial capital must be positive');
  if (!ISO_CURRENCY.test(input.portfolioCurrency)) throw new Error('portfolio currency must be an ISO 4217 code');
  if (input.bars.length === 0) throw new Error('backtest requires bars');
  const warmup = validateWarmupPlan(input.strategy.warmup);
  const instrumentId = input.bars[0]!.instrumentId;
  if (input.bars.some((b) => b.instrumentId !== instrumentId)) throw new Error('V1 backtest is single-instrument');
  if (input.bars.some((b) => !b.isFinal)) throw new Error('backtest accepts final bars only');
  const first = input.bars[0]!;
  const starts = new Set<string>();
  for (const bar of input.bars) {
    if (bar.interval !== first.interval || bar.session !== first.session || bar.adjustment !== first.adjustment || bar.source !== first.source) {
      throw new Error('backtest bars must be one uniform interval/session/adjustment/source series');
    }
    if (starts.has(bar.startTime)) throw new Error('backtest bars contain a duplicate startTime');
    starts.add(bar.startTime);
  }
  // Explicit accounting needs raw prices: the position is adjusted here, so split-adjusted bars would adjust it twice.
  if (input.corporateActions && first.adjustment !== 'raw') {
    throw new Error('CORPORATE_ACTION_DOUBLE_ADJUSTMENT_RISK: ' + CORPORATE_ACTION_REASON_TEXT.CORPORATE_ACTION_DOUBLE_ADJUSTMENT_RISK + ' (got ' + first.adjustment + ')');
  }
  if (input.corporateActions && input.corporateActions.calendar.calendarId !== input.executionCalendar.calendarId) {
    throw new Error('corporate actions and execution use different calendars (' + input.corporateActions.calendar.calendarId + ' vs ' + input.executionCalendar.calendarId + ')');
  }
  const replay: BarReplayMode = input.replay ?? 'historical_research';
  assertChronologicalAvailability(input.bars, replay);

  const events = buildBarAvailabilityQueue({ [instrumentId]: input.bars }, replay);
  const state = new PointInTimeBarState(replay);
  const costModel = new DeterministicCostModel(input.costModel);
  const intrabarPolicy = input.intrabarPolicy ?? 'conservative';
  const ledger = input.corporateActions ? new CorporateActionLedger(input.corporateActions, input.portfolioCurrency, first) : null;
  let cash = input.initialCapital;
  let position: BacktestPosition | null = null;
  let pending: PendingOrder | null = null;
  let totalFees = Decimal.ZERO;
  let ambiguousBars = 0;
  let exposedPoints = 0;
  let warmupBars = 0;
  let tradableBars = 0;
  let strategyEvaluations = 0;
  let evaluationsBelowPreferred = 0;
  let firstStrategyEvaluationAt: string | null = null;
  let preferredWarmupCompleteAt: string | null = null;
  let fillSequence = 0;
  let tradeSequence = 0;
  let lastRawClose: Decimal | null = null;
  const fills: BacktestFill[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: BacktestRunResult['equityCurve'] = [];

  const addFill = (fill: Omit<BacktestFill, 'fillId'>): BacktestFill => {
    const complete: BacktestFill = { ...fill, fillId: 'fill_' + String(++fillSequence).padStart(6, '0') };
    fills.push(complete);
    totalFees = totalFees.plus(complete.commission);
    return complete;
  };

  const closePosition = (_bar: MarketBar, rawPrice: Decimal, reason: BacktestFill['reason'], timing: FillTiming): void => {
    if (!position) return;
    const openPosition = position;
    const quote = costModel.quote(rawPrice, 'sell', openPosition.quantity);
    const exitFill = addFill({ instrumentId, side: 'sell', reason, at: fillAt(timing), timing, rawPrice, executionPrice: quote.executionPrice, quantity: openPosition.quantity, commission: quote.commission });
    const exitNet = quote.executionPrice.times(openPosition.quantity).minus(quote.commission);
    // The entry is resolved by its immutable id. Its cost is the entry fill itself: a split changes the per-share basis, never the total.
    const entryFill = fills.find((f) => f.fillId === openPosition.entryFillId);
    if (!entryFill || entryFill.side !== 'buy') throw new Error('entry fill missing for open position');
    const entryCost = entryFill.executionPrice.times(entryFill.quantity).plus(entryFill.commission);
    const pnl = exitNet.minus(entryCost);
    const returnPct = entryCost.isZero() ? 0 : pnl.dividedBy(entryCost, 12, 'half_even').times(100).toNumber();
    trades.push({ tradeId: 'trade_' + String(++tradeSequence).padStart(6, '0'), instrumentId, entry: entryFill, exit: exitFill, pnl, returnPct });
    cash = cash.plus(exitNet);
    position = null;
  };

  for (const event of events) {
    const bar = event.bar;
    state.advance(event);

    // 0. Corporate actions effective at this bar's open, before anything is processed at that open.
    if (ledger) {
      const step = ledger.applyDue({ bar, eventMs: parseUtc(event.availableAt), position, levels: levelsOf(pending), lastRawClose });
      position = step.position;
      pending = withLevels(pending, step.levels);
    }

    // 1. Market order created earlier, at this bar's EXECUTABLE open (execution-clock:v1). A signal fills there only if it was usable by
    //    that open (equality is eligible). A signal usable after the open waits for the next executable open; it never fills retroactively.
    if (pending) {
      const open = executionOpenOf(bar, input.executionCalendar);
      if (isEligibleAtOpen(pending.decidedAt, open.openMs)) {
        const timing: FillTiming = { kind: 'OPEN_EXACT', executionAt: toUtcIso(open.openMs), barStart: bar.startTime, openSource: open.source };
        if (pending.side === 'buy' && !position) {
          const estimatedExecution = costModel.executionPrice(bar.open, 'buy');
          const desired = desiredLongQuantity({ sizing: input.sizing, cash, equity: cash, executionPrice: estimatedExecution, stopLoss: pending.stopLoss });
          const affordable = costModel.maxAffordableQuantity(cash, bar.open);
          const quantity = minDecimal(desired, affordable);
          if (quantity.isPositive()) {
            const quote = costModel.quote(bar.open, 'buy', quantity);
            const total = quote.executionPrice.times(quantity).plus(quote.commission);
            if (total.lte(cash)) {
              const fill = addFill({ instrumentId, side: 'buy', reason: 'market_entry', at: fillAt(timing), timing, rawPrice: bar.open, executionPrice: quote.executionPrice, quantity, commission: quote.commission });
              cash = cash.minus(total);
              position = { instrumentId, entryFillId: fill.fillId, quantity, entryPrice: quote.executionPrice, entryTime: fill.at, entryCommission: quote.commission, stopLoss: pending.stopLoss, takeProfit: pending.takeProfit };
            }
          }
        } else if (pending.side === 'sell' && position) {
          closePosition(bar, bar.open, 'strategy_exit', timing);
        }
        pending = null;
      }
    }

    // 2. Protective exits over this bar. A gap through a level executes at the open (exact). A level touched inside the bar's range has
    //    an instant that OHLC cannot give: it is recorded as INTRABAR_UNKNOWN with the bar window, never as an exact time.
    if (position && (position.stopLoss !== null || position.takeProfit !== null)) {
      const protective = protectiveExitForLong(bar, position.stopLoss, position.takeProfit, intrabarPolicy);
      if (protective?.kind === 'ambiguous') ambiguousBars++;
      else if (protective?.rawFillPrice) {
        const timing: FillTiming =
          protective.timing === 'OPEN_EXACT'
            ? (() => {
                const open = executionOpenOf(bar, input.executionCalendar);
                return { kind: 'OPEN_EXACT' as const, executionAt: toUtcIso(open.openMs), barStart: bar.startTime, openSource: open.source };
              })()
            : { kind: 'INTRABAR_UNKNOWN', barStart: bar.startTime, barEnd: bar.endTime };
        closePosition(bar, protective.rawFillPrice, protective.kind, timing);
      }
    }

    // 3. Mark at close. Receivables are economic value in equity, never cash.
    const receivablesValue = ledger ? ledger.receivablesValue() : Decimal.ZERO;
    const marketValue = position ? position.quantity.times(bar.close) : Decimal.ZERO;
    const equity = cash.plus(marketValue).plus(receivablesValue);
    equityCurve.push({ at: event.availableAt, cash, marketValue, receivablesValue, equity });
    lastRawClose = bar.close;

    // 4. Warm-up gate (hard). Warm-up events stay in the equity history but never reach the strategy.
    const history = Object.freeze(state.historyAt(instrumentId, event.availableAt));
    if (history.length < warmup.requiredBars) {
      warmupBars++;
      continue;
    }

    // 5. Evaluation. Each tradable event is evaluated exactly once, on the split-normalised view when accounting is enabled.
    tradableBars++;
    if (position) exposedPoints++;
    strategyEvaluations++;
    firstStrategyEvaluationAt ??= event.availableAt;
    if (history.length < warmup.preferredBars) evaluationsBelowPreferred++;
    else preferredWarmupCompleteAt ??= event.availableAt;

    const view = ledger ? ledger.strategyView(history, bar, parseUtc(event.availableAt)) : { history, currentBar: bar };
    // A frozen copy of the open position: the strategy reads its levels, the engine alone changes them.
    const decision = input.strategy.evaluate({ instrumentId, asOf: event.availableAt, currentBar: view.currentBar, history: view.history, position: position === null ? null : Object.freeze({ ...position }) });
    if (!pending) {
      const decidedAt = parseUtc(event.availableAt);
      if (decision.action === 'ENTER_LONG' && !position) pending = decisionToPending(decision, decidedAt);
      else if (decision.action === 'EXIT_LONG' && position) pending = decisionToPending(decision, decidedAt);
    }
  }

  const barsProcessed = events.length;
  const requiredWarmupMet = barsProcessed >= warmup.requiredBars;
  const preferredWarmupMet = strategyEvaluations > 0 && evaluationsBelowPreferred === 0;
  const endingEquity = equityCurve.at(-1)?.equity ?? cash;
  const metrics = backtestMetrics({ startingCapital: input.initialCapital, endingEquity, trades, equityCurve, totalFees, exposedPoints, tradablePoints: tradableBars });

  // Quality is derived from what the engine proved. A caller's `modeled` that the engine did not prove is refused, as a reason.
  const corporateActions = ledger ? ledger.result() : undefined;
  const caReasons: CorporateActionReasonCode[] = corporateActions ? [...corporateActions.reasons] : [];
  if (input.quality.corporateActions === 'modeled' && (!corporateActions || !corporateActions.complete)) caReasons.push('CORPORATE_ACTION_CLAIM_NOT_PROVEN');
  const modeled = corporateActions !== undefined && corporateActions.complete && caReasons.length === 0;
  const assessed = assessBacktestQuality({ ...input.quality, corporateActions: modeled ? 'modeled' : 'not_modeled' }, trades.length, ambiguousBars, costModel.isZeroCost(), barKnowledgeAtUse(input.bars, replay), caReasons, input.universe ?? null);
  const quality = applyWarmupToQuality(assessed, { requiredWarmupMet, preferredWarmupMet, barsProcessed, requiredBars: warmup.requiredBars, preferredBars: warmup.preferredBars, strategyEvaluations, evaluationsBelowPreferred });
  const warmupResult: BacktestWarmupResult = {
    algorithmVersion: warmup.algorithmVersion,
    requiredBars: warmup.requiredBars,
    preferredBars: warmup.preferredBars,
    requiredWarmupMet,
    preferredWarmupMet,
    firstStrategyEvaluationAt,
    preferredWarmupCompleteAt,
    warmupBars,
    tradableBars,
    strategyEvaluations,
    evaluationsBelowPreferred,
  };
  const strategyFingerprint = hashOf({ id: input.strategy.id, version: input.strategy.version, definition: input.strategy.definition });
  const inputFingerprint = hashOf({
    engine: BACKTEST_ENGINE_VERSION,
    strategyFingerprint,
    warmup: warmupPlanOf(warmup),
    initialCapital: input.initialCapital,
    portfolioCurrency: input.portfolioCurrency,
    sizing: input.sizing,
    costModel: costModel.config,
    intrabarPolicy,
    qualityContext: input.quality,
    replay,
    corporateActions: ledger ? ledger.fingerprintRows() : null,
    executionClock: executionClockIdentity(input.executionCalendar),
    universe: input.universe ?? null,
    bars: input.bars.map(barFingerprint),
  });

  return {
    backtestRunId: 'bt_' + inputFingerprint.slice(0, 40),
    engineVersion: BACKTEST_ENGINE_VERSION,
    instrumentId,
    strategyId: input.strategy.id,
    strategyVersion: input.strategy.version,
    strategyDefinition: structuredClone(input.strategy.definition),
    strategyFingerprint,
    inputFingerprint,
    initialCapital: input.initialCapital,
    portfolioCurrency: input.portfolioCurrency,
    executionClock: executionClockIdentity(input.executionCalendar),
    costModel: costModel.config,
    sizing: input.sizing,
    intrabarPolicy,
    barsProcessed,
    fills,
    trades,
    equityCurve,
    openPosition: position,
    metrics,
    quality,
    ambiguousBars,
    warmup: warmupResult,
    ...(corporateActions ? { corporateActions } : {}),
    ...(input.universe ? { universe: input.universe } : {}),
  };
}
