# O5: executable risk sizing (risk-sizing:v1, backtest-engine:v10)

Status: design, written before the RED tests and the implementation. Base: `6d1070a` (Bounded Streaming Transport V2, closed).
Scope: the `risk_per_trade` position sizing of the single-instrument, long-only backtest. Nothing else changes: `fixed_cash` and `percent_equity` keep
their economics, and the cost model, execution clock, intrabar policy, warm-up, strategy interface, quality grading and persistence design are unchanged.

This is NOT VaR. It is NOT a probability model, NOT an AI confidence, and NOT a guarantee that a real loss cannot exceed the budget. It is a deterministic,
configured stress model. A real market gap can be larger than the configured stress, and the realized loss can then exceed the risk budget. That is expected
and is documented in §10.

## 1. The old naive formula

`src/backtest/sizing.ts` (backtest-engine:v9) sized a long position as

    perUnitRisk = executionPrice(open, buy) − stopLoss
    riskQuantity = riskBudget / perUnitRisk        (rounded down, 12 decimals)
    cashQuantity = (min(cash, equity × maxCash)) / executionPrice

and the engine then capped the quantity with `maxAffordableQuantity(cash, open)`. It omitted:

- the entry commission, which is charged on the buy notional;
- the exit commission, which is charged on the stressed sell notional;
- the sell-side spread and slippage, so the exit price was the raw stop, not an executable price;
- any gap-through-stop stress, so the exit was assumed to fill at the stop.

A configured 1% budget could therefore size a position whose modeled downside exceeded 1%. Its stop was also validated against the buy execution price, not
the raw entry: a stop above the raw entry but below the buy execution price was accepted.

## 2. Configuration

`PositionSizing` `risk_per_trade` gains an explicit gap stress:

    { type: 'risk_per_trade'; riskBasisPoints; maxCashBasisPoints; stopGapStressBasisPoints }

- `riskBasisPoints`: integer, `> 0`, `<= 10 000`.
- `maxCashBasisPoints`: integer, `> 0`, `<= 10 000`.
- `stopGapStressBasisPoints`: integer, `>= 0`, `< 10 000`. Required for every risk-sized run of engine v10. There is no default and no market-derived
  value: the stress is a configured assumption. In the stored types it is optional so that v9 records still parse, but the engine refuses a v10
  `risk_per_trade` run without it.
- No NaN, no Infinity, no fractions. Every invalid value throws before the run starts.

After validation, all monetary arithmetic is `Decimal`. No `number` arithmetic touches a price, a quantity or a budget.

## 3. Inputs at the entry event

The entry is the pending buy created by a strategy decision. It executes at the executable open of a later bar (execution-clock:v1, unchanged). The sizing
reads only:

- `E`: the raw entry price, which is `bar.open` of that executable-open bar;
- `S`: the strategy's stop, as it stands after any corporate-action transformation that is due at that same open (§9);
- the stress, risk and cash configuration;
- `cash` at the event, before the fill.

It reads nothing from any later bar (§8).

## 4. Executable entry and stressed stop exit

Using the existing `DeterministicCostModel` (its definitions are unchanged):

    P  = executionPrice(E, 'buy')                        entry execution price
    Sr = S × (1 − g / 10 000)                            stressed raw exit, g = stopGapStressBasisPoints
    Ps = executionPrice(Sr, 'sell')                      stressed sell execution price

Example: stop 95, gap 200 bp, so `Sr = 95 × 0.98 = 93.10`. This is a deterministic stress price. It is not a prediction of the next gap.

A raw stop is valid only if `0 < S < E`, where `E` is the raw entry, not the buy execution price. Also `Sr > 0` and `Ps > 0`. Any invalid stop refuses the entry:
no BUY fill is created, the pending order is cleared, and there is no fallback to another sizing type (§11).

## 5. Commissions

The commission is the cost model's own function, `commission(notional) = max(notional × commissionBps / 10 000, minCommission)`. It is not a fixed per-unit
value, because the minimum makes it piecewise.

    entryCommission(Q) = commission(P × Q)
    exitCommission(Q)  = commission(Ps × Q)

Both sides use the same minimum. The entry commission is the commission of the buy fill, exactly as `quote()` computes it.

## 6. Modeled stress downside

For a candidate quantity `Q`:

    entryCost(Q)  = P × Q + entryCommission(Q)
    stressNet(Q)  = Ps × Q − exitCommission(Q)
    D(Q)          = entryCost(Q) − stressNet(Q)
                  = Q × (P − Ps) + max(c·P·Q, m) + max(c·Ps·Q, m)

where `c = commissionBps / 10 000` and `m = minCommission`. `D` is the **modeled stress downside**. It is a configured stress figure. It is never called a
maximum loss or a worst loss (§10). The audit field is `modeledStressDownside`.

## 7. Budgets, the solver and rounding

**Risk budget.** `R = sizingEquity × riskBasisPoints / 10 000`. The equity basis is spendable cash at the entry event (§12).

**Cash budget.** `B = min(spendableCash, sizingEquity × maxCashBasisPoints / 10 000)`. The entry total `P × Q + entryCommission(Q)` must not exceed `B`.

**Exact risk solution.** `D(Q)` is a maximum of four linear functions, because each `max` in `D` is a maximum of two terms and the terms are independent:

    D(Q) = max( (a+α+β)Q,  (a+α)Q + m,  (a+β)Q + m,  aQ + 2m )

with `a = P − Ps`, `α = c·P`, `β = c·Ps`. So `D(Q) ≤ R` holds exactly when all four hold, which gives four closed-form bounds:

    Qr = min( R/(a+α+β),  (R−m)/(a+α),  (R−m)/(a+β),  (R−2m)/a )

A bound whose numerator is not positive is zero. Every bound is rounded DOWN to 12 decimals, and the minimum of floored bounds equals the floor of the minimum,
so `Qr` is the largest 12-decimal quantity with `D(Qr) ≤ R`. Nothing is searched and nothing depends on floating point.

**Exact cash solution.** The entry total is `max(c·P·Q, m) + P·Q`. It is at most `B` exactly when both `(1 + c)·P·Q ≤ B` and `P·Q + m ≤ B`. So the largest
affordable quantity is `Qc = min( B/(P(1+c)), (B−m)/P )`, rounded down. This is `DeterministicCostModel.maxAffordableQuantity(B, E)`, which is exact in this sense.

**Final quantity.** `Q = min(Qr, Qc)`, rounded down to 12 decimals. Quantity scale is unchanged (12 decimals, rounded down). Then:

- `bindingConstraint` is `risk_budget` if `Qr < Qc`, `cash_budget` if `Qc < Qr`, and `both` if they are equal. The comparison is on the floored values.
- If `Q ≤ 0`, the entry is refused (§11).
- Defensive: the chosen `Q` is checked again with exact arithmetic (`D(Q) ≤ R` and entry total `≤ B`). The check cannot fail if the derivation holds. A failure throws.

Exact boundaries: `D(Q) ≤ R` at the chosen `Q`, and `D(Q + 10⁻¹²) > R` whenever the risk budget is the binding constraint. Equivalently, the entry total is at most `B`, and
one tick more exceeds `B` whenever cash binds (§11 and the tests).

**Why the minimum commission matters.** `D` is piecewise linear. A minimum commission can make the modeled downside exceed the budget even when the proportional
rate alone would not. Dropping either the entry or the exit commission changes `Qr`. The tests pin both.

## 8. No look-ahead

The sizing reads only the entry event's values (§3). It never inspects a later bar. A paired-run test proves this: two backtests that are identical through the
entry fill, but whose later bar gaps differ (a small gap in one, a catastrophic gap in the other), must produce the same entry quantity, the same entry execution
and the same audit. Only the later exit and P&L may differ.

## 9. Corporate actions

The entry sizing uses the stop after any corporate-action transformation due at the executable open. The engine applies due actions (step 0) before it processes
the pending entry (step 1), so the stop already has the post-split value. The sizing never adjusts a stop a second time. A regression fixture covers a pending
entry decided before a 4-for-1 split (stop 80 becomes 20).

## 10. Gap-stress limitation and the realized loss

The stress is a configured assumption. A real market gap can open below the stressed exit. In that case the protective exit executes at the **actual** executable
open, under the existing execution-model semantics (`open ≤ stop → fill at open`). The stressed price is never used to clamp the real exit. The realized loss may
therefore exceed the entry risk budget. That is expected.

The risk budget is a **sizing budget under the configured stress scenario**. It is not a guarantee against a larger future gap. The audit records what was
modeled at entry, and it never claims otherwise. The words `maximum possible loss` and `worst possible loss` are not used anywhere for these figures. The names
are `modeledStressDownside`, `configuredStressDownside` and `executableStressDownside`.

## 11. Refusals

A `risk_per_trade` entry creates no BUY fill, and the pending order is cleared, when any of these hold: the stop is missing; `S ≤ 0`; `S ≥ E`; a stress price is
not positive; or `Q ≤ 0` after the budgets. There is no silent fallback to `fixed_cash` or `percent_equity`, and no stop is invented.

## 12. Equity basis

The engine has at most one open position, and a new entry happens only when no position is open. At the entry event the economic equity is
`cash + receivablesValue`. The V1 decision is:

- The risk budget uses `sizingEquity = cash` (spendable cash). This is the basis the engine already used, so it does not change. Dividend receivables are excluded,
  which is conservative: the risk budget is smaller, never larger.
- The cash budget uses spendable cash only. No receivable becomes spendable cash.

Using the economic equity for the risk budget would widen O5 beyond this branch, so it is not done here.

## 13. Audit record

Every executed `risk_per_trade` BUY fill (reason `market_entry`) carries an immutable `riskSizing` record:

    version: 'risk-sizing:v1'
    riskBasisPoints, maxCashBasisPoints, stopGapStressBasisPoints
    sizingEquity, spendableCash, riskBudget, cashBudget
    rawEntryPrice, entryExecutionPrice
    stopLoss, stressRawExitPrice, stressExecutionPrice
    quantity
    entryCommission, stressExitCommission
    modeledStressDownside
    riskLimitedQuantity, cashLimitedQuantity
    bindingConstraint: 'risk_budget' | 'cash_budget' | 'both'

Only `market_entry` BUY fills of a v10 `risk_per_trade` run carry it. `fixed_cash` and `percent_equity` fills do not. The record is part of the fill, so the lossless
JSONB run persists it. No migration is added.

The sizing function returns this record as the single source of truth. The engine never recomputes it separately.

## 14. Verification

`verifyBacktestRun` checks every v10 `risk_per_trade` entry. It recomputes the sizing from the record's own inputs with the same pure function, and then
requires every field to match: quantity, both commissions, the stressed prices, the modeled downside, the budgets and the binding constraint. It also checks that:

- the fill's quantity, execution price, raw price and commission equal the record's;
- the stop is positive and below the raw entry;
- the stress prices are positive and ordered (`stressRawExitPrice ≤ stopLoss`, `stressExecutionPrice < entryExecutionPrice`);
- the basis-point fields agree with `run.sizing`.

Any tampering with the record fails closed with `BacktestRunIntegrityError`. Historical runs are not reinterpreted. Engine v9 and earlier runs must not carry a
record, and a v9 `risk_per_trade` run is verified exactly as before.

## 15. Versioning and identity

- `RISK_SIZING_VERSION = 'risk-sizing:v1'`.
- `BACKTEST_ENGINE_VERSION` becomes `backtest-engine:v10`. v10 introduces executable cost-aware risk-per-trade sizing. v9 runs are not reinterpreted.
- The input fingerprint includes the engine version, the full sizing configuration (so `stopGapStressBasisPoints` is included), the cost model, and the risk-sizing
  version. Changing only `stopGapStressBasisPoints` changes the fingerprint and therefore the `backtestRunId`.

## 16. Determinism and rounding

- Decimal only after validation. No random values, no floating-point decisions.
- Repeated runs with identical input give identical quantity, audit, fills, trades, fingerprint and run id.
- Quantity rounds DOWN at 12 decimals. Nothing rounds up.

## 17. Unchanged semantics

- Same-bar execution is still forbidden: a final-close signal cannot fill on its own bar.
- Protective exits execute at the actual open when a gap crosses the level. The stress price is used only to size the entry.
- Same-bar stop and take-profit touches still use the conservative adverse stop (`INTRABAR_UNKNOWN`). O5 does not change intrabar ordering. **O6 remains open**: O5 does not claim an exact intrabar stop time.
- The strategy interface, warm-up and execution clock are unchanged.
- `fixed_cash` and `percent_equity` keep their quantities and fills.
- Live Trading, Broker Orders and Physical Purchase stay LOCKED. O1 stays false. No AI model chooses the quantity, and no broker adapter or order intent is involved.

## 18. Limitations

- The stress is configured. It is not a probability, a volatility estimate or a market-derived gap.
- A realized loss can exceed the risk budget when an actual gap is larger than the stress. The engine records this and does not hide it.
- The cost model is static and deterministic. Impact does not depend on volume.
- Single instrument and long-only. The equity basis is spendable cash (§12).
- Quantity precision is 12 decimals, rounded down. A position is therefore slightly smaller than the exact continuous optimum.
