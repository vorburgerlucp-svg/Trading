# NEXUS Pattern Engine Specification — prepared 2026-10-08

## Purpose

NEXUS needs deterministic chart-pattern detection as a separate Quant evidence layer.

A chart pattern is **not** a buy/sell instruction and **not** a probability by itself.

The Pattern Engine answers:

- Is a known structure forming?
- How complete is it?
- At what point is it confirmed?
- Which price/time invalidates it?
- Which breakout/breakdown level matters?
- What deterministic target methods apply?
- What happened historically after the same pattern under comparable conditions?

AI may later interpret the result. It must never invent the pattern geometry, breakout level, invalidation, or historical success rate.

## Architecture

```text
Market Bars
  -> Data Quality
  -> Swings / Support-Resistance / Market Structure / ATR / Volume
  -> Pattern Engine
  -> PatternObservation[]
  -> Pattern Backtest Statistics
  -> Scanner
  -> later: News / Fundamentals / AI Council
```

Pattern detection belongs in Quant, not in the AI layer.

## Core distinction

Every pattern has a lifecycle:

```text
CANDIDATE
  -> FORMING
  -> CONFIRMED
  -> TARGET_ACTIVE
  -> COMPLETED
or
  -> INVALIDATED
or
  -> FAILED_BREAKOUT
or
  -> EXPIRED
```

NEXUS must never label a future-completed shape as if it were already known in the past.

A pattern may only use swing points whose `confirmedAt <= asOf`.

## Proposed canonical type

```ts
interface PatternObservation {
  patternObservationId: string;
  patternType: PatternType;
  algorithmVersion: string;

  instrumentId: string;
  interval: BarInterval;
  series: QuantSeriesId;

  direction: 'bullish' | 'bearish' | 'neutral';

  status:
    | 'candidate'
    | 'forming'
    | 'confirmed'
    | 'target_active'
    | 'completed'
    | 'invalidated'
    | 'failed_breakout'
    | 'expired';

  asOf: string;

  firstSeenAt: string;
  confirmedAt?: string;
  invalidatedAt?: string;

  progressScore: number;       // 0..1 geometry completion; NOT probability
  geometryScore: number;       // 0..1 fit quality; NOT probability
  symmetryScore?: number;
  volumeScore?: number;

  anchorPoints: PatternAnchor[];
  breakoutLevel?: Decimal;
  breakdownLevel?: Decimal;
  invalidationLevel?: Decimal;

  targetMethod?: string;
  targetPrice?: Decimal;

  expectedDirection?: 'up' | 'down';

  evidenceRefs: string[];
  inputFingerprint: string;
}
```

Scores are geometry/fit scores only.

They must never be named confidence/probability unless statistically calibrated.

## Pattern catalog

### Reversal patterns

#### Head and Shoulders
- Head and Shoulders Top
- Inverse Head and Shoulders

Required deterministic concepts:
- left shoulder swing
- head swing
- right shoulder swing
- neckline from the two intervening reaction points
- shoulder symmetry tolerance
- head prominence
- neckline slope
- breakout/breakdown confirmation
- optional volume confirmation

Target:
measured distance from head to neckline projected from confirmed break.

Invalidation:
geometry/version-specific, e.g. recovery through the opposite shoulder/head structure.

No trade signal before neckline confirmation unless a strategy explicitly backtests an early-entry rule.

#### Double Top / Double Bottom
- two comparable extrema
- minimum separation in bars/time
- tolerance based on ATR or percentage
- intervening reaction point
- confirmation only after neckline/reaction break

Target:
height of formation projected from neckline.

#### Triple Top / Triple Bottom
Same principles with three extrema and stricter geometry controls.

#### Rounded Top / Rounded Bottom
V2 unless a robust deterministic curve-fit definition is validated.
Avoid subjective visual matching in V1.

#### Cup and Handle
V2 candidate unless deterministic cup depth, duration, rim tolerance and handle constraints are implemented and independently tested.

### Continuation / consolidation patterns

#### Ascending Triangle
- approximately horizontal resistance
- rising swing lows
- minimum touches
- convergence
- confirmation above resistance

#### Descending Triangle
- approximately horizontal support
- falling swing highs
- confirmation below support

#### Symmetrical Triangle
- descending highs
- ascending lows
- converging trend lines

Need:
- line-fit quality
- apex
- breakout before/near apex policy
- minimum pattern duration

#### Rectangle / Trading Range
- horizontal support/resistance clusters
- repeated touches
- bounded volatility
- breakout confirmation

#### Rising Wedge
- rising support and resistance
- convergence
- direction cannot be assumed from name alone without backtested rule set

#### Falling Wedge
- falling support and resistance
- convergence

#### Bull Flag
- impulsive bullish pole
- bounded/downward consolidation
- breakout continuation rule

#### Bear Flag
mirrored definition

#### Bull Pennant
- strong bullish pole
- small converging consolidation

#### Bear Pennant
mirrored definition

#### Channels
- ascending channel
- descending channel
- horizontal channel

Use fitted swing lines with explicit residual tolerances.

### Breakout / retest structures

These should be first-class structures because they are often more useful than visual pattern labels:

- resistance breakout
- support breakdown
- breakout + successful retest
- breakdown + failed retest
- false breakout / bull trap
- false breakdown / bear trap

A retest cannot be known until the later retest bar is available.

### Candlestick patterns

Keep them separate from multi-bar structural patterns.

V1 catalog:
- Hammer
- Inverted Hammer
- Hanging Man
- Shooting Star
- Doji
- Dragonfly Doji
- Gravestone Doji
- Bullish Engulfing
- Bearish Engulfing
- Morning Star
- Evening Star
- Piercing Line
- Dark Cloud Cover
- Harami bullish/bearish
- Three White Soldiers
- Three Black Crows
- Tweezer Top
- Tweezer Bottom

Candlestick patterns must use exact numeric definitions and tolerance policies.
Names alone are insufficient.

Do not claim universal predictive power.

## V1 recommended scope

Do NOT implement every known visual pattern in one pass.

Highest-value deterministic V1:

1. Head and Shoulders / Inverse H&S
2. Double Top / Double Bottom
3. Triple Top / Triple Bottom
4. Ascending Triangle
5. Descending Triangle
6. Symmetrical Triangle
7. Rising Wedge
8. Falling Wedge
9. Bull Flag / Bear Flag
10. Bull Pennant / Bear Pennant
11. Rectangle / Range
12. Breakout / Breakdown
13. Breakout Retest / Breakdown Retest
14. False Breakout / False Breakdown
15. Channels
16. Candlestick V1 catalog

Cup & Handle and rounded formations should follow only after deterministic definitions are proven.

## Point-in-time requirements

Pattern detection must consume only:

- bars with `availableAt <= asOf`
- final bars by default
- confirmed swing points with `confirmedAt <= asOf`

Example:

If a right shoulder looks valid at bar 100 but requires three right-side bars for swing confirmation, the pattern cannot be marked confirmed until those three later bars exist and are available.

Any historical replay must reproduce exactly what NEXUS could have known at that time.

## Geometry and tolerances

Never use hard-coded visual intuition.

Tolerance sources should be versioned and preferably volatility-aware:

- ATR multiple
- percent of price
- tick size
- duration ratio
- line-fit residual
- slope constraints

Example concepts:

```text
same_level_tolerance = 0.5 * ATR(14)
min_pattern_bars
max_pattern_bars
min_swing_separation
max_shoulder_height_difference
max_neckline_slope
min_head_prominence
triangle_min_touches
flag_max_retracement_of_pole
```

All thresholds belong in `PatternParameters` and in the fingerprint.

## Volume confirmation

Volume can be evidence, not a requirement for every asset.

Examples:
- equities: useful
- spot FX: provider volume may be unsuitable
- some crypto venues: venue-specific

If volume is unavailable or unreliable:
`volumeScore = unavailable`

Never invent volume confirmation.

## Targets and pivots

Pattern targets must be deterministic and versioned.

Examples:

- H&S: vertical head-to-neckline distance projected from break
- Double top/bottom: formation height projected from neckline
- Triangle: widest formation height projected from breakout
- Flag/pennant: pole projection, but this must be independently backtested

These are **technical target methods**, not expected values and not guaranteed prices.

Pattern target can be compared with:
- Pivot levels
- Support/resistance
- ATR
- prior swing levels

If multiple independent structures cluster near the same level, NEXUS may record a confluence score.

Again: confluence score != probability.

## Historical pattern statistics

This is the crucial part.

NEXUS must not use internet claims such as “this pattern succeeds 73% of the time” as trading truth.

We should build a `PatternOutcomeEvaluator` from our own point-in-time data.

For every confirmed pattern record:

- pattern type + algorithm version
- instrument
- asset class
- interval
- market regime
- volatility regime
- pattern geometry bucket
- volume-confirmed yes/no/unavailable
- breakout strength
- entry rule
- stop rule
- target rule
- transaction-cost model
- maximum favorable excursion
- maximum adverse excursion
- target hit before stop?
- return after N bars
- failure / false breakout
- elapsed bars to outcome

Then aggregate only after adequate sample size.

## Probability / calibration policy

Do not expose:

`patternProbability = 72%`

unless the number comes from a documented, out-of-sample calibrated estimator with enough independent observations.

Before calibration use fields like:

- sampleSize
- historicalHitRate
- Wilson confidence interval
- medianForwardReturn
- meanForwardReturn
- medianMFE
- medianMAE
- falseBreakoutRate

Historical hit rate is descriptive evidence, not a guaranteed probability for the next trade.

Require regime- and asset-aware cohorts where sample sizes permit.

## Avoiding data-mining / overfitting

Pattern Engine creates a large multiple-testing problem.

Required safeguards:

- algorithm versions frozen before OOS evaluation
- in-sample / validation / out-of-sample split
- walk-forward evaluation
- never optimize on the final OOS period
- track every tested pattern/version
- minimum sample size
- correct for repeated experimentation later
- benchmark against simple alternatives

A pattern that works only after many threshold tweaks is suspect.

## Scanner integration

Patterns become deterministic scanner features.

Examples:

```text
pattern = inverse_head_shoulders
status = forming
progressScore = 0.82
neckline = 142.30
confirmationAbove = 142.30
invalidationBelow = 134.10
technicalTarget = 151.80
```

Scanner may rank:

- forming pattern near confirmation
- confirmed breakout
- confirmed pattern with favorable R:R
- pattern + support/resistance/pivot confluence
- pattern + trend/ADX/volume agreement

It must not automatically buy.

## Watchlist logic

Useful states:

### FORMING
“This structure may become an inverse H&S. Watch neckline X.”

### NEAR_CONFIRMATION
“Price is within Y ATR of the confirmation level.”

### CONFIRMED
“Breakout confirmed using rule version Z.”

### FAILED
“Breakout failed / invalidation reached.”

This is ideal for NEXUS watchlists.

## News and fundamental confirmation

After deterministic pattern detection:

```text
Pattern Observation
  + Quant
  + Company Fundamentals
  + Macro
  + News/Catalysts
  -> later AI Council
  -> Risk Engine
  -> Capital Engine
```

News must not define whether the geometric pattern exists.

News answers separate questions:
- Is there a catalyst explaining the move?
- Is there material earnings/guidance/legal/M&A/macro information?
- Is current sentiment/events consistent or contradictory?
- Is there scheduled event risk before entry/target?

Example:

```text
Inverse H&S: CONFIRMED
Technical target: 151.80
ADX: strengthening
Volume: confirmed
Fundamentals: neutral
News: earnings in 2 days
Risk decision: NO_TRADE / WATCH because event risk dominates
```

A good technical pattern can still produce NO_TRADE.

## Pattern + fundamental evidence must remain independent

Never train or tune the detector using whether the later news was bullish/bearish.

Otherwise future information can leak into the pattern label.

First detect pattern from price/volume point-in-time.
Then attach contemporaneously available external evidence.

## News architecture preparation

Future `CatalystEvidence` should include:

- source
- publishedAt
- availableAt
- retrievedAt
- instrument/entity mapping
- category
- event date
- content hash
- source credibility metadata
- structured claims
- untrusted=true

External article text is DATA, never instructions.

AI-generated news interpretation remains untrusted model output.

## Persistence

Proposed tables:

```text
pattern_runs
pattern_observations
pattern_anchors
pattern_outcomes
pattern_statistics
```

Do not mutate historical pattern observations.

When an algorithm changes:
new algorithm version -> new observations/statistics.

## Testing requirements

### Golden geometry tests
Synthetic exact shapes:
- H&S
- inverse H&S
- double/triple top/bottom
- triangles
- wedges
- flags
- pennants
- rectangles
- channels

### Near-miss negative tests
Shapes that look similar but violate:
- shoulder tolerance
- head prominence
- touch count
- slope constraints
- time symmetry
- breakout confirmation

Detector must reject them.

### No-look-ahead tests
Change every bar after T.
All pattern states at T remain identical.

### Formation-state tests
Pattern must progress:
candidate -> forming -> confirmed
without knowing later completion early.

### Failure tests
- failed breakout
- invalidation
- expiry

### Scale invariance
For percentage/ATR-based geometry, multiplying all prices by a constant should not change pattern classification.

### Timestamp invariance
Changing retrieval time without changing availability knowledge should not rewrite historical state.

### Reproducibility
Same data + same parameters + same algorithm version -> identical patternObservationId.

## Integration with Backtest Engine

Pattern rules must be backtestable as ordinary deterministic strategy features.

Examples:

- entry at next executable bar after confirmed neckline break
- stop below invalidation
- target from measured move
- no same-bar hindsight
- cost/slippage/gap model still applies

Pattern statistics must be calculated using realistic execution rules, not geometric target touches alone.

## Definition of Done for Pattern Engine V1

- deterministic detectors for V1 catalog
- point-in-time safe
- forming/confirmed/invalidated lifecycle
- versioned parameters
- targets/invalidation
- unit + adversarial + no-look-ahead tests
- persistent observations
- PatternOutcomeEvaluator
- historical descriptive statistics
- scanner integration
- no probability unless calibrated
- no live execution
- no AI required to recognize geometry

## Recommended implementation order

1. Pattern types / lifecycle / parameter schema.
2. Common line-fit and swing-geometry primitives.
3. Double top/bottom.
4. H&S / inverse H&S.
5. Triangles.
6. Wedges / channels.
7. Rectangle / breakout/retest.
8. Flags / pennants.
9. Candlestick module.
10. Persistence.
11. Outcome evaluator.
12. Scanner integration.
13. Historical statistics.
14. Only later: News/Fundamental enrichment and AI interpretation.

## Key principle

NEXUS should say:

> “A bullish inverse head-and-shoulders pattern is confirmed under algorithm v1. The neckline is X, invalidation is Y, measured technical target is Z. In 184 comparable out-of-sample historical observations under this exact rule set, the target-before-stop hit rate was A with interval B, after costs.”

It must never say:

> “This pattern means the stock has a 78% chance of rising.”

unless that probability has actually been calibrated and validated.
