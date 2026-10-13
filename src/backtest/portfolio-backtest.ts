import type { MarketBar, BarReplayMode } from '../market-data/market-data-types.js';
import type { TradingCalendar } from '../market-data/sessions.js';
import type { Decimal } from '../money/decimal.js';
import type { BacktestStrategy } from './strategy.js';
import type {
  BacktestEquityPoint,
  BacktestFill,
  BacktestMetrics,
  BacktestPosition,
  BacktestQuality,
  BacktestQualityContext,
  BacktestTrade,
  PositionSizing,
} from './backtest-types.js';
import type { CostModelConfig } from './cost-model.js';
import type { IntrabarFillPolicy } from './execution-model.js';

export const PORTFOLIO_BACKTEST_VERSION = 'portfolio-backtest:v1';

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

/**
 * O7 RED surface. The implementation is intentionally absent in this commit so the behavior tests
 * fail for the feature, not because the public API is missing or TypeScript cannot compile it.
 */
export function runPortfolioBacktest(_input: PortfolioBacktestInput): PortfolioBacktestResult {
  throw new Error('O7 portfolio backtest not implemented');
}
