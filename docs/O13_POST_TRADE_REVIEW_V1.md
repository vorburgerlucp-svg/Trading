# O13: Post-Trade Review & Learning Feedback V1

Status: design first. Base: `988648a` (O12 Point-in-Time Confidence Calibration V1 merged and green).

## 1. Goal

O13 creates a deterministic post-trade review artifact that links:

- the original decision trace;
- what information was known at decision time;
- the model/quant/risk/capital reasoning used then;
- the realized trade outcome;
- the existing OutcomeEvaluator result;
- model-performance observations;
- optional calibrated-confidence evidence from O12;
- candidate learning feedback.

The central rule is:

> Outcome quality and decision-process quality are different things.

A profitable trade does not automatically prove the decision process was good, and a losing trade does not automatically prove it was bad.

## 2. Existing foundations reused

O13 must reuse rather than duplicate:

- `DecisionTrace`
- `TradeOutcome`
- `TradeEvaluation`
- `OutcomeEvaluator`
- `PerformanceObservation`
- O9/O10 historical evidence references already stored on the decision
- O11 shadow benchmark evidence where available
- O12 calibrated probabilities where already present on model attempts

O13 does not re-run backtests, models, scanner, quant or calibration.

## 3. Scope

V1 produces a structured review artifact for one completed trade decision.

It must support both:

- executed trades;
- counterfactual/non-executed trade outcomes.

Physical-commerce reviews are deferred to a later version.

## 4. No outcome hindsight in process grading

Process grading may use only evidence already present in the original `DecisionTrace`.

The realized outcome is allowed to affect:

- outcome grading;
- forecast correctness;
- model-performance attribution;
- calibration diagnostics;
- lesson candidates.

It must not retroactively alter what the decision knew or what the pre-trade process score was.

## 5. Review identity

Version:

`post-trade-review:v1`

A review identity binds at least:

- decisionId
- decision `asOf`
- decision trace fingerprint
- outcome fingerprint
- outcome `knownAt`
- TradeEvaluation fingerprint
- linked performance observation fingerprints
- review policy version

Same inputs produce the same review id.

## 6. Decision trace verification

O13 V1 accepts a `DecisionTrace` but must verify basic internal consistency before review:

- outcome.decisionId equals decision.decisionId;
- task ids align;
- decision asOf is canonical UTC;
- outcome knownAt is canonical UTC and later than decision asOf;
- attempt step ids refer to the plan when required;
- no duplicate successful attempt identity;
- evidence references used by the decision are not rewritten.

O13 does not claim to independently authenticate the full trace. It verifies structural consistency and binds the supplied trace into the review identity.

## 7. Process-quality dimensions

V1 calculates deterministic process diagnostics from pre-outcome evidence.

At minimum:

### Evidence discipline
- cited evidence count
- excluded look-ahead count
- evidence warnings count
- unresolved blocking evidence impact count

### Independent review
- number of successful non-shadow analyst attempts
- distinct providers
- critic/counter-analysis participation
- required-vs-observed independent opinions

### Quant / empirical support
- quant status
- quant run linked or absent
- scanner run linked or absent
- backtest run count

### Risk discipline
- risk gate passed/failed
- unresolved blocking or major findings
- human approval required
- execution gate state

### Capital discipline
- potential capital impact
- recommended allocation when present
- allocation skip reasons
- capital state reference present

These diagnostics are descriptive first. V1 must not invent a single opaque “AI quality score”.

## 8. Process classification

O13 V1 may classify the process into:

- `PROCESS_STRONG`
- `PROCESS_ACCEPTABLE`
- `PROCESS_WEAK`
- `PROCESS_BLOCKED`

The policy must be explicit and versioned.

A blocked process can never be upgraded merely because the trade later made money.

## 9. Outcome classification

Using the existing `TradeEvaluation`:

- `OUTCOME_FAVORABLE`
- `OUTCOME_FLAT`
- `OUTCOME_ADVERSE`

The flat band must reuse `FLAT_BAND_BP`.

Executed/non-executed status is reported separately.

## 10. Decision-vs-outcome matrix

Each review records one of:

- strong process + favorable outcome
- strong process + adverse outcome
- weak process + favorable outcome
- weak process + adverse outcome
- blocked process + any outcome
- flat/ambiguous outcome variants

This is intended to reduce outcome bias.

## 11. Forecast attribution

For each successful model attempt, O13 records:

- modelKey
- role
- shadow status
- recommendation
- confidenceScore
- calibratedProbability, if present
- realized performance score already produced by OutcomeEvaluator
- whether the model direction/recommendation was directionally correct
- whether a critic warning was useful

O13 must not rescore a model with a different formula than OutcomeEvaluator.

## 12. Confidence calibration diagnostics

When an attempt carries a non-null `calibratedProbability`, O13 may compute a per-attempt Brier contribution only when there is an explicit binary target derivable from the review.

For V1, supported target:

`recommendation_direction_correct:v1`

No Brier contribution is produced for `hold`/`no_trade` unless the binary target semantics are explicitly valid for that recommendation.

Raw confidence alone is never treated as probability.

## 13. Learning feedback

O13 produces candidate feedback categories such as:

- `KEEP_PROCESS`
- `REVIEW_EVIDENCE_QUALITY`
- `REVIEW_MODEL_CONFIDENCE`
- `REVIEW_STOP_PLACEMENT`
- `REVIEW_TARGET_PLACEMENT`
- `REVIEW_RISK_DISCIPLINE`
- `REVIEW_PROVIDER_DIVERSITY`
- `REVIEW_QUANT_SUPPORT`
- `REVIEW_EXECUTION_VS_THESIS`

Each feedback item contains:

- code
- severity
- evidence/reason references
- short deterministic explanation
- whether it is process-derived, outcome-derived or both

## 14. No automatic self-modification

O13 V1 must not:

- change scanner parameters;
- change risk policy;
- change allocation policy;
- activate/deactivate models;
- change champion/challenger state;
- retrain models;
- modify calibration bins;
- place broker orders;
- unlock live trading.

Feedback is advisory evidence only.

## 15. OutcomeEvaluator interaction

O13 should consume an already-produced:

- `TradeEvaluation`
- `PerformanceObservation[]`

rather than calling `OutcomeEvaluator.evaluate(...)` internally.

This keeps side effects (memory, performance writes, audit writes) outside the pure review function.

## 16. Pure review core

The core function should be pure:

```ts
buildPostTradeReview({
  trace,
  outcome,
  evaluation,
  performanceObservations,
  policy
}) -> PostTradeReview
```

No database writes, memory writes or network calls.

Persistence can wrap the pure result later.

## 17. Review result

The result should contain at least:

- reviewId
- engineVersion
- inputFingerprint
- decisionId
- decisionAsOf
- outcomeKnownAt
- executed
- instrumentId
- processClassification
- outcomeClassification
- processDiagnostics
- outcomeDiagnostics
- attemptAttribution
- calibrationDiagnostics
- feedback
- source fingerprints/references

## 18. Determinism

Input ordering must not change identity where ordering is semantically irrelevant.

Preserve semantically meaningful order where it matters:

- model attempt execution order may be retained for audit;
- set-like references should be canonicalized for identity.

## 19. Fail-closed conditions

O13 refuses:

- outcome for another decision;
- malformed/non-canonical timestamps;
- outcome known before or at decision time;
- malformed trade prices/result structure;
- evaluation that does not correspond to the supplied outcome;
- performance observation for another decision;
- duplicate performance observation identity;
- performance observation for a model/attempt not present in the trace;
- non-finite confidence/probability;
- calibrated probability outside 0..1;
- inconsistent execution gate state;
- malformed review policy.

## 20. RED test matrix

Before implementation, tests should prove at least:

1. same inputs produce same review id
2. outcome must belong to decision
3. outcome knownAt must be after decision asOf
4. review does not mutate trace/outcome/evaluation
5. profitable outcome cannot upgrade a blocked process
6. adverse outcome cannot downgrade a structurally strong process by itself
7. look-ahead exclusions remain visible in diagnostics
8. quant/scanner/backtest references are preserved
9. provider diversity is counted deterministically
10. required independent-opinion shortfall is reported
11. critic participation is reported
12. risk gate state is preserved
13. execution gate remains non-live
14. counterfactual outcome is distinguished from executed outcome
15. outcome classification reuses FLAT_BAND_BP
16. performance observations must belong to the decision
17. performance observations must map to trace attempts
18. duplicate performance observations fail closed
19. OutcomeEvaluator score is reused, not recomputed differently
20. raw confidence is never used as a probability
21. calibrated probability outside 0..1 fails closed
22. valid calibrated probability yields Brier contribution only for supported target semantics
23. hold/no_trade does not silently get a binary calibration target
24. feedback never changes policy/config/model state
25. input order of set-like references does not change identity
26. changing the realized outcome changes review identity
27. changing only review-irrelevant array insertion order does not change identity
28. tampered evaluation inconsistent with outcome fails closed
29. successful executed trade with weak process stays weak-process/favorable-outcome
30. failed trade with strong process stays strong-process/adverse-outcome
31. O12/O11/O10/O9 and existing governance tests remain green

## 21. Four-eyes review target

Independent review should attack:

- outcome bias leaking into process classification
- duplicated or missing model attribution
- calibrated-probability misuse
- counterfactual-vs-executed confusion
- tampered outcome/evaluation pair
- feedback that accidentally mutates system state
- non-deterministic identity
- future evidence leaking into pre-trade process diagnostics

## 22. Persistence

V1 may return a verified immutable review artifact in memory.

Append-only sealed persistence is a follow-up before reviews drive automated learning.

## 23. Safety

O13 is analysis and learning feedback only.

Live Trading, Broker Orders and Physical Purchase remain LOCKED.
