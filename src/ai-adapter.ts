import type { AiAnalysis } from './contracts.js';

export interface AnalysisPacket {
  symbol:string;
  timeframe:string;
  asOf:string;
  marketData:unknown;
  quant:unknown;
  news?:unknown[];
  fundamentals?:unknown;
}

export interface AiAnalyst {
  readonly provider:string;
  readonly model:string;
  analyze(packet:AnalysisPacket):Promise<AiAnalysis>;
}

export interface ModelRegistryEntry {
  provider:string;
  model:string;
  enabled:boolean;
  shadowMode:boolean;
  financeBenchmark?:number;
  latencyMs?:number;
  costScore?:number;
}
