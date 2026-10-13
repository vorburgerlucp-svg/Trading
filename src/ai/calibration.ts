// Confidence ≠ probability.
// A model's confidence is an uncalibrated SCORE. A calibrated probability may only exist when a
// documented calibration method was fitted on enough historical outcomes. Until then it is null —
// and the database enforces that a probability never appears without its method.

export type CalibrationMethod = 'isotonic_regression' | 'platt_scaling' | 'histogram_binning';

export interface CalibrationModel {
  method: CalibrationMethod;
  /** Version/identifier of the fitted model (for the audit trail). */
  version: string;
  fittedAt: string;
  /** Number of evaluated outcomes the model was fitted on. */
  sampleSize: number;
  /** Minimum sample size this method requires before it may be used. */
  minSamples: number;
  /** Maps a raw confidence score (0..1) to a probability (0..1). */
  apply(confidence: number): number;
}

export interface CalibrationResult {
  confidenceScore: number;
  calibratedProbability: number | null;
  calibrationMethod: string | null;
}

export function calibrate(confidenceScore: number, model: CalibrationModel | null): CalibrationResult {
  if (!(confidenceScore >= 0 && confidenceScore <= 1)) throw new Error('confidence score must be within 0..1');
  if (model === null || model.sampleSize < model.minSamples || model.minSamples <= 0) {
    return { confidenceScore, calibratedProbability: null, calibrationMethod: null };
  }
  const probability = model.apply(confidenceScore);
  if (!(probability >= 0 && probability <= 1)) throw new Error('calibration model returned an invalid probability');
  return { confidenceScore, calibratedProbability: probability, calibrationMethod: model.method + '@' + model.version };
}
