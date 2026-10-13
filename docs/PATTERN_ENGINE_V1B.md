# Pattern Engine V1B: price-action structures

Status: design, written before implementation. Base: `36dd8ab` (`feature/pattern-engine-v1-structural`).
Branch: `feature/pattern-engine-v1b-price-action`. Not merged.

V1B adds deterministic price-action structures on top of the V1 structural core (`docs/PATTERN_ENGINE_V1.md`):

- `resistance_breakout`, `support_breakdown`
- `breakout_retest`, `breakdown_retest`
- `false_breakout`, `false_breakdown`
- `rectangle`
- `ascending_channel`, `descending_channel`
- `rising_wedge`, `falling_wedge`

Out of scope, and not implemented: flags, pennants, candlesticks, cup and handle, rounded patterns, success statistics, confluence scores,
AI interpretation, trade orders, persistence and migrations. Migrations 001–011 stay byte-identical.

This document states the rules the code and tests must follow. Where a rule is a policy default rather than a market truth, it is marked as one
and lives in `PatternParameters` (§17).

---

## 1. Preserve V1

All seven V1 types keep their geometry, status and instance identity. The golden snapshot (`test/patterns/golden/v1-observations.json`) is captured
from `36dd8ab` before any V1B change. A V1B change that alters it is a bug, unless it is a confirmed V1 bug, in which case it gets a RED regression
first.

V1B reaches V1 only through the shared pieces it reuses: `buildPitView`, `findSwings`, `atr`, `supportResistance`, the exact line machinery in
`line.ts`, and `walkCandidate`. None of those change their V1 behaviour. New detectors live in new modules, so V1 code is not edited.

## 2. Versions and identity

| Item | Value | Why |
|---|---|---|
| `PATTERN_ENGINE_VERSION` (run) | `pattern-engine:v1b` | The run now produces new types, so the run identity changes explicitly. |
| `PATTERN_GEOMETRY_VERSION` (run) | `pattern-geometry:v1b` | New rectangle, channel and wedge geometry. |
| `PRICE_ACTION_LIFECYCLE_VERSION` | `price-action-lifecycle:v1` | New breakout, retest and false-break lifecycle. |
| `PATTERN_LIFECYCLE_VERSION` | `pattern-lifecycle:v1` (unchanged) | The V1 walk is unchanged. |
| `SUPPORT_RESISTANCE_VERSION` | `sr:swing-cluster:v1` (imported) | Enters the run fingerprint and the level identity. |
| `SWING_VERSION`, `ATR_VERSION` | imported (unchanged) | Enter the fingerprint. |

**V1 instance identity is frozen.** The V1 instance-id hash keeps its original tags: `engine: 'pattern-engine:v1'`, `geometry: 'pattern-geometry:v1'`.
Otherwise every V1 `patternInstanceId` would change with the bump. These tags are constants in `pattern-parameters.ts` (`V1_IDENTITY`). V1B types hash
with the V1B tags.

**What changes for V1 observations.** `patternInstanceId` (`pi_`), type, status, geometry, anchors, boundaries, target and timestamps are identical.
`patternObservationId` (`po_`) and the run fingerprint change, because they include the run fingerprint, which now includes the V1B versions.
This is the explicit, documented exception. The golden test excludes `po_` and the run-level identifiers, and compares everything else.

## 3. Point-in-time view: the same path

Every V1B structure is built from `buildPitView(bars, asOf, replay)` and nothing else. There is no second replay path.

The view is a prefix (V1 §3, the prefix rule). A bar that is not final, or not held at asOf, ends the usable series. Later bars are never joined across that
gap. Consequently every swing, level, breakout, retest, false break, rectangle, channel and wedge is computed only from the usable prefix.

The per-bar computations below use bars strictly before or at the decision bar B and nothing later:

- Level set at B: `supportResistance` as of **B − 1** (`lastIndex = B − 1`). Only swings with `confirmedIndex ≤ B − 1` enter.
- Scale at B: ATR at B, which uses bars up to B. ATR for level tolerance: ATR at B − 1.
- Breakout test at B: final close at B against the level, with the previous close at B − 1.

## 4. Swings and levels: reuse only

- Pivots: `findSwings(high, low, leftBars, rightBars)`. No new pivot algorithm.
- Levels: `supportResistance(swings, options)` from `src/quant/structure/support-resistance.ts`. No new clustering.
- Scale: `atr(...)` (Wilder). No new ATR.

Level tolerance is `tolerance.sameLevelAtrMultiple` × ATR(B − 1). V1 reserved this parameter for the V1B level family. V1 never reads it, so V1 is
unchanged. Level parameters: `minTouches = 2`, `lookbackBars = 120`, `priceScale = 6`.

The `strengthScore` produced by `supportResistance` is a quant ranking score. V1B never reads it in a decision and never reports it.

### 4.1 Level identity (superseded by §25: the evidence hash is now `levelEvidenceId`; structural identity is `levelLineageId`)

A level is identified by its evidence, not by its rounded price. Two distinct historical levels at the same price are two levels.

```
levelIdentity = hash({
  kind: 'level-identity',
  sr: SUPPORT_RESISTANCE_VERSION,
  interval,
  priceLevel,            // exact decimal text, as computed as of B − 1
  confirmedAt,           // replay instant of the minTouches-th confirmation
  touches: [...]         // sorted canonically by (time, kind, price)
})
```

The touch list is sorted canonically before hashing, so the input order never matters. The identity includes the touch list as of B − 1, so a level
that gains a touch later is a different identity. That is intentional: the later state is new evidence, not a rewrite of the earlier one (§5).

## 5. Breakout definition

A breakout at bar B needs a level that existed before B. Let `L` be a level from §4 as of B − 1, and `buf = breakoutBufferAtr × ATR(B)`.

- Resistance breakout at B: `L > close(B−1)` and `close(B) > L + buf`.
- Support breakdown at B: `L < close(B−1)` and `close(B) < L − buf`.

Rules:

- **Final close only.** An intrabar wick through the level is never a breakout. The comparison uses the bar close.
- **Strict inequality.** A close exactly at `L + buf` is not a breakout (tested).
- **Decimal comparison.** Closes and levels are exact `Decimal`. A close is never converted through `Number` (§16).
- **One breakout per level per direction.** The scan goes forward in bar order. The first qualifying B for a given `(levelIdentity, direction)` is the
  breakout. Later re-crossings of that same level and direction are not emitted as new breakouts.

`firstSeenAt` of a breakout is the replay instant of bar B.

## 6. Level look-ahead invariant

**Invariant.** At breakout bar B, only touches confirmed by bar B − 1 may form the level. A later touch, or a later swing, must never change a level
that was used at an earlier B.

This follows from §3 and §4: the level set at B is `supportResistance(…, lastIndex = B − 1)`. A third touch that is confirmed after B cannot enter.

**RED regression (mandatory).** A resistance is built from two touches. The close crosses it at B. Later a third touch creates a stronger historical
level. Replaying at T ≥ B must return the same breakout instance, with the same level identity and the same touch list as before. Replaying at a T
before that third touch must give the same answer as a replay at T ≫ B.

## 7. Breakout instance identity (superseded by §25: bound to `levelLineageId`, not to the evidence hash)

```
patternInstanceId = 'pi_' + hash({
  kind: 'price-action-instance',
  family: 'pattern-engine:v1b',
  instrumentId, interval, series,
  levelIdentity,
  direction            // 'up' for resistance_breakout, 'down' for support_breakdown
})
```

The identity is bound to instrument, interval, series, level identity and break direction. It is **not** bound to:

- the later retest,
- the later failure,
- the target outcome,
- asOf, the current status, or the breakout bar's position relative to other structures.

The later retest and false-break structures are separate types with their own identities (§8). Each derives its identity from the breakout's
`patternInstanceId` plus a fixed tag, so the breakout instance id stays stable.

## 8. Breakout structures and their lifecycle

Breakout structures are emitted only from their breakout bar onward. A level that has not been crossed is level evidence, not an observation, so
there is no `forming` state for breakouts. The `forming` state is used by rectangles, channels and wedges (§11–§13).

| Type | Created at | Statuses | Meaning |
|---|---|---|---|
| `resistance_breakout` / `support_breakdown` | breakout bar B | `confirmed` | The breakout is historically confirmed. It stays `confirmed` even if it later fails. Failure is recorded by the false-break structure. |
| `breakout_retest` / `breakdown_retest` | first touch of the zone after B | `retest_pending`, `retest_confirmed`, `failed_breakout`, `expired` | Created when the price first re-enters the zone. |
| `false_breakout` / `false_breakdown` | failure confirmation | `failed_breakout` | Created when a failure close occurs within the failure window. |

### 8.1 Retest and failure walk

The walk for breakout B covers the final bars after B in order. Thresholds use ATR at B, which is frozen for the whole lifecycle.

- **Same-bar rule.** The walk starts at **B + 1**. A retest is never claimed on the breakout bar, because OHLC cannot prove the breakout occurred
  before a same-bar retest (tested).
- **Failure (close-based).** For a resistance breakout: `close(t) < L − failBuf`, with `t − B ≤ failureWindowBars`. Mirror for a support breakdown.
  `failBuf = failureBufferAtr × ATR(B)`.
- **Touch.** `low(t) ≤ L + tol` for a resistance breakout (`tol = retestToleranceAtr × ATR(B)`). Mirror: `high(t) ≥ L − tol` for a breakdown.
  The touch counts only if `t − B ≤ retestWindowBars`, and only on a bar that does not fail. A bar whose close fails is a failure, and the failure is
  checked first, so its touch is never counted as a retest.
- **Hold.** `close(t) ≥ L + holdBuf` for a resistance breakout (`holdBuf = retestHoldBufferAtr × ATR(B)`, default 0). Mirror: `close(t) ≤ L − holdBuf`.
- A touch and a hold may occur on the same bar after B. That makes the retest confirmed on its touch bar.

**Retest status** (once touched, and as of asOf):

- `retest_confirmed`: a hold occurred at a bar within the retest window after a touch.
- `failed_breakout`: a failure occurred before a hold. The retest did not hold, so the retest structure records the failure.
- `expired`: touched, not held, and the retest window has passed (`last − B > retestWindowBars`).
- `retest_pending`: touched, not held, window still open.

If a hold occurs and a failure occurs later within the failure window, the retest structure stays `retest_confirmed` (its history is not rewritten), and a
`false_breakout` is also emitted.

**Same-bar ambiguity.** Retest and failure are both close-based and mutually exclusive on a single bar: a hold needs `close ≥ L + holdBuf`, and a failure
needs `close < L − failBuf`. The two cannot both be true. A wick back through the level is not a failure (§8.2), so no same-bar ordering is ever needed
inside the breakout lifecycle. The explicit `outcome_ambiguous` state is kept for rectangle, channel and wedge target-versus-failure (V1 rule, §11.3).

### 8.2 Wicks are not failures

A bar whose wick returns through the level but whose close does not is not a failure (default policy: final-close failure). It is also not a hold
violation. Tested.

### 8.3 False breakout

A false breakout is a breakout whose failure close occurs within `failureWindowBars` of B. The failure bar is the `false_breakout` observation's
`firstSeenAt`, and its `resolvedAt`. Its identity is `hash({kind:'price-action-false-break', breakoutInstanceId})`, which does not depend on the failure
bar. The golden expectation is a `false_breakout` observation with status `failed_breakout` at asOf ≥ failure bar. No future bar is needed to see the
breakout itself.

## 9. Retest tolerance and windows

Retest tolerance and the two windows are versioned policy (§17). They are not visual truths. The retest zone is ATR-based: it scales with the instrument's
own volatility, as V1 requires. Percent-of-price tolerance is available only through the explicit percent scale mode.

## 10. Rectangle (range)

A rectangle is an upper horizontal cluster and a lower horizontal cluster from the §4 level family, both with enough touches.

### 10.1 Birth (no duplicates)

For each bar F in order, compute `supportResistance` as of F. Take every pair `(S, R)` of levels with `S.priceLevel < R.priceLevel`. The pair is born at
`F` only if:

- `max(confirmedIndex(S), confirmedIndex(R)) == F`, i.e. F is the bar where the later of the two levels became confirmed, and
- the pair satisfies §10.2 as of F, and
- `S.priceLevel < close(F) < R.priceLevel`, so the price is inside the range at birth.

A later touch on an existing level never creates a new birth, so one range produces one rectangle. The instance is frozen at birth, so later touches
never rewrite it (V1 §13 and the "later third touch" rule, §6).

`firstSeenAt` is the replay instant of F: the latest confirmation the geometry requires, not the timestamp of a historical extreme.

### 10.2 Rules

- `S.touchCount ≥ minTouchesPerSide` and `R.touchCount ≥ minTouchesPerSide`.
- Duration `max(lastSeen) − min(firstSeen)` in bars is within `[minDurationBars, maxDurationBars]`.
- Flatness: the least-squares slope of each side's touches satisfies `|b| / ATR(F) ≤ flatSlopeToleranceAtrPerBar`. This rejects widening or
  converging bounds.
- Residuals: the maximum touch deviation from its fitted line is `≤ maxResidualAtr × ATR(F)`.
- Height: `R − S ≥ minHeightAtr × ATR(F)`. This is the separation of the two clusters relative to ATR.

### 10.3 Lifecycle

The rectangle is a candidate with frozen boundaries `breakUp = horizontal(R)` and `breakDown = horizontal(S)`. It uses the V1 `walkCandidate`:

- `forming` while inside the range, until `confirmationWindowBars` elapses (then `expired`).
- A final close above `R + buf` confirms an upward break. Below `S − buf` confirms a downward break.
- Failure is close-based: after an upward break, a close back below `R` by more than `failBuf`. (V1 rule.)
- **Target:** the rectangle height projected from the confirmed break: `R + height` or `S − height`. It is stored as a technical geometry target,
  not an expected price, take-profit or probability.
- Same-bar target-and-failure touch is `outcome_ambiguous`, as in V1.

The rectangle itself is direction-neutral while forming (`direction = neutral`).

## 11. Channels

A channel is two fitted swing lines with the same slope sign, in a bounded alternating window of confirmed swings.

### 11.1 Windows

Consecutive alternating confirmed swings, longest valid window first for each end swing (the V1 triangle windowing). Windows are bounded by
`maxSwings`. No arbitrary touch subsets are searched.

### 11.2 Rules (`A` = ATR at the geometry-known bar)

- Touches: at least `minTouchesPerSide` highs and lows.
- Duration `last.index − first.index` in `[minDurationBars, maxDurationBars]`.
- Residuals: `maxResidual ≤ maxResidualAtr × A`.
- Ascending: both slopes `≥ minSlopeAtrPerBar × A`. Descending: both `≤ −minSlopeAtrPerBar × A`.
- Parallel: `|sU − sL| ≤ maxSlopeDifferenceAtrPerBar`.
- Width positive at both ends of the window (the lines are linear, so the width is then positive throughout).
- Width stable: `|w_end / w_start − 1| ≤ maxWidthChangeRatio` (default 0.15).

Metrics exposed as exact text: `upperSlopeAtrPerBar`, `lowerSlopeAtrPerBar`, `slopeDifferenceAtrPerBar`, `maxResidualAtr`, `widthStartAtr`,
`widthEndAtr`, `durationBars`, `upperTouches`, `lowerTouches`. There is no confidence score.

### 11.3 Lifecycle and direction

`breakUp = upper`, `breakDown = lower`, with failure boundaries as in a V1 triangle. A channel is descriptive. Its direction is `neutral` while it
forms, and the actual break determines the confirmed direction. It never assumes a breakout direction. Target: the formation width projected from
the break (`targetMethod = formation_width_projected_from_break`, the same for wedges).

**Rectangles.** Breakout buffer: `priceAction.breakoutBufferAtr`. Failure buffer: `outcome.failureBufferAtr` (the V1 outcome rule). Target method:
`rectangle_height_projected_from_break`.

**Breakout family.** Breakout buffer: `priceAction.breakoutBufferAtr`. Failure buffer: `priceAction.failureBufferAtr`. Retest tolerance:
`priceAction.retestToleranceAtr`. The retest and failure windows are counted in bars from the breakout bar.

## 12. Wedges

A wedge is two fitted swing lines with the same slope sign, converging toward an apex ahead of the window.

### 12.1 Rules

- Touches, duration and residuals as for channels (§11.2).
- Both slopes beyond the minimum: `|sU| ≥ minSlopeAtrPerBar` and `|sL| ≥ minSlopeAtrPerBar`, same sign.
- Rising wedge: both slopes positive and the support steeper, `sL > sU`.
- Falling wedge: both slopes negative and the resistance steeper, `sU < sL`, i.e. `|sU| > |sL|`.
- Convergence: `(w0 − w1) / w0 ≥ minConvergence`, with `w1 > 0`.
- Apex ahead of the window: `0 < apex − last.index ≤ maxApexBarsAhead`.

### 12.2 No predictive direction

A wedge's name does not imply a direction. While forming, `direction = neutral`. The actual break determines the confirmed direction, and **both**
breakouts are legitimate for both wedge types. A rising wedge can break upward, and a falling wedge can break downward. No textbook expectation is
encoded as detector truth. Tests cover both breakouts for each wedge type.

## 13. Classification: no accidental category drift

The categories are disjoint by construction. Each condition below is required and checked by explicit classification tests.

| Structure | Required | Excluded by |
|---|---|---|
| Ascending / descending triangle (V1) | one side flat (`|s| ≤ flatTol`) | a wedge needs both sides beyond `minSlope` |
| Symmetrical triangle (V1) | opposite-sign slopes | a wedge needs same-sign slopes |
| Channel | same-sign slopes, parallel, width stable within `maxWidthChangeRatio` | a wedge needs convergence `≥ minConvergence` > width tolerance |
| Wedge | same-sign slopes beyond minimum, convergence `≥ minConvergence` | a channel's width tolerance is smaller than `minConvergence` |
| Rectangle | horizontal bounds from levels | swing-line categories are not applicable (different source) |

Required parameter relation (checked in `resolvePatternParameters`):
`triangle.flatSlopeToleranceAtrPerBar < wedge.minSlopeAtrPerBar` and
`channel.maxWidthChangeRatio < wedge.minConvergence`. A parameter set that violates either is refused.

A rectangle and a wedge or channel may overlap only in the sense that both describe the same bars. That overlap is allowed (§14).

## 14. Overlaps

Overlaps are allowed: a rectangle inside a larger channel, a wedge overlapping a triangle window, a rectangle's breakout also reported as a standalone
`resistance_breakout`. Overlaps are not globally suppressed.

Exact duplicate geometry from the same detector is deduplicated by `patternInstanceId`. Different types never deduplicate against each other, because
the type is part of the identity.

## 15. firstSeenAt

| Structure | firstSeenAt |
|---|---|
| V1 structures | unchanged (V1 §8) |
| Rectangle | replay instant of the latest bar at which a required level was confirmed (§10.1) |
| Channel, wedge | replay instant of the confirming bar of the last anchor |
| Breakout | replay instant of breakout bar B |
| Retest | replay instant of its first touch |
| False break | replay instant of its failure bar |

No structure may appear before the market evidence needed to know it existed.

## 16. Decimal and representability

- **Closes and levels are exact `Decimal`.** Breakout, retest, failure and channel comparisons use `Decimal`. A close is never passed through `Number`.
- **Swings and ATR are double-based by design.** `findSwings` compares doubles, and ATR is scale only. V1's representability gate
  (§5 of the V1 design) covers high and low, and the same gate is reused unchanged. Close is not used by the swing detector.
- **Line fitting** uses `line.ts` (exact `Decimal`, fixed slope and intercept scales). V1B does not duplicate its math and does not add a second
  rounding policy.
- **Open is not compared in V1B** except as the previous close, which is `Decimal`.

## 17. Parameters (policy defaults, not market truth)

All values are versioned in `PatternParameters` and enter the run fingerprint.

Keys as implemented (`PatternParameters` in `src/patterns/pattern-parameters.ts`). The level tolerance is `tolerance.sameLevelAtrMultiple`, which V1
reserved for this family and V1B now reads.

```
tolerance.sameLevelAtrMultiple   0.5     level tolerance in ATR at the bar before the decision
priceAction:
  levelMinTouches         2
  levelLookbackBars       120
  levelPriceScale         6
  breakoutBufferAtr       0.1
  retestToleranceAtr      0.3
  retestHoldBufferAtr     0
  retestWindowBars        20
  failureWindowBars       10
  failureBufferAtr        0.1
rectangle:
  minTouchesPerSide       2
  minDurationBars         15
  maxDurationBars         100
  flatSlopeToleranceAtrPerBar  0.02
  minHeightAtr            1.5
  maxResidualAtr          0.5
  confirmationWindowBars  30
channel:
  minTouchesPerSide       2
  minDurationBars         15
  maxDurationBars         100
  maxResidualAtr          0.5
  minSlopeAtrPerBar       0.03
  maxSlopeDifferenceAtrPerBar  0.02
  maxWidthChangeRatio     0.15
  maxSwings               6
  confirmationWindowBars  30
wedge:
  minTouchesPerSide       2
  minDurationBars         15
  maxDurationBars         100
  maxResidualAtr          0.5
  minSlopeAtrPerBar       0.03
  minConvergence          0.2
  maxApexBarsAhead        60
  maxSwings               6
  confirmationWindowBars  30
```

Validation refuses any value outside its domain. It also refuses the relation in §13.

## 18. Performance and bounds

- **Breakout scan.** One level computation per bar B: `supportResistance` over the swings in the lookback window only. Cost per bar is `O(S log S)` with `S` bounded by `lookbackBars`. The scan is `O(N · S log S)`, not quadratic in N.
- **Retest and failure walks.** Each breakout walks at most `max(retestWindowBars, failureWindowBars)` bars after B. Breakouts per level and direction are deduplicated, so the total work is bounded by level count times window.
- **Rectangles.** One level computation per F, and pairs are formed only from that bar's levels (a small number). Only the birth bar of a pair is accepted.
- **Channels and wedges.** Consecutive alternating windows only, bounded by `maxSwings`. The longest valid window per end swing is kept. The windowing loop is bounded by `maxSwings`.
- **Diagnostics** expose `levelEvaluations`, `breakoutCount`, `priceActionBarsWalked`, `rectangleBirthChecks`, `channelWedgeWindows`, plus the V1
  `barsWalked` and `candidateCount`. The `candidateCount` and `barsWalked` counters include the V1B candidates.

## 19. Fingerprint

The run fingerprint includes: pattern engine, geometry, lifecycle (V1 and price-action), swing, ATR, support/resistance, line-fit policy (`line.ts`
scales), all parameters including the V1B families, instrument, series, asOf, replay mode, the bars of the usable prefix, and the ChartContext
fingerprint if present. There is no unversioned semantic dependency.

## 20. Golden regression

1. Capture `test/patterns/golden/v1-observations.json` at `36dd8ab` for a fixed case list (the V1 fixtures at several asOf values, the mirror, the
   scaled series and the shallow near miss). The capture is part of the first commit, before any V1B source change.
2. The golden test compares, for V1 types only: `patternInstanceId`, type, direction, status, anchors, boundaries, geometry metrics,
   `firstSeenAt`, `confirmedAt`, `resolvedAt`, `invalidatedAt` and target. It excludes `po_` and run identifiers (§2).
3. The test runs after V1B changes and must pass unchanged.

## 21. Red team (tests written before the code)

1. Level created after breakout (the late third-touch regression, §6).
2. Retest known on the breakout bar (same-bar rule, §8.1).
3. False breakout based on a wick only (§8.2).
4. Line touch uses a future swing (level computed as of B − 1, rectangle born only when confirmed, §3 and §10.1).
5. Wedge assumes textbook direction (both breakouts tested, §12.2).
6. Decimal close accidentally converted to Number (strict-boundary test, §16).
7. Support/resistance version missing from fingerprint (fingerprint test, §19).
8. V1 triangle output changes after refactor (V1 golden, §20).
9. Gap in the PIT prefix bridged (dedicated prefix regression, §23).
10. ChartContext changes geometry (independence test).
11. Duplicate breakout instances emitted (one breakout per level and direction, §5).
12. Same-bar lifecycle ordering invented (close-based exclusivity, §8.1).

## 22. Limitations

- Breakouts are not emitted as `forming`; a level that has not been crossed is level evidence only.
- Level identity includes the touch list as of B − 1. A level that later gains a touch gets a new identity (§4.1). This is a deliberate choice and is
  documented, not hidden.
- Each re-crossing of an already-broken level in the same direction is not emitted as a new breakout (§5).
- Thresholds are policy defaults. They are not market truths, and their predictive value is not claimed.
- `supportResistance` ranks levels by a quant score. V1B does not use that score.
- Open is not checked for double representability (V1 limitation, unchanged).
- `sr:swing-cluster:v1` clusters highs and lows together by price. A level can therefore carry a low touch (a former resistance that acted as support),
  and its kind is set by the reference price of the call. The breakout family does not depend on the kind: it compares the level with the previous
  close directly.
- Channel and wedge windows overlap by design. The same two lines can appear as several instances when the windows differ in their first or last
  swing. Each instance has its own geometry-known bar and its own identity, and none is hidden.
- Rectangle births are checked at every bar, but a rectangle is born only when its later level is confirmed. A range whose levels were confirmed
  earlier and whose touches then change identity is not reborn.
- A same-bar ambiguity between a retest and a failure is unreachable under close semantics (§8.1). Ambiguity remains only for the rectangle, channel
  and wedge target against the failure boundary, as in V1.
- The prefix rule ends the view at the first unusable bar. A non-final bar in the middle of the history therefore stops all later structures, which
  fails safe and is reported as `afterGap` in the view. The data-quality gate is not asked to repair it.

## 24. Implementation map

| Module | Role |
|---|---|
| `src/patterns/levels.ts` | Level family: swing inputs, `levelsAt(lastIndex)`, `levelIdentityOf` |
| `src/patterns/price-action.ts` | Breakout scan, retest and false-break walk, observation drafts |
| `src/patterns/geometry-price-action.ts` | Rectangle births; channel and wedge windows |
| `src/patterns/pattern-parameters.ts` | Versions, V1 and V1B identity tags, parameters, relations |
| `src/patterns/pattern-engine.ts` | Integration, identities, fingerprint, diagnostics |
| `src/patterns/geometry.ts`, `lifecycle.ts`, `line.ts`, `pit-view.ts` | V1, unchanged |

## 25. Hardening: stable level lineage and event relationships (`level-lineage:v1`)

Status: design for the `feature/pattern-v1b-lineage-hardening` branch. It supersedes §4.1 (the level id) and §7 (the breakout id) where they conflict.

### 25.1 The gap

The V1B level identity hashed the price, the confirmation instant and the whole touch list. A later touch on the same physical level changed that
identity, so the next crossing of that level looked like a new level and emitted a second `resistance_breakout`. Reproduced by a RED test
(`test/patterns/price-action-recross.test.ts`).

### 25.2 Two concepts, not one

- **`levelLineageId`: structural identity.** "This is the same price-area structure over time." It does not change when touches are added, and it does
  not change when the level's role flips between resistance and support.
- **`levelEvidenceId`: audit identity.** "This exact set of touches existed at this instant." It changes with every touch, every price revision of the
  cluster and every confirmation change. It is recorded, never used as the structural identity.

### 25.3 Lineage policy (`level-lineage:v1`)

- **Birth.** A lineage is born from a cluster that no existing lineage claims. Its birth touches are the first `levelMinTouches` touches of the cluster
  in confirmation order (confirmedIndex, then index, then kind). The birth instant is the cluster's `confirmedAt`, and the birth price is the cluster's
  price at that bar.
- **Identity.** `levelLineageId = hash({policy: 'level-lineage:v1', sr, instrumentId, interval, birthConfirmedAt, birthPrice, birthTouches})`, with the
  birth touches sorted canonically. Two distinct historical levels at the same price differ by birth instant and birth touches.
- **Matching, bar by bar.** The levels are swept in bar order, using the support/resistance clusters as of each bar (the same clusters the breakout
  scan uses). A cluster matches a lineage when it contains at least one of that lineage's birth touches that is still within the lookback. Matches are
  made greedily and deterministically: larger overlap first, then the earlier birth, then the lower price. One cluster matches at most one lineage, and
  one lineage matches at most one cluster. An unmatched cluster is born as a new lineage.
- **Lapse.** A lineage with no matching cluster is inactive. A later cluster that contains one of its birth touches re-matches it. When every birth touch
  leaves the lookback, the lineage is over and a later cluster at the same price is a new lineage. That is the unrelated same-price case.
- **Role switch.** The matching ignores `kind`. A breakout that flips a resistance into a support keeps the lineage.

The sweep depends only on bars up to the bar it has reached, so the lineage at a bar never changes because of later bars.

### 25.4 Evidence identity

`levelEvidenceId = hash({sr, interval, priceLevel, confirmedAt, touches})`, with the touches sorted canonically. Adding a touch changes it. This is the old
`levelIdentityOf`, renamed.

### 25.5 Breakouts

- **Instance identity** binds to `levelLineageId` (not `levelEvidenceId`), direction, instrument, interval and series. Later touches, retests and failures
  do not change it.
- **The observation records the evidence used.** `levelEvidence` carries `levelLineageId`, `levelEvidenceId`, the price, the touch count, the high and
  low touch counts, and the evidence confirmation instant. These are the values at B − 1, the ones that actually confirmed the breakout.
- **Re-cross policy.** One breakout event per `levelLineageId` and direction. A later up-cross of the same lineage is not a second independent
  `resistance_breakout`. A future V2 may define a re-arm lifecycle, and it is not in V1B hardening.

### 25.6 Event relationships

Every price-action observation carries `patternLineage`:

```
patternLineage: {
  eventFamilyId:            'ef_…'   // hash(instrument, interval, series, levelLineageId, direction)
  parentPatternInstanceId:  string | null
  rootPatternInstanceId:    string   // the breakout's patternInstanceId
  relationship:             'root' | 'retest_of' | 'false_break_of'
}
```

- Breakout: `root`, parent `null`, root = itself.
- Retest: `retest_of`, parent = the breakout, root = the breakout.
- False break: `false_break_of`, parent = the breakout, root = the breakout.
- Breakdown and its retest and false break mirror these, with the breakdown's direction in the family id.

`eventFamilyId` does not depend on `asOf`, the retest bar, the failure bar or the current status. The three members of one family share it.

### 25.7 Confluence safety

Breakout, retest and false-break observations of one event are **related observations, not independent evidence**. A future Confluence Engine must
group them by `eventFamilyId` and count each family once, through its `rootPatternInstanceId`. This branch does not build Confluence.

### 25.8 Mixed high and low touches

`sr:swing-cluster:v1` is not rewritten. A level can carry a low touch (a former resistance that acted as support). The composition is exposed, not
hidden: `highTouchCount` and `lowTouchCount` appear in `levelEvidence`, and in the rectangle metrics per side.

### 25.9 Rectangles

A rectangle's identity is its birth anchors, which are frozen at birth. Later touches on either side create no second rectangle, because the birth
rule is unchanged: the pair is born only at the bar where the later of its two levels is confirmed. The lineage ids of both sides are recorded in the
metrics (`upperLineageId`, `lowerLineageId`) so that a consumer can see the structure's levels.

### 25.10 Fingerprint and versions

`level-lineage:v1` is a constant, in the run fingerprint and in `PatternRun.levelLineageVersion`. Changing the lineage rule changes every
`levelLineageId` (the policy string is hashed into it) and every run id.

### 25.11 Identity migration

- Changed: the breakout, retest and false-break `patternInstanceId` values from the V1B commit. They now derive from `levelLineageId`, so they differ
  from the previous branch's ids. Their `patternObservationId` values change with the run fingerprint.
- Unchanged: every V1 structure (its instance ids and geometry), and the rectangle, channel and wedge instance ids. The V1 golden test stays green.
- Verified: the instance ids of the same fixtures (head and shoulders, rectangle, ascending channel, rising wedge, double top, symmetrical triangle, and
  the resistance series) were captured on `10efa84` and on this branch. Only the breakout, retest and false-break ids differ.

### 25.12 Known limitations

- A lineage whose birth touches all leave the lookback is over. A level that returns after that is a new lineage, by design.
- A cluster that merges two lineages' touches is claimed by the one with the larger overlap, so the other lineage is inactive until its touches separate.
- The event is one breakout per lineage and direction. A re-armed level is not modelled.

## 23. Prefix regression (dedicated)

Bars A, B usable; C unusable (not final); D, E usable-looking. The PIT view must be `[A, B]`. D and E must not create a swing, confirm a level, form a
breakout, a retest, a false break, a rectangle, a channel or a wedge, nor resolve an outcome. Tested in historical and decision-time forms where
the replay mode applies.
