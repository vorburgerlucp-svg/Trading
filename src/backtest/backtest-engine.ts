// Single-instrument deterministic Backtest Engine V1 core.
//
// Event convention per final bar becoming available:
//   1. process a market order created from an earlier bar at this bar's OPEN
//   2. process protective stop/take-profit over this bar
//   3. mark the portfolio at this bar's CLOSE, now that the bar is available
//   4. evaluate the strategy using only bars with availableAt <= this event time
//   5. create (but never fill) new market orders for a later bar
//
// This intentionally forbids same-bar execution from final-close decisions.

import type { MarketBar } from '../market-data/market-data-types.js';
import { parseUtc } from '../market-data/time.js';
import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import { DeterministicCostModel } from './cost-model.js';
import { isEligibleNextBar, protectiveExitForLong } from './execution-model.js';
import { backtestMetrics } from './performance.js';
import { PointInTimeBarState, buildBarAvailabilityQueue } from './point-in-time.js';
import { assessBacktestQuality } from './quality.js';
import { desiredLongQuantity } from './sizing.js';
import type { BacktestFill, BacktestInput, BacktestPosition, BacktestRunResult, BacktestTrade } from './backtest-types.js';
import type { BacktestStrategy, StrategyDecision } from './strategy.js';

export const BACKTEST_ENGINE_VERSION = 'backtest-engine:v1';

interface PendingOrder {
  side: 'buy' | 'sell';
  decisionBar: MarketBar;
  stopLoss: Decimal | null;
  takeProfit: Decimal | null;
}

function minDecimal(a: Decimal, b: Decimal): Decimal {
  return a.lte(b) ? a : b;
}

function barFingerprint(bar: MarketBar): unknown[] {
  return [bar.instrumentId, bar.startTime, bar.endTime, bar.open, bar.high, bar.low, bar.close, bar.volume ?? null, bar.availableAt, bar.isFinal, bar.source, bar.adjustment];
}

function decisionToPending(decision: StrategyDecision, currentBar: MarketBar): PendingOrder | null {
  if (decision.action === 'ENTER_LONG') {
    return { side: 'buy', decisionBar: currentBar, stopLoss: decision.stopLoss ?? null, takeProfit: decision.takeProfit ?? null };
  }
  if (decision.action === 'EXIT_LONG') {
    return { side: 'sell', decisionBar: currentBar, stopLoss: null, takeProfit: null };
  }
  return null;
}

function assertChronologicalAvailability(bars: readonly MarketBar[]): void {
  const ordered = [...bars].sort((a, b) => parseUtc(a.startTime) - parseUtc(b.startTime));
  let previousAvailable = Number.NEGATIVE_INFINITY;
  for (const bar of ordered) {
    const available = parseUtc(bar.availableAt);
    if (available < previousAvailable) {
      throw new Error('V1 backtest does not support per-instrument availability inversion; an older bar arrived after a newer bar');
    }
    previousAvailable = available;
  }
}

export function runBacktest(input: BacktestInput & { strategy: BacktestStrategy }): BacktestRunResult {
  if (!input.initialCapital.isPositive()) throw new Error('initial capital must be positive');
  if (input.bars.length === 0) throw new Error('backtest requires bars');
  const instrumentId = input.bars[0]!.instrumentId;
  if (input.bars.some((b) => b.instrumentId !== instrumentId)) throw new Error('V1 backtest is single-instrument');
  if (input.bars.some((b) => !b.isFinal)) throw new Error('backtest accepts final bars only');
  if (input.quality.corporateActions === 'modeled') {
    throw new Error('Backtest Engine V1 cannot claim corporate actions are modeled; open-position split/dividend handling is not implemented yet');
  }
  const first = input.bars[0]!;
  const starts = new Set<string>();
  for (const bar of input.bars) {
    if (bar.interval !== first.interval || bar.session !== first.session || bar.adjustment !== first.adjustment || bar.source !== first.source) {
      throw new Error('backtest bars must be one uniform interval/session/adjustment/source series');
    }
    if (starts.has(bar.startTime)) throw new Error('backtest bars contain a duplicate startTime');
    starts.add(bar.startTime);
  }
  assertChronologicalAvailability(input.bars);

  const events = buildBarAvailabilityQueue({ [instrumentId]: input.bars });
  const state = new PointInTimeBarState();
  const costModel = new DeterministicCostModel(input.costModel);
  const intrabarPolicy = input.intrabarPolicy ?? 'conservative';
  let cash = input.initialCapital;
  let position: BacktestPosition | null = null;
  let pending: PendingOrder | null = null;
  let totalFees = Decimal.ZERO;
  let ambiguousBars = 0;
  let exposedPoints = 0;
  let fillSequence = 0;
  let tradeSequence = 0;
  const fills: BacktestFill[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: BacktestRunResult['equityCurve'] = [];

  const addFill = (fill: Omit<BacktestFill, 'fillId'>): BacktestFill => {
    const complete: BacktestFill = { ...fill, fillId: 'fill_' + String(++fillSequence).padStart(6, '0') };
    fills.push(complete);
    totalFees = totalFees.plus(complete.commission);
    return complete;
  };

  const closePosition = (bar: MarketBar, rawPrice: Decimal, reason: BacktestFill['reason']): void => {
    if (!position) return;
    const openPosition = position;
    const quote = costModel.quote(rawPrice, 'sell', openPosition.quantity);
    const exitFill = addFill({ instrumentId, side: 'sell', reason, at: bar.startTime, rawPrice, executionPrice: quote.executionPrice, quantity: openPosition.quantity, commission: quote.commission });
    const exitNet = quote.executionPrice.times(openPosition.quantity).minus(quote.commission);
    const entryCost = openPosition.entryPrice.times(openPosition.quantity).plus(openPosition.entryCommission);
    const pnl = exitNet.minus(entryCost);
    const returnPct = entryCost.isZero() ? 0 : pnl.dividedBy(entryCost, 12, 'half_even').times(100).toNumber();
    const entryFill = fills.find((f) => f.side === 'buy' && f.at === openPosition.entryTime && f.quantity.eq(openPosition.quantity));
    if (!entryFill) throw new Error('entry fill missing for open position');
    trades.push({ tradeId: 'trade_' + String(++tradeSequence).padStart(6, '0'), instrumentId, entry: entryFill, exit: exitFill, pnl, returnPct });
    cash = cash.plus(exitNet);
    position = null;
  };

  for (const event of events) {
    const bar = event.bar;
    state.advance(event);

    if (pending && isEligibleNextBar(pending.decisionBar, bar)) {
      if (pending.side === 'buy' && !position) {
        const estimatedExecution = costModel.executionPrice(bar.open, 'buy');
        const desired = desiredLongQuantity({ sizing: input.sizing, cash, equity: cash, executionPrice: estimatedExecution, stopLoss: pending.stopLoss });
        const affordable = costModel.maxAffordableQuantity(cash, bar.open);
        const quantity = minDecimal(desired, affordable);
        if (quantity.isPositive()) {
          const quote = costModel.quote(bar.open, 'buy', quantity);
          const total = quote.executionPrice.times(quantity).plus(quote.commission);
          if (total.lte(cash)) {
            const fill = addFill({ instrumentId, side: 'buy', reason: 'market_entry', at: bar.startTime, rawPrice: bar.open, executionPrice: quote.executionPrice, quantity, commission: quote.commission });
            cash = cash.minus(total);
            position = { instrumentId, quantity, entryPrice: quote.executionPrice, entryTime: fill.at, entryCommission: quote.commission, stopLoss: pending.stopLoss, takeProfit: pending.takeProfit };
          }
        }
      } else if (pending.side === 'sell' && position) {
        closePosition(bar, bar.open, 'strategy_exit');
      }
      pending = null;
    }

    if (position && (position.stopLoss !== null || position.takeProfit !== null)) {
      const protective = protectiveExitForLong(bar, position.stopLoss, position.takeProfit, intrabarPolicy);
      if (protective?.kind === 'ambiguous') ambiguousBars++;
      else if (protective?.rawFillPrice) closePosition(bar, protective.rawFillPrice, protective.kind);
    }

    const marketValue = position ? position.quantity.times(bar.close) : Decimal.ZERO;
    const equity = cash.plus(marketValue);
    if (position) exposedPoints++;
    equityCurve.push({ at: event.availableAt, cash, marketValue, equity });

    const history = state.historyAt(instrumentId, event.availableAt);
    const decision = input.strategy.evaluate({ instrumentId, asOf: event.availableAt, currentBar: bar, history, position });
    if (!pending) {
      if (decision.action === 'ENTER_LONG' && !position) pending = decisionToPending(decision, bar);
      else if (decision.action === 'EXIT_LONG' && position) pending = decisionToPending(decision, bar);
    }
  }

  const endingEquity = equityCurve.at(-1)?.equity ?? cash;
  const metrics = backtestMetrics({ startingCapital: input.initialCapital, endingEquity, trades, equityCurve, totalFees, exposedPoints });
  const quality = assessBacktestQuality(input.quality, trades.length, ambiguousBars, costModel.isZeroCost());
  const strategyFingerprint = hashOf({ id: input.strategy.id, version: input.strategy.version, definition: input.strategy.definition });
  const inputFingerprint = hashOf({
    engine: BACKTEST_ENGINE_VERSION,
    strategyFingerprint,
    initialCapital: input.initialCapital,
    sizing: input.sizing,
    costModel: costModel.config,
    intrabarPolicy,
    qualityContext: input.quality,
    bars: input.bars.map(barFingerprint),
  });

  return {
    backtestRunId: 'bt_' + inputFingerprint.slice(0, 40),
    engineVersion: BACKTEST_ENGINE_VERSION,
    instrumentId,
    strategyId: input.strategy.id,
    strategyVersion: input.strategy.version,
    strategyFingerprint,
    inputFingerprint,
    initialCapital: input.initialCapital,
    costModel: costModel.config,
    sizing: input.sizing,
    intrabarPolicy,
    barsProcessed: events.length,
    fills,
    trades,
    equityCurve,
    openPosition: position,
    metrics,
    quality,
    ambiguousBars,
  };
}
