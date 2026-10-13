# NEXUS Indicator Catalog and Expansion Plan

## Current implemented indicators

Quant Engine V1 already contains:

### Trend
- SMA
- EMA
- MACD
- ADX / +DI / -DI
- Market Structure HH/HL/LH/LL

### Momentum
- RSI

### Volatility
- ATR
- Bollinger Bands

### Volume / price
- Session VWAP

### Levels / structure
- Classic Pivot Points
- Fibonacci Pivot Points
- confirmed Swing High / Swing Low
- Support / Resistance

These are deterministic, versioned and point-in-time safe.

## Important principle

NEXUS does **not** become better by adding every indicator ever published.

Many indicators are mathematical transformations of the same price series and are highly redundant.

Example:
RSI, Stochastic, Williams %R and CCI all measure related aspects of momentum/position within a recent price range.

Therefore every new indicator must answer:

> Does this add independent useful information after costs and out-of-sample testing?

Indicator count is not a quality metric.

## Recommended additional indicator catalog

### Priority A — high-value additions

#### Stochastic Oscillator
- %K
- %D
- configurable smoothing
- deterministic warm-up
- useful for momentum/range context

#### ROC — Rate of Change
- N-period percentage change
- simple and interpretable momentum factor

#### OBV — On-Balance Volume
- volume accumulation/distribution proxy
- only when volume is meaningful/reliable

#### MFI — Money Flow Index
- price + volume momentum
- must be unavailable when volume quality is insufficient

#### CCI — Commodity Channel Index
- deviation from recent typical-price mean

#### Williams %R
- position of close within recent high-low range

#### Donchian Channels
- N-period high/low breakout structure
- directly useful for systematic breakout strategies

#### Keltner Channels
- EMA center + ATR envelope
- useful as a volatility/trend complement to Bollinger

#### Relative Volume
- current volume relative to comparable historical/session volume
- needs session-aware normalization

#### Average Dollar / Notional Volume
- liquidity filter for equities
- not universal across asset classes

### Priority B — valuable but more complex

#### Ichimoku
- Tenkan-sen
- Kijun-sen
- Senkou spans
- Chikou span

Important:
Traditional chart plotting shifts some lines forward/backward.
The computational representation must not leak future information.
At decision time NEXUS may only use values derivable from data available at that time.

#### Supertrend
- ATR-based trend state
- exact implementation/version must be fixed because variants differ

#### Parabolic SAR
- trend-following trailing structure
- implementation details must be explicitly versioned

#### Aroon
- Aroon Up / Down / Oscillator
- time since recent high/low

#### Chaikin Money Flow
- volume-weighted accumulation/distribution
- volume quality gate required

#### Accumulation / Distribution Line
- volume-dependent
- provider volume semantics matter

#### Chaikin Oscillator
- derived from A/D line

#### TRIX
- triple-smoothed EMA ROC

#### DPO — Detrended Price Oscillator
- useful for cycle analysis
- careful point-in-time alignment required

### Priority C — later / specialist

- Elder Ray Bull/Bear Power
- Force Index
- Ultimate Oscillator
- Klinger Volume Oscillator
- Ease of Movement
- Vortex Indicator
- Chande Momentum Oscillator
- TSI — True Strength Index
- PPO — Percentage Price Oscillator
- RVI — Relative Vigor Index
- Fisher Transform
- Hull Moving Average
- Kaufman Adaptive Moving Average
- DEMA / TEMA
- linear regression slope/channel
- rolling correlation/beta
- realized volatility
- historical volatility percentile
- Parkinson volatility
- Garman-Klass volatility

Only add these if a strategy/research question needs them.

## Regime indicators

NEXUS should not treat all markets identically.

Useful regime features:

- realized volatility
- ATR percentile
- ADX trend strength
- moving-average slope
- price dispersion
- market breadth later
- benchmark-relative strength
- correlation regime
- volume regime

Pattern statistics should be conditioned on regime where sample size permits.

## Relative strength

Important distinction:

RSI != relative strength versus another asset.

Add later:

- asset return vs benchmark return
- rolling excess return
- relative strength ratio
- relative strength percentile within universe

Examples:
AAPL vs S&P 500
sector ETF vs market
stock vs sector

This can be useful for scanner ranking.

## Breadth indicators — later market-level engine

For broad equity markets:

- Advance / Decline Line
- Advance / Decline Ratio
- New Highs / New Lows
- % above SMA50
- % above SMA200
- McClellan Oscillator later
- sector breadth

These require trustworthy point-in-time universe membership.
Do not implement breadth before survivorship-safe universe data exists.

## Fundamental and news are NOT technical indicators

Keep evidence types separate:

```text
TECHNICAL
PATTERN
FUNDAMENTAL
NEWS/CATALYST
MACRO
LIQUIDITY
RISK
```

This matters because several independent evidence families are stronger than twenty correlated price indicators.

## Indicator confluence

NEXUS may create a deterministic confluence representation, e.g.:

```text
Trend:
  EMA50 > EMA200
  ADX = 31

Momentum:
  RSI = 59
  MACD histogram positive

Structure:
  Higher High / Higher Low
  resistance breakout

Pattern:
  inverse H&S confirmed

Volume:
  relative volume elevated

Levels:
  breakout above 142.30
  next pivot 147.20
```

But do not simply count:
“6 bullish indicators = 86% buy”.

Indicators are correlated.

## Indicator redundancy analysis

Later build an Indicator Research layer that measures:

- pairwise correlation
- mutual information where appropriate
- incremental predictive value
- feature stability by regime
- out-of-sample contribution
- turnover / cost impact

If an indicator adds no robust incremental value, NEXUS should be allowed to ignore it.

## Warm-up requirements

Every new indicator defines:

- algorithmVersion
- requiredBars
- preferredBars
- unavailable conditions
- input requirements
- point-in-time semantics

Warm-up must be enforced before strategies can act.

## Golden-test requirement

For every indicator:

1. formula documented
2. seed convention documented
3. known numerical vector
4. independent reference calculation where practical
5. edge cases
6. no-look-ahead test
7. deterministic replay test

No library may silently define the formula for us without pinning conventions.

## Volume indicators

Volume-dependent indicators must carry a volume-quality decision.

Examples where raw reported volume can differ materially:
- equities
- crypto exchanges
- spot FX / tick volume
- CFDs

Do not compare volume indicators across providers/asset classes without semantics.

## Recommended next implementation sequence

After current Scanner/Backtest red-team review:

1. Pattern Engine core primitives
2. Pattern V1 catalog
3. Stochastic
4. ROC
5. OBV
6. MFI
7. CCI
8. Williams %R
9. Donchian Channels
10. Keltner Channels
11. Relative Volume
12. benchmark-relative strength
13. Ichimoku with explicit point-in-time-safe semantics
14. Supertrend / Aroon / Parabolic SAR if research shows value

Then run indicator ablation/redundancy research before adding more.

## Key principle

NEXUS should prefer:

> 8 independent, well-tested evidence features

over:

> 40 highly correlated indicators that all transform the same closing prices.

The goal is signal quality and reproducibility, not a large indicator menu.
