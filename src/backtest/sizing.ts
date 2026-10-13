import { Decimal } from '../money/decimal.js';
import type { PositionSizing } from './backtest-types.js';

function basisPointsFraction(bp: number): Decimal {
  if (!Number.isInteger(bp) || bp < 0 || bp > 10_000) throw new Error('basis points must be an integer between 0 and 10000');
  return Decimal.from(bp).dividedBy(10_000, 12, 'half_even');
}

function minDecimal(a: Decimal, b: Decimal): Decimal {
  return a.lte(b) ? a : b;
}

export function desiredLongQuantity(input: {
  sizing: PositionSizing;
  cash: Decimal;
  equity: Decimal;
  executionPrice: Decimal;
  stopLoss: Decimal | null;
}): Decimal {
  if (!input.executionPrice.isPositive() || !input.cash.isPositive()) return Decimal.ZERO;

  switch (input.sizing.type) {
    case 'fixed_cash': {
      const budget = minDecimal(input.cash, Decimal.from(input.sizing.amount));
      if (!budget.isPositive()) return Decimal.ZERO;
      return budget.dividedBy(input.executionPrice, 12, 'down');
    }
    case 'percent_equity': {
      const budget = minDecimal(input.cash, input.equity.times(basisPointsFraction(input.sizing.basisPoints)));
      if (!budget.isPositive()) return Decimal.ZERO;
      return budget.dividedBy(input.executionPrice, 12, 'down');
    }
    case 'risk_per_trade': {
      if (!input.stopLoss || !input.stopLoss.lt(input.executionPrice)) return Decimal.ZERO;
      const perUnitRisk = input.executionPrice.minus(input.stopLoss);
      const riskBudget = input.equity.times(basisPointsFraction(input.sizing.riskBasisPoints));
      const riskQuantity = riskBudget.dividedBy(perUnitRisk, 12, 'down');
      const cashCap = minDecimal(input.cash, input.equity.times(basisPointsFraction(input.sizing.maxCashBasisPoints)));
      const cashQuantity = cashCap.dividedBy(input.executionPrice, 12, 'down');
      return minDecimal(riskQuantity, cashQuantity);
    }
  }
}
