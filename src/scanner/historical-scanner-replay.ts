import type { BarReplayMode, BarInterval, BarSession, PriceAdjustment } from '../market-data/market-data-types.js';
import type { QuantParameters, QuantRunRecord } from '../quant/quant-types.js';
import type { QuantRunRequest } from '../quant/quant-service.js';
import type { ScannerDefinition, ScannerRun, ScannerSnapshot } from './scanner-types.js';
import type { UniverseSelection } from '../universe/universe-model.js';
import type { UniverseSelectionQuery } from '../universe/universe-store.js';

export const HISTORICAL_SCANNER_REPLAY_VERSION = 'historical-scanner-replay:v1' as const;
export const SCANNER_SNAPSHOT_POLICY_VERSION = 'scanner-snapshot:v1' as const;

export interface HistoricalScannerReplaySeries {
  source: string;
  interval: BarInterval;
  session: BarSession;
  adjustment: PriceAdjustment;
}

export interface HistoricalScannerReplayRequest {
  definition: ScannerDefinition;
  asOf: readonly string[];
  universeId: string;
  universeSourceId: string;
  universeStoredThrough: number;
  marketStoredThroughByInstrument: Readonly<Record<string, number>>;
  series: HistoricalScannerReplaySeries;
  replay: BarReplayMode;
  quantParameters?: Partial<QuantParameters>;
}

export interface HistoricalScannerReplayQuantRef {
  instrumentId: string;
  quantRunId: string;
  storedThrough: number;
}

export interface HistoricalScannerReplayStep {
  asOf: string;
  scannerRunId: string;
  scannerInputFingerprint: string;
  universeFingerprint: string;
  universeSnapshotRevisionId: string | null;
  quantRunIds: HistoricalScannerReplayQuantRef[];
  candidateInstrumentIds: string[];
  rankingComplete: boolean;
}

export interface HistoricalScannerReplayResult {
  replayRunId: string;
  engineVersion: typeof HISTORICAL_SCANNER_REPLAY_VERSION;
  inputFingerprint: string;
  replay: BarReplayMode;
  definitionId: string;
  definitionVersion: string;
  universeId: string;
  universeSourceId: string;
  universeStoredThrough: number;
  marketStoredThroughByInstrument: Readonly<Record<string, number>>;
  asOf: string[];
  steps: HistoricalScannerReplayStep[];
}

export interface HistoricalScannerUniversePort {
  select(query: UniverseSelectionQuery): UniverseSelection | Promise<UniverseSelection>;
}

export interface HistoricalScannerQuantPort {
  run(request: QuantRunRequest): Promise<{ record: QuantRunRecord; status: 'APPLIED' | 'ALREADY_APPLIED' }>;
}

export interface HistoricalScannerSnapshotPort {
  build(input: {
    instrumentId: string;
    asOf: string;
    storedThrough: number;
    replay: BarReplayMode;
    series: HistoricalScannerReplaySeries;
    quant: QuantRunRecord;
  }): Promise<ScannerSnapshot | null>;
}

export interface HistoricalScannerRunPort {
  save(run: ScannerRun): Promise<'APPLIED' | 'ALREADY_APPLIED'>;
}

export interface HistoricalScannerReplayDependencies {
  universe: HistoricalScannerUniversePort;
  quant: HistoricalScannerQuantPort;
  snapshots: HistoricalScannerSnapshotPort;
  scannerRuns: HistoricalScannerRunPort;
}

export class HistoricalScannerReplayError extends Error {
  override readonly name = 'HistoricalScannerReplayError';
  constructor(
    readonly code:
      | 'INVALID_REPLAY_SCHEDULE'
      | 'UNIVERSE_ANCHOR_REQUIRED'
      | 'MARKET_ANCHOR_REQUIRED'
      | 'ANCHOR_MISMATCH',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

/** O9 RED API surface. Behavior is implemented after RED tests prove the contract. */
export async function runHistoricalScannerReplay(
  _request: HistoricalScannerReplayRequest,
  _deps: HistoricalScannerReplayDependencies,
): Promise<HistoricalScannerReplayResult> {
  throw new Error('O9 historical scanner replay not implemented');
}
