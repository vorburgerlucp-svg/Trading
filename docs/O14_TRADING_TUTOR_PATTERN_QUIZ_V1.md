# O14: Trading Tutor & Pattern Quiz V1

Status: design first. Base: `2fee858` (O13 Post-Trade Review & Learning Feedback V1 merged and green).

## 1. Goal

O14 adds two read-only learning surfaces:

1. **Trading Tutor** — converts verified O13 post-trade reviews into deterministic teaching material.
2. **Pattern Quiz** — turns historical, point-in-time pattern observations into answerable training questions without revealing future resolution data before the answer.

The central rule is:

> O14 teaches from already verified evidence. It does not change trading behavior.

## 2. Existing foundations reused

O14 must reuse rather than duplicate:

- O13 `PostTradeReview`
- O13 process/outcome classifications and feedback codes
- Pattern Engine `PatternRun` / `PatternObservation`
- Pattern lifecycle status and point-in-time timestamps
- canonical hashing via `hashOf`

O14 must not re-run models, scanner, quant, pattern detection, backtests, calibration or post-trade evaluation.

## 3. Tutor scope

Input:

- one verified O13 review;
- optional learner profile containing only non-sensitive learning progress fields;
- explicit tutor policy.

Output:

- deterministic lesson id;
- concise lesson title;
- 1–3 learning objectives;
- key facts from the review;
- process-vs-outcome explanation;
- mistakes/strengths grounded in O13 feedback;
- 1–3 reflection questions;
- references back to review fields.

The tutor must never invent a claim not present in the review.

## 4. Outcome-bias guard

Tutor wording must preserve O13 semantics:

- profitable + weak process is not praised as a good decision process;
- losing + strong process is not called a bad process merely because of the result;
- blocked process remains blocked whatever the outcome.

## 5. Tutor determinism

Same:

- review identity;
- policy;
- learner level;

must produce the same lesson identity and same deterministic structured lesson.

Free-form LLM prose is outside V1.

## 6. Tutor policy

Version:

`trading-tutor-policy:v1`

At minimum:

- learnerLevel: `beginner | intermediate | advanced`
- maxLearningObjectives
- maxReflectionQuestions
- includeCalibrationDiagnostics
- includeExecutionDiagnostics

Policy must be validated and part of lesson identity.

## 7. Tutor lesson categories

V1 lesson categories may include:

- `PROCESS_DISCIPLINE`
- `EVIDENCE_QUALITY`
- `RISK_DISCIPLINE`
- `MODEL_CONFIDENCE`
- `QUANT_SUPPORT`
- `EXECUTION_VS_THESIS`
- `STOP_TARGET_REVIEW`
- `KEEP_PROCESS`

Categories are derived from O13 feedback codes.

## 8. Tutor safety

Tutor output is educational.

It must not:

- issue a live trade instruction;
- tell the user to place an order;
- change risk limits;
- change model weights;
- activate/deactivate models;
- alter calibration;
- alter capital allocation.

## 9. Pattern Quiz scope

Input:

- one point-in-time `PatternObservation`;
- one explicit quiz policy;
- optional quiz mode.

Output:

- deterministic quiz id;
- pattern observation reference;
- prompt;
- multiple-choice options;
- correct answer;
- explanation;
- evidence shown before answer;
- evidence revealed only after answer.

## 10. Quiz modes

V1 supports:

### Pattern identification
Question: identify the pattern type.

### Direction
Question: infer bullish/bearish/neutral direction where the observation supports one.

### Lifecycle
Question: identify the current status using only evidence available at the quiz `asOf`.

Future resolution questions are not allowed unless the quiz explicitly operates after the corresponding `resolvedAt`.

## 11. Anti-leakage

The quiz must never expose future information in its pre-answer payload.

Before-answer payload must not include:

- `confirmedAt` if confirmation occurs after quiz asOf;
- `invalidatedAt` if later;
- `resolvedAt` if later;
- future bars;
- target outcome after quiz asOf;
- any answer rationale that reveals future lifecycle state.

The correct answer and explanation may be stored internally in the quiz artifact, but the public/pre-answer view must be separately generated and verified not to contain it.

## 12. Quiz identity

Version:

`pattern-quiz:v1`

Identity binds:

- exact patternObservationId;
- patternInstanceId;
- pattern type;
- observation asOf;
- quiz mode;
- quiz policy;
- visible evidence fingerprint;
- answer fingerprint.

Same inputs must produce same quiz id.

## 13. Quiz distractors

Distractors must be deterministic and drawn from a fixed, versioned vocabulary.

No randomization in V1.

Distractors must:

- be valid pattern labels/directions/statuses;
- never duplicate the correct answer;
- remain stable for identical input;
- avoid introducing nonexistent future information.

## 14. Quiz policy

Version:

`pattern-quiz-policy:v1`

At minimum:

- mode;
- optionCount;
- learnerLevel;
- revealGeometryMetrics;
- revealChartContext;
- revealLifecycleTimestampsAvailableByAsOfOnly.

## 15. Answer evaluation

A pure function evaluates:

`gradePatternQuiz(quiz, submittedOptionId)`

Result:

- correct boolean;
- selected answer;
- correct answer;
- deterministic explanation;
- quiz identity.

No learner score is persisted in V1.

## 16. No hidden future target

Pattern lifecycle artifacts may contain fields that were produced from a later walk.

O14 must build the visible question from the observation's declared decision-time/asOf state, not by serializing the whole observation into the prompt.

A verifier must inspect the visible quiz payload independently.

## 17. Artifact verification

V1 exposes:

- `verifyTradingTutorLesson(review, lesson)`
- `verifyPatternQuiz(observation, quiz)`

Verifiers recompute deterministic artifacts from their sources.

They do not merely trust stored fingerprints.

## 18. Pure-core requirement

Tutor and quiz builders are pure.

No runtime imports from:

- NexusMemory
- ModelPerformance
- ModelRegistry
- ChampionBoard
- Risk Gate
- Capital Engine
- Broker
- audit/persistence stores
- network providers

## 19. Fail-closed conditions

Tutor refuses:

- malformed/unsupported O13 review version;
- malformed tutor policy;
- non-finite calibration diagnostics;
- review fields inconsistent with O13 classifications where independently checkable.

Quiz refuses:

- malformed pattern observation;
- malformed/non-canonical times;
- quiz asOf before pattern firstSeenAt;
- requested lifecycle fact not known by quiz asOf;
- invalid mode for the observation;
- duplicate options;
- correct answer missing from options;
- future timestamp/data leaking into visible payload;
- malformed policy.

## 20. RED test matrix

Before implementation, tests should prove at least:

### Tutor
1. same review/policy -> same lesson id
2. weak process + favorable outcome remains a cautionary process lesson
3. strong process + adverse outcome remains process-positive
4. blocked process never becomes praise
5. lesson facts are sourced from review only
6. feedback-code mapping is deterministic
7. learner level changes lesson identity
8. policy order does not introduce nondeterminism
9. malformed review version fails closed
10. lesson verifier detects tampering
11. no live-trade instruction field exists
12. pure-core dependency guard passes

### Pattern Quiz
13. same observation/policy -> same quiz id
14. pattern-identification answer equals observation pattern type
15. direction answer uses observation direction only
16. lifecycle answer uses status known at quiz asOf
17. visible payload omits later confirmedAt
18. visible payload omits later invalidatedAt
19. visible payload omits later resolvedAt
20. visible payload never serializes full source observation
21. deterministic distractors
22. no duplicate distractors
23. correct answer appears exactly once
24. grading correct option returns correct=true
25. grading wrong option returns correct=false
26. quiz verifier detects tampering
27. quiz asOf before firstSeenAt fails closed
28. invalid mode fails closed
29. optionCount policy bounds enforced
30. input order of set-like visible refs does not change identity
31. no future bars/outcomes are introduced
32. O13/O12/O11/O10/O9 and existing pattern tests remain green

## 21. Four-eyes review targets

Independent review should attack:

- hidden future timestamps in visible quiz payload;
- outcome-bias language in tutor mappings;
- accidental re-interpretation of O13 feedback;
- deterministic distractor collisions;
- tampered correct answers;
- full observation serialization leaking future lifecycle fields;
- mutable learner state or side effects;
- identity instability.

## 22. Persistence

V1 artifacts may remain in memory.

Persistent learner history, spaced repetition and mastery scoring are follow-up work after the pure artifact contracts are hardened.

## 23. Safety

O14 is educational only.

Live Trading, Broker Orders and Physical Purchase remain LOCKED.

## 24. Independent review amendment (Haiku, branch `feature/o14-haiku-review-hardening-v1`)

This section records what the independent review enforced on top of §11, §16, §17 and §19, which leakage clues it removed and why, and which trust limits remain. Where it differs from the sections above, this section is the authoritative description of V1.

### 24.1 Tutor refusals

The tutor reproduces the O13 classification from the embedded diagnostics and policy, and it re-derives the outcome class from the embedded return:
- the outcome class must equal the class of `returnBp` against O13's flat band (`FLAT_BAND_BP`);
- the process class must equal the O13 rule applied to the diagnostics, including the pending-approval cap;
- process diagnostics must be non-negative integers, flags must be booleans, the execution locks must remain `false`, and the quant and approval statuses must be in their vocabularies;
- every feedback item must carry a known O13 code, a known severity and basis, string references and an explanation; an empty feedback list is refused, since O13 always emits at least `KEEP_PROCESS`;
- `KEEP_PROCESS` cannot accompany a weak or blocked process;
- a calibration diagnostic must name the supported binary target, and its Brier contribution must equal `(probability − label)²`;
- the policy accepts exactly its documented keys.

Feedback is mapped to categories only when the code is known; an unknown code is a refusal, never a silent drop. The fallback that invented a `PROCESS_DISCIPLINE` lesson for an empty category list was removed: after validation the category list is never empty.

`verifyTradingTutorLesson(review, lesson, expectedPolicy?)` takes an optional expected policy. A consumer that expects a policy passes it in, and a lesson re-issued under another policy is refused.

### 24.2 Quiz validation

Lifecycle quizzes (where the status is the answer) require the status to be the one the lifecycle timestamps at `asOf` imply:

| status | confirmedAt | invalidatedAt | resolvedAt |
|---|---|---|---|
| forming, retest_pending | null | null | null |
| confirmed, target_active, retest_confirmed | set | null | null |
| completed, outcome_ambiguous | set | null | set |
| failed_breakout | any | null | set |
| invalidated | null | set | null |
| expired | any | null | null, or set only with confirmedAt set |

These shapes are taken from Pattern Engine `lifecycle.ts` and `price-action.ts`. The `failed_breakout` and `retest_pending` rows reflect that a retest can fail or wait before any confirmation.

All modes refuse: invalidation and resolution set together (they are mutually exclusive terminal times in the engine); resolution before confirmation; confirmation or invalidation before the first sighting; duplicate anchor roles; a price, boundary line, metric, confirmation level or buffer, or invalidation level that is not exact decimal text (the engine's `Decimal.toString` form, including exponent notation); a malformed boundaries container, reported as a classified refusal.

The quiz policy accepts exactly its documented keys.

### 24.3 Leakage clues removed from the public view

The rule is: a field is a leak when its name or value is the answer, or a deterministic function of the answer alone. Geometry is evidence and stays.

- **Anchor roles** (`head`, `left_shoulder`, `retest_touch`) name the pattern. They become positional labels (`point_1`, …). The anchor price, time, confirmation time and pivot kind (`high`/`low`) stay: the kind is geometry the learner needs to identify a shape.
- **Boundary names** (`neckline`, `breakUp`, `failUpAfterDown`) name the pattern or its direction. They become positional labels (`line_1`, …). The intercept and slope stay.
- **Geometry metric names** (`retestBarsAfterBreakout`, `symmetry`) name the pattern. They become positional labels (`metric_1`, …). The metric values stay.
- **The invalidation rule** (`close_above_head`, `final_close_beyond_failure_boundary`) is withheld. The invalidation level stays.
- **The confirmation direction** is shown only in the lifecycle mode. In pattern identification it discriminates the breakout families (resistance versus support breakout), and in direction mode it is the answer's neighbour. Lifecycle timestamps known by `asOf` stay in the lifecycle mode: they are the evidence from which the status follows.
- **Chart context** remains a policy-controlled context field (`revealChartContext`). Its point-in-time validity belongs to the chart-context engine, which O14 does not re-check.
- **Shared state**: the public view copies the boundary values and the chart context, so editing a quiz cannot edit its source observation.

Hidden fields (the answer label, the explanation, the answer fingerprint) remain only in the internal `answer`, and a test pins that the explanation never appears in `publicView`.

### 24.4 Quiz identity and verification

- Every deterministic field (quiz id, input and answer fingerprints, options, prompt, explanation) is derived by one function that the builder and the verifier share.
- `validateQuizStructure`, which `gradePatternQuiz` also calls, re-derives those fields from the quiz's own identity fields and checks the visible-evidence fingerprint. A rewrite of the answer, the options, the prompt, the explanation or the evidence without re-deriving the fingerprints is refused without needing the source.
- `verifyPatternQuiz(observation, quiz, expectedPolicy?)` recomputes the whole quiz from its source. A consistent quiz re-issued from a different observation is refused.

### 24.5 Point-in-time facts verified upstream

- `buildPitView` (`src/patterns/pit-view.ts`) excludes every bar whose start is at or after `asOf`. The run input fingerprint is computed from that point-in-time view, so `patternRunId` does not change with future bars.
- The lifecycle walk runs over bars before `asOf`, so the observation status and its timestamps are point-in-time when the observation is produced by the engine at its `asOf`.
- `patternObservationId` hashes the status and the run fingerprint. Both are point-in-time, so the quiz identity does not couple to future values through the observation id.

O14 defends in depth against observations whose fields are later than their `asOf`, for example stored or hand-built observations. It does not depend on the engine to have done so.

### 24.6 Trust limits that remain

1. **Tutor rederivation duplicates O13.** The tutor reproduces O13's process rule in its own code, because O13 does not export a pure classifier. If one copy changes and the other does not, the tutor refuses valid reviews or accepts invalid ones. Recommended follow-up: export one pure classifier from O13 and use it in both places.
2. **Tutor provenance.** The tutor checks a review against its own embedded diagnostics. It cannot prove the review came from a real decision. A review re-issued with consistent diagnostics passes. Provenance requires `verifyPostTradeReview` against the source trace, which is O13's responsibility.
3. **Grading trust.** `gradePatternQuiz` checks the quiz's self-consistency only. A quiz re-issued with every fingerprint re-derived passes grading. A consumer that scores learners must call `verifyPatternQuiz` against the source observation first.
4. **Policy trust.** `verifyPatternQuiz` and `verifyTradingTutorLesson` verify against the policy stored in the artifact unless the consumer passes the expected policy. A consumer that does not pass one accepts any valid policy.
5. **Geometry is not timestamped.** Boundary lines, metric values and the invalidation level carry no time of their own in `PatternObservation`. O14 cannot prove from the observation alone that they were computed as of `asOf`. It relies on the engine's point-in-time view (see §24.5).
6. **Chart context** is passed through when its policy is enabled. Its point-in-time validity is not checked here.
7. **Distractor quality.** Distractors are drawn from the full mode vocabulary, so a chart pattern can be offered a candlestick name. That is a quality issue, not a leak. Pattern family could be used to restrict the vocabulary; V1 does not.
8. **Outcome-bias wording** is pinned by a matrix over every process and outcome combination. It is not semantic review: a new sentence template needs a new matrix entry.

No field in any artifact can place, route, size or cancel an order. Live Trading, Broker Orders and Physical Purchase remain LOCKED.
