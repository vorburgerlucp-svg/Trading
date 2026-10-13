// The provider-neutral contract for stored source attestations (docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §20–§21). A store persists verified
// attestations and returns verified ones. It never decides the research policy by itself: readEligible filters by the New York filing-date bound, and the
// reader applies the policy again to every row.

import type { FinancialSourceAttestation } from './financial-source-attestation.js';

export type SourceSaveStatus = 'APPLIED' | 'ALREADY_APPLIED';

export interface SourceAttestationQuery {
  /** A canonical UTC instant. The New York calendar date of this instant is the filing-date bound. */
  readonly asOf: string;
  readonly instrumentId?: string;
  readonly connectorId?: string;
  readonly capability?: string;
}

export interface FinancialSourceAttestationStore {
  /** Verifies, then stores under a transaction lock. An identical attestation is ALREADY_APPLIED and changes nothing. */
  save(attestation: FinancialSourceAttestation): Promise<SourceSaveStatus>;
  get(attestationId: string): Promise<FinancialSourceAttestation | null>;
  getForEvidence(evidenceId: string): Promise<readonly FinancialSourceAttestation[]>;
  /** Verified attestations whose official filing date is before the New York date of asOf, and that match the filters. */
  readEligible(query: SourceAttestationQuery): Promise<readonly FinancialSourceAttestation[]>;
}
