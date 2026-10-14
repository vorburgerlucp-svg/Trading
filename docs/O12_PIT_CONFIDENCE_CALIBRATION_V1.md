# O12: Point-in-Time Confidence Calibration V1

Status: design first. Base: `a40cd95` (O11 Shadow Model Benchmark V1 merged and green).

## 1. Goal

O12 turns raw model confidence scores into calibrated probabilities using only historical outcomes that were actually known at the fit instant.

The central rule is:

> Confidence is a model score. Probability exists only after a documented calibration model has been fitted on a valid binary target with point-in-time-safe evidence.

O12 must never reinterpret an arbitrary performance score as a probability.

## 2. Existing foundation

The repository already has:

- `src/ai/calibration.ts`
- `CalibrationModel`
- `calibrate(confidenceScore, model)`
- supported method names:
  - `histogram_binning`
  - `platt_scaling`
  - `isotonic_regression`

The current helper applies a fitted model but does not fit, validate, version, persist or independently evaluate one.

O12 adds that missing lifecycle.

## 3. V1 scope

O12 V1 implements one deterministic fitting method:

`histogram_binning`

Platt scaling and isotonic regression remain recognized method names but are not fitted in O12 V1.

This keeps V1 auditable and dependency-free.

## 4. Calibration target

Each observation contains:

```ts
{
  observationId: string;
  modelKey: ModelKey;
  asOf: string;
  knownAt: string;
  confidenceScore: number; // raw model confidence, 0..1
  outcomeLabel: 0 | 1;     // explicit binary target
  evidenceFingerprint: string;
}
```

`outcomeLabel` is not the O11 benchmark score.

Examples of valid binary targets:

- recommendation direction was correct;
- predicted event occurred;
- declared threshold was met.

The meaning of the target is fixed by `targetId` and `targetVersion`.

Different targets must never share one calibration model.

## 5. Point-in-time fitting

A calibration request specifies:

- `fitAsOf`
- `targetId`
- `targetVersion`
- one model key
- explicit observations

An observation is eligible for fitting only when:

`knownAt <= fitAsOf`

and:

`asOf <= knownAt`

Observations with outcomes known later than `fitAsOf` are invisible to the fit.

The caller may supply later observations in the request; O12 must exclude them deterministically rather than leak them into training.

## 6. Canonical time

`asOf`, `knownAt` and `fitAsOf` must be canonical UTC timestamps:

`YYYY-MM-DDTHH:mm:ss.sssZ`

Equivalent non-canonical spellings are refused.

## 7. Evidence identity

Each observation fingerprint binds:

- observationId
- modelKey
- asOf
- knownAt
- confidenceScore
- outcomeLabel
- targetId
- targetVersion
- evidenceFingerprint

Duplicate evidence under another observation id must not increase sample size.

## 8. Histogram-binning policy

V1 uses caller-declared, immutable bin edges.

Example:

```ts
binEdges: [0, 0.2, 0.4, 0.6, 0.8, 1]
```

Requirements:

- first edge exactly 0
- last edge exactly 1
- strictly increasing
- at least two bins
- maximum bounded number of bins
- exact deterministic inclusion rule:
  - bins except last: `[lower, upper)`
  - last bin: `[lower, 1]`

For each bin:

`probability = positives / samples`

## 9. Minimum samples

V1 has two explicit minimums:

- `minimumFitSamples`
- `minimumSamplesPerBin`

A calibration model is usable only when:

- total eligible fit sample size >= `minimumFitSamples`
- every populated bin used for prediction meets `minimumSamplesPerBin`

Empty bins do not invent probabilities.

A raw confidence landing in an empty/under-sampled bin returns no calibrated probability.

## 10. Calibration model result

O12 produces a serializable fitted model descriptor, not a closure-only function.

Version:

`pit-confidence-calibration:v1`

The result records:

- calibrationRunId
- inputFingerprint
- modelKey
- targetId / targetVersion
- method = histogram_binning
- fitAsOf
- policy
- eligible sample size
- excluded-future sample count
- canonical bin statistics
- modelFingerprint
- status

Possible status:

- `FITTED`
- `INSUFFICIENT_SAMPLES`

No model is fabricated when evidence is insufficient.

## 11. Applying the model

O12 exposes a deterministic apply function:

```ts
applyFittedCalibration(model, confidenceScore)
```

It returns:

- raw confidence score
- calibratedProbability or null
- calibration method/version reference
- bin evidence
- reason when probability is null

No interpolation is used in histogram V1.

## 12. Evaluation

Fitting and evaluation are separate.

A calibration evaluation request supplies observations not used to fit the model.

At minimum O12 reports:

- evaluation sample size
- Brier score
- calibration bins
- mean predicted probability
- observed positive rate
- coverage rate

V1 must not report ECE unless the exact weighting/bucketing policy is explicitly pinned.

## 13. No in-sample evaluation

An observation used in the fit may not be reused as out-of-sample evaluation evidence for the same calibration evaluation.

Duplicate evidence is detected by observation evidence identity, not only observationId.

## 14. Point-in-time evaluation

An evaluation observation can be scored only when its outcome is known at the evaluation `asOf`.

Future outcomes remain invisible.

## 15. Model-specific identity

A calibration model belongs to one exact `modelKey`.

A model fitted for one model must never calibrate another model.

Model version pinning is deferred until O11 carries a stronger registry/model-version identity across all cases. O12 V1 records the observed model key and target identity.

## 16. Determinism

Identical:

- eligible observations
- fitAsOf
- modelKey
- target identity
- bin policy
- minimum-sample policy

must produce identical:

- bin statistics
- model fingerprint
- input fingerprint
- calibrationRunId

Input order must not matter.

## 17. Fail-closed conditions

O12 refuses:

- malformed model key
- empty target identity
- malformed times
- `knownAt < asOf`
- confidence outside 0..1
- non-binary outcome label
- malformed evidence fingerprint
- duplicate observation ids
- duplicate evidence under another observation id
- invalid bin edges
- non-integer/non-positive sample thresholds
- application to another model
- tampered fitted model
- evaluation using fit evidence
- non-finite derived metrics

## 18. RED test matrix

Before implementation, tests must prove at least:

1. future-known observations are excluded from fitting
2. eligible observations are fitted
3. input order does not change model identity
4. duplicate observation ids fail closed
5. duplicate evidence under different ids fails closed
6. non-canonical timestamps fail closed
7. `knownAt < asOf` fails closed
8. confidence outside 0..1 fails closed
9. non-binary labels fail closed
10. invalid bin edges fail closed
11. insufficient total samples produces `INSUFFICIENT_SAMPLES`
12. exact bin boundary semantics are pinned
13. empty bin returns null on apply
14. under-sampled bin returns null on apply
15. valid populated bin returns empirical probability
16. fitted model is serializable
17. fitted model verifier detects tampered bin counts
18. verifier detects tampered probabilities
19. verifier detects tampered model fingerprint
20. verifier detects tampered run id
21. model-key mismatch on apply fails closed
22. evaluation refuses fit evidence reuse
23. evaluation ignores future-known outcomes
24. Brier score is computed only from covered evaluation observations
25. coverage rate is exact
26. changing one eligible outcome changes model identity
27. changing only a future-known outcome does not change fit identity
28. O11 benchmark score is never accepted as an implicit calibration label
29. existing `calibrate(...)` semantics remain valid
30. O11/O10/O9 and governance tests remain green

## 19. Four-eyes review target

Independent review should attack:

- outcome leakage across `fitAsOf`
- evidence duplication/sample inflation
- bin-edge off-by-one behavior
- empty-bin handling
- tampered fitted models
- in-sample evaluation leakage
- Brier denominator/coverage mistakes
- accidental interpretation of performance score as probability
- non-determinism from object/map insertion order

## 20. Persistence

V1 may return verified immutable calibration artifacts without PostgreSQL persistence.

Append-only sealed persistence should be added before calibrated probabilities affect production routing or capital decisions.

## 21. Safety and governance

O12 changes measurement semantics only.

It does not:

- activate models
- change ChampionBoard
- route decisions
- place broker orders
- modify capital
- unlock live trading

Live Trading, Broker Orders and Physical Purchase remain LOCKED.
