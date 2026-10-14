# Haiku independent review task: O11 Shadow Model Benchmark V1

Base under review: `feature/o11-shadow-model-benchmark-v1` at `6d7b0fd9`.
Review branch: `feature/o11-haiku-review-hardening-v1`.

## Purpose

Act as an independent second developer/reviewer. Do not assume the O11 implementation is correct because CI is green.

The implementation under review is:

- `src/evaluation/shadow-model-benchmark.ts`
- `test/evaluation/o11-shadow-model-benchmark.test.ts`
- `docs/O11_SHADOW_MODEL_BENCHMARK_V1.md`

The merge target PR is #10, but do not merge it.

## Review goals

Try to break these guarantees:

1. Realized outcome data must never reach the model evaluator.
2. The model output must be frozen before the scorer receives it.
3. Benchmarking must never activate a model or otherwise mutate registry governance state.
4. Existing `ModelPerformance` shrinkage semantics must be preserved.
5. Existing `shadowExitGate` semantics must be preserved exactly.
6. A passed benchmark may only report `GATE_PASSED_HUMAN_REVIEW_REQUIRED`; never activation.
7. Case input order must not change benchmark identity.
8. Duplicate cases must not inflate sample size.
9. A case's model input fingerprint must bind its model input payload.
10. A case's outcome fingerprint must bind its outcome payload.
11. Model output fingerprint must bind returned model output fields.
12. Scoring fingerprint must bind score + historical outcome + frozen model output.
13. Comparison must reject different case sets.
14. Comparison must reject different benchmark policies.
15. Unknown/unregistered models must fail before evaluator calls.
16. Evaluator substitution of model/case ids must fail.
17. Scorer substitution of model/case ids must fail.
18. NaN/Infinity and scores outside 0..1 must fail closed.
19. Invalid/malformed fingerprints must fail closed.
20. Repeated identical benchmark must be deterministic.
21. No code path may unlock live trading, broker orders or physical purchases.

## Adversarial cases to add

Please add tests for any uncovered cases you find, especially:

- scorer returns another model key;
- scorer returns another case id;
- duplicate model output fingerprint across different cases;
- duplicate scoring fingerprint across different cases;
- tampered modelInput payload with old fingerprint;
- tampered outcome payload with old fingerprint;
- malformed case time;
- malformed model key;
- registry model is active instead of shadow: benchmark may measure it, but still must not mutate it;
- custom performance/champion policy mismatch in comparison;
- same shrunk score in comparison: verify deterministic ordering or identify if fail-closed would be safer;
- scorer mutates the modelOutput it receives;
- evaluator tries to mutate the frozen modelInput;
- scorer tries to mutate the frozen outcome;
- prototype/inherited-property tricks in modelInput/outcome;
- unexpected nested values that canonical hashing cannot encode;
- model output fingerprint re-issued after changing a bound field;
- score fingerprint re-issued after changing score/output/outcome;
- two benchmark results forged to share caseSetFingerprint but contain different case-level evidence.

## Mutation testing

Run a focused mutation campaign if practical.

At minimum, try temporarily disabling each major validation branch in `shadow-model-benchmark.ts` and verify that a test catches it.

Restore source exactly after mutation checks.

## Scope restrictions

Do not change:

- O9 replay algorithm or persistence;
- O10 walk-forward/OOS;
- ModelRegistry governance rules;
- ChampionBoard promotion semantics;
- live-trading locks;
- broker adapters;
- capital engine.

If you find a bug outside O11, document it instead of changing unrelated files.

## Delivery rules

- Work only on `feature/o11-haiku-review-hardening-v1`.
- Commit in small, reviewable steps.
- Keep existing tests; do not weaken assertions.
- Run full `npm run check`.
- Push only when full check is green.
- Do not merge PR #10 or any branch.

Report:

- commit hashes;
- files changed;
- full test count;
- any mutation-testing result;
- every bug or risk found;
- what you changed;
- unresolved risks;
- whether you recommend merge, merge-after-fix, or reject.
