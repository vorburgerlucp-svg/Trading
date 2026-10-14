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

/**
 * A forger who re-issues every hash a model states, with the public formulas, and leaves the rest as it was. Bins are deliberately not recomputed,
 * so a test can change one and see whether the verifier notices.
 */
function identityOfEvidence(model: PitConfidenceCalibrationModel, evidenceFingerprint: string): string {
  return hashOf({ kind: 'calibration-evidence-identity', modelKey: model.modelKey, targetId: model.targetId, targetVersion: model.targetVersion, evidenceFingerprint });
}

function contentOfEvidence(model: PitConfidenceCalibrationModel, row: PitConfidenceCalibrationModel['fitEvidence'][number]): string {
  return hashOf({
    modelKey: model.modelKey,
    targetId: model.targetId,
    targetVersion: model.targetVersion,
    asOf: row.asOf,
    knownAt: row.knownAt,
    confidenceScore: row.confidenceScore,
    outcomeLabel: row.outcomeLabel,
    evidenceFingerprint: row.evidenceFingerprint,
  });
}

function reissue(model: PitConfidenceCalibrationModel): PitConfidenceCalibrationModel {
  const fitEvidence = model.fitEvidence.map((row) => ({ ...row, calibrationEvidenceFingerprint: contentOfEvidence(model, row) }));
  const fitEvidenceFingerprints = fitEvidence.map((row) => identityOfEvidence(model, row.evidenceFingerprint));
  const inputFingerprint = hashOf({
    engine: PIT_CONFIDENCE_CALIBRATION_VERSION,
    method: 'histogram_binning',
    modelKey: model.modelKey,
    targetId: model.targetId,
    targetVersion: model.targetVersion,
    fitAsOf: model.fitAsOf,
    policy: model.policy,
    fitEvidenceFingerprints,
  });
  const modelFingerprint = modelFingerprintFor({ ...model, fitEvidence, fitEvidenceFingerprints, inputFingerprint });
  return { ...model, fitEvidence, fitEvidenceFingerprints, inputFingerprint, calibrationRunId: 'pcc_' + inputFingerprint.slice(0, 40), modelFingerprint };
}

/** The model fingerprint formula, as a forger would reproduce it. */
function modelFingerprintFor(model: PitConfidenceCalibrationModel): string {
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

describe('O12 review — re-issued hashes do not make impossible states verifiable (guards)', () => {
  it('T1 re-issued bin counts are refused: bins must follow from the fit evidence', () => {
    const forged = structuredClone(fitPitConfidenceCalibration(request()));
    forged.bins[0]!.sampleSize += 1;
    expect(codeOf(() => verifyPitConfidenceCalibrationModel(reissue(forged)))).toBe('INVALID_CALIBRATION_MODEL');
  });

  it('T2 a re-issued probability is refused: probabilities must follow from the bin counts', () => {
    const forged = structuredClone(fitPitConfidenceCalibration(request()));
    forged.bins[0]!.probability = 0.123;
    expect(codeOf(() => verifyPitConfidenceCalibrationModel(reissue(forged)))).toBe('INVALID_CALIBRATION_MODEL');
  });

  it('T3 a re-issued status flip is refused: an INSUFFICIENT_SAMPLES model cannot be presented as fitted', () => {
    const forged = structuredClone(fitPitConfidenceCalibration(request({ observations: [observation('one', 0.8, 1)], policy: { ...policy, minimumFitSamples: 2 } })));
    forged.status = 'FITTED';
    expect(codeOf(() => verifyPitConfidenceCalibrationModel(reissue(forged)))).toBe('INVALID_CALIBRATION_MODEL');
  });

  it('T4 re-issued fit evidence known after fitAsOf is refused', () => {
    const forged = structuredClone(fitPitConfidenceCalibration(request()));
    forged.fitEvidence[0]!.knownAt = '2026-03-01T00:00:00.000Z';
    expect(codeOf(() => verifyPitConfidenceCalibrationModel(reissue(forged)))).toBe('INVALID_CALIBRATION_MODEL');
  });

  it('T5 a re-issued eligible sample size is refused', () => {
    const forged = structuredClone(fitPitConfidenceCalibration(request()));
    forged.eligibleSampleSize += 1;
    expect(codeOf(() => verifyPitConfidenceCalibrationModel(reissue(forged)))).toBe('INVALID_CALIBRATION_MODEL');
  });

  it('T6 a model fitted on other evidence verifies as itself: consistency is not provenance (limit pinned, see the design doc)', () => {
    const changed = request().observations.map((one, index) => (index === 0 ? { ...one, outcomeLabel: 1 as const, evidenceFingerprint: evidenceFingerprint('changed') } : one));
    expect(() => verifyPitConfidenceCalibrationModel(fitPitConfidenceCalibration(request({ observations: changed })))).not.toThrow();
  });

  it('T8 a re-issued policy change is refused: the bins publish probabilities under the stated policy only', () => {
    const forged = structuredClone(fitPitConfidenceCalibration(request()));
    forged.policy = { ...forged.policy, minimumSamplesPerBin: 10 };
    expect(codeOf(() => verifyPitConfidenceCalibrationModel(reissue(forged)))).toBe('INVALID_CALIBRATION_MODEL');
  });

  it('T7 a re-issued excluded-future count changes no identity: it is audit metadata, not fit evidence (limit pinned)', () => {
    const model = fitPitConfidenceCalibration(request());
    const forged = reissue({ ...structuredClone(model), excludedFutureSampleCount: 99 });
    expect(forged.inputFingerprint).toBe(model.inputFingerprint);
    expect(() => verifyPitConfidenceCalibrationModel(forged)).not.toThrow();
  });
});

describe('O12 review — evidence identity boundaries (guards)', () => {
  it('E2 rows with identical content but distinct evidence fingerprints are distinct evidence: the caller owns the identity', () => {
    const fit = fitPitConfidenceCalibration(
      request({
        observations: [
          observation('a', 0.1, 0, { evidenceFingerprint: evidenceFingerprint('one') }),
          observation('b', 0.1, 0, { evidenceFingerprint: evidenceFingerprint('two') }),
        ],
      }),
    );
    expect(fit.eligibleSampleSize).toBe(2);
  });

  it('E4 equivalent numeric values with the same evidence fingerprint are one piece of evidence (-0 is 0)', () => {
    const fp = evidenceFingerprint('same');
    expect(codeOf(() => fitPitConfidenceCalibration(request({ observations: [observation('a', -0, 0, { evidenceFingerprint: fp }), observation('b', 0, 0, { evidenceFingerprint: fp })] })))).toBe('INVALID_OBSERVATIONS');
  });

  it('V6 an evaluation row with identical content but a distinct evidence fingerprint is new evidence, not reuse', () => {
    const fit = fitPitConfidenceCalibration(request());
    const twin = observation('twin', 0.1, 0, { asOf: '2026-01-01T12:00:00.000Z', knownAt: '2026-01-02T12:00:00.000Z', evidenceFingerprint: evidenceFingerprint('twin') });
    const evaluation = evaluatePitConfidenceCalibration({ model: fit, asOf: '2026-03-01T00:00:00.000Z', observations: [twin] });
    expect(evaluation.eligibleSampleSize).toBe(1);
  });

  it('V7 a duplicate evidence fingerprint inside one evaluation is refused, and the sample is not inflated', () => {
    const fit = fitPitConfidenceCalibration(request());
    const fp = evaluationFingerprint();
    const rows = [
      observation('e1', 0.8, 1, { asOf: '2026-03-01T00:00:00.000Z', knownAt: '2026-03-02T00:00:00.000Z', evidenceFingerprint: fp }),
      observation('e2', 0.8, 1, { asOf: '2026-03-01T00:00:00.000Z', knownAt: '2026-03-03T00:00:00.000Z', evidenceFingerprint: fp }),
    ];
    expect(codeOf(() => evaluatePitConfidenceCalibration({ model: fit, asOf: '2026-04-01T00:00:00.000Z', observations: rows }))).toBe('INVALID_OBSERVATIONS');
  });
});

function evaluationFingerprint(): string {
  return evidenceFingerprint('evaluation-shared');
}

function messageOf(run: () => unknown): string {
  try {
    run();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('O12 review — every refusal names its reason (guards)', () => {
  it('A01 a row that is not an object is refused as an observation error', () => {
    expect(codeOf(() => fitPitConfidenceCalibration(request({ observations: [...request().observations, null as unknown as CalibrationObservation] })))).toBe('INVALID_OBSERVATIONS');
  });

  it('A02 a later row with a blank observationId is refused: every row must be identifiable', () => {
    expect(codeOf(() => fitPitConfidenceCalibration(request({ observations: [...request().observations, observation(' ', 0.9, 0, { knownAt: FUTURE })] })))).toBe('INVALID_OBSERVATIONS');
  });

  it('G8b an unreadable knownAt is refused with its own reason', () => {
    expect(messageOf(() => fitPitConfidenceCalibration(request({ observations: [...request().observations, observation('future-time', 0.9, 0, { knownAt: 'Mar 1 2026' })] })))).toMatch(/knownAt must be a canonical UTC instant/);
  });

  it('B01 two rows with one observationId and different evidence are refused as duplicate ids', () => {
    expect(messageOf(() => fitPitConfidenceCalibration(request({ observations: [observation('same-id', 0.3, 1), observation('same-id', 0.6, 0)] })))).toMatch(/duplicate observationId same-id/);
  });

  it('B02 a non-canonical asOf of an eligible row is refused with its reason', () => {
    expect(messageOf(() => fitPitConfidenceCalibration(request({ observations: [observation('x', 0.5, 1, { asOf: '2026-01-01' })] })))).toMatch(/asOf must be a canonical UTC instant/);
  });

  it('B03 knownAt before asOf is refused by the observation check, not by the later self-verification', () => {
    expect(messageOf(() => fitPitConfidenceCalibration(request({ observations: [observation('x', 0.5, 1, { asOf: '2026-01-03T00:00:00.000Z', knownAt: '2026-01-02T00:00:00.000Z' })] })))).toMatch(/knownAt precedes asOf/);
  });

  it('B05 a non-binary label is refused by the observation check', () => {
    expect(codeOf(() => fitPitConfidenceCalibration(request({ observations: [{ ...observation('x', 0.5, 1), outcomeLabel: 0.5 as never }] })))).toBe('INVALID_OBSERVATIONS');
  });

  it('B06 a malformed evidence fingerprint is refused by the observation check', () => {
    expect(messageOf(() => fitPitConfidenceCalibration(request({ observations: [{ ...observation('x', 0.5, 1), evidenceFingerprint: 'short' }] })))).toMatch(/evidenceFingerprint must be a lowercase/);
  });

  it('C04 a bin below minimumSamplesPerBin publishes no probability, while a bin that meets it does', () => {
    const fit = fitPitConfidenceCalibration(
      request({
        observations: [observation('a', 0.1, 0), observation('b', 0.2, 1), observation('c', 0.8, 1), observation('d', 0.9, 1), observation('e', 0.85, 1)],
        policy: { ...policy, minimumFitSamples: 2, minimumSamplesPerBin: 3 },
      }),
    );
    expect(fit.bins.map((bin) => [bin.sampleSize, bin.probability])).toEqual([
      [2, null],
      [3, 1],
    ]);
  });

  it('F01 a tampered engine version is refused', () => {
    const forged = { ...fitPitConfidenceCalibration(request()), engineVersion: 'pit-confidence-calibration:v0' as never };
    expect(messageOf(() => verifyPitConfidenceCalibrationModel(forged))).toMatch(/engineVersion is invalid/);
  });

  it('F02 a tampered method is refused', () => {
    const forged = { ...fitPitConfidenceCalibration(request()), method: 'platt_scaling' as never };
    expect(messageOf(() => verifyPitConfidenceCalibrationModel(forged))).toMatch(/method is not histogram_binning/);
  });

  it('F03 a non-canonical fitAsOf is refused by the verifier', () => {
    const forged = { ...structuredClone(fitPitConfidenceCalibration(request())), fitAsOf: '2026-02-01' };
    expect(messageOf(() => verifyPitConfidenceCalibrationModel(forged))).toMatch(/fitAsOf is not canonical UTC/);
  });

  it('F04 a negative excluded-future count is refused', () => {
    const forged = { ...structuredClone(fitPitConfidenceCalibration(request())), excludedFutureSampleCount: -1 };
    expect(messageOf(() => verifyPitConfidenceCalibrationModel(forged))).toMatch(/excludedFutureSampleCount is invalid/);
  });

  it('F06 a re-issued confidence outside 0..1 is refused by the verifier, not by binning', () => {
    const forged = structuredClone(fitPitConfidenceCalibration(request()));
    forged.fitEvidence[0]!.confidenceScore = 2;
    expect(messageOf(() => verifyPitConfidenceCalibrationModel(reissue(forged)))).toMatch(/confidenceScore is invalid/);
  });

  it('F07 a re-issued label outside 0 and 1 is refused by the verifier, not by the bin totals', () => {
    const forged = structuredClone(fitPitConfidenceCalibration(request()));
    forged.fitEvidence[0]!.outcomeLabel = 2 as never;
    expect(messageOf(() => verifyPitConfidenceCalibrationModel(reissue(forged)))).toMatch(/outcomeLabel is invalid/);
  });

  it('F08 a fit row changed without re-issuing its content binding is refused', () => {
    const forged = structuredClone(fitPitConfidenceCalibration(request()));
    forged.fitEvidence[0]!.knownAt = '2026-01-03T12:00:00.000Z';
    expect(messageOf(() => verifyPitConfidenceCalibrationModel(forged))).toMatch(/does not bind the evidence/);
  });

  it('F09 a re-issued model that repeats one evidence under another observation id is refused', () => {
    const model = structuredClone(fitPitConfidenceCalibration(request()));
    const copy = { ...model.fitEvidence[0]!, observationId: 'a2' };
    const forged = { ...model, fitEvidence: [model.fitEvidence[0]!, copy, ...model.fitEvidence.slice(1)] };
    expect(messageOf(() => verifyPitConfidenceCalibrationModel(reissue(forged)))).toMatch(/duplicate fit evidence/);
  });

  it('F10 a re-issued model whose fit evidence is out of observationId order is refused', () => {
    const model = structuredClone(fitPitConfidenceCalibration(request()));
    const forged = { ...model, fitEvidence: [...model.fitEvidence].reverse() };
    expect(messageOf(() => verifyPitConfidenceCalibrationModel(reissue(forged)))).toMatch(/canonical observationId order/);
  });

  it('F12 a changed fit-evidence identity list is refused even when the model fingerprint is re-issued', () => {
    const model = structuredClone(fitPitConfidenceCalibration(request()));
    const forged = { ...model, fitEvidenceFingerprints: ['f'.repeat(64), ...model.fitEvidenceFingerprints.slice(1)] };
    const reissued = { ...forged, modelFingerprint: modelFingerprintFor(forged) };
    expect(messageOf(() => verifyPitConfidenceCalibrationModel(reissued))).toMatch(/fitEvidenceFingerprints do not match fit evidence/);
  });

  it('F16 a changed input fingerprint is refused even when the run id and model fingerprint are re-issued', () => {
    const model = structuredClone(fitPitConfidenceCalibration(request()));
    const inputFingerprint = 'e'.repeat(64);
    const forged = { ...model, inputFingerprint, calibrationRunId: 'pcc_' + inputFingerprint.slice(0, 40) };
    const reissued = { ...forged, modelFingerprint: modelFingerprintFor(forged) };
    expect(messageOf(() => verifyPitConfidenceCalibrationModel(reissued))).toMatch(/inputFingerprint does not match calibration inputs/);
  });

  it('F19 a blank target version is refused by the verifier with its reason', () => {
    const forged = { ...fitPitConfidenceCalibration(request()), targetVersion: ' ' };
    expect(messageOf(() => verifyPitConfidenceCalibrationModel(forged))).toMatch(/targetVersion must be a non-empty trimmed string/);
  });

  it('G5b applying a NaN confidence is refused with its reason', () => {
    const fit = fitPitConfidenceCalibration(request());
    expect(messageOf(() => applyFittedCalibration(fit, MODEL, Number.NaN))).toMatch(/confidenceScore must be within 0..1/);
  });

  it('H5 mean predicted probability and observed positive rate cover only covered rows', () => {
    const fit = fitPitConfidenceCalibration(
      request({
        observations: [observation('fit-a', 0.1, 0), observation('fit-b', 0.2, 1), observation('fit-c', 0.8, 1)],
        policy: { ...policy, minimumFitSamples: 3, minimumSamplesPerBin: 2 },
      }),
    );
    const known = { asOf: '2026-03-01T00:00:00.000Z', knownAt: '2026-03-02T00:00:00.000Z' };
    const evaluation = evaluatePitConfidenceCalibration({
      model: fit,
      asOf: '2026-04-01T00:00:00.000Z',
      observations: [
        observation('covered', 0.2, 1, { ...known, evidenceFingerprint: evidenceFingerprint('covered') }),
        observation('uncovered', 0.8, 0, { ...known, evidenceFingerprint: evidenceFingerprint('uncovered') }),
      ],
    });
    expect(evaluation).toMatchObject({ meanPredictedProbability: 0.5, observedPositiveRate: 1 });
  });
});

describe('O12 review — evaluation time and mixed rows (guards)', () => {
  it('V2 an evaluation row decided and known after the evaluation instant is excluded', () => {
    const fit = fitPitConfidenceCalibration(request());
    const evaluation = evaluatePitConfidenceCalibration({
      model: fit,
      asOf: '2026-04-01T00:00:00.000Z',
      observations: [observation('later', 0.8, 1, { asOf: '2026-04-05T00:00:00.000Z', knownAt: '2026-04-06T00:00:00.000Z', evidenceFingerprint: evidenceFingerprint('later') })],
    });
    expect(evaluation).toMatchObject({ eligibleSampleSize: 0, excludedFutureSampleCount: 1, coverageRate: null });
  });

  it('V4 mixed covered, uncovered and future rows are counted exactly', () => {
    const fit = fitPitConfidenceCalibration(
      request({
        observations: [observation('fit-a', 0.1, 0), observation('fit-b', 0.2, 1), observation('fit-c', 0.8, 1)],
        policy: { ...policy, minimumFitSamples: 3, minimumSamplesPerBin: 2 },
      }),
    );
    const known = { asOf: '2026-03-01T00:00:00.000Z', knownAt: '2026-03-02T00:00:00.000Z' };
    const evaluation = evaluatePitConfidenceCalibration({
      model: fit,
      asOf: '2026-04-01T00:00:00.000Z',
      observations: [
        observation('covered', 0.2, 1, { ...known, evidenceFingerprint: evidenceFingerprint('covered') }),
        observation('uncovered', 0.8, 0, { ...known, evidenceFingerprint: evidenceFingerprint('uncovered') }),
        observation('future', 0.2, 0, { asOf: '2026-03-01T00:00:00.000Z', knownAt: '2026-05-01T00:00:00.000Z', evidenceFingerprint: evidenceFingerprint('future') }),
      ],
    });
    expect(evaluation).toMatchObject({ eligibleSampleSize: 2, coveredSampleSize: 1, uncoveredSampleCount: 1, excludedFutureSampleCount: 1, coverageRate: 0.5 });
  });

  it('A3 future rows in any order leave the fit identity unchanged', () => {
    const futureA = observation('future-a', 0.3, 1, { knownAt: '2026-03-01T00:00:00.000Z', evidenceFingerprint: evidenceFingerprint('future-a') });
    const futureB = observation('future-b', 0.6, 0, { knownAt: '2026-03-02T00:00:00.000Z', evidenceFingerprint: evidenceFingerprint('future-b') });
    const forward = fitPitConfidenceCalibration(request({ observations: [...request().observations, futureA, futureB] }));
    const backward = fitPitConfidenceCalibration(request({ observations: [...request().observations, futureB, futureA] }));
    expect(backward.inputFingerprint).toBe(forward.inputFingerprint);
    expect(backward.excludedFutureSampleCount).toBe(2);
  });
});
