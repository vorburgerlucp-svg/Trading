# Backtest Warm-up Enforcement (O3) — 2026-10-09

Status: implemented on `feature/backtest-warmup-enforcement`. Not merged.
Engine: `backtest-engine:v2` (was `v1`). Warm-up policy: `warmup:v1` (`src/backtest/warmup.ts`, unchanged).

## 1. Invariant

No strategy decision, order or fill exists before the required historical warm-up is complete and point-in-time available.
The first decision is made only on history that was actually available at that event. The earliest fill of a decision stays
on a later, executable bar (the next-bar rule is unchanged).

## 2. Where warm-up lives

`BacktestStrategy.warmup: WarmupPlan` is required. There is no default, so a strategy that does not declare its history
requirement cannot be constructed. A missing or malformed plan refuses the run (`WarmupPlanError`): `requiredBars` must be an
integer >= 1, `preferredBars` an integer >= `requiredBars`, and `algorithmVersion` non-empty. Nothing defaults to 1.

- Quant-based strategies use `warmupPlan(quantParameters)`.
- Test strategies declare their own small plan. The existing engine tests use `requiredBars: 1`, which keeps their behaviour.
- No quant-based strategy exists in the backtest yet. The Pattern Engine is out of scope for this change.

## 3. The gate (event convention, step 4)

For every final bar becoming available, the engine:
1. processes the market order from the previous decision at this bar's open (unchanged),
2. processes protective stop/take-profit (unchanged),
3. marks the equity at this bar's close (unchanged: warm-up bars stay visible in the equity history),
4. counts the bars available at this event (`history.length`, point-in-time, `availableAt <= event`).
   - Below `requiredBars`: the event is a **warm-up bar**. The strategy is **not called**. No pending order and no fill can result.
   - At or above `requiredBars`: the event is **tradable**. The strategy is called exactly once for it.
5. creates new orders only for a later bar (unchanged).

Because `evaluate()` is not called during warm-up, a strategy cannot bypass the gate by accident. The gate counts availability,
not `bars.length` and not future bars. A late bar therefore holds the gate until it is available (see the delayed-availability test).

## 4. Preferred warm-up

`requiredBars` is the hard gate. `preferredBars` is a stability goal and never a minimum:
- `preferredWarmupMet = strategyEvaluations > 0 && evaluationsBelowPreferred === 0`. Every decision had preferred history.
- A run that trades with `requiredBars <= history < preferredBars` is allowed. It is marked: `preferredWarmupMet = false`,
  `evaluationsBelowPreferred` counts the decisions made under the preferred history, and the quality reasons carry a
  `PREFERRED_WARMUP_NOT_MET` hint. The grade is not changed: the preferred history is a stability goal, not a validity rule.
- `preferredWarmupCompleteAt` records when the preferred history was first available, for transparency.

No probability and no weight is derived from this. The evidence layer reports it as a warning
(`BACKTEST_PREFERRED_WARMUP_NOT_MET`), it does not change strength.

## 5. Insufficient history (`INSUFFICIENT_WARMUP_HISTORY`)

If `barsProcessed < requiredBars`:
- the strategy is never called; there are no orders, fills, trades or open positions;
- the run is **stored**, with `quality.grade = INVALID` and the reason `INSUFFICIENT_WARMUP_HISTORY: n bar(s) available, requiredBars m; …`.

Why stored rather than thrown: the run is deterministic and its id is reproducible. Storing it is an auditable record that the
system refused to trade on too little history. A thrown error would leave no trace in the audit or the run store.
INVALID blocks it as evidence (`BACKTEST_INVALID` in the O1 validation), so it cannot be promoted to a decision basis.
The run's `warmup.requiredWarmupMet = false`, so `verifyBacktestRun` checks that it shows no decision, order or fill.

## 6. Result metadata (`BacktestRunResult.warmup`)

| Field | Meaning |
|---|---|
| `algorithmVersion`, `requiredBars`, `preferredBars` | the plan that was enforced |
| `requiredWarmupMet` | `barsProcessed >= requiredBars` |
| `preferredWarmupMet` | every evaluation had preferred history, and there was at least one |
| `firstStrategyEvaluationAt` | `availableAt` of the first evaluated event, or null |
| `preferredWarmupCompleteAt` | `availableAt` when preferred history was first complete, or null |
| `warmupBars` | events below the gate |
| `tradableBars` | events at or above the gate (the exposure denominator) |
| `strategyEvaluations` | `evaluate()` calls; equals `tradableBars` by construction |
| `evaluationsBelowPreferred` | evaluations with fewer than `preferredBars` bars |

`warmupBars + tradableBars = barsProcessed` and `strategyEvaluations = tradableBars` are verified on read.
`warmup` is optional in the type, only for `backtest-engine:v1` runs (section 9).

## 7. Exposure convention

`exposurePct = exposedPoints / tradableBars * 100`. Warm-up bars are excluded from the denominator, because they are not
tradable. Example: 200 warm-up bars, 20 tradable bars, a position during 10 of them → 10/21 (the tradable events are the 21 bars
from the first evaluation onward), not 10/220.

Return and drawdown are **not** changed: they still use the full equity curve (warm-up bars included, flat at the initial capital).
The equity curve keeps every event, so the audit history is complete.

## 8. Fingerprint and versioning

- The warm-up plan (`algorithmVersion`, `requiredBars`, `preferredBars`) is part of the **input fingerprint**. Changing any of
  them changes the `BacktestRunId`. Tested: 50 vs 200 required, preferred, algorithm version.
- The **strategy fingerprint** is unchanged: `hash({id, version, definition})`. The warm-up plan is a run input, not part of the
  strategy's own identity. `verifyBacktestRun` still checks the strategy checksum as before.
- `BACKTEST_ENGINE_VERSION` is `backtest-engine:v2`. The engine version is in the input fingerprint, so the same bars and plan
  produce new ids under v2. v1 runs are never re-stored or rewritten.

## 9. Existing data

- **v1 runs** (`backtest-engine:v1`) have no `warmup` field. They stay readable: `verifyBacktestRun` accepts them only in this
  exact form. They had no gate, so their early decisions cannot be shown to have had enough history. The O1 validation therefore
  refuses them as evidence (`BACKTEST_WARMUP_UNPROVEN`).
- A v2 run without warm-up metadata fails verification (`warm-up metadata is missing`).
- No migration: `backtest_runs.result` is JSONB, lossless. The warm-up metadata is inside the hashed result. The existing
  `quality_grade` column already allows `INVALID`. Changing the schema is not needed.

## 10. What this does not prove (open)

- **Market-data provenance.** `availableAt` is the ingest's claim (provider/ingest). The gate enforces what the data says, not
  whether the provider's availability time was true.
- **Recursive indicators.** The gate guarantees a minimum history. It does not verify that an indicator's seeding is correct:
  that is the quant engine's responsibility (`warmup:v1`).
- **Minimum sample.** `minimumTrades` remains the caller's `BacktestQualityContext`. No system default.
- **Preferred history is not weighted.** It is a transparent hint only, by design.
