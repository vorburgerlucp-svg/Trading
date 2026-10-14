import type { ModelKey } from './model-types.js';

export const PIT_CONFIDENCE_CALIBRATION_VERSION = 'pit-confidence-calibration:v1' as const;

export type CalibrationOutcomeLabel = 0 | 1;

export interface CalibrationObservation {
  observationId: string;
  modelKey: ModelKey;
  asOf: string;
  knownAt: string;
  confidenceScore: number;
  outcomeLabel: CalibrationOutcomeLabel;
  evidenceFingerprint: string;
}

export interface HistogramCalibrationPolicy {
  binEdges: readonly number[];
  minimumFitSamples: number;
  minimumSamplesPerBin: number;
}

export interface PitCalibrationRequest {
  modelKey: ModelKey;
  targetId: string;
  targetVersion: string;
  fitAsOf: string;
  observations: readonly CalibrationObservation[];
  policy: HistogramCalibrationPolicy;
}

export interface HistogramCalibrationBin {
  index: number;
  lower: number;
  upper: number;
  sampleSize: number;
  positives: number;
  probability: number | null;
}

export type PitCalibrationStatus = 'FITTED' | 'INSUFFICIENT_SAMPLES';

export interface PitConfidenceCalibrationModel {
  calibrationRunId: string;
  engineVersion: typeof PIT_CONFIDENCE_CALIBRATION_VERSION;
  inputFingerprint: string;
  modelFingerprint: string;
  modelKey: ModelKey;
  targetId: string;
  targetVersion: string;
  method: 'histogram_binning';
  fitAsOf: string;
  policy: HistogramCalibrationPolicy;
  eligibleSampleSize: number;
  excludedFutureSampleCount: number;
  status: PitCalibrationStatus;
  bins: HistogramCalibrationBin[];
  fitEvidenceFingerprints: string[];
}

export interface AppliedPitCalibration {
  modelKey: ModelKey;
  confidenceScore: number;
  calibratedProbability: number | null;
  calibrationMethod: string | null;
  binIndex: number | null;
  binSampleSize: number | null;
  reason: 'CALIBRATED' | 'MODEL_NOT_FITTED' | 'EMPTY_BIN' | 'INSUFFICIENT_BIN_SAMPLES';
}

export interface CalibrationEvaluationRequest {
  model: PitConfidenceCalibrationModel;
  asOf: string;
  observations: readonly CalibrationObservation[];
}

export interface CalibrationEvaluationBin {
  index: number;
  sampleSize: number;
  meanPredictedProbability: number;
  observedPositiveRate: number;
}

export interface CalibrationEvaluationResult {
  modelFingerprint: string;
  asOf: string;
  eligibleSampleSize: number;
  coveredSampleSize: number;
  excludedFutureSampleCount: number;
  uncoveredSampleCount: number;
  coverageRate: number;
  brierScore: number | null;
  meanPredictedProbability: number | null;
  observedPositiveRate: number | null;
  bins: CalibrationEvaluationBin[];
}

export class PitConfidenceCalibrationError extends Error {
  override readonly name = 'PitConfidenceCalibrationError';

  constructor(
    readonly code:
      | 'INVALID_MODEL'
      | 'INVALID_TARGET'
      | 'INVALID_TIME'
      | 'INVALID_OBSERVATIONS'
      | 'INVALID_POLICY'
      | 'INVALID_CALIBRATION_MODEL'
      | 'MODEL_MISMATCH'
      | 'FIT_EVIDENCE_REUSE',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

/** O12 RED API surface. Implementation follows after behavior tests pin the contract. */
export function fitPitConfidenceCalibration(
  _request: PitCalibrationRequest,
): PitConfidenceCalibrationModel {
  throw new Error('O12 PIT confidence calibration not implemented');
}

export function verifyPitConfidenceCalibrationModel(
  _model: PitConfidenceCalibrationModel,
): void {
  throw new Error('O12 PIT confidence calibration verifier not implemented');
}

export function applyFittedCalibration(
  _model: PitConfidenceCalibrationModel,
  _modelKey: ModelKey,
  _confidenceScore: number,
): AppliedPitCalibration {
  throw new Error('O12 PIT confidence calibration apply not implemented');
}

export function evaluatePitConfidenceCalibration(
  _request: CalibrationEvaluationRequest,
): CalibrationEvaluationResult {
  throw new Error('O12 PIT confidence calibration evaluation not implemented');
}
