import type { Decimal } from '../money/decimal.js';
import type { QuantResult } from '../quant/quant-types.js';

export type ScannerFilter =
  | { type: 'minimum_price'; value: string }
  | { type: 'minimum_average_volume'; value: string }
  | { type: 'rsi_range'; min: number; max: number }
  | { type: 'price_above_ema'; period: number }
  | { type: 'ema_alignment'; fast: number; slow: number }
  | { type: 'adx_minimum'; value: number }
  | { type: 'atr_percent_range'; min?: number; max?: number }
  | { type: 'market_structure'; allowed: Array<'bullish' | 'bearish' | 'range' | 'unknown'> };

export type ScannerRankingRule =
  | { type: 'adx'; weight: number }
  | { type: 'rsi_momentum'; weight: number }
  | { type: 'atr_percent'; weight: number };

export interface ScannerDefinition {
  id: string;
  version: string;
  universeId: string;
  interval: string;
  filters: ScannerFilter[];
  ranking: ScannerRankingRule[];
  maxCandidates: number;
}

export interface ScannerSnapshot {
  instrumentId: string;
  asOf: string;
  lastPrice: Decimal;
  averageVolume?: Decimal;
  quant: QuantResult;
}

export interface ScannerCandidate {
  scannerRunId: string;
  instrumentId: string;
  asOf: string;
  quantRunId: string;
  passedFilters: string[];
  failedFilters: string[];
  rankingScore: number;
  rank: number;
  dataQualityStatus: string;
}

export interface ScannerRun {
  scannerRunId: string;
  definitionId: string;
  definitionVersion: string;
  universeId: string;
  universeFingerprint: string;
  asOf: string;
  candidates: ScannerCandidate[];
  rejected: Array<{ instrumentId: string; reasons: string[] }>;
}
