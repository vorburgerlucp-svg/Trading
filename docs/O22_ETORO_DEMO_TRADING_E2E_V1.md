# O22 – Controlled eToro Demo Trading Cycle (End-to-End) V1

Status: **implemented and tested offline; not released.** Base: `519233d` (merge of PR #24, O21C).
- No eToro request was sent while building O22: no authenticated read, no demo write, no metadata read.
- Afterwards, two operator-approved reads were made, each exactly one `GET /api/v1/trading/info/demo/pnl` through the observation tool (2026-10-18). Both returned a **non-empty** response that the parser accepted. The second proved G1 and G2 (section 12).
- The evidence record now says `nonEmptyPnlLiveObserved: true` and cites both reports. The demo account safety source is therefore **active**: it reads `/demo/pnl` and decides. A safety decision is **not** a trade release:
  - the build lock stays closed;
  - the account limits are unchanged;
  - the hand-opened ETH position makes the decision `CAPACITY_BLOCK`.
- `BUILD_LOCKS.etoroDemoExecution = true` refuses every demo write in this build.
- The demo account safety source (B2, variant A, section 5) is built and wired. It answers `null` (`PORTFOLIO_SAFETY_NOT_CONNECTED`) only when its one `/demo/pnl` read fails or is refused; the evidence gate itself is open. With the hand-opened position, its decision refuses every cycle open with `CAPACITY_BLOCK`.
- 2026-10-19 (section 15): the local registry held no instrument. Twelve Data states no currency for ETH/USD in `/symbol_search` or `/quote`; O22 now takes it from Twelve Data's `/cryptocurrencies` reference (`currency_quote` "US Dollar" → `USD` by a reviewed name table). ETH/USD is registered once (`ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc`), its production quote showed `USD` at 51.7 s, and the governed eToro mapping `etoro / 100001 → ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc` was **applied** by `luc-vorburger` after an approved dry run (one `mapping_added` event).
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
| `execution/execution-gate.ts` | `DEMO_E2E_CYCLE_POLICY` with the open and close budget, long-only and market-only. `GateSafetyDecision`: the narrow safety shape the gate reads; the checks themselves are unchanged. |
| `execution/etoro-demo-execution-service.ts` | Submission counts and `cycleBudget()`. The broker's `settlementType` is kept from order status reads. |
| `execution/etoro-demo-execution-validation.ts` | `asset.settlementType` of `orders:lookup`: an enum, strictly validated. |
| `execution/demo-account-evidence.ts` | The compile-time evidence record. Non-empty `/demo/pnl` live-observed: **true**, citing both reports of section 12. |
| `execution/demo-account-safety.ts` | The demo account safety source: the guide formulas, limits, risk day, kill switch. |
| `execution/demo-safety-readiness.ts` | Readiness report: evidence, source status, sync, kill switch. |
| `execution/demo-cycle-reconciliation.ts` | The cycle against the snapshot; external positions; product type. |
| `etoro-pnl-validation.ts` | `parseDemoPnlValuationInput`: `credit`, `accountCurrencyId` and the external costs, with the same strictness. |
| `etoro-readonly.ts`, `etoro-transport.ts`, `etoro-instrument-metadata.ts`, `etoro-observe-cli.ts` | One fixed metadata read, `instrument.metadata.100001`. |
| `etoro-instrument-mapping.ts`, `etoro-map-instrument-cli.ts`, `package.json` | The governed mapping (plan and apply), and `npm run etoro:map-instrument` (dry run by default). |
| `execution/demo-cycle-test-verdict.ts`, `etoro-broker-service.ts` (`snapshotHistory`), `runtime/services.ts` | C1: the test verdict of the success criterion (`passed` / `failed` / `incomplete`) from stored state; `GET /api/broker/etoro/demo/cycle` reports it as `test`. |
| `execution/etoro-demo-execution-service.ts`, `etoro-demo-execution-adapter.ts`, `etoro-demo-execution-transport.ts` | C2: no account safety read for a close. C3/F10: the write request is built, serialized and checked (`prepareOpen` / `prepareClose`, `serializeRequestBody`, `assertSendable`) before the reservation; the transport sends exactly the prepared text. F6: the intent view lists every status read unmerged (`statusReads`) and the confirmation id of a broker-confirmed state. |
| `etoro-me-scopes.ts`, `etoro-readonly.ts`, `etoro-observe-cli.ts` | B5: the fixed identity read `identity.me` (`GET /api/v1/me`) and `--source=me`; the report keeps only the scope names and the demo/real read/write checks. |
| `market-data/providers/twelve-data-crypto-reference.ts`, `twelve-data.ts`, `twelve-data-schema.ts` | The quote currency of a crypto pair from `/cryptocurrencies` (section 15): strict parser, unique row, reviewed name table, cached reference, origin. |
| `market-data/market-data-types.ts`, `market-data-provider.ts`, `market-data-service.ts`, `bar-validation.ts`, `runtime/services.ts`, `runtime/app.ts` | `CurrencyOrigin` on quotes and candidates (not hashed, not stored); the registry event names the origin; `/api/market/quote` reports `currency` and `currencyOrigin`. |
| `runtime/compose.ts`, `bootstrap.ts`, `services.ts`, `app.ts` | Cycle policy; the demo account safety source wired, with the log `etoro-demo-account-valuations`; `GET /api/broker/etoro/demo/cycle`. |
| Tests | Section 10. |

## 3. The cycle policy and budget

`DEMO_E2E_CYCLE_POLICY` is the runtime policy:
- at most 100 USD per open, leverage 1, one position, at most 100 USD gross exposure of NEXUS intents;
- **one open and one close submission over the whole intent log**;
- **the open is a buy (long) at market only** (since policy version `etoro-demo-e2e-cycle-policy:v2`).

**Long-only, market-only (v2).**
- `DemoExecutionPolicy` has two optional fields, `allowedOpenSides` and `allowedOpenOrderTypes`. Absent means no restriction.
- Only `DEMO_E2E_CYCLE_POLICY` sets them, to `['buy']` and `['mkt']` (frozen). `DEFAULT_DEMO_EXECUTION_POLICY` (O21) is unchanged and has neither field.
- A sell (short) open is refused with `CYCLE_SIDE_NOT_ALLOWED`; an MIT open with `CYCLE_ORDER_TYPE_NOT_ALLOWED`.
- The checks are in the gate's book-check table. So they run at creation, again at execute with fresh input, and once more in the reservation step, inside the intent log's critical section immediately before `SUBMITTING`. A refusal sends nothing and spends no budget.
- A close is not affected: it closes the broker-confirmed position by its id, at market.

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
| `positions[].unrealizedPnL.pnL` | `/demo/pnl` schema (nested), guides | **yes**: nested under `unrealizedPnL` in schema spelling (report 1); a **finite JSON number** for every position (report 2, G1). |
| `accountCurrencyId` = 1 in a non-empty `/demo/pnl` | `/demo/pnl` schema | **yes**: integer, code 1 (report 2, G2) |
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
- **Evidence gate.** `DEMO_ACCOUNT_VALUATION_EVIDENCE.nonEmptyPnlLiveObserved` is a compile-time constant, read directly like `BUILD_LOCKS`. It is **`true`** in this build (section 12), so the source reads and decides. Were it false, the source would return null and **send no request** (tested with the record mocked, `o22-demo-account-safety-no-evidence.test.ts`). The evidence enables decisions only; it releases no trade.

### The hand-opened ETH position

**Closed by the operator in the eToro UI on 2026-10-19 (B2, section 9); the text below describes the state before.** It was in the account (O21B/O21C: 100 USD at leverage 1). With it, account exposure (≈100 USD) plus the reserved 100 USD order exceeds 100 USD, and the account holds one position already. The decision is `CAPACITY_BLOCK` (`ACCOUNT_EXPOSURE_LIMIT`, `ACCOUNT_POSITION_LIMIT`), and the cycle open stays refused (tested).

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
| NEXUS mapping for 100001 | **`ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc`** (ETH/USD, crypto, USD), governed mapping applied 2026-10-19 by `luc-vorburger` (section 15) |

**The metadata read (executed once, section 14).** `npm run etoro:observe-demo -- --source=instrument-metadata --confirm-live-read`: one GET `/api/v2/market-data/instruments?instrumentsIds=100001`. The report keeps four fields: id, type, symbol and display name.

**Applied 2026-10-19 (section 15):**
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

1. **Evidence for the valuation. Done** (2026-10-18, section 12): two non-empty reads, G1 and G2 proved, and the evidence record set with both reports.
2. **Identity.**
   - Metadata read. **Done** (2026-10-18, section 14): `accepted`, id 100001, type `Crypto`.
   - Register ETH/USD (`POST /api/instruments/register`). **Done** (2026-10-19, section 15): `ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc`.
   - Check the production ETH/USD quote: `USD`, valid timestamp, at most 60 s old. **Done** (2026-10-19): `USD` from the reference, 51.7 s.
   - Dry-run `etoro:map-instrument` (**done**, 2026-10-19: plan accepted, nothing written), then apply it with confirmation (**done**, 2026-10-19, approved by the operator: `validFrom` 2026-10-19T11:47:36.000Z).
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
   - Sync, then cycle. Expect the reconciliation verdict `consistent` with the item `open_position_confirmed`; STOP on `inconsistent` (`open_position_missing`, `position_mismatch`) or a persisting `unknown` (section 17.3).
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
| B2 | Demo portfolio safety | **closed** (2026-10-19). The operator closed the hand-opened ETH demo position in the eToro UI. One read-only `GET /demo/pnl` through the observation tool afterwards: parser `accepted`, **0 positions**, every order container empty (`orders`, `ordersForOpen`, `ordersForClose`, `ordersForCloseMultiple`, `entryOrders`, `exitOrders`, `stockOrders`, `mirrors`), account currency USD (evidence `docs/evidence/O22_etoro_demo_pnl_observation_2026-10-19_b2.json`). No position or order blocks the test. Available cash ≥ 100 USD is not shown by the report (it states `credit` only as positive) and is decided by the safety source at creation. | — |
| B3 | Identity of 100001 | **confirmed** (section 14): Crypto, ETH, Ethereum | — (the quote currency of the pair and the product type remain under B6/B8) |
| B4 | Governed mapping path | **closed** (2026-10-19): `etoro / 100001 → ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc`, applied by `human/luc-vorburger` after a read-only dry run with the same parameters; read-only check: 100001 resolves to exactly this instrument, one new event | — |
| B5 | Demo write permission | **closed** (2026-10-19, second `/me` read, about 14:33 UTC, with a new demo user key): `demoRead=true`, `demoWrite=true` through `etoro-public:trade.demo:write`, `realRead=false`, `realWrite=false`. The first read (earlier the same day, previous key) had `demoWrite=false` (section 15). | — |
| B6 | `settlementType` | **decided** (operator, 2026-10-19): the test passes only with open, unique position binding, `settlementType=real`, close and final reconciliation all proved. A missing or other `settlementType` fails the test; a securely bound NEXUS position is still closed through the regular close flow. | the success criterion must be evaluated explicitly (17.6, C1): the reconciliation verdict alone does not carry it |
| B7 | AMBIGUOUS close | accepted (unchanged): stays AMBIGUOUS, no further close, manual UI check | — |
| B8 | Production ETH/USD quote | **closed for the currency** (2026-10-19): production quote, `currency: USD` from the `/cryptocurrencies` reference, 51.7 s old. Freshness must hold again at create and execute (`observedAt` is the last minute candle). | — (refresh the quote right before create and before execute) |

## 10. Tests

| File | What |
|---|---|
| `o22-cycle.test.ts` (24) | Policy; long-only and market-only (sell and MIT refused at creation, at execute and in the reservation table; the close stays possible); full cycle; timeout, AMBIGUOUS, 403; close ambiguity; crash and restart; races; kill switch; product type from the order status |
| `o22-demo-account-safety.test.ts` (14) | Guide formulas; external positions; data holds; decision limits; the hand-opened position blocks the open; the evidence record cites both reports; the source reads once and decides |
| `o22-demo-account-safety-no-evidence.test.ts` (2) | With the evidence record mocked to "not observed": the source answers null and sends nothing; readiness not connected |
| `o22-pnl-valuation-evidence.test.ts` (15) | The `valuationEvidence` of the `/demo/pnl` report (G1, G2); no value, id or key reported |
| `o22-account-safety-cycle.test.ts` (10) | Evidence released for the module only: <ul><li>one GET per evaluation; null on 4xx/5xx, timeout or invalid response;</li><li>risk day start, peak and new day;</li><li>DATA_HOLD not recorded; kill switch;</li><li>the cycle with the real source: open refused with the hand-opened position;</li><li>the position appearing before execute (refused, budget kept);</li><li>a failed read refuses the open;</li><li>the full open; the close without a safety read;</li><li>an ambiguous close is never repeated.</li></ul> |
| `o22-cycle-reconciliation.test.ts` (8), `o22-safety-readiness.test.ts` (5) | Reconciliation and readiness |
| `o22-instrument-metadata.test.ts` (23), `o22-governed-mapping.test.ts` (6), `o22-map-instrument-cli.test.ts` (6) | Metadata read, mapping, tool |
| `o22-test-verdict.test.ts` (12) | C1 (v2 rules): passed only with every proof; dropping any single proof never passes; a non-`real` product type fails and stays failed after the close; position binding from the confirming fill read; rejected / ambiguous open and close; the position observed between the open's submission and the close's fill (missing: incomplete); external activity within the test period (own orders excluded; attribution by the snapshot's storage time); no false failure before attribution; mismatch |
| `o22-review-regressions.test.ts` (27) | Review findings: F1 a proved external order stays failed while the close is in progress; F2 a passed result is historical (no time of reading, nothing after the closing snapshot), the closing snapshot fresh when taken; F3 missing observation is incomplete; F4 `snapshotHistory` order, tie-break, failed syncs, missing records; F5 deterministic order; F6 the confirming fill read is authoritative (missing / contradicted product type, binding from fill reads, invisible confirmation incomplete); F7 partial fills; F10 an unserializable body is refused before fetch, the wire text is the prepared text, the wire `x-request-id` is the stored one; F8 no pacer slot on `REQUEST_NOT_SENDABLE`, a race of two opens for the reservation; second review: N1 closing snapshot and period by storage order, N2 a stated final partial fill stays failed, N4 b held after its gate at the reservation (the refusal comes from the lock), N5 the verdict has no clock and an unserializable body is refused at the service level (APPROVED, nothing spent); third check: D1 a snapshot stored after the closing one cannot prove the position |
| `o22-safe-close-precheck.test.ts` (10) | C2: the close reads no account decision and still goes out once; a failing account source blocks the open, not the close; the close's protections unchanged. C3: an unsendable request is refused before `SUBMITTING` (nothing sent, `APPROVED`, budget unspent); restart and parallel processes on the same stores write exactly once; an unclear send stays AMBIGUOUS and spends the budget. C1 over the real service's state: a full cycle is `passed`, the same verdict after a restart; `cfd` failed before and after the close; a missing product type fails |
| `o22-me-scopes.test.ts` (18) | `/me`: scope names only (no identifier or profile field in the report), demo write only by `demo:write` / `trade.demo:write`, real scopes reported, strict refusals; one fixed GET, no retry on 401/403/429/500, gated (confirmation, demo mode, keys) |
| `test/market-data/o22-twelve-data-crypto-quote.test.ts` (8) | Quote currency: `currency`, ISO `currency_quote`, no translation of stated names, never from the symbol; without a usable reference no currency, and `INSTRUMENT_NOT_USD` |
| `test/market-data/o22-twelve-data-crypto-reference.test.ts` (23) | `/cryptocurrencies`: the live ETH/USD answer resolves to USD with its origin; unique row (none, several, other pairs); unknown names (no near match, no case folding); ISO code; never the symbol or `currency_base`; venue listed; strict parser; reuse within 24 h, concurrent reads shared, a refused read not kept; a stated quote currency never replaced; a contradiction with the instrument currency refused; stocks unchanged; registration through the runtime services records the origin |
| `test/runtime/o22-runtime.test.ts` (9) | The route; the production wiring with recorded evidence (creating an open reads `/demo/pnl` once, the hand-opened position blocks it, 0 writes); an empty account (risk-approved, execute still `EXECUTION_LOCKED_IN_BUILD`); every lock closed |
| `test/pg/o22-cycle-budget.pg.test.ts` (3), `test/pg/o22-account-safety.pg.test.ts` (1) | Budget across pools; a shared risk day across processes and a restart |
| `test/pg/o22-map-instrument.pg.test.ts` (4), `test/pg/o22-registry-inspect.pg.test.ts` (5) | Mapping dry run on a throwaway database (writes nothing); read-only registry inspection |

Results: in the PR description. Local run 2026-10-20 after both review rounds (F1–F10, N1–N7): `npm run typecheck` clean; `vitest --project unit --project pg` 174 files, **3126 tests, all passed** (232 of them in the 21 O22 files). The O20/O21A allowlist tests were updated earlier for the one added operation `identity.me`. After the one-condition fix D1: `npm run typecheck` clean and `vitest --project unit test/broker test/runtime` 810/810; the full suite runs in CI.

## 12. Live observation of a non-empty /demo/pnl (2026-10-18)

### What was run

- Exactly one `GET /api/v1/trading/info/demo/pnl`, approved by the operator. It ran in the operator's session with the existing demo keys, at `f971ea0`.
- Command: `npm run etoro:observe-demo -- --source=pnl --confirm-live-read --pseudonymize-ids --show-instrument-ids`.
- No retry, no fallback, no other endpoint, no order, no mapping, no change of a constant or a lock.
- Evidence: the sanitized report, unchanged, in `docs/evidence/O22_etoro_demo_pnl_observation_2026-10-18.json`. It contains:
  - no value and no key;
  - ids only as per-run HMAC pseudonyms;
  - the instrument id in clear.

### Result

| Item | Report |
|---|---|
| Parser verdict (`parseDemoPnl`, REFERENCE_SCHEMA) | **accepted**: positions 1, orders 0, ordersForOpen 0 |
| `clientPortfolio` keys | All 13 schema keys, including `accountCurrencyId` and the account-level `unrealizedPnL`. None undocumented, none missing. |
| `credit` / `bonusCredit` | positive non-integer number / integer zero |
| Containers | `positions` 1; `mirrors`, `orders`, `ordersForOpen`, `ordersForClose`, `ordersForCloseMultiple`, `stockOrders`, `entryOrders`, `exitOrders` all 0 |
| Position spelling | **Schema spelling** (`positionID`, `instrumentID`, `CID`, `mirrorID`, …). `exampleOnlyPresent` is empty: the reference **example** spelling (`positionId`, flat `pnL`) does **not** occur. |
| Position fields | 36 of the 37 schema fields present. Only `externalOperation` is missing (`documentedMissing`; not read by NEXUS). None undocumented. |
| `unrealizedPnL` (per position) | An **object** holding all 11 schema keys: `pnL`, `pnlAssetCurrency`, `exposureInAccountCurrency`, `exposureInAssetCurrency`, `marginInAccountCurrency`, `marginInAssetCurrency`, `marginCurrencyId`, `assetCurrencyId`, `closeRate`, `closeConversionRate`, `timestamp`. `nested.schemaMissing` and `nested.undocumentedPresent` are both empty. |
| Kinds used by the formulas | `amount`: positive integer. `leverage`: positive integer, as the pnl schema states. `mirrorID` / `parentPositionID`: 0 (not copy trading). `settlementTypeID`: positive, so **not CFD**. |
| Instrument | `[100001]`, the same as in `/demo/portfolio` (O21B, O21C) |

### B2 evidence gaps

**Closed:**
- The **live shape of a non-empty `/demo/pnl`**: the nested `unrealizedPnL`, schema spelling not example spelling. This resolves the schema/example contradiction of O21A.1 for positions.
- Live presence of every input the guide formulas take from **positions**: `amount` (positive) and `unrealizedPnL.pnL` (key present). Also `leverage` (positive integer) for exposure, and `credit` (positive number).
- No copy trading in the account.

**Open after report 1 (the report states keys, not the kinds inside `unrealizedPnL`); G1 and G2 are closed by report 2 below:**
- **G1 – kind of `unrealizedPnL.pnL`.** The parser accepts `pnL` as a finite number **or null**, and the report lists only the key. Whether it was a number is therefore not proved. The safety source would answer a null with `DATA_HOLD`, never zero, but the evidence for "pnL is a number" is missing.
- **G2 – value of `accountCurrencyId`.** The key is present and the parser accepted it as a non-negative integer. The report does not state the value. `1` was observed once before, in an empty `/demo/pnl` (direct GET, O21A.1); in this read it is not shown.
- **G3 – pending orders.** `orders` and `ordersForOpen` (with `totalExternalCosts`) are still not observed non-empty. That is no gap for the cycle: the account limit allows no pending order, so such an order blocks the open.

### Follow-up changes after report 1 (all done)

1. **Observation report, code change. Done.** The `/demo/pnl` report now carries `valuationEvidence` (`valuationEvidenceOf` in `etoro-observation.ts`; tests in `o22-pnl-valuation-evidence.test.ts`):
   - **`unrealizedPnlObject`:** per position, whether `unrealizedPnL` is an object, null, missing or another type.
   - **`pnL`:** the type (number, null, missing, other), the number of finite values, and the sign (positive, negative, zero, not_applicable).
   - **`accountCurrencyId`:** present or not, its JSON kind, and the numeric code when it is a non-negative safe integer.
   - **`checks`:** `allPositionPnlFiniteNumbers` (G1; null without positions) and `accountCurrencyIsUsd` (G2).

   No amount, PnL value, id or key is reported. The portfolio report is unchanged.
2. **One more approved `/demo/pnl` read. Done** (second observation, below).
3. **Evidence record. Done:** `nonEmptyPnlLiveObserved: true`, and `evidenceRef` names both reports.

### Second observation (2026-10-18, G1 and G2)

- **What was run.** Exactly one `GET /api/v1/trading/info/demo/pnl`, approved by the operator, at `b251d34`, with the same command. There was no retry and no other call. The hand-opened position was unchanged.
- **Evidence.** `docs/evidence/O22_etoro_demo_pnl_observation_2026-10-18_2.json`, unchanged and sanitized. The only numbers in it are counts, 0/1 flags and the instrument id 100001.

| Item | Report 2 |
|---|---|
| Parser verdict | **accepted**: positions 1, orders 0, ordersForOpen 0 |
| Keys | the same as report 1; nothing undocumented, nothing missing in `clientPortfolio`, `exampleOnlyPresent` empty |
| `valuationEvidence.unrealizedPnlObject` | object 1, null 0, missing 0, other 0 |
| `valuationEvidence.pnL` | type number 1 (null 0, missing 0, other 0); **finite 1**; sign negative 1 |
| `valuationEvidence.accountCurrencyId` | present, integer, **code 1** |
| `checks` | **`allPositionPnlFiniteNumbers: true` (G1)**, **`accountCurrencyIsUsd: true` (G2)** |

**Valuation inputs.** The inputs `parseDemoPnlValuationInput` reads beyond `parseDemoPnl` are proved by the same reports: `credit` is a positive number, `accountCurrencyId` is the code 1, and `ordersForOpen` is empty, so no external costs are needed. The condition of the evidence record is therefore met.

**Not proved.** A non-empty `orders` or `ordersForOpen` (G3) is still not observed. That is not needed for the cycle: any pending order makes the decision `CAPACITY_BLOCK`.

**Behaviour change.** With `ETORO_DEMO_EXECUTION_ENABLED=1`, creating an intent now makes **one authenticated `/demo/pnl` read**, the safety evaluation of the create gate. Execute is refused by the build lock before its gate runs, so it reads nothing. No other route reads `/demo/pnl`; the cycle status route shows the last evaluation only.

## 14. Instrument identity of 100001 confirmed (B3, 2026-10-18)

### Observation

- **What was run.** Exactly one `GET https://public-api.etoro.com/api/v2/market-data/instruments?instrumentsIds=100001`, approved by the operator.
  - It went through the observation tool: `--source=instrument-metadata --confirm-live-read`, at `b5001bd`.
  - Authorization: the existing key (market-data scope).
  - No retry, no fallback, no portfolio or PnL read.
- **Evidence.** `docs/evidence/O22_etoro_instrument_metadata_100001_2026-10-18.json`, byte-identical with the tool's report (sha256 `3e898fcd9578b862180e7a824c2cde904e44fde64b9dc27454d35b782340528c`).

| Field | Value |
|---|---|
| verdict | **accepted**: exactly one result, for the requested id, with a documented type |
| `instrumentId` | 100001 |
| `type` | **Crypto** |
| `symbol` | **ETH** |
| `displayName` | **Ethereum** |

**B3 is confirmed** for the identity: eToro instrument 100001 is Ethereum, type Crypto. It agrees with the operator's UI comparison (O21B) and with the arithmetic of the observed position.

**Still to verify separately.** The metadata names the asset, not the pair or the execution:
- The quote currency of eToro's ETH price. `openRate` is "in the instrument's currency" and the payload states no currency. NEXUS maps 100001 to a **USD** instrument because eToro orders are in USD and the account currency is USD (G2). That ETH is quoted in USD at eToro is an assumption, not proved by this read.
- The product type of a NEXUS order: `settlementType` is not sent; it is verified after the fill (B6).

### Mapping dry run (B4); no write

- **The real tool, as requested.** `npm run etoro:map-instrument -- --instrument-id=… --metadata-report=docs/evidence/O22_etoro_instrument_metadata_100001_2026-10-18.json --valid-from=… --operator=…` without `--apply`. On 2026-10-18 it ended with `MAPPING_FAILED: the registry could not be opened or written` (no database). On 2026-10-19, against the local registry through the read-only path, it ends with `MAPPING_INSTRUMENT_INVALID` because no ETH/USD instrument exists (section 15); nothing was written.
- **The same dry run on a throwaway PostgreSQL** (`test/pg/o22-map-instrument.pg.test.ts`, with a TEST ETH/USD instrument and the real evidence file). It plans exactly:
  - `{ instrumentId: <NEXUS ETH/USD>, provider: 'etoro', providerSymbol: '100001', providerInstrumentId: '100001', validFrom: <the human's instant> }`;
  - `by: { kind: 'human', id: <operator> }`;
  - reason: `O22 governed eToro mapping by a named human; evidence 3e898fcd… (type Crypto, symbol ETH)`.

  It writes no event. Without an ETH/USD instrument it refuses (`MAPPING_INSTRUMENT_INVALID`) and creates none. An instrument that already has an eToro mapping is refused (`MAPPING_CONFLICT`).

### Existing registry entries

On 2026-10-18 the registry could not be checked (no database reachable). **Superseded by section 15:** on 2026-10-19 the local NEXUS database was read read-only; it held **no instrument**. ETH/USD was then registered once (`ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc`, section 15); the governed eToro mapping 100001 → this instrument was applied after a dry run. The repository contains **no** ETH instrument either (only TEST ETH/USD fixtures in tests). The mapping tool refuses a second eToro mapping, and the registry refuses a second mapping of the same Twelve Data symbol in an overlapping period, so a duplicate cannot be written either way.

### Missing before the mapping can be applied

1. **Look up or create the NEXUS ETH/USD instrument in the operator's registry.**
   - With `DATABASE_URL`: list the instruments and look for `crypto` / `ETH/USD`.
   - If there is none: `POST /api/instruments/register` with Twelve Data `ETH/USD`.
   - Twelve Data's symbol search returns no currency for `ETH/USD` (observed 2026-10-19); the currency comes from the `/cryptocurrencies` reference (section 15).
2. **Requirements for the mapping:** the instrument must be `crypto`, `USD` and active.
3. **The governed mapping:** a dry run with `DATABASE_URL`, then `--apply --confirm-human-mapping`. That is a human decision.

### Risks

- **The hand-opened ETH position.**
  - After the mapping, the O20 sync maps it to ETH/USD. The ledger reconciliation then reports `missing_in_ledger` for it (not a NEXUS booking; nothing is booked).
  - The cycle reconciliation identifies by `positionID` and keeps it **external**.
  - The demo account safety counts it in exposure and positions, so every cycle open stays `CAPACITY_BLOCK` until the operator closes it in the UI.
  - NEXUS never closes it. A buy while it exists would also put two ETH positions in the account, which the identification by `positionID` keeps apart.
- **The ETH/USD quote (B8).**
  - The gate needs a production quote at create **and** at execute, no older than 60 s, with `currency: 'USD'`.
  - The Twelve Data crypto quote does not state its currency (observed 2026-10-19). It now comes from the `/cryptocurrencies` reference (section 15); without a usable reference the gate refuses (`INSTRUMENT_NOT_USD`).
  - Twelve Data's ETH/USD (an exchange or aggregate price) is not eToro's execution price. The order is by **amount**, so the quote only checks freshness and sanity; the units come from eToro.
- **Currency assumption.** If eToro's ETH were not quoted in USD, `openRate` and the units/rate arithmetic would not be USD. The valuation does not depend on it: `amount` and `pnL` are in the account currency, USD (G2).

## 15. Registry, database and ETH/USD market data (B4, B8)

### Database status (2026-10-19, read-only check before the registration; superseded where the registration below changed it)

The operator has since set up the local NEXUS database (PostgreSQL 17 on loopback, database `nexus`, an application role and a read-only role, passwords only in the user's `pgpass.conf`). It was read with the read-only role and `default_transaction_read_only=on`; no credential was printed, no migration was run and no database was created.

| Check | Result |
|---|---|
| Migrations | `schema_migrations` holds versions 1–13; each checksum equals the sha256 of the file in `db/migrations` at `141a479`. Nothing pending. |
| Instruments | **0** rows in `instruments`, `instrument_events` and `provider_instrument_mappings`. |
| `npm run registry:inspect -- --symbol=ETH --etoro-instrument-id=100001` | `instrumentCount: 0`, no match, eToro 100001 `resolvesTo: null`. |
| ETH/USD instrument | **does not exist**: it must be registered once. |
| Twelve Data mapping for ETH/USD; eToro mapping for 100001 | **none** |
| Mapping dry run (read-only path) | `MAPPING_INSTRUMENT_INVALID`; afterwards still 0 instruments, 0 mappings, 0 log rows |
| `TWELVE_DATA_API_KEY` | **not set** in the process, user or machine environment, and not in a `.env`. Registration and the quote check therefore were **not** run (B8). |
| `NEXUS_OPERATOR_ID` | **not set**: `operatorAuth: not_configured`. |

A local runtime start (loopback, `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`, eToro and Twelve Data not configured) answered:
- `/api/health`: database connected, market data not configured, live trading locked, all four `buildLocks` `true`;
- `/api/safety/status`: kill switch ARMED, `canIncreaseRisk: false`, `liveTradingAllowed: false`;
- `/api/broker/etoro/demo/cycle`: execution disabled, `buildLocked: true`, safety readiness not connected, `valuationEvidence: verified`.

Its bootstrap created the two empty log heads `instruments` and `portfolio-kill-switch` (sequence 0, no record). Nothing else was written: no instrument, mapping, ledger row, intent or order, and no eToro or Twelve Data request was sent.

### Database status (2026-10-18, superseded)

- No authorized database access:
  - `DATABASE_URL` and `PG*` are not set (neither process nor user scope);
  - no PostgreSQL listens on the usual local ports, and no postgres process runs.
- The runtime reads the database only from `DATABASE_URL` (README); there is no other configured connection.
- Foreign `.env` files were not opened.
- No database was created, and no throwaway test database is presented as the registry.
- **The operator's registry was therefore not read.** Whether ETH/USD exists there, is active, crypto and USD, or has an eToro or Twelve Data mapping is **unknown**. The repository holds no ETH instrument.

### New: strictly read-only inspection

- **`PostgresAppendOnlyStore.openReadOnly`.** Opening it writes nothing; `open` inserts a log row, this does not. Every append is refused before any statement.
- **`npm run registry:inspect -- --symbol=ETH --etoro-instrument-id=100001`** (`src/market-data/registry-inspect-cli.ts`).
  - The session is opened with `default_transaction_read_only=on`, so PostgreSQL itself refuses any write, and the read-only store is used.
  - Per match it prints: id, symbol, name, asset class, currency, active, exchange, time zone, calendar, all mappings, and the checks `crypto`, `quotedInUsd`, `symbolIsEthUsd`, `openEtoroMapping`, `openTwelveDataMapping`. It also prints what eToro 100001 resolves to.
  - It never prints `DATABASE_URL` or a key.
  - The base currency (ETH) is not a registry field and is **not** derived from the symbol; `symbolIsEthUsd` only compares the stored symbol.
- **`etoro:map-instrument` without `--apply`** now uses the same read-only path. Before, the dry run opened the log with `open`, which inserts an `append_only_logs` row if missing. Now a dry run writes nothing at all (PostgreSQL test). Only `--apply --confirm-human-mapping` opens for the one append.

### ETH/USD quote and currency (B8)

**Integration as built.**
- `TwelveDataMarketDataProvider.getQuote` reads `GET /quote?symbol=ETH/USD`. It refuses a quote for another symbol.
- `observedAt` is `last_quote_at` (else `timestamp`), the start of the last minute candle. The demo gate needs it ≤ 60 s old, from a production source, at create and at execute.

**What Twelve Data states (production, 2026-10-19).**
- `/symbol_search?symbol=ETH/USD`: three rows (Binance, Huobi, Bitfinex), `Digital Currency`, time zone UTC, **no currency**. The registration therefore refused ETH/USD (`instrument metadata is incomplete or invalid`, HTTP 502 at the route), before any write.
- `/quote?symbol=ETH/USD`: production, fresh, but `currency`, `currency_base` and `currency_quote` are **all absent**. The gate would refuse every quote with `INSTRUMENT_NOT_USD`.
- `/cryptocurrencies?symbol=ETH/USD` (documented reference for crypto pairs: `currency_base` / `currency_quote` are **names**, documented example "Bitcoin" / "US Dollar"; 1 API credit): `status: ok`, **exactly one row**, `symbol: ETH/USD`, `currency_base: "Ethereum"`, `currency_quote: "US Dollar"`, `available_exchanges: Binance, Bitfinex, Huobi`. Evidence: `docs/evidence/O22_twelvedata_cryptocurrencies_ETH_USD_2026-10-19.json` (the full answer; it holds no key).

**The currency of a crypto pair from the reference (`twelve-data-crypto-reference.ts`).**
- **Used only when nothing is stated.** A quote that states `currency` or an ISO `currency_quote` keeps it; two different stated codes stay a schema error. A stated value that is not an ISO code (for example "US Dollar" in the quote) is not translated and **not** replaced by the reference (`STATED_CURRENCY_NOT_ISO`). Only a crypto quote that states no currency at all reads the reference; other asset classes are unchanged. At registration, only a crypto search row without currency reads it.
- **Unique row.** Exactly one row whose `symbol` is the requested provider symbol; none is `NO_REFERENCE`, several are `AMBIGUOUS_REFERENCE`. A known venue (the mapping's exchange) must be in `available_exchanges`, else `EXCHANGE_NOT_LISTED`.
- **Only `currency_quote`, and only explicitly.** An ISO code is used as it is (`rule: iso_code`). A name is used only through the frozen table `twelvedata-currency-names:v1` = `{ "US Dollar": "USD" }`; any other name is `UNKNOWN_CURRENCY_NAME` (no near match, no case folding). The symbol, `currency_base` and the instrument's display name are never read for a currency.
- **Contradiction.** A reference currency that differs from the registered instrument's currency is a schema error; the quote is refused.
- **Origin.** The quote and the registration candidate carry `currencyOrigin`: `{ kind: 'reference', source: 'twelvedata:/cryptocurrencies#currency_quote', stated: 'US Dollar', rule: 'twelvedata-currency-names:v1', retrievedAt }` (or `stated` with the field, or `unresolved` with the reason). `/api/market/quote` reports `currency` and `currencyOrigin` for the quote it just fetched. The registry event of a registration names the origin in its reason. The origin is not part of the quote's content hash and is not stored with the quote: `market_quotes` has no column for it, and no migration is added.
- **API limits.** One reference read per symbol is reused for 24 h (`CRYPTO_REFERENCE_TTL_MS`) by the provider instance; concurrent callers share one read; a failed read is not kept. A failed or refused reference read leaves a quote without currency (`REFERENCE_UNAVAILABLE`, the gate refuses); at registration it fails the registration.

### ETH/USD registered, quote checked, mapping dry run (2026-10-19)

The worktree `.env` (ignored by Git, readable only by the operator) holds the existing `DATABASE_URL`, the operator's `TWELVE_DATA_API_KEY`, `NEXUS_OPERATOR_ID=luc-vorburger` and a random 64-hex `NEXUS_OPERATOR_TOKEN`. The runtime ran on loopback with `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`, eToro not configured, every build lock `true`.

| Step | Result |
|---|---|
| Registry before | read-only: 0 instruments |
| `POST /api/instruments/register` `{ "providerSymbol": "ETH/USD", "validFrom": "2026-10-19T11:27:45.000Z" }` (once) | HTTP 201: **`ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc`**, `ETH/USD`, "Ethereum US Dollar", `crypto`, **`USD`**, time zone UTC, exchange Binance (the first search row), active. `currencyOrigin`: reference, "US Dollar", `twelvedata-currency-names:v1`, read at 11:27:45.966Z. |
| Registry after | read-only `registry:inspect`: 1 instrument; checks `crypto: true`, `quotedInUsd: true`, `symbolIsEthUsd: true`, open Twelve Data mapping `ETH/USD @ Binance`, open eToro mapping none. The event `instrument_registered` (by `system/nexus-runtime`) names the currency origin. |
| `GET /api/market/quote?instrumentId=ins_adcd4ec5-…` | `source: twelvedata:quote:production`, last 2418.71, **`currency: USD`** (origin: the same reference read, no second `/cryptocurrencies` request), `observedAt` 11:27:00Z, `retrievedAt` 11:27:51.681Z: **51.7 s old** (≤ 60 s), `usableForTrading: true`. One quote row stored. |
| Mapping dry run (read-only role, `default_transaction_read_only=on`) | `npm run etoro:map-instrument -- --instrument-id=ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc --metadata-report=docs/evidence/O22_etoro_instrument_metadata_100001_2026-10-18.json --valid-from=2026-10-19T11:28:13.000Z --operator=luc-vorburger`: `mode: dry_run`, mapping `{ instrumentId: ins_adcd4ec5-…, provider: etoro, providerSymbol: 100001, providerInstrumentId: 100001, validFrom: 2026-10-19T11:28:13.000Z }`, `by: human/luc-vorburger`, `reportSha256: 3e898fcd…340528c`. Afterwards still exactly 1 mapping (Twelve Data) and 1 log record. |
| Not done | no mapping apply, no eToro request, no order, no ledger booking; build locks, risk limits and kill switch unchanged (kill switch log at sequence 0). |

**Freshness note.** `observedAt` is the start of the last minute candle, so a quote is between 0 and about 60 s old when fetched, and older afterwards. The gate's 60 s limit is not relaxed: the quote must be refreshed right before create and right before execute, and a refusal for staleness is expected behaviour, not a fault.

### Planned mapping (applied 2026-10-19, below)

- **Evidence:** `docs/evidence/O22_etoro_instrument_metadata_100001_2026-10-18.json` (sha256 `3e898fcd…340528c`): 100001, Crypto, ETH, Ethereum.
- **Plan:** `etoro / 100001 / 100001 → ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc`, `validFrom` set by the human, actor `human/luc-vorburger`, no exchange.
- **Conditions:** It needs an existing, active, crypto, USD instrument (met). It refuses a duplicate and never creates an instrument.

### Governed eToro mapping applied (2026-10-19)

Approved by the operator only for eToro 100001 → `ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc`, operator `luc-vorburger`, evidence `docs/evidence/O22_etoro_instrument_metadata_100001_2026-10-18.json`.

| Step | Result |
|---|---|
| Registry before (read-only) | 1 instrument `ins_adcd4ec5-…`: active, `crypto`, `USD`; mappings: Twelve Data `ETH/USD @ Binance` only; no eToro mapping; eToro 100001 resolves to nothing; log `instruments` at sequence 1. |
| Evidence | sha256 `3e898fcd9578b862180e7a824c2cde904e44fde64b9dc27454d35b782340528c`, unchanged against the commit. |
| `validFrom` | fixed once: `2026-10-19T11:47:36.000Z` |
| Dry run (read-only role, `default_transaction_read_only=on`) | exit 0, `mode: dry_run`, `{ instrumentId: ins_adcd4ec5-…, provider: etoro, providerSymbol: 100001, providerInstrumentId: 100001, validFrom: 2026-10-19T11:47:36.000Z }`, `by: human/luc-vorburger`, the evidence sha256 |
| Apply (application role from the worktree `.env`, the same parameters + `--apply --confirm-human-mapping`) | exit 0, `mode: applied`, the identical mapping |
| Registry after (read-only) | `registry:inspect`: eToro 100001 `resolvesTo: ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc`; checks `openEtoroMapping: 100001`, `openTwelveDataMapping: ETH/USD @ Binance`; 2 mappings in total (no exchange on the eToro one). |
| Events | log `instruments` at sequence 2: exactly one new record, `mapping_added`, by `human/luc-vorburger`, reason `O22 governed eToro mapping by a named human; evidence 3e898fcd… (type Crypto, symbol ETH)`. Still 1 instrument, 0 ledger transactions; the kill switch log at sequence 0. |

### eToro demo configuration and write scope (2026-10-19)

- **eToro keys and switches: not configured on this machine.** The worktree `.env` has no `ETORO_*` line, and neither the process nor the user or machine environment holds `ETORO_API_KEY`, `ETORO_USER_KEY`, `ETORO_ENABLED`, `ETORO_TRADING_MODE` or `ETORO_DEMO_EXECUTION_ENABLED`. The earlier reads ran in the operator's own session.
- **Operator auth: configured** (`NEXUS_OPERATOR_ID`, `NEXUS_OPERATOR_TOKEN`).
- **`/me` scopes, before the read: no evidence.** `docs/evidence` held the portfolio, `/demo/pnl` and metadata reports only; no `/me` result or scope list existed in the repository or `C:\NEXUS\setup`.
- **Afterwards:** the operator entered the demo keys into the worktree `.env` (`ETORO_ENABLED=1`, `ETORO_TRADING_MODE=demo`, `ETORO_DEMO_EXECUTION_ENABLED=0`).

### `/me` scope checks (B5, 2026-10-19)

#### First check (historical finding: previous user key)

- **What was run.** Exactly one `GET /api/v1/me`, approved by the operator: `npm run etoro:observe-demo -- --source=me --confirm-live-read`, at `1efd532`. Exit 0, verdict `accepted`, no retry, no other call. Only the scope names and the checks were reported; no key, header, account id or raw response was printed or stored.
- **Granted scopes:**
  - `etoro-public:market-data:read`
  - `etoro-public:money.balance:read`
  - `etoro-public:money.cash-transactions:read`
  - `etoro-public:trade.demo:read`
  - `etoro-public:user-info:read`

| Check | Result |
|---|---|
| `demoRead` | **true** (`trade.demo:read`) |
| `demoWrite` | **false**: neither `etoro-public:demo:write` nor `etoro-public:trade.demo:write` |
| `realRead` | **false** |
| `realWrite` | **false** |

**Finding then: B5 confirmed as a blocker.** The key pair matched the reads made so far (portfolio, `/demo/pnl`, metadata) but could not place a demo order. The write permission is set when a user key is created, so the operator created a new demo user key with write permission and entered it into the worktree `.env`.

#### Second check (new demo user key): B5 closed

- **What was run.** Exactly one `GET /api/v1/me`, approved by the operator, at about 14:33 UTC on 2026-10-19 (`358609d`), with the same command. Before it, a check without output of values: both keys present once, well-formed and distinct; `ETORO_TRADING_MODE=demo`, `ETORO_DEMO_EXECUTION_ENABLED=0`. Exit 0, verdict `accepted`, no retry, no other call. Only scope names and checks were reported; nothing was stored.
- **Granted scopes:**
  - `etoro-public:market-data:read`
  - `etoro-public:money.balance:read`
  - `etoro-public:money.cash-transactions:read`
  - `etoro-public:trade.demo:read`
  - `etoro-public:trade.demo:write` (new)
  - `etoro-public:user-info:read`

| Check | Result |
|---|---|
| `demoRead` | **true** |
| `demoWrite` | **true**, through `etoro-public:trade.demo:write` |
| `realRead` | **false** |
| `realWrite` | **false** |

**B5 is closed.** The key pair may trade on the demo account and holds no real-account scope. This releases nothing: `BUILD_LOCKS.etoroDemoExecution` still refuses every demo write, and `ETORO_DEMO_EXECUTION_ENABLED=0`.

### Remaining before the controlled demo test

1. **eToro demo configuration. Done** (2026-10-19): the demo keys and `ETORO_ENABLED=1`, `ETORO_TRADING_MODE=demo`, `ETORO_DEMO_EXECUTION_ENABLED=0` are in the worktree `.env`.
2. **B5, write scope. Closed** (second check above). The read path is the observation tool, `--source=me` (O22): the fixed operation `identity.me` (`GET /api/v1/me`, documented as the first call with a key pair; `scopes` is the array of granted scopes, `etoro-public:demo:write` includes `trade.demo:write`). The report (`etoro-me-scopes.ts`) keeps only the scope names, checked against a strict pattern, and `demoWrite`, `demoRead`, `realWrite`, `realRead`; no identifier, name or profile field. No retry. Tested in `o22-me-scopes.test.ts` (18). The first read gave `demoWrite=false`; after a new demo user key the second gave `demoWrite=true` and `realWrite=false`. A change of keys needs a new check.
3. **B2, account. Closed** (2026-10-19): the operator closed the hand-opened position in the eToro UI; a read-only `/demo/pnl` read shows no position and no order (section 9).
4. **B6. Decided** (2026-10-19): `settlementType=real` is part of the success criterion (17.2).
5. **B1, release.** A separate reviewed change opens `BUILD_LOCKS.etoroDemoExecution`; `TRADING_MODE=paper` and `ALLOW_LIVE_TRADING=false` stay.
6. **The cycle (section 8, from step 6).** Sync and cycle status; quote refreshed right before create and before execute; one open, one close; no ledger booking.

## 16. Safety boundaries (unchanged)

- `BUILD_LOCKS` = `{ liveTrading, brokerOrders, physicalPurchase, etoroDemoExecution }`, all `true`.
- `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`.
- No real endpoint and no real key path.
- No autonomous cycle.
- No ledger booking and no balancing booking; the valuation log is not a ledger.
- No automatic mapping and no automatic close of the hand-opened position.
- No eToro request was made while building O22.

## 17. Final review of PR #25 and the first demo cycle (prepared, not executed)

Nothing in this section has been run. It prepares the review and the one controlled cycle. No order, no position close, no merge, no release.

### 17.1 Review readiness

| Item | State (2026-10-19) |
|---|---|
| Base | `519233d` = `origin/main`; no rebase needed. |
| Scope | 18 commits, 61 files, +5773 / −54 lines (about 1600 in `src`, the rest tests, docs and evidence). |
| Local tests | at `1efd532` (code unchanged since; later commits are docs only): `npm run typecheck` clean; `vitest --project unit --project pg` 171 files, 3078 tests, all passed. |
| CI | green at every pushed head, last at `899901a`. |
| Locks | `BUILD_LOCKS` all `true` (`src/nexus/safety.ts`), asserted by `o22-runtime.test.ts`; `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`. Merging opens nothing. |
| Production state prepared | ETH/USD `ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc` registered; eToro 100001 mapped to it; quote currency USD from the reference; demo key with `demoWrite=true`, `realWrite=false`. |

**Where a reviewer should look (by risk):**
1. `execution/execution-gate.ts`: `DEMO_E2E_CYCLE_POLICY` v2 (100 USD, leverage 1, one position, 1 open + 1 close submission, buy and `mkt` only); the book checks `cycleOpenBudget`, `cycleCloseBudget`, `openSide`, `openOrderType`; `policyVersion` from the policy.
2. `execution/etoro-demo-execution-service.ts`: the reservation precondition re-runs `bookRefusals` inside the intent log's critical section before `SUBMITTING`; the budget counts every intent that reached `SUBMITTING`, whatever followed.
3. `execution/demo-account-safety.ts`, `demo-account-evidence.ts`: one `/demo/pnl` read per evaluation, never retried; fail-closed valuation (DATA_HOLD, never zero); the whole account counted, external positions included; limits as code constants.
4. `execution/demo-cycle-reconciliation.ts`: identification by `positionID`; the hand-opened position stays external.
5. `etoro-readonly.ts`: the GET allowlist is now `portfolio.demo`, `pnl.demo`, `instrument.metadata.100001`, `identity.me`; the observation tool and its reports (`etoro-observation.ts`, `etoro-instrument-metadata.ts`, `etoro-me-scopes.ts`) keep no key, id or personal field.
6. `market-data/providers/twelve-data-crypto-reference.ts` and `twelve-data.ts`: the reference currency only when nothing is stated; reviewed name table; contradictions refused.
7. `etoro-instrument-mapping.ts`, `etoro-map-instrument-cli.ts`, `registry-inspect-cli.ts`: the dry run and the inspection are read-only at the database (`default_transaction_read_only=on`).

**Known review points:**
- **R1 Naming.** The other package "O22 OpenAI shadow provider" (`014_model_run_usage.sql`) is no longer a local worktree and not on `origin`; it exists only as `local-backup/feature/o22-openai-shadow-provider-v1`. This PR adds no migration, so there is no file conflict; the package numbering should still be settled before that branch is revived.
- **R2 PR description.** It predates the later commits and could not be edited from this machine (no `gh`); an update text is supplied with the review.
- **R3 Currency origin.** `currencyOrigin` is reported by `/api/market/quote` and in the registry event, but not stored with the quote (no column, no migration).
- **R4 Quote freshness.** The gate reads the latest **stored** quote; `observedAt` is the start of the last minute candle. The quote must be fetched right before create and right before execute; a stale refusal is expected behaviour.
- **R5 Venue.** The registration took the first search row (Binance); the Twelve Data price is a check of freshness and sanity only, the order is by amount and eToro sets the units.
- **R6 External position.** With the mapping in place, a sync reports the hand-opened ETH position as `missing_in_ledger` (a report, not a booking) until it is gone.
- **R7 Cosmetic.** Section numbers 11 and 13 are unused.

### 17.2 Open items and decisions

- **B2, external ETH demo position: closed (2026-10-19).** The operator closed it in the eToro UI. One read-only `GET /demo/pnl` afterwards (observation tool, no write): 0 positions, all order containers empty, account currency USD. Nothing in the account blocks the test; available cash is checked by the safety source at creation.
- **B6, product type after the fill: decided (operator, 2026-10-19).** **Success criterion of the whole test:** proved open (`FILLED`), unique position binding (exactly one broker-confirmed position), `settlementType=real` from the order status of the open, proved close (`FILLED`), and a final reconciliation `consistent` with `close_confirmed` on a snapshot taken after the close. A missing or other `settlementType` means **the test is not passed**. A securely bound NEXUS demo position is nevertheless closed through the regular close flow (steps 8–9); no protection is bypassed and nothing is retried.
- **B1, build lock: stays closed.** `BUILD_LOCKS.etoroDemoExecution = true`, `ETORO_DEMO_EXECUTION_ENABLED=0`. The release is a separate reviewed change (proposal: `docs/O22_DEMO_RELEASE_PROPOSAL.md`), after the human review of this PR including C1–C3.

### 17.3 Runbook of the first demo cycle (only after B2, B6 and B1)

**Operating rules (operator, 2026-10-19):**
- **No parallel manual trades** in the demo account from step 2 to step 9. Any other position or order seen in that window fails the test (`EXTERNAL_ACTIVITY`).
- **More than one position from one fill:** the test is failed; the manual clarification of 17.5 applies.
- **Stale quote:** fetch it again and re-check, **at most three times per step**; then stop the step. No endless loop, and the 60 s limit is never relaxed. A refused execute sends nothing and spends no budget; a new intent after `expiresAt` is allowed.
- **Product type other than `real` (or none stated):** the test is failed; the securely bound position is still closed through the regular flow (steps 8–9).
- **Closing deadline (N3):** the closing sync (step 9) must be **observed within 5 minutes after the close is recorded `FILLED`** and stored within 5 minutes after it started. If that is missed (for example a failed sync and a wait), the test stays `incomplete` with `FINAL_SNAPSHOT_NOT_IN_TIME` **for good**: it can no longer pass. Retry a failed closing sync at once, at most three times.
- **One machine, one clock (N7):** the runtime and every sync of the cycle run on this one machine. The test verdict compares the storage time of a snapshot with the submission time of an intent; both come from the same clock only then.

**Preconditions (all, else no start):** PR #25 reviewed; C1–C3 in the build (done on the O22 branch); the release change for B1 reviewed and in the build; B2 confirmed again by step 2; the worktree `.env` with the demo keys of the second `/me` check, `ETORO_ENABLED=1`, `ETORO_TRADING_MODE=demo`, `ETORO_DEMO_EXECUTION_ENABLED=1`; `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`; the runtime on loopback. Every `POST` intent route needs `Authorization: Bearer <NEXUS_OPERATOR_TOKEN>`; the token is read from the `.env` and never printed.

| # | Step | Expect | STOP when |
|---|---|---|---|
| 1 | `GET /api/health` | database connected, market data configured, `liveTrading` locked, `buildLocks` as released (only `etoroDemoExecution` changed) | any other lock open, or live trading not locked |
| 2 | `POST /api/broker/etoro/sync`, then `GET /api/broker/etoro/demo/cycle` | policy `etoro-demo-e2e-cycle-policy:v2`, budget open 0/1, close 0/1; no position, no pending order; reconciliation without external positions | any position or order in the account, or a spent budget |
| 3 | `GET /api/market/quote?instrumentId=ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc` | `currency: USD`, production source, `observedAt` ≤ 60 s old | no USD or not production: stop. Older than 60 s: fetch again, at most three times in this step, then stop |
| 4 | `POST /api/broker/etoro/demo/intents` with the open below | 201, `RISK_APPROVED` (creation reads `/demo/pnl` once for the safety decision) | `REJECTED`: read `gateReasons`, stop |
| 5 | `POST …/intents/{openId}/approve` | `APPROVED` by `luc-vorburger` | anything else |
| 6 | step 3 again, then `POST …/intents/{openId}/execute` **once** | `SUBMITTED` | `REJECTED`: stop (budget spent, the cycle is over). `AMBIGUOUS`: only `refresh`, never execute again. `GATE_REFUSED` (e.g. stale quote, or `REQUEST_NOT_SENDABLE`): nothing was sent and no budget spent; for a stale quote refresh and retry at most three times in this step, otherwise stop; never past `expiresAt`. |
| 7 | `POST …/intents/{openId}/refresh` until `FILLED`; then sync and cycle | exactly one `brokerPositionIds` entry; `brokerSettlementType` = `real`; reconciliation verdict `consistent`, item `open_position_confirmed` | `brokerSettlementType` missing or not `real`: **the test is failed**, but do **not** stop: continue with step 8 to close the securely bound position. More than one `brokerPositionIds` entry: stop and follow 17.5 (A3); verdict `inconsistent` (`open_position_missing`, `position_mismatch`); verdict `unknown` (`snapshot_predates_intent`, `outcome_pending`): one more sync, then stop if unchanged |
| 8 | `POST /api/broker/etoro/demo/intents` with the close below, `approve` (a new approval), `execute` **once**, `refresh` until `FILLED` | `SUBMITTED`, then `FILLED`; **the 5-minute closing deadline starts now** | `AMBIGUOUS`: no further close; check the eToro UI by hand |
| 9 | sync **within 5 minutes of the close's `FILLED`**, then cycle | verdict `consistent`, item `close_confirmed` on a snapshot after the close, budget open 1/1, close 1/1; every further write refused. **Test passed only if** `cycle.test.result` is `passed` (C1); `failed` names the broken criterion; `incomplete`: one more sync inside the deadline, then stop (`FINAL_SNAPSHOT_NOT_IN_TIME` is terminal) | verdict `inconsistent` (`closed_position_still_open`) or `unknown` after one more sync |
| 10 | afterwards | `ETORO_DEMO_EXECUTION_ENABLED=0`; the build lock closed again by a reviewed change; the result (passed / failed, with the failed criterion) documented with sanitized evidence | — |

**The open intent** (times: canonical UTC, `expiresAt` at most 15 minutes after `createdAt`, e.g. 10):
```json
{ "action": "open", "instrumentId": "ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc", "etoroInstrumentId": 100001,
  "side": "buy", "orderType": "mkt", "amount": "100", "currency": "USD", "leverage": 1,
  "strategyRunId": "o22-demo-cycle-1", "createdAt": "<UTC now>", "expiresAt": "<UTC now + 10 min>" }
```

**The close intent** (the same side as the open; no amount: the whole position):
```json
{ "action": "close", "instrumentId": "ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc", "etoroInstrumentId": 100001,
  "side": "buy", "orderType": "mkt", "currency": "USD", "leverage": 1, "closesIntentId": "<openId>",
  "strategyRunId": "o22-demo-cycle-1", "createdAt": "<UTC now>", "expiresAt": "<UTC now + 10 min>" }
```

No ledger booking at any step. NEXUS never touches a position it did not open (the hand-opened one was closed by the operator on 2026-10-19, B2).

### 17.4 Review result (2026-10-19, code reviewed at `74aaf90`)

**Scope note.** This review covers the code at `74aaf90` and the comment fixes S1–S3. The changes C1–C3 (17.6) were made after it, on request; they are covered by targeted tests and a full local run (3100/3100), but they have **not** been through an independent review yet and are part of the human review of this PR.

**Method.** The safety-critical paths were read in full at the current head: `execution-gate.ts`, `etoro-demo-execution-service.ts`, `demo-account-safety.ts`, `demo-cycle-reconciliation.ts`, the demo execution adapter, transport and endpoints, `append-only-log.ts` and the PostgreSQL store's `writeExclusive`, `runtime/compose.ts`, `runtime/config.ts`, `demo-execution-sources.ts`, the sync adapter; the tests of each property were matched to it.

**Tests.** `npm run typecheck` clean. `vitest --project unit --project pg`: 171 files, 3078 tests, **3077 passed, 1 failed**. The failure is a 5 s timeout (5.9 s) in `test/patterns/v1c-regression.test.ts` ("V1B instance-id golden"), a file this PR does not change; the whole run was slow (the PostgreSQL files took up to 190 s each). Run alone it passed twice (about 2.2 s). Suspected cause: machine load during that run (the run was markedly slower than earlier ones); the cause is not proven. The earlier full run at `1efd532` (same code) passed 3078/3078. CI is green at every pushed head. The later commits of the review (S1–S3) change comments only; for them only `npm run typecheck` was run (clean), not the full suite again.

| Property | Result | Where |
|---|---|---|
| At most one open and one close, durably | **Holds.** The budget is derived from the persistent intent log (every intent that reached `SUBMITTING`, whatever followed) and checked by the gate and again in the reservation precondition inside the log's critical section; the PostgreSQL store serializes appends with `SELECT … FOR UPDATE` on the log head and applies newer records before the precondition runs. Not resettable by configuration. | `execution-gate.ts` L175–176, `etoro-demo-execution-service.ts` L342–355 and L740–742, `append-only-log.ts` L176–186, `postgres-append-only-store.ts` L52–65; tests `o22-cycle.test.ts`, `test/pg/o22-cycle-budget.pg.test.ts` |
| Safety re-checked before execution and reservation | **Holds, with one documented gap (A1).** `execute` re-runs the full gate with a fresh `/demo/pnl` decision, a fresh stored quote, the kill switch and the mapping; the reservation re-runs the book checks (budget, side, order type, exposure, positions, ambiguity, duplicates). The account decision itself is not re-read inside the critical section. A local database lock cannot make manual broker activity atomic with the NEXUS write in any case: the eToro account is changed outside NEXUS, so an order placed by hand between the gate and the reservation (or after it) is not prevented, only detected afterwards (C1, `EXTERNAL_ACTIVITY`). | `etoro-demo-execution-service.ts` L331–355, L759–787; test "the position appears between approval and execute" |
| Timeout, restart, concurrency | **Holds.** Writes are never retried (`etoro-demo-execution-transport.ts`); a timeout, 5xx or unreadable answer is AMBIGUOUS and spends the budget; an AMBIGUOUS open is resolved only by positive evidence found by its `x-request-id`; an AMBIGUOUS close is never reconciled or resent; a crash after `SUBMITTING` becomes AMBIGUOUS after 30 s; the same approved intent executed twice at once writes once (fixed record ids). | adapter L131–150, service L404–447; tests "times out", "crashed after SUBMITTING", "executed twice at once", pg "two processes", "restarted process" |
| Unique position binding, external positions | **Holds.** A close needs `closesIntentId` of a FILLED NEXUS open on the same instrument and side with **exactly one** position confirmed by an eToro order status read; the position id never comes from a request. A hand-opened position can therefore never be closed by NEXUS; the account safety counts it fully and the cycle reconciliation reports it as external. | service L534–561, L723–730; `demo-cycle-reconciliation.ts`; `demo-account-safety.ts` L104 |
| Currency, freshness, demo/real separation | **Holds.** Open needs a stored production quote ≤ 60 s old and `currency` and instrument currency both `USD`; the crypto currency comes only from the reviewed reference rule. Config refuses `ETORO_TRADING_MODE=real` before anything else and needs `demo` for execution; every execution path is built from fixed `/demo/` segments; the GET allowlist has no real path; the key has no real scope (`/me`). | `execution-gate.ts` L249–260, `twelve-data.ts` getQuote, `config.ts` L123–146, `etoro-demo-execution-endpoints.ts` L14–34 |

**Merge blockers.** None in the code. Before merge (process):
- **M1 PR description** is outdated and must be replaced (prepared text; `gh` is not available on this machine).
- **M2 Draft status:** the PR leaves Draft only after M1 and the human reviewer's approval.

**Stale comments S1–S3 (found in the review; fixed, comments only, no behaviour change):**
- **S1** `execution-gate.ts` L295–296 said "the O20 sync refuses a non-empty portfolio"; the sync reads non-empty portfolios. Now: a close does not depend on the sync because a broker-confirmed NEXUS position must stay closable even when the sync is failing or stale.
- **S2** `demo-execution-sources.ts` L1–6 said "no source exists yet … always answers null". Now: the runtime wires `EtoroDemoAccountSafetySource` (`compose.ts`); `NO_DEMO_SAFETY_SOURCE` is only the fallback when that source cannot be built.
- **S3** `etoro-sync-adapter.ts` L5–7 said non-empty positions are "not yet observed in a live response". Now: positions have been observed live (O21B/O21C, O22 `/demo/pnl`), pending orders have not; the coverage label stays `documented_schema` in this build.

The diff of S1–S3 contains comment lines only (checked line by line); `npm run typecheck` is clean.

**Documented residual risks** (assessed against the success criterion in 17.6; C1–C3 implemented 2026-10-19; acceptance of what remains is open before the execution release):
- **A1** The account decision is read before, not inside, the reservation; a local database lock cannot make manual broker activity atomic with the NEXUS write. Detected afterwards by C1 (`EXTERNAL_ACTIVITY`); operating rule: no parallel manual trades.
- **A2** Reduced by C3: a request that could never be sent is refused before `SUBMITTING` and spends nothing. A local refusal after `SUBMITTING` is not expected any more; it would still spend the budget.
- **A3** A fill with more than one position makes the NEXUS close impossible: a close needs exactly one broker-confirmed position (`closePositionOf`, `confirmed.length !== 1`). Manual procedure, see 17.5.
- **A4** Removed by C2: a close reads no account decision.
- **A5** Quote freshness depends on the minute candle (R4); a stale refusal sends nothing and spends no budget.
- **A6** The runtime registry is not re-synced per gate run: a mapping applied while the runtime runs is seen after a restart (fail closed until then).

**Prerequisites of the demo cycle (not merge blockers):** B2 closed and B6 decided (2026-10-19); C1–C3 implemented and the operating rules set (17.3, 17.6); open: the human review of PR #25, the acceptance of the remaining A1/A3/A5/A6, then B1 (separate release change) and the runbook 17.3.

**Verdict.** The review of the safety-critical behaviour found no merge blocker; S1–S3 are fixed. The PR stays Draft until M1 and the human reviewer's approval; the acceptance of the remaining residual risks is a separate decision before the execution release. This is not a release: the build lock stays closed.

### 17.5 Procedure when a fill creates more than one position (A3)

**How it shows.** There is no dedicated reason code. The signals are: after `refresh`, the open intent is `FILLED` (or `PARTIALLY_FILLED`) and its `brokerPositionIds` has **more than one** entry; for a `FILLED` open the cycle route lists one item per position (a `PARTIALLY_FILLED` open appears as one `outcome_pending` item); creating the close intent is refused with `INTENT_INVALID` ("the close target is not a known, broker-confirmed position of NEXUS").

**What NEXUS does and does not do.**
- No further order of any kind: the open budget is spent, and no close is created or sent.
- No safety check is bypassed: the rule "exactly one broker-confirmed position" is not overridden, and no position id is ever taken from a request.

**Manual procedure (operator).**
1. STOP the runbook at step 7. Do not create, approve or execute any further intent.
2. Record what NEXUS shows: the open intent (`GET …/intents/{openId}`: state, `brokerPositionIds`, `brokerSettlementType`) and `GET /api/broker/etoro/demo/cycle` after one read-only sync. Store only ids and states, no keys.
3. Clarify in the eToro demo account (UI): which positions belong to the order, their units and amounts.
4. Any close of these positions is a manual action of the operator in the eToro UI, taken by a separate, explicit decision. NEXUS does not close them.
5. Afterwards one approved read-only sync. The account must show none of these positions; the cycle route then reports them as `open_position_missing` (verdict `inconsistent`), which is the expected record of a close outside NEXUS and is not resolved by NEXUS. Document the case with sanitized evidence. A new cycle needs a reviewed code change (the budget is spent).

### 17.6 A1–A6 against the success criterion; changes C1–C3 and operating rules (2026-10-19)

**Finding that changes the picture.** The reconciliation verdict does not carry the success criterion of B6. `PRODUCT_TYPE_NOT_CONFIRMED_REAL` is only a reason: the verdict stays `consistent` (`demo-cycle-reconciliation.ts` L106–109, L117–121). After the close, the open's item is skipped for a closed position (L94), so the final reconciliation no longer shows the product type at all. Read alone, "consistent" after step 9 would report a test as passed that B6 counts as failed.

| Risk | Effect on the success criterion | Technical change | Operating rule / decision |
|---|---|---|---|
| **A1** account decision read before, not inside, the reservation | A position or order placed by hand between the gate and the reservation is not seen. The NEXUS position stays uniquely bound by `positionID`, but the account limits could be exceeded for the test; the final reconciliation would report `EXTERNAL_POSITIONS_PRESENT`. | None possible in NEXUS: a local database lock cannot make manual broker activity in the eToro account atomic with the NEXUS write. C1 detects it afterwards (`EXTERNAL_ACTIVITY`, from the open's creation on, sticky). | **D1 (set):** no parallel manual trades; any external position or order fails the test. |
| **A2** a local refusal after `SUBMITTING` spends the budget | The test fails with no order sent, and a new cycle needs a code change. The refusals possible there are deterministic from the intent (body and URL building, the close's position id, the transport's own pre-check). | **C3 (done):** `prepareOpen` / `prepareClose` build the body and URL and run the transport's checks (`assertSendable`) before the reservation; an unsendable request is refused as `REQUEST_NOT_SENDABLE`, the intent stays `APPROVED`, nothing is spent. The budget re-check under the lock is unchanged; from `SUBMITTING` on the budget stays spent and nothing is resent. | D2 resolved by C3. |
| **A3** more than one position from one fill | Unique binding fails: the test is failed. NEXUS cannot close (exactly one confirmed position required). | None: the rule must not be weakened. C1 reports `POSITION_BINDING_NOT_UNIQUE`. | **D3 (set):** test failed; manual clarification per 17.5. |
| **A4** the close also reads `/demo/pnl` | The read does not decide a close, but `runGate` makes it for every phase; an exception while recording the valuation (for example a database error) would abort the close's execute (nothing sent, no budget spent, can be repeated). It is an avoidable dependency of the safe close. | **C2 (done):** `runGate` reads the account only for an open. The gate's checks are unchanged (every safety check applies to opens only); identity, position binding, demo mode and budget checks of the close are untouched. **Side effect (F9):** a close no longer appends an account valuation to `etoro-demo-account-valuations` (the risk day's start and peak) and no longer refreshes the safety source's last status shown in `safetyReadiness`; after a close both show the last open's reading. No protection depends on them for a close. | D4 resolved by C2. |
| **A5** quote freshness by minute candle | A stale quote refuses the open (nothing sent, no budget spent); repeated refusals until `expiresAt` leave the test not started, not failed. No effect on the close (no quote check for a close). | None; the 60 s limit stays. | **D5 (set):** refetch and re-check at most three times per step, then stop; never relax the limit. |
| **A6** registry not re-synced per gate run | None for this test: the mapping was applied before any runtime start of the cycle. | None. | – (runbook: start the runtime after the mapping; already the case) |

**C1 – the test verdict of B6** (`etoro-demo-cycle-test-verdict:v2`, `demo-cycle-test-verdict.ts`; corrected after the independent review, 17.7). `GET /api/broker/etoro/demo/cycle` reports `test` next to the reconciliation. The **test verdict is historical**: it reads stored state only (the intent log with every broker status read unmerged, and the stored sync history) and never the time of reading. The **reconciliation describes the current account**. They are kept apart.
- **`passed`** only when all are proved: exactly one open submitted and `FILLED`; the status read that confirmed the fill names exactly one position, and no other fill read of the open names another; that confirming read states `settlementType` `real`, and no read of the open states another type; a snapshot observed after the open was submitted and before the close was filled shows the position (instrument and side); exactly one close of that position submitted and `FILLED`; a **closing snapshot**: the first observation **in storage order** (sync log sequence) taken after the close was filled, at most 5 minutes after it, stored at most 5 minutes after it was taken, without the position; no other position or order in any snapshot of the **test period** (observed from the open's creation on and stored up to and including the closing snapshot: a point in the append-only log, which a later-stored snapshot cannot move).
- **`failed`** with the broken criterion: `OPEN_REJECTED`, `OPEN_NOT_FILLED`, `OPEN_PARTIALLY_FILLED_FINAL`, `POSITION_BINDING_NOT_UNIQUE`, `SETTLEMENT_TYPE_MISSING`, `SETTLEMENT_TYPE_NOT_REAL`, `SETTLEMENT_TYPE_CONTRADICTED`, `POSITION_MISMATCH`, `EXTERNAL_ACTIVITY`, `CLOSE_TARGET_MISMATCH`, `CLOSE_REJECTED`, `CLOSE_NOT_FILLED`, `CLOSE_AMBIGUOUS`, `MORE_THAN_ONE_OPEN_SUBMITTED`, `MORE_THAN_ONE_CLOSE_SUBMITTED`. A failure is decided only on facts a later event cannot change: final intent states, the confirming read, snapshots judged by their own times. An entry of a snapshot is external only when no intent that had been submitted before that snapshot was stored can still turn out to own it (its order id is known or it is final).
- **`incomplete`** otherwise (`FINAL_SNAPSHOT_NOT_IN_TIME` is terminal: the test can then never pass): evidence missing, in progress or not readable consistently (`OPEN_POSITION_NOT_OBSERVED`, `FILL_CONFIRMATION_NOT_VISIBLE`, `SNAPSHOT_HISTORY_INCOMPLETE`, `FINAL_SNAPSHOT_MISSING` / `_NOT_IN_TIME`, `FINAL_POSITION_STILL_OPEN`, `ACTIVITY_NOT_YET_ATTRIBUTABLE`, open or close pending, a partial fill not stated final). Never `passed`.
- **Order of observations:** by `observedAt`, then by the sync log sequence (`compareObservations`), inside the verdict and for the latest snapshot of the reconciliation alike. The sync log is read before the snapshot log; a sync whose snapshot record cannot be read is counted, never skipped silently.
- **After the closing snapshot** neither the passing of time nor later activity in the account changes the result. A partial fill counts as final only when the broker states it (`partially_filled_final`), never from elapsed time; once any read states it, the failure stays, also against a later read.

**Not changed.** No protection is weakened by any of C1–C3; no limit is raised; the budget stays one open and one close.

### 17.7 Independent review of C1–C3 and its corrections (2026-10-19)

A separate review agent read the commit `53d1c3a` (C1–C3) without changing anything. It found no issue in the C2 gate path and in the C3 request path, and ten findings. The operator classed F1 and F2 as release blockers. Each finding was first pinned by a regression test that failed on `53d1c3a` (13 of the then 18 tests failed; the other 5 guarded behaviour that was already right), then corrected:

| # | Finding | Correction |
|---|---|---|
| F1 | A proved `EXTERNAL_ACTIVITY` (foreign order) disappeared while the close was `SUBMITTING` or `AMBIGUOUS` | Attribution per snapshot by time: an intent can own an entry only if it was submitted before that snapshot was stored |
| F2 | `passed` depended on the time of reading (freshness against now) and on activity after the test | Closing snapshot judged by its own times; the test period ends with it |
| F3 | A late-stored observation could create and remove `OPEN_POSITION_NOT_OBSERVED` | Missing observation is `incomplete`; any observation between the open's submission and the close's fill counts |
| F4 | Sync and snapshot logs read in parallel; a missing record skipped silently | Sync log first, then snapshot log; missing records counted (`SNAPSHOT_HISTORY_INCOMPLETE`); the route reads the history before the intents |
| F5 | Order depended on input order; different tie-break than the latest snapshot | One rule (`compareObservations`) for the verdict and the latest snapshot |
| F6 | Product type and binding from merged fields | The read that confirmed the fill is authoritative; contradictions fail; binding from fill reads only; an invisible confirmation is `incomplete` |
| F7 | A final partial fill stayed `incomplete` forever | Failed only when the broker states `partially_filled_final`; otherwise `incomplete` |
| F8 | Test gaps | `o22-review-regressions.test.ts` (20 tests) |
| F9 | A close no longer records an account valuation or refreshes the source status | Documented (17.6, A4) |
| F10 | A body serialization error inside the fetch became AMBIGUOUS | The body is serialized and checked before the reservation; the transport sends exactly that text and serializes outside its fetch error handling |

While aligning the tests, one more defect of the corrected verdict was found and fixed: with the fill confirmation not readable, an unbound position was judged `EXTERNAL_ACTIVITY`; it is now `incomplete`.

**Second review of the corrections (commit `eaec0de`).** F1–F6 and F8–F10 confirmed fixed, F7 partially; no blocker. New findings, each first pinned by a regression test (N1 and N2: 4 tests failed on `eaec0de`), then corrected:

| # | Finding | Correction |
|---|---|---|
| N1 | Closing snapshot and period chosen in `observedAt` order: a later-stored, earlier-observed snapshot could move the period (a failure could disappear, a `passed` could change) | Closing snapshot = first qualifying observation in storage order; the period ends at its sync log sequence |
| N2 | `partially_filled_final` read from the last read only | Any read stating it fails the test for good; the binding counts as final only in a final state |
| N3 | 5-minute closing deadline not in the runbook | Operating rule and steps 8–9; `FINAL_SNAPSHOT_NOT_IN_TIME` marked terminal |
| N4 | The race test did not prove the refusal came from the reservation | Process b is held after its gate at its `SUBMITTING` append; its refusal comes from the precondition under the lock |
| N5 | The "stale" test proved nothing; no service-level test for an unserializable body | The verdict is shown to take no clock (fake time); a service-level test with the real serializer |
| N6 | A test comment and the section-10 row described v1 rules | Corrected |
| N7 | Attribution compares two processes' clocks | Operating rule: one machine, one clock |

**Third check (commit `1bb76f6`).** N1–N7 confirmed fixed; the operator's success criteria re-confirmed (no path to `passed` with missing or late evidence; no failure can disappear; no time of reading; nothing after the closed period counts). One new defect, pinned by a regression test that failed on `1bb76f6`, then fixed: **D1** the proof "position observed" read every stored snapshot, so a slow sync stored after the closing snapshot could complete it (turning `incomplete` into `passed`) while its other entries were never judged. It now uses the same closed period as the activity check (`sequence ≤` the closing snapshot's).
