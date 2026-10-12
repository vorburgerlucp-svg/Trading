// The error vocabulary of historical financial source attestation (docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §26). Kept in its own module, so the
// archive parser and the attestation record can both use it without an import cycle. DATA_NOT_CONNECTED is never reused for a semantic mismatch.

export type SourceAttestationErrorCode =
  | 'SOURCE_ATTESTATION_UNSUPPORTED'
  | 'SOURCE_ATTESTATION_INVALID'
  | 'SOURCE_SEMANTIC_MISMATCH'
  | 'SOURCE_ARTIFACT_MISMATCH'
  | 'SOURCE_ATTESTATION_CONFLICT';

export class FinancialSourceAttestationError extends Error {
  override readonly name = 'FinancialSourceAttestationError';
  constructor(
    readonly code: SourceAttestationErrorCode,
    message: string,
  ) {
    super(message);
  }
}
