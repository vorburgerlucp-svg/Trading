import { hashOf } from '../persistence/canonical-json.js';
import type { ModelKey } from './model-types.js';

// Point-in-time confidence calibration (pit-confidence-calibration:v1). The contract is docs/O12_PIT_CONFIDENCE_CALIBRATION_V1.md.
// A row is classified by its knownAt alone: a row known after the cutoff contributes only to the excluded count, and its outcome, confidence, label and
// fingerprint are never inspected. Identity-level checks (an object, a valid observationId, the model key and a readable knownAt) still apply to every row,
// because a row that cannot be identified or placed in time cannot be classified at all.

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
  /** Empirical probability. Non-null only for a FITTED model and a bin that meets minimumSamplesPerBin. */
  probability: number | null;
}

export interface CalibrationFitEvidence {
  observationId: string;
  asOf: string;
  knownAt: string;
  confidenceScore: number;
  outcomeLabel: CalibrationOutcomeLabel;
  evidenceFingerprint: string;
  /** The row's content identity (everything but observationId). It binds the row's values. */
  calibrationEvidenceFingerprint: string;
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
  /**
   * Audit metadata: how many rows were known after fitAsOf and were not inspected. It is not part of any identity, because the fit must not depend on
   * information that was unknown at fitAsOf. The verifier checks only its shape: the excluded rows are not retained, so their count cannot be recomputed.
   */
  excludedFutureSampleCount: number;
  status: PitCalibrationStatus;
  bins: HistogramCalibrationBin[];
  fitEvidence: CalibrationFitEvidence[];
  /** The evidence identities of the fit rows (model, target and evidenceFingerprint), in observationId order. */
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
  /** Covered over eligible. Null when no row is eligible: an empty evaluation has no coverage, and zero would invent one. */
  coverageRate: number | null;
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

const HEX64 = /^[0-9a-f]{64}$/;
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f]/;
const MAX_BINS = 100;
const compareCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function fail(code: PitConfidenceCalibrationError['code'], message: string): never {
  throw new PitConfidenceCalibrationError(code, message);
}

function canonicalMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

function validateModelKey(key: unknown, code: 'INVALID_MODEL' | 'INVALID_CALIBRATION_MODEL' = 'INVALID_MODEL'): asserts key is ModelKey {
  if (
    typeof key !== 'string' ||
    key.trim() !== key ||
    CONTROL_OR_SPACE.test(key) ||
    key.split('/').length !== 2 ||
    key.startsWith('/') ||
    key.endsWith('/')
  ) {
    fail(code, 'modelKey must be provider/model');
  }
}

function validateTarget(targetId: unknown, targetVersion: unknown, code: 'INVALID_TARGET' | 'INVALID_CALIBRATION_MODEL' = 'INVALID_TARGET'): void {
  if (typeof targetId !== 'string' || targetId.trim() === '' || targetId !== targetId.trim()) fail(code, 'targetId must be a non-empty trimmed string');
  if (typeof targetVersion !== 'string' || targetVersion.trim() === '' || targetVersion !== targetVersion.trim()) fail(code, 'targetVersion must be a non-empty trimmed string');
}

function normalizedPolicy(raw: HistogramCalibrationPolicy, code: 'INVALID_POLICY' | 'INVALID_CALIBRATION_MODEL' = 'INVALID_POLICY'): HistogramCalibrationPolicy {
  if (!raw || !Array.isArray(raw.binEdges)) fail(code, 'binEdges are required');
  if (raw.binEdges.length < 3 || raw.binEdges.length > MAX_BINS + 1) {
    fail(code, 'binEdges must define between 2 and ' + MAX_BINS + ' bins');
  }
  const binEdges = [...raw.binEdges];
  if (binEdges[0] !== 0 || binEdges.at(-1) !== 1) fail(code, 'binEdges must start at 0 and end at 1');
  for (let i = 0; i < binEdges.length; i++) {
    if (!Number.isFinite(binEdges[i])) fail(code, 'binEdges must be finite');
    if (i > 0 && !(binEdges[i]! > binEdges[i - 1]!)) fail(code, 'binEdges must be strictly increasing');
  }
  if (!Number.isSafeInteger(raw.minimumFitSamples) || raw.minimumFitSamples <= 0) fail(code, 'minimumFitSamples must be a positive integer');
  if (!Number.isSafeInteger(raw.minimumSamplesPerBin) || raw.minimumSamplesPerBin <= 0) fail(code, 'minimumSamplesPerBin must be a positive integer');
  return {
    binEdges,
    minimumFitSamples: raw.minimumFitSamples,
    minimumSamplesPerBin: raw.minimumSamplesPerBin,
  };
}

/** The content of a row without its observationId: two rows with the same content have the same values. */
function calibrationEvidenceFingerprintOf(
  modelKey: ModelKey,
  targetId: string,
  targetVersion: string,
  observation: Pick<CalibrationObservation, 'asOf' | 'knownAt' | 'confidenceScore' | 'outcomeLabel' | 'evidenceFingerprint'>,
): string {
  return hashOf({
    modelKey,
    targetId,
    targetVersion,
    asOf: observation.asOf,
    knownAt: observation.knownAt,
    confidenceScore: observation.confidenceScore,
    outcomeLabel: observation.outcomeLabel,
    evidenceFingerprint: observation.evidenceFingerprint,
  });
}

/**
 * The identity of the underlying evidence: the caller's evidenceFingerprint, scoped to one model and target. A repeated identity is one piece of
 * evidence, whatever its observationId or knownAt, so it can neither inflate a sample nor be evaluated after it was fitted.
 */
function evidenceIdentityOf(modelKey: ModelKey, targetId: string, targetVersion: string, evidenceFingerprint: string): string {
  return hashOf({ kind: 'calibration-evidence-identity', modelKey, targetId, targetVersion, evidenceFingerprint });
}

interface ValidatedObservation extends CalibrationObservation {
  calibrationEvidenceFingerprint: string;
  evidenceIdentity: string;
}

/**
 * Splits the rows into those known at the cutoff and those known after it. A later row contributes only to the excluded count. Rows that cannot be
 * identified or placed in time are refused whatever their time, because they cannot be classified at all.
 */
function partitionObservations(
  raw: readonly CalibrationObservation[],
  modelKey: ModelKey,
  targetId: string,
  targetVersion: string,
  cutoffMs: number,
): { eligible: ValidatedObservation[]; excludedFutureSampleCount: number } {
  if (!Array.isArray(raw) || raw.length === 0) fail('INVALID_OBSERVATIONS', 'at least one observation is required');
  const knownRows: CalibrationObservation[] = [];
  let excludedFutureSampleCount = 0;
  for (const one of raw) {
    if (!one || typeof one !== 'object') fail('INVALID_OBSERVATIONS', 'every observation must be an object');
    if (typeof one.observationId !== 'string' || one.observationId.trim() === '' || one.observationId !== one.observationId.trim()) {
      fail('INVALID_OBSERVATIONS', 'observationId must be a non-empty trimmed string');
    }
    if (one.modelKey !== modelKey) fail('INVALID_OBSERVATIONS', one.observationId + ' belongs to another model');
    const knownAtMs = canonicalMs(one.knownAt);
    if (knownAtMs === null) fail('INVALID_TIME', one.observationId + ' knownAt must be a canonical UTC instant');
    if (knownAtMs > cutoffMs) {
      excludedFutureSampleCount += 1;
      continue;
    }
    knownRows.push(one);
  }

  const ids = new Set<string>();
  const identities = new Map<string, string>();
  const out: ValidatedObservation[] = [];
  for (const one of knownRows) {
    if (ids.has(one.observationId)) fail('INVALID_OBSERVATIONS', 'duplicate observationId ' + one.observationId);
    ids.add(one.observationId);
    const asOfMs = canonicalMs(one.asOf);
    if (asOfMs === null) fail('INVALID_TIME', one.observationId + ' asOf must be a canonical UTC instant');
    if (canonicalMs(one.knownAt)! < asOfMs) fail('INVALID_TIME', one.observationId + ' knownAt precedes asOf');
    if (!Number.isFinite(one.confidenceScore) || one.confidenceScore < 0 || one.confidenceScore > 1) {
      fail('INVALID_OBSERVATIONS', one.observationId + ' confidenceScore must be within 0..1');
    }
    if (one.outcomeLabel !== 0 && one.outcomeLabel !== 1) fail('INVALID_OBSERVATIONS', one.observationId + ' outcomeLabel must be binary 0 or 1');
    if (typeof one.evidenceFingerprint !== 'string' || !HEX64.test(one.evidenceFingerprint)) {
      fail('INVALID_OBSERVATIONS', one.observationId + ' evidenceFingerprint must be a lowercase 64-character hex hash');
    }
    const identity = evidenceIdentityOf(modelKey, targetId, targetVersion, one.evidenceFingerprint);
    const prior = identities.get(identity);
    if (prior !== undefined) fail('INVALID_OBSERVATIONS', 'observations ' + prior + ' and ' + one.observationId + ' carry the same evidence');
    identities.set(identity, one.observationId);
    out.push({
      ...one,
      calibrationEvidenceFingerprint: calibrationEvidenceFingerprintOf(modelKey, targetId, targetVersion, one),
      evidenceIdentity: identity,
    });
  }
  return { eligible: out.sort((a, b) => compareCodeUnit(a.observationId, b.observationId)), excludedFutureSampleCount };
}

function binIndexOf(edges: readonly number[], confidence: number): number {
  if (confidence === 1) return edges.length - 2;
  for (let i = 0; i < edges.length - 1; i++) {
    if (confidence >= edges[i]! && confidence < edges[i + 1]!) return i;
  }
  fail('INVALID_OBSERVATIONS', 'confidenceScore does not fall into a configured bin');
}

/** Bin statistics. A probability exists only for a FITTED model and a bin that meets minimumSamplesPerBin; otherwise it is null. */
function binsOf(
  policy: HistogramCalibrationPolicy,
  evidence: readonly Pick<CalibrationFitEvidence, 'confidenceScore' | 'outcomeLabel'>[],
  status: PitCalibrationStatus,
): HistogramCalibrationBin[] {
  const bins: HistogramCalibrationBin[] = [];
  for (let i = 0; i < policy.binEdges.length - 1; i++) {
    bins.push({
      index: i,
      lower: policy.binEdges[i]!,
      upper: policy.binEdges[i + 1]!,
      sampleSize: 0,
      positives: 0,
      probability: null,
    });
  }
  for (const one of evidence) {
    const bin = bins[binIndexOf(policy.binEdges, one.confidenceScore)]!;
    bin.sampleSize += 1;
    bin.positives += one.outcomeLabel;
  }
  for (const bin of bins) {
    const publishable = status === 'FITTED' && bin.sampleSize > 0 && bin.sampleSize >= policy.minimumSamplesPerBin;
    bin.probability = publishable ? bin.positives / bin.sampleSize : null;
  }
  return bins;
}

function inputFingerprintOf(
  modelKey: ModelKey,
  targetId: string,
  targetVersion: string,
  fitAsOf: string,
  policy: HistogramCalibrationPolicy,
  fitEvidenceFingerprints: readonly string[],
  fitContentFingerprints: readonly string[],
): string {
  return hashOf({
    engine: PIT_CONFIDENCE_CALIBRATION_VERSION,
    method: 'histogram_binning',
    modelKey,
    targetId,
    targetVersion,
    fitAsOf,
    policy,
    fitEvidenceFingerprints,
    fitContentFingerprints,
  });
}

function modelFingerprintOf(model: Omit<PitConfidenceCalibrationModel, 'modelFingerprint' | 'calibrationRunId'>): string {
  return hashOf({
    engineVersion: model.engineVersion,
    inputFingerprint: model.inputFingerprint,
    modelKey: model.modelKey,
    targetId: model.targetId,
    targetVersion: model.targetVersion,
    method: model.method,
    fitAsOf: model.fitAsOf,
    policy: model.policy,
    eligibleSampleSize: model.eligibleSampleSize,
    status: model.status,
    bins: model.bins,
    fitEvidence: model.fitEvidence,
    fitEvidenceFingerprints: model.fitEvidenceFingerprints,
  });
}

export function fitPitConfidenceCalibration(
  request: PitCalibrationRequest,
): PitConfidenceCalibrationModel {
  validateModelKey(request.modelKey);
  validateTarget(request.targetId, request.targetVersion);
  const fitAsOfMs = canonicalMs(request.fitAsOf);
  if (fitAsOfMs === null) fail('INVALID_TIME', 'fitAsOf must be a canonical UTC instant');
  const policy = normalizedPolicy(request.policy);
  const { eligible, excludedFutureSampleCount } = partitionObservations(
    request.observations,
    request.modelKey,
    request.targetId,
    request.targetVersion,
    fitAsOfMs,
  );

  const fitEvidence: CalibrationFitEvidence[] = eligible.map((one) => ({
    observationId: one.observationId,
    asOf: one.asOf,
    knownAt: one.knownAt,
    confidenceScore: one.confidenceScore,
    outcomeLabel: one.outcomeLabel,
    evidenceFingerprint: one.evidenceFingerprint,
    calibrationEvidenceFingerprint: one.calibrationEvidenceFingerprint,
  }));
  const fitEvidenceFingerprints = eligible.map((one) => one.evidenceIdentity);
  const fitContentFingerprints = fitEvidence.map((one) => one.calibrationEvidenceFingerprint);
  const status: PitCalibrationStatus =
    fitEvidence.length >= policy.minimumFitSamples ? 'FITTED' : 'INSUFFICIENT_SAMPLES';
  const bins = binsOf(policy, fitEvidence, status);
  const inputFingerprint = inputFingerprintOf(
    request.modelKey,
    request.targetId,
    request.targetVersion,
    request.fitAsOf,
    policy,
    fitEvidenceFingerprints,
    fitContentFingerprints,
  );
  const partial: Omit<PitConfidenceCalibrationModel, 'modelFingerprint' | 'calibrationRunId'> = {
    engineVersion: PIT_CONFIDENCE_CALIBRATION_VERSION,
    inputFingerprint,
    modelKey: request.modelKey,
    targetId: request.targetId,
    targetVersion: request.targetVersion,
    method: 'histogram_binning',
    fitAsOf: request.fitAsOf,
    policy,
    eligibleSampleSize: fitEvidence.length,
    excludedFutureSampleCount,
    status,
    bins,
    fitEvidence,
    fitEvidenceFingerprints,
  };
  const modelFingerprint = modelFingerprintOf(partial);
  const result: PitConfidenceCalibrationModel = {
    calibrationRunId: 'pcc_' + inputFingerprint.slice(0, 40),
    ...partial,
    modelFingerprint,
  };
  verifyPitConfidenceCalibrationModel(result);
  return result;
}

/**
 * Recomputes the model from its own fit evidence. A model that passes is internally consistent: every bin, status, identity and fingerprint follows from
 * its evidence. A forger who re-issues every hash still produces a consistent model, so the verifier proves consistency, not provenance (see the design
 * doc). excludedFutureSampleCount is audit metadata and is checked for shape only.
 */
export function verifyPitConfidenceCalibrationModel(
  model: PitConfidenceCalibrationModel,
): void {
  const bad = (message: string): never => fail('INVALID_CALIBRATION_MODEL', message);
  if (!model || typeof model !== 'object') bad('calibration model is missing');
  if (model.engineVersion !== PIT_CONFIDENCE_CALIBRATION_VERSION) bad('engineVersion is invalid');
  if (typeof model.inputFingerprint !== 'string' || !HEX64.test(model.inputFingerprint)) bad('inputFingerprint is invalid');
  if (typeof model.modelFingerprint !== 'string' || !HEX64.test(model.modelFingerprint)) bad('modelFingerprint is invalid');
  if (model.calibrationRunId !== 'pcc_' + model.inputFingerprint.slice(0, 40)) bad('calibrationRunId does not derive from inputFingerprint');
  try {
    validateModelKey(model.modelKey, 'INVALID_CALIBRATION_MODEL');
    validateTarget(model.targetId, model.targetVersion, 'INVALID_CALIBRATION_MODEL');
  } catch (error) {
    bad((error as Error).message);
  }
  if (model.method !== 'histogram_binning') bad('method is not histogram_binning');
  const fitAsOfMs = canonicalMs(model.fitAsOf);
  if (fitAsOfMs === null) bad('fitAsOf is not canonical UTC');
  const policy = (() => {
    try {
      return normalizedPolicy(model.policy, 'INVALID_CALIBRATION_MODEL');
    } catch (error) {
      return bad((error as Error).message);
    }
  })();
  if (!Number.isSafeInteger(model.excludedFutureSampleCount) || model.excludedFutureSampleCount < 0) bad('excludedFutureSampleCount is invalid');
  if (!Array.isArray(model.fitEvidence) || !Array.isArray(model.fitEvidenceFingerprints)) bad('fit evidence is missing');

  const ids = new Set<string>();
  const identities = new Set<string>();
  let previousId: string | null = null;
  const evidence: CalibrationFitEvidence[] = [];
  const expectedIdentities: string[] = [];
  const expectedContentFingerprints: string[] = [];
  for (const one of model.fitEvidence) {
    if (!one || typeof one.observationId !== 'string' || one.observationId.trim() === '') bad('fit evidence observationId is invalid');
    if (previousId !== null && compareCodeUnit(one.observationId, previousId) <= 0) bad('fit evidence is not in canonical observationId order');
    previousId = one.observationId;
    if (ids.has(one.observationId)) bad('duplicate fit evidence observationId');
    ids.add(one.observationId);
    const asOfMs = canonicalMs(one.asOf);
    const knownAtMs = canonicalMs(one.knownAt);
    if (asOfMs === null || knownAtMs === null || knownAtMs < asOfMs || knownAtMs > fitAsOfMs!) bad(one.observationId + ' fit evidence time is invalid');
    if (!Number.isFinite(one.confidenceScore) || one.confidenceScore < 0 || one.confidenceScore > 1) bad(one.observationId + ' confidenceScore is invalid');
    if (one.outcomeLabel !== 0 && one.outcomeLabel !== 1) bad(one.observationId + ' outcomeLabel is invalid');
    if (typeof one.evidenceFingerprint !== 'string' || !HEX64.test(one.evidenceFingerprint)) bad(one.observationId + ' evidenceFingerprint is invalid');
    const contentFingerprint = calibrationEvidenceFingerprintOf(model.modelKey, model.targetId, model.targetVersion, {
      asOf: one.asOf,
      knownAt: one.knownAt,
      confidenceScore: one.confidenceScore,
      outcomeLabel: one.outcomeLabel,
      evidenceFingerprint: one.evidenceFingerprint,
    });
    if (one.calibrationEvidenceFingerprint !== contentFingerprint) bad(one.observationId + ' calibrationEvidenceFingerprint does not bind the evidence');
    const identity = evidenceIdentityOf(model.modelKey, model.targetId, model.targetVersion, one.evidenceFingerprint);
    if (identities.has(identity)) bad('duplicate fit evidence: the same evidence appears twice');
    identities.add(identity);
    expectedIdentities.push(identity);
    expectedContentFingerprints.push(contentFingerprint);
    evidence.push(one);
  }

  if (hashOf(model.fitEvidenceFingerprints) !== hashOf(expectedIdentities)) bad('fitEvidenceFingerprints do not match fit evidence');
  if (model.eligibleSampleSize !== evidence.length) bad('eligibleSampleSize does not match fit evidence');
  const expectedStatus: PitCalibrationStatus = evidence.length >= policy.minimumFitSamples ? 'FITTED' : 'INSUFFICIENT_SAMPLES';
  if (model.status !== expectedStatus) bad('status does not match eligible sample size');

  const bins = binsOf(policy, evidence, expectedStatus);
  if (hashOf(model.bins) !== hashOf(bins)) bad('bin statistics do not match fit evidence');
  const inputFingerprint = inputFingerprintOf(
    model.modelKey,
    model.targetId,
    model.targetVersion,
    model.fitAsOf,
    policy,
    expectedIdentities,
    expectedContentFingerprints,
  );
  if (model.inputFingerprint !== inputFingerprint) bad('inputFingerprint does not match calibration inputs');

  const partial: Omit<PitConfidenceCalibrationModel, 'modelFingerprint' | 'calibrationRunId'> = {
    engineVersion: model.engineVersion,
    inputFingerprint: model.inputFingerprint,
    modelKey: model.modelKey,
    targetId: model.targetId,
    targetVersion: model.targetVersion,
    method: model.method,
    fitAsOf: model.fitAsOf,
    policy,
    eligibleSampleSize: model.eligibleSampleSize,
    excludedFutureSampleCount: model.excludedFutureSampleCount,
    status: model.status,
    bins: model.bins,
    fitEvidence: model.fitEvidence,
    fitEvidenceFingerprints: model.fitEvidenceFingerprints,
  };
  if (model.modelFingerprint !== modelFingerprintOf(partial)) bad('modelFingerprint does not match calibration model contents');
}

export function applyFittedCalibration(
  model: PitConfidenceCalibrationModel,
  modelKey: ModelKey,
  confidenceScore: number,
): AppliedPitCalibration {
  verifyPitConfidenceCalibrationModel(model);
  validateModelKey(modelKey);
  if (modelKey !== model.modelKey) fail('MODEL_MISMATCH', 'calibration model belongs to ' + model.modelKey + ', not ' + modelKey);
  if (!Number.isFinite(confidenceScore) || confidenceScore < 0 || confidenceScore > 1) {
    fail('INVALID_OBSERVATIONS', 'confidenceScore must be within 0..1');
  }
  if (model.status !== 'FITTED') {
    return {
      modelKey,
      confidenceScore,
      calibratedProbability: null,
      calibrationMethod: null,
      binIndex: null,
      binSampleSize: null,
      reason: 'MODEL_NOT_FITTED',
    };
  }
  const index = binIndexOf(model.policy.binEdges, confidenceScore);
  const bin = model.bins[index]!;
  if (bin.sampleSize === 0) {
    return {
      modelKey,
      confidenceScore,
      calibratedProbability: null,
      calibrationMethod: null,
      binIndex: index,
      binSampleSize: bin.sampleSize,
      reason: 'EMPTY_BIN',
    };
  }
  if (bin.sampleSize < model.policy.minimumSamplesPerBin) {
    return {
      modelKey,
      confidenceScore,
      calibratedProbability: null,
      calibrationMethod: null,
      binIndex: index,
      binSampleSize: bin.sampleSize,
      reason: 'INSUFFICIENT_BIN_SAMPLES',
    };
  }
  if (bin.probability === null) fail('INVALID_CALIBRATION_MODEL', 'a populated bin of a fitted model carries no probability');
  return {
    modelKey,
    confidenceScore,
    calibratedProbability: bin.probability,
    calibrationMethod: 'histogram_binning@' + model.modelFingerprint,
    binIndex: index,
    binSampleSize: bin.sampleSize,
    reason: 'CALIBRATED',
  };
}

export function evaluatePitConfidenceCalibration(
  request: CalibrationEvaluationRequest,
): CalibrationEvaluationResult {
  verifyPitConfidenceCalibrationModel(request.model);
  const evaluationAsOfMs = canonicalMs(request.asOf);
  if (evaluationAsOfMs === null) fail('INVALID_TIME', 'evaluation asOf must be a canonical UTC instant');
  if (evaluationAsOfMs < canonicalMs(request.model.fitAsOf)!) {
    fail('INVALID_TIME', 'evaluation asOf precedes the model fitAsOf: the model did not exist yet');
  }

  const { eligible, excludedFutureSampleCount } = partitionObservations(
    request.observations,
    request.model.modelKey,
    request.model.targetId,
    request.model.targetVersion,
    evaluationAsOfMs,
  );
  const fitIdentities = new Set(request.model.fitEvidenceFingerprints);
  for (const one of eligible) {
    if (fitIdentities.has(one.evidenceIdentity)) {
      fail('FIT_EVIDENCE_REUSE', one.observationId + ' reuses evidence that fitted this calibration model');
    }
  }

  const covered: Array<{ probability: number; label: CalibrationOutcomeLabel; binIndex: number }> = [];
  let uncoveredSampleCount = 0;
  for (const one of eligible) {
    const applied = applyFittedCalibration(request.model, request.model.modelKey, one.confidenceScore);
    if (applied.calibratedProbability === null || applied.binIndex === null) {
      uncoveredSampleCount += 1;
      continue;
    }
    covered.push({
      probability: applied.calibratedProbability,
      label: one.outcomeLabel,
      binIndex: applied.binIndex,
    });
  }

  const coveredSampleSize = covered.length;
  const eligibleSampleSize = eligible.length;
  const coverageRate = eligibleSampleSize === 0 ? null : coveredSampleSize / eligibleSampleSize;
  const brierScore =
    coveredSampleSize === 0
      ? null
      : covered.reduce((sum, one) => sum + (one.probability - one.label) ** 2, 0) / coveredSampleSize;
  const meanPredictedProbability =
    coveredSampleSize === 0
      ? null
      : covered.reduce((sum, one) => sum + one.probability, 0) / coveredSampleSize;
  const observedPositiveRate =
    coveredSampleSize === 0
      ? null
      : covered.reduce((sum, one) => sum + one.label, 0) / coveredSampleSize;

  const bins: CalibrationEvaluationBin[] = [];
  for (let index = 0; index < request.model.bins.length; index++) {
    const rows = covered.filter((one) => one.binIndex === index);
    if (rows.length === 0) continue;
    bins.push({
      index,
      sampleSize: rows.length,
      meanPredictedProbability: rows.reduce((sum, one) => sum + one.probability, 0) / rows.length,
      observedPositiveRate: rows.reduce((sum, one) => sum + one.label, 0) / rows.length,
    });
  }

  const finiteMetrics = [
    ...(coverageRate === null ? [] : [coverageRate]),
    ...(brierScore === null ? [] : [brierScore]),
    ...(meanPredictedProbability === null ? [] : [meanPredictedProbability]),
    ...(observedPositiveRate === null ? [] : [observedPositiveRate]),
    ...bins.flatMap((bin) => [bin.meanPredictedProbability, bin.observedPositiveRate]),
  ];
  if (!finiteMetrics.every(Number.isFinite)) fail('INVALID_CALIBRATION_MODEL', 'evaluation produced a non-finite metric');

  return {
    modelFingerprint: request.model.modelFingerprint,
    asOf: request.asOf,
    eligibleSampleSize,
    coveredSampleSize,
    excludedFutureSampleCount,
    uncoveredSampleCount,
    coverageRate,
    brierScore,
    meanPredictedProbability,
    observedPositiveRate,
    bins,
  };
}

/** Recomputes an evaluation from its request and refuses a stored result that does not match it. Evaluation is pure, so the recomputation is exact. */
export function verifyPitCalibrationEvaluation(
  request: CalibrationEvaluationRequest,
  result: CalibrationEvaluationResult,
): void {
  const recomputed = evaluatePitConfidenceCalibration(request);
  if (hashOf(recomputed) !== hashOf(result)) {
    fail('INVALID_CALIBRATION_MODEL', 'evaluation result does not match its request (it was altered or belongs to another request)');
  }
}
