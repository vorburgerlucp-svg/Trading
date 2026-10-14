import { describe, expect, it } from 'vitest';
import { calibrate, type CalibrationModel } from '../../src/ai/calibration.js';
import {
  PIT_CONFIDENCE_CALIBRATION_VERSION,
  PitConfidenceCalibrationError,
  applyFittedCalibration,
  evaluatePitConfidenceCalibration,
  fitPitConfidenceCalibration,
  verifyPitCalibrationEvaluation,
  verifyPitConfidenceCalibrationModel,
  type CalibrationObservation,
  type HistogramCalibrationPolicy,
  type PitCalibrationRequest,
  type PitConfidenceCalibrationModel,
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

  it('rejects model keys with control characters before fitting', () => {
    expect(() => fitPitConfidenceCalibration(request({ modelKey: 'openai/model\nother' }))).toThrow(PitConfidenceCalibrationError);
  });

  it('verifier rejects target, policy, status and fit-evidence tampering', () => {
    const result = fitPitConfidenceCalibration(request());

    const target = structuredClone(result);
    target.targetVersion = 'v2';
    expect(() => verifyPitConfidenceCalibrationModel(target)).toThrow(PitConfidenceCalibrationError);

    const policyTamper = structuredClone(result);
    policyTamper.policy.minimumSamplesPerBin += 1;
    expect(() => verifyPitConfidenceCalibrationModel(policyTamper)).toThrow(PitConfidenceCalibrationError);

    const statusTamper = structuredClone(result);
    statusTamper.status = 'INSUFFICIENT_SAMPLES';
    expect(() => verifyPitConfidenceCalibrationModel(statusTamper)).toThrow(PitConfidenceCalibrationError);

    const evidenceTamper = structuredClone(result);
    evidenceTamper.fitEvidence[0]!.outcomeLabel = evidenceTamper.fitEvidence[0]!.outcomeLabel === 1 ? 0 : 1;
    expect(() => verifyPitConfidenceCalibrationModel(evidenceTamper)).toThrow(PitConfidenceCalibrationError);
  });

  it('returns null metrics with zero coverage instead of inventing evaluation quality', () => {
    const fit = fitPitConfidenceCalibration(
      request({
        observations: [
          observation('fit-a', 0.1, 0),
          observation('fit-b', 0.2, 1),
        ],
      }),
    );

    const evaluation = evaluatePitConfidenceCalibration({
      model: fit,
      asOf: '2026-04-01T00:00:00.000Z',
      observations: [
        observation('eval-empty-bin', 0.8, 1, {
          asOf: '2026-03-01T00:00:00.000Z',
          knownAt: '2026-03-02T00:00:00.000Z',
          evidenceFingerprint: evidenceFingerprint('eval-empty-bin'),
        }),
      ],
    });

    expect(evaluation).toMatchObject({
      eligibleSampleSize: 1,
      coveredSampleSize: 0,
      uncoveredSampleCount: 1,
      coverageRate: 0,
      brierScore: null,
      meanPredictedProbability: null,
      observedPositiveRate: null,
      bins: [],
    });
  });

  it('includes an observation whose outcome becomes known exactly at fitAsOf', () => {
    const result = fitPitConfidenceCalibration(
      request({
        observations: [
          observation('a', 0.2, 0),
          observation('boundary-known', 0.8, 1, { knownAt: FIT_AS_OF }),
        ],
      }),
    );
    expect(result.eligibleSampleSize).toBe(2);
    expect(result.excludedFutureSampleCount).toBe(0);
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

// ---------------------------------------------------------------------------
// Independent review probes (RED). Each probe names the review item it attacks. Guards pin behaviour that already holds.
// ---------------------------------------------------------------------------

const FUTURE = '2026-03-01T00:00:00.000Z';

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof PitConfidenceCalibrationError ? error.code : 'UNCLASSIFIED: ' + String(error);
  }
}

/** Reverses every object's key order, as a store that sorts keys (JSONB) would. The content is unchanged. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).reverse()) out[key] = reverseKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

describe('O12 review — future rows are classified by knownAt only (RED)', () => {
  it('R1 adding a future-known row with identical eligible evidence does not change the fit identity (doc §16)', () => {
    const base = fitPitConfidenceCalibration(request());
    const withFuture = fitPitConfidenceCalibration(request({ observations: [...request().observations, observation('future', 0.9, 0, { knownAt: FUTURE })] }));
    expect(withFuture.excludedFutureSampleCount).toBe(1);
    expect(withFuture.inputFingerprint).toBe(base.inputFingerprint);
    expect(withFuture.modelFingerprint).toBe(base.modelFingerprint);
    expect(withFuture.calibrationRunId).toBe(base.calibrationRunId);
  });

  it('R2 malformed future-known rows cannot refuse the fit or change it (doc §5, §16)', () => {
    const base = fitPitConfidenceCalibration(request());
    const malformed: CalibrationObservation[] = [
      observation('future-label', 0.9, 0, { knownAt: FUTURE, outcomeLabel: 2 as never }),
      observation('future-confidence', 1.5, 1, { knownAt: FUTURE }),
      observation('future-fingerprint', 0.5, 1, { knownAt: FUTURE, evidenceFingerprint: 'short' }),
      observation('future-backwards', 0.5, 1, { asOf: '2026-03-05T00:00:00.000Z', knownAt: '2026-03-02T00:00:00.000Z' }),
    ];
    for (const row of malformed) {
      const fit = fitPitConfidenceCalibration(request({ observations: [...request().observations, row] }));
      expect(fit.inputFingerprint, row.observationId).toBe(base.inputFingerprint);
      expect(fit.excludedFutureSampleCount, row.observationId).toBe(1);
    }
  });

  it('R4 a future row repeating an eligible evidence fingerprint neither inflates nor refuses the fit', () => {
    const base = fitPitConfidenceCalibration(request());
    const repeated = observation('future-copy', 0.1, 0, { knownAt: FUTURE, evidenceFingerprint: evidenceFingerprint('a') });
    const fit = fitPitConfidenceCalibration(request({ observations: [...request().observations, repeated] }));
    expect(fit.eligibleSampleSize).toBe(base.eligibleSampleSize);
    expect(fit.inputFingerprint).toBe(base.inputFingerprint);
  });

  it('R12 a future row repeating an eligible observation id does not refuse the fit', () => {
    expect(codeOf(() => fitPitConfidenceCalibration(request({ observations: [...request().observations, observation('a', 0.5, 1, { knownAt: FUTURE })] })))).toBe('NO_ERROR');
  });

  it('R13 an evaluation row known after the evaluation instant is excluded even when malformed', () => {
    const fit = fitPitConfidenceCalibration(request());
    const evaluation = evaluatePitConfidenceCalibration({
      model: fit,
      asOf: '2026-04-01T00:00:00.000Z',
      observations: [
        observation('future-eval', 0.8, 2 as never, { asOf: '2026-04-02T00:00:00.000Z', knownAt: '2026-05-01T00:00:00.000Z' }),
      ],
    });
    expect(evaluation).toMatchObject({ eligibleSampleSize: 0, excludedFutureSampleCount: 1 });
  });
});

describe('O12 review — evidence identity and reuse (RED)', () => {
  it('R6 the same evidence fingerprint restated with another knownAt is one piece of evidence, not two', () => {
    const restated = observation('a-restated', 0.1, 0, { knownAt: '2026-01-03T12:00:00.000Z', evidenceFingerprint: evidenceFingerprint('a') });
    expect(codeOf(() => fitPitConfidenceCalibration(request({ observations: [observation('a', 0.1, 0), restated] })))).toBe('INVALID_OBSERVATIONS');
  });

  it('R7 fit evidence reused in an evaluation with a changed knownAt is refused (doc §13)', () => {
    const fit = fitPitConfidenceCalibration(request());
    const reused = { ...request().observations[0]!, observationId: 'renamed', knownAt: '2026-01-20T12:00:00.000Z' };
    expect(
      codeOf(() => evaluatePitConfidenceCalibration({ model: fit, asOf: '2026-03-01T00:00:00.000Z', observations: [reused] })),
    ).toBe('FIT_EVIDENCE_REUSE');
  });

  it('R5 an evaluation asOf before the model fitAsOf is refused: the model did not exist yet (doc §14)', () => {
    const fit = fitPitConfidenceCalibration(request());
    const early = observation('eval-early', 0.2, 0, {
      asOf: '2026-01-05T00:00:00.000Z',
      knownAt: '2026-01-10T00:00:00.000Z',
      evidenceFingerprint: evidenceFingerprint('eval-early'),
    });
    expect(codeOf(() => evaluatePitConfidenceCalibration({ model: fit, asOf: '2026-01-15T00:00:00.000Z', observations: [early] }))).toBe('INVALID_TIME');
  });
});

describe('O12 review — no invented probabilities or quality (RED)', () => {
  it('R8 an INSUFFICIENT_SAMPLES model exposes no bin probabilities (doc §10: no model is fabricated)', () => {
    const result = fitPitConfidenceCalibration(request({ observations: [observation('one', 0.8, 1)], policy: { ...policy, minimumFitSamples: 2 } }));
    expect(result.status).toBe('INSUFFICIENT_SAMPLES');
    expect(result.bins.every((bin) => bin.probability === null)).toBe(true);
  });

  it('R9 zero eligible evaluation rows give a null coverage rate, not an invented zero (review item 21)', () => {
    const fit = fitPitConfidenceCalibration(request());
    const evaluation = evaluatePitConfidenceCalibration({
      model: fit,
      asOf: '2026-04-01T00:00:00.000Z',
      observations: [observation('future-eval', 0.8, 1, { asOf: '2026-04-02T00:00:00.000Z', knownAt: '2026-05-01T00:00:00.000Z' })],
    });
    expect(evaluation).toMatchObject({ eligibleSampleSize: 0, coverageRate: null, brierScore: null });
  });
});

describe('O12 review — self-verification of artifacts (RED)', () => {
  it('R10 a serialized artifact whose keys a store reordered still verifies (its content is unchanged)', () => {
    const result = fitPitConfidenceCalibration(request());
    expect(() => verifyPitConfidenceCalibrationModel(reverseKeys(result) as PitConfidenceCalibrationModel)).not.toThrow();
  });

  it('R11 an evaluation result verifies against its request, and a tampered metric is refused', () => {
    const fit = fitPitConfidenceCalibration(request());
    const evaluationRequest = {
      model: fit,
      asOf: '2026-04-01T00:00:00.000Z',
      observations: [
        observation('eval-low', 0.2, 0, { asOf: '2026-03-01T00:00:00.000Z', knownAt: '2026-03-02T00:00:00.000Z', evidenceFingerprint: evidenceFingerprint('eval-low') }),
      ],
    };
    const evaluation = evaluatePitConfidenceCalibration(evaluationRequest);
    expect(() => verifyPitCalibrationEvaluation(evaluationRequest, evaluation)).not.toThrow();
    expect(codeOf(() => verifyPitCalibrationEvaluation(evaluationRequest, { ...evaluation, brierScore: 0 }))).toBe('INVALID_CALIBRATION_MODEL');
  });
});

describe('O12 review — boundaries, numerics and time inclusion (guards)', () => {
  it('G1 every interior edge is lower-inclusive, the last bin includes 1, and a value just below an edge stays in the lower bin', () => {
    const edges = [0, 0.2, 0.4, 0.6, 0.8, 1];
    const wide = { ...policy, binEdges: edges, minimumFitSamples: 1, minimumSamplesPerBin: 1 };
    const atEdges = fitPitConfidenceCalibration(
      request({
        policy: wide,
        observations: [observation('e0', 0, 0), observation('e1', 0.2, 0), observation('e2', 0.4, 0), observation('e3', 0.6, 0), observation('e4', 0.8, 0), observation('one', 1, 1)],
      }),
    );
    expect(atEdges.bins.map((bin) => bin.sampleSize)).toEqual([1, 1, 1, 1, 2]);

    const justBelow = fitPitConfidenceCalibration(
      request({ policy: wide, observations: [observation('below', 0.19999999999999998, 1)] }),
    );
    expect(justBelow.bins.map((bin) => bin.sampleSize)).toEqual([1, 0, 0, 0, 0]);
  });

  it('G2 -0 is binned as 0, and NaN, Infinity and out-of-range confidences are refused', () => {
    const fit = fitPitConfidenceCalibration(request({ observations: [observation('zero', -0, 0), observation('one', 0.9, 1)] }));
    expect(fit.bins[0]!.sampleSize).toBe(1);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.000001, 1.000001]) {
      expect(codeOf(() => fitPitConfidenceCalibration(request({ observations: [observation('x', bad, 1)] }))), String(bad)).toBe('INVALID_OBSERVATIONS');
    }
  });

  it('G3 a populated bin with one positive in three reports exactly 1/3 and verifies', () => {
    const fit = fitPitConfidenceCalibration(
      request({
        observations: [observation('a', 0.1, 1), observation('b', 0.2, 0), observation('c', 0.3, 0)],
        policy: { ...policy, minimumFitSamples: 3, minimumSamplesPerBin: 1 },
      }),
    );
    expect(fit.bins[0]!.probability).toBe(1 / 3);
    expect(() => verifyPitConfidenceCalibrationModel(fit)).not.toThrow();
  });

  it('G4 more than the bounded number of bins is refused', () => {
    const edges = Array.from({ length: 102 }, (_, index) => index / 101);
    expect(codeOf(() => fitPitConfidenceCalibration(request({ policy: { ...policy, binEdges: edges } })))).toBe('INVALID_POLICY');
  });

  it('G5 an outcome known one millisecond after fitAsOf is excluded', () => {
    const fit = fitPitConfidenceCalibration(request({ observations: [...request().observations, observation('late', 0.9, 0, { knownAt: '2026-02-01T00:00:00.001Z' })] }));
    expect(fit.excludedFutureSampleCount).toBe(1);
  });

  it('G6 an evaluation outcome known exactly at evaluation asOf is covered; one millisecond later it is excluded', () => {
    const fit = fitPitConfidenceCalibration(request());
    const evaluation = evaluatePitConfidenceCalibration({
      model: fit,
      asOf: '2026-03-02T00:00:00.000Z',
      observations: [
        observation('at-asof', 0.8, 1, { asOf: '2026-03-01T00:00:00.000Z', knownAt: '2026-03-02T00:00:00.000Z', evidenceFingerprint: evidenceFingerprint('at-asof') }),
        observation('later', 0.8, 1, { asOf: '2026-03-01T00:00:00.000Z', knownAt: '2026-03-02T00:00:00.001Z', evidenceFingerprint: evidenceFingerprint('later') }),
      ],
    });
    expect(evaluation).toMatchObject({ eligibleSampleSize: 1, excludedFutureSampleCount: 1 });
  });

  it('G7 a row that belongs to another model is refused even when it is in the future (a contract error, not a time error)', () => {
    expect(codeOf(() => fitPitConfidenceCalibration(request({ observations: [...request().observations, observation('other', 0.9, 0, { knownAt: FUTURE, modelKey: OTHER_MODEL })] })))).toBe('INVALID_OBSERVATIONS');
  });

  it('G8 a future row whose knownAt cannot be read is refused: it cannot be placed in time', () => {
    expect(codeOf(() => fitPitConfidenceCalibration(request({ observations: [...request().observations, observation('future-time', 0.9, 0, { knownAt: 'Mar 1 2026' })] })))).toBe('INVALID_TIME');
  });

  it('G9 a non-canonical evaluation asOf is refused', () => {
    const fit = fitPitConfidenceCalibration(request());
    expect(codeOf(() => evaluatePitConfidenceCalibration({ model: fit, asOf: '2026-03-02', observations: [] }))).toBe('INVALID_TIME');
  });
});
