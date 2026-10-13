// NEXUS's knowledge timing for financial evidence (financial-knowledge-seal:v1, docs/FINANCIAL_EVIDENCE_PERSISTENCE_V1.md §5–§6, §9, §11). The seal follows the
// same commit-bracket semantics as migrations 006 and 011, with its own table and version. A COMMIT_SEAL brackets the commit: recordedAt is a lower bound,
// sealedAt an upper bound. A PRESENCE_ATTESTATION proves existence by sealedAt and never claims an earlier time, so only a COMMIT_SEAL can prove absence.

import { parseUtc } from '../market-data/time.js';
import { hashOf } from '../persistence/canonical-json.js';
import { FinancialEvidenceIntegrityError, type FinancialEvidence } from './financial-evidence.js';
import { FINANCIAL_VERSIONS } from './financial-types.js';

export const FINANCIAL_KNOWLEDGE_SEAL_VERSION = FINANCIAL_VERSIONS.knowledgeSeal;

export const FINANCIAL_PROOF_KINDS = ['COMMIT_SEAL', 'PRESENCE_ATTESTATION'] as const;
export type FinancialProofKind = (typeof FINANCIAL_PROOF_KINDS)[number];

export interface FinancialEvidenceSeal {
  readonly evidenceId: string;
  readonly proofKind: FinancialProofKind;
  /** The exact stored record this seal binds. */
  readonly recordHash: string;
  /** Read by the database clock before the commit: a lower bound on the commit time (for a COMMIT_SEAL). */
  readonly recordedAt: string;
  /** Read by the database clock after the commit: an upper bound on the commit time (for a COMMIT_SEAL). */
  readonly sealedAt: string;
  readonly sealHash: string;
}

/** A stored record with its verified seal. The seal is null when no proof exists. Nothing here is a claim the stored data does not support. */
export interface SealedFinancialEvidence {
  readonly evidence: FinancialEvidence;
  readonly recordHash: string;
  readonly semanticHash: string;
  readonly seal: FinancialEvidenceSeal | null;
}

export type KnowledgeResult = 'PROVEN_AVAILABLE' | 'PROVEN_NOT_AVAILABLE' | 'UNPROVEN';

const CANONICAL_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVIDENCE_ID = /^fe_[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function invalid(message: string): FinancialEvidenceIntegrityError {
  return new FinancialEvidenceIntegrityError(message);
}

function sealHashOf(s: Omit<FinancialEvidenceSeal, 'sealHash'>): string {
  return hashOf({ version: FINANCIAL_KNOWLEDGE_SEAL_VERSION, proofKind: s.proofKind, evidenceId: s.evidenceId, recordHash: s.recordHash, recordedAt: s.recordedAt, sealedAt: s.sealedAt });
}

/** The form of a seal: canonical readings, a proof kind, and a bounded interval. */
function checkForm(s: Omit<FinancialEvidenceSeal, 'sealHash'>): void {
  if (!(FINANCIAL_PROOF_KINDS as readonly string[]).includes(s.proofKind)) throw invalid('unknown proof kind');
  if (!EVIDENCE_ID.test(s.evidenceId)) throw invalid('seal evidence id is malformed');
  if (!HEX64.test(s.recordHash)) throw invalid('seal record hash must be a sha-256 digest');
  for (const at of [s.recordedAt, s.sealedAt]) {
    if (!CANONICAL_MS.test(at)) throw invalid('seal timestamp must be ISO UTC with milliseconds: ' + at);
  }
  if (parseUtc(s.recordedAt) > parseUtc(s.sealedAt)) throw invalid('seal recordedAt is after sealedAt');
}

/** Builds a seal from canonical readings. The database supplies the readings; this function never reads a clock. */
export function financialSealFor(input: Omit<FinancialEvidenceSeal, 'sealHash'>): FinancialEvidenceSeal {
  checkForm(input);
  return Object.freeze({ ...input, sealHash: sealHashOf(input) });
}

/** Checks a stored seal against the record it claims to bind. Any change to a sealed field fails here. */
export function verifyFinancialSeal(seal: FinancialEvidenceSeal, expected: { evidenceId: string; recordHash: string }): FinancialEvidenceSeal {
  if (seal.evidenceId !== expected.evidenceId) throw invalid('seal belongs to another evidence record');
  if (seal.recordHash !== expected.recordHash) throw invalid('seal does not match the stored record (the record was altered after sealing)');
  checkForm(seal);
  if (sealHashOf(seal) !== seal.sealHash) throw invalid('seal hash mismatch: a sealed field was altered');
  return seal;
}

/**
 * What NEXUS's own database knowledge proves about a record at asOf. A seal proves when NEXUS's durable database held the record. It proves nothing
 * about the external source, and nothing about economic time.
 */
export function financialKnowledgeAt(sealed: SealedFinancialEvidence, asOf: string): { result: KnowledgeResult; basis: string } {
  const at = parseUtc(asOf);
  const seal = sealed.seal;
  if (seal && parseUtc(seal.sealedAt) <= at) return { result: 'PROVEN_AVAILABLE', basis: seal.proofKind + ' sealed at or before asOf' };
  // Only a COMMIT_SEAL's recordedAt is a lower bound on the commit. A presence attestation's recordedAt is when the attestation began, which says
  // nothing about when the record was committed, so it can never prove non-availability.
  if (seal && seal.proofKind === 'COMMIT_SEAL' && parseUtc(seal.recordedAt) > at) return { result: 'PROVEN_NOT_AVAILABLE', basis: 'the commit began after asOf' };
  return { result: 'UNPROVEN', basis: seal ? 'the seal does not prove availability at asOf' : 'no database seal' };
}
