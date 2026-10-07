export type EvidenceType =
  | 'market_price'
  | 'fx_rate'
  | 'broker_position'
  | 'sec_filing'
  | 'company_report'
  | 'news'
  | 'web_page'
  | 'social_media'
  | 'macro_series'
  | 'exchange_data'
  | 'inventory_record'
  | 'marketplace_offer'
  | 'manual_input'
  | 'quant_calculation'
  | 'capital_state';

/** Evidence whose content is free text from outside NEXUS. Always untrusted as instructions. */
export const EXTERNAL_TEXT_TYPES: readonly EvidenceType[] = ['news', 'web_page', 'social_media'];

/**
 * Provenance of one piece of data. Three timestamps make point-in-time replay possible:
 *  observedAt  – when the value was true / observed at the source (e.g. quote time)
 *  availableAt – when it became available to the public / to NEXUS (e.g. publication time)
 *  retrievedAt – when NEXUS fetched it
 * A decision at time T may only use evidence with availableAt <= T.
 */
export interface EvidenceRef {
  id: string;
  type: EvidenceType;
  source: string;
  observedAt: string;
  availableAt: string;
  retrievedAt: string;
  /** Max age (from observedAt) for use as CURRENT data. Undefined: not time-sensitive (e.g. a filing). */
  freshnessMs?: number;
  /** Integrity of the source (verified API / feed). Says nothing about obeying its content: content is always data. */
  trusted: boolean;
  contentKind: 'structured' | 'external_text';
  contentHash?: string;
  metadata?: Record<string, unknown>;
}

export type EvidenceStatus =
  | 'fresh' // within freshnessMs at asOf
  | 'timeless' // no freshness requirement
  | 'stale' // older than freshnessMs: must not be treated as current
  | 'not_yet_available' // availableAt > asOf: look-ahead, invisible
  | 'unknown'; // not registered

export interface EvidenceAssessment {
  id: string;
  status: EvidenceStatus;
  ageMs: number | null;
  trusted: boolean;
  ref: EvidenceRef | null;
}
