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
| B2 | Demo portfolio safety | **evidence closed; source active.** G1 and G2 are proved (section 12), and the evidence record cites both reports. The decision is still `CAPACITY_BLOCK` because of the hand-opened position. | The account must fit the unchanged limits: the operator closes the hand-opened position in the UI. No limit is raised. |
| B3 | Identity of 100001 | **confirmed** (section 14): Crypto, ETH, Ethereum | — (the quote currency of the pair and the product type remain under B6/B8) |
| B4 | Governed mapping path | **closed** (2026-10-19): `etoro / 100001 → ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc`, applied by `human/luc-vorburger` after a read-only dry run with the same parameters; read-only check: 100001 resolves to exactly this instrument, one new event | — |
| B5 | Demo write permission | **not granted** (one `/me` read, 2026-10-19): `demoRead=true`, `demoWrite=false`, `realRead=false`, `realWrite=false`. The key pair can read the demo account but not trade on it; eToro would refuse every demo order. | a new demo user key created with write permission, entered by the operator; then one approved `/me` read with `demoWrite=true` and `realWrite=false` |
| B6 | `settlementType` | **narrowed**: not sent, but verified after the fill and flagged unless `real` | decide whether a non-`real` result is acceptable for the test |
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
| `o22-me-scopes.test.ts` (18) | `/me`: scope names only (no identifier or profile field in the report), demo write only by `demo:write` / `trade.demo:write`, real scopes reported, strict refusals; one fixed GET, no retry on 401/403/429/500, gated (confirmation, demo mode, keys) |
| `test/market-data/o22-twelve-data-crypto-quote.test.ts` (8) | Quote currency: `currency`, ISO `currency_quote`, no translation of stated names, never from the symbol; without a usable reference no currency, and `INSTRUMENT_NOT_USD` |
| `test/market-data/o22-twelve-data-crypto-reference.test.ts` (23) | `/cryptocurrencies`: the live ETH/USD answer resolves to USD with its origin; unique row (none, several, other pairs); unknown names (no near match, no case folding); ISO code; never the symbol or `currency_base`; venue listed; strict parser; reuse within 24 h, concurrent reads shared, a refused read not kept; a stated quote currency never replaced; a contradiction with the instrument currency refused; stocks unchanged; registration through the runtime services records the origin |
| `test/runtime/o22-runtime.test.ts` (9) | The route; the production wiring with recorded evidence (creating an open reads `/demo/pnl` once, the hand-opened position blocks it, 0 writes); an empty account (risk-approved, execute still `EXECUTION_LOCKED_IN_BUILD`); every lock closed |
| `test/pg/o22-cycle-budget.pg.test.ts` (3), `test/pg/o22-account-safety.pg.test.ts` (1) | Budget across pools; a shared risk day across processes and a restart |
| `test/pg/o22-map-instrument.pg.test.ts` (4), `test/pg/o22-registry-inspect.pg.test.ts` (5) | Mapping dry run on a throwaway database (writes nothing); read-only registry inspection |

Results: in the PR description. Local run 2026-10-19 with the `/me` read: `npm run typecheck` clean; `vitest --project unit --project pg` 171 files, 3078 tests, all passed (184 of them in the 18 O22 files above). The O20/O21A allowlist tests were updated for the one added operation `identity.me`.

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

### `/me` scope check (B5, 2026-10-19)

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

**B5 is confirmed as a blocker.** The key pair matches the reads made so far (portfolio, `/demo/pnl`, metadata) but cannot place a demo order. The write permission is set when a user key is created; a new demo user key with write permission is needed. No real-account scope is granted.

### Remaining before the controlled demo test

1. **eToro demo configuration. Done** (2026-10-19): the demo keys and `ETORO_ENABLED=1`, `ETORO_TRADING_MODE=demo`, `ETORO_DEMO_EXECUTION_ENABLED=0` are in the worktree `.env`.
2. **B5, write scope. Open.** The read path is the observation tool, `--source=me` (O22): the fixed operation `identity.me` (`GET /api/v1/me`, documented as the first call with a key pair; `scopes` is the array of granted scopes, `etoro-public:demo:write` includes `trade.demo:write`). The report (`etoro-me-scopes.ts`) keeps only the scope names, checked against a strict pattern, and `demoWrite`, `demoRead`, `realWrite`, `realRead`; no identifier, name or profile field. No retry. Tested in `o22-me-scopes.test.ts` (18). The first read gave `demoWrite=false` (above). Next: the operator creates a demo user key with write permission and enters it; then exactly one approved `/me` read, expected `demoWrite=true` and `realWrite=false`; any other result stops the preparation.
3. **B2, account.** The operator closes the hand-opened ETH position in the eToro UI. NEXUS never closes it.
4. **B6.** Decide whether a non-`real` `settlementType` after the fill is acceptable for the test.
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
