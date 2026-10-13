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

// v0.1 registry entry superseded by the measured ModelRegistry (src/ai/model-registry.ts).
export type { ModelRegistryEntry, ModelCapabilityScore } from './ai/model-registry.js';
// General specialist port used by the NEXUS Brain (AiAnalyst remains the v0.1 trading-only interface).
export type { ModelAdapter, SpecialistRequest } from './ai/model-adapter.js';
