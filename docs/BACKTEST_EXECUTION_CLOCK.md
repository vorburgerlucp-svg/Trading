# Backtest execution clock (execution-clock:v1, backtest-engine:v7)

Status: implemented on `feature/backtest-execution-clock`. Not merged.

## 1. The defect

A daily bar's `startTime` is its data window: local midnight of the trading date. It is not the market open. The engine stamped market
fills with that window start, and it decided next-bar eligibility by comparing the window start with the instant the signal became usable.
That gave two wrong results:

- A fill was recorded at a time before the market had opened (XNAS: 04:00 UTC instead of 13:30 UTC on daylight time).
- A signal that became usable after the open could still fill at that open, because the comparison used the bar's gate (the previous
  completion), not the instant the signal was known. Reproduced: a signal known at 13:30:00.001 UTC filled at the 13:30 open. On intraday
  bars, a signal known at 13:31 filled at the 13:30 open.

## 2. Authority: the calendar

`src/backtest/execution-clock.ts` is the single source of an executable open.

- Daily bar: the regular-session open of the bar's trading date, `calendar.session(date, 'regular').open`. The calendar is the only
  source. No UTC offsets appear in production logic.
- Intraday bar: its start, once the calendar proves it is a regular-session bar start (`barWindow`).
- No session, a session the calendar only assumes (outside verified coverage), or a start outside the session: fail closed with
  `EXECUTION_CALENDAR_UNPROVEN`.

## 3. Eligibility

A signal is eligible for an executable open when `open >= decisionUsableInstant`. **Equality is eligible**: a signal known exactly at the
open may fill there. A signal usable after the open waits for the next executable open. It never fills retroactively.

The decision's usable instant is the event time of the bar that produced it, which is `max(gate, knowledge)` in decision-time replay. The
previous code compared against the bar's gate, which is why late-known signals filled at already-passed opens.

## 4. Explicit calendar contract

`BacktestInput.executionCalendar` is required. It is used whether or not corporate actions are enabled. When corporate actions are given,
their calendar must have the same identity. The fingerprint records the execution-clock version and the calendar identity (`calendarId`,
`timezone`, `source`, `kind`). The runtime object is never serialised.

## 5. Fill timing

`BacktestFill.timing` is explicit:

- `OPEN_EXACT`: market entry, strategy exit, gap stop and gap take profit. `executionAt` is the executable open. `at` equals it.
- `INTRABAR_UNKNOWN`: a stop or target touched inside the bar's range. OHLC cannot give the instant. `at` is the bar window start and is
  not an execution time; `barStart` and `barEnd` bound the touch.

`BacktestPosition.entryTime` is the entry fill's `at`, so it is the session open for daily bars.

## 6. Corporate actions and fills at the same instant

The engine order is fixed: corporate actions effective at the open are applied first, then the market fill at the same open. The audit shows
`appliedAt` and the fill's `at` both equal the open. Equality is fine because the event phase is explicit. `processedAt` is the later event.

Dividend convention is unchanged: a position held immediately before the open is entitled; a buy filled at the open is not; a sell filled at
the open remains entitled. This models ordinary ex-dividend behaviour only. Special dividends, due bills and similar terms are not modelled.

## 7. Integrity

A stored run at `backtest-engine:v7` must carry an execution-clock identity of the current version. Each fill must have timing. An exact
fill must execute at its recorded open, which is not before its bar window start. An intrabar fill must have a non-empty window and `at`
equal to its window start. An open position's entry time must match its entry fill. Runs at v6 and earlier are not reinterpreted.

## 8. Behaviour changes to note

- `isEligibleNextBar(decisionBar, candidate)` is replaced by `isEligibleAtOpen(decidedAtMs, openMs)`.
- A synthetic intraday test that runs past the 20:00 close is now refused on an XNAS calendar (the fill is outside the regular session).
  Its calendar is now the 24x7 calendar, which is a continuous market.
- A daily action or run on an assumed (unverified) session is refused, not applied with a reason. This follows the fail-closed rule for
  executable opens.

## 9. Remaining work: O6 (intrabar exact timing)

Intrabar stop and target touches are recorded as `INTRABAR_UNKNOWN`. Resolving them to an exact instant requires intraday data for the bar
(finer bars, or tick data). That is not part of this branch. Trade-duration statistics must treat `INTRABAR_UNKNOWN` as bounded, not exact.
