# R2: Learning Evaluation v2 and safe performance quarantine

Status: **implemented on a development branch. Not activated:** `outcome-eval:v2` is not an accepted scoring method, so nothing in routing, champions, the registry or calibration uses it. No migration (the generic append-only log tables are used).

## 1. Why

`outcome-eval:v1` (`src/evaluation/outcome-evaluator.ts`) scores a decision by the later **gross price direction**. It has nine weaknesses (B1–B9), each pinned by `test/evaluation/v2/v1-weaknesses.test.ts`.

**v1 itself is not changed:** old observations and post-trade reviews (which verify stored scores against `scoreAttempt`) stay reproducible.

| | v1 weakness | v2 |
|---|---|---|
| B1 | `hold` and `no_trade` are scored like `sell` | HOLD continues the OPEN side; NO_TRADE is valued by its rejected candidate plan |
| B2 | Gross price move; costs and stop ignored | Net result of the plan: spread, slippage, commission, fixed fees; the stop ends the position |
| B3 | Stop and target geometry long-only | Long and short rules, gaps on both sides |
| B4 | Exit price and horizon chosen by the caller | Only the sealed plan decides entry, stop, target and time exit |
| B5 | Fixed 50 bp flat band | Value in R of the plan; flat band in R (policy) |
| B6 | A critic is rewarded for silence before gains | Warnings are not scored against outcomes; only an explicit probability of a defined event is scored (Brier) |
| B7 | Consensus direction and model recommendation mixed | Only the plan's side |
| B8 | Only `knownAt > asOf` | The plan must be sealed strictly before its earliest entry and made from data known at sealing |
| B9 | 20 binary outcomes change routing | Quarantine; aggregates state their sample size and an interval |

## 2. Modules (`src/evaluation/v2/`)

| Module | Content |
|---|---|
| `trade-plan.ts` | `trade-plan:v1`: signal and decision ids, instrument, source, interval, side, position context, strategy, rule, code and method versions, origin, realization, entry (`next_bar_open`, `earliestEntryAt`), stop, optional target, `maxHoldingBars`, size, costs (with spread source `modeled` or `measured`), intrabar policy, data basis (`asOf`, `storedThrough`, input fingerprint). `tradePlanProblems()` lists everything missing or inconsistent; an incomplete plan cannot be sealed |
| `plan-ledger.ts` | `TradePlanLedger`: the seal is the stored record (`recordedAt`, sequence); a different plan under the same id is refused. `EvaluationLedgerV2`: one record per decision, method and origin, never overwritten |
| `plan-simulator.ts` | Deterministic simulation (rules in section 3) |
| `outcome-eval-v2.ts` | Action rules, seal checks, process versus outcome, quadrants, risk compliance, forecasts |
| `performance-v2.ts` | v2 evaluation → observation labelled `outcome-eval:v2` (analysts only, EVALUATED only); `recordQuarantinedV2` |
| `evaluation-summary.ts` | Aggregates of ONE origin and ONE realization (a mixed input is refused); sample sufficiency and a 95 % interval |
| `learning-lab-contracts.ts` | Types for the later Learning Lab: an observed execution (demo, paper, live), a comparison between simulation and observation, decision provenance (model and prompt THEN), the seal of a Phase R reconstruction |

Changed existing module: `src/ai/model-performance.ts`. It gains the optional `scoringMethod` label, `acceptedScoringMethods` (default `['outcome-eval:v1']`), and `quarantinedObservations()`.

`DEFAULT_PERFORMANCE_POLICY` is unchanged (it is fingerprinted by benchmarks).

## 3. Simulation rules (`outcome-eval:v2`)

- **Entry:** at the open of the first expected bar (exchange calendar) at or after `earliestEntryAt`. Half the spread and the slippage are applied against the trade.
- **Stop:**
  - long: `low <= stop`; short: `high >= stop`;
  - a bar opening beyond the stop fills at its open (a gap, worse than the stop);
  - the stop can trigger in the entry bar.
- **Target:** long `high >= target`, short `low <= target`. It fills at the target, also after a favourable gap (conservative).
- **Stop and target in one bar:**
  - `conservative_stop_first` takes the stop and flags `assumptionUsed`;
  - `indeterminate` gives INDETERMINATE.
- **Time exit:** at the close of the `maxHoldingBars`-th bar.
- **Missing data:**
  - a missing expected bar is INSUFFICIENT_DATA (no invented fill);
  - a bar not yet complete is PENDING;
  - in-progress bars and bars of another series are never used.
- **Result:**
  - net PnL = gross (fills) − commission − fixed fees;
  - risk = quantity × |entry fill − stop|;
  - value in R = net / risk.

## 4. What is evaluated against what

| Action | Context | Plan | Value |
|---|---|---|---|
| ENTER_LONG / ENTER_SHORT | flat | the entered plan, same side | +net R |
| HOLD | long_open / short_open | continuation of the OPEN side | +net R |
| EXIT | long_open / short_open | the continuation the exit avoided | −net R |
| NO_TRADE | flat | the rejected candidate plan (required) | −net R |
| NO_ACTION, INSUFFICIENT_DATA | any | none | not evaluable, no score |

**Not evaluable** (with the reason stated):
- HOLD or EXIT without a position;
- a plan of another side, context, decision or method;
- a changed plan (hash);
- a plan sealed at or after its entry, or made from data newer than its seal;
- a PAPER, DEMO or LIVE plan: these need observed fills (`ObservedExecutionV2`) and are never simulated.

**Kept apart:**
- process quality, assessed at decision time; an assessment after the entry does not count;
- the outcome (net R, FAVORABLE, FLAT or ADVERSE);
- the quadrant (good or bad decision × good or bad outcome);
- `lossWithinPlannedRisk` (a loss at the stop is not by itself a bad decision);
- data quality (legacy bars, ambiguous bars, assumption);
- the forecast (Brier score, only for a probability stated before the seal and an event that was determined);
- `evidence: 'single_case'`: one result is never evidence of skill.

## 5. Learning quarantine

Every observation carries a scoring method; no label means `outcome-eval:v1`.

`ModelPerformance.observations()`, and through it `stats()`, `published()`, the router, `syncRegistry`, the champion-challenger and the shadow exit gate, use **accepted** methods only. The default is v1 only. v2 observations are stored and readable through `quarantinedObservations()`, and influence nothing.

**Proof:** `test/evaluation/v2/quarantine.test.ts`.
- With and without 160 strongly contrary v2 observations, three routing decisions, published scores, stats, registry scores, the champion decision and the shadow gates are identical.
- A positive control shows that a policy accepting v2 does change them.
- On PostgreSQL, observations written by a second process do not move the first process's published score (`test/pg/evaluation-v2.pg.test.ts`).
- The executed code of the v2 modules reaches no router, champion, registry, calibration, decision, broker or runtime module.

**Accepting `outcome-eval:v2` later** requires:
1. an independent validation (synthetic markets with known results, walk-forward on stored history, and the comparison with the frozen v1 results);
2. an explicit human decision;
3. a new policy version.

Until then, v1 remains the only accepted method, exactly as before R2. v1's weaknesses stay documented, and v1 is not wired into the runtime today.

## 6. Learning Lab preparation (no Learning Lab yet)

- Origins `historical_simulation`, `research`, `demo` and realizations `HYPOTHETICAL`, `PAPER`, `DEMO`, `LIVE` are part of every plan and evaluation. Aggregates refuse mixed inputs.
- A plan keeps its data basis (`asOf`, `storedThrough`, input fingerprint): a Phase R reconstruction can re-read exactly what was known.
- Evaluations name the method and policy version; a later method is a new record, never a reinterpretation.
- `DecisionProvenanceV2` keeps the model and prompt versions used THEN.

## 7. Tests

**Unit** (`test/evaluation/v2/`): 60 tests.
- Simulator scenarios with hand-computed results: long and short win and loss, stop-then-recovery both ways, gaps, the ambiguous bar under both policies, a data gap, pending, in-progress bars, another series, an overnight session, costs turning a gross gain into a net loss.
- Action rules and the seal checks.
- Quadrants and forecasts.
- B1–B9.
- Quarantine.
- Ledgers and aggregates.

**PostgreSQL:** 3 tests (sealing across two processes, restart, quarantine on the persistent memory).
