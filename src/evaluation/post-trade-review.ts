import type { PerformanceObservation } from '../ai/model-performance.js';
import type { ModelKey, Recommendation } from '../ai/model-types.js';
import type { TradeEvaluation, TradeOutcome } from './outcome-evaluator.js';
import type { DecisionTrace } from '../nexus/nexus-types.js';

export const POST_TRADE_REVIEW_VERSION = 'post-trade-review:v1' as const;
export const POST_TRADE_REVIEW_POLICY_VERSION = 'post-trade-review-policy:v1' as const;

export type ProcessClassification =
  | 'PROCESS_STRONG'
  | 'PROCESS_ACCEPTABLE'
  | 'PROCESS_WEAK'
  | 'PROCESS_BLOCKED';

export type OutcomeClassification =
  | 'OUTCOME_FAVORABLE'
  | 'OUTCOME_FLAT'
  | 'OUTCOME_ADVERSE';

export interface PostTradeReviewPolicy {
  version: typeof POST_TRADE_REVIEW_POLICY_VERSION;
  minimumEvidenceCountForStrong: number;
}

export const DEFAULT_POST_TRADE_REVIEW_POLICY: PostTradeReviewPolicy = Object.freeze({
  version: POST_TRADE_REVIEW_POLICY_VERSION,
  minimumEvidenceCountForStrong: 1,
});

export interface PostTradeReviewRequest {
  trace: DecisionTrace;
  outcome: TradeOutcome;
  evaluation: TradeEvaluation;
  performanceObservations: readonly PerformanceObservation[];
  policy?: PostTradeReviewPolicy;
}

export interface ProcessDiagnostics {
  evidenceCount: number;
  excludedLookAheadCount: number;
  evidenceWarningCount: number;
  blockingEvidenceImpactCount: number;
  successfulNonShadowAnalysts: number;
  distinctAnalystProviders: number;
  requiredIndependentOpinions: number;
  independentOpinionShortfall: number;
  criticRequired: boolean;
  criticObserved: boolean;
  counterAnalysisRequired: boolean;
  counterAnalysisObserved: boolean;
  quantStatus: 'confirmed' | 'contradicts' | 'not_available';
  quantRunId: string | null;
  scannerRunId: string | null;
  backtestRunIds: string[];
  riskPassed: boolean;
  blockingFindingCount: number;
  majorFindingCount: number;
  humanApprovalRequired: boolean;
  humanApprovalStatus: 'pending' | 'not_required';
  paperIntentAllowed: boolean;
  liveOrderAllowed: false;
  physicalPurchaseAllowed: false;
  capitalStateRefPresent: boolean;
  allocationSkipReasons: string[];
}

export interface OutcomeDiagnostics {
  returnBp: number;
  maxAdverseExcursionBp: number;
  maxFavorableExcursionBp: number;
  stop: TradeEvaluation['stop'];
  target: TradeEvaluation['target'];
  directionCorrect: boolean | null;
  netResultChf: bigint;
  feesChf: bigint;
}

export interface AttemptAttribution {
  stepId: string;
  modelKey: ModelKey;
  role: 'analyst' | 'counter_analyst' | 'critic';
  shadow: boolean;
  recommendation: Recommendation;
  confidenceScore: number | null;
  calibratedProbability: number | null;
  calibrationMethod: string | null;
  performanceScore: number;
  directionCorrect: boolean | null;
}

export interface CalibrationDiagnostic {
  stepId: string;
  modelKey: ModelKey;
  targetId: 'recommendation_direction_correct:v1';
  calibratedProbability: number;
  outcomeLabel: 0 | 1;
  brierContribution: number;
}

export type PostTradeFeedbackCode =
  | 'KEEP_PROCESS'
  | 'REVIEW_EVIDENCE_QUALITY'
  | 'REVIEW_MODEL_CONFIDENCE'
  | 'REVIEW_STOP_PLACEMENT'
  | 'REVIEW_TARGET_PLACEMENT'
  | 'REVIEW_RISK_DISCIPLINE'
  | 'REVIEW_PROVIDER_DIVERSITY'
  | 'REVIEW_QUANT_SUPPORT'
  | 'REVIEW_EXECUTION_VS_THESIS';

export interface PostTradeFeedbackItem {
  code: PostTradeFeedbackCode;
  severity: 'info' | 'minor' | 'major';
  basis: 'process' | 'outcome' | 'both';
  references: string[];
  explanation: string;
}

export interface PostTradeReview {
  reviewId: string;
  engineVersion: typeof POST_TRADE_REVIEW_VERSION;
  inputFingerprint: string;
  policy: PostTradeReviewPolicy;
  decisionId: string;
  decisionAsOf: string;
  outcomeKnownAt: string;
  instrumentId: string;
  executed: boolean;
  processClassification: ProcessClassification;
  outcomeClassification: OutcomeClassification;
  processDiagnostics: ProcessDiagnostics;
  outcomeDiagnostics: OutcomeDiagnostics;
  attemptAttribution: AttemptAttribution[];
  calibrationDiagnostics: CalibrationDiagnostic[];
  feedback: PostTradeFeedbackItem[];
  sourceFingerprints: {
    trace: string;
    outcome: string;
    evaluation: string;
    performanceObservations: string;
  };
}

export class PostTradeReviewError extends Error {
  override readonly name = 'PostTradeReviewError';
  constructor(
    readonly code:
      | 'INVALID_TRACE'
      | 'INVALID_OUTCOME'
      | 'INVALID_EVALUATION'
      | 'INVALID_PERFORMANCE'
      | 'INVALID_POLICY',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

/** O13 RED API surface. Implementation follows after behavior tests pin the contract. */
export function buildPostTradeReview(_request: PostTradeReviewRequest): PostTradeReview {
  throw new Error('O13 post-trade review not implemented');
}

export function verifyPostTradeReview(
  _request: PostTradeReviewRequest,
  _review: PostTradeReview,
): void {
  throw new Error('O13 post-trade review verifier not implemented');
}
