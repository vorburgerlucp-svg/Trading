# O11: Shadow Model Benchmark V1

Status: design first. Base: `e2d3643` (O10 walk-forward/OOS merged and green).

## 1. Goal

O11 turns historical walk-forward/OOS cases into a deterministic benchmark for AI models in shadow mode.

It answers:

> Given a fixed set of historical cases, how well did each model perform, and does the measured evidence satisfy the existing human-governed shadow-exit gate?

O11 does **not** activate models. It only produces benchmark evidence and a gate assessment.

## 2. Existing foundations reused

O11 must reuse, not replace:

- `OutcomeEvaluator`
- `ModelPerformance`
- `ModelRegistry`
- `shadowExitGate`
- O9 historical scanner replay
- O10 walk-forward/OOS evaluation
- existing governance rule: only a human may activate a model

## 3. Benchmark subject

A benchmark subject is one model key:

`provider/model`

The model must already exist in `ModelRegistry`.

O11 V1 is primarily for models with `shadowMode === true`.

Running a benchmark for an active model is allowed for comparison, but O11 never changes registry state.

## 4. Historical cases

The caller supplies an explicit immutable case set.

Each case records at least:

- `caseId`
- `asOf`
- `domain`
- `subtask`
- source O9/O10 evidence reference
- expected evaluation/outcome reference
- case fingerprint

Case ids must be unique.

The case set is canonicalized by `caseId` for identity, not by result quality.

## 5. Model benchmark evaluator

O11 orchestrates model evaluation through an injected port.

The evaluator receives one model and one case at a time and returns:

```ts
{
  modelKey,
  caseId,
  recommendation,
  confidenceScore,
  score,
  evidenceFingerprint,
  evaluationFingerprint
}
```

`score` is the realized outcome score in `0..1`.

O11 itself does not call a live provider directly. A later adapter may implement this port using stored shadow outputs or a controlled provider call.

## 6. No influence

Benchmark execution must not:

- route production decisions through the shadow model;
- change champion selection;
- activate the model;
- publish scores into the registry automatically;
- create broker orders;
- change capital state.

O11 is measurement only.

## 7. Point-in-time rule

A case may contain only information available at its historical `asOf`.

The benchmark evaluator must not receive future-case outcome data as model input.

The realized outcome is used only after the model output is frozen and only for scoring.

## 8. Case execution sequence

For each case:

1. freeze historical input;
2. obtain/store model output;
3. validate model output identity and schema;
4. only then expose the historical realized outcome to the scoring layer;
5. produce one immutable benchmark observation.

The evaluator must never receive the realized score/outcome before model output is fixed.

## 9. Benchmark result

Version:

`shadow-model-benchmark:v1`

A result contains:

- benchmarkRunId
- inputFingerprint
- modelKey
- model registry identity/reference
- case set identity
- ordered case results
- sample size
- mean raw score
- shrunk performance score
- shadow exit gate assessment
- benchmark evidence fingerprints

## 10. Performance policy

O11 uses the existing `ModelPerformance` policy:

- sample threshold
- neutral prior
- prior weight
- shrunk score

It must not silently introduce another scoring formula.

## 11. Shadow exit gate

O11 reports the existing gate semantics:

- minimum benchmark samples
- minimum benchmark score

The result contains:

```ts
{
  passed: boolean,
  reasons: string[]
}
```

A passed gate means only:

> measured benchmark evidence meets the configured threshold.

It does **not** mean the model becomes active.

Activation still requires a separate explicit human action through `ModelRegistry.activate(...)`.

## 12. Determinism

With the same:

- model key/version
- case set
- model outputs
- realized outcomes
- performance policy
- gate policy

O11 must produce the same:

- case scores
- aggregate score
- gate result
- input fingerprint
- benchmarkRunId

Input order must not change identity.

## 13. Fail-closed conditions

O11 refuses:

- empty case set
- duplicate case ids
- malformed model key
- unknown registry model
- evaluator returns another model key
- evaluator returns another case id
- non-finite score
- score outside `0..1`
- invalid confidence score
- invalid fingerprints
- duplicate evaluation identity
- future outcome exposed before model output
- inconsistent model/version evidence
- tampered case evidence
- non-deterministic evaluator output for identical case request

## 14. Comparison

V1 may benchmark multiple models independently, but a benchmark result itself is per model.

A separate comparison helper may rank benchmark results only when:

- case sets are identical
- case fingerprints are identical
- policies are identical
- sample sizes are identical

No comparison is valid across different historical case sets.

## 15. Activation recommendation

O11 may report:

- `GATE_PASSED_HUMAN_REVIEW_REQUIRED`
- `GATE_FAILED`

It must never report or perform `ACTIVATED`.

## 16. RED test matrix

Before implementation, tests must prove:

1. all cases are evaluated exactly once
2. case input order does not change identity
3. model output is frozen before outcome scoring
4. evaluator never receives realized outcome
5. scores outside 0..1 fail closed
6. wrong model key from evaluator fails closed
7. wrong case id fails closed
8. duplicate case ids fail before evaluator calls
9. unknown model fails before evaluator calls
10. benchmark does not change registry shadowMode
11. benchmark does not write champion changes
12. sample count is exact
13. shrunk score uses existing performance policy
14. gate fails below minimum sample size
15. gate fails below minimum score
16. gate passes only when both thresholds pass
17. passing gate still leaves model in shadow mode
18. repeated identical benchmark is deterministic
19. changing one historical case changes benchmark identity
20. two models can be compared only on identical case sets
21. mismatched comparison case sets fail closed
22. existing O10/O9/governance tests remain green

## 17. Persistence

V1 may begin with an immutable in-memory result store following the same append-only/sealed pattern as O9.

PostgreSQL persistence is a follow-up unless it can be added without widening this PR substantially.

## 18. Four-eyes review target

Independent review should specifically attack:

- leakage of realized outcome into model input
- accidental registry activation
- benchmark score manipulation
- mismatched case-set comparison
- sample-size inflation
- duplicate cases
- fingerprint substitution
- gate semantics differing from `shadowExitGate`

## 19. Safety

O11 is measurement only.

Live Trading, Broker Orders and Physical Purchase remain LOCKED.

## 16. Review amendments

An independent review (`docs/HAIKU_O11_REVIEW_TASK.md`) found the following and changed the implementation. The behaviour below supersedes earlier wording in this document.

- Results are verified. `verifyShadowModelBenchmarkResult` recomputes every fingerprint a result states (case, output, score, case set and identity), the sample size, the mean and shrunk scores, the gate and `gateAsOf` from the case evidence alone. A benchmark verifies its own output before returning it, and `compareShadowBenchmarks` verifies every input before comparing. A result that fails verification is refused with `INVALID_RESULT`.
- Each case result carries the fields its `caseFingerprint` binds: `asOf`, `domain`, `subtask`, `modelInputFingerprint`, `outcomeFingerprint` and `knownAt`.
- Availability is point-in-time. An observation becomes available at `max(asOf, knownAt)`, where `knownAt` is the outcome's `knownAt` (a canonical UTC instant that every outcome must carry). The gate is evaluated at the latest availability, recorded as `gateAsOf`. The shrinkage formula and `shadowExitGate` are unchanged. The statistics run over the benchmark's own in-process evidence store, not `NexusMemory`, so a benchmark writes no performance record to shared memory.
- Payloads must be exactly what their fingerprints bind. `modelInput` and `outcome` may contain only plain JSON objects and dense arrays of finite numbers, strings, booleans and null, with enumerable data properties. Other values (dates, bigints, `undefined`, functions, getters, class instances, proxies, cycles, symbols, NaN and infinities) are refused with `INVALID_CASES`.
- Identical evidence counts once. Two cases with the same `asOf`, `domain`, `subtask`, input fingerprint and outcome fingerprint are refused, whatever their case ids.
- Times are canonical. `asOf` and `knownAt` must be ISO UTC instants with milliseconds and a `Z`. Other spellings of the same instant are refused.
- Model keys may not contain whitespace or control characters. Policy errors use the code `INVALID_POLICY`.

Known limits, unchanged on purpose:

- Fingerprints bind consistency; they do not authenticate. A scorer or evaluator that returns self-consistent output is accepted, so the scores are only as trustworthy as the scorer.
- The result has no registry reference, so the registry entry that was measured cannot be proven from the result (section 9 asks for one).
- Equal shrunk scores are ordered by model key. The order is deterministic but carries no evidence of superiority.
- The registry accepts model names containing `/`, while the benchmark refuses such keys (fail-closed). Those models cannot be benchmarked.
- Realized values placed inside `modelInput` cannot be detected structurally. Only the `outcome` field is isolated.
