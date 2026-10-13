import { hashOf } from '../persistence/canonical-json.js';
import type { HistoricalScannerReplayResult, HistoricalScannerReplayStep } from '../scanner/historical-scanner-replay.js';
import { verifyHistoricalScannerReplayResult } from '../scanner/historical-scanner-replay-store.js';

export const WALK_FORWARD_OOS_VERSION = 'walk-forward-oos:v1' as const;
export const WALK_FORWARD_SELECTION_POLICY_VERSION = 'walk-forward-selection:max-validation:v1' as const;

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

const HEX64 = /^[0-9a-f]{64}$/;
const compareCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function cloneVariant(variant: WalkForwardVariant): WalkForwardVariant {
  return {
    variantId: variant.variantId,
    definition: structuredClone(variant.definition),
  };
}

function normalizeVariants(raw: readonly WalkForwardVariant[]): WalkForwardVariant[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new WalkForwardOosError('INVALID_VARIANTS', 'at least one variant is required');
  const seen = new Set<string>();
  const out: WalkForwardVariant[] = [];
  for (const variant of raw) {
    if (!variant || typeof variant.variantId !== 'string' || variant.variantId.trim() === '' || variant.variantId !== variant.variantId.trim()) {
      throw new WalkForwardOosError('INVALID_VARIANTS', 'variantId must be a non-empty trimmed string');
    }
    if (seen.has(variant.variantId)) throw new WalkForwardOosError('INVALID_VARIANTS', 'duplicate variantId ' + variant.variantId);
    if (typeof variant.definition !== 'object' || variant.definition === null || Array.isArray(variant.definition)) {
      throw new WalkForwardOosError('INVALID_VARIANTS', 'variant ' + variant.variantId + ' definition must be an object');
    }
    try {
      hashOf(variant.definition);
    } catch (error) {
      throw new WalkForwardOosError('INVALID_VARIANTS', 'variant ' + variant.variantId + ' definition is not canonically hashable: ' + (error as Error).message);
    }
    seen.add(variant.variantId);
    out.push(cloneVariant(variant));
  }
  return out.sort((a, b) => compareCodeUnit(a.variantId, b.variantId));
}

interface ResolvedFold {
  spec: WalkForwardFoldSpec;
  trainStart: number;
  trainEnd: number;
  validationStart: number;
  validationEnd: number;
  testStart: number;
  testEnd: number;
}

function cloneRange(range: WalkForwardRange): WalkForwardRange {
  return { from: range.from, through: range.through };
}

function normalizeFolds(raw: readonly WalkForwardFoldSpec[], schedule: readonly string[]): ResolvedFold[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new WalkForwardOosError('INVALID_FOLDS', 'at least one fold is required');
  const indexOf = new Map(schedule.map((at, index) => [at, index]));
  const ids = new Set<string>();
  const resolved: ResolvedFold[] = [];

  const boundary = (value: unknown, label: string): number => {
    if (typeof value !== 'string') throw new WalkForwardOosError('INVALID_FOLDS', label + ' must be an O9 replay instant');
    const index = indexOf.get(value);
    if (index === undefined) throw new WalkForwardOosError('INVALID_FOLDS', label + ' is not present in the O9 replay schedule');
    return index;
  };

  for (const fold of raw) {
    if (!fold || typeof fold.foldId !== 'string' || fold.foldId.trim() === '' || fold.foldId !== fold.foldId.trim()) {
      throw new WalkForwardOosError('INVALID_FOLDS', 'foldId must be a non-empty trimmed string');
    }
    if (ids.has(fold.foldId)) throw new WalkForwardOosError('INVALID_FOLDS', 'duplicate foldId ' + fold.foldId);
    ids.add(fold.foldId);

    const trainStart = boundary(fold.train?.from, fold.foldId + '.train.from');
    const trainEnd = boundary(fold.train?.through, fold.foldId + '.train.through');
    const validationStart = boundary(fold.validation?.from, fold.foldId + '.validation.from');
    const validationEnd = boundary(fold.validation?.through, fold.foldId + '.validation.through');
    const testStart = boundary(fold.test?.from, fold.foldId + '.test.from');
    const testEnd = boundary(fold.test?.through, fold.foldId + '.test.through');

    if (trainStart > trainEnd || validationStart > validationEnd || testStart > testEnd) {
      throw new WalkForwardOosError('INVALID_FOLDS', fold.foldId + ' contains a reversed phase range');
    }
    if (trainEnd >= validationStart || validationEnd >= testStart) {
      throw new WalkForwardOosError('INVALID_FOLDS', fold.foldId + ' phases overlap or are not ordered train < validation < test');
    }

    resolved.push({
      spec: {
        foldId: fold.foldId,
        train: cloneRange(fold.train),
        validation: cloneRange(fold.validation),
        test: cloneRange(fold.test),
      },
      trainStart,
      trainEnd,
      validationStart,
      validationEnd,
      testStart,
      testEnd,
    });
  }

  return resolved.sort((a, b) => a.testStart - b.testStart || compareCodeUnit(a.spec.foldId, b.spec.foldId));
}

function validateSourceReplay(source: HistoricalScannerReplayResult): HistoricalScannerReplayResult {
  try {
    return verifyHistoricalScannerReplayResult(source);
  } catch (error) {
    throw new WalkForwardOosError('INVALID_SOURCE_REPLAY', (error as Error).message);
  }
}

function frozenSteps(source: HistoricalScannerReplayResult, from: number, through: number): readonly HistoricalScannerReplayStep[] {
  const copy = structuredClone(source.steps.slice(from, through + 1));
  if (copy.length === 0) throw new WalkForwardOosError('INVALID_FOLDS', 'a phase resolved to an empty step range');
  return deepFreeze(copy);
}

function normalizeEvaluation(
  raw: WalkForwardEvaluation,
  expected: {
    variantId: string;
    foldId: string;
    phase: WalkForwardPhase;
    stepFrom: string;
    stepThrough: string;
  },
): WalkForwardEvaluation {
  if (
    !raw ||
    raw.variantId !== expected.variantId ||
    raw.foldId !== expected.foldId ||
    raw.phase !== expected.phase ||
    raw.stepFrom !== expected.stepFrom ||
    raw.stepThrough !== expected.stepThrough
  ) {
    throw new WalkForwardOosError(
      'INVALID_EVALUATION',
      expected.foldId + '/' + expected.phase + '/' + expected.variantId + ' evaluator metadata does not match its request',
    );
  }
  if (!Number.isFinite(raw.objectiveValue)) {
    throw new WalkForwardOosError('INVALID_EVALUATION', expected.foldId + '/' + expected.phase + '/' + expected.variantId + ' objective is not finite');
  }
  if (typeof raw.evaluationFingerprint !== 'string' || !HEX64.test(raw.evaluationFingerprint)) {
    throw new WalkForwardOosError('INVALID_EVALUATION', expected.foldId + '/' + expected.phase + '/' + expected.variantId + ' evaluation fingerprint is invalid');
  }
  return {
    variantId: raw.variantId,
    foldId: raw.foldId,
    phase: raw.phase,
    stepFrom: raw.stepFrom,
    stepThrough: raw.stepThrough,
    objectiveValue: raw.objectiveValue,
    evaluationFingerprint: raw.evaluationFingerprint,
    ...(raw.metrics !== undefined ? { metrics: structuredClone(raw.metrics) } : {}),
  };
}

async function evaluate(
  evaluator: WalkForwardEvaluator,
  variant: WalkForwardVariant,
  foldId: string,
  phase: WalkForwardPhase,
  steps: readonly HistoricalScannerReplayStep[],
): Promise<WalkForwardEvaluation> {
  const safeVariant = deepFreeze(cloneVariant(variant));
  const input: WalkForwardEvaluatorInput = deepFreeze({
    variant: safeVariant,
    foldId,
    phase,
    steps,
  });
  const raw = await evaluator.evaluate(input);
  return normalizeEvaluation(raw, {
    variantId: variant.variantId,
    foldId,
    phase,
    stepFrom: steps[0]!.asOf,
    stepThrough: steps.at(-1)!.asOf,
  });
}

function oosSummary(folds: readonly WalkForwardFoldResult[]): WalkForwardOosSummary {
  const values = folds.map((fold) => fold.testEvaluation.objectiveValue);
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2;

  const counts = new Map<string, number>();
  for (const fold of folds) counts.set(fold.selectedVariantId, (counts.get(fold.selectedVariantId) ?? 0) + 1);
  const selectedVariantCounts = Object.fromEntries(
    [...counts.entries()].sort(([a], [b]) => compareCodeUnit(a, b)),
  );

  return {
    foldCount: folds.length,
    selectedVariantCounts,
    meanTestObjective: total / values.length,
    medianTestObjective: median,
    minimumTestObjective: sorted[0]!,
    maximumTestObjective: sorted.at(-1)!,
  };
}

/**
 * Deterministic walk-forward orchestration. The evaluator sees only the immutable O9 steps for the
 * requested phase. Test evaluation starts only after train/validation selection is frozen.
 */
export async function runWalkForwardOos(
  request: WalkForwardRequest,
  evaluator: WalkForwardEvaluator,
): Promise<WalkForwardResult> {
  const source = validateSourceReplay(request.sourceReplay);
  const variants = normalizeVariants(request.variants);
  const folds = normalizeFolds(request.folds, source.asOf);

  const minimumTrainingObjective =
    request.minimumTrainingObjective === undefined ? null : request.minimumTrainingObjective;
  if (minimumTrainingObjective !== null && !Number.isFinite(minimumTrainingObjective)) {
    throw new WalkForwardOosError('INVALID_VARIANTS', 'minimumTrainingObjective must be finite when provided');
  }

  const foldResults: WalkForwardFoldResult[] = [];

  for (const fold of folds) {
    const trainSteps = frozenSteps(source, fold.trainStart, fold.trainEnd);
    const validationSteps = frozenSteps(source, fold.validationStart, fold.validationEnd);
    const testSteps = frozenSteps(source, fold.testStart, fold.testEnd);

    const trainingEvaluations: WalkForwardEvaluation[] = [];
    for (const variant of variants) {
      trainingEvaluations.push(await evaluate(evaluator, variant, fold.spec.foldId, 'train', trainSteps));
    }

    const eligibleIds = new Set(
      trainingEvaluations
        .filter((evaluation) => minimumTrainingObjective === null || evaluation.objectiveValue >= minimumTrainingObjective)
        .map((evaluation) => evaluation.variantId),
    );
    if (eligibleIds.size === 0) {
      throw new WalkForwardOosError('NO_ELIGIBLE_VARIANT', fold.spec.foldId + ' has no training-eligible variant');
    }

    const validationEvaluations: WalkForwardEvaluation[] = [];
    for (const variant of variants) {
      if (!eligibleIds.has(variant.variantId)) continue;
      validationEvaluations.push(await evaluate(evaluator, variant, fold.spec.foldId, 'validation', validationSteps));
    }

    const bestValue = Math.max(...validationEvaluations.map((evaluation) => evaluation.objectiveValue));
    const best = validationEvaluations.filter((evaluation) => evaluation.objectiveValue === bestValue);
    if (best.length !== 1) {
      throw new WalkForwardOosError(
        'WALK_FORWARD_SELECTION_AMBIGUOUS',
        fold.spec.foldId + ' has ' + best.length + ' variants tied at validation objective ' + bestValue,
      );
    }

    const selectedValidation = best[0]!;
    const selectedVariant = variants.find((variant) => variant.variantId === selectedValidation.variantId)!;
    const selectedTraining = trainingEvaluations.find((evaluation) => evaluation.variantId === selectedVariant.variantId)!;

    // The selected variant and its train/validation evidence are frozen before TEST is evaluated.
    const selectionEvidence: WalkForwardSelectionEvidence = {
      selectedVariantId: selectedVariant.variantId,
      trainingEvaluationFingerprint: selectedTraining.evaluationFingerprint,
      validationEvaluationFingerprint: selectedValidation.evaluationFingerprint,
    };

    const testEvaluation = await evaluate(evaluator, selectedVariant, fold.spec.foldId, 'test', testSteps);

    foldResults.push({
      foldId: fold.spec.foldId,
      train: cloneRange(fold.spec.train),
      validation: cloneRange(fold.spec.validation),
      test: cloneRange(fold.spec.test),
      trainingEvaluations,
      validationEvaluations,
      selectedVariantId: selectedVariant.variantId,
      selectionEvidence,
      testEvaluation,
    });
  }

  const summary = oosSummary(foldResults);
  const normalizedFolds = folds.map((fold) => fold.spec);
  const identity = {
    engine: WALK_FORWARD_OOS_VERSION,
    selectionPolicy: WALK_FORWARD_SELECTION_POLICY_VERSION,
    sourceReplayRunId: source.replayRunId,
    sourceReplayInputFingerprint: source.inputFingerprint,
    variants,
    folds: normalizedFolds,
    minimumTrainingObjective,
    foldResults: foldResults.map((fold) => ({
      foldId: fold.foldId,
      training: fold.trainingEvaluations.map((evaluation) => ({
        variantId: evaluation.variantId,
        objectiveValue: evaluation.objectiveValue,
        evaluationFingerprint: evaluation.evaluationFingerprint,
      })),
      validation: fold.validationEvaluations.map((evaluation) => ({
        variantId: evaluation.variantId,
        objectiveValue: evaluation.objectiveValue,
        evaluationFingerprint: evaluation.evaluationFingerprint,
      })),
      selectedVariantId: fold.selectedVariantId,
      selectionEvidence: fold.selectionEvidence,
      test: {
        variantId: fold.testEvaluation.variantId,
        objectiveValue: fold.testEvaluation.objectiveValue,
        evaluationFingerprint: fold.testEvaluation.evaluationFingerprint,
      },
    })),
  };
  const inputFingerprint = hashOf(identity);

  return {
    walkForwardRunId: 'wfo_' + inputFingerprint.slice(0, 40),
    engineVersion: WALK_FORWARD_OOS_VERSION,
    inputFingerprint,
    sourceReplayRunId: source.replayRunId,
    sourceReplayInputFingerprint: source.inputFingerprint,
    variants: variants.map(cloneVariant),
    folds: normalizedFolds.map((fold) => ({
      foldId: fold.foldId,
      train: cloneRange(fold.train),
      validation: cloneRange(fold.validation),
      test: cloneRange(fold.test),
    })),
    minimumTrainingObjective,
    foldResults,
    oosSummary: summary,
  };
}
