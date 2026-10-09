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
  /**
   * live_trading (default): every input must be trading-usable, which requires proven bar revisions. research: valid data is enough;
   * historical reconstructions may be scanned, and every candidate says whether its bars were strict point in time.
   */
  useCase?: 'live_trading' | 'research';
}

export interface ScannerSnapshot {
  instrumentId: string;
  asOf: string;
  lastPrice: Decimal;
  lastPriceAvailableAt: string;
  averageVolume?: Decimal;
  averageVolumeAvailableAt?: string;
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
  /** Whether every bar behind the candidate's quant run was a proven revision held by asOf. */
  strictPointInTime: boolean;
}

export interface ScannerCoverage {
  universeMembers: number;
  snapshotsProvided: number;
  evaluatedInstruments: number;
  missingInstruments: string[];
  duplicateInstruments: string[];
  complete: boolean;
}

export interface ScannerRun {
  scannerRunId: string;
  inputFingerprint: string;
  definition: ScannerDefinition;
  definitionId: string;
  definitionVersion: string;
  universeId: string;
  universeFingerprint: string;
  universePointInTimeSafe: boolean;
  asOf: string;
  coverage: ScannerCoverage;
  rankingComplete: boolean;
  candidates: ScannerCandidate[];
  rejected: Array<{ instrumentId: string; reasons: string[] }>;
  /**
   * Latest availability time of any in-universe snapshot input (last price or average volume). null when there
   * were no inputs. Absent in runs stored before market-scanner:v2: such a run's input time is not provable.
   */
  inputsAvailableAt?: string | null;
}
