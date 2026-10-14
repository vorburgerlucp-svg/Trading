# Haiku independent review task: O12 Point-in-Time Confidence Calibration V1

Base under review: `feature/o12-pit-confidence-calibration-v1` at `4e0f803`.
Review branch: `feature/o12-haiku-review-hardening-v1`.

## Purpose

Act as an independent second developer/reviewer. Do not assume O12 is correct because the feature-branch CI is green.

Review:

- `src/ai/pit-confidence-calibration.ts`
- `test/ai/o12-pit-confidence-calibration.test.ts`
- `docs/O12_PIT_CONFIDENCE_CALIBRATION_V1.md`
- existing `src/ai/calibration.ts` compatibility

PR #11 is the merge candidate. Do not merge it.

## Core guarantees to attack

1. Outcomes with `knownAt > fitAsOf` must not influence fitted bins.
2. Changing only future-known outcome contents must not change the fitted model identity.
3. `knownAt < asOf` must fail closed.
4. Only explicit binary `outcomeLabel: 0 | 1` may be a calibration target.
5. O11 performance scores must not be implicitly interpreted as probabilities.
6. Duplicate observation ids must not inflate sample size.
7. Duplicate calibration evidence under another id must not inflate sample size.
8. Input ordering must not affect fit identity.
9. Histogram boundaries must be exact:
   - non-last bins are [lower, upper)
   - last bin includes 1.
10. Empty and under-sampled bins must not invent probabilities.
11. `INSUFFICIENT_SAMPLES` must not act like a fitted model.
12. A fitted model must be self-verifiable from its stored fit evidence.
13. Tampered bin counts/positives/probabilities must be refused.
14. Tampered fit evidence must be refused.
15. Tampered policy, target, input/model fingerprint or run id must be refused.
16. A calibration model must never apply to another model key.
17. Evaluation must not reuse fit evidence, even under another observation id.
18. Future-known evaluation outcomes must be excluded.
19. Brier score denominator must include only covered OOS observations.
20. Coverage rate must be exact.
21. Zero coverage must return null quality metrics rather than invented zeros.
22. Existing `calibrate(...)` semantics must remain unchanged.
23. O12 must not activate models, alter ChampionBoard, route decisions, alter capital, place broker orders or unlock live trading.

## High-priority PIT adversarial review

Please investigate these specifically:

### A. Future-data influence beyond outcome values

Check whether future observations can affect the current fit through:

- their existence/count;
- malformed future outcome labels;
- malformed future evidence fingerprints;
- duplicate future evidence;
- future observation ids;
- future ordering.

Decide whether any such influence violates the documented point-in-time contract. If so, add reproducing RED tests and fix it.

### B. Excluded-future count identity

The result records `excludedFutureSampleCount`.

Check whether including this count in `inputFingerprint` / `modelFingerprint` means adding an otherwise invisible future observation changes the calibration identity despite identical eligible fit evidence.

Determine the safest semantics:
- fitted-model identity based only on information eligible at `fitAsOf`; and/or
- separate request/audit identity if excluded rows must be accounted for.

Do not silently choose convenience over PIT correctness.

### C. Evidence identity

Attack the duplicate-evidence rule by changing:

- observationId only;
- external `evidenceFingerprint` only;
- knownAt only;
- equivalent numeric values;
- case ordering.

Check whether sample inflation is still possible.

### D. Self-verification limits

The verifier has eligible fit evidence but does not retain excluded future observations.

Identify which result fields can and cannot be independently recomputed.

If a field is audit metadata rather than independently verifiable, document that explicitly or redesign the artifact so the distinction is clear.

### E. Histogram and numeric edge cases

Attack:

- confidence exactly 0;
- exactly 1;
- every interior edge;
- very close floating-point values around an edge;
- `-0`;
- NaN / Infinity;
- malformed edges;
- huge bin counts;
- probability fractions such as 1/3;
- sample count overflow assumptions.

### F. Evaluation leakage

Attack:

- fit evidence reused with a new observation id;
- fit evidence reused with changed `knownAt`;
- same underlying evidence but changed external fingerprint;
- evaluation `asOf` before model `fitAsOf`;
- evaluation observation decision time after evaluation `asOf`;
- outcome known exactly at evaluation `asOf`;
- empty eligible evaluation set;
- all eligible rows uncovered;
- mixed covered/uncovered/future rows.

### G. Tamper/reissue attacks

Try re-issuing hashes after modifying:

- bins;
- policy;
- fit evidence;
- target id/version;
- model key;
- excluded-future count;
- status;
- sample size.

A verifier should refuse structurally impossible states even if a forger recomputes superficial hashes.

## Mutation testing

Run focused mutation testing if practical.

Try disabling each major validation or derivation branch. Restore source exactly after each mutant/campaign.

Classify survivors as:

- real test gap;
- equivalent mutant;
- redundant guard.

## Scope restrictions

Do not change:

- O9 replay/persistence;
- O10 walk-forward/OOS;
- O11 benchmark/governance;
- ModelRegistry activation semantics;
- ChampionBoard;
- capital engine;
- broker adapters;
- live-trading locks.

If you find an issue outside O12, document it with file/function and risk instead of widening this branch.

## Delivery

- Work only on `feature/o12-haiku-review-hardening-v1`.
- Commit in small reviewable steps.
- Do not weaken or remove existing tests.
- Run full `npm run check`.
- Push only after the final full check is green.
- Do not merge PR #11.

Report:

1. commit hashes
2. files changed
3. full test count
4. mutation campaign result, if run
5. bugs found with severity
6. fixes made
7. guarantees already held and newly pinned
8. unresolved risks
9. recommendation: MERGE / MERGE NACH FIX / REJECT
