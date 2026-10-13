import { knownAtMs, replayInstantMs, vintageOf } from '../market-data/bar-replay.js';
import type { BarReplayMode, MarketBar } from '../market-data/market-data-types.js';
import type { TradingCalendar } from '../market-data/sessions.js';
import { parseUtc, toUtcIso } from '../market-data/time.js';
import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import type { BacktestStrategy, StrategyDecision } from './strategy.js';
import {
  type BacktestBarKnowledge,
  type BacktestEquityPoint,
  type BacktestFill,
  type BacktestMetrics,
  type BacktestPosition,
  type BacktestQuality,
  type BacktestQualityContext,
  type BacktestTrade,
  type EntryRiskSizingAudit,
  type FillTiming,
  type PositionSizing,
} from './backtest-types.js';
import { DeterministicCostModel, type CostModelConfig } from './cost-model.js';
import { executionClockIdentity, executionOpenOf, executionWindowOf, isEligibleAtOpen } from './execution-clock.js';
import { INTRABAR_TIMING_VERSION, protectiveExitForLong, type IntrabarFillPolicy } from './execution-model.js';
import { backtestMetrics } from './performance.js';
import { buildBarAvailabilityQueue, PointInTimeBarState, type BarAvailabilityEvent } from './point-in-time.js';
import { assessBacktestQuality } from './quality.js';
import { desiredLongQuantity, maxRiskSizedLongQuantity, RISK_SIZING_VERSION, riskPerTradeConfigOf } from './sizing.js';
import { validateWarmupPlan } from './warmup.js';

export const PORTFOLIO_BACKTEST_VERSION = 'portfolio-backtest:v1' as const;

export interface PortfolioBacktestInput {
  seriesByInstrument: Readonly<Record<string, readonly MarketBar[]>>;
  strategy: BacktestStrategy;
  executionCalendars: Readonly<Record<string, TradingCalendar>>;
  initialCapital: Decimal;
  portfolioCurrency: string;
  sizing: PositionSizing;
  costModel: CostModelConfig;
  quality: BacktestQualityContext;
  intrabarPolicy?: IntrabarFillPolicy;
  replay?: BarReplayMode;
}

export interface PortfolioBacktestResult {
  portfolioRunId: string;
  engineVersion: typeof PORTFOLIO_BACKTEST_VERSION;
  inputFingerprint: string;
  strategyId: string;
  strategyVersion: string;
  strategyDefinition: Readonly<Record<string, unknown>>;
  strategyFingerprint: string;
  instrumentIds: string[];
  initialCapital: Decimal;
  portfolioCurrency: string;
  sizing: PositionSizing;
  costModel: Readonly<CostModelConfig>;
  intrabarPolicy: IntrabarFillPolicy;
  fills: BacktestFill[];
  trades: BacktestTrade[];
  openPositions: BacktestPosition[];
  equityCurve: BacktestEquityPoint[];
  metrics: BacktestMetrics;
  quality: BacktestQuality;
  ambiguousBars: number;
}

export class PortfolioAllocationAmbiguousError extends Error {
  override readonly name = 'PortfolioAllocationAmbiguousError';
  readonly code = 'PORTFOLIO_ALLOCATION_AMBIGUOUS';
}

interface PendingOrder {
  side: 'buy' | 'sell';
  decidedAt: number;
  stopLoss: Decimal | null;
  takeProfit: Decimal | null;
}

interface EligibleOrder {
  instrumentId: string;
  order: PendingOrder;
  event: BarAvailabilityEvent;
  openMs: number;
  openSource: 'regular_session_open' | 'intraday_bar_start';
}

interface PlannedBuy {
  eligible: EligibleOrder;
  quantity: Decimal;
  executionPrice: Decimal;
  commission: Decimal;
  total: Decimal;
  riskSizing?: EntryRiskSizingAudit;
}

const ISO_CURRENCY = /^[A-Z]{3}$/;

function minDecimal(a: Decimal, b: Decimal): Decimal {
  return a.lte(b) ? a : b;
}

function fillAt(timing: FillTiming): string {
  if (timing.kind === 'OPEN_EXACT') return timing.executionAt;
  if (timing.kind === 'INTRABAR_BOUNDED') return timing.earliestAt;
  return timing.barStart;
}

function decisionToPending(decision: StrategyDecision, decidedAt: number): PendingOrder | null {
  if (decision.action === 'ENTER_LONG') {
    return { side: 'buy', decidedAt, stopLoss: decision.stopLoss ?? null, takeProfit: decision.takeProfit ?? null };
  }
  if (decision.action === 'EXIT_LONG') return { side: 'sell', decidedAt, stopLoss: null, takeProfit: null };
  return null;
}

function barFingerprint(bar: MarketBar): unknown[] {
  const k = bar.knowledge;
  return [
    bar.instrumentId,
    bar.interval,
    bar.startTime,
    bar.endTime,
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume ?? null,
    bar.observedAt,
    bar.availableAt,
    bar.retrievedAt,
    k.knownAt,
    k.knowledgeSource,
    k.vintage,
    k.vintagePolicy,
    bar.isFinal,
    bar.source,
    bar.session,
    bar.adjustment,
  ];
}

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

function assertChronologicalAvailability(bars: readonly MarketBar[], mode: BarReplayMode): void {
  const ordered = [...bars].sort((a, b) => parseUtc(a.startTime) - parseUtc(b.startTime));
  let previous = Number.NEGATIVE_INFINITY;
  for (const bar of ordered) {
    const available = replayInstantMs(bar, mode);
    if (available < previous) throw new Error('portfolio backtest does not support per-instrument availability inversion');
    previous = available;
  }
}

function markedEquity(cash: Decimal, positions: ReadonlyMap<string, BacktestPosition>, marks: ReadonlyMap<string, Decimal>): Decimal {
  let equity = cash;
  for (const position of positions.values()) {
    const mark = marks.get(position.instrumentId);
    if (!mark) throw new Error('PORTFOLIO_MARK_UNPROVEN: no point-in-time-known mark for ' + position.instrumentId);
    equity = equity.plus(position.quantity.times(mark));
  }
  return equity;
}

function exactTiming(event: BarAvailabilityEvent, openMs: number, openSource: 'regular_session_open' | 'intraday_bar_start'): FillTiming {
  return { kind: 'OPEN_EXACT', executionAt: toUtcIso(openMs), barStart: event.bar.startTime, openSource };
}

/**
 * O7 V1 portfolio/world event loop.
 *
 * Bars with the same usable timestamp are one atomic information batch. Every bar in that batch is
 * made point-in-time-visible before strategy evaluation, while orders created by those evaluations
 * are not processed until a later batch. Scarce simultaneous buy cash fails closed rather than using
 * object/map/alphabetic order as an implicit allocator.
 */
export function runPortfolioBacktest(rawInput: PortfolioBacktestInput): PortfolioBacktestResult {
  if (!rawInput.initialCapital.isPositive()) throw new Error('initial capital must be positive');
  if (!ISO_CURRENCY.test(rawInput.portfolioCurrency)) throw new Error('portfolio currency must be an ISO 4217 code');

  const instrumentIds = Object.keys(rawInput.seriesByInstrument).sort();
  if (instrumentIds.length === 0) throw new Error('portfolio backtest requires at least one instrument');

  const replay: BarReplayMode = rawInput.replay ?? 'historical_research';
  const warmup = validateWarmupPlan(rawInput.strategy.warmup);
  const riskConfig = rawInput.sizing.type === 'risk_per_trade' ? riskPerTradeConfigOf(rawInput.sizing) : null;
  const intrabarPolicy = rawInput.intrabarPolicy ?? 'conservative';
  const costModel = new DeterministicCostModel(rawInput.costModel);

  const normalized: Record<string, readonly MarketBar[]> = {};
  for (const instrumentId of instrumentIds) {
    const source = rawInput.seriesByInstrument[instrumentId];
    if (!source || source.length === 0) throw new Error('portfolio series is empty for ' + instrumentId);
    const calendar = rawInput.executionCalendars[instrumentId];
    if (!calendar) throw new Error('execution calendar is missing for ' + instrumentId);

    const bars = source.map((bar) => Object.freeze({ ...bar })).sort((a, b) => parseUtc(a.startTime) - parseUtc(b.startTime));
    const first = bars[0]!;
    const starts = new Set<string>();
    for (const bar of bars) {
      if (bar.instrumentId !== instrumentId) throw new Error('series key does not match bar instrumentId');
      if (!bar.isFinal) throw new Error('portfolio backtest accepts final bars only');
      if (bar.interval !== first.interval || bar.session !== first.session || bar.adjustment !== first.adjustment || bar.source !== first.source) {
        throw new Error('portfolio bars must be uniform within each instrument series');
      }
      if (starts.has(bar.startTime)) throw new Error('portfolio bars contain duplicate startTime for ' + instrumentId);
      starts.add(bar.startTime);
    }
    assertChronologicalAvailability(bars, replay);
    normalized[instrumentId] = bars;
  }

  const events = buildBarAvailabilityQueue(normalized, replay);
  const state = new PointInTimeBarState(replay);
  const positions = new Map<string, BacktestPosition>();
  const pending = new Map<string, PendingOrder>();
  let latestMarks = new Map<string, Decimal>();
  let cash = rawInput.initialCapital;
  let fillSequence = 0;
  let tradeSequence = 0;
  let totalFees = Decimal.ZERO;
  let ambiguousBars = 0;
  let exposedPoints = 0;
  let tradablePoints = 0;
  const fills: BacktestFill[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: BacktestEquityPoint[] = [];

  const addFill = (fill: Omit<BacktestFill, 'fillId'>): BacktestFill => {
    const complete: BacktestFill = { ...fill, fillId: 'fill_' + String(++fillSequence).padStart(6, '0') };
    fills.push(complete);
    totalFees = totalFees.plus(complete.commission);
    return complete;
  };

  const closePosition = (instrumentId: string, rawPrice: Decimal, reason: BacktestFill['reason'], timing: FillTiming): void => {
    const position = positions.get(instrumentId);
    if (!position) return;
    const quote = costModel.quote(rawPrice, 'sell', position.quantity);
    const exitFill = addFill({
      instrumentId,
      side: 'sell',
      reason,
      at: fillAt(timing),
      timing,
      rawPrice,
      executionPrice: quote.executionPrice,
      quantity: position.quantity,
      commission: quote.commission,
    });
    const entryFill = fills.find((fill) => fill.fillId === position.entryFillId);
    if (!entryFill || entryFill.side !== 'buy') throw new Error('entry fill missing for portfolio position');
    const entryCost = entryFill.executionPrice.times(entryFill.quantity).plus(entryFill.commission);
    const exitNet = quote.executionPrice.times(position.quantity).minus(quote.commission);
    const pnl = exitNet.minus(entryCost);
    const returnPct = entryCost.isZero() ? 0 : pnl.dividedBy(entryCost, 12, 'half_even').times(100).toNumber();
    trades.push({
      tradeId: 'trade_' + String(++tradeSequence).padStart(6, '0'),
      instrumentId,
      entry: entryFill,
      exit: exitFill,
      pnl,
      returnPct,
    });
    cash = cash.plus(exitNet);
    positions.delete(instrumentId);
  };

  for (let cursor = 0; cursor < events.length; ) {
    const batchAt = events[cursor]!.availableAt;
    const batch: BarAvailabilityEvent[] = [];
    while (cursor < events.length && events[cursor]!.availableAt === batchAt) batch.push(events[cursor++]!);

    // Marks that were actually known before this batch. Open-time sizing must never use this batch's later closes.
    const sizingMarks = new Map(latestMarks);

    // Atomic information boundary: all same-time bars become visible before any strategy evaluation.
    for (const event of batch) state.advance(event);

    // Previously-created market orders. Select the first eligible bar of this batch per instrument.
    const eligible: EligibleOrder[] = [];
    for (const instrumentId of [...pending.keys()].sort()) {
      const order = pending.get(instrumentId)!;
      const calendar = rawInput.executionCalendars[instrumentId]!;
      const candidateEvents = batch
        .filter((event) => event.instrumentId === instrumentId)
        .sort((a, b) => parseUtc(a.bar.startTime) - parseUtc(b.bar.startTime));
      for (const event of candidateEvents) {
        const open = executionOpenOf(event.bar, calendar);
        if (isEligibleAtOpen(order.decidedAt, open.openMs)) {
          eligible.push({ instrumentId, order, event, openMs: open.openMs, openSource: open.source });
          break;
        }
      }
    }

    const groups = new Map<number, EligibleOrder[]>();
    for (const item of eligible) {
      const group = groups.get(item.openMs);
      if (group) group.push(item);
      else groups.set(item.openMs, [item]);
    }

    for (const openMs of [...groups.keys()].sort((a, b) => a - b)) {
      const group = groups.get(openMs)!.sort((a, b) => a.instrumentId.localeCompare(b.instrumentId));
      const cashBeforeGroup = cash;
      const equityBeforeGroup = markedEquity(cashBeforeGroup, positions, sizingMarks);
      const plannedBuys: PlannedBuy[] = [];

      for (const item of group) {
        if (item.order.side !== 'buy' || positions.has(item.instrumentId)) continue;
        const rawPrice = item.event.bar.open;
        if (riskConfig) {
          const sized = maxRiskSizedLongQuantity({
            costModel,
            rawEntryPrice: rawPrice,
            stopLoss: item.order.stopLoss,
            config: riskConfig,
            sizingEquity: cashBeforeGroup,
            spendableCash: cashBeforeGroup,
          });
          if (!sized.audit) continue;
          const quote = costModel.quote(rawPrice, 'buy', sized.quantity);
          const total = quote.executionPrice.times(sized.quantity).plus(quote.commission);
          plannedBuys.push({ eligible: item, quantity: sized.quantity, executionPrice: quote.executionPrice, commission: quote.commission, total, riskSizing: sized.audit });
        } else {
          const estimated = costModel.executionPrice(rawPrice, 'buy');
          const desired = desiredLongQuantity({ sizing: rawInput.sizing, cash: cashBeforeGroup, equity: equityBeforeGroup, executionPrice: estimated });
          const affordable = costModel.maxAffordableQuantity(cashBeforeGroup, rawPrice);
          const quantity = minDecimal(desired, affordable);
          if (!quantity.isPositive()) continue;
          const quote = costModel.quote(rawPrice, 'buy', quantity);
          const total = quote.executionPrice.times(quantity).plus(quote.commission);
          plannedBuys.push({ eligible: item, quantity, executionPrice: quote.executionPrice, commission: quote.commission, total });
        }
      }

      const combinedBuyCost = plannedBuys.reduce((sum, plan) => sum.plus(plan.total), Decimal.ZERO);
      if (plannedBuys.length > 1 && combinedBuyCost.gt(cashBeforeGroup)) {
        throw new PortfolioAllocationAmbiguousError(
          'PORTFOLIO_ALLOCATION_AMBIGUOUS: simultaneous buys require ' +
            combinedBuyCost.toString() +
            ' but only ' +
            cashBeforeGroup.toString() +
            ' is spendable; O7 V1 has no allocation tie-break policy',
        );
      }

      // Same-instant sells do not manufacture buying power for the simultaneous buy planning above.
      for (const item of group) {
        if (item.order.side === 'sell' && positions.has(item.instrumentId)) {
          closePosition(item.instrumentId, item.event.bar.open, 'strategy_exit', exactTiming(item.event, item.openMs, item.openSource));
          sizingMarks.delete(item.instrumentId);
        }
        pending.delete(item.instrumentId);
      }

      for (const plan of plannedBuys.sort((a, b) => a.eligible.instrumentId.localeCompare(b.eligible.instrumentId))) {
        const item = plan.eligible;
        // The combined-cost guard used the pre-group cash. A single order may still be unaffordable only
        // if an invariant above was violated; refuse rather than silently resizing.
        if (plan.total.gt(cash)) throw new Error('portfolio buy became unaffordable after deterministic batch planning');
        const timing = exactTiming(item.event, item.openMs, item.openSource);
        const fill = addFill({
          instrumentId: item.instrumentId,
          side: 'buy',
          reason: 'market_entry',
          at: fillAt(timing),
          timing,
          rawPrice: item.event.bar.open,
          executionPrice: plan.executionPrice,
          quantity: plan.quantity,
          commission: plan.commission,
          ...(plan.riskSizing ? { riskSizing: plan.riskSizing } : {}),
        });
        cash = cash.minus(plan.total);
        positions.set(item.instrumentId, {
          instrumentId: item.instrumentId,
          entryFillId: fill.fillId,
          quantity: plan.quantity,
          entryPrice: plan.executionPrice,
          entryTime: fill.at,
          entryCommission: plan.commission,
          stopLoss: item.order.stopLoss,
          takeProfit: item.order.takeProfit,
        });
        // Known exact economic value at the fill instant; useful only if this unusual batch later contains
        // another, strictly later execution group before a new close is available.
        sizingMarks.set(item.instrumentId, plan.executionPrice);
      }
    }

    // Protective exits in economic bar order. A later-bar entry is never tested against an earlier bar.
    const protectiveEvents = [...batch].sort((a, b) => {
      const byStart = parseUtc(a.bar.startTime) - parseUtc(b.bar.startTime);
      return byStart !== 0 ? byStart : a.instrumentId.localeCompare(b.instrumentId);
    });
    for (const event of protectiveEvents) {
      const position = positions.get(event.instrumentId);
      if (!position || (position.stopLoss === null && position.takeProfit === null)) continue;
      const calendar = rawInput.executionCalendars[event.instrumentId]!;
      const window = executionWindowOf(event.bar, calendar);
      if (parseUtc(position.entryTime) > window.closeMs) continue;

      const protective = protectiveExitForLong(event.bar, position.stopLoss, position.takeProfit, intrabarPolicy);
      if (protective?.kind === 'ambiguous') {
        ambiguousBars++;
        continue;
      }
      if (!protective || protective.rawFillPrice === null) continue;

      const timing: FillTiming =
        protective.timing === 'OPEN_EXACT'
          ? { kind: 'OPEN_EXACT', executionAt: toUtcIso(window.openMs), barStart: event.bar.startTime, openSource: window.source }
          : {
              kind: 'INTRABAR_BOUNDED',
              earliestAt: toUtcIso(Math.max(window.openMs, parseUtc(position.entryTime))),
              latestAt: toUtcIso(window.closeMs),
              barStart: event.bar.startTime,
              barEnd: event.bar.endTime,
              basis: 'OHLC_RANGE_TOUCH',
            };
      closePosition(event.instrumentId, protective.rawFillPrice, protective.kind, timing);
    }

    // One aggregate portfolio mark per world batch, using only bars visible at this exact point in time.
    const snapshot = state.snapshot(batchAt);
    let marketValue = Decimal.ZERO;
    for (const position of positions.values()) {
      const mark = snapshot.get(position.instrumentId);
      if (!mark) throw new Error('PORTFOLIO_MARK_UNPROVEN: no point-in-time-known mark for ' + position.instrumentId);
      marketValue = marketValue.plus(position.quantity.times(mark.close));
    }
    const equity = cash.plus(marketValue);
    equityCurve.push({ at: batchAt, cash, marketValue, receivablesValue: Decimal.ZERO, equity });

    latestMarks = new Map([...snapshot.entries()].map(([instrumentId, latest]) => [instrumentId, latest.close]));

    // Strategy evaluation happens only after the entire batch is visible. One evaluation per instrument,
    // using the latest bar that became usable in this batch.
    const latestEventByInstrument = new Map<string, BarAvailabilityEvent>();
    for (const event of batch) {
      const previous = latestEventByInstrument.get(event.instrumentId);
      if (!previous || parseUtc(event.bar.startTime) > parseUtc(previous.bar.startTime)) latestEventByInstrument.set(event.instrumentId, event);
    }

    let evaluatedThisBatch = false;
    for (const instrumentId of [...latestEventByInstrument.keys()].sort()) {
      const event = latestEventByInstrument.get(instrumentId)!;
      const history = Object.freeze([...state.historyAt(instrumentId, batchAt)]);
      if (history.length < warmup.requiredBars) continue;
      evaluatedThisBatch = true;
      const decision = rawInput.strategy.evaluate({
        instrumentId,
        asOf: batchAt,
        currentBar: event.bar,
        history,
        position: positions.get(instrumentId) ?? null,
      });
      if (pending.has(instrumentId)) continue;
      const decidedAt = parseUtc(batchAt);
      if (decision.action === 'ENTER_LONG' && !positions.has(instrumentId)) {
        const order = decisionToPending(decision, decidedAt);
        if (order) pending.set(instrumentId, order);
      } else if (decision.action === 'EXIT_LONG' && positions.has(instrumentId)) {
        const order = decisionToPending(decision, decidedAt);
        if (order) pending.set(instrumentId, order);
      }
    }
    if (evaluatedThisBatch) {
      tradablePoints++;
      if (positions.size > 0) exposedPoints++;
    }
  }

  const endingEquity = equityCurve.at(-1)?.equity ?? cash;
  const metrics = backtestMetrics({
    startingCapital: rawInput.initialCapital,
    endingEquity,
    trades,
    equityCurve,
    totalFees,
    exposedPoints,
    tradablePoints,
  });

  const allBars = instrumentIds.flatMap((instrumentId) => normalized[instrumentId]!);
  const quality = assessBacktestQuality(
    { ...rawInput.quality, corporateActions: 'not_modeled' },
    trades.length,
    ambiguousBars,
    costModel.isZeroCost(),
    barKnowledgeAtUse(allBars, replay),
    [],
    null,
  );

  const strategyFingerprint = hashOf({
    id: rawInput.strategy.id,
    version: rawInput.strategy.version,
    definition: rawInput.strategy.definition,
  });
  const inputFingerprint = hashOf({
    engine: PORTFOLIO_BACKTEST_VERSION,
    strategyFingerprint,
    warmup,
    initialCapital: rawInput.initialCapital,
    portfolioCurrency: rawInput.portfolioCurrency,
    sizing: rawInput.sizing,
    riskSizingVersion: RISK_SIZING_VERSION,
    intrabarTimingVersion: INTRABAR_TIMING_VERSION,
    costModel: costModel.config,
    intrabarPolicy,
    qualityContext: rawInput.quality,
    replay,
    instruments: instrumentIds.map((instrumentId) => ({
      instrumentId,
      executionClock: executionClockIdentity(rawInput.executionCalendars[instrumentId]!),
      bars: normalized[instrumentId]!.map(barFingerprint),
    })),
  });

  return {
    portfolioRunId: 'pbt_' + inputFingerprint.slice(0, 40),
    engineVersion: PORTFOLIO_BACKTEST_VERSION,
    inputFingerprint,
    strategyId: rawInput.strategy.id,
    strategyVersion: rawInput.strategy.version,
    strategyDefinition: structuredClone(rawInput.strategy.definition),
    strategyFingerprint,
    instrumentIds,
    initialCapital: rawInput.initialCapital,
    portfolioCurrency: rawInput.portfolioCurrency,
    sizing: rawInput.sizing,
    costModel: costModel.config,
    intrabarPolicy,
    fills,
    trades,
    openPositions: [...positions.values()].sort((a, b) => a.instrumentId.localeCompare(b.instrumentId)),
    equityCurve,
    metrics,
    quality,
    ambiguousBars,
  };
}
