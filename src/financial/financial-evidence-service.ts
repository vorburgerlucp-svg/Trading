// Orchestration of gateway and store (docs/FINANCIAL_EVIDENCE_PERSISTENCE_V1.md §16). The gateway fetches and validates. The store persists and seals. This
// service only sequences them, and it returns the exact sealed record the store holds, never the caller's in-memory copy.

import type { FinancialEvidence } from './financial-evidence.js';
import { FinancialEvidenceIntegrityError } from './financial-evidence.js';
import type { FinancialEvidenceStore, SaveStatus } from './financial-evidence-store.js';
import type { SealedFinancialEvidence } from './financial-knowledge.js';

export interface FinancialEvidenceServiceOptions {
  readonly gateway: {
    fetch(raw: unknown): Promise<FinancialEvidence>;
    fetchBatch?(raw: unknown): Promise<{ evidence: readonly FinancialEvidence[]; complete: boolean }>;
  };
  readonly store: FinancialEvidenceStore;
}

export class FinancialEvidenceService {
  constructor(private readonly options: FinancialEvidenceServiceOptions) {}

  async fetchAndPersist(request: unknown): Promise<{ status: SaveStatus; sealed: SealedFinancialEvidence }> {
    const evidence = await this.options.gateway.fetch(request);
    const status = await this.options.store.save(evidence);
    const sealed = await this.options.store.getSealed(evidence.evidenceId);
    if (sealed === null) throw new FinancialEvidenceIntegrityError('the evidence ' + evidence.evidenceId + ' was saved but cannot be read back');
    return { status, sealed };
  }

  /**
   * Several articles from one provider call. Each is saved and sealed on its own, so each has its own evidence id, its own record and its own seal. The
   * `complete` flag says whether the provider reported more pages that were not followed.
   */
  async fetchAndPersistMany(request: unknown): Promise<{ complete: boolean; items: Array<{ status: SaveStatus; sealed: SealedFinancialEvidence }> }> {
    const fetchBatch = this.options.gateway.fetchBatch;
    if (!fetchBatch) throw new FinancialEvidenceIntegrityError('the gateway offers no batch path');
    const batch = await fetchBatch.call(this.options.gateway, request);
    const items: Array<{ status: SaveStatus; sealed: SealedFinancialEvidence }> = [];
    for (const evidence of batch.evidence) {
      const status = await this.options.store.save(evidence);
      const sealed = await this.options.store.getSealed(evidence.evidenceId);
      if (sealed === null) throw new FinancialEvidenceIntegrityError('the evidence ' + evidence.evidenceId + ' was saved but cannot be read back');
      items.push({ status, sealed });
    }
    return { complete: batch.complete, items };
  }
}
