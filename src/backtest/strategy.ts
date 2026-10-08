import type { MarketBar } from '../market-data/market-data-types.js';
import type { Decimal } from '../money/decimal.js';
import type { BacktestPosition } from './backtest-types.js';

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
  evaluate(context: StrategyContext): StrategyDecision;
}
