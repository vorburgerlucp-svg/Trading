import { Decimal } from '../money/decimal.js';
import type { BacktestEquityPoint, BacktestMetrics, BacktestTrade } from './backtest-types.js';

function average(values: readonly Decimal[]): Decimal | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum.plus(value), Decimal.ZERO);
  return total.dividedBy(values.length, 12, 'half_even');
}

export function backtestMetrics(input: {
  startingCapital: Decimal;
  endingEquity: Decimal;
  trades: readonly BacktestTrade[];
  equityCurve: readonly BacktestEquityPoint[];
  totalFees: Decimal;
  exposedPoints: number;
}): BacktestMetrics {
  const pnl = input.endingEquity.minus(input.startingCapital);
  const returnPct = input.startingCapital.isZero() ? 0 : pnl.dividedBy(input.startingCapital, 12, 'half_even').times(100).toNumber();
  const winners = input.trades.filter((t) => t.pnl.isPositive());
  const losers = input.trades.filter((t) => t.pnl.isNegative());
  const grossProfit = winners.reduce((sum, t) => sum.plus(t.pnl), Decimal.ZERO);
  const grossLossAbs = losers.reduce((sum, t) => sum.plus(t.pnl.abs()), Decimal.ZERO);

  let peak: Decimal | null = null;
  let maxDrawdownPct = 0;
  for (const point of input.equityCurve) {
    if (!peak || point.equity.gt(peak)) peak = point.equity;
    if (peak && peak.isPositive()) {
      const drawdown = peak.minus(point.equity).dividedBy(peak, 12, 'half_even').times(100).toNumber();
      if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
    }
  }

  return {
    startingCapital: input.startingCapital,
    endingEquity: input.endingEquity,
    absoluteReturn: pnl,
    returnPct,
    maxDrawdownPct,
    numberOfTrades: input.trades.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    winRate: input.trades.length === 0 ? null : winners.length / input.trades.length,
    averageWinner: average(winners.map((t) => t.pnl)),
    averageLoser: average(losers.map((t) => t.pnl)),
    profitFactor: grossLossAbs.isZero() ? null : grossProfit.dividedBy(grossLossAbs, 12, 'half_even').toNumber(),
    expectancy: average(input.trades.map((t) => t.pnl)),
    totalFees: input.totalFees,
    exposurePct: input.equityCurve.length === 0 ? 0 : (input.exposedPoints / input.equityCurve.length) * 100,
  };
}
