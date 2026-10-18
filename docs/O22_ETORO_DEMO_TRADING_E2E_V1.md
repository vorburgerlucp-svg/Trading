# O22 – Controlled eToro Demo Trading Cycle (End-to-End) V1

Status: **implemented and tested offline; not released.** Base: `519233d` (merge of PR #24, O21C).
- No eToro request was sent while building O22: no authenticated read, no demo write, no metadata read.
- Every build lock stays closed; `BUILD_LOCKS.etoroDemoExecution = true` refuses every demo write in this build.
- `PORTFOLIO_SAFETY_NOT_CONNECTED` stays: the runtime has no demo safety source, so every **open** is refused.
- The first demo buy therefore **cannot** happen with this build. Section 9 lists what must be decided and changed first, section 8 the exact sequence for afterwards.

Naming note: an unrelated, uncommitted work package "O22 OpenAI shadow provider" exists in another local worktree (with a migration `014_model_run_usage.sql`). This package uses its own file and branch names (`O22_ETORO_DEMO_TRADING_E2E_V1.md`, `feature/o22-etoro-demo-trading-e2e-v1`), adds no migration, and touches none of those files. The numbering should be reconciled before both are merged.

## 1. What already existed and is reused

| Part | Source | Used for |
|---|---|---|
| Read-only demo portfolio sync, snapshot, reconciliation against the ledger | O20, O21A | baseline and after-trade portfolio |
| Non-empty portfolio parser (live-observed for positions) | O21A, O21B, O21C | identifying positions by `positionID` |
| `ExecutionIntent`, state machine, risk gate, operator authentication, routes | O21 | the cycle itself, unchanged |
| Reservation step (`SUBMITTING` inside the log's critical section) | O21 | at-most-once, now also the cycle budget |
| AMBIGUOUS handling (lookup by original `x-request-id`; a negative lookup decides nothing; an AMBIGUOUS close is never reconciled) | O21 | timeouts and unclear answers |
| Close of a broker-confirmed position, cancel of a pending open | O21 | the close of the cycle |
| Kill switch store, O15 safety envelope | O15/O16 | open blocked when tripped; close stays possible |

There is no parallel implementation: O22 adds a policy, a book counter, read-only checks, one fixed read and one governed function.

## 2. What O22 adds

| File | Change |
|---|---|
| `src/broker/etoro/execution/execution-gate.ts` | `DEMO_E2E_CYCLE_POLICY` (`etoro-demo-e2e-cycle-policy:v1`). Two book checks, `cycleOpenBudget` and `cycleCloseBudget`. The verdict records the policy version actually used. |
| `src/broker/etoro/execution/etoro-demo-execution-service.ts` | The book counts submissions. `cycleBudget()` is read only. |
| `src/runtime/compose.ts` | The runtime uses `DEMO_E2E_CYCLE_POLICY`, a code constant. |
| `src/broker/etoro/execution/demo-cycle-reconciliation.ts` | Pure check of the cycle against a stored portfolio snapshot. |
| `src/broker/etoro/execution/demo-safety-readiness.ts` | Pure readiness report. It is not a safety decision. |
| `src/broker/etoro/etoro-readonly.ts`, `etoro-transport.ts` | One fixed read `instrument.metadata.100001`, and the URL helper `etoroOperationUrl`. |
| `src/broker/etoro/etoro-instrument-metadata.ts` | Strict parser and four-field report of that read. |
| `src/broker/etoro/etoro-observe-cli.ts` | `--source=instrument-metadata`. |
| `src/broker/etoro/etoro-instrument-mapping.ts` | `applyGovernedEtoroMapping`: a human eToro mapping with metadata evidence. |
| `src/runtime/app.ts`, `services.ts` | `GET /api/broker/etoro/demo/cycle`, read only. |
| `test/broker/etoro/o22-*.test.ts`, `test/runtime/o22-runtime.test.ts`, `test/pg/o22-cycle-budget.pg.test.ts` | New tests (section 10). |
| `test/broker/etoro/o20-boundary.test.ts`, `o21a-observation.test.ts`, `o21a1-observation.test.ts` | Allowlist pins updated: three fixed GET operations. |
| `test/runtime/o21-runtime.test.ts`, `test/pg/o21-runtime.pg.test.ts` | The route intent invests 100 USD (the runtime cycle limit). No rule was relaxed. |

## 3. The cycle policy and budget

`DEMO_E2E_CYCLE_POLICY` is the runtime policy since O22. It is stricter than the O21 default in every field:

| Field | O21 default | Cycle |
|---|---|---|
| `maxOrderInvestmentUsd` | 1000 | **100** |
| `maxLeverage` | 1 | 1 |
| `maxOpenPositions` | 3 | **1** |
| `maxGrossExposureUsd` | 3000 | **100** |
| `maxOpenSubmissions` / `maxCloseSubmissions` | none | **1 / 1** |
| quote / safety / sync age | 60 s / 5 min / 5 min | same |

**The budget.**
- It counts every intent that ever reached `SUBMITTING`, over the whole persistent intent log, whatever happened next: accepted, rejected (for example 403, a missing write permission), timeout, `AMBIGUOUS`, or a crash after the reservation.
- It is checked in two places:
  - at the gate;
  - again inside the reservation step (`bookRefusals`, inside the log's storage-backed critical section).

  So it holds across processes (tested on PostgreSQL with two pools).
- Once spent, every further open or close is refused (`CYCLE_OPEN_BUDGET_EXHAUSTED` / `CYCLE_CLOSE_BUDGET_EXHAUSTED`). There is no reset, no route and no configuration for it. A new cycle needs a reviewed code change. **This is the test end**: after one open and one close, nothing more can be sent.
- A refused execute (lock closed, gate refused) never reaches `SUBMITTING` and does not spend the budget.

## 4. Cycle reconciliation (read only)

`reconcileDemoCycle(intents, snapshot)` and `GET /api/broker/etoro/demo/cycle` compare broker-confirmed order status with a stored O20 `/demo/portfolio` snapshot.

**Identity.** A position is identified by the `positionID` from an eToro **order status read** (`orders:lookup`), never by instrument. A position the operator opened by hand on the same instrument (for example the existing ETH buy of O21B/O21C) is listed as **external**. It is never taken for the NEXUS position, and NEXUS never closes it.

**Item kinds.**
- `open_position_confirmed`, `close_confirmed`: proved by a snapshot observed **after** the confirming state.
- `open_position_missing`, `position_mismatch`, `closed_position_still_open`: **inconsistent**.
- `outcome_pending` (`SUBMITTING`, `SUBMITTED`, `ACCEPTED`, `AMBIGUOUS`, `RECONCILED`, `PARTIALLY_FILLED`) and `snapshot_predates_intent`: **unknown**.

**Verdict.**
- `consistent` only if nothing is inconsistent or unknown and the snapshot is fresh.
- A missing or stale snapshot is `unknown`.

Nothing is sent, written, booked or corrected.

**The route.** `GET /api/broker/etoro/demo/cycle` answers with:
- `execution` (enabled or disabled) and `buildLocked`;
- the budget: `policyVersion`, maxima and counts;
- the cycle reconciliation;
- the safety readiness.

It sends no broker request: the snapshot is the latest stored one, and `POST /api/broker/etoro/sync` (O20) refreshes it.

## 5. Portfolio safety: why it stays not connected

What the request asks for, and what NEXUS can prove today (`assessDemoSafetyReadiness`):

| Input | Status | Why |
|---|---|---|
| Demo account context | not verified | The portfolio states no account identity (`accountIdentity: not_observed`). "Demo" rests on the demo route and keys. |
| Positions and open orders | verified when the sync is fresh | O20/O21A parser; positions live-observed |
| Current gross exposure | not available | `/demo/portfolio` has no current rate; the valuation of the demo positions is not verified |
| Available funds | not verified | The meaning of `credit` is not verified; cash stays `not_read` |
| Drawdown and loss limits | not available | No verified demo equity or day P&L. The O15 envelope values the **CHF ledger**, which does not hold the demo account. |
| Data freshness | from the O20 sync | |
| Kill switch | from the kill switch store | A tripped switch blocks every open |

The report always says `connected: false`, and the runtime still passes `NO_DEMO_SAFETY_SOURCE`. Feeding the O15 ledger decision into the gate would read the demo account as safe without valuing it: that is the "unknown read as approved" case that is excluded. **No safety decision is produced, and none is faked.**

Closing this gap needs a safety-relevant decision by the operator (section 9, B2).

## 6. Instrument identity of 100001

| Fact | Status |
|---|---|
| `instrumentID` 100001 is the position observed in `/demo/portfolio` | LIVE_OBSERVED (O21B direct, O21C through NEXUS) |
| It is ETH | **Preliminary hint only**: the operator's UI comparison (direction, units, rate, time); 0.04229 × 2364.57 ≈ 100 = `amount` at leverage 1 |
| Product type of the observed position | Not CFD. `settlementTypeID` is documented as "0 - CFD, 1 - Real Asset, 2 - SWAP, 3 - Crypto MarginTrade, 4 - Future Contract". O21C reports it as a positive integer; the exact value is not exported. |
| Meaning of `units` and `amount` | `amount` = USD allocated (reference). `units` = number of units (reference); whether it equals an ETH quantity depends on the exact `settlementTypeID`. NOT_VERIFIED. |
| Currency and price notation of `openRate` | "In the instrument's currency" (reference); USD is not stated in the payload. NOT_VERIFIED. |
| NEXUS registry mapping for 100001 | **None.** No ETH/USD instrument is registered in the repository fixtures. Nothing was registered. |

**Prepared, not executed:**
- **The fixed metadata read.**
  - Operation: `instrument.metadata.100001` → `GET https://public-api.etoro.com/api/v2/market-data/instruments?instrumentsIds=100001`.
  - Fixed: the id and the query are constants.
  - Rules: one GET, no body, no retry, keys in headers only.
  - Used only by `npm run etoro:observe-demo -- --source=instrument-metadata --confirm-live-read`.
  - Report: `instrumentId`, `type`, `symbol` and `displayName`, nothing else. A refusal names a path, never a value, and exit code 0 still requires `verdict: accepted`.
  - Authorization: the reference accepts `etoro-public:market-data:read` (or `demo:read`). The operator reports that `market-data:read` was present in the successful `/me` result (not stored in the repository); if so, no new key permission is needed, only this addition to our allowlist.
- **The governed mapping, `applyGovernedEtoroMapping`.**
  - Who: a named human only.
  - Evidence: the accepted report, cited by its sha256.
  - The NEXUS instrument must already exist, be active and in USD, with the asset class of the eToro type: `Crypto` → `crypto`. CFD, Bonds, TrustFunds and Options are refused.
  - The mapping has no exchange, and an existing mapping on either side is refused.
  - No symbol comparison decides anything.
  - **There is no CLI or route for it yet** (section 9, B4).

## 7. The demo buy as the code sends it

- **Body.** `{ action: 'open', transaction: 'buy', instrumentId: 100001, orderType: 'mkt', amount: 100, orderCurrency: 'usd', leverage: 1 }`, plus `stopLossRate` / `stopLossType: 'fixed'` / `takeProfitRate` only if the intent sets them. Exactly one of amount/units is sent; the cycle uses **amount**, never unverified units.
- **Endpoint and header.** `POST https://public-api.etoro.com/api/v2/trading/execution/demo/orders`, with a fresh `x-request-id`. The `referenceId` of the answer must echo it.
- **`settlementType`.** It is optional on v2 and **not sent** (O21). The position type is then the broker default. Open point: whether to send `settlementType: 'real'` explicitly is a decision (section 9, B6).
- **Minimum amount.** It is not in the API reference. eToro's own product announcement gives a USD 10 minimum for crypto; 100 USD is above it.
- **Write permission.** The reference requires `etoro-public:demo:write` or `etoro-public:trade.demo:write`. Whether the existing key has it is **not verified**. A 401/403 is `REJECTED`, which also spends the open budget.
- **Rate limit.** 20 writes per 60 s, shared. The local pacer and `Retry-After` apply.

## 8. Exact sequence for the later first demo buy and close (after section 9 is resolved)

Every step is a separate operator action, and every "STOP" is final for this cycle.

1. **Preconditions** (each checked, not assumed):
   - the release change of section 9 is merged;
   - `ETORO_ENABLED=1`, `ETORO_TRADING_MODE=demo`, `ETORO_DEMO_EXECUTION_ENABLED=1`, `NEXUS_OPERATOR_ID` / `NEXUS_OPERATOR_TOKEN` set; `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false` unchanged;
   - production market data for ETH/USD configured.
2. **Identity.**
   - Run the metadata read once. STOP unless `verdict: accepted`, `instrumentId: 100001`, `type: Crypto`.
   - Register ETH/USD via `POST /api/instruments/register` if it is not registered.
   - Apply the governed mapping by the operator with the report's sha256.
3. **Quote.** `GET /api/market/quote?instrumentId=<ETH/USD>`. It must be fresh (≤ 60 s), production, USD.
4. **Baseline.**
   - `POST /api/broker/etoro/sync`, then `GET /api/broker/etoro/demo/cycle`.
   - Expect: budget 0/0; reconciliation without items; the hand-opened ETH position listed as **external**.
   - STOP if the sync fails or the snapshot is not fresh.
5. **Create the open.** `POST /api/broker/etoro/demo/intents` with `action: open`, `side: buy`, `orderType: mkt`, `amount: "100"`, `currency: USD`, `leverage: 1`, the NEXUS ETH/USD id, `etoroInstrumentId: 100001`, `expiresAt` ≤ 15 min after `createdAt`. STOP unless `RISK_APPROVED`.
6. **Approve.** `POST …/intents/{id}/approve` by the operator.
7. **Execute, exactly once.** `POST …/intents/{id}/execute`.
   - `SUBMITTED` → continue.
   - `REJECTED` → STOP. The cycle budget is spent.
   - `AMBIGUOUS` (timeout, 5xx, unparseable) → **never execute again**. Only `POST …/refresh`, which looks the order up by the original `x-request-id`. A not-found decides nothing. Check the eToro UI by hand.
8. **Confirm.** `POST …/refresh` (reads only) until `FILLED`; it may take several manual calls with pauses. Note `brokerPositionIds` (exactly one). An accepted order is not an executed one.
9. **Portfolio after the buy.**
   - `POST /api/broker/etoro/sync`, then `GET /api/broker/etoro/demo/cycle`.
   - Expect `open_position_confirmed` for that `positionId` and verdict `consistent`.
   - STOP on `inconsistent` or `unknown`.
10. **Close, with a new approval.**
    - `POST …/intents` with `action: close`, `closesIntentId: <open intent>`. The position id comes from the broker-confirmed status, never from input.
    - Then `approve` (a **new** human approval) and `execute`, exactly once.
    - `AMBIGUOUS` close: **no further close**. It stays `AMBIGUOUS`; check the UI by hand.
    - `refresh` until `FILLED`.
11. **Final state.**
    - `POST /api/broker/etoro/sync`, then `GET /api/broker/etoro/demo/cycle`.
    - Expect `close_confirmed`, budget 1/1, the external ETH position untouched.
    - **Test end**: every further open or close is refused by the budget.

No step books anything in the ledger, and no balancing or opening booking is made.

## 9. Blockers before a release

| # | Blocker | Kind |
|---|---|---|
| B1 | `BUILD_LOCKS.etoroDemoExecution = true` | A separate, explicitly approved code change, after B2–B5. Not part of this package. |
| B2 | No demo portfolio safety source (`PORTFOLIO_SAFETY_NOT_CONNECTED`); equity, cash, exposure and day P&L of the demo account are not verified | **Safety decision by the operator**: (a) build a verified demo-account valuation (needs a non-empty `/demo/pnl` observation and verified `credit` semantics), or (b) explicitly approve a narrowly scoped cycle-only safety basis (the 100 USD / one position / one-cycle budget instead of an account-level envelope). Neither is implemented. |
| B3 | Identity of 100001 not officially confirmed | One approved run of the prepared metadata read, or an explicit operator decision to accept the UI hint |
| B4 | No governed mapping path in the running system | A CLI or operator route calling `applyGovernedEtoroMapping` (not built) |
| B5 | Demo write permission of the key not verified | Operator check of the key's scopes (`demo:write` / `trade.demo:write`) |
| B6 | `settlementType` not sent; the broker default decides the position type | Decision: keep the default, or send `real` (a code change) |
| B7 | AMBIGUOUS close reconciliation not verified (O21) | Accepted: an ambiguous close stays ambiguous and is checked by hand |
| B8 | Production ETH/USD quote | Configuration of the market data provider in production mode |

## 10. Tests

| File | What |
|---|---|
| `o22-cycle.test.ts` (16) | The policy constant, stricter in every field; sizes above 100 USD and leverage refused. Then: <ul><li>the full cycle with exactly 2 writes and the test end;</li><li>the open body;</li><li>budget across processes;</li><li>timeout → AMBIGUOUS with no second order;</li><li>a negative lookup decides nothing;</li><li>AMBIGUOUS found by referenceId;</li><li>403 spends the budget;</li><li>AMBIGUOUS close not reconciled, no second close;</li><li>a rejected close spends the close budget;</li><li>crash after SUBMITTING and restart;</li><li>the race where the reservation refuses by budget alone;</li><li>the same intent executed twice at once;</li><li>a tripped kill switch blocks the open but allows the close;</li><li>no safety source → `PORTFOLIO_SAFETY_NOT_CONNECTED`.</li></ul> |
| `o22-cycle-reconciliation.test.ts` (7) | Confirmed, external hand-opened position, mismatch, close confirmed or still open, snapshot predates, missing or stale, pending states, pending broker orders |
| `o22-safety-readiness.test.ts` (4) | Never connected; stale is never verified; a tripped switch blocks; the runtime passes no safety source |
| `o22-instrument-metadata.test.ts` (23) | Strict parser; 13 refusals by path; one GET to the fixed URL; HTTP errors with no retry; gating; only the CLI and the allowlist name the operation; no mapping from it |
| `o22-governed-mapping.test.ts` (6) | Human only; evidence checks; instrument checks; conflicts; symbol does not decide |
| `test/runtime/o22-runtime.test.ts` (7) | The route, with no broker request; the runtime policy; locked build without a mock (0 writes, budget untouched); every lock closed; no real route |
| `test/pg/o22-cycle-budget.pg.test.ts` (3) | Budget across two PostgreSQL pools; concurrent executes; restart after a timeout |

Results: see the PR description (full unit and PostgreSQL suites, `tsc --noEmit`).

## 11. Safety boundaries (unchanged)

- `BUILD_LOCKS` = `{ liveTrading, brokerOrders, physicalPurchase, etoroDemoExecution }` all `true`.
- `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`.
- No real-account endpoint and no real key path.
- No autonomous cycle: every write needs a named human approval and a human execute.
- No ledger booking, no balancing booking, no automatic mapping.
- No eToro request was made while building O22.
