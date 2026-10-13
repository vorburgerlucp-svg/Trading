# O10: Walk-Forward & Out-of-Sample Evaluation V1

Status: design first. Base: `f39fde2` (O9 replay persistence hardening merged and green).

## 1. Goal

O9 produces an immutable, point-in-time historical scanner timeline.

O10 turns that timeline into deterministic walk-forward research with explicit:

- training windows;
- validation windows;
- untouched out-of-sample test windows;
- pre-declared strategy/parameter variants;
- deterministic selection rules;
- immutable fold-level evidence.

The core invariant is simple:

> Nothing learned from a test window may influence which variant is selected for that test window.

O10 is research infrastructure only. It does not create broker orders or unlock live trading.

## 2. Why this comes after O9

O9 answers:

> What would the scanner have seen and selected at historical instant T?

O10 answers:

> If several pre-declared research variants existed before T, which one would have been selected using only earlier evidence, and how did that frozen choice perform out of sample?

This is the minimum safe foundation for later model benchmarking, parameter research and AI shadow evaluation.

## 3. Non-goals

O10 V1 does not add:

- automated hyperparameter search;
- Bayesian optimization;
- genetic optimization;
- AI-generated variants;
- test-window peeking;
- cross-fold model mutation;
- live trading;
- broker execution;
- portfolio capital allocation changes;
- model activation.

The caller supplies all variants before evaluation starts.

## 4. Inputs

O10 consumes one immutable `HistoricalScannerReplayResult` and one explicit walk-forward plan.

Each variant has:

```ts
{
  variantId: string;
  definition: Readonly<Record<string, unknown>>;
}
```

Variant ids must be unique, non-empty and supplied before any fold is evaluated.

The full variant set is fingerprinted into the O10 run identity.

## 5. Explicit folds

The caller supplies folds using exact O9 replay instants:

```ts
{
  foldId: string;
  train:      { from: string; through: string };
  validation: { from: string; through: string };
  test:       { from: string; through: string };
}
```

Every boundary must exist in the O9 `asOf` schedule.

Inside one fold:

`train.through < validation.from`

and:

`validation.through < test.from`

No phase may overlap another phase inside the same fold.

Adjacent phases are allowed.

Folds themselves may overlap with other folds because walk-forward research commonly rolls through time.

## 6. Frozen source replay

One O10 run is bound to exactly one O9 replay identity.

The following enter the O10 fingerprint:

- O9 `replayRunId`;
- O9 `inputFingerprint`;
- exact normalized folds;
- exact pre-declared variants;
- evaluation policy version;
- objective definition.

O10 never silently re-runs O9 with new anchors.

If a different O9 replay is desired, it produces a different O10 run.

## 7. Evaluation port

O10 orchestrates evaluation but does not duplicate backtest economics.

The core receives an evaluator port:

```ts
evaluate({
  variant,
  phase,
  foldId,
  steps
}) -> VariantEvaluation
```

The evaluator may later call O7 portfolio backtesting, but O10 only requires immutable deterministic evaluation records.

Each `VariantEvaluation` contains:

- variantId;
- foldId;
- phase;
- stepFrom;
- stepThrough;
- objectiveValue;
- metrics/evidence;
- evaluationFingerprint.

The evaluator must not receive steps outside the requested phase.

## 8. Selection policy V1

All variants are evaluated on TRAIN.

Variants failing the configured training eligibility gate are excluded before validation.

Eligible variants are evaluated on VALIDATION.

The winner is selected **only** from validation results.

V1 supports one explicit objective:

`maximize objectiveValue`

No test result participates in selection.

If two or more eligible variants have exactly the same best validation objective, O10 fails closed with:

`WALK_FORWARD_SELECTION_AMBIGUOUS`

V1 does not invent a lexical, random or hidden secondary tie-breaker.

## 9. Training eligibility

V1 uses an explicit finite threshold supplied in the request:

```ts
minimumTrainingObjective?: number
```

When omitted, every finite training evaluation is eligible.

When provided, a variant is eligible only if:

`training.objectiveValue >= minimumTrainingObjective`

NaN and infinite objective values are always invalid and fail closed.

A future version may add richer risk gates.

## 10. Test isolation

After a winner is frozen for one fold:

1. record the selected variant id;
2. record the exact training and validation evaluation fingerprints used for selection;
3. only then call the evaluator for TEST;
4. evaluate TEST for the selected variant only.

Non-selected variants are not evaluated on TEST in V1.

This matters because a test evaluation itself may produce downstream cached artifacts. O10 V1 avoids creating test artifacts for variants that were not selected.

## 11. No-peek evaluator contract

The evaluator call receives only the O9 steps belonging to its phase.

For example, during TRAIN it cannot receive validation/test steps.

O10 constructs a fresh immutable slice for each call.

The evaluator also receives a phase-specific context object containing no future boundaries beyond that phase.

O10 never passes the whole replay result into the evaluator.

## 12. Fold result

Each fold records:

```ts
{
  foldId,
  trainRange,
  validationRange,
  testRange,
  trainingEvaluations,
  validationEvaluations,
  selectedVariantId,
  selectionEvidence,
  testEvaluation
}
```

Training and validation arrays are canonicalized by `variantId`.

Candidate rank/order inside O9 steps is not rewritten.

## 13. Run result

O10 introduces:

`walk-forward-oos:v1`

A run contains:

- walkForwardRunId;
- inputFingerprint;
- source O9 replay identity;
- objective policy;
- normalized variants;
- normalized folds;
- ordered fold results;
- aggregate OOS summary.

## 14. Aggregate OOS summary

V1 aggregates only test results.

It reports at least:

- foldCount;
- selectedVariantCounts;
- meanTestObjective;
- medianTestObjective;
- minimumTestObjective;
- maximumTestObjective.

Training and validation values never enter OOS summary statistics.

No annualization or statistical significance claim is made in V1.

## 15. Determinism

Identical:

- O9 replay result;
- variants;
- folds;
- thresholds;
- evaluator algorithm/version and outputs;

must produce the same:

- evaluator call order;
- selected variants;
- fold results;
- aggregate OOS summary;
- input fingerprint;
- walkForwardRunId.

Map insertion order must not affect identity.

## 16. Fail-closed conditions

O10 fails closed on:

- empty replay schedule;
- malformed source replay identity;
- no variants;
- duplicate variant ids;
- no folds;
- duplicate fold ids;
- boundary not present in the replay;
- phase overlap or reversed phase order;
- empty train, validation or test phase;
- evaluator result referring to another variant/fold/phase;
- evaluator result covering another step range;
- non-finite objective value;
- no training-eligible variant;
- exact best-validation tie;
- evaluator non-determinism for the same request.

## 17. RED test matrix

Before implementation, tests must prove:

1. one valid fold evaluates all variants on TRAIN;
2. only training-eligible variants reach VALIDATION;
3. only the validation winner reaches TEST;
4. TEST is called only after winner selection;
5. evaluator never receives future-phase steps;
6. changing only a TEST step cannot change the selected variant;
7. changing TRAIN may change eligibility;
8. changing VALIDATION may change the selected variant;
9. exact validation tie fails with `WALK_FORWARD_SELECTION_AMBIGUOUS`;
10. no eligible variant fails closed;
11. duplicate variant ids fail before evaluator calls;
12. duplicate fold ids fail before evaluator calls;
13. unknown fold boundary fails before evaluator calls;
14. overlapping/reversed phases fail before evaluator calls;
15. non-finite evaluator objective fails closed;
16. evaluator metadata mismatch fails closed;
17. variant input order does not change identity or result ordering;
18. fold input order is normalized by chronological test window and then foldId, or rejected if ambiguous;
19. repeated identical run is deterministic;
20. aggregate summary uses TEST values only;
21. changing O9 replay identity changes O10 identity;
22. existing O9, O7 and earlier tests remain green.

## 18. Four-eyes review target

Before merge, an independent review should specifically attack:

- future-step leakage into TRAIN/VALIDATION evaluator calls;
- accidental test evaluation of losing variants;
- deterministic tie handling;
- result/fingerprint tampering;
- fold normalization;
- NaN/Infinity behavior;
- evaluator result substitution across phases/folds/variants.

## 19. What O10 enables next

After O10 is stable:

- model benchmarking on historical cases;
- shadow AI challenger evaluation;
- calibrated confidence research;
- scanner parameter benchmarking;
- portfolio rules driven by historically selected scanner candidates.

## 20. Safety

O10 evaluates historical research only.

Live Trading, Broker Orders and Physical Purchase remain LOCKED.
