# Pattern Engine V1C: flags, pennants and a deterministic candlestick catalog

Status: design, written before implementation. Base: `3bfb9ae` (`feature/pattern-v1b-lineage-hardening`).
Branch: `feature/pattern-engine-v1c-flags-candles`. Not merged.

V1C completes the V1 catalog with two families:

- **Structural continuation:** `bull_flag`, `bear_flag`, `bull_pennant`, `bear_pennant`.
- **Candlesticks:** `hammer`, `inverted_hammer`, `hanging_man`, `shooting_star`, `doji`, `dragonfly_doji`, `gravestone_doji`,
  `bullish_engulfing`, `bearish_engulfing`, `morning_star`, `evening_star`, `piercing_line`, `dark_cloud_cover`, `bullish_harami`,
  `bearish_harami`, `three_white_soldiers`, `three_black_crows`, `tweezer_top`, `tweezer_bottom`.

Not in V1C: AI, trade actions, success probabilities, hit-rate or internet claims, statistics, persistence, ChartContext-driven geometry.
Migrations 001–011 stay byte-identical.

Every subjective threshold is versioned and listed in §12. Defaults are design policy, not market truth.

---

## 1. Preserve all existing behaviour

Before any V1C code change, the instance ids of the existing V1 and V1B structures are frozen:

- V1: `test/patterns/golden/v1-observations.json` (the V1 golden, from `36dd8ab`).
- V1B: `test/patterns/golden/v1b-ids.json` (the instance ids of the V1B fixtures, from `3bfb9ae`). Captured on the base before any V1C change.

Both are compared by `v1c-regression.test.ts`, which filters to the types that existed at the base, so new V1C types do not disturb it.

### 1.1 Frozen identity tags

`V1B_IDENTITY.engine` and `V1B_IDENTITY.geometry` were derived from the run's engine constants. A V1C version bump would have changed every V1B
id. They become literals (`'pattern-engine:v1b'`, `'pattern-geometry:v1b'`), and the golden proves the ids are unchanged.

V1C has its own tags:

| Family | Identity tags |
|---|---|
| V1 | `pattern-engine:v1`, `pattern-geometry:v1` (unchanged) |
| V1B | `pattern-engine:v1b`, `pattern-geometry:v1b` (literal) |
| V1C flags and pennants | `pattern-engine:v1c`, `pattern-geometry:v1c` |
| V1C candlesticks | `pattern-engine:v1c`, `candlestick-policy:v1`, `candle-geometry:v1`, `candle-context:v1` |

## 2. Same PIT view, final bars only

Every V1C detector receives the output of `buildPitView(...)`. There is no second replay path.

- The view is a prefix. A non-final bar, a decision-time knowledge gap, a bar after asOf or an unavailable revision ends the series. No later bar can
  join, so no candle, pole, flag or pennant can use one.
- Candlestick patterns and flags use final bars only. The view contains final bars only, so no forming candle is ever read, and no confirmation
  comes from an unfinished bar.

## 3. Exact decimal candle geometry

For each candle, with `Decimal` values taken directly from the bar:

```
range      = high − low
body       = |close − open|
upperWick  = high − max(open, close)
lowerWick  = min(open, close) − low
```

- `bullish`: `close > open`. `bearish`: `close < open`.
- `neutral`: `body ≤ doji.maxBodyToRange × range` (the doji tolerance). A candle with `range = 0` is degenerate: it yields no candle pattern.

OHLC is never converted through `Number` for candle geometry. ATR, which is double-based, is used only as the scale for ATR-normalised thresholds, as
in V1.

## 4. Candle context: deterministic, price-only, before the candle (`candle-context:v1`)

The prior context of candle `i` uses only bars before `i`:

- `netAtr = (close[i−1] − close[i−1−lookbackBars]) / ATR(i−1)`, with `lookbackBars = 5`.
- `rising` if `netAtr ≥ minMoveAtr`; `falling` if `netAtr ≤ −minMoveAtr`; otherwise `range`.
- `insufficient` if there are not enough bars or ATR is unavailable.

`minMoveAtr = 1.0`. The trend definition is `net-close-change:v1`.

Not used: future bars, ChartContext, RSI, MACD, news, any later outcome.

## 5. Contextual single-candle names

The name depends on the shape and the prior context, never on the shape alone.

| Shape | Prior `falling` | Prior `rising` | Prior `range` or `insufficient` |
|---|---|---|---|
| lower-long (hammer shape) | `hammer` | `hanging_man` | **none** |
| upper-long (inverted-hammer shape) | `inverted_hammer` | `shooting_star` | **none** |

**Decision:** in range or insufficient context, no contextual alias is emitted. An explicitly neutral "shape" observation would be a new name without
a textbook meaning. Emitting nothing is the conservative choice, and it is tested (context flip test, §30).

A candle never receives two names for one geometry. Hammer and hanging man are exclusive, as are inverted hammer and shooting star, because
context is mutually exclusive between them.

## 6. Doji family and precedence

Body threshold `doji.maxBodyToRange` (inclusive):

1. `body ≤ maxBodyToRange × range` (a doji-shaped candle), then the most specific name:
   - `dragonfly_doji` if `lowerWick ≥ longWick.minWickToRange × range` and `upperWick ≤ smallOppositeWick.maxOppositeWickToRange × range`;
   - else `gravestone_doji` if the mirror holds;
   - else `doji`.
   The generic doji is **not** emitted alongside a dragonfly or gravestone.
2. Otherwise the hammer-shape rules of §5 apply, with `body ≤ hammerShape.maxBodyToRange × range`.

A doji-shaped candle never receives a hammer-shape name, because the body thresholds are disjoint.

## 7. Two-candle definitions (bodies)

**Engulfing** (`previous` = candle `i−1`, `current` = candle `i`):

- `bullish_engulfing`: previous bearish with a body, current bullish with a body, and the current body contains the previous body:
  `current.open ≤ previous.close` and `current.close ≥ previous.open`, both inclusive (`equalityPolicy = inclusive`), and
  `currentBody ≥ engulfing.minBodyRatio × previousBody` (`minBodyRatio = 1.0`).
- `bearish_engulfing`: the mirror (`current.open ≥ previous.close`, `current.close ≤ previous.open`).

The entire wick range is **not** required to engulf.

**Harami** uses the same containment, with the current body strictly smaller:

- `bullish_harami`: previous bearish with a body, current bullish, `previous.close ≤ current.open`, `current.close ≤ previous.open`, and
  `currentBody < harami.maxBodyRatio × previousBody` (`maxBodyRatio = 1.0`, strict).
- `bearish_harami`: the mirror.

Engulfing and harami are exclusive by construction: `currentBody ≥ previousBody` for engulfing, `<` for harami.

**Piercing line** (bullish current, bearish previous):

- `current.open < previous.close` (opens below the previous close; the optional gap condition, §11).
- `current.close ≥ previous.close + piercing.minPenetration × previousBody` (`minPenetration = 0.5`, inclusive).
- `current.close < previous.open` (not an engulfing, which would require `≥`).

`dark_cloud_cover` is the mirror: bullish previous, bearish current, `current.open > previous.close`,
`current.close ≤ previous.close − minPenetration × previousBody`, `current.close > previous.open`.

Piercing and dark cloud are exclusive by colour.

Overlaps between two-candle families are explicit: engulfing vs harami vs piercing vs dark cloud are exclusive. The tweezers (§9) use extremes,
not bodies, and may legitimately overlap a body pattern (§13).

## 8. Three-candle definitions (stars and soldiers)

**Morning star** (`c1`, `c2`, `c3` = candles `i−2`, `i−1`, `i`):

- `c1` bearish with `body1 ≥ star.minFirstBodyAtr × ATR(i)`.
- `c2` small: `body2 ≤ star.maxMiddleBodyToRange × range2` (`0.3`, inclusive).
- Location (optional gap): `max(open2, close2) ≤ close1`.
- `c3` bullish with `close3 ≥ close1 + star.minThirdPenetration × body1` (`0.5`, inclusive).
- Strict gap mode (§11): additionally `high2 < close1` (candle 2 entirely below the first body) and `open3 > high2` (candle 3 opens above candle 2).

`evening_star` is the mirror: `c1` bullish, `min(open2, close2) ≥ close1`, `c3` bearish with `close3 ≤ close1 − minThirdPenetration × body1`, strict:
`low2 > close1` and `open3 < low2`.

The star is first seen when candle 3 is usable. It never uses a fourth candle.

**Three white soldiers** (three bullish candles):

- each candle: `body/range ≥ soldiersCrows.minBodyToRange` (`0.6`, inclusive) and `upperWick ≤ maxOppositeWickToRange × range` (`0.2`, inclusive);
- each candle opens within the previous real body: `previous.open ≤ current.open ≤ previous.close` (inclusive);
- progression: `close_{k} − close_{k−1} ≥ soldiersCrows.minProgressionAtr × ATR(i)` (`0.1`, inclusive).

**Three black crows** is the mirror: bearish candles, lower wick the opposite wick, closes falling.

No future continuation is inferred, and no folklore indicator is used.

## 9. Tweezers

- `tweezer_top`: candle `i−1` bullish and candle `i` bearish, with `|high(i−1) − high(i)| ≤ tweezer.maxExtremeDifferenceAtr × ATR(i)`
  (`0.05`, inclusive). Context requirement (decided and versioned, `tweezer.requiresContext = true`): the prior context of candle `i−1` is `rising`.
- `tweezer_bottom`: the mirror on lows, candle `i−1` bearish and candle `i` bullish, prior context `falling`.

Exact binary equality is not required. Tolerance is in ATR units. The colour requirement is classic and explicit.

## 10. Gap policy (`candlestick-gap-policy:v1`)

A gap is a price fact of the bars, not an assumption. The policy classifies the series:

| State | When |
|---|---|
| `SESSION_GAP_REQUIRED` | `assetClass` is `stock` or `etf`, and the series session is `regular` |
| `UNSUPPORTED_FOR_SERIES` | `assetClass` is `crypto` or `forex`, or the series session is `continuous` |
| `GAP_OPTIONAL` | every other series |

Gap-dependent definitions (the strict star and the strict piercing and dark cloud, §7–§8):

- **Optional mode (default):** the opening condition only. No gap is required, so none is fabricated. The observation records
  `gapPolicy` = the state, and `gapSatisfied` = `optional`.
- **Strict mode** (`candlestick.gapMode = 'strict'`): the price gap must exist **and** the state must be `SESSION_GAP_REQUIRED`. Otherwise the pattern
  is **not emitted**. A 24x7 series therefore never produces a strict gap-dependent pattern.

Patterns that depend on the gap policy: morning star, evening star (strict gap rules). Piercing and dark cloud (gap-optional opening condition).
Engulfing, harami, dojis, hammers, tweezers and soldiers and crows do not depend on it.

## 11. Candlestick instance identity and first-seen

```
patternInstanceId = 'pi_' + hash({
  kind: 'candle-instance',
  engine: 'pattern-engine:v1c', candlestickPolicy: 'candlestick-policy:v1', candleGeometry: 'candle-geometry:v1',
  patternType, instrumentId, interval, series,
  barStartTimes: [...exact participating bar starts]
})
```

Context is not bound (the name depends on context, but the instance is the candle group: the same candles under a different context get a different
`patternType`, and therefore a different instance). `asOf`, the outcome and ChartContext are never bound.

`firstSeenAt`: single candle → its replay instant; two candles → candle 2; three candles → candle 3. Never the candle `startTime`.

## 12. Parameters (policy defaults, not market truth)

Versioned in `PatternParameters` and in the run fingerprint.

```
candlestick (candlestick-policy:v1)
  doji.maxBodyToRange                      0.1    inclusive
  longWick.minWickToBody                   2.0    inclusive
  longWick.minWickToRange                  0.6    inclusive
  smallOppositeWick.maxOppositeWickToRange 0.1    inclusive
  hammerShape.maxBodyToRange               0.35   inclusive
  engulfing.minBodyRatio                   1.0    inclusive; equalityPolicy = inclusive
  harami.maxBodyRatio                      1.0    strict (<)
  piercing.minPenetration                  0.5    inclusive
  star.maxMiddleBodyToRange                0.3    inclusive
  star.minFirstBodyAtr                     1.0    inclusive
  star.minThirdPenetration                 0.5    inclusive
  tweezer.maxExtremeDifferenceAtr          0.05   inclusive
  tweezer.requiresContext                  true
  soldiersCrows.minBodyToRange             0.6    inclusive
  soldiersCrows.maxOppositeWickToRange     0.2    inclusive
  soldiersCrows.minProgressionAtr          0.1    inclusive
  gapMode                                  'optional' | 'strict'
candleContext (candle-context:v1)
  lookbackBars                             5
  minMoveAtr                               1.0    inclusive
  trendDefinitionVersion                   'net-close-change:v1'
pole (pole-policy:v1)
  minMoveAtr                               3.0    inclusive
  minBars                                  3
  maxBars                                  20
  maxInternalRetracement                   0.5    inclusive (of the pole move)
  minDirectionalEfficiency                 0.5    inclusive
  maxStartSwings                           6      how far back the pole start is searched
flag (flag-pennant:v1, flag consolidation)
  minTouchesPerSide                        2
  minBars                                  3
  maxBarsToPoleRatio                       1.0    inclusive
  maxRetracementOfPole                     0.5    inclusive
  maxResidualAtr                           0.5    inclusive
  maxFlatSlopeAtrPerBar                    0.02   inclusive: bull slopes ≤ this (not rising beyond tolerance)
  maxParallelDiffAtr                       0.03   inclusive
  maxSwings                                4
  confirmationWindowBars                   20
pennant (flag-pennant:v1, pennant consolidation)
  minTouchesPerSide                        2
  minBars                                  3
  maxBarsToPoleRatio                       1.0    inclusive
  maxRetracementOfPole                     0.5    inclusive
  maxResidualAtr                           0.5    inclusive
  minSlopeAtrPerBar                        0.03   inclusive, each side in magnitude
  minConvergence                           0.3    inclusive
  maxApexBarsAhead                         20     inclusive
  maxSwings                                4
  confirmationWindowBars                   20
```

Validation refuses a value outside its domain.

## 13. Overlaps and taxonomy

Within one exact geometry family, aliases never duplicate:

- doji family: dragonfly > gravestone > doji (one name per candle);
- hammer family: lower-long vs upper-long are exclusive; hammer vs hanging man is exclusive by context;
- two-candle bodies: engulfing vs harami exclusive; piercing vs dark cloud exclusive;
- soldiers vs crows exclusive; star vs soldiers and crows exclusive (colours).

Legitimate overlaps across **different scopes** are emitted, and are not suppressed:

- a middle doji of a morning star is also a standalone `doji` (a different scope);
- a tweezer top or bottom may coincide with a body pattern on the same two candles (extremes vs bodies);
- a flag or pennant may overlap a channel or triangle on the same bars (§17).

## 14. Flags and pennants: the pole first (`pole-policy:v1`)

A flag or pennant needs a valid impulse pole. No pole is invented visually.

**The pole** is a pair of confirmed swings (real space for bull, mirrored space for bear):

- `start` = a swing low (bull), `end` = a swing high, with `minBars ≤ end.index − start.index ≤ maxBars`;
- `move = end.price − start.price` and `move ≥ minMoveAtr × ATR(end.confirmedIndex)`;
- directional efficiency `|close(end) − close(start)| / Σ|close(t) − close(t−1)| ≥ minDirectionalEfficiency`;
- the largest drawdown from a running close peak within the pole, divided by `move`, is `≤ maxInternalRetracement`.

The pole is searched backwards from the consolidation's start: the nearest valid start, within `maxStartSwings`, is taken.

**The pole ends before the consolidation begins.** The consolidation's first swing has a larger index than the pole end. Only swings confirmed by
the consolidation's last swing are used. A later breakout bar cannot define the pole, because the pole is chosen only from swings that precede the
consolidation.

## 15. Flag and pennant consolidation (flag-pennant:v1)

The consolidation is a bounded, alternating window of confirmed swings that starts at the swing after the pole end. For each consolidation start, the
longest valid window (up to `maxSwings`) is kept.

**Shared checks:**

- `minTouchesPerSide` highs and lows;
- duration from the pole end to the window's last swing: `minBars ≤ bars ≤ maxBarsToPoleRatio × poleBars`;
- retracement of the pole: `(poleEnd.price − lowest consolidation low) / poleMove ≤ maxRetracementOfPole`;
- residual: each side's maximum deviation from its least-squares line `≤ maxResidualAtr × ATR`.

Lines are fitted with `leastSquares` and `maxResidual` from `line.ts`, and the apex with `apexOf` (no duplicate triangle fitting).

**Bull flag:** both slopes (ATR per bar) `≤ maxFlatSlopeAtrPerBar` (downward or near-horizontal relative to the pole), `|sU − sL| ≤ maxParallelDiffAtr`,
and the width is positive at both ends.

**Bull pennant:** `sU ≤ −minSlopeAtrPerBar` and `sL ≥ minSlopeAtrPerBar` (converging, each side non-flat), convergence
`(w0 − w1)/w0 ≥ minConvergence` with `w1 > 0`, and the apex ahead within `(0, maxApexBarsAhead]`.

A window cannot satisfy both: a flag is parallel, a pennant converges by at least `minConvergence`.

**Bear flag and pennant** are the bull definitions applied to the mirrored space (as V1 does for bottoms): slopes and metrics are reported in the
original orientation.

## 16. Flag and pennant lifecycle and direction

Boundaries (candidate space):

- `breakUp` = upper line (continuation confirmation in the pole direction);
- `invalidateDown` = lower line (a decisive break against the pole invalidates);
- `failDownAfterUp` = upper line (a close back below it after a continuation is a failed breakout).

The lifecycle is the V1 `walkCandidate`:

- `forming` until a final close above the upper line plus `breakoutBufferAtr × ATR`. Never from a wick alone.
- `confirmed` on that close, with the direction in the pole direction.
- A final close below the lower line minus `failureBufferAtr × ATR` before confirmation: `invalidated`. Opposite break is never labelled a successful continuation.
- `target_active`, `completed` on a high touching the target, and `failed_breakout` on a close back below the upper line. Same-bar target and failure: `outcome_ambiguous` (the V1 rule).
- `expired` when no breakout occurs within `confirmationWindowBars` after geometry is known.

**Direction.** The name describes the pole direction and the setup geometry, not the outcome. The observation's `direction` is `neutral` while forming,
and the actual confirmed direction after a breakout.

**Target.** `pole_length_projected_from_breakout`: the upper line at the confirmation bar plus the pole move (bear: the lower line minus the move).
This is a technical geometry target. It is not an expected return, a take-profit or a probability.

## 17. Relationships: flag versus channel or triangle

A flag or pennant is a structural shape **plus** a valid prior pole. A channel or triangle is a shape alone. A flag and a channel can describe the same
bars, and that overlap is legitimate; neither is suppressed.

Each flag or pennant carries `patternLineage`:

- `eventFamilyId` = hash of the **pole** (its direction and anchors). Several flags or pennants that share one pole share this id.
- `relationship` = `root`, `parentPatternInstanceId` = `null`, `rootPatternInstanceId` = itself.

A consumer must count the pole once. The members of one pole-family are related observations, not independent evidence. A generic channel or
triangle on the same bars is a separate family and is **not** linked in V1C (documented limitation).

## 18. Identity of flags and pennants

```
patternInstanceId = 'pi_' + hash({
  kind: 'pattern-instance', engine: 'pattern-engine:v1c', geometry: 'pattern-geometry:v1c',
  instrumentId, interval, patternType,
  anchors: [pole_start, pole_end, consolidation touches]   // role, kind, time, price
})
```

Lifecycle advancement (status, breakout, target) never changes it.

## 19. Candlestick observations

- `status`: `confirmed` (a candle group is complete when its last candle is usable), `confirmedAt` = `firstSeenAt`.
- `target`: `none`. `invalidation`: `none`. No stop, no take-profit, no expected return.
- `direction`: the direction of the final candle's real body (`bullish`, `bearish`, or `neutral` for a doji-shaped body). Descriptive only.
- `candles`: the participating candles with role, bar start, and exact OHLC text.
- `candleContext`: `{ policy: 'candle-context:v1', state, netAtr }` for contextual candles, else `null`.
- `geometryMetrics`: exact text for `range`, `body`, `upperWick`, `lowerWick`, and the ratios used.

## 20. Fingerprint

The run fingerprint adds every semantic version and policy:

`pattern-engine:v1c`, `pattern-geometry:v1c`, `candlestick-policy:v1`, `candle-geometry:v1`, `candle-context:v1`,
`candlestick-gap-policy:v1`, `pole-policy:v1`, `flag-pennant:v1`, plus the existing V1, V1B, lineage and support/resistance versions and the
complete parameter set. The run metadata carries each version.

## 21. Performance

- Candles: O(number of bars). Each candle reads a fixed local window (at most the context lookback, one previous candle and two previous candles).
- Flags and pennants: per space, for each consolidation start, at most `maxStartSwings` pole starts and `maxSwings` window ends. Each pole check
  reads at most `maxBars` closes. The total is O(swings × constants), never a search over pole and consolidation subsets.
- Diagnostics: `candleEvaluations`, `candleCandidates`, `flagPoleChecks`, `flagWindows`, `flagCandidates`.

## 22. Test plan

- **Golden:** one exact synthetic positive for every candle type and for each flag or pennant type, with participating indices, `firstSeenAt`, metrics and identity stability.
- **Near misses:** just inside, exactly at, and just outside each threshold (exclusive and inclusive as declared), at the unit level with exact `Decimal` values
  for the candle rules, and at the engine level for the flag and pennant parameters.
- **Context flip:** the same hammer and inverted-hammer geometry, with falling and rising prior sequences.
- **Gaps:** a sessioned equity fixture (strict gap semantics); a 24x7 fixture (no fabricated gap, strict patterns not emitted).
- **No look-ahead:** every bar after asOf changed, outputs identical; an unusable middle bar ends the prefix; a future candle cannot complete a star
  early; a future swing cannot construct a pole early; a breakout cannot define its own pole.
- **Identity:** V1 golden and V1B id golden unchanged; V1C ids stable across lifecycle.
- **Scale:** OHLC ×10 gives the same classification, lifecycle and normalized metrics, and prices ×10.
- **ChartContext:** the same bars with a different context give the same geometry.
- **Decimal:** candle geometry never converts OHLC through `Number` (checked with exact decimal boundaries).

## 23. Red team

The tests try to falsify: hammer versus hanging man decided by shape alone; future bars changing the context; a morning star emitted before candle 3;
a fabricated 24x7 gap; inconsistent equality; a pole chosen with a later breakout; a pennant that re-implements the triangle line maths; a ChartContext
changing the geometry; a V1 or V1B identity regression; the PIT prefix bridged; candle OHLC converted through `Number`; a flag, channel and pennant
counted as unrelated lineages; a scale change altering normalized classification.

## 24. Limitations

- Candle names are labels of geometry plus a price-only prior context. They are not predictions, and they carry no statistics.
- Tweezers require the colour pattern and the prior context. Other colour combinations of equal highs or lows are not tweezers.
- Flag and pennant poles are price-only swing pairs. A pole is not a volume-confirmed impulse.
- The optional gap mode makes the strict gap conditions a subset. A pattern detected in optional mode is not verified as a true session gap.
- A flag or pennant is not linked to a channel or triangle on the same bars (§17).
- Thresholds are design policy and are not validated out-of-sample. No success rate or expected return is produced.
