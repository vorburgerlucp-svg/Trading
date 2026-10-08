import { hashOf } from '../persistence/canonical-json.js';
import type { ScannerRun } from './scanner-types.js';

export class ScannerRunConflictError extends Error {
  override readonly name = 'ScannerRunConflictError';
}
export class ScannerRunIntegrityError extends Error {
  override readonly name = 'ScannerRunIntegrityError';
}

export function verifyScannerRun(run: ScannerRun): ScannerRun {
  if (!/^[0-9a-f]{64}$/.test(run.inputFingerprint)) throw new ScannerRunIntegrityError('invalid scanner input fingerprint');
  if (run.scannerRunId !== 'scan_' + run.inputFingerprint.slice(0, 40)) throw new ScannerRunIntegrityError('scannerRunId does not match input fingerprint');
  if (run.definition.id !== run.definitionId || run.definition.version !== run.definitionVersion || run.definition.universeId !== run.universeId) {
    throw new ScannerRunIntegrityError('scanner definition metadata mismatch');
  }
  const ranks = new Set<number>();
  const instruments = new Set<string>();
  for (const candidate of run.candidates) {
    if (!Number.isFinite(candidate.rankingScore)) throw new ScannerRunIntegrityError('candidate ranking score is not finite');
    if (candidate.scannerRunId !== run.scannerRunId) throw new ScannerRunIntegrityError('candidate belongs to another scanner run');
    if (candidate.asOf !== run.asOf) throw new ScannerRunIntegrityError('candidate asOf differs from scanner run');
    if (!Number.isInteger(candidate.rank) || candidate.rank < 1 || ranks.has(candidate.rank)) throw new ScannerRunIntegrityError('invalid or duplicate candidate rank');
    if (instruments.has(candidate.instrumentId)) throw new ScannerRunIntegrityError('duplicate scanner candidate instrument');
    ranks.add(candidate.rank);
    instruments.add(candidate.instrumentId);
  }
  return run;
}

export interface ScannerRunStore {
  save(run: ScannerRun): Promise<'APPLIED' | 'ALREADY_APPLIED'>;
  get(scannerRunId: string): Promise<ScannerRun | null>;
}

export class InMemoryScannerRunStore implements ScannerRunStore {
  private readonly runs = new Map<string, { run: ScannerRun; hash: string }>();

  async save(run: ScannerRun): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
    verifyScannerRun(run);
    const hash = hashOf(run);
    const existing = this.runs.get(run.scannerRunId);
    if (existing) {
      if (existing.hash !== hash) throw new ScannerRunConflictError('scanner run already exists with different content');
      return 'ALREADY_APPLIED';
    }
    this.runs.set(run.scannerRunId, { run, hash });
    return 'APPLIED';
  }

  async get(scannerRunId: string): Promise<ScannerRun | null> {
    const stored = this.runs.get(scannerRunId);
    if (!stored) return null;
    if (hashOf(stored.run) !== stored.hash) throw new ScannerRunIntegrityError('stored scanner run hash mismatch');
    return verifyScannerRun(stored.run);
  }
}
