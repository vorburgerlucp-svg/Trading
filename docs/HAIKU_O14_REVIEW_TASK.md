# Haiku independent review task: O14 Trading Tutor & Pattern Quiz V1

Base under review: `feature/o14-trading-tutor-pattern-quiz-v1` at `81406cc`.
Review branch: `feature/o14-haiku-review-hardening-v1`.

PR #13 is the merge candidate. Do not merge it.

## Review scope

Review:

- `src/learning/trading-tutor.ts`
- `src/learning/pattern-quiz.ts`
- `test/learning/o14-trading-tutor-pattern-quiz.test.ts`
- `docs/O14_TRADING_TUTOR_PATTERN_QUIZ_V1.md`

Read-only dependencies to understand contracts:

- `src/evaluation/post-trade-review.ts`
- `src/patterns/pattern-types.ts`
- `src/patterns/pattern-engine.ts`

Do not widen the implementation into persistence, learner scoring, model routing or trading execution.

## Purpose

Act as an independent second developer/reviewer. Assume O14 may be wrong even though feature CI is green.

O14 has two trust boundaries:

1. Tutor must teach only what the O13 review supports, without reintroducing outcome bias.
2. Pattern Quiz must never leak future pattern lifecycle information into the learner-visible question or its point-in-time identity.

## Trading Tutor invariants to attack

1. Weak process + favorable outcome must remain a cautionary process lesson.
2. Strong process + adverse outcome must remain process-positive.
3. Blocked process must never be praised because the trade made money.
4. Tutor must independently refuse an O13 process classification inconsistent with the embedded diagnostics/policy.
5. Tutor must not silently reinterpret O13 feedback codes.
6. Raw confidence must never be taught as a probability.
7. Corrupt/non-finite calibration diagnostics must fail closed.
8. Lesson identity must bind the source review and tutor policy.
9. Learner level must be identity-relevant.
10. Objective/reflection limits must be enforced.
11. Tampered stored lesson must fail verification.
12. Lesson must contain no action field that can place/route a trade.
13. Builder/verifier must be pure and side-effect free.

## Pattern Quiz invariants to attack

1. `publicView` must not expose:
   - source `patternType` except as one unlabeled multiple-choice option;
   - source `direction` except as one unlabeled option in direction mode;
   - source `status` except as one unlabeled option in lifecycle mode;
   - target outcome;
   - later `confirmedAt`, `invalidatedAt`, `resolvedAt`;
   - later confirmation level/direction/bar time;
   - future anchors.
2. Future-only source changes must not alter the current quiz id/input fingerprint when they do not change visible evidence or the answer known at the observation `asOf`.
3. Pattern identification uses only the source pattern type as the internal correct answer.
4. Direction uses only the source observation direction.
5. Lifecycle uses only a status demonstrably valid by the observation `asOf`.
6. Correct answer appears exactly once.
7. Option ids and labels are unique.
8. Distractors are deterministic and valid vocabulary members.
9. No RNG/wall-clock dependence.
10. Grade function refuses unknown option ids.
11. Quiz verifier recomputes from the source observation, not from stored quiz hashes alone.
12. Hidden answer/explanation may exist in the internal artifact but must not appear in `publicView`.

## High-priority adversarial review

### A. Future lifecycle leakage

Attack future values independently:

- `confirmedAt`
- `invalidatedAt`
- `resolvedAt`
- `confirmation.confirmedByBarTime`
- `confirmation.direction`
- `confirmation.level`
- anchors whose `time` is <= asOf but `confirmedAt` is after asOf
- anchors whose `time` itself is after asOf

Change only future values while keeping current pattern identity/answer stable.

Check both:

- serialized `publicView`
- `visibleEvidenceFingerprint`
- `inputFingerprint`
- `quizId`

If a future-only value changes current identity, treat it as PIT leakage unless there is a documented reason.

### B. Indirect answer leakage

The public view may not contain fields named `patternType`, `direction` or `status`, but other fields can trivially reveal them.

Review:

- anchor role names such as `head`, `left_shoulder`
- boundary names such as `neckline`
- invalidation rule strings
- chart context
- confirmation direction in non-direction modes
- geometry metric names

Decide which clues are legitimate quiz evidence and which amount to serializing the answer itself.

Do not overcorrect: pattern-identification questions necessarily need pattern geometry. The goal is no direct metadata answer leak.

### C. Lifecycle correctness

Attack combinations such as:

- status `forming` with earlier `confirmedAt`
- status `confirmed` with no confirmation time
- status `completed` with no `resolvedAt`
- `invalidated` with no `invalidatedAt`
- `resolvedAt < confirmedAt`
- `confirmedAt < firstSeenAt`
- multiple mutually exclusive terminal timestamps
- timestamps exactly equal to `asOf`
- one millisecond after `asOf`

Pin only rules supported by Pattern Engine lifecycle semantics; document any trust boundary you cannot prove from `PatternObservation` alone.

### D. Observation runtime validation

Attack malformed runtime values despite TypeScript:

- invalid interval/series
- duplicate anchor roles
- negative/non-integer barIndex
- malformed decimal strings
- malformed boundary/metric objects
- non-canonical anchor timestamps
- bad evidence refs
- prototype/getter/class-instance payloads if relevant

Avoid duplicating the entire Pattern Engine validator. Focus on values O14 publishes to learners.

### E. Quiz identity and reissue attacks

Try modifying:

- public prompt
- option ordering
- option labels
- correct option id
- answer label
- explanation
- visible evidence
- source ids
- policy

Then reissue superficial stored fingerprints/ids where possible.

`verifyPatternQuiz(source, quiz)` should recompute from source and refuse.

Also inspect whether the quiz id binds semantically irrelevant hidden future data.

### F. Distractor generation

Attack:

- optionCount = 2, 3, 6
- correct answer at vocabulary beginning/end
- direction vocabulary size 3
- lifecycle vocabulary
- repeated source builds
- seed values producing wrap-around
- duplicate distractors
- correct answer duplicated under another option id

### G. Tutor review consistency

Reproduce O13 process classification from the embedded diagnostics and policy.

Attack:

- STRONG with risk failure
- STRONG with blocking finding
- STRONG with independent-opinion shortfall
- STRONG with plan-step shortfall
- STRONG with required critic missing
- STRONG with quant contradiction
- WEAK with no weak trigger
- BLOCKED with no blocker
- ACCEPTABLE when diagnostics require BLOCKED/WEAK
- malformed O13 policy
- malformed feedback code/severity/basis at runtime

Check whether tutor category mapping loses material O13 feedback.

### H. Outcome-bias language

Review every deterministic sentence template.

Search for wording that could imply:

- profitable = good process;
- loss = bad process;
- confidence justified because result was favorable;
- hindsight-based instruction.

Mutation-test process/outcome combinations if practical.

### I. Pure-core / side-effect boundary

The O14 modules should import only pure types/utilities.

Verify no imports or calls to:

- NexusMemory
- ModelPerformance
- ModelRegistry
- ChampionBoard
- Risk Gate
- Capital Engine
- Broker
- persistence/audit store writers
- network adapters

`hashOf` is allowed as a pure deterministic utility.

### J. Safety boundary

Confirm O14 does not:

- create order intent;
- activate a model;
- change risk policy;
- change capital allocation;
- write calibration;
- unlock live trading;
- unlock physical purchase.

Educational strings must not be interpreted as execution commands by any typed API.

## Mutation testing

Run focused mutation testing if practical.

Prioritize:

- tutor process-classification rederivation;
- feedback-code mapping;
- future timestamp filters;
- future confirmation filters;
- option uniqueness;
- answer membership;
- lifecycle-mode refusal;
- verifier recomputation;
- grading unknown-option refusal.

Classify survivors as:

- real test gap;
- equivalent mutant;
- redundant guard.

Restore source byte-for-byte after mutation campaigns.

## Scope restrictions

Do not change:

- O9 replay/persistence
- O10 walk-forward/OOS
- O11 benchmark
- O12 calibration
- O13 post-trade review
- Pattern Engine detection/lifecycle algorithms
- Model Registry
- ChampionBoard
- Capital Engine
- Broker adapters
- Live Trading locks

If an upstream issue is found, document file/function/risk. Do not widen scope without a clearly required integration fix.

## Delivery

- Work only on `feature/o14-haiku-review-hardening-v1`.
- Keep commits small and reviewable.
- Do not weaken or delete existing tests.
- Run full `npm run check`.
- Push only after final full check is green.
- Do not merge PR #13.

Report:

1. commit hashes
2. files changed
3. full test count
4. mutation result
5. bugs found with severity
6. fixes made
7. guarantees already held/newly pinned
8. unresolved trust/provenance limits
9. recommendation: MERGE / MERGE NACH FIX / REJECT
