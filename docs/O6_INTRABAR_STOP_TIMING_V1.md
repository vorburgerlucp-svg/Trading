# O6: bounded intrabar stop timing (intrabar-timing:v1, backtest-engine:v11)

Status: design, written before RED tests and implementation. Base: `29c9a48` (O5 executable risk sizing merged).

## 1. Problem

The engine already distinguishes exact open fills from protective levels touched somewhere inside an OHLC bar. A gap through a stop or take-profit is `OPEN_EXACT`; a level touched only by the bar range is currently `INTRABAR_UNKNOWN`.

That distinction is directionally correct, but the current unknown timing uses `bar.startTime` as the fill's `at` and as the beginning of its timing window. For an intraday bar this commonly equals the executable bar open. For a daily/session bar it may not: the data window can start at a civil/UTC boundary while the economic session opens later. Recording the window from `bar.startTime` therefore makes the exit appear possible before the instrument could trade.

O6 tightens the timing contract without inventing tick data or an OHLC path.

## 2. Scope

O6 changes only the timing representation and verification of protective stop/take-profit exits in the single-instrument long-only backtest.

Unchanged:
- entry sizing and O5 risk economics;
- execution prices and cost model;
- corporate-action transformations;
- strategy evaluation clock;
- warm-up;
- conservative vs `mark_ambiguous` intrabar policy;
- actual gap-through pricing;
- point-in-time data and universe semantics;
- Live Trading, Broker Orders and Physical Purchase remain LOCKED.

No tick feed, synthetic path, interpolation, Brownian bridge, random ordering or lower-timeframe reconstruction is introduced in V1.

## 3. Timing categories

### 3.1 OPEN_EXACT

A protective exit is exact only when the raw bar open itself proves the trigger:

- long stop: `bar.open <= stopLoss`;
- long take-profit: `bar.open >= takeProfit`.

The raw fill price is the actual bar open and `executionAt` is the executable market open from `execution-clock:v1`.

This remains an exact instant.

### 3.2 INTRABAR_BOUNDED

When the open does not trigger the level but the OHLC range proves that it was touched later in the bar, the exit time is not exact.

The timing record is:

```
{
  kind: 'INTRABAR_BOUNDED',
  earliestAt,
  latestBefore,
  barStart,
  barEnd,
  basis: 'OHLC_RANGE_TOUCH'
}
```

Semantics:
- `earliestAt` is the earliest economic instant at which this fill could have happened;
- `latestBefore` is the exclusive upper bound;
- the true fill instant lies in `[earliestAt, latestBefore)`;
- neither bound is claimed to be the actual execution instant;
- `at` equals `earliestAt` only as a deterministic ordering key and must never be described as an exact execution time.

For a position already open before the bar:
- `earliestAt = executable open of this bar`.

For a position entered at this bar's executable open:
- `earliestAt = entry fill executionAt`.
- In V1 that is the same executable open, but the dependency is explicit so the exit can never predate the entry.

`latestBefore = bar.endTime`.

The engine must reject an impossible bound where `earliestAt >= latestBefore`.

## 4. Why bar.startTime is not enough

A bar window is a data interval, not necessarily an executable market session. For a daily XNAS bar, the data interval can start before the 09:30 America/New_York regular-session open. An OHLC stop touch cannot therefore be placed at the data window start.

O6 anchors the lower bound to `executionOpenOf(bar, calendar)`, not to `bar.startTime`.

The original `barStart` and `barEnd` remain in the timing record for provenance and audit.

## 5. Stop and take-profit semantics

For a long position:

1. Gap through stop at open -> stop at open, `OPEN_EXACT`.
2. Gap through take-profit at open -> take-profit at open, `OPEN_EXACT`.
3. Only stop touched by range -> stop at stop level, `INTRABAR_BOUNDED`.
4. Only take-profit touched by range -> take-profit at target level, `INTRABAR_BOUNDED`.
5. Both touched in one OHLC bar:
   - `conservative`: execute the adverse stop at the stop level, but timing remains `INTRABAR_BOUNDED`; no order is invented.
   - `mark_ambiguous`: create no exit fill and increment `ambiguousBars`.

The conservative outcome is a policy choice about P&L, not evidence of which level traded first.

## 6. Same-bar entry and protective exit

The event order remains:

1. corporate actions due at the open;
2. pending market order at executable open;
3. protective stop/take-profit over that bar;
4. mark at close;
5. strategy evaluation.

Therefore a market entry at the executable open may be stopped or targeted later in the same bar when the OHLC range proves a touch.

For such an exit:
- it may not predate the entry;
- `earliestAt` is the entry's exact execution time;
- an open-trigger cannot be applied twice after the entry because the entry itself happened at that open; only the post-open range-touch semantics apply to the newly opened position.

This point must be covered explicitly by RED tests.

## 7. Fill schema

`FillTiming` becomes:

```
type FillTiming =
  | {
      kind: 'OPEN_EXACT';
      executionAt: string;
      barStart: string;
      openSource: 'regular_session_open' | 'intraday_bar_start';
    }
  | {
      kind: 'INTRABAR_BOUNDED';
      earliestAt: string;
      latestBefore: string;
      barStart: string;
      barEnd: string;
      basis: 'OHLC_RANGE_TOUCH';
    };
```

Historical `backtest-engine:v7` through `v10` records with `INTRABAR_UNKNOWN` remain valid historical records and are not reinterpreted.

The stored decoder/verifier must therefore understand the legacy variant when reading old runs, while new v11 runs must emit only `OPEN_EXACT` or `INTRABAR_BOUNDED`.

## 8. `at` field

For v11:
- `OPEN_EXACT`: `fill.at === timing.executionAt`.
- `INTRABAR_BOUNDED`: `fill.at === timing.earliestAt`.

For bounded fills, `at` is a stable sort/index key, not an assertion that the fill occurred exactly then.

Any duration or latency calculation must branch on timing kind. It may use an exact duration only when both relevant instants are exact. Otherwise it must report a range/unknown result rather than silently using `at` as an exact timestamp.

## 9. Verification

`verifyBacktestRun` for v11 must fail closed when:

- an `OPEN_EXACT` fill has `at != executionAt`;
- an `INTRABAR_BOUNDED` fill has `at != earliestAt`;
- `earliestAt >= latestBefore`;
- either bound lies outside the economic bar window;
- `latestBefore != barEnd`;
- `barStart >= barEnd`;
- a v11 protective range-touch fill uses legacy `INTRABAR_UNKNOWN`;
- a v11 market-entry or strategy-exit fill uses bounded timing;
- a v11 gap-through protective fill is not `OPEN_EXACT`.

The verifier must not infer an exact intrabar timestamp.

## 10. Identity and versioning

- Add `INTRABAR_TIMING_VERSION = 'intrabar-timing:v1'`.
- `BACKTEST_ENGINE_VERSION` becomes `backtest-engine:v11`.
- The input fingerprint includes the engine version and intrabar timing version.
- The existing `intrabarPolicy` remains part of the input identity.
- Historical runs are not reinterpreted.

## 11. RED test matrix

Before implementation, tests must demonstrate the v10 deficiencies and the intended v11 contract.

Required RED cases:

1. A daily XNAS bar whose `bar.startTime` precedes the regular-session open: a range-touch stop must have `earliestAt` equal to the session open, not `bar.startTime`.
2. Same-bar entry at the executable open followed by a stop touch: bounded exit cannot predate the entry.
3. Carried position stopped intrabar on a later bar: lower bound is that bar's executable open.
4. Intrabar take-profit uses the same bounded timing semantics.
5. Gap-through stop remains `OPEN_EXACT` and fills at actual open.
6. Gap-through take-profit remains `OPEN_EXACT`.
7. Both stop and target touched under `conservative`: adverse stop, bounded timing, no invented ordering.
8. Both touched under `mark_ambiguous`: no fill; `ambiguousBars` increments.
9. A tampered v11 bounded timing record fails verification.
10. A historical v10 run containing `INTRABAR_UNKNOWN` still verifies under legacy rules.
11. Repeated identical v11 runs produce identical timing records, fingerprint and run id.
12. Changing only the engine/timing version changes identity; no v10 run is silently upgraded.

## 12. Preservation tests

The following must remain unchanged:

- O5 risk-sized quantities and audit records;
- stop/take-profit raw fill prices;
- cost-model execution prices and commissions;
- gap-through actual-open execution;
- strategy exits at open;
- corporate-action timing and split-transformed levels;
- same-bar final-close decisions remain unable to execute on their own bar;
- point-in-time replay and warm-up behavior.

## 13. Non-goals / limitations

O6 V1 does not determine the exact instant of an OHLC range touch.

It also does not determine whether stop or take-profit traded first when both lie inside one bar. The conservative policy remains deliberately adverse; `mark_ambiguous` remains available when the caller refuses that assumption.

A future version may accept independently sourced lower-timeframe or tick evidence. Such evidence must carry its own point-in-time provenance and must never be synthesized from the parent OHLC bar.

## 14. Safety

O6 changes backtest evidence quality only. It does not unlock execution.

Live Trading, Broker Orders and Physical Purchase remain LOCKED.
