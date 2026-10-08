import { Decimal } from '../money/decimal.js';

export interface CostModelConfig {
  commissionBps: number;
  spreadBps: number;
  slippageBps: number;
  minCommission: string;
}

export interface ExecutionCosts {
  rawPrice: Decimal;
  executionPrice: Decimal;
  commission: Decimal;
  spreadBps: number;
  slippageBps: number;
}

function assertBps(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 100_000) throw new Error(name + ' must be a non-negative integer basis-point value');
}

function bpFraction(bps: number): Decimal {
  return Decimal.from(bps).dividedBy(10_000, 12, 'half_even');
}

function minDecimal(a: Decimal, b: Decimal): Decimal {
  return a.lte(b) ? a : b;
}

export class DeterministicCostModel {
  readonly config: Readonly<CostModelConfig>;

  constructor(config: CostModelConfig) {
    assertBps(config.commissionBps, 'commissionBps');
    assertBps(config.spreadBps, 'spreadBps');
    assertBps(config.slippageBps, 'slippageBps');
    const minCommission = Decimal.from(config.minCommission);
    if (minCommission.isNegative()) throw new Error('minCommission must not be negative');
    this.config = Object.freeze({ ...config });
  }

  executionPrice(rawPrice: Decimal, side: 'buy' | 'sell'): Decimal {
    if (!rawPrice.isPositive()) throw new Error('execution price must be positive');
    const halfSpread = bpFraction(this.config.spreadBps).dividedBy(2, 12, 'half_even');
    const slippage = bpFraction(this.config.slippageBps);
    const impact = halfSpread.plus(slippage);
    return side === 'buy' ? rawPrice.times(Decimal.ONE.plus(impact)) : rawPrice.times(Decimal.ONE.minus(impact));
  }

  commission(notional: Decimal): Decimal {
    if (notional.isNegative()) throw new Error('notional must not be negative');
    const proportional = notional.times(bpFraction(this.config.commissionBps));
    const minimum = Decimal.from(this.config.minCommission);
    return proportional.gte(minimum) ? proportional : minimum;
  }

  quote(rawPrice: Decimal, side: 'buy' | 'sell', quantity: Decimal): ExecutionCosts {
    if (quantity.isNegative()) throw new Error('quantity must not be negative');
    const executionPrice = this.executionPrice(rawPrice, side);
    return {
      rawPrice,
      executionPrice,
      commission: this.commission(executionPrice.times(quantity)),
      spreadBps: this.config.spreadBps,
      slippageBps: this.config.slippageBps,
    };
  }

  /**
   * Conservative affordability cap for buys. It satisfies both the proportional-commission and
   * minimum-commission cases, so quote(price, 'buy', result) can never intentionally overspend cash.
   */
  maxAffordableQuantity(cash: Decimal, rawPrice: Decimal, scale = 12): Decimal {
    if (!cash.isPositive()) return Decimal.ZERO;
    const price = this.executionPrice(rawPrice, 'buy');
    const minimum = Decimal.from(this.config.minCommission);
    if (cash.lte(minimum)) return Decimal.ZERO;
    const byMinimum = cash.minus(minimum).dividedBy(price, scale, 'down');
    const proportionalFactor = Decimal.ONE.plus(bpFraction(this.config.commissionBps));
    const byProportional = cash.dividedBy(price.times(proportionalFactor), scale, 'down');
    return minDecimal(byMinimum, byProportional);
  }

  isZeroCost(): boolean {
    return this.config.commissionBps === 0 && this.config.spreadBps === 0 && this.config.slippageBps === 0 && Decimal.from(this.config.minCommission).isZero();
  }
}

export const ZERO_COST_MODEL = new DeterministicCostModel({ commissionBps: 0, spreadBps: 0, slippageBps: 0, minCommission: '0' });
