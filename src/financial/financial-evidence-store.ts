// Provider-neutral persistence contract for financial evidence (financial-evidence-store:v1, docs/FINANCIAL_EVIDENCE_PERSISTENCE_V1.md §11). The gateway
// stays the provider, schema and security boundary; a store only persists verified evidence and returns its verified seal.

import type { FinancialEvidence } from './financial-evidence.js';
import type { SealedFinancialEvidence } from './financial-knowledge.js';
import type { FinancialCapability } from './financial-types.js';

export type SaveStatus = 'APPLIED' | 'ALREADY_APPLIED';

/** A strict point-in-time read: records whose seal proves NEXUS knew them by asOf. Economic time is not a filter. */
export interface FinancialEvidencePitQuery {
  readonly asOf: string;
  readonly instrumentId?: string;
  readonly connectorId?: string;
  readonly capability?: FinancialCapability;
}

export interface FinancialEvidenceStore {
  /** Verifies, then stores. The first record and its seal are kept: a later equivalent fetch is ALREADY_APPLIED and changes nothing. */
  save(evidence: FinancialEvidence): Promise<SaveStatus>;
  get(evidenceId: string): Promise<FinancialEvidence | null>;
  getSealed(evidenceId: string): Promise<SealedFinancialEvidence | null>;
  readAvailable(query: FinancialEvidencePitQuery): Promise<readonly SealedFinancialEvidence[]>;
}

/** The same evidence id holds a different semantic identity. Never resolved by overwriting. */
export class FinancialEvidenceConflictError extends Error {
  override readonly name = 'FinancialEvidenceConflictError';
  readonly code = 'EVIDENCE_CONFLICT' as const;
}
