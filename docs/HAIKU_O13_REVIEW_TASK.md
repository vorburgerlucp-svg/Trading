# Haiku independent review task: O13 Post-Trade Review & Learning Feedback V1

Base under review: `feature/o13-post-trade-review-v1` at `da35cb8`.
Review branch: `feature/o13-haiku-review-hardening-v1`.

## Purpose

Act as an independent second developer/reviewer. Do not assume O13 is correct because feature CI is green.

Review:

- `src/evaluation/post-trade-review.ts`
- `test/evaluation/o13-post-trade-review.test.ts`
- `docs/O13_POST_TRADE_REVIEW_V1.md`
- the contracts consumed from:
  - `src/evaluation/outcome-evaluator.ts`
  - `src/nexus/nexus-types.ts`
  - `src/ai/model-performance.ts`

PR #12 is the merge candidate. Do not merge it.

## Core invariants to attack

1. Process classification must depend only on information present before the outcome was known.
2. A favorable outcome must never upgrade a blocked/weak pre-trade process.
3. An adverse outcome must never downgrade a structurally strong pre-trade process by itself.
4. O13 must not recompute model-performance scores using a different scoring rule than OutcomeEvaluator.
5. A supplied TradeEvaluation must exactly correspond to the supplied TradeOutcome.
6. The outcome must belong to the reviewed decision.
7. Trade chronology and price envelopes must be physically consistent.
8. Future evidence must not leak into pre-trade process diagnostics.
9. Performance observations must map unambiguously to successful trace attempts.
10. Duplicate or unmatched observations must fail closed.
11. Raw confidence is never a probability.
12. Calibrated probability may be used only when valid and explicitly calibrated.
13. Brier contribution may be produced only for explicit supported binary target semantics.
14. `hold` / `no_trade` must not silently get a buy/sell direction-correct binary target.
15. Counterfactual and executed outcomes must remain distinguishable.
16. Set-like insertion order must not change review identity.
17. Semantically meaningful model-attempt order must not be erased.
18. The verifier must detect a modified review artifact.
19. Feedback is advisory only and must not mutate any model, policy, risk, routing, capital or execution state.
20. Live Trading, Broker Orders and Physical Purchase remain locked.

## High-priority adversarial review

### A. Future-evidence leakage in DecisionTrace

The current implementation structurally trusts much of the supplied DecisionTrace.

Attack at least:

- `trace.inputs.evidence[].availableAt > decision.asOf`
- `trace.inputs.evidence[].observedAt > decision.asOf`
- quant/scanner/backtest references or lineage whose timestamps are after decision `asOf`
- future evidence inserted into consensus/critic findings
- a future item moved from `excludedLookAhead` into included evidence

Determine what O13 can independently verify from the trace itself and what must remain a documented trust boundary.

If a future timestamp is directly visible in the supplied trace, prefer fail-closed over silently grading it as valid pre-trade evidence.

### B. Process classification semantics

Attack every transition:

- STRONG -> ACCEPTABLE
- ACCEPTABLE -> WEAK
- WEAK -> BLOCKED

Check whether:

- evidence warnings are weighted correctly;
- `decision.evidence.impact` really means “blocking evidence impact” or is being misnamed/misclassified;
- major findings should make the process WEAK;
- risk failure/blocking findings always make it BLOCKED;
- pending required human approval should affect classification;
- execution refusal should or should not affect process grade;
- confirmed/contradicting/missing quant support is handled consistently with the documented policy.

Do not introduce a hidden aggregate score.

### C. Performance-observation trust and attribution

`PerformanceObservation` has no `stepId`.

Attack:

- same model+role used in multiple plan steps;
- same model+role+subtask repeated;
- two observations with different scores for the same attribution tuple;
- arbitrary score changed from the real OutcomeEvaluator score;
- changed `availableAt`;
- changed `shadow`;
- changed domain/subtask;
- observation missing for one successful attempt;
- observation supplied for failed/not-connected attempt.

Decide which issues O13 can prove from the request and which require a stronger source identity in a future version.

Do not invent a step mapping when attribution is ambiguous.

### D. Trace integrity and identity

Attack mismatches among:

- DecisionRecord
- NexusDecision
- AiTask
- TaskPlan
- attempt provider/model/modelKey
- record modelRuns vs attempts/runIds
- capitalStateRef in record/decision/inputs
- finalAction in record vs decision
- reason codes

Check whether a structurally inconsistent trace can still produce a review.

Also test set-like ordering for:

- record evidence refs
- reason codes
- required capabilities/context refs
- input evidence
- excluded look-ahead
- quant backtest ids
- evidence warnings/impact
- lineage backtests/seals if applicable
- routing primaries/fallbacks/shadows/rejections

A reordered serialization of the same semantic trace should not create a new review identity where order is non-semantic.

### E. Outcome integrity

Attack:

- openedAt before decision asOf
- closedAt before openedAt
- knownAt before closedAt
- highest below entry/exit
- lowest above entry/exit
- stopLoss/takeProfit outside valid price domain
- exit or entry zero/negative
- high/low inconsistent with stop/target classifications
- executed=false with contradictory execution/result metadata
- fees/netResult malformed at runtime
- counterfactual outcome with nonzero netResult (decide and document semantics)

### F. Evaluation tamper / reissue

Try modifying one evaluation field and then modifying review hashes/ids consistently.

The review verifier should recompute from the source request, not merely trust hashes in the review.

### G. Calibration semantics

Attack:

- calibrated probability without method;
- method without probability;
- probability NaN/Infinity/out of range;
- raw confidence changed while calibrated probability unchanged;
- sell recommendation label semantics;
- flat return at exactly +/- `FLAT_BAND_BP`;
- buy/sell probability when return is flat;
- hold/no_trade with calibrated probability;
- critic/counter-analyst calibrated probabilities;
- multiple calibrated analyst attempts.

Check Brier denominator and exact binary label semantics.

### H. Outcome-bias isolation

Mutation-test or directly patch the implementation to make process classification depend on:

- returnBp;
- netResultChf;
- executed;
- directionCorrect.

Existing tests should catch each. Add tests if they do not.

### I. Side-effect boundary

The pure builder must have no imports or calls that can mutate:

- NexusMemory
- ModelPerformance
- ModelRegistry
- ChampionBoard
- risk policy
- capital ledger
- broker
- audit store

Verify source-level dependencies and add a regression guard if practical.

## Mutation testing

Run a focused mutation campaign if practical.

Prioritize:

- validation branches;
- process classification gates;
- outcome classification boundaries;
- attribution uniqueness;
- calibrated-probability guards;
- identity normalization;
- verifier recomputation.

Classify survivors as:
- real test gap;
- equivalent mutant;
- redundant guard.

Restore production source byte-for-byte after mutation campaigns.

## Scope restrictions

Do not change:

- O9 replay/persistence;
- O10 walk-forward/OOS;
- O11 benchmark;
- O12 calibration fitting/evaluation;
- ModelRegistry governance;
- ChampionBoard;
- Capital Engine;
- Broker adapters;
- Live Trading locks.

If you find a problem outside O13, document it with file/function and risk rather than widening this branch.

## Delivery

- Work only on `feature/o13-haiku-review-hardening-v1`.
- Keep commits small and reviewable.
- Do not weaken/remove existing tests.
- Run full `npm run check`.
- Push only after final full check is green.
- Do not merge PR #12.

Report:

1. commit hashes
2. files changed
3. full test count
4. mutation campaign result
5. bugs found with severity
6. fixes made
7. guarantees already held and newly pinned
8. unresolved trust/provenance limits
9. recommendation: MERGE / MERGE NACH FIX / REJECT
