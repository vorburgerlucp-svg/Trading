# Pattern Engine V1: the structural core

Status: design, written before implementation on `feature/pattern-engine-v1-structural` (base `63efede`). Not merged.

Engine: `pattern-engine:v1`. Geometry: `pattern-geometry:v1`. Lifecycle: `pattern-lifecycle:v1`. Swings: `swings:fractal-strict-left:v1` (reused, not
re-implemented). ATR: `atr:wilder:v1` (reused).

This document is the authoritative implemented decision record. `docs/PATTERN_ENGINE_SPEC.md` stays as the design intent. Where the two differ, this
document states what V1 does and why.

## 1. What V1 answers, and what it does not

It answers: which deterministic chart geometry exists in the final bars up to `asOf`; which confirmed swings define it; whether it is forming,
confirmed, target-active, completed, invalidated, failed, expired, or outcome-ambiguous; the exact confirmation and invalidation levels; the
technical target that its geometry implies; and when NEXUS could first have known each state.

It does not answer whether to buy or sell, the probability of success, profitability, or what any AI thinks. It produces no statistics, no
historical success rate, no expected return, no confidence, no probability, no trade action (no buy, sell, entry, stop, size, or take-profit), no
AI interpretation, and no persistence.

## 2. Structural patterns in V1

`head_and_shoulders`, `inverse_head_and_shoulders`, `double_top`, `double_bottom`, `ascending_triangle`, `descending_triangle`,
`symmetrical_triangle`.

Not in V1: triple tops and bottoms, wedges, flags, pennants, rectangles, channels, cup and handle, rounded formations, candlestick patterns,
breakout and retest catalogues, pattern statistics, AI interpretation. They belong to V1B and V2. The architecture makes a new family a new detector
and a new boundary set, with no change to the lifecycle or the identities.

## 3. Inputs and the point-in-time cut

`PatternRunInput`: instrument (`instrumentId`, `assetClass`, `tickSize?`, `allowsNegativePrices`), `calendar` (may be null), `series`
(`source`, `interval`, `session`, `adjustment`), `bars`, `asOf`, `replay` (`historical_research` or `decision_time`), `sourceInfo?`, `parameters?`,
`useCase?`, `chartContext?`.

The engine never trusts the array it was given. It builds a point-in-time view:

1. A bar with `startTime >= asOf` is excluded. Nothing of the future enters the view.
2. Replay gate, applied to each bar in `startTime` order:
   - `historical_research`: the bar is used when `availableAt <= asOf` (the market gate). A revision NEXUS held only later is used and labelled.
   - `decision_time`: the bar is used when the instant NEXUS held exactly this revision is `<= asOf`. A legacy bar with no knowledge proof throws
     (`BarKnowledgeNotProvenError`). Nothing is substituted.
3. The view is a prefix. It ends at the first bar that is not final (`isFinal = false`) or that fails the replay gate. Every later bar is counted as
   `afterGap` and excluded. Without this, the swing windows would join the bars on either side of a hole as if the series were complete, and a
   forming or unheld bar would still shape the geometry (a right shoulder confirmed by a bar NEXUS did not hold).
4. Bars are sorted by `startTime`. Duplicate starts are refused by the data-quality gate.

The replay instant of a bar is `replayInstantMs` (`src/market-data/bar-replay.ts`): the market gate in research mode; the later of the market gate and
the NEXUS knowledge instant in decision-time mode.

## 4. Data-quality gate

The view is graded by `MarketDataQualityService.assessBars` with the same context the Quant Engine uses.

- `valid = false`: the run returns `INVALID_DATA` with the issues. No observation is emitted. The run stays auditable.
- Fewer view bars than the scale needs (`atrPeriod + 1`, or fewer than the shortest pattern requires): `INSUFFICIENT_DATA`, no observations.
- Otherwise `READY`. A run with zero observations is still `READY`: no pattern is a valid answer.

A warning (for example a missing calendar) does not stop the run. Only invalid data does.

## 5. Swings: one algorithm, carried with prices and instants

Pivots come from the existing `findSwings(high, low, leftBars, rightBars)`, run on the point-in-time view only. Its output carries an index and a
confirming index. The engine adds the exact price, the bar start time, and the confirmation instant:

- `price`: the bar's high for a swing high, its low for a swing low, as an exact `Decimal`.
- `time`: the bar's `startTime`.
- `confirmedIndex`: `index + rightBars`, which must lie inside the view. A swing near the end of the view therefore cannot yet exist.
- `confirmedAt`: the replay instant of the confirming bar. Not its `startTime`.

A swing exists for `asOf` only if its confirming bar is in the view. That makes the right side of every structure known only after its confirmation.

Known limitation: `findSwings` compares `number` values. Exact `Decimal` prices drive every later geometric decision, but two prices closer than the
double precision of the input may tie in the pivot test. Each bar's high and low must round-trip exactly through a double (the decimal text read back
as a double and parsed again gives the same value). A bar that fails this makes the run `INVALID_DATA` with the issue `price_not_representable`, and
no geometry is emitted. Open and close are not checked here: the swing detector reads only highs and lows, and the lifecycle compares closes exactly.

## 6. Scale and tolerance

Every geometric threshold is expressed in units of a scale `A`:

- `tolerance.mode = atr` (default): `A` is the Wilder ATR (`atr:wilder:v1`, period `atrPeriod`) at the bar where the pattern's geometry becomes known
  (the confirming bar of its last anchor). That bar is in the view, and Wilder ATR is causal, so `A` never depends on later bars.
- `tolerance.mode = percent`: an explicit configured alternative. `A = percentOfPrice × |close|` at the same bar. It needs no ATR warm-up.

No arbitrary visual tolerance is ever substituted. If ATR is required and unavailable, the candidate is not emitted and the run reports
`INSUFFICIENT_DATA` for it. ATR is a scale, not a vote: it is never bullish or bearish, and it predicts nothing.

## 7. Consecutive structural windows (no combinatorial search)

Structural patterns are built from consecutive confirmed swings in the order they occur, with alternating kinds. A window is a contiguous slice of the
swing list. Nothing skips a swing inside a window.

- Head and shoulders top: `H L H L H`. Inverse: `L H L H L`.
- Double top: `H L H`. Double bottom: `L H L`.
- Triangles: a window of `2 × minTouchesPerSide` to `maxTriangleSwings` alternating swings, ending at each swing. For each end the longest valid
  window is taken, and the search stops at the first valid length.

Every window is checked against `maxPatternBars`. The number of candidates is therefore at most the number of swings times a constant. That bounds
the work and removes the `O(S^5)` search over all swing combinations. The cost is a limitation: a valid structure with an unrelated swing inside it is
not found in V1.

## 8. Bottoms are the mirror of tops: one mathematics

A bottom pattern is found by running the top detector on a mirrored view. In the mirror, each high is the negated low, each low is the negated high,
and each close is negated. `high − low` and the true range are unchanged, so the Wilder ATR is identical. Inverse head and shoulders is the mirror of
head and shoulders. The double bottom is the mirror of the double top. Every price in the mirrored view is negated back to its original value on
output, so the observation shows real prices.

Triangles are not mirrored. The ascending, descending, and symmetrical detectors cover both orientations directly. Mirroring them would repeat
the same candidates.

## 9. Exact lines

A boundary is a line `value(t) = a + b·t`, with `t` the bar index, `b` the slope and `a` the intercept, all exact `Decimal` values. A slope between two
points is `(y₂ − y₁) / (x₂ − x₁)`, rounded half-even to a fixed scale of 12 decimal places. The lines through several touches use exact least
squares in `Decimal` arithmetic, with the same fixed-scale rounding. No binary floating point is used for a price or a boundary.

Fit quality is the maximum absolute residual over the touches, in units of `A`. An apex is `x* = (a_lower − a_upper) / (b_upper − b_lower)`. Parallel
lines have no apex and are rejected.

## 10. Head and shoulders top (the mirror gives the inverse)

Anchors `H1 L1 H2 L2 H3`, roles `left_shoulder`, `neckline_left`, `head`, `neckline_right`, `right_shoulder`.

Conditions, all in units of `A`:

- Prominence: `H2 − max(H1, H3) ≥ minHeadProminenceAtr · A`.
- Shoulder difference: `|H1 − H3| ≤ maxShoulderDifferenceAtr · A`.
- No impossible crossing: `L1 < min(H1, H2)` and `L2 < min(H2, H3)`.
- Duration symmetry: with `left = H2.index − H1.index` and `right = H3.index − H2.index`, `max(left, right) / min(left, right) ≤ maxShoulderDurationRatio`.
- Total span: `H3.index − H1.index` in `[minPatternBars, maxPatternBars]`.
- Neckline: the line through `L1` and `L2`. Its slope satisfies `|b| ≤ maxNecklineSlopeAtrPerBar · A`. It is a line, not a horizontal level. It is evaluated at the bar being tested.

Geometry known: the confirming bar of `H3`. `firstSeenAt` is that bar's replay instant. The earliest bar that can confirm is the next one.

Confirmation: the first final bar after geometry is known whose close is below `neckline(t) − breakoutBufferAtr · A`. `confirmedAt` is that bar's replay instant.

Invalidation before confirmation: a final close above `H3 + failureBufferAtr · A` (the structure has been reclaimed).

Failure after confirmation: a final close back above `neckline(t) + failureBufferAtr · A`. Failure touched intrabar: `high ≥ neckline(t)`.

Target: height `h = H2 − neckline(H2.index)`. Target `= neckline(t_confirm) − h`, the technical distance from head to neckline, projected down from the confirmation neckline. Technical target, never an expected return.

## 11. Double top (the mirror gives the double bottom)

Anchors `H1 L1 H2`, roles `first_peak`, `neckline`, `second_peak`.

- Peaks: `|H1 − H2| ≤ maxPeakDifferenceAtr · A`.
- Reaction depth: `min(H1, H2) − L1 ≥ minReactionDepthAtr · A`.
- Separation: `H2.index − H1.index ≥ minSeparationBars`, and `H2.index − H1.index ≤ maxPatternBars`.

Neckline: the horizontal line at `L1`. Geometry known: the confirming bar of `H2`.

Confirmation: a final close below `L1 − breakoutBufferAtr · A`. Invalidation before confirmation: a final close above `max(H1, H2) + failureBufferAtr · A`.

Failure after confirmation: a final close back above `L1 + failureBufferAtr · A`. Intrabar touch: `high ≥ L1`.

Target: `peakRef = (H1 + H2) / 2` (exact). Height `h = peakRef − L1`. Target `= L1 − h`.

## 12. Triangles (ascending, descending, symmetrical)

Anchors are the window's alternating swings. Upper line: least-squares through the highs. Lower line: least-squares through the lows.

Conditions:

- At least `minTouchesPerSide` touches on each side.
- Residuals: the maximum residual on each line, in units of `A`, is at most `maxResidualAtr`.
- Duration: `lastAnchor.index − firstAnchor.index` in `[minPatternBars, maxPatternBars]`.
- Convergence: the width `w(x) = upper(x) − lower(x)` is positive at the first and last anchor, and `(w_first − w_last) / w_first ≥ minConvergence`.
- Apex: the lines are not parallel. The apex lies after the last anchor, and `apex − lastAnchor.index ≤ maxApexBarsAhead`. An apex at or before the last anchor is rejected as expired.

Slopes are normalised by `A` per bar. A slope `s` is flat when `|s| ≤ flatSlopeToleranceAtrPerBar`, and trending when `|s| ≥ minTrendSlopeAtrPerBar`.

- Ascending: upper flat, lower rising. Confirmation up through the upper line.
- Descending: lower flat, upper falling. Confirmation down through the lower line.
- Symmetrical: upper falling, lower rising. Direction-neutral while forming. The first decisive final close beyond either line sets the direction.

Geometry known: the confirming bar of the last anchor. A breakout is considered only after that bar.

Confirmation: final close above `upper(t) + breakoutBufferAtr · A` (up), or below `lower(t) − breakoutBufferAtr · A` (down).

Invalidation before confirmation (ascending and descending only): ascending, a final close below `lower(t) − failureBufferAtr · A`; descending, a final close above `upper(t) + failureBufferAtr · A`. A symmetrical triangle has no pre-confirmation invalidation beyond its own break.

Failure after confirmation: after an up-break, a final close back below `upper(t) − failureBufferAtr · A`; after a down-break, back above `lower(t) + failureBufferAtr · A`. Intrabar touch: `low ≤ upper(t)` after an up-break, `high ≥ lower(t)` after a down-break.

Target: height `h = w(first anchor index)`, the widest validated formation height, projected from the actual breakout: up `upper(t_confirm) + h`, down `lower(t_confirm) − h`.

## 13. Lifecycle

For one candidate, the lifecycle walks the point-in-time view strictly after its geometry-known bar, bar by bar, with the final bars only. Statuses:

- `forming`: geometry exists; no boundary crossed; the confirmation window (`confirmationWindowBars` after the geometry-known bar) is still open. Emitted only when `asOf` is at or after `firstSeenAt`.
- `invalidated`: the pre-confirmation invalidation was crossed.
- `expired` (before confirmation): the window elapsed without confirmation.
- `confirmed`: the confirming bar is the last view bar.
- `target_active`: confirmed earlier, no outcome yet, within `maxOutcomeBars`.
- `completed`: the target was reached, and no failure touch or close occurred in the same bar.
- `failed_breakout`: a final close back through the failure boundary before the target.
- `outcome_ambiguous`: in one bar, the target was touched and the failure boundary was touched intrabar. The order of those two touches cannot be known from OHLC, so neither is chosen.
- `expired` (after confirmation): `maxOutcomeBars` elapsed without an outcome.

Same-bar rule, in this order after confirmation: if the target and the failure boundary are both touched in one bar, `outcome_ambiguous`. Otherwise a failure close is `failed_breakout`. Otherwise a target touch is `completed`. The target touch is `high ≥ target − targetToleranceAtr · A` (up) or `low ≤ target + targetToleranceAtr · A` (down).

A bar that confirms cannot also resolve the outcome. Confirmation starts the outcome walk on later bars only.

## 14. Identities and first-seen times

- `patternInstanceId = 'pi_' + hash(engine version, geometry version, instrumentId, interval, patternType, anchors)`. The anchor identity is `(role, kind, startTime, exact price)`. It contains no asOf and no status, so the same geometry keeps the same id from the moment it forms until it resolves.
- `patternObservationId = 'po_' + hash(patternInstanceId, asOf, status, inputFingerprint)`. It changes when the observation or the run changes.
- `inputFingerprint` covers the engine, geometry, lifecycle, swing and ATR versions, the instrument (identity, tick size, asset class, negative-price policy), the series, the replay mode, `asOf`, the resolved parameters, every selected bar (times, OHLCV, finality, `availableAt`, `retrievedAt`, knowledge and vintage fields), and the chart context identity when supplied. It is sorted canonically: input order does not change it. `createdAt` is excluded.
- `patternRunId = 'pr_' + inputFingerprint[0..40]`.

`firstSeenAt` of a pattern is the replay instant of its geometry-known bar: the latest `confirmedAt` among the anchors. A swing is not known before its confirmation, so no state is ever stamped earlier than its own knowledge.

Duplicate candidates from the same detector are removed by `patternInstanceId`. Overlapping patterns are not suppressed globally: each has its own id.

## 15. Observation

Each observation carries `patternInstanceId`, `patternObservationId`, `patternType`, `direction` (`bullish`, `bearish`, or `neutral` while a symmetrical
triangle forms), `status`, `instrumentId`, `interval`, `series`, `asOf`, `firstSeenAt`, `confirmedAt`, `invalidatedAt`, `resolvedAt` (each `null` when
not reached), `anchors` (`role`, `kind`, `price`, `time`, `barIndex`, `confirmedAt`), `confirmation` (kind, level or line, buffer, confirming bar time),
`invalidation` (rule and level), `target` (method and price), `geometryMetrics` (raw values such as `shoulderDifferenceAtr`, `headProminenceAtr`,
`durationRatio`, `necklineSlopeAtrPerBar`, `peakDifferenceAtr`, `reactionDepthAtr`, `lineResidualAtr`, `apexBarsAhead`, `convergence`), and
`evidenceRefs` (`patternRunId`, and `chartContextId` when supplied).

Not present: a probability, a confidence, a geometry score, a success rate, an expected return, a stop, a size, or an order.

## 16. ChartContext: metadata only

A supplied `ChartContext` is validated first, and a mismatch is refused. It must have the same `instrumentId` and `asOf`. It must contain the pattern's
interval in `timeframes`. Its series must match: the same source, session, and adjustment, and its `barReplay` must equal the pattern's replay.
Its `useCase` must match. A supplied but incompatible context fails closed. It is never silently ignored.

The observation copies only metadata: `chartContextId`, `dominantTrend`, `currentPhase`, `timeframeAlignment`. These never change `patternType`,
anchors, neckline, confirmation, invalidation, or target. Pattern existence does not depend on the context. Without a context the engine works
unchanged.

## 17. Run status and provenance

`READY`, `INSUFFICIENT_DATA`, or `INVALID_DATA`, as in section 4. Provenance uses the same two questions as the bar layer: decision-time knowledge
proven by `asOf` for every selected bar; historical reconstruction (any bar with vintage `historical_reconstruction`); legacy unproven bars; and whether
the latest final bar is contemporaneous. A pattern can be known by today's decision and still rest on reconstructed history: that is valid research
context, and it is labelled.

## 18. Default parameters (policy defaults, not market truths)

Each default is a policy choice, documented here. It is not an empirical claim. Every value enters the fingerprint.

| Parameter | Default | Reason |
|---|---|---|
| `swing.leftBars`, `swing.rightBars` | 3, 3 | Same as the Quant Engine's swing defaults, so both see the same pivots |
| `tolerance.mode` | `atr` | Volatility-aware scale; `percent` is an explicit alternative |
| `tolerance.atrPeriod` | 14 | Same as the Quant Engine's ATR default |
| `tolerance.sameLevelAtrMultiple` | 0.5 | Reserved for the V1B level families. V1 does not read it: no V1 geometry tests level equality |
| `tolerance.percentOfPrice` | 0.01 | Used only in `percent` mode |
| `headShoulders.minHeadProminenceAtr` | 1.0 | Head clearly above both shoulders |
| `headShoulders.maxShoulderDifferenceAtr` | 1.0 | Shoulders within one scale unit |
| `headShoulders.maxShoulderDurationRatio` | 2.5 | Longer side at most 2.5 times the shorter |
| `headShoulders.maxNecklineSlopeAtrPerBar` | 0.2 | A neckline that is nearly flat relative to scale |
| `headShoulders.minPatternBars`, `maxPatternBars` | 15, 120 | Enough geometry, and bounded duration |
| `headShoulders.confirmationWindowBars` | 20 | Confirmation must come soon after geometry is known |
| `headShoulders.breakoutBufferAtr`, `outcome.failureBufferAtr` | 0.1, 0.1 | A close must clear the line by a fraction of scale |
| `double.maxPeakDifferenceAtr` | 1.0 | Peaks within one scale unit |
| `double.minReactionDepthAtr` | 1.5 | A real reaction, not noise |
| `double.minSeparationBars` | 8 | The peaks are not adjacent |
| `double.maxPatternBars` | 100 | Bounded duration |
| `double.confirmationWindowBars` | 20 | As for head and shoulders |
| `triangle.minTouchesPerSide` | 2 | At least two touches on each line |
| `triangle.minPatternBars`, `maxPatternBars` | 15, 100 | Enough geometry, bounded duration |
| `triangle.flatSlopeToleranceAtrPerBar` | 0.02 | A line is flat when it moves less than 2% of scale per bar |
| `triangle.minTrendSlopeAtrPerBar` | 0.03 | A line is trending when it moves at least 3% of scale per bar |
| `triangle.maxResidualAtr` | 0.5 | Touches lie close to their line |
| `triangle.minConvergence` | 0.2 | The width must narrow by at least 20% |
| `triangle.maxApexBarsAhead` | 60 | The apex is near enough to matter |
| `triangle.maxTriangleSwings` | 6 | A bounded window |
| `triangle.confirmationWindowBars` | 30 | As above, a longer structure |
| `triangle.breakoutBufferAtr` | 0.1 | As above |
| `outcome.targetToleranceAtr` | 0 | A target is touched exactly |
| `outcome.maxOutcomeBars` | 60 | Outcome window after confirmation |

## 19. Performance

Swing detection is `O(n · (left + right))`. ATR is `O(n)`. Candidate windows are `O(S · K)`, with `K` the constant window bound. The lifecycle of
one candidate walks at most `confirmationWindowBars + maxOutcomeBars` bars. Total work is therefore bounded by the number of bars and swings, with
constant factors fixed by the parameters. Tests assert the number of candidates and bars walked, not milliseconds.

## 20. Mutation isolation

Bars, ChartContext, parameters, anchors and shared helpers are never mutated. Inputs are copied into plain data. Outputs are frozen. A test fixes a
hash of the inputs before and after a run and asserts they are unchanged.

## 21. Versions

`pattern-engine:v1`, `pattern-geometry:v1`, `pattern-lifecycle:v1`. The swing and ATR versions above are carried in the fingerprint. None of this
changes the Quant Engine, the ChartContext, the Scanner, the O1 validator or the backtest engine.

## 22. Red team (regressions before the fix)

- a future swing used before its confirmation;
- a breakout confirmed from an intrabar high rather than a final close;
- a right shoulder known before its confirmation;
- a target computed from a future bar;
- same-bar target and failure ordering invented;
- non-consecutive or non-alternating anchors accepted;
- a triangle line fit that depends on input order;
- float rounding that changes a classification;
- ChartContext alignment that changes geometry;
- a reconstruction labelled as strict;
- invalid market data that still emits patterns;
- a duplicate pattern emitted twice;
- an observation id that is unstable;
- a pattern instance id that changes as the lifecycle advances;
- caller input mutated.

## 23. Limitations stated plainly

1. Consecutive structural windows only (section 7). A valid structure with an extra swing inside it is missed.
2. Pivots come from `findSwings` on doubles (section 5). Prices that tie at double precision can change a pivot. The engine states this and refuses
   series it cannot represent exactly.
3. Defaults are policy choices (section 18). They have no statistical support. No claim about success rates is made.
4. Confirmation and outcome use final closes and bar extremes. Intrabar order is never inferred (section 13).
5. Volume is not used. It is not a confirmation requirement and no volume is invented.
6. The geometry is verified on synthetic series in V1. Real-data validation comes with the outcome research, not before it.
7. No persistence. The run is a deterministic derived object, identified by its inputs.
8. The mirror relies on `ATR` and the true range being symmetric under negation. A test asserts this.
