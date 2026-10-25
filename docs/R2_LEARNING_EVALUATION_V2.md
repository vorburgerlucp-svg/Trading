# R2: Learning Evaluation v2 and safe performance quarantine

Status: **implemented on a development branch. Not activated.**
- `outcome-eval:v2` is not an accepted scoring method: nothing in routing, champions, the registry or calibration uses it.
- No migration: the generic append-only log tables are used.
- Current evaluation policy: **`outcome-eval-policy:v2.1`**. The review of 2026-10-25 changed v2.0; see section 8.

## 1. Why

`outcome-eval:v1` (`src/evaluation/outcome-evaluator.ts`) scores a decision by the later **gross price direction**. It has nine weaknesses (B1–B9), each pinned by `test/evaluation/v2/v1-weaknesses.test.ts`. **v1 itself is not changed:** old observations and post-trade reviews stay reproducible.

| | v1 weakness | v2 |
|---|---|---|
| B1 | `hold` and `no_trade` are scored like `sell` | HOLD is valued as hold versus close now of the OPEN position; NO_TRADE by its rejected candidate plan |
| B2 | Gross price move; costs and stop ignored | Net of spread, slippage, commission and fixed fees; the stop ends the position |
| B3 | Stop and target geometry long-only | Long and short rules, gaps on both sides |
| B4 | Exit price and horizon chosen by the caller | Only the plan decides entry, stop, target and time exit |
| B5 | Fixed 50 bp flat band | Value in R of the plan |
| B6 | A critic is rewarded for silence before gains | Warnings are not scored against outcomes; only explicit probabilities (Brier) |
| B7 | Consensus direction and model recommendation mixed | Only the plan's side |
| B8 | Only `knownAt > asOf` | Live plans are sealed in the ledger strictly before their first bar; reconstructions are labelled as such |
| B9 | 20 binary outcomes change routing | Quarantine; aggregates state their sample size and an interval |

## 2. Plans (`src/evaluation/v2/trade-plan.ts`)

**`trade-plan:v2`: an ENTRY plan** (ENTER_LONG, ENTER_SHORT, and the rejected candidate of NO_TRADE). It starts flat and fixes:
- side;
- entry `next_bar_open` at or after `earliestEntryAt`;
- stop and an optional target;
- `maxHoldingBars`;
- size;
- costs;
- intrabar policy;
- **quote currency** (the fee currency must be the same; R2 converts no currency);
- the data basis (`asOf`, `storedThrough`, input fingerprint);
- origin, realization, and the strategy, rule, code and method versions.

**`continuation-plan:v1`: an OPEN position at a decision point** (HOLD, EXIT). It carries the real remaining position:
- reference, side, **open quantity**;
- average entry price and costs already paid (both informational, sunk);
- opening time;
- the current stop and target, the holding limit and the decision point.

It never opens a position.

**Validation.** `tradePlanProblems()` lists everything missing or inconsistent:
- a stop or target on the wrong side;
- a position opened after the decision point;
- a context that does not match the position side;
- a fee currency that differs from the quote currency;
- data newer than the plan start.

An incomplete plan cannot be sealed and is not evaluated. `trade-plan:v1` (before the review) is superseded and never evaluated.

## 3. Simulation rules (`src/evaluation/v2/plan-simulator.ts`)

- **Entry plan:** entry at the open of the first expected bar (exchange calendar). Half the spread and the slippage apply against the trade.
- **Continuation:**
  - **no entry**: both alternatives start at the same decision bar with the same fill model;
  - **close now** exits the open quantity at that bar's open;
  - **hold** exits under the plan;
  - the result is the difference (hold minus close now): the gross difference of the two exit fills, minus the difference of their exit fees;
  - costs already paid are never charged again.
- **Stop:**
  - long `low <= stop`, short `high >= stop`;
  - a bar opening beyond the stop fills at its open (a gap, worse than the stop).
- **Target:** long `high >= target`, short `low <= target`. It fills at the target, also after a favourable gap (conservative).
- **Stop and target in one bar:**
  - `conservative_stop_first` takes the stop and flags `assumptionUsed`;
  - `indeterminate` gives INDETERMINATE.
- **Time exit:** at the close of the `maxHoldingBars`-th bar.
- **Data:**
  - only final bars of the plan's series that NEXUS held at the evaluation time (`knownAt <= evaluatedAt`) are used;
  - a missing bar is **PENDING** during the data grace period (default 6 hours after the bar's end), then **INSUFFICIENT_DATA**;
  - a fill is never invented.
- **Assumptions:** every result lists the assumptions it rests on: `FULL_FILL_AT_MODELED_PRICE`, `FIXED_STOP_AND_TARGET`, `MODELED_SPREAD` (unless measured).
- **Not modelled, therefore blocked:**
  - partial fills;
  - scaling in or out; partial EXIT gives `PARTIAL_EXIT_NOT_SUPPORTED`;
  - moving the stop or target inside the holding window (a change is a new decision with a new continuation plan);
  - currency conversion (a plan with a different fee currency is incomplete).

## 4. What is evaluated against what (`outcome-eval-v2.ts`)

| Action | Context | Plan | Value |
|---|---|---|---|
| ENTER_LONG / ENTER_SHORT | flat | entry plan of that side | +net R |
| NO_TRADE | flat | the rejected candidate entry plan (required) | −net R |
| HOLD | long_open / short_open | continuation plan of the open side | hold versus close now, in R of the risk kept (quantity × \|decision open − stop\|) |
| EXIT | long_open / short_open | continuation plan | −(HOLD value) |
| NO_ACTION, INSUFFICIENT_DATA | any | none | not evaluable, no score |

**Not evaluable** (with the reason stated):
- HOLD or EXIT without the real position (`NO_POSITION_STATE`) or with an entry plan;
- an entry with an open position;
- a plan of another side, context, decision or method; a changed plan (hash); an incomplete plan;
- a superseded schema;
- a live plan sealed too late or made from data newer than its seal;
- a PAPER, DEMO or LIVE plan: these need observed fills and are never simulated.

**Kept apart:**
- process quality, assessed no later than the plan start;
- the outcome;
- the quadrant;
- `lossWithinPlannedRisk`;
- data quality;
- the forecast (Brier score, stated before the seal and before the plan start);
- `evidence: 'single_case'`.

## 5. Authenticity of a seal

A `SealedPlan` object proves nothing by itself: anyone can build one with a convincing `sealedAt`, hash and sequence. Therefore:

| Authenticity | How | Use |
|---|---|---|
| `unverified` | `evaluateDecisionV2()`: the caller supplies the plan (tests, synthetic scenarios) | Evaluated, but never a performance observation. Research and demo aggregates refuse it |
| `sealed_before_outcome` | `evaluateDecisionFromLedger()` reads the plan from the `TradePlanLedger` itself. The seal is the stored record (`recordedAt`, sequence); the log's hash chain is verified when read, the plan hash is checked, and a direct database change is detected (PostgreSQL test). Research and demo plans must be stored **strictly before** their first bar, from data known at sealing | Live research evidence |
| `historical_reconstruction` | Read from the ledger, origin `historical_simulation`: made now about the past. No wall-clock seal can exist; the evidence against hindsight is the data basis | Backtests; never a decision of that time |

**Limits that R3 must close:**
1. `recordedAt` is the writing process's clock. R3 should also check it against the database transaction time, for example within a tolerance on insert.
2. A plan's `dataBasis` (`asOf`, `storedThrough`) is declared by its producer. For research plans, R3 must re-run the deterministic strategy with exactly that `storedThrough` and compare the plan hash. Only a reproduced plan counts as made from that data.
3. Market data revisions after `storedThrough` must not enter the decision. R3 reads with `storedThrough` and `decision_time` replay.

## 6. Learning quarantine and the v1 guard

Every observation carries a scoring method; no label means v1. `ModelPerformance.observations()`, and through it `stats()`, `published()`, the router, `syncRegistry`, the champion-challenger and the shadow exit gate, use **accepted** methods only. The default is v1 only, exactly as before R2. v2 observations are stored and readable through `quarantinedObservations()`, and influence nothing. Only a ledger-read v2 evaluation can become an observation.

**Proof:** `test/evaluation/v2/quarantine.test.ts`.
- With and without 160 contrary v2 observations, routing, scores, stats, registry, the champion decision and the shadow gates are identical.
- A positive control shows the sensitivity of the test.
- PostgreSQL across two processes.
- The executed code of the v2 modules reaches no router, champion, registry, calibration, decision, broker or runtime code.

**The v1 guard.** A guard test fails if code in `src/runtime` or `src/research`:
- imports the v1 evaluator; or
- builds a `ModelPerformance` without naming its accepted methods.

A runtime introduced later (NexusBrain wiring) must therefore decide explicitly. The recommendation is `acceptedScoringMethods: []` until a method is validated: routing then uses the neutral prior.

## 7. Learning Lab preparation (no Learning Lab yet)

- Origins (`historical_simulation`, `research`, `demo`), realizations (`HYPOTHETICAL`, `PAPER`, `DEMO`, `LIVE`), the policy version and the authenticity are part of every evaluation. Aggregates refuse mixed origins, realizations or policy versions.
- Only final evaluations are recorded; PENDING is refused, so a complete evaluation is never blocked.
- `learning-lab-contracts.ts`: an observed execution, a comparison between simulation and observation, decision provenance (model and prompt THEN), the seal of a Phase R reconstruction.

## 8. Versions

**`outcome-eval-policy:v2.0`** (commit `57cc679`, before the review):
- simulated a new entry for HOLD and EXIT;
- required a wall-clock seal for backtests;
- had no fee currency check, no late-data rule and no authenticity.

No v2.0 result was ever stored outside tests. Because the policy version is part of every evaluation record id and every aggregate scope, v2.0 and v2.1 results can never be mixed or silently reinterpreted.

**`trade-plan:v1`** is superseded by `trade-plan:v2` and `continuation-plan:v1`.

## 9. Tests

- **Unit** (`test/evaluation/v2/`): 75 tests.
  - Simulator scenarios with hand-computed results, including late-arriving data and the grace period.
  - HOLD and EXIT of open long and short positions:
    - no new entry, no repeated entry costs, the open quantity;
    - same-bar alternatives, gap at the decision bar;
    - missing position state, partial exit.
  - Seal authenticity (ledger, caller-supplied and forged, late, reconstruction).
  - Quadrants, forecasts, B1–B9, quarantine, the v1 guard, ledgers and aggregates.
- **PostgreSQL:** 4 tests.
  - Sealing across two processes, restart.
  - Authenticity across processes, and detection of a plan changed directly in the database.
  - Quarantine on the persistent memory.
