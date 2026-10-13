import type { MarketBar } from '../market-data/market-data-types.js';
import type { Decimal } from '../money/decimal.js';
import type { BacktestPosition } from './backtest-types.js';
import type { WarmupPlan } from './warmup.js';

export type StrategyDecision =
  | { action: 'NONE'; reasons: string[] }
  | { action: 'ENTER_LONG'; reasons: string[]; stopLoss?: Decimal; takeProfit?: Decimal }
  | { action: 'EXIT_LONG'; reasons: string[] };

export interface StrategyContext {
  instrumentId: string;
  asOf: string;
  currentBar: MarketBar;
  history: readonly MarketBar[];
  position: Readonly<BacktestPosition> | null;
}

export interface BacktestStrategy {
  readonly id: string;
  /** Must change whenever evaluate() semantics change. */
  readonly version: string;
  /** Canonical declarative parameters/config. Changing these changes the backtest fingerprint. */
  readonly definition: Readonly<Record<string, unknown>>;
  /**
   * Explicit history requirement. There is no default. evaluate() is not called before requiredBars bars are
   * available at the current event; warm-up bars never create a decision, an order or a fill.
   */
  readonly warmup: WarmupPlan;
  evaluate(context: StrategyContext): StrategyDecision;
}
