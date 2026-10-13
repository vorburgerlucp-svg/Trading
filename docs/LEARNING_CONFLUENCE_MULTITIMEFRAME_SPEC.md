# NEXUS Learning, Confluence & Multi-Timeframe Intelligence

Prepared: 2026-10-08

## Mission

Learning is a first-class NEXUS objective.

NEXUS should continuously improve its understanding of:

- chart structure
- technical indicators
- chart patterns
- indicator combinations
- pattern + indicator combinations
- market regimes
- timeframes / investment horizons
- fundamentals
- macroeconomics
- news and catalysts
- execution / transaction costs
- strategy failure modes
- its own model/agent performance

But learning must be **controlled research**, not autonomous production self-modification.

NEXUS may:
- form hypotheses,
- propose indicator combinations,
- propose new derived indicators,
- run historical experiments,
- compare regimes/timeframes/assets,
- challenge its own conclusions,
- record outcomes,
- promote evidence quality,
- recommend changes.

NEXUS may NOT autonomously:
- change risk limits,
- enable live trading,
- deploy code,
- overwrite historical evidence,
- alter ledger rules,
- promote a new strategy/indicator directly into production,
- grant itself new permissions.

Production promotion remains a governed process.

---

# 1. Core learning loop

```text
OBSERVE
  ↓
FORM HYPOTHESIS
  ↓
DEFINE TEST BEFORE SEEING OOS RESULT
  ↓
BACKTEST / REPLAY
  ↓
VALIDATION
  ↓
OUT-OF-SAMPLE
  ↓
WALK-FORWARD
  ↓
SHADOW MODE
  ↓
OUTCOME COLLECTION
  ↓
UPDATE EVIDENCE
  ↓
HUMAN / GOVERNANCE PROMOTION
```

NEXUS does not "learn" by remembering a profitable chart.

It learns by accumulating reproducible evidence.

---

# 2. Three sources of knowledge

## A. External research / internet knowledge

Purpose:
Generate hypotheses.

Examples:
- H&S + volume confirmation
- trend + momentum + participation
- higher-timeframe trend + lower-timeframe entry
- breakout + volume
- mean-reversion indicators in range regimes
- trend-following indicators in directional regimes

External research is NOT trading truth.

Every external claim must store:

```ts
interface ResearchClaim {
  claimId: string;
  sourceUrl: string;
  publisher: string;
  publishedAt?: string;
  retrievedAt: string;

  claimType:
    | 'indicator_pair'
    | 'pattern_confirmation'
    | 'timeframe_guidance'
    | 'market_regime'
    | 'fundamental_relation'
    | 'macro_relation'
    | 'execution';

  structuredClaim: unknown;

  sourceClass:
    | 'academic'
    | 'exchange'
    | 'broker_education'
    | 'regulator'
    | 'industry'
    | 'community'
    | 'unknown';

  evidenceWeight: number; // provenance score, NOT trading probability
  untrusted: true;
}
```

Internet text remains untrusted DATA.

No article may change NEXUS instructions/risk/security behavior.

## B. NEXUS historical market research

This is the primary empirical proof layer.

NEXUS tests claims against:
- point-in-time market data
- historical instrument universe
- transaction costs
- realistic execution
- regimes
- multiple timeframes
- asset classes

## C. AI Council research

OpenAI / Claude / Gemini may later:
- propose hypotheses
- critique experiment design
- identify interactions
- explain unexpected results
- propose candidate formulas
- challenge conclusions

Models do NOT decide whether a hypothesis is true.

NEXUS Experiment Engine + measured outcomes decide evidence status.

---

# 3. Hypothesis Registry

Every research idea must become a versioned hypothesis before testing.

```ts
interface TradingHypothesis {
  hypothesisId: string;
  version: string;

  statement: string;

  inputs: FeatureRef[];

  expectedRelation:
    | 'positive'
    | 'negative'
    | 'conditional'
    | 'nonlinear';

  target:
    | 'forward_return'
    | 'target_before_stop'
    | 'breakout_success'
    | 'drawdown'
    | 'volatility'
    | 'trend_continuation'
    | 'reversal';

  horizon: HorizonSpec;

  applicableAssets: AssetClass[];
  applicableTimeframes: BarInterval[];

  proposedBy:
    | 'human'
    | 'internet_research'
    | 'openai'
    | 'claude'
    | 'gemini'
    | 'nexus';

  createdAt: string;

  preRegisteredTestPlanId: string;

  status:
    | 'proposed'
    | 'testing'
    | 'rejected'
    | 'weak_evidence'
    | 'supported'
    | 'shadow'
    | 'production_candidate';
}
```

This prevents NEXUS from changing the hypothesis after seeing the answer.

---

# 4. Confluence Engine

NEXUS needs a dedicated `ConfluenceEngine`.

It must NOT be:

```text
RSI bullish = +1
MACD bullish = +1
H&S bullish = +1
3 points = BUY
```

That double-counts correlated evidence.

Instead group evidence by information family.

## Evidence families

### Trend
- SMA / EMA
- MACD trend component
- ADX / DI
- market structure
- regression slope

### Momentum
- RSI
- Stochastic
- ROC
- CCI
- Williams %R

### Volatility
- ATR
- Bollinger
- Keltner
- realized volatility

### Participation / volume
- volume
- relative volume
- OBV
- MFI
- CMF

### Structure
- support/resistance
- pivots
- breakouts/retests
- swing structure

### Pattern
- H&S
- double bottom/top
- triangles
- flags
- wedges
- candlestick structures

### Relative strength
- asset vs benchmark
- asset vs sector
- percentile in universe

### Fundamental
- valuation
- earnings
- margins
- growth
- balance-sheet quality

### Macro
- rates
- inflation
- FX
- commodities
- liquidity/regime

### Catalyst / news
- earnings
- guidance
- M&A
- legal/regulatory
- product
- macro event
- geopolitical

The Confluence Engine should favor evidence from independent families.

Example:

```text
Pattern: inverse H&S confirmed
Trend: daily EMA50 > EMA200
Participation: breakout on high relative volume
Momentum: RSI 58
```

This may be stronger than:

```text
RSI bullish
Stochastic bullish
Williams %R bullish
CCI bullish
```

because the second group may be four transformations of similar momentum information.

---

# 5. Internet-derived hypothesis catalog

These are hypotheses to TEST, never hard-coded truths.

## H&S / inverse H&S

Research hypothesis:
- geometry + neckline break
- volume behavior may improve confirmation
- momentum/trend context may alter outcome

Candidate confluence:
- H&S + Relative Volume
- H&S + OBV divergence
- H&S + ADX regime
- H&S + higher-timeframe trend context
- H&S + support/resistance confluence

## Flags / Pennants

Candidate hypotheses:
- strong pole
- reduced volume during consolidation
- renewed volume on breakout
- trend strength / ADX
- higher-timeframe trend alignment

## Triangles

Candidate hypotheses:
- converging structure
- breakout + relative volume
- ADX transition from low/compression to rising
- ATR/Bollinger compression before expansion
- higher-timeframe trend direction

## Breakouts

Candidate hypotheses:
- breakout + relative volume
- breakout + OBV
- breakout + ADX rising
- breakout + retest
- breakout aligned with higher timeframe
- breakout against major weekly resistance may fail more often

## Double bottoms/tops

Candidate hypotheses:
- second extreme + momentum divergence
- neckline break
- volume change
- higher-timeframe support/resistance
- regime dependence

Again: NEXUS must measure whether any of these combinations actually add value.

---

# 6. Combination research

NEXUS should automatically test combinations, but under strict experiment control.

Example:

```text
Pattern only
vs
Pattern + ADX
vs
Pattern + Relative Volume
vs
Pattern + ADX + Relative Volume
vs
Pattern + RSI
vs
Pattern + RSI + Volume
```

Measured outputs:

- sample size
- hit rate
- forward returns
- expectancy
- max drawdown
- MFE / MAE
- false breakout rate
- turnover
- cost drag
- performance by regime
- performance by asset
- performance by timeframe

Then compute incremental contribution:

```text
Does adding indicator B to A improve OOS outcome?
Does adding C still help after A+B?
```

Do NOT select the best combination solely on in-sample profit.

---

# 7. Multiple-testing protection

NEXUS will eventually test thousands of combinations.

That creates a severe false-discovery problem.

Required controls:

- count every configuration tested
- immutable experiment registry
- train / validation / OOS split
- walk-forward
- untouched final holdout
- minimum sample
- strategy-family comparison
- Probability of Backtest Overfitting / CSCV later
- Deflated Sharpe Ratio later
- false-discovery correction where appropriate
- no silent parameter search
- no reusing final holdout until it becomes historical and a new holdout exists

NEXUS must know:

`we tried 4,812 variants before finding this one`

That information is part of evidence quality.

---

# 8. Multi-Timeframe Intelligence

This is mandatory.

NEXUS should never see only a 1-minute chart and call it "the trend".

It needs a hierarchical market view.

## Timeframe hierarchy

Proposed canonical layers:

### Microstructure
- seconds / 1m / 3m / 5m
- execution timing
- intraday noise
- liquidity
- very short momentum

### Intraday
- 15m / 30m / 1h
- session trend
- intraday setups
- tactical entry

### Swing
- 4h / daily
- multi-day / multi-week structures
- major technical setups

### Position
- daily / weekly
- months
- primary trend
- structural support/resistance

### Strategic
- weekly / monthly
- multi-year
- secular regime
- long-term valuation / macro context

### Very long horizon
- monthly / quarterly-derived fundamentals
- 5–10 year historical context
- secular valuation/cycle analysis

---

# 9. "Whole chart" analysis

NEXUS needs `ChartContext`, not isolated indicators.

```ts
interface ChartContext {
  instrumentId: string;
  asOf: string;

  horizons: {
    micro?: TimeframeState;
    intraday?: TimeframeState;
    swing?: TimeframeState;
    position?: TimeframeState;
    strategic?: TimeframeState;
  };

  dominantTrend: TrendState;
  secularTrend: TrendState;

  currentPhase:
    | 'impulse_up'
    | 'pullback_in_uptrend'
    | 'impulse_down'
    | 'relief_rally_in_downtrend'
    | 'range'
    | 'transition'
    | 'unknown';

  majorSupport: Level[];
  majorResistance: Level[];

  timeframeAlignment: TimeframeAlignment;
}
```

Example:

```text
5m: bullish breakout
1h: recovery rally
4h: bearish correction
Daily: bullish primary trend
Weekly: bullish secular trend

Interpretation:
short-term bullish move occurring inside a 4h pullback,
while the larger daily/weekly structure remains bullish.
```

That is much better than:
`5m RSI = 62 -> bullish`

---

# 10. Multi-Timeframe Alignment

NEXUS should compute deterministic relationships.

Examples:

```text
FULL_BULL_ALIGNMENT
weekly bullish
daily bullish
4h bullish
1h bullish

PULLBACK_LONG_SETUP
weekly bullish
daily bullish
4h bearish/corrective
1h stabilizing/bullish

COUNTER_TREND_RALLY
weekly bearish
daily bearish
4h bullish
1h bullish

CONFLICTED
no coherent hierarchy
```

These are states, not trading orders.

---

# 11. Timeframe-specific indicator research

NEXUS should learn empirically:

```text
Which indicator works where?
```

For each indicator/pattern:

```ts
interface FeaturePerformanceProfile {
  featureId: string;
  version: string;

  assetClass: AssetClass;
  timeframe: BarInterval;
  regime: Regime;

  sampleSize: number;

  incrementalValue: number | null;
  stabilityScore: number;

  forwardReturnStats: ...
  hitRateStats: ...
  drawdownStats: ...

  transactionCostSensitivity: ...;

  evidenceStatus:
    | 'insufficient'
    | 'unstable'
    | 'weak'
    | 'supported'
    | 'strong';
}
```

Never hard-code:
"RSI works on 15m."

Instead learn:
"For US large-cap equities, RSI14 mean-reversion in low-ADX 15m sessions showed X OOS behavior under algorithm version Y."

---

# 12. Horizon-aware analysis

Trading horizons are different problems.

## Scalping
seconds–minutes

Important:
- spread
- latency
- order-book/liquidity
- transaction costs

Long-term fundamentals mostly irrelevant to immediate entry.

## Day trading
minutes–hours

Important:
- session VWAP
- volume
- intraday S/R
- catalysts
- market index context

## Swing trading
days–weeks

Important:
- daily/4h structure
- patterns
- trend/momentum
- earnings/calendar risk
- fundamentals begin to matter more

## Position trading
weeks–months

Important:
- daily/weekly trend
- fundamentals
- macro
- earnings cycle
- valuation
- sector strength

## Long-term investing
months–10+ years

Important:
- financial statements
- cash flow
- balance sheet
- competitive advantage
- industry
- macro/secular trends
- valuation

Minute indicators should not dominate a 10-year thesis.

---

# 13. Horizon weighting engine

NEXUS should choose evidence weights based on the requested horizon.

Example only:

```text
1-day trade:
technical 45
pattern 20
liquidity/execution 20
news 15
fundamental small

3-year position:
fundamental 40
macro 20
weekly/monthly technical 20
valuation 15
short-term technical 5
```

These weights should NOT be permanently hand-coded as truth.

Start as human priors.
Then measure/calibrate with outcome data.

---

# 14. Learning from outcomes

Every decision must later have an outcome record.

```text
What did NEXUS believe?
What evidence was available?
Which models agreed/disagreed?
Which pattern existed?
Which timeframes aligned?
What did the asset actually do?
What would have happened under different execution rules?
Which evidence was useful?
Which evidence was noise?
```

Update performance metadata only.

Never rewrite the original decision.

---

# 15. NEXUS Research Lab

Create a separate research environment.

It may:

- search external sources
- create hypotheses
- generate candidate formulas
- generate candidate indicator combinations
- generate candidate strategy rules
- run experiments
- compare results
- produce research reports

It cannot:

- deploy to production
- enable live execution
- alter risk
- alter ledger
- silently promote itself

## Candidate new indicator lifecycle

```text
IDEA
-> FORMULA SPEC
-> UNIT TEST
-> GOLDEN TEST
-> HISTORICAL RESEARCH
-> REDUNDANCY TEST
-> OOS
-> WALK-FORWARD
-> SHADOW
-> GOVERNANCE REVIEW
-> PRODUCTION FEATURE
```

---

# 16. New indicator invention

Yes: NEXUS may propose new derived features.

Examples:

```text
normalized trend strength
= ADX * relative volume * directional consistency

breakout quality
= distance beyond resistance / ATR
  × volume expansion
  × close location in bar
```

But a formula is only a hypothesis.

NEXUS must record:
- exact formula
- formula version
- who proposed it
- how many variants were tried
- train/validation/OOS results
- redundancy with existing features
- cost sensitivity
- regime stability

No formula is promoted because it looks good once.

---

# 17. AI Council learning roles

Roles stay dynamic, not vendor-hardcoded.

Possible tasks:

### Researcher
find literature / market hypotheses

### Quant Critic
find statistical flaws

### Market Structure Analyst
propose chart interpretation

### Fundamental Analyst
evaluate company/economy

### Devil's Advocate
find why the thesis may fail

### Experiment Reviewer
review experimental leakage / multiple testing

NEXUS decides which model performs each role based on measured performance.

---

# 18. Shared Research Blackboard

AI models may collaborate through structured research claims.

Example:

```ts
interface ResearchBlackboardEntry {
  hypothesisId: string;
  authorModelRunId: string;

  claim: string;

  evidenceRefs: string[];

  claimClass:
    | 'external_claim'
    | 'empirical_result'
    | 'critique'
    | 'alternative_explanation'
    | 'proposed_experiment';

  untrusted: true;
}
```

No free-form model text can alter system behavior.

---

# 19. Internet Research Engine

Future research agent should search:

Priority:
1. peer-reviewed / academic
2. exchanges / regulators
3. broker research / education
4. respected industry material
5. community/social as sentiment/hypothesis only

Store claim provenance.

Do not continuously scrape the internet into trading rules.

External knowledge creates hypotheses.
NEXUS data validates them.

---

# 20. Economic / fundamental learning

The same learning architecture applies beyond charts.

Hypotheses:

```text
What happens to bank equities when yield curve steepens?
How do high-growth stocks respond to real-rate changes?
How does oil price affect airline margins?
How do earnings surprises behave in different valuation regimes?
```

NEXUS can build conditional historical profiles.

This is how chart + economics eventually meet.

---

# 21. Cross-domain confluence

Example future NEXUS assessment:

```text
SECULAR:
Weekly/monthly uptrend

PRIMARY:
Daily trend bullish

TACTICAL:
4h pullback ending

PATTERN:
Inverse H&S forming on 1h
neckline = 142.30

MOMENTUM:
RSI recovery from 42 -> 54

TREND STRENGTH:
ADX rising

PARTICIPATION:
Relative Volume 1.8x

LEVEL:
Daily support 134.50
Weekly resistance 151.00

FUNDAMENTAL:
Revenue growth stable
balance sheet strong

CATALYST:
earnings in 2 days

HISTORICAL:
pattern cohort appears positive OOS,
but sample only 63

RISK:
earnings gap risk dominates

ACTION:
WATCH / NO_TRADE
```

This is the desired NEXUS behavior.

---

# 22. Evidence hierarchy

NEXUS should explicitly know the difference between:

```text
internet claim
historical in-sample result
validation result
out-of-sample result
walk-forward result
paper-trading result
small-live result
production outcome
```

Production evidence is stronger than an online article.

---

# 23. Learning score

Do not create one simplistic "knowledge score".

Track dimensions separately:

- sample size
- OOS stability
- regime stability
- asset stability
- cost robustness
- temporal stability
- provider robustness
- redundancy
- calibration
- experiment count / overfitting risk

---

# 24. Forgetting / adaptation

Markets change.

NEXUS must detect:
- performance decay
- regime shifts
- feature degradation

Historical evidence should not disappear.

Instead:

```text
historically strong
recently weak
possible regime dependency
```

Use rolling and expanding evaluation windows.

---

# 25. Safety boundary for learning

Learning never overrides Risk Engine.

Even a strategy with strong evidence cannot:
- exceed position limits
- bypass capital controls
- bypass liquidity rules
- enable live trading
- modify the ledger

AI proposes.
Quant verifies.
Research measures.
Risk controls.
Capital Engine constrains.
Human governs critical production changes.

---

# 26. Source-backed starting hypotheses

The following are suitable as initial research hypotheses, not truths:

### Automated chart patterns
Academic work by Lo, Mamaysky & Wang found that systematically recognized technical patterns including head-and-shoulders and double-bottom-type structures contained incremental information in a large historical US equity sample.

### Volume confirmation
Broker technical-analysis material commonly uses volume to confirm trend/breakout participation, including H&S and flags/pennants.

### Multi-timeframe analysis
Industry education commonly uses a top-down workflow:
higher timeframe -> dominant trend/context
middle timeframe -> setup
lower timeframe -> entry/timing

### Technical + fundamental
Industry material treats technical and fundamental analysis as complementary evidence families rather than substitutes.

### Overfitting warning
Financial backtest research shows that trying many strategy variants can produce impressive but spurious backtests.

Therefore NEXUS must log all experiments and protect true OOS data.

---

# 27. Required new modules

Proposed future modules:

```text
src/research/
  hypothesis-registry.ts
  experiment-registry.ts
  external-research.ts
  evidence-quality.ts
  experiment-runner.ts
  multiple-testing.ts
  feature-performance.ts
  learning-memory.ts

src/confluence/
  confluence-engine.ts
  evidence-family.ts
  redundancy.ts

src/timeframes/
  timeframe-hierarchy.ts
  chart-context.ts
  alignment.ts
  horizon-policy.ts

src/patterns/
  ... Pattern Engine

src/quant/research/
  feature-ablation.ts
  indicator-combinations.ts
```

---

# 28. Persistence

Future tables:

```text
research_sources
research_claims
hypotheses
experiment_plans
experiment_runs
experiment_variants
oos_evaluations
feature_performance_profiles
confluence_profiles
timeframe_profiles
learning_events
candidate_indicators
candidate_indicator_versions
```

All append-only / versioned where financially relevant.

---

# 29. Tests

Mandatory:

- no-look-ahead across all timeframes
- higher timeframe bar not visible before availableAt
- no incomplete weekly/monthly candle used as final
- DST/session alignment
- exact resampling rules
- no future higher-timeframe close leaking into lower timeframe
- experiment pre-registration immutability
- holdout cannot be used during optimization
- tested variant count retained
- candidate feature cannot promote itself
- risk controls unaffected by research
- same experiment inputs -> same result
- AI text cannot alter experiment rules

---

# 30. Priority for implementation

After the current Scanner/Backtest independent Haiku review:

1. Multi-Timeframe data/resampling semantics
2. ChartContext / whole-chart state
3. Pattern Engine V1
4. Confluence evidence families
5. Hypothesis + Experiment Registry
6. Outcome evaluator
7. Indicator-combination research
8. Timeframe-performance profiles
9. External research ingestion
10. AI Research Council in Shadow Mode
11. Candidate new-indicator research sandbox
12. Multiple-testing / PBO / deflated-performance controls

Do not connect autonomous learning directly to live execution.

---

# Final design objective

NEXUS should eventually be able to say:

> On the 15-minute chart a bullish breakout is forming, but the 4-hour chart remains in a corrective downswing inside a bullish daily and weekly primary trend. The inverse H&S pattern is not yet confirmed. Relative volume and ADX are improving. Historical OOS tests show that this exact pattern + volume + trend-state combination behaved better than the pattern alone for this asset class and timeframe, but only across 117 independent observations and the effect weakened in high-volatility regimes. Earnings are tomorrow, so the Risk Engine keeps the opportunity on WATCH.

That is learning.

Not:

> Three indicators are green, therefore buy.
