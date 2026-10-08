import type { MarketBar } from '../market-data/market-data-types.js';
import type { Decimal } from '../money/decimal.js';
import type { CostModelConfig } from './cost-model.js';
import type { IntrabarFillPolicy } from './execution-model.js';

export type PositionSizing =
  | { type: 'fixed_cash'; amount: string }
  | { type: 'percent_equity'; basisPoints: number }
  | { type: 'risk_per_trade'; riskBasisPoints: number; maxCashBasisPoints: number };

export interface BacktestPosition {
  instrumentId: string;
  quantity: Decimal;
  entryPrice: Decimal;
  entryTime: string;
  entryCommission: Decimal;
  stopLoss: Decimal | null;
  takeProfit: Decimal | null;
}

export interface BacktestFill {
  fillId: string;
  instrumentId: string;
  side: 'buy' | 'sell';
  reason: 'market_entry' | 'strategy_exit' | 'stop' | 'take_profit';
  at: string;
  rawPrice: Decimal;
  executionPrice: Decimal;
  quantity: Decimal;
  commission: Decimal;
}

export interface BacktestTrade {
  tradeId: string;
  instrumentId: string;
  entry: BacktestFill;
  exit: BacktestFill;
  pnl: Decimal;
  returnPct: number;
}

export interface BacktestEquityPoint {
  at: string;
  cash: Decimal;
  marketValue: Decimal;
  equity: Decimal;
}

export interface BacktestMetrics {
  startingCapital: Decimal;
  endingEquity: Decimal;
  absoluteReturn: Decimal;
  returnPct: number;
  maxDrawdownPct: number;
  numberOfTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number | null;
  averageWinner: Decimal | null;
  averageLoser: Decimal | null;
  profitFactor: number | null;
  expectancy: Decimal | null;
  totalFees: Decimal;
  exposurePct: number;
}

export interface BacktestQuality {
  grade: 'A' | 'B' | 'C' | 'INVALID';
  reasons: string[];
  insufficientSample: boolean;
}

export interface BacktestRunResult {
  backtestRunId: string;
  engineVersion: string;
  instrumentId: string;
  strategyId: string;
  strategyVersion: string;
  strategyDefinition: Readonly<Record<string, unknown>>;
  strategyFingerprint: string;
  inputFingerprint: string;
  initialCapital: Decimal;
  costModel: Readonly<CostModelConfig>;
  sizing: PositionSizing;
  intrabarPolicy: IntrabarFillPolicy;
  barsProcessed: number;
  fills: BacktestFill[];
  trades: BacktestTrade[];
  equityCurve: BacktestEquityPoint[];
  openPosition: BacktestPosition | null;
  metrics: BacktestMetrics;
  quality: BacktestQuality;
  ambiguousBars: number;
}

export interface BacktestQualityContext {
  pointInTimeUniverse: boolean;
  dataComplete: boolean;
  corporateActions: 'modeled' | 'not_modeled';
  providerProduction: boolean;
  minimumTrades: number;
}

export interface BacktestInput {
  bars: readonly MarketBar[];
  initialCapital: Decimal;
  sizing: PositionSizing;
  costModel: CostModelConfig;
  intrabarPolicy?: IntrabarFillPolicy;
  quality: BacktestQualityContext;
}
