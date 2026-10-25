// R2: contracts the later Learning Lab builds on. Types only (no Learning Lab logic, no agents): what a comparison between a
// simulated plan and an observed execution must carry, and how the phases of a review are kept apart.
//   Phase R (reconstruction): only information available at the decision time (dataBasis.asOf, storedThrough, the model and
//                             prompt versions used THEN), sealed before Phase E;
//   Phase E (evaluation):     the outcome data, read only after the reconstruction was sealed.

import type { EvaluationV2 } from './outcome-eval-v2.js';
import type { EvaluationOrigin, Realization } from './trade-plan.js';

/** An execution observed at a broker or paper engine (never produced by the simulator). DEMO fills are not market evidence. */
export interface ObservedExecutionV2 {
  realization: Exclude<Realization, 'HYPOTHETICAL'>;
  origin: EvaluationOrigin;
  planId: string;
  /** Evidence references (e.g. intent and confirmation record ids); no raw broker payloads. */
  evidenceRefs: string[];
  entryFill: { at: string; price: string; quantity: string } | null;
  exitFill: { at: string; price: string; quantity: string } | null;
  fees: string | null;
  status: 'filled' | 'partially_filled' | 'rejected' | 'cancelled' | 'open' | 'unknown';
}

/** A simulated plan next to its observed execution: the deviations are the finding, never a merged result. */
export interface SimulationComparisonV2 {
  planId: string;
  simulated: EvaluationV2;
  observed: ObservedExecutionV2;
  /** Observed minus simulated, in the quote currency; null where one side has no value. */
  deviations: { entryPrice: string | null; exitPrice: string | null; netPnl: string | null; fees: string | null };
  /** Known causes, e.g. PARTIAL_FILL, REJECTED, DIFFERENT_EXIT_TIME, DEMO_FILL_MODEL. */
  causes: string[];
}

/** The model and prompt that made a decision THEN; a review never substitutes today's versions silently. */
export interface DecisionProvenanceV2 {
  decisionId: string;
  modelKeys: string[];
  promptVersions: string[];
  codeVersion: string;
  dataBasis: { asOf: string; storedThrough: number; inputFingerprint: string };
}

/** The seal of a Phase R reconstruction; Phase E may only start after it. */
export interface ReconstructionSealV2 {
  reviewId: string;
  sealedAt: string;
  reconstructionHash: string;
  /** No outcome data may have been readable before sealedAt (asserted by the review, not assumed). */
  outcomeDataUnlockedAt: string;
}
