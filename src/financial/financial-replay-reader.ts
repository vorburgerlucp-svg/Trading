// The historical replay reader (docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §5, §7–§9, §15). It is a separate path from FinancialEvidenceStore.readAvailable,
// which keeps its meaning: DB knowledge only. decision_time uses the DB seal and never reads an attestation. historical_research also accepts a verified
// SEC source attestation, under the New York filing-date policy. Each returned record states its basis, and the DB seal is the basis whenever both exist.

import type { FinancialEvidence } from './financial-evidence.js';
import type { SealedFinancialEvidence } from './financial-knowledge.js';
import {
  FinancialSourceAttestationError,
  verifyFinancialSourceAttestation,
  type FinancialReplayUseCase,
  type FinancialSourceAttestation,
  type SourceResult,
} from './financial-source-attestation.js';
import { sourceEligibleOn } from './historical-policy.js';

export type ReplayBasis = 'DB_KNOWLEDGE_SEAL' | 'SEC_SOURCE_ATTESTATION';

export interface ReplayScope {
  readonly asOf: string;
  readonly instrumentId?: string;
  readonly connectorId?: string;
  readonly capability?: string;
}

export interface ReplayQuery extends ReplayScope {
  readonly useCase: FinancialReplayUseCase;
  readonly provider?: string;
}

export interface ReplayRecord {
  readonly evidence: FinancialEvidence;
  readonly sealed: SealedFinancialEvidence;
  /** The basis is always stated. A DB seal and an attestation are never mixed silently. */
  readonly basis: ReplayBasis;
  /** The verified attestation behind a SEC_SOURCE_ATTESTATION basis, or null for a DB basis. */
  readonly attestation: FinancialSourceAttestation | null;
}

/** The two stores the reader reads. Both are provider-neutral contracts. */
export interface ReplayDeps {
  readonly evidenceStore: {
    readAvailable(query: ReplayScope): Promise<readonly SealedFinancialEvidence[]>;
    getSealed(evidenceId: string): Promise<SealedFinancialEvidence | null>;
  };
  readonly attestationStore: {
    readEligible(query: ReplayScope): Promise<readonly FinancialSourceAttestation[]>;
    getForEvidence(evidenceId: string): Promise<readonly FinancialSourceAttestation[]>;
  };
}

const USE_CASES: readonly string[] = ['decision_time', 'historical_research'];

function compareEvidenceIds(a: ReplayRecord, b: ReplayRecord): number {
  const x = a.evidence.evidenceId;
  const y = b.evidence.evidenceId;
  return x < y ? -1 : x > y ? 1 : 0;
}

export class FinancialReplayReader {
  constructor(private readonly deps: ReplayDeps) {}

  /** The records that may be used for this use case at asOf. Each carries its basis. */
  async readForReplay(query: ReplayQuery): Promise<ReplayRecord[]> {
    if (!USE_CASES.includes(query.useCase)) throw new FinancialSourceAttestationError('SOURCE_ATTESTATION_UNSUPPORTED', 'unknown replay use case: ' + String(query.useCase));
    const scope: ReplayScope = { asOf: query.asOf, instrumentId: query.instrumentId, connectorId: query.connectorId, capability: query.capability };
    const records = new Map<string, ReplayRecord>();
    for (const sealed of await this.deps.evidenceStore.readAvailable(scope)) {
      if (query.provider !== undefined && sealed.evidence.provider !== query.provider) continue;
      records.set(sealed.evidence.evidenceId, { evidence: sealed.evidence, sealed, basis: 'DB_KNOWLEDGE_SEAL', attestation: null });
    }
    // decision_time never reads an attestation: a source record is not something NEXUS held by asOf.
    if (query.useCase === 'historical_research') {
      for (const [evidenceId, attestation] of await this.eligibleAttestations(query)) {
        // The DB seal is the stronger local knowledge, so a record that has one keeps the DB basis.
        if (records.has(evidenceId)) continue;
        const sealed = await this.boundRecord(evidenceId, attestation);
        records.set(evidenceId, { evidence: sealed.evidence, sealed, basis: 'SEC_SOURCE_ATTESTATION', attestation });
      }
    }
    return [...records.values()].sort(compareEvidenceIds);
  }

  /** What the source attestations say about one evidence record at asOf. Uses the source vocabulary, never PROVEN_AVAILABLE. */
  async sourceResultOf(evidenceId: string, asOf: string): Promise<SourceResult> {
    const attestations = await this.deps.attestationStore.getForEvidence(evidenceId);
    if (attestations.length === 0) return 'SOURCE_ATTESTATION_MISSING';
    let verified: FinancialSourceAttestation[];
    try {
      verified = attestations.map((a) => verifyFinancialSourceAttestation(a));
    } catch {
      return 'SOURCE_ATTESTATION_INVALID';
    }
    return verified.some((a) => sourceEligibleOn(a.sourceFilingDate, asOf)) ? 'SOURCE_ATTESTED_RESEARCH_AVAILABLE' : 'SOURCE_NOT_YET_ELIGIBLE';
  }

  /**
   * The eligible attestations for the query, one per evidence record. Every row is verified, and the New York policy is applied again, whatever the store
   * returned. Two different verified attestations eligible for one record fail closed (SOURCE_ATTESTATION_CONFLICT).
   */
  private async eligibleAttestations(query: ReplayQuery): Promise<Map<string, FinancialSourceAttestation>> {
    const scope: ReplayScope = { asOf: query.asOf, instrumentId: query.instrumentId, connectorId: query.connectorId, capability: query.capability };
    const verified = (await this.deps.attestationStore.readEligible(scope)).map((a) => verifyFinancialSourceAttestation(a));
    const eligible = verified.filter((a) => sourceEligibleOn(a.sourceFilingDate, query.asOf) && (query.provider === undefined || a.provider === query.provider));
    const byEvidence = new Map<string, FinancialSourceAttestation[]>();
    for (const attestation of eligible) {
      const list = byEvidence.get(attestation.evidenceId) ?? [];
      list.push(attestation);
      byEvidence.set(attestation.evidenceId, list);
    }
    const chosen = new Map<string, FinancialSourceAttestation>();
    for (const [evidenceId, list] of byEvidence) {
      const distinct = new Set(list.map((a) => a.attestationId));
      if (distinct.size > 1) throw new FinancialSourceAttestationError('SOURCE_ATTESTATION_CONFLICT', 'two different verified attestations are eligible for ' + evidenceId + '; refusing to choose');
      chosen.set(evidenceId, list[0]!);
    }
    return chosen;
  }

  /** The stored evidence the attestation is bound to. It must be stored, and it must match every bound field. */
  private async boundRecord(evidenceId: string, attestation: FinancialSourceAttestation): Promise<SealedFinancialEvidence> {
    const sealed = await this.deps.evidenceStore.getSealed(evidenceId);
    if (sealed === null) throw new FinancialSourceAttestationError('SOURCE_ATTESTATION_INVALID', 'the attested evidence ' + evidenceId + ' is not stored');
    verifyFinancialSourceAttestation(attestation, {
      evidenceId: sealed.evidence.evidenceId,
      evidenceRecordHash: sealed.recordHash,
      evidenceContentHash: sealed.evidence.contentHash,
      instrumentId: sealed.evidence.instrumentId,
    });
    return sealed;
  }
}
