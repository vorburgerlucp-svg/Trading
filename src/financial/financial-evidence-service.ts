// Orchestration of gateway and store (docs/FINANCIAL_EVIDENCE_PERSISTENCE_V1.md §16). The gateway fetches and validates. The store persists and seals. This
// service only sequences them, and it returns the exact sealed record the store holds, never the caller's in-memory copy.

import type { FinancialEvidence } from './financial-evidence.js';
import { FinancialEvidenceIntegrityError } from './financial-evidence.js';
import type { FinancialEvidenceStore, SaveStatus } from './financial-evidence-store.js';
import type { SealedFinancialEvidence } from './financial-knowledge.js';

export interface FinancialEvidenceServiceOptions {
  readonly gateway: { fetch(raw: unknown): Promise<FinancialEvidence> };
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
}
