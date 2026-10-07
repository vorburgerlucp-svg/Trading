export type AssetClass = 'stock'|'etf'|'crypto'|'forex'|'commodity'|'future'|'index';
export type Horizon = 'intraday'|'swing'|'position'|'investment';
export type Direction = 'long'|'short'|'neutral';
export type Decision = 'buy'|'sell'|'watch'|'no_trade';
export type TradingMode = 'backtest'|'paper'|'live';

export interface TradePlan {
  symbol:string;
  assetClass:AssetClass;
  horizon:Horizon;
  decision:Decision;
  direction:Direction;
  entry:{min:number;max:number};
  stopLoss:number;
  takeProfits:number[];
  riskReward:number;
  confidence:number;
  maxPositionChf:number;
  rationale:string[];
  invalidation:string;
}

export interface RiskDecision { approved:boolean; reasons:string[]; cappedPositionChf:number; }
export interface OrderIntent { symbol:string; side:'buy'|'sell'; amountChf:number; orderType:'market'|'limit'; limitPrice?:number; stopLoss?:number; takeProfit?:number; clientOrderId:string; }
export interface BrokerOrderResult { broker:string; mode:TradingMode; accepted:boolean; externalOrderId?:string; message:string; }

export interface AiAnalysis {
  provider:string;
  model:string;
  direction:Direction;
  confidence:number;
  thesis:string;
  risks:string[];
  catalysts:string[];
  invalidation:string;
}
