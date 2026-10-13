# Multi-Timeframe / Whole-Chart Context V1

Status: design, written before implementation on `feature/multitimeframe-chart-context-v1` (base `4aa4007`). Not merged.

Engine: `chart-context-engine:v1`. Hierarchy: `timeframe-hierarchy:v1`. Alignment: `alignment:v1`.

## 1. What it answers, and what it does not

It answers: "What does the market structure look like across the available native timeframes at this exact asOf?"

It does **not** answer whether to buy or sell. It produces no action, no size, no stop, no target, no probability, no score, no pattern, no AI
interpretation. Its output is descriptive, deterministic, and auditable.

## 2. The Quant Engine stays the numerical authority

ChartContext consumes verified `QuantRunRecord`s from `quant-engine:v3`. It recomputes nothing: no EMA, SMA, RSI, MACD, ADX, ATR, Bollinger,
VWAP, swings, support or resistance, or market structure. It reads the results and arranges them.

## 3. Verified inputs (fail closed)

Every input record passes `verifyRunRecord` (the stored `resultHash` must equal the hash of the stored result). Beyond that, the context checks:

- `engineVersion` is `quant-engine:v3`. Any other engine version is refused. There is no fallback.
- `quantRunId` equals `'qr_' + inputFingerprint[0..40]`.
- `marketStructure` is internally consistent with its own labels (section 6). A corrupted structure whose hash was recomputed still fails.
- `mode` is `final_only`. `include_in_progress` is refused.
- Each interval is one of the native intervals and is among the requested intervals.
- At most one run per interval. Two runs for the same interval are refused, never chosen between.

Every input must agree on the same `instrumentId`, `asOf`, `series.source`, `series.session`, `series.adjustment`, `barReplay`, and `useCase`.
Intervals differ by design. A mismatch on any other field is refused.

The caller states `instrumentId`, `asOf`, and `requestedIntervals` explicitly. A run whose `asOf` or `instrumentId` differs from the stated one is refused.
A run for an interval that was not requested is refused.

What the verification proves: a record is the one the Quant Engine stored, unchanged, and it is internally consistent. What it cannot prove: that
a process holding the functions did not construct the record. Persisted records are verified against their seals when read (`QuantRunStore`).

## 4. Native timeframes only

Native intervals in V1: `1m`, `5m`, `15m`, `1h`, `4h`, `1d` (`BAR_INTERVALS`). Nothing is synthesised: no weekly, no monthly, no daily-to-weekly
resampling.

Strategic and secular context is therefore **unavailable** in V1. It is never inferred from daily bars.

## 5. Timeframe state

Each supplied interval yields one `TimeframeState`. It carries the raw, deterministic values and statuses of its Quant run:

- `structure`: `trend` (from `marketStructure.trend`), `lastHighLabel`, `lastLowLabel`, `reason`.
- `momentum`: the raw `rsi` and `macd` indicator values, each with its own status.
- `trendStrength`: the raw `adx`, `plusDI`, `minusDI`.
- `volatility`: the raw `atr` and `bollinger` bandwidth.
- `levels`: `nearestSupport`, `nearestResistance`, `pivots` (classic and fibonacci, with status).
- `provenance`: the run's `barDataProvenance` fields, `barReplay`, `inputStart`, `inputEnd`, `barCount`.
- `quantRunId`, `quantResultHash`.
- `status`: `READY`, `INSUFFICIENT_DATA`, or `INVALID_DATA`.

Status rules, in order:

1. `INVALID_DATA`: `dataQuality.valid` is false. Such a run contributes **no** structural state. Its structure is reported as `unknown`
   with the reason `data invalid`, and it is never copied into alignment.
2. `INSUFFICIENT_DATA`: the data is valid, but a warm-up that the Quant Engine requires is not complete (`warmupStatus` has an entry with `ready = false`).
   Its structure is reported as `unknown` with the reason `warm-up not complete`.
3. `READY`: otherwise. A `READY` state may carry `trend = unknown` when there are too few confirmed swings. That is valid data, not invalid data.

Indicator values are not converted into trading truth. `RSI > 70` is not "bearish", `ADX > 25` is not "strong trend", `MACD > 0` is not "buy".
Those may become research hypotheses later.

## 6. Price structure is the V1 trend authority

The structural trend of a timeframe is `QuantResult.marketStructure.trend`. It is built from confirmed higher highs and lows
(`structure:swing-hhll:v1`). No second trend algorithm is introduced. EMA, MACD, and ADX stay descriptive context.

A consistency check runs on every input:

- `unknown` exactly when `lastHighLabel` or `lastLowLabel` is null;
- `bullish` exactly when the labels are `HH` and `HL`;
- `bearish` exactly when the labels are `LH` and `LL`;
- `range` otherwise (both labels present, not one of the two pairs above);
- when `points` is non-empty, the last high and the last low point carry the labels.

Disagreement between EMA, MACD, and structure is allowed and is reported as it is. It is never collapsed into a hidden score.

## 7. Timeframe hierarchy (`timeframe-hierarchy:v1`)

| Layer | Intervals |
|---|---|
| MICRO | 1m, 5m |
| INTRADAY | 15m, 1h |
| SWING | 4h |
| POSITION | 1d |
| STRATEGIC | none (unavailable in V1) |

Each daily bar is used in one layer only. This mapping follows the brief, not the broader horizons of
`docs/LEARNING_CONFLUENCE_MULTITIMEFRAME_SPEC.md` §"Timeframe hierarchy". The hierarchy is part of the context identity (section 11).

## 8. Layer state

A layer's state is derived from its intervals, and every interval stays visible underneath (`contributing` and `unusable` lists).

Usable intervals are `READY` states whose trend is `bullish`, `bearish`, or `range`. A `READY` state with trend `unknown` is listed as unusable
(`structure_unknown`). Invalid and insufficient intervals are listed as unusable with their status. A requested interval with no run is listed as `missing`.

- No usable interval: `unknown` if any interval is `READY` (structure not yet confirmed), otherwise `unavailable`.
- All usable intervals have the same trend: that trend (one usable interval, or agreement).
- Usable intervals disagree: `mixed`. Range counts as a trend here: `range` with `bullish` is `mixed`.

Nothing is chosen silently. A layer never picks 5m over 1m, or 1h over 15m.

## 9. Alignment (`alignment:v1`)

Alignment uses the POSITION, SWING, and INTRADAY layer states. MICRO is described but does not enter alignment. Let `p` be the POSITION trend
(`bullish` or `bearish`), `o` its opposite, and `S`, `I` the SWING and INTRADAY states.

Evaluated in this order:

1. If POSITION, SWING, or INTRADAY is `unknown` or `unavailable`: `INSUFFICIENT_CONTEXT`.
2. POSITION `range`: `RANGE_DOMINANT` if SWING and INTRADAY are both `range`, otherwise `CONFLICTED`.
3. POSITION `mixed`: `CONFLICTED`.
4. POSITION `p`:
   - S = p and I = p: `FULL_BULL_ALIGNMENT` (or `FULL_BEAR_ALIGNMENT`).
   - S = range and I = range: `RANGE_DOMINANT`.
   - S ∈ {o, mixed, range} and I ∈ {p, range}: `HIGHER_BULL_LOWER_PULLBACK` (or `HIGHER_BEAR_LOWER_RALLY`).
   - S = p and I ∈ {o, mixed, range}: `HIGHER_BULL_LOWER_PULLBACK` (or `HIGHER_BEAR_LOWER_RALLY`). The lower layer is corrective.
   - S ∈ {o, mixed, range} and I ∈ {o, mixed}: `CONFLICTED`.

These are structure descriptions, not orders. They are never called BUY, SELL, LONG_SETUP, or SHORT_SETUP.

## 10. Phase, dominant trend, secular trend

Phase (descriptive, not an order signal):

| Alignment | Phase |
|---|---|
| FULL_BULL_ALIGNMENT | `impulse_up` |
| FULL_BEAR_ALIGNMENT | `impulse_down` |
| HIGHER_BULL_LOWER_PULLBACK | `pullback_in_uptrend` |
| HIGHER_BEAR_LOWER_RALLY | `relief_rally_in_downtrend` |
| RANGE_DOMINANT | `range` |
| CONFLICTED | `transition` |
| INSUFFICIENT_CONTEXT | `unknown` |

Dominant trend: the highest available structural layer, in the order POSITION, SWING, INTRADAY, MICRO. It is not a vote.

- A layer that is `unknown` or `unavailable` is skipped (no confirmed structure).
- A layer that is `mixed` stops the search. The result is `unknown` with `sourceLayer` set to that layer and the reason `higher layer is mixed`.
  A lower timeframe never overrides a mixed higher layer.
- Otherwise `{ trend, sourceLayer }` is the first layer's state.
- If nothing is available: `{ trend: unknown, sourceLayer: null }`.

Secular trend: `{ status: 'unavailable', reason: 'weekly and monthly timeframes are not implemented' }`. It is never derived from daily bars.

## 11. Support and resistance context

Levels are preserved per timeframe with their origin. Nothing is merged, averaged, or moved into an invented level.

- `majorSupport` and `majorResistance`: the structural levels of the intervals `1d` and `4h` (the highest available native timeframes), ordered
  by interval (1d first), then by the Quant ordering (ascending price).
- `minorSupport` and `minorResistance`: the levels of the lower intervals. They are preserved, not discarded.

Each `ContextLevel` carries `interval`, `kind`, `price` (exact decimal string), `touchCount`, `firstSeen`, `lastSeen`, `confirmedAt`,
`strengthScore` (the Quant score, carried raw), `sourceQuantRunId`, and `sourceResultHash`. No confluence scoring is done here. That belongs to the
later Confluence Engine.

## 12. Provenance and coverage

Provenance is aggregated honestly, and the questions are not collapsed:

- `decisionTimeKnowledgeProven`: true only when every supplied run is decision-time proven. One unproven interval makes the context false.
- `historicalReconstruction`: true when any run is a reconstruction. A reconstructed warm-up does not downgrade decision-time knowledge.
- `legacyUnproven`: true when any run has legacy unproven bars.
- `allSignalBarsContemporaneous`: true only when every run's latest final bar is contemporaneous.
- `perTimeframe`: each interval's own provenance.

Coverage is descriptive:

- `requestedIntervals`, `readyIntervals`, `missingIntervals`, `invalidIntervals`, `insufficientIntervals`.
- `complete` is true only when every requested interval is `READY`. A context is not declared incomplete merely because an unrequested interval
  such as `1m` is absent.
- Missing or non-ready requested intervals do not stop the context from being computed.

Quality: `dataValid` (no invalid interval among the supplied runs) and `contextComplete` (= `coverage.complete`). No A/B/C grade. No performance metric.

## 13. Identity and fingerprint

`inputFingerprint` = hash of: engine version, hierarchy version, alignment version, the hierarchy mapping, `instrumentId`, `asOf`, the requested
intervals sorted by interval, and for each supplied run its interval, `quantRunId`, and `quantResultHash`. `createdAt` is never included.

`chartContextId = 'cc_' + inputFingerprint[0..40]`.

Input order does not matter: `[1d, 4h, 1h]` and `[1h, 1d, 4h]` give the same context, fingerprint, and identity. Changing one run's
`quantRunId` or `resultHash` changes the identity. Changing `asOf` changes it. Changing the hierarchy or alignment policy changes it.

## 14. Isolation

The context is built from frozen copies. It never mutates a `QuantResult`, a `QuantRunRecord`, an indicator object, or a level. Decimal values are
converted to strings at the boundary. A regression asserts that the caller's objects are byte-for-byte unchanged after a build.

## 15. Complexity

Work is O(number of timeframes + exposed levels). There are at most six native timeframes. Historical bars are not rescanned; that already happened
in the Quant Engine.

## 16. Persistence

None in V1. The context is a deterministic derived object whose identity binds the immutable Quant run identities. No migration is added.
Migrations 001–011 are unchanged.

## 17. Not available in V1 (stated explicitly)

- Weekly: not implemented.
- Monthly: not implemented.
- Secular trend: not implemented. No "strategic bullish" result is produced from daily bars alone.
- Pattern recognition (head and shoulders, triangles, flags, wedges, double tops and bottoms, candlesticks): not implemented. The next module is the Pattern Engine.
- Confluence scoring, probabilities, learned weights, AI interpretation, and any trade action: not implemented.

## 18. Red-team plan (regressions before the fix)

- two instruments mixed; two asOf values mixed; raw and split-adjusted mixed; historical and decision replay mixed;
- duplicate 1h inputs; an unrequested interval supplied;
- an invalid Quant trend contaminating alignment;
- unknown structure treated as bullish or bearish;
- input order changing the context;
- an `include_in_progress` run accepted;
- a future or unknown engine version accepted;
- a missing interval silently called complete;
- a lower timeframe overriding a higher trend;
- indicators becoming implicit votes;
- weekly or secular state fabricated;
- a corrupted result with a recomputed hash but inconsistent structure.

## 19. Versions

`chart-context-engine:v1`, `timeframe-hierarchy:v1`, `alignment:v1`. None of these changes the Quant Engine, the Scanner, the O1 validator, or the backtest engine.
