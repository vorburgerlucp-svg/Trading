# O22 – Controlled eToro Demo Trading Cycle (End-to-End) V1

Status: **implemented and tested offline; not released.** Base: `519233d` (merge of PR #24, O21C).
- No eToro request was sent while building O22: no authenticated read, no demo write, no metadata read.
- `BUILD_LOCKS.etoroDemoExecution = true` refuses every demo write in this build.
- The demo account safety source (B2, variant A, section 5) is built and wired. It answers `null` until a non-empty `/demo/pnl` has been observed live and recorded, so every open is still refused with `PORTFOLIO_SAFETY_NOT_CONNECTED`.
- The first demo buy therefore cannot happen with this build. Section 9 lists what is still open; section 8 gives the exact sequence for afterwards.

Naming note: an unrelated, uncommitted work package "O22 OpenAI shadow provider" exists in another local worktree (with a migration `014_model_run_usage.sql`). This package uses its own file and branch names, adds no migration, and touches none of those files. The numbering should be reconciled before both are merged.

## 1. What already existed and is reused

| Part | Source | Used for |
|---|---|---|
| Read-only demo portfolio sync, snapshot, reconciliation against the ledger | O20, O21A | baseline and after-trade portfolio |
| Non-empty portfolio parser (live-observed for positions) | O21A, O21B, O21C | identifying positions by `positionID` |
| `/demo/pnl` parser (REFERENCE_SCHEMA, only empty live-observed) | O21A.1 | the account valuation of the safety source |
| `ExecutionIntent`, state machine, risk gate, operator authentication, routes | O21 | the cycle itself, unchanged |
| Reservation step (`SUBMITTING` inside the log's critical section) | O21 | at-most-once, and the cycle budget |
| AMBIGUOUS handling | O21 | timeouts and unclear answers |
| Close of a broker-confirmed position, cancel of a pending open | O21 | the close of the cycle |
| Kill switch store | O15/O16 | part of every safety decision |

## 2. What O22 adds

| File | Change |
|---|---|
| `execution/execution-gate.ts` | `DEMO_E2E_CYCLE_POLICY` with the open and close budget. `GateSafetyDecision`: the narrow safety shape the gate reads; the checks themselves are unchanged. |
| `execution/etoro-demo-execution-service.ts` | Submission counts and `cycleBudget()`. The broker's `settlementType` is kept from order status reads. |
| `execution/etoro-demo-execution-validation.ts` | `asset.settlementType` of `orders:lookup`: an enum, strictly validated. |
| `execution/demo-account-evidence.ts` | The compile-time evidence record. Non-empty `/demo/pnl` live-observed: **false**. |
| `execution/demo-account-safety.ts` | The demo account safety source: the guide formulas, limits, risk day, kill switch. |
| `execution/demo-safety-readiness.ts` | Readiness report: evidence, source status, sync, kill switch. |
| `execution/demo-cycle-reconciliation.ts` | The cycle against the snapshot; external positions; product type. |
| `etoro-pnl-validation.ts` | `parseDemoPnlValuationInput`: `credit`, `accountCurrencyId` and the external costs, with the same strictness. |
| `etoro-readonly.ts`, `etoro-transport.ts`, `etoro-instrument-metadata.ts`, `etoro-observe-cli.ts` | One fixed metadata read, `instrument.metadata.100001`. |
| `etoro-instrument-mapping.ts`, `etoro-map-instrument-cli.ts`, `package.json` | The governed mapping (plan and apply), and `npm run etoro:map-instrument` (dry run by default). |
| `runtime/compose.ts`, `bootstrap.ts`, `services.ts`, `app.ts` | Cycle policy; the demo account safety source wired, with the log `etoro-demo-account-valuations`; `GET /api/broker/etoro/demo/cycle`. |
| Tests | Section 10. |

## 3. The cycle policy and budget

`DEMO_E2E_CYCLE_POLICY` is the runtime policy:
- at most 100 USD per open, leverage 1, one position, at most 100 USD gross exposure of NEXUS intents;
- **one open and one close submission over the whole intent log**.

**Budget.**
- Every submission spends it, whatever its outcome: accepted, rejected, timeout, AMBIGUOUS, or a crash after the reservation.
- It is checked at the gate and again inside the reservation step, so it holds across processes (tested on PostgreSQL).
- It cannot be reset: after one open and one close the test is over, and a new cycle needs a code change.
- A refused execute (lock, gate) is not a submission and does not spend it.

## 4. Cycle reconciliation (read only)

Positions are identified by the `positionID` from an eToro order status read, never by instrument.
- **Hand-opened positions.** A position the operator opened by hand (the ETH buy of O21B/O21C) is **external**. It is never taken for the NEXUS position and never closed by NEXUS.
- **Snapshot timing.** Only a snapshot taken after the confirming state can confirm.
- **Product type.** A filled open whose order status does not state `settlementType: real` is flagged `PRODUCT_TYPE_NOT_CONFIRMED_REAL`, because the units of a CFD or margin position are not an asset quantity.
- **Route.** `GET /api/broker/etoro/demo/cycle` reports the budget, this reconciliation and the safety readiness. It sends no broker request.

## 5. Portfolio safety of the demo account (B2, variant A)

### What eToro documents, and what has been observed

| Value | Source (official) | LIVE_OBSERVED |
|---|---|---|
| `credit` | `/demo/pnl` and `/demo/portfolio` schema; guides use it for Available Cash | present as a positive number in empty and non-empty `/demo/portfolio`, and in an empty `/demo/pnl` |
| `accountCurrencyId` ("1 = USD") | `/demo/pnl` schema | **1**, in an empty `/demo/pnl` (direct GET, O21A.1) |
| `positions[].amount`, `leverage` | both schemas | yes, in `/demo/portfolio` (O21B/O21C) |
| `positions[].unrealizedPnL.pnL` | `/demo/pnl` schema (nested), guides | **no**: a non-empty `/demo/pnl` has never been observed |
| `ordersForOpen[].amount`, `totalExternalCosts`; `orders[].amount` | `/demo/pnl` schema, guides | no (always empty) |
| Account identity | not in the portfolio; `GET /api/v1/me` returns `demoCid` and `scopes` | the operator reports a successful `/me`; nothing of it is stored |
| Demo context of the key | Reference: "Each key can only be used for one environment" | the operator confirmed the key environment Demo (O21A section 11) |

**Formulas** (official guides, checked 2026-10-18):
- Available Cash = credit − (Σ ordersForOpen.amount (mirrorID = 0) + Σ orders.amount)
- Total Invested = Σ positions.amount + Σ ordersForOpen.amount + Σ orders.amount + Σ ordersForOpen.totalExternalCosts (+ mirror terms; mirrors are refused)
- Unrealized PnL = Σ positions.unrealizedPnL.pnL
- Equity = Available Cash + Total Invested + Unrealized PnL

All of these are "USD balance".

### The source (`EtoroDemoAccountSafetySource`)

- **One read per evaluation.** Each gate run (create and execute) makes one GET `/demo/pnl`, never retried. HTTP ≠ 200, a transport failure, or a refused response gives **null**, and the gate answers `PORTFOLIO_SAFETY_NOT_CONNECTED`.
- **Fail-closed valuation.** A value a formula needs and the response does not state is a **DATA_HOLD** and is never read as zero:
  - a position without `unrealizedPnL.pnL`;
  - an `ordersForOpen` entry without `totalExternalCosts`;
  - `accountCurrencyId` absent or not 1.
- **Whole account.**
  - Gross exposure = Σ |amount × leverage + pnL| over **all** positions, plus Σ amount × leverage over all pending orders.
  - Hand-opened positions are included and reported as `externalPositions` / `externalExposureUsd`. Nothing is subtracted.
- **Limits** (`DEMO_ACCOUNT_SAFETY_POLICY`, a code constant for review):

  | Check | Limit | Result |
  |---|---|---|
  | account gross exposure + one reserved cycle order (100 USD) | ≤ 100 USD | else `ACCOUNT_EXPOSURE_LIMIT` (capacity block) |
  | positions + pending orders + 1 | ≤ 1 | else `ACCOUNT_POSITION_LIMIT` (capacity block) |
  | available cash | ≥ 100 USD | else `AVAILABLE_CASH_BELOW_ORDER` (capacity block) |
  | day loss from the first valuation of the UTC day | < 100 USD and < 100 bp | else `DAILY_LOSS_LIMIT` (trips) |
  | drawdown from the day's peak | < 100 USD and < 100 bp | else `DRAWDOWN_LIMIT` (trips) |
  | equity | > 0 | else `EQUITY_NOT_POSITIVE` (trips) |
  | kill switch | armed | else `KILL_SWITCH_TRIPPED` |

- **Risk day.** Complete valuations are appended to `etoro-demo-account-valuations`. It stores day, time and equity only; no account or position id. All processes share it, so a restart does not reset a drawdown (PostgreSQL test). A breach does not latch the shared kill switch. With an open budget of one, a later recovery cannot allow more than that one open.
- **Decision.** It has the gate's shape (`state`, `canIncreaseRisk`, `killSwitch`, reasons, `asOf`). It is NORMAL only with every check passing, and `liveOrderAllowed` is always `false`.
- **Evidence gate.** `DEMO_ACCOUNT_VALUATION_EVIDENCE.nonEmptyPnlLiveObserved = false` is a compile-time constant, read directly like `BUILD_LOCKS`. While it is false, the source returns null and **sends no request**.

### The hand-opened ETH position

It is in the account (O21B/O21C: 100 USD at leverage 1). With it, account exposure (≈100 USD) plus the reserved 100 USD order exceeds 100 USD, and the account holds one position already. The decision is `CAPACITY_BLOCK` (`ACCOUNT_EXPOSURE_LIMIT`, `ACCOUNT_POSITION_LIMIT`), and the cycle open stays refused (tested).

Two ways out, neither taken here:
1. **Recommended:** the operator closes the hand-opened position **in the eToro UI** before the test. NEXUS never closes it. The account then has no exposure, and the 100 USD order fits.
2. A reviewed code change raises `maxAccountGrossExposureUsd` / `maxAccountPositionsAndOrders` to cover the existing position. That is an explicit risk decision; the existing exposure would still be counted, not removed.

## 6. Instrument identity of 100001

| Fact | Status |
|---|---|
| 100001 is the instrument of the observed position | LIVE_OBSERVED (O21B, O21C) |
| It is ETH | preliminary UI hint only (direction, units, rate, time; 0.04229 × 2364.57 ≈ 100 = `amount`) |
| Product type of the hand-opened position | `settlementTypeID` positive: **not a CFD** ("0 - CFD, 1 - Real Asset, 2 - SWAP, 3 - Crypto MarginTrade, 4 - Future Contract"). Exact value not exported. |
| Product type of the NEXUS open | captured from the order status (`asset.settlementType`: cfd, real, realFutures, marginTrade) and flagged unless `real` |
| `amount` / `units` | `amount` = USD allocated incl. margin; `units` = number of units. They equal an asset quantity only for `real` (to be confirmed by the order status). |
| `openRate` currency | "in the instrument's currency"; not stated in the payload |
| NEXUS mapping for 100001 | **none**; nothing registered |

**Prepared, not executed:**
- **The metadata read.** `npm run etoro:observe-demo -- --source=instrument-metadata --confirm-live-read`: one GET `/api/v2/market-data/instruments?instrumentsIds=100001`. The report keeps four fields: id, type, symbol and display name.
- **The governed mapping.** `npm run etoro:map-instrument -- --instrument-id=<ETH/USD> --metadata-report=<saved report> --valid-from=<UTC> --operator=<id>`.
  - It runs as a dry run by default; `--apply --confirm-human-mapping` writes the one registry event.
  - The evidence is the report file, cited by its sha256.
  - The NEXUS instrument must exist, be active, in USD and `crypto`. There must be no exchange and no existing mapping.
  - No symbol comparison decides anything.

## 7. The demo buy as the code sends it

- **Body.** `{ action: 'open', transaction: 'buy', instrumentId: 100001, orderType: 'mkt', amount: 100, orderCurrency: 'usd', leverage: 1 }`, with no units and a fresh `x-request-id`.
- **`settlementType`.** It is not sent (v2: optional). The broker's choice is **verified** after the fill from the order status and flagged unless `real`.
- **Minimum.** USD 10 for crypto (eToro product announcement, not the API reference).
- **Write permission.**
  - Required: `etoro-public:demo:write` or `etoro-public:trade.demo:write`.
  - For API keys, the permission is set when the user key is created ("Write" for trading) and is reported in `GET /me` → `scopes`.
  - Not proved in the repository. If the operator's earlier `/me` result lists one of these scopes, B5 is closed **without any new call**.

## 8. Exact sequence for the first demo buy and close (after section 9)

Each step is a separate operator action. Every STOP ends this cycle.

1. **Evidence for the valuation.**
   - Run one approved `npm run etoro:observe-demo -- --source=pnl --confirm-live-read --pseudonymize-ids --show-instrument-ids` while the hand-opened position still exists. It is non-empty now, so this is exactly the missing observation.
   - STOP unless the parser verdict is `accepted` and `positions[].unrealizedPnL` holds `pnL`.
   - Record the report as evidence. Then a reviewed code change sets `nonEmptyPnlLiveObserved: true` with that `evidenceRef`.
2. **Identity.**
   - Run one approved metadata read. STOP unless `accepted`, id 100001, type `Crypto`.
   - Register ETH/USD (`POST /api/instruments/register`).
   - Dry-run `etoro:map-instrument`, then apply it with confirmation.
3. **Write permission.** The operator confirms a demo write scope from the `/me` result.
4. **Clear the account.** The operator closes the hand-opened ETH position in the eToro UI. NEXUS does not touch it.
5. **Release.** A separate reviewed change opens `BUILD_LOCKS.etoroDemoExecution` for this build. Set `ETORO_ENABLED=1`, `ETORO_TRADING_MODE=demo`, `ETORO_DEMO_EXECUTION_ENABLED=1` and operator auth. `TRADING_MODE=paper` and `ALLOW_LIVE_TRADING=false` stay.
6. **Baseline.**
   - `POST /api/broker/etoro/sync` and `GET /api/broker/etoro/demo/cycle`.
   - Expect budget 0/0, no positions, safety `connected: true` with last decision NORMAL.
   - Check that the ETH/USD quote is fresh.
7. **Open.**
   - Create the open intent (100 USD, mkt, buy, leverage 1, 100001). STOP unless `RISK_APPROVED`.
   - Approve it.
   - **Execute exactly once.**
     - `REJECTED`: STOP.
     - `AMBIGUOUS`: only `refresh`, which looks the order up by the original request id. Never execute again.
8. **Confirm.**
   - `refresh` until `FILLED`. Note the one `brokerPositionIds` and `brokerSettlementType`.
   - Sync, then cycle. Expect `open_position_confirmed`; STOP on `inconsistent` or `unknown`.
   - A `PRODUCT_TYPE_NOT_CONFIRMED_REAL` reason is noted for review.
9. **Close.**
   - Create the close intent (`closesIntentId`), give a **new** approval, **execute once**.
   - `AMBIGUOUS`: no further close; check the UI by hand.
   - `refresh` until `FILLED`.
10. **Final state.**
    - Sync, then cycle. Expect `close_confirmed` and budget 1/1.
    - Test end: every further write is refused.

No ledger booking at any step.

## 9. Blockers B1–B8

| # | Blocker | Status after this package | What closes it |
|---|---|---|---|
| B1 | `BUILD_LOCKS.etoroDemoExecution = true` | **open** (by design) | a separate, approved code change, last |
| B2 | Demo portfolio safety | **implemented (variant A); not active** | (1) one approved `/demo/pnl` observation, non-empty and parser-accepted; (2) a reviewed change of the evidence record; (3) the account must fit the limits (close the hand-opened position, or an explicit limit decision) |
| B3 | Identity of 100001 | **open**; read prepared | one approved metadata read (or an explicit decision to accept the UI hint) |
| B4 | Governed mapping path | **closed** (`etoro:map-instrument`, dry run and apply); not executed | the operator's apply after B3 |
| B5 | Demo write permission | **not proved in the repository** | the `scopes` from the operator's `/me` result (no new call needed if it is at hand) |
| B6 | `settlementType` | **narrowed**: not sent, but verified after the fill and flagged unless `real` | decide whether a non-`real` result is acceptable for the test |
| B7 | AMBIGUOUS close | accepted (unchanged): stays AMBIGUOUS, no further close, manual UI check | — |
| B8 | Production ETH/USD quote | **open** | production market data configuration |

## 10. Tests

| File | What |
|---|---|
| `o22-cycle.test.ts` (17) | Policy; full cycle; timeout, AMBIGUOUS, 403; close ambiguity; crash and restart; races; kill switch; product type from the order status |
| `o22-demo-account-safety.test.ts` (14) | Guide formulas; external positions; data holds; decision limits; the hand-opened position blocks the open; the source sends nothing without evidence |
| `o22-account-safety-cycle.test.ts` (10) | Evidence released for the module only: <ul><li>one GET per evaluation; null on 4xx/5xx, timeout or invalid response;</li><li>risk day start, peak and new day;</li><li>DATA_HOLD not recorded; kill switch;</li><li>the cycle with the real source: open refused with the hand-opened position;</li><li>the position appearing before execute (refused, budget kept);</li><li>a failed read refuses the open;</li><li>the full open; the close without a safety read;</li><li>an ambiguous close is never repeated.</li></ul> |
| `o22-cycle-reconciliation.test.ts` (8), `o22-safety-readiness.test.ts` (4) | Reconciliation and readiness |
| `o22-instrument-metadata.test.ts` (23), `o22-governed-mapping.test.ts` (6), `o22-map-instrument-cli.test.ts` (6) | Metadata read, mapping, tool |
| `test/runtime/o22-runtime.test.ts` (8) | The route; the production wiring with the demo account source and no evidence (open refused, 0 eToro requests); locked build without mock; every lock closed |
| `test/pg/o22-cycle-budget.pg.test.ts` (3), `test/pg/o22-account-safety.pg.test.ts` (1) | Budget across pools; a shared risk day across processes and a restart |

Results: in the PR description.

## 11. Safety boundaries (unchanged)

- `BUILD_LOCKS` = `{ liveTrading, brokerOrders, physicalPurchase, etoroDemoExecution }`, all `true`.
- `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`.
- No real endpoint and no real key path.
- No autonomous cycle.
- No ledger booking and no balancing booking; the valuation log is not a ledger.
- No automatic mapping and no automatic close of the hand-opened position.
- No eToro request was made while building O22.
