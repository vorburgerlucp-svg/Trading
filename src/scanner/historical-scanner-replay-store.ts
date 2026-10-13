// O9 replay persistence and integrity (RED stub). The verifier and the in-memory store are implemented in the next commit.

import type { EvidenceSeal, Sealed } from '../persistence/evidence-seal.js';
import type { HistoricalScannerReplayResult } from './historical-scanner-replay.js';

export class HistoricalScannerReplayConflictError extends Error {
  override readonly name = 'HistoricalScannerReplayConflictError';
}

export class HistoricalScannerReplayIntegrityError extends Error {
  override readonly name = 'HistoricalScannerReplayIntegrityError';
}

export interface HistoricalScannerReplayStore {
  save(result: HistoricalScannerReplayResult): Promise<'APPLIED' | 'ALREADY_APPLIED'>;
  get(replayRunId: string): Promise<HistoricalScannerReplayResult | null>;
  getSealed(replayRunId: string): Promise<Sealed<HistoricalScannerReplayResult> | null>;
}

/** One stored row of the in-memory table: the lossless JSON payload, its hash and its seal. */
export interface HistoricalScannerReplayRow {
  payload: string;
  resultHash: string;
  seal: EvidenceSeal;
}

export function verifyHistoricalScannerReplayResult(_result: HistoricalScannerReplayResult): HistoricalScannerReplayResult {
  throw new Error('not implemented');
}

export class InMemoryHistoricalScannerReplayStore implements HistoricalScannerReplayStore {
  constructor(_options: { clock?: () => Date; rows?: Map<string, HistoricalScannerReplayRow> } = {}) {}

  async save(_result: HistoricalScannerReplayResult): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    throw new Error('not implemented');
  }

  async get(_replayRunId: string): Promise<HistoricalScannerReplayResult | null> {
    throw new Error('not implemented');
  }

  async getSealed(_replayRunId: string): Promise<Sealed<HistoricalScannerReplayResult> | null> {
    throw new Error('not implemented');
  }
}
