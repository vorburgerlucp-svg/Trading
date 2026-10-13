# O7: Multi-Instrument Portfolio Event Loop V1

Status: design first. Base: `249812d` (O6 bounded intrabar stop timing merged and green).

## 1. Goal

NEXUS already has a point-in-time event queue that can order bars from multiple instruments by the instant they became usable. The current backtest engine nevertheless refuses mixed instruments and holds only one position and one pending order.

O7 introduces a deterministic portfolio/world event loop over multiple instruments while preserving the existing point-in-time, next-open, execution-clock, O5 risk-sizing and O6 intrabar-timing invariants.

O7 is a backtest-only change. Live Trading, Broker Orders and Physical Purchase remain LOCKED.

## 2. Non-goals

V1 does not add:

- short selling;
- leverage or margin;
- partial fills;
- limit/stop-entry orders;
- cross-asset signals;
- optimization of capital allocation;
- random or alphabetical tie-breaking for scarce cash;
- FX conversion;
- portfolio-level VaR;
- broker execution;
- AI-based allocation.

Those require separate, explicit versions.

## 3. Portfolio state

The portfolio owns one shared cash balance and zero or more long positions.

Per instrument V1 permits at most:

- one open long position;
- one pending market order.

No netting or pyramiding is allowed.

The same instrument may not have two open positions or two pending orders at once.

## 4. Input

The portfolio engine receives a map of instrument series instead of one flat single-instrument series:

```
seriesByInstrument: Readonly<Record<string, readonly MarketBar[]>>
```

Every non-empty series must be internally uniform in interval/session/adjustment/source.

Instrument ids are taken from the bars and must exactly match the map key.

Each instrument has an explicit execution calendar. O7 never guesses a venue calendar.

The initial portfolio currency remains one ISO 4217 currency in V1. All instruments therefore have to be modeled in that same currency. FX conversion is out of scope.

## 5. World event queue

O7 reuses `buildBarAvailabilityQueue`.

Events are ordered by replay/availability time. Events that share the exact same usable timestamp form one **world batch**.

A world batch is the atomic information boundary. NEXUS must not let the arbitrary order of instruments inside one timestamp change what other instruments can know at that same timestamp.

For each timestamp:

1. advance all bars of the batch into `PointInTimeBarState`;
2. apply due per-instrument corporate actions;
3. process previously-created market orders whose executable open is eligible;
4. process protective exits;
5. compute one aggregate portfolio mark using the latest point-in-time-known price of every open position;
6. evaluate each instrument whose bar became usable in the batch;
7. create new pending orders for later executable opens.

A decision created in step 6 cannot execute in the same batch. This preserves the existing next-open rule and removes cross-instrument same-timestamp look-ahead.

## 6. Determinism inside a batch

Instrument iteration is canonicalized by ascending `instrumentId` only for operations whose economics are independent of order.

That ordering must never be used to decide who receives scarce cash.

If multiple eligible BUY orders in one exact execution batch collectively require more spendable cash than is available, O7 V1 fails closed with:

`PORTFOLIO_ALLOCATION_AMBIGUOUS`

It does not:

- fill the alphabetically first symbol;
- fill the first event returned by a map;
- silently resize one order;
- randomly choose;
- pro-rate quantities.

A future allocation-policy version may resolve this explicitly. Its policy and inputs must enter the run fingerprint.

If cash is sufficient for every simultaneous eligible buy, all may execute.

SELL exits release cash before BUY affordability is checked only when their economic execution instant is strictly earlier. Orders sharing the same exact execution instant are one allocation batch; V1 does not invent an ordering between simultaneous sells and buys to manufacture buying power.

## 7. Positions and pending orders

State becomes keyed by instrument:

```
positions: Map<string, BacktestPosition>
pendingOrders: Map<string, PendingOrder>
```

Every fill and trade already carries `instrumentId`; those identities remain immutable.

Closing one instrument may never mutate another instrument's position, pending order, fill or trade.

## 8. Shared cash and equity

Cash is portfolio-wide.

Aggregate marked equity at a world timestamp is:

```
cash
+ sum(latestKnownPrice[instrument] * openQuantity[instrument])
+ portfolioReceivables
```

A position is marked only with information available at or before that world timestamp.

A later-delivered bar from another instrument may never be used early.

If an open position has no point-in-time-known mark at a required portfolio event, the engine fails closed rather than carrying an unproven price.

## 9. Position sizing

### fixed_cash

The requested cash amount remains per entry and is capped by spendable portfolio cash.

### percent_equity

The percentage is applied to aggregate point-in-time portfolio equity immediately before the execution batch.

### risk_per_trade

O5 remains unchanged in V1: `sizingEquity` and `spendableCash` are the spendable cash at the entry event. Existing O5 audit records and equations are not widened to unrealized portfolio equity in O7.

This is deliberately conservative and keeps O5 reproducible.

## 10. Execution invariants

O7 preserves:

- final-close decisions never execute on their own bar;
- a pending order fills only at an eligible executable open;
- a decision usable after an open cannot fill retroactively;
- gap stops/targets fill at the actual open;
- O6 range touches use `INTRABAR_BOUNDED`;
- spread, slippage and commissions remain deterministic;
- no future bar is read for sizing or execution.

## 11. Strategy scope

O7 V1 reuses the existing per-instrument `BacktestStrategy` contract.

A strategy evaluation receives:

- the current instrument id;
- that instrument's point-in-time history;
- that instrument's position.

It does not receive other instruments' bars or positions in V1.

This means O7 tests portfolio execution and shared capital without introducing cross-asset alpha logic at the same time.

## 12. Corporate actions

Corporate-action ledgers are per instrument.

A split/dividend/symbol action may affect only the matching instrument.

The same effective-instant and knowledge-boundary rules from the existing corporate-action engine apply independently per instrument.

If O7 cannot prove the relevant calendar/action ordering for one instrument, the portfolio run fails closed.

## 13. Result identity

O7 introduces an explicit portfolio result identity rather than pretending a multi-instrument run is a historical single-instrument run.

Proposed version:

`portfolio-backtest:v1`

The fingerprint includes at least:

- portfolio engine version;
- sorted instrument ids;
- every instrument's bars;
- every execution-calendar identity;
- replay mode;
- strategy metadata;
- sizing and O5 risk-sizing version;
- O6 intrabar-timing version;
- cost model;
- initial capital/currency;
- corporate-action inputs;
- quality/universe evidence where applicable.

Map insertion order must not change the fingerprint or run id.

## 14. RED test matrix

Before implementation, RED tests must pin these cases:

1. Current single-instrument engine refuses A+B; O7 accepts two independent series.
2. B is delivered five seconds later than A: A's earlier evaluation cannot see B's future bar.
3. Same usable timestamp for A+B: both bars are advanced before either strategy is evaluated.
4. Decisions created in one world batch cannot execute at an open that already occurred inside that same batch.
5. Two open positions mark aggregate equity from each instrument's latest point-in-time-known bar.
6. Closing A leaves B untouched.
7. Gap stop in A and O6 bounded stop in B retain their existing timing semantics.
8. Two simultaneous BUYs with enough cash both fill deterministically.
9. Two simultaneous BUYs whose combined requirements exceed cash fail with `PORTFOLIO_ALLOCATION_AMBIGUOUS`.
10. Reversing map insertion order gives identical fills, trades, equity, fingerprint and run id.
11. Changing one bar of B changes portfolio identity but not A's historical fills before that bar becomes usable.
12. An instrument with no proven mark for an open position causes fail-closed behavior.
13. Per-instrument corporate action changes only its own position.
14. Existing single-instrument v11 tests remain unchanged and green.

## 15. Preservation

The existing `runBacktest` single-instrument API and historical `backtest-engine:v11` records remain supported.

O7 must not silently reinterpret those runs as portfolio runs.

The safest implementation path is a separate portfolio orchestration layer that reuses existing execution/cost/timing primitives rather than rewriting their economics.

## 16. Safety

O7 adds research/backtest capability only.

It does not authorize or create broker orders, transfer capital or unlock live trading.
