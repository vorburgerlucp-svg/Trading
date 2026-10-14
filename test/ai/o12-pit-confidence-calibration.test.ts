import { describe, expect, it } from 'vitest';
import { calibrate, type CalibrationModel } from '../../src/ai/calibration.js';
import {
  PIT_CONFIDENCE_CALIBRATION_VERSION,
  PitConfidenceCalibrationError,
  applyFittedCalibration,
  evaluatePitConfidenceCalibration,
  fitPitConfidenceCalibration,
  verifyPitConfidenceCalibrationModel,
  type CalibrationObservation,
  type HistogramCalibrationPolicy,
  type PitCalibrationRequest,
} from '../../src/ai/pit-confidence-calibration.js';
import { modelKey } from '../../src/ai/model-types.js';
import { hashOf } from '../../src/persistence/canonical-json.js';

const MODEL = modelKey('openai', 'shadow-calibrator');
const OTHER_MODEL = modelKey('google', 'other');
const TARGET_ID = 'recommendation_direction_correct';
const TARGET_VERSION = 'v1';
const FIT_AS_OF = '2026-02-01T00:00:00.000Z';

const policy: HistogramCalibrationPolicy = {
  binEdges: [0, 0.5, 1],
  minimumFitSamples: 2,
  minimumSamplesPerBin: 1,
};

function evidenceFingerprint(seed: string): string {
  return hashOf({ source: 'fixture', seed });
}

function observation(
  id: string,
  confidenceScore: number,
  outcomeLabel: 0 | 1,
  overrides: Partial<CalibrationObservation> = {},
): CalibrationObservation {
  return {
    observationId: id,
    modelKey: MODEL,
    asOf: '2026-01-01T12:00:00.000Z',
    knownAt: '2026-01-02T12:00:00.000Z',
    confidenceScore,
    outcomeLabel,
    evidenceFingerprint: evidenceFingerprint(id),
    ...overrides,
  };
}

function request(overrides: Partial<PitCalibrationRequest> = {}): PitCalibrationRequest {
  return {
    modelKey: MODEL,
    targetId: TARGET_ID,
    targetVersion: TARGET_VERSION,
    fitAsOf: FIT_AS_OF,
    observations: [
      observation('a', 0.1, 0),
      observation('b', 0.4, 1),
      observation('c', 0.6, 1),
      observation('d', 0.9, 1),
    ],
    policy,
    ...overrides,
  };
}

describe('O12 point-in-time confidence calibration — RED', () => {
  it('has an explicit engine identity', () => {
    expect(PIT_CONFIDENCE_CALIBRATION_VERSION).toBe('pit-confidence-calibration:v1');
  });

  it('fits only observations whose outcomes are known at fitAsOf', () => {
    const result = fitPitConfidenceCalibration(
      request({
        observations: [
          observation('a', 0.1, 0),
          observation('b', 0.9, 1),
          observation('future', 0.9, 0, { knownAt: '2026-03-01T00:00:00.000Z' }),
        ],
      }),
    );

    expect(result.status).toBe('FITTED');
    expect(result.eligibleSampleSize).toBe(2);
    expect(result.excludedFutureSampleCount).toBe(1);
    expect(result.bins.map((b) => [b.sampleSize, b.positives, b.probability])).toEqual([
      [1, 0, 0],
      [1, 1, 1],
    ]);
  });

  it('changing only a future-known outcome does not change fit identity', () => {
    const future = observation('future', 0.9, 0, { knownAt: '2026-03-01T00:00:00.000Z' });
    const a = fitPitConfidenceCalibration(request({ observations: [observation('a', 0.1, 0), observation('b', 0.9, 1), future] }));
    const changed = { ...future, outcomeLabel: 1 as const, evidenceFingerprint: evidenceFingerprint('future-changed') };
    const b = fitPitConfidenceCalibration(request({ observations: [observation('a', 0.1, 0), observation('b', 0.9, 1), changed] }));

    expect(b.inputFingerprint).toBe(a.inputFingerprint);
    expect(b.modelFingerprint).toBe(a.modelFingerprint);
    expect(b.calibrationRunId).toBe(a.calibrationRunId);
  });

  it('normalizes eligible observation input order without changing identity', () => {
    const source = request().observations;
    const a = fitPitConfidenceCalibration(request({ observations: source }));
    const b = fitPitConfidenceCalibration(request({ observations: [...source].reverse() }));

    expect(b).toEqual(a);
  });

  it('rejects duplicate observation ids and duplicate evidence under another id', () => {
    const same = observation('same', 0.3, 1);
    expect(() => fitPitConfidenceCalibration(request({ observations: [same, { ...same }] }))).toThrow(PitConfidenceCalibrationError);

    const first = observation('first', 0.3, 1);
    const duplicate = { ...first, observationId: 'second' };
    expect(() => fitPitConfidenceCalibration(request({ observations: [first, duplicate] }))).toThrow(PitConfidenceCalibrationError);
  });

  it('rejects malformed times and look-ahead where knownAt precedes asOf', () => {
    expect(() => fitPitConfidenceCalibration(request({ fitAsOf: '2026-02-01' }))).toThrow(PitConfidenceCalibrationError);

    const nonCanonical = observation('x', 0.5, 1, { knownAt: 'Jan 2 2026' });
    expect(() => fitPitConfidenceCalibration(request({ observations: [nonCanonical] }))).toThrow(PitConfidenceCalibrationError);

    const backwards = observation('x', 0.5, 1, {
      asOf: '2026-01-03T00:00:00.000Z',
      knownAt: '2026-01-02T00:00:00.000Z',
    });
    expect(() => fitPitConfidenceCalibration(request({ observations: [backwards] }))).toThrow(PitConfidenceCalibrationError);
  });

  it('rejects confidence outside 0..1, non-binary labels and malformed evidence fingerprints', () => {
    expect(() => fitPitConfidenceCalibration(request({ observations: [observation('x', 1.01, 1)] }))).toThrow(PitConfidenceCalibrationError);
    expect(() =>
      fitPitConfidenceCalibration(
        request({ observations: [{ ...observation('x', 0.5, 1), outcomeLabel: 0.5 as never }] }),
      ),
    ).toThrow(PitConfidenceCalibrationError);
    expect(() =>
      fitPitConfidenceCalibration(
        request({ observations: [{ ...observation('x', 0.5, 1), evidenceFingerprint: 'short' }] }),
      ),
    ).toThrow(PitConfidenceCalibrationError);
  });

  it('rejects invalid bin edges and invalid sample thresholds', () => {
    const badPolicies: HistogramCalibrationPolicy[] = [
      { ...policy, binEdges: [0.1, 0.5, 1] },
      { ...policy, binEdges: [0, 0.5, 0.5, 1] },
      { ...policy, binEdges: [0, 0.5, 0.9] },
      { ...policy, binEdges: [0, 1] },
      { ...policy, minimumFitSamples: 0 },
      { ...policy, minimumSamplesPerBin: 1.5 },
    ];
    for (const bad of badPolicies) {
      expect(() => fitPitConfidenceCalibration(request({ policy: bad }))).toThrow(PitConfidenceCalibrationError);
    }
  });

  it('returns INSUFFICIENT_SAMPLES instead of fabricating a fitted model', () => {
    const result = fitPitConfidenceCalibration(
      request({
        observations: [observation('one', 0.8, 1)],
        policy: { ...policy, minimumFitSamples: 2 },
      }),
    );

    expect(result.status).toBe('INSUFFICIENT_SAMPLES');
    expect(result.eligibleSampleSize).toBe(1);
    expect(applyFittedCalibration(result, MODEL, 0.8)).toMatchObject({
      calibratedProbability: null,
      reason: 'MODEL_NOT_FITTED',
    });
  });

  it('pins exact histogram boundary semantics: 0.5 belongs to the upper bin', () => {
    const result = fitPitConfidenceCalibration(
      request({
        observations: [
          observation('low', 0.499999, 0),
          observation('boundary', 0.5, 1),
        ],
      }),
    );

    expect(result.bins.map((b) => [b.sampleSize, b.positives])).toEqual([
      [1, 0],
      [1, 1],
    ]);
    expect(applyFittedCalibration(result, MODEL, 0.5)).toMatchObject({
      binIndex: 1,
      calibratedProbability: 1,
      reason: 'CALIBRATED',
    });
    expect(applyFittedCalibration(result, MODEL, 1)).toMatchObject({
      binIndex: 1,
      calibratedProbability: 1,
    });
  });

  it('returns null for an empty bin and an under-sampled populated bin', () => {
    const empty = fitPitConfidenceCalibration(
      request({
        observations: [observation('a', 0.1, 0), observation('b', 0.2, 1)],
      }),
    );
    expect(applyFittedCalibration(empty, MODEL, 0.8)).toMatchObject({
      calibratedProbability: null,
      reason: 'EMPTY_BIN',
      binIndex: 1,
      binSampleSize: 0,
    });

    const undersampled = fitPitConfidenceCalibration(
      request({
        observations: [
          observation('a', 0.1, 0),
          observation('b', 0.2, 1),
          observation('c', 0.8, 1),
        ],
        policy: { ...policy, minimumFitSamples: 2, minimumSamplesPerBin: 2 },
      }),
    );
    expect(applyFittedCalibration(undersampled, MODEL, 0.8)).toMatchObject({
      calibratedProbability: null,
      reason: 'INSUFFICIENT_BIN_SAMPLES',
      binIndex: 1,
      binSampleSize: 1,
    });
  });

  it('returns empirical bin probability for a sufficiently populated bin', () => {
    const result = fitPitConfidenceCalibration(
      request({
        observations: [
          observation('a', 0.6, 1),
          observation('b', 0.7, 0),
          observation('c', 0.8, 1),
          observation('d', 0.9, 1),
        ],
        policy: { ...policy, minimumFitSamples: 4, minimumSamplesPerBin: 2 },
      }),
    );
    expect(applyFittedCalibration(result, MODEL, 0.75)).toMatchObject({
      calibratedProbability: 0.75,
      binIndex: 1,
      binSampleSize: 4,
      reason: 'CALIBRATED',
    });
  });

  it('produces a serializable artifact and its verifier rejects tampering', () => {
    const result = fitPitConfidenceCalibration(request());
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(() => verifyPitConfidenceCalibrationModel(result)).not.toThrow();

    const countTamper = structuredClone(result);
    countTamper.bins[0]!.sampleSize += 1;
    expect(() => verifyPitConfidenceCalibrationModel(countTamper)).toThrow(PitConfidenceCalibrationError);

    const probabilityTamper = structuredClone(result);
    probabilityTamper.bins[0]!.probability = 0.123;
    expect(() => verifyPitConfidenceCalibrationModel(probabilityTamper)).toThrow(PitConfidenceCalibrationError);

    const fingerprintTamper = { ...result, modelFingerprint: 'b'.repeat(64) };
    expect(() => verifyPitConfidenceCalibrationModel(fingerprintTamper)).toThrow(PitConfidenceCalibrationError);

    const runIdTamper = { ...result, calibrationRunId: 'pcc_' + 'c'.repeat(40) };
    expect(() => verifyPitConfidenceCalibrationModel(runIdTamper)).toThrow(PitConfidenceCalibrationError);
  });

  it('refuses application to another model and invalid confidence', () => {
    const result = fitPitConfidenceCalibration(request());
    expect(() => applyFittedCalibration(result, OTHER_MODEL, 0.5)).toThrow(PitConfidenceCalibrationError);
    expect(() => applyFittedCalibration(result, MODEL, Number.NaN)).toThrow(PitConfidenceCalibrationError);
  });

  it('refuses evaluation evidence reused from fit even under another observation id', () => {
    const fit = fitPitConfidenceCalibration(request());
    const reused = { ...request().observations[0]!, observationId: 'renamed-fit-evidence' };

    expect(() =>
      evaluatePitConfidenceCalibration({
        model: fit,
        asOf: '2026-03-01T00:00:00.000Z',
        observations: [reused],
      }),
    ).toThrow(PitConfidenceCalibrationError);
  });

  it('evaluation ignores future-known outcomes and computes Brier only over covered observations', () => {
    const fit = fitPitConfidenceCalibration(
      request({
        observations: [
          observation('fit-a', 0.1, 0),
          observation('fit-b', 0.2, 1),
          observation('fit-c', 0.7, 1),
          observation('fit-d', 0.8, 1),
        ],
      }),
    );

    const evaluation = evaluatePitConfidenceCalibration({
      model: fit,
      asOf: '2026-04-01T00:00:00.000Z',
      observations: [
        observation('eval-low', 0.2, 0, {
          asOf: '2026-03-01T00:00:00.000Z',
          knownAt: '2026-03-02T00:00:00.000Z',
          evidenceFingerprint: evidenceFingerprint('eval-low'),
        }),
        observation('eval-high', 0.8, 1, {
          asOf: '2026-03-01T00:00:00.000Z',
          knownAt: '2026-03-02T00:00:00.000Z',
          evidenceFingerprint: evidenceFingerprint('eval-high'),
        }),
        observation('future', 0.8, 0, {
          asOf: '2026-03-01T00:00:00.000Z',
          knownAt: '2026-05-01T00:00:00.000Z',
          evidenceFingerprint: evidenceFingerprint('eval-future'),
        }),
      ],
    });

    // fit low-bin probability = 1/2; high-bin = 1
    // covered Brier = ((0.5 - 0)^2 + (1 - 1)^2) / 2 = 0.125
    expect(evaluation).toMatchObject({
      eligibleSampleSize: 2,
      coveredSampleSize: 2,
      excludedFutureSampleCount: 1,
      uncoveredSampleCount: 0,
      coverageRate: 1,
      brierScore: 0.125,
      meanPredictedProbability: 0.75,
      observedPositiveRate: 0.5,
    });
  });

  it('evaluation coverage excludes empty or under-sampled bins from the Brier denominator', () => {
    const fit = fitPitConfidenceCalibration(
      request({
        observations: [
          observation('fit-a', 0.1, 0),
          observation('fit-b', 0.2, 1),
          observation('fit-c', 0.8, 1),
        ],
        policy: { ...policy, minimumFitSamples: 3, minimumSamplesPerBin: 2 },
      }),
    );

    const evaluation = evaluatePitConfidenceCalibration({
      model: fit,
      asOf: '2026-04-01T00:00:00.000Z',
      observations: [
        observation('covered', 0.2, 1, {
          asOf: '2026-03-01T00:00:00.000Z',
          knownAt: '2026-03-02T00:00:00.000Z',
          evidenceFingerprint: evidenceFingerprint('covered'),
        }),
        observation('uncovered', 0.8, 0, {
          asOf: '2026-03-01T00:00:00.000Z',
          knownAt: '2026-03-02T00:00:00.000Z',
          evidenceFingerprint: evidenceFingerprint('uncovered'),
        }),
      ],
    });

    expect(evaluation.coveredSampleSize).toBe(1);
    expect(evaluation.uncoveredSampleCount).toBe(1);
    expect(evaluation.coverageRate).toBe(0.5);
    expect(evaluation.brierScore).toBeCloseTo(0.25, 12);
  });

  it('changing one eligible outcome changes the fitted model identity', () => {
    const base = request().observations;
    const a = fitPitConfidenceCalibration(request({ observations: base }));
    const changed = base.map((o, i) => (i === 0 ? { ...o, outcomeLabel: 1 as const, evidenceFingerprint: evidenceFingerprint('changed-a') } : o));
    const b = fitPitConfidenceCalibration(request({ observations: changed }));

    expect(b.inputFingerprint).not.toBe(a.inputFingerprint);
    expect(b.modelFingerprint).not.toBe(a.modelFingerprint);
    expect(b.calibrationRunId).not.toBe(a.calibrationRunId);
  });

  it('requires an explicit binary target identity; no performance score is accepted implicitly', () => {
    expect(() => fitPitConfidenceCalibration(request({ targetId: '' }))).toThrow(PitConfidenceCalibrationError);
    const raw = observation('x', 0.8, 1) as CalibrationObservation & { score?: number };
    raw.score = 0.5;
    const fitted = fitPitConfidenceCalibration(request({ observations: [raw, observation('y', 0.2, 0)] }));
    expect(fitted.eligibleSampleSize).toBe(2);
  });

  it('preserves the existing calibrate helper semantics', () => {
    const legacy: CalibrationModel = {
      method: 'histogram_binning',
      version: 'legacy-test',
      fittedAt: FIT_AS_OF,
      sampleSize: 10,
      minSamples: 5,
      apply: (confidence) => confidence * 0.5,
    };
    expect(calibrate(0.8, legacy)).toEqual({
      confidenceScore: 0.8,
      calibratedProbability: 0.4,
      calibrationMethod: 'histogram_binning@legacy-test',
    });
    expect(calibrate(0.8, null)).toEqual({
      confidenceScore: 0.8,
      calibratedProbability: null,
      calibrationMethod: null,
    });
  });
});
