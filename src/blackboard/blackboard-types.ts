import type { CouncilRole } from '../ai/model-types.js';

export type BlackboardCategory =
  | 'fact'
  | 'hypothesis'
  | 'risk'
  | 'catalyst'
  | 'contradiction'
  | 'calculation'
  | 'recommendation'
  | 'critique';

export interface BlackboardAuthor {
  type: 'model' | 'quant' | 'system' | 'human';
  provider?: string;
  model?: string;
  role?: CouncilRole;
  /** Plan step that produced the entry; used to isolate independent analyses. */
  stepId?: string;
  /** Shadow-mode output: stored for benchmarking, excluded from decisions. */
  shadow?: boolean;
}

export interface BlackboardEntryInput {
  taskId: string;
  author: BlackboardAuthor;
  category: BlackboardCategory;
  statement: string;
  confidence?: number;
  evidenceRefs: string[];
  validUntil?: string;
}

/**
 * verified:     all refs known, visible at asOf, trusted, and fresh or timeless
 * missing:      no evidence given
 * unknown:      at least one ref is not registered
 * untrusted:    at least one ref comes from an unverified source
 * stale:        at least one time-sensitive ref is older than its freshness window
 */
export type EntryEvidenceStatus = 'verified' | 'missing' | 'unknown' | 'untrusted' | 'stale';

export interface BlackboardEntry extends BlackboardEntryInput {
  id: string;
  createdAt: string;
  /** Category the author asked for; `category` is what NEXUS accepted after the evidence policy. */
  requestedCategory: BlackboardCategory;
  evidenceStatus: EntryEvidenceStatus;
  downgradeReason?: string;
}
