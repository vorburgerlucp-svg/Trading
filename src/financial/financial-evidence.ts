// FinancialEvidence (financial-evidence:v1, docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §16–§17). Identity is deterministic: the same normalized response under
// the same request and policy gives the same evidenceId. Process time never enters it, and no V1 evidence is a database proof.

import { deepFreeze } from '../persistence/append-only-log.js';
import { hashOf } from '../persistence/canonical-json.js';
import { toUntrustedBlock, type UntrustedBlock } from '../security/untrusted-input.js';
import type { FinancialSourceLicense } from './financial-license.js';
import type { FinancialRequest } from './financial-requests.js';
import type { CanonicalData } from './financial-schemas.js';
import { FINANCIAL_VERSIONS, type FinancialCapability, type FinancialMode, type FinancialTransport } from './financial-types.js';

export const KNOWLEDGE_PROOF = 'PROCESS_RECEIPT_UNSEALED' as const;
export const O1_STATUS = 'EXTERNAL_FINANCIAL_EVIDENCE_UNSEALED' as const;

export interface EvidenceTextBlock extends UntrustedBlock {
  /** Hash of the original text, kept for the audit trail when the text itself is quarantined. */
  readonly originalHash: string;
}

export interface FinancialEvidence {
  readonly evidenceId: string;
  readonly schemaVersion: 'financial-evidence:v1';
  readonly connectorId: string;
  readonly provider: string;
  readonly transport: FinancialTransport;
  readonly capability: FinancialCapability;
  readonly instrumentId: string | null;
  readonly queryFingerprint: string;
  readonly effectiveAt: string | null;
  readonly providerPublishedAt: string | null;
  readonly retrievedAt: string;
  readonly nexusReceivedAt: string;
  readonly knowledgeProof: typeof KNOWLEDGE_PROOF;
  readonly rawPayloadHash: string;
  readonly contentHash: string;
  readonly data: CanonicalData;
  readonly textBlocks?: readonly EvidenceTextBlock[];
  readonly license: FinancialSourceLicense;
  readonly provenance: {
    readonly policyVersion: string;
    readonly connectorMode: FinancialMode;
    readonly licenseStatus: string;
    readonly connectionState: string;
  };
  readonly o1Status: typeof O1_STATUS;
  readonly quality: {
    readonly schemaValid: true;
    readonly mappingVerified: boolean;
    readonly currencyExplicit: boolean;
    readonly degraded: boolean;
  };
  /** Envelope creation time. It is not part of the identity. */
  readonly createdAt: string;
}

export interface EvidenceInput {
  readonly request: FinancialRequest;
  readonly connector: { readonly connectorId: string; readonly provider: string; readonly transport: FinancialTransport };
  readonly mode: FinancialMode;
  readonly license: FinancialSourceLicense;
  readonly connectionState: string;
  readonly mappingVerified: boolean;
  readonly data: CanonicalData;
  readonly providerPublishedAt: string | null;
  readonly effectiveAt: string | null;
  readonly retrievedAt: string;
  readonly rawPayloadHash: string;
  readonly textBlocks: ReadonlyArray<{ readonly source: string; readonly text: string }>;
  /** NEXUS process time at which the gateway accepted the response. */
  readonly now: string;
}

export function buildEvidence(input: EvidenceInput): FinancialEvidence {
  const instrumentId = 'instrumentId' in input.request ? input.request.instrumentId : null;
  // The requestId is a caller correlation id, not part of what was asked for, so it stays out of the identity.
  const canonicalRequest = Object.fromEntries(Object.entries(input.request).filter(([key]) => key !== 'requestId'));
  const textHashes = input.textBlocks.map((block) => hashOf({ source: block.source, text: block.text }));
  const contentHash = hashOf({ data: input.data, textHashes });
  const evidenceId =
    'fe_' +
    hashOf({
      schemaVersion: FINANCIAL_VERSIONS.evidence,
      connectorId: input.connector.connectorId,
      provider: input.connector.provider,
      transport: input.connector.transport,
      capability: input.request.capability,
      canonicalRequest,
      instrumentId,
      contentHash,
      effectiveAt: input.effectiveAt,
      providerPublishedAt: input.providerPublishedAt,
      license: { status: input.license.status, redistribution: input.license.redistribution },
      provenancePolicyVersion: FINANCIAL_VERSIONS.gateway,
    });
  // Text blocks take the evidence id, so they are built after it. Flagged text is replaced by the quarantine notice inside toUntrustedBlock.
  const textBlocks: EvidenceTextBlock[] = input.textBlocks.map((block, index) => ({
    ...toUntrustedBlock(evidenceId, block.source, block.text),
    originalHash: textHashes[index]!,
  }));
  return deepFreeze({
    evidenceId,
    schemaVersion: FINANCIAL_VERSIONS.evidence,
    connectorId: input.connector.connectorId,
    provider: input.connector.provider,
    transport: input.connector.transport,
    capability: input.request.capability,
    instrumentId,
    queryFingerprint: hashOf(canonicalRequest),
    effectiveAt: input.effectiveAt,
    providerPublishedAt: input.providerPublishedAt,
    retrievedAt: input.retrievedAt,
    nexusReceivedAt: input.now,
    knowledgeProof: KNOWLEDGE_PROOF,
    rawPayloadHash: input.rawPayloadHash,
    contentHash,
    data: input.data,
    ...(textBlocks.length > 0 ? { textBlocks } : {}),
    license: input.license,
    provenance: {
      policyVersion: FINANCIAL_VERSIONS.gateway,
      connectorMode: input.mode,
      licenseStatus: input.license.status,
      connectionState: input.connectionState,
    },
    o1Status: O1_STATUS,
    quality: {
      schemaValid: true,
      mappingVerified: input.mappingVerified,
      currencyExplicit: typeof input.data.currency === 'string',
      degraded: input.connectionState === 'degraded',
    },
    createdAt: input.now,
  });
}
