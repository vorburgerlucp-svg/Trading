// NEXUS Memory stores structured records and retrieves them later. It does NOT train or change
// any underlying language model; "learning" happens through measured metadata (model performance,
// outcomes) that deterministic code reads.

export type MemoryKind =
  | 'market' // observations about markets/instruments
  | 'trade' // trade outcomes and evaluations
  | 'business' // physical commerce / business outcomes
  | 'strategy' // strategy notes and benchmarks
  | 'model_performance' // per-model evaluation observations
  | 'failure'; // model/system failures (timeouts, invalid output, outages)
// Decisions are not memory records: they live in the DecisionRecordStore + audit events (src/audit).

export interface MemoryRecordInput<C = unknown> {
  id: string;
  kind: MemoryKind;
  /** Main subject: instrument, product, model key, decision id, ... */
  subject: string;
  tags: string[];
  content: C;
  /** When the remembered event happened. */
  occurredAt: string;
  /** When the information became known; recall at time T only sees availableAt <= T (no look-ahead). */
  availableAt: string;
  evidenceRefs?: string[];
  /** Corrections are new records that supersede old ones; nothing is edited. */
  supersedes?: string;
  source: string;
}

export interface MemoryRecord<C = unknown> extends MemoryRecordInput<C> {
  recordedAt: string;
}

export interface RecallQuery {
  kind: MemoryKind;
  /** Point in time of the question. Required: there is no "recall everything regardless of time". */
  asOf: string;
  subject?: string;
  /** All listed tags must be present. */
  tags?: string[];
  limit?: number;
  /**
   * Second time axis: only records NEXUS had stored up to this memory position (see NexusMemory.position).
   * `asOf` alone admits records back-filled later with an earlier availableAt; with this bound a past
   * view stays exactly reproducible.
   */
  storedThrough?: number;
}
