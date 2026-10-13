import type { HistoricalScannerReplayResult, HistoricalScannerReplayStep } from '../scanner/historical-scanner-replay.js';

export const WALK_FORWARD_OOS_VERSION = 'walk-forward-oos:v1' as const;

export type WalkForwardPhase = 'train' | 'validation' | 'test';

export interface WalkForwardVariant {
  variantId: string;
  definition: Readonly<Record<string, unknown>>;
}

export interface WalkForwardRange {
  from: string;
  through: string;
}

export interface WalkForwardFoldSpec {
  foldId: string;
  train: WalkForwardRange;
  validation: WalkForwardRange;
  test: WalkForwardRange;
}

export interface WalkForwardEvaluation {
  variantId: string;
  foldId: string;
  phase: WalkForwardPhase;
  stepFrom: string;
  stepThrough: string;
  objectiveValue: number;
  evaluationFingerprint: string;
  metrics?: Readonly<Record<string, unknown>>;
}

export interface WalkForwardEvaluatorInput {
  variant: WalkForwardVariant;
  foldId: string;
  phase: WalkForwardPhase;
  steps: readonly HistoricalScannerReplayStep[];
}

export interface WalkForwardEvaluator {
  evaluate(input: WalkForwardEvaluatorInput): Promise<WalkForwardEvaluation>;
}

export interface WalkForwardRequest {
  sourceReplay: HistoricalScannerReplayResult;
  variants: readonly WalkForwardVariant[];
  folds: readonly WalkForwardFoldSpec[];
  minimumTrainingObjective?: number;
}

export interface WalkForwardSelectionEvidence {
  selectedVariantId: string;
  trainingEvaluationFingerprint: string;
  validationEvaluationFingerprint: string;
}

export interface WalkForwardFoldResult {
  foldId: string;
  train: WalkForwardRange;
  validation: WalkForwardRange;
  test: WalkForwardRange;
  trainingEvaluations: WalkForwardEvaluation[];
  validationEvaluations: WalkForwardEvaluation[];
  selectedVariantId: string;
  selectionEvidence: WalkForwardSelectionEvidence;
  testEvaluation: WalkForwardEvaluation;
}

export interface WalkForwardOosSummary {
  foldCount: number;
  selectedVariantCounts: Readonly<Record<string, number>>;
  meanTestObjective: number;
  medianTestObjective: number;
  minimumTestObjective: number;
  maximumTestObjective: number;
}

export interface WalkForwardResult {
  walkForwardRunId: string;
  engineVersion: typeof WALK_FORWARD_OOS_VERSION;
  inputFingerprint: string;
  sourceReplayRunId: string;
  sourceReplayInputFingerprint: string;
  variants: WalkForwardVariant[];
  folds: WalkForwardFoldSpec[];
  minimumTrainingObjective: number | null;
  foldResults: WalkForwardFoldResult[];
  oosSummary: WalkForwardOosSummary;
}

export class WalkForwardOosError extends Error {
  override readonly name = 'WalkForwardOosError';
  constructor(
    readonly code:
      | 'INVALID_SOURCE_REPLAY'
      | 'INVALID_VARIANTS'
      | 'INVALID_FOLDS'
      | 'NO_ELIGIBLE_VARIANT'
      | 'WALK_FORWARD_SELECTION_AMBIGUOUS'
      | 'INVALID_EVALUATION',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

/** O10 RED API surface. Implementation follows after behavior tests pin the contract. */
export async function runWalkForwardOos(
  _request: WalkForwardRequest,
  _evaluator: WalkForwardEvaluator,
): Promise<WalkForwardResult> {
  throw new Error('O10 walk-forward OOS not implemented');
}
