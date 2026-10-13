// Commit-time seals for stored evidence (scanner, backtest and quant runs).
//
// A seal binds a stored run to two clock readings and proves nothing else:
//   recordedAt  read BEFORE the run's transaction commits. It is a LOWER bound on the commit time:
//               the commit happened at or after recordedAt. recordedAt > asOf therefore proves the
//               run was NOT available at asOf.
//   sealedAt    read AFTER the commit, in its own transaction. It is an UPPER bound on the commit time:
//               the commit happened at or before sealedAt. sealedAt <= asOf therefore proves the run
//               WAS available at asOf.
// Only the pair proves availability. recordedAt alone does not: a commit can still land after asOf.
//
// What a seal does NOT prove: that the market data it was computed from was available at that time
// (that is the availability of the inputs, checked separately), or that nobody with write access to the
// database rewrote the run and its seal together. Both limits are documented in docs/EVIDENCE_REFERENCE_VALIDATION.md.

import { parseUtc } from '../market-data/time.js';
import { hashOf } from './canonical-json.js';

export const EVIDENCE_SEAL_KINDS = ['scanner_run', 'backtest_run', 'quant_run'] as const;
export type EvidenceSealKind = (typeof EVIDENCE_SEAL_KINDS)[number];

export interface EvidenceSeal {
  kind: EvidenceSealKind;
  /** scannerRunId, backtestRunId or quantRunId. */
  recordId: string;
  /** Result hash of the sealed run at the time of sealing. */
  resultHash: string;
  /** ISO UTC with milliseconds. Read before COMMIT (lower bound). */
  recordedAt: string;
  /** ISO UTC with milliseconds. Read after COMMIT (upper bound). */
  sealedAt: string;
  sealHash: string;
}

/** A stored run together with its seal. The seal is null for runs stored before sealing existed. */
export interface Sealed<T> {
  record: T;
  seal: EvidenceSeal | null;
}

export class EvidenceSealIntegrityError extends Error {
  override readonly name = 'EvidenceSealIntegrityError';
}

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function sealHashOf(seal: Omit<EvidenceSeal, 'sealHash'>): string {
  return hashOf({ kind: seal.kind, recordId: seal.recordId, resultHash: seal.resultHash, recordedAt: seal.recordedAt, sealedAt: seal.sealedAt });
}

/** Builds a seal. Timestamps must be canonical (ms precision), so a value read back from the database is identical. */
export function sealFor(input: Omit<EvidenceSeal, 'sealHash'>): EvidenceSeal {
  for (const at of [input.recordedAt, input.sealedAt]) {
    if (!ISO_UTC_MS.test(at)) throw new EvidenceSealIntegrityError('seal timestamp must be ISO UTC with milliseconds: ' + at);
  }
  if (parseUtc(input.recordedAt) > parseUtc(input.sealedAt)) throw new EvidenceSealIntegrityError('seal recordedAt is after sealedAt');
  return { ...input, sealHash: sealHashOf(input) };
}

/** Checks a stored seal against the run it claims to belong to. Any change to a sealed field fails here. */
export function verifySeal(seal: EvidenceSeal, expected: { kind: EvidenceSealKind; recordId: string; resultHash: string }): EvidenceSeal {
  if (seal.kind !== expected.kind || seal.recordId !== expected.recordId) throw new EvidenceSealIntegrityError('seal belongs to another record');
  if (seal.resultHash !== expected.resultHash) throw new EvidenceSealIntegrityError('seal does not match the stored result (run was altered after sealing)');
  if (sealHashOf(seal) !== seal.sealHash) throw new EvidenceSealIntegrityError('seal hash mismatch: the stored recordedAt or sealedAt was altered');
  return seal;
}

/** ISO UTC with milliseconds, as the stores write and read it. */
export function isoMs(date: Date): string {
  return date.toISOString();
}
