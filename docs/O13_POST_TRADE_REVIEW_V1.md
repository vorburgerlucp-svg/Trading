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

## 24. Independent review amendment (Haiku, branch `feature/o13-haiku-review-hardening-v1`)

This section records what the independent review enforced on top of §19, how classification and calibration changed, and which trust limits remain. It is the authoritative description of V1 behaviour where it differs from the sections above.

### 24.1 Additional refusals

Trace:
- evidence available after `asOf` is refused unless it is an excluded `not_yet_available` item; availability never precedes observation;
- evidence ids are unique; a look-ahead id in `excludedLookAhead` must be `not_yet_available` evidence in the trace;
- the record cites only usable evidence that resolves to the trace inputs, never quarantined evidence, and cites every usable item;
- record and decision agree on `finalAction`, `reasonCodes` and the capital state reference; the capital state is read at or before `asOf`;
- decision and `humanApproval` agree on whether approval is required, and the approval status matches it;
- the record's model runs are exactly the runs of the recorded attempts;
- a calibration method requires a probability and a probability requires a method; both must be within range.

Outcome:
- a trade cannot open before its decision;
- a bullish stop sits below entry and a bullish target above it;
- a bearish trade cannot carry a stop or target, because stop and target semantics are long-only;
- fees are non-negative Rappen, net result is Rappen, `executed` is a boolean.

Performance:
- a stored score must equal the OutcomeEvaluator rule (`scoreAttempt`) for its attempt. Any other value in range is refused.

Policy:
- `minimumEvidenceCountForStrong` is at least 1.

### 24.2 Process classification

- Evidence impact on the decision makes the process `PROCESS_WEAK`, not merely not strong.
- A quant assessment that contradicts the decision makes it `PROCESS_WEAK`.
- A required human approval that is still pending caps the grade at `PROCESS_ACCEPTABLE`.
- A plan step whose own model count or provider diversity is unmet by successful, non-shadow answers makes it `PROCESS_WEAK`.
- `evidenceCount` counts usable evidence only. Look-ahead items are not counted.

All process gates read the trace only. The realized outcome never enters process grading (§4).

### 24.3 Calibration and attribution

- A flat move (`|returnBp| <= FLAT_BAND_BP`) carries no direction label. It produces no Brier diagnostic and `directionCorrect` is `null`.
- A calibrated probability is attributed, and enters `calibrationDiagnostics`, only for an analyst buy or sell on a non-flat move (`recommendation_direction_correct:v1`). For hold/no_trade, critic, counter-analyst and flat moves, the attribution's probability and method are `null`.
- Raw confidence is never a probability (unchanged).

### 24.4 Identity

- Set-like lists are canonicalized by sorting and are not deduplicated. A duplicated entry changes the trace, so it changes the identity.
- Routing fallbacks keep their order. The fallback chain decides which model is tried next, so reordering it is a different decision. Primaries and shadow models are set-like.
- Plan steps and pipeline order, attempt order, model-run order and blackboard entry ids keep their order.

### 24.5 Trust limits that remain

1. **Quarantined evidence in the Brain.** The Brain lists quarantined external text in `record.evidenceRefs`. O13 refuses such traces (fail-closed). The fix belongs in the Brain, which this review did not change.
2. **Executed outcome versus execution gate.** The real fixture trace is a `NO_ACTION` decision with `paperIntentAllowed: false`, and it carries an executed trade. §19's "inconsistent execution gate state" is not enforced yet, because enforcing it breaks the fixture-based tests. Until it is enforced, `executed` is reported, not verified against the trace.
3. **Counterfactual net result.** For `executed: false`, `netResultChf` is supplied by the caller and is not reconciled with fees or prices. It is reported as given and must not be read as realized profit.
4. **Trace authenticity.** The review binds the trace it was built from through fingerprints, and `verifyPostTradeReview` recomputes from the supplied source. Nothing seals or signs the trace. A consistent but fabricated trace is accepted; a reissued review without its source cannot be verified against the truth.
5. **Reference timing.** Quant, scanner and backtest run ids carry no timestamps in the trace, so their point-in-time validity is not checked here.
6. **Instrument binding.** The outcome's `instrumentId` is not bound to the decision's opportunity, because the trace holds no instrument id.
7. **Directional scope.** Stop and target envelopes are checked for bullish and bearish decisions. Neutral and contested decisions pass without an envelope check.
8. **Shared scoring rule.** The review reuses the evaluator's scoring rule, so an error in that rule is invisible to the review's own checks. It is covered by the evaluator's tests only.
9. **Requirement without step.** A plan that requires a critic or counter-analysis but has no such step is graded `PROCESS_WEAK` through the observed-participation check, not through a plan-step shortfall.

### 24.6 Test changes in the review

No assertion was weakened or removed. Three existing tests and one shared helper were corrected, each because the setup violated an invariant the Brain itself keeps:
- two look-ahead tests listed excluded ids that were not part of `inputs.evidence`; those items are now present as `not_yet_available` evidence;
- the test with the arbitrary performance score `0.123` asserted that the score was copied through. It now asserts the evaluator's own score, and P7 refuses any other value;
- `strongTrace` removes the critic and counter-analyst steps together with their requirements, and sets the analyst step to one model and one provider. The base fixture is a committee plan with two analysts of which one answered, so it is `PROCESS_WEAK` under the new shortfall rule.

One regression test was added: routing fallback order changes the review id.
