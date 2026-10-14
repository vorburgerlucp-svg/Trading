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
