# O21A – eToro Non-empty Demo Portfolio Read-only V1

Status: implemented and merged (PR #21, merge commit `9a226b4`; original base `ae6a984`, merge of PR #20, O21).
- `/demo/portfolio`: LIVE_OBSERVED twice through NEXUS (2026-10-17), HTTP 200, **empty** both times.
- `/demo/pnl` (O21A.1, section 11): LIVE_OBSERVED once through NEXUS (2026-10-17), HTTP 200, **empty**.
- An independent direct `/demo/pnl` GET outside NEXUS was also **empty**.
- On 2026-10-17 a **non-empty** response was **NOT live-observed**, although a demo position was open in the eToro UI (section 9).
- **2026-10-18 (O21B, section 12):** a **non-empty** `/demo/portfolio` response is now **LIVE_OBSERVED** once, through a single direct GET outside NEXUS. It held one position that matches the ETH buy position visible in the eToro UI. The unchanged parser accepted the operator's private pseudonymized export offline. The repository fixture has `credit` redacted to `null` and is therefore refused as a whole, by design; its position passes `parsePosition`. Why the earlier responses were empty is still **unexplained**. `/demo/pnl` was **not** read again.
- **2026-10-18 (O21C, section 13):** a non-empty `/demo/portfolio` response is now **LIVE_OBSERVED through NEXUS**. One read was made with the observation tool (`--source=portfolio`). The O21A parser **accepted** it with 1 position and 0 orders. Not confirmed by this: sync/reconciliation, instrument mapping, cash semantics, portfolio safety connection.

O21A prepares the O20 read-only adapter for a non-empty eToro **demo** portfolio. It reads open positions and pending orders strictly with the documented schema, maps them to NEXUS instruments only through the human-governed `etoro` mapping, and stores the fields NEXUS needs. It also adds a separate read-only observation tool for the first controlled live read. Nothing here writes to the broker, unlocks anything, or touches O17, O19, O21 execution or O22.

## 1. Evidence levels

| Level | Meaning |
|---|---|
| **DOCUMENTED** | Stated in the official eToro API reference, `GET /api/v1/trading/info/demo/portfolio` (api-portal.etoro.com, `trading--demo/get-demo-portfolio-breakdown`), checked 2026-10-17. |
| **LIVE_OBSERVED** | Seen in a real eToro demo response. |
| **NOT_VERIFIED** | Neither documented nor observed, or documented but with unclear meaning. NEXUS does not rely on it. |

| Fact | Level |
|---|---|
| Path, method, `clientPortfolio` wrapper | DOCUMENTED + LIVE_OBSERVED (O20, empty portfolio) |
| All nine containers present and arrays when empty, `credit` a JSON number | LIVE_OBSERVED (O20) |
| Empty `/demo/portfolio` structure (all 11 documented keys, every container empty) | LIVE_OBSERVED twice (O21A, section 11) |
| Empty `/demo/pnl` structure (all 13 schema keys, `positions` / `orders` / `ordersForOpen` empty) | LIVE_OBSERVED once through NEXUS, and once independently outside NEXUS (section 11) |
| Element schema of `positions` | DOCUMENTED + LIVE_OBSERVED twice on 2026-10-18, one position each time: a direct GET outside NEXUS (O21B, section 12) and a read through the NEXUS observation tool (O21C, section 13) |
| Element schema of `orders` | DOCUMENTED only (`orders` was empty in every observed response) |
| Non-empty `positions`, every other container empty | LIVE_OBSERVED (O21B section 12; O21C section 13, through NEXUS, parser accepted) |
| Any other non-empty container / element shape | **NOT LIVE_OBSERVED** |
| Meaning and currency of `credit` / `bonusCredit` | DOCUMENTED as "USD"; meaning NOT_VERIFIED |
| Element schema of `ordersForOpen`, `ordersForClose`, `ordersForCloseMultiple` | NOT documented (`items: { type: object }`, no properties) |
| `stockOrders`, `entryOrders`, `exitOrders` | DOCUMENTED as "Obsolete" |
| `required` list on any element | NOT documented (the reference has none) |
| int32/int64 format of `positionID`, `orderID`, `instrumentID` | NOT documented (only `integer`) |
| Format of `openDateTime` | DOCUMENTED `date-time` ("ISO 8601" for positions); the example uses `...Z` |

## 2. Documented structure

`clientPortfolio`: `positions` ("List of currently open trading positions"), `credit` (number, "Available trading balance in USD, representing funds available for new positions"), `mirrors` ("Copy trading configurations and positions"), `orders` ("List of pending orders"), `stockOrders` / `entryOrders` / `exitOrders` ("Obsolete"), `ordersForOpen` ("Active orders to open positions"), `ordersForClose` ("Active orders to close positions"), `ordersForCloseMultiple` ("Active orders to close multiple positions"), `bonusCredit` (number, "Bonus credit amount in USD available for trading").

**Position (`TradingDemoApi_Position`), 35 fields:** `positionID`, `CID`, `openDateTime`, `openRate`, `instrumentID`, `mirrorID`, `parentPositionID`, `isBuy`, `leverage`, `takeProfitRate`, `stopLossRate`, `amount`, `orderID`, `orderType`, `units`, `totalFees`, `initialAmountInDollars`, `isTslEnabled`, `stopLossVersion`, `isSettled`, `redeemStatusID`, `initialUnits`, `isPartiallyAltered`, `unitsBaseValueDollars`, `isDiscounted`, `openPositionActionType`, `settlementTypeID`, `isDetached`, `openConversionRate`, `pnlVersion`, `totalExternalFees`, `totalExternalTaxes`, `isNoTakeProfit`, `isNoStopLoss`, `lotCount`.

Relevant documented meanings: `positionID` "Unique identifier for the position"; `instrumentID` "Identifier of the traded instrument"; `isBuy` "true for long (buy) positions, false for short (sell) positions"; `units` "Number of units in the position"; `openRate` "Entry price of the position in the instrument's currency"; `leverage` "Leverage multiplier"; `amount` "USD amount allocated to the position … includes both the initial investment, and additional margin"; `openDateTime` "Timestamp when the position was opened in ISO 8601 format"; `stopLossRate` / `takeProfitRate` the trigger prices; `isNoStopLoss` / `isNoTakeProfit` "false = enabled, true = disabled"; `isTslEnabled` trailing stop loss active; `mirrorID` / `parentPositionID` "0 otherwise" (not copy trading); `orderID` "Original orderID the position was opened by. Need to match together with orderType". There is **no documented current rate** in this endpoint. `totalFees` is documented ("overnight fees and dividends … in USD") but not used.

**Pending order (`orders`), 14 fields:** `orderID` ("Unique identifier for the order"), `CID`, `openDateTime` ("Date and time when the order was created"), `instrumentID`, `isBuy` ("true - Long, false - Short"), `takeProfitRate`, `stopLossRate`, `rate` ("Asset rate at which to send market order to the market"), `amount` ("USD amount to invest in the position"), `leverage`, `units` ("If this value is greater than zero the position will open on the requested units, and not amount"), `isTslEnabled`, `executionType` ("Type of order execution"), `isDiscounted`. There is **no documented status field**: membership in `orders` means "pending".

Documentation inconsistency noted: the mirrors schema has `mirrorStatusID`, its example `mirrorStatusId`. Mirrors are not read.

## 3. What was implemented

### Parser (`src/broker/etoro/etoro-validation.ts`)

- `positions` and `orders` are read element by element; every other container must be empty (`mirrors`: copy trading out of scope; obsolete containers; containers without a documented element schema). A non-empty one is `BROKER_RESPONSE_INVALID`.
- **NEXUS-required** fields (NEXUS policy, since the reference has no `required` list):
  - position: `positionID`, `instrumentID`, `isBuy`, `units` (> 0), `openRate` (> 0), `leverage` (1…1000), `amount` (≥ 0), `openDateTime`.
  - order: `orderID`, `instrumentID`, `isBuy`, `amount` (≥ 0), `units` (≥ 0, 0 is documented as "use amount"), `leverage`, `openDateTime`.
- Optional, null when absent, never interpreted: `stopLossRate`, `takeProfitRate`, `isNoStopLoss`, `isNoTakeProfit`, `isTslEnabled`, `rate`. A value of 0 is kept as reported; no meaning is given to it.
- `orderID` + `orderType` on a position are kept only as a pair (as documented); an `orderID` without a valid `orderType` is refused.
- A position with `mirrorID` or `parentPositionID` other than 0 is refused (copy trading).
- IDs: positive **safe** integers. An id above 2^53 cannot round-trip through `JSON.parse` and is refused. No int32 bound is assumed (not documented).
- Numbers: finite JSON numbers within a bound (|x| ≤ 1e12), stored as canonical decimal strings. A string where a number is expected is refused; no coercion. `Infinity` (from an overflowing literal) and `NaN` are refused.
- Timestamps: ISO 8601 with a time and an explicit `Z` or offset, normalized to UTC. A timestamp without a zone is refused (not guessed as UTC).
- Duplicate ids within a container are refused. Output is sorted by id: deterministic regardless of element order.
- Unknown extra fields are ignored and never kept. Error messages name the field path only, never a value.
- The empty portfolio stays valid; the bound of 500 entries per container stays.

### Snapshot (`etoro-sync-adapter.ts`, `etoro-broker-service.ts`)

- The adapter carries the parsed entries in `snapshot.etoro.{positions, orders}`. The generic `BrokerSnapshot.positions/openOrders/cash` stay empty: they need a cost currency and a NEXUS instrument that the payload does not state.
- Coverage: `positions` / `openOrders` are `verified_empty` when empty and `documented_schema` when entries were read with the not-yet-observed schema. `cash: not_read`, `accountIdentity: not_observed` unchanged.
- Persisted per position: `positionId`, `etoroInstrumentId`, `instrumentId` (NEXUS, or `null`), `direction`, `units`, `openRate`, `leverage`, `amountUsd`, `openedAt`, `stopLossRate`, `takeProfitRate`, `stopLossDisabled`, `takeProfitDisabled`, `trailingStopLoss`, `openOrder`. Per order: `orderId`, `etoroInstrumentId`, `instrumentId`, `direction`, `amountUsd`, `units`, `rate`, `leverage`, `createdAt`, `stopLossRate`, `takeProfitRate`, `trailingStopLoss`.
- Not persisted: the raw response, `CID`, fees, taxes, P&L fields, obsolete fields, unknown fields, keys, headers, request ids, any account id.
- The content of an empty portfolio is byte-for-byte the O20 content (no `positions`/`orders` keys), so O20 snapshot ids are unchanged.

### Mapping semantics

- Broker identity = eToro `instrumentID`. A NEXUS instrument is found only with `InstrumentRegistry.resolve('etoro', String(instrumentID), observedAt)`: the same provider (`etoro`) and provider-symbol convention as the O21 execution gate.
- No ticker or symbol fallback. Nothing is registered or mapped automatically.
- Unknown instrument id → `instrumentId: null`; reconciliation reports `unmapped_broker_instrument` and is not matched.
- A mapping that carries an `exchange` does not match (the portfolio states no exchange): it fails closed as unmapped.

### Reconciliation

- `reconcilePositionQuantities` (extracted from `reconcileBrokerSnapshot`, behaviour unchanged) compares the net broker units per mapped NEXUS instrument (buy minus sell) with the open ledger positions of broker `etoro`.
- Pending orders do not change positions. Cash is not compared.
- Netting `units` against the ledger quantity assumes eToro units and NEXUS quantity mean the same; for leveraged/CFD positions this is **NOT_VERIFIED** and is exactly what the live observation must confirm. A mismatch is reported, never corrected.
- Ledger mutation: 0.

## 4. Cash

`cash` stays `not_read`. `credit` is documented as "Available trading balance in USD", but it is not verified whether it is free cash, equity or buying power, nor how pending orders and `bonusCredit` affect it. `cash = credit` is **not** set. `credit` is still required to be present (O20 rule).

## 5. Observation harness

`src/broker/etoro/etoro-observation.ts` (report) and `src/broker/etoro/etoro-observe-cli.ts` (tool). Not imported by the runtime.

```
npm run etoro:observe-demo -- --source=portfolio|pnl --confirm-live-read [--pseudonymize-ids] [--show-instrument-ids]
```

- Refuses without exactly one valid `--source` (O21A.1: no default), without `--confirm-live-read`, without `ETORO_TRADING_MODE=demo`, with malformed keys, or with any unknown argument. A refusal sends nothing.
- Sends exactly one request through the O20 transport: `--source=portfolio` → `GET /api/v1/trading/info/demo/portfolio`, `--source=pnl` → `GET /api/v1/trading/info/demo/pnl` (section 11). No fallback, no retry.
- Prints a sanitized JSON report to stdout and writes nothing to disk; the body is dropped after the report.
- The report contains: top-level keys, `clientPortfolio` keys, documented-but-missing and undocumented keys, per container the kind and element count, per field the presence count and JSON kind counts (`integer`, `unsafe_integer`, `non_integer_number`, `string_iso8601_utc_z` / `_offset` / `_no_zone`, `string_numeric`, `string_other`, `boolean`, `null`, `array`, `object`), sign classes for numbers (zero/positive/negative), the comparison against the documented field lists, and the O21A parser verdict (`accepted` with counts, or `refused` with the field path).
- It contains no value. Key names that do not look like field names are counted, not printed. IDs appear only with `--pseudonymize-ids`, as HMAC-SHA256 with a random per-run salt that is never output (comparable within one report, not across runs). eToro instrument ids are public market identifiers and appear only with `--show-instrument-ids`, to prepare the human-governed mapping.
- Failures print a fixed code or HTTP status only.

## 6. Fixtures

`test/broker/etoro/o21a-documented-fixture.ts` is the official reference example, field for field. It is marked **documented fixture — NOT live-observed** (`FIXTURE_PROVENANCE = 'documented_fixture_not_live_observed'`). No real payload was copied, and there is no "real payload fixture". The live reads so far were empty, so no observed element could be compared with this structure (`NON_EMPTY_DEMO_PORTFOLIO_NOT_LIVE_OBSERVED`).

## 7. Tests

- `test/broker/etoro/o21a-validation.test.ts`: empty still valid; one/several positions; one/several orders; positions + orders; duplicates; non-empty unread containers refused; malformed ids, instrument ids, wrong number types, NaN/Infinity, missing required fields, bad timestamps; extra/unknown fields ignored and not kept; no ticker identity; deterministic order; no value in errors.
- `test/broker/etoro/o21a-service.test.ts`: mapping present (match, mismatch), mapping missing, no registry, unknown instrument id, ticker-only mapping does not match, other provider, expired mapping, mapping with exchange, netting, pending orders ignored for positions, deterministic snapshot and reconciliation, O20 empty content unchanged, cash never derived, no raw fields stored, malformed payload stores nothing, ledger unchanged, no key in any record, one GET only.
- `test/broker/etoro/o21a-observation.test.ts`: report structure, no values, pseudonyms, instrument ids opt-in, undocumented/missing fields, data-like keys, parser verdict; tool gating, one GET, no key, fixed failure codes, no file writes, not imported by the runtime.
- `test/runtime/o21a-runtime.test.ts`: production composition with O21 execution enabled; a non-empty sync leaves ledger, kill switch, all four O21 execution logs and the registry unchanged; the execution transport sends nothing; `BUILD_LOCKS` all `true`; paper / no live trading; no real-account path in any eToro source.
- O20 validation tests updated where O21A changes behaviour on purpose: positions/orders entries are now parsed (and refused by field path if they do not match the schema) instead of refused as a whole.

## 8. Safety boundaries (unchanged)

- `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`.
- `BUILD_LOCKS.liveTrading`, `.brokerOrders`, `.physicalPurchase`, `.etoroDemoExecution` = `true`.
- No change to O21 execution, its state machine, operator auth, or O17/O19.
- `PORTFOLIO_SAFETY_NOT_CONNECTED` stays: no eToro demo portfolio safety source is built in O21A.
- Broker writes: 0. Real endpoints: 0.
- Allowed eToro read operations: exactly two fixed demo read operations, both GET:
  - `portfolio.demo` → `/trading/info/demo/portfolio`;
  - `pnl.demo` → `/trading/info/demo/pnl`, observation-only (used by the observation tool alone).
- No real route and no write route.

## 9. Remaining blockers

1. **`NON_EMPTY_DEMO_PORTFOLIO_NOT_LIVE_OBSERVED`** – state of 2026-10-17.
   - **Superseded for `positions` via `/demo/portfolio`** on 2026-10-18:
     - a direct GET outside NEXUS (O21B, section 12);
     - a read through the NEXUS observation tool, parser accepted (O21C, section 13).
   - **Not superseded** for a non-empty `orders` (or any other container) or for a non-empty `/demo/pnl`: neither has been observed.
   - Still **unexplained**: why the 2026-10-17 responses were empty.
   - The original 2026-10-17 record: no non-empty demo portfolio had been observed live.
   - The demo position open in the eToro UI was visible neither through `/demo/portfolio` nor through `/demo/pnl`.
   - A direct `/demo/pnl` GET outside NEXUS was empty too.
   - Section 11 records the observations and the manual credential/account check.
   - Treated as an external eToro demo API / portfolio visibility blocker: the API response does not expose the UI-visible position in the observed context.
   - Every non-empty parse path therefore rests on the documentation alone. The non-empty parser semantics (`units`, ids, timestamps, the PnL nesting and casing of `/demo/pnl`) remain unconfirmed live.
2. Semantics to confirm live: `units` vs NEXUS quantity (leverage/CFD vs real asset), sign/meaning of `stopLossRate`/`takeProfitRate` = 0, timestamp format (zone present?), whether ids fit safe integers.
3. Where an order placed via O21 appears before execution (`orders` vs `ordersForOpen`). `ordersForOpen` has no documented element schema; while non-empty, the whole read is refused.
4. Cash authority (`credit`, `bonusCredit`) not decided.
5. No account identity in the payload.
6. Human-governed `etoro` mappings must exist for the instruments held, before reconciliation can match.
7. The eToro demo portfolio safety source (next step) is not built.

## 10. First live read (historical, executed 2026-10-17)

The planned procedure was carried out; the results are in section 11.
1. A human opened a demo position manually in the eToro UI, not through NEXUS. The O21 lock stayed closed.
2. Approved, single runs of `npm run etoro:observe-demo` were made with demo keys: twice `--source=portfolio`, once `--source=pnl`.
3. Every report was compared against the documented structure. All responses were empty, so there was no element shape to compare (`NON_EMPTY_DEMO_PORTFOLIO_NOT_LIVE_OBSERVED`).
4. No decision on the mapping or the safety source has been made.

## 11. O21A.1 – /demo/pnl read-only observation support

### Live observations of /demo/portfolio (2026-10-17)

| Read | Result |
|---|---|
| 1 (portfolio empty in the UI) | HTTP 200, one GET. `clientPortfolio` with all 11 documented keys, none undocumented, none missing; every container an empty array; `credit` a positive non-integer number, `bonusCredit` the integer 0; parser accepted (0 positions, 0 orders). |
| 2 (after a demo position was opened manually in the eToro UI) | HTTP 200, one GET. **Identical structure, every container still empty**; parser accepted (0/0). |

LIVE_OBSERVED is therefore the empty container structure of `/demo/portfolio`. The position visible in the UI was **not** in the response.

### Live observation of /demo/pnl (2026-10-17)

| Read | Result |
|---|---|
| 1, through NEXUS (`--source=pnl`) | HTTP 200, one GET. `clientPortfolio` with all 13 schema keys; `positions` = 0, `orders` = 0, `ordersForOpen` = 0; parser accepted. No non-empty element shape observed. |
| Independent direct GET outside NEXUS | `GET https://public-api.etoro.com/api/v1/trading/info/demo/pnl` via PowerShell, made manually by the operator with the same existing demo credentials. Request successful: `positions`, `orders`, `ordersForOpen`, `ordersForClose`, `ordersForCloseMultiple` and `mirrors` all 0; `accountCurrencyId` = 1; `credit` present as a positive number (value not recorded). A demo position was open in the eToro UI at the same time. |

### Credential / account context (checked manually by the operator)

- Key environment: Demo.
- Same eToro login as the UI.
- Main account (not an agent portfolio or sub-account).
- The position was open in the demo context.

Despite this, both NEXUS and a direct API call outside NEXUS return an empty portfolio. The empty response is therefore not caused by the NEXUS transport or parser. The remaining blocker is kept as an external eToro demo API / portfolio visibility blocker: the API response does not expose the UI-visible position in the observed context. Blocker name: **`NON_EMPTY_DEMO_PORTFOLIO_NOT_LIVE_OBSERVED`**.

### Why /demo/pnl

The current official guides *Calculate Available Cash*, *Calculate Total Invested*, *Calculate Profit/Loss* and *Calculate Equity* all read `GET /api/v1/trading/info/demo/pnl` (or `/real/pnl`), not `/portfolio`. `/demo/portfolio` is still documented and not deprecated. O21A.1 adds `/demo/pnl` as a **second, separate** observation source. `/demo/portfolio` remains supported unchanged; the sync adapter, service and runtime still read only `/demo/portfolio`.

### Transport

`ETORO_ALLOWED_OPERATIONS` has exactly two fixed operations, both GET, both under `/trading/info/demo/`: `portfolio.demo` → `/trading/info/demo/portfolio` (unchanged) and `pnl.demo` → `/trading/info/demo/pnl`. There is no caller-supplied URL, no generic method, no real route and no write route. Only the observation tool references `pnl.demo` (enforced by a test).

### Evidence classes for /demo/pnl

| Class | Meaning |
|---|---|
| REFERENCE_SCHEMA | The property definitions of the official reference (checked 2026-10-17). **Normative.** |
| REFERENCE_EXAMPLE | The example response on the same page. **Not normative.** |
| LIVE_OBSERVED | A real response. For `/demo/pnl`: an empty response, observed once through NEXUS and once independently outside NEXUS. The non-empty element shape remains **NOT LIVE_OBSERVED**. |

Schema and example contradict each other:

| Point | REFERENCE_SCHEMA | REFERENCE_EXAMPLE |
|---|---|---|
| Position ids | `positionID`, `instrumentID`, `CID`, `mirrorID`, `parentPositionID`, `orderID`, `redeemStatusID`, `settlementTypeID` | `positionId`, `instrumentId`, `cid`, `mirrorId`, `parentPositionId`, `orderId`, `redeemStatusId`, `settlementTypeId` |
| Position PnL | nested, nullable `unrealizedPnL` { `pnL`, `pnlAssetCurrency`, `exposureInAccountCurrency`, `exposureInAssetCurrency`, `marginInAccountCurrency`, `marginInAssetCurrency`, `marginCurrencyId`, `assetCurrencyId`, `closeRate`, `closeConversionRate`, `timestamp` } | flat `pnL`, `closeRate`, `closeConversionRate`, `timestamp` on the position, no `unrealizedPnL` |
| Mirrors | `mirrorID`, `CID`, `parentCID`, `mirrorStatusID` | `mirrorId`, `cid`, `parentCid`, `mirrorStatusId` |

Documented without contradiction: the pnl order schemas spell `orderId` / `instrumentId` (unlike `orderID` / `instrumentID` in `/demo/portfolio`); `leverage` is `integer` (a number in `/portfolio`); `ordersForOpen`, `ordersForClose` and `ordersForCloseMultiple` have element schemas here; `clientPortfolio` also has `unrealizedPnL` (number) and `accountCurrencyId` ("1 = USD").

### Parser (`src/broker/etoro/etoro-pnl-validation.ts`)

- Follows REFERENCE_SCHEMA only, with no aliases: `positionId` is not read as `positionID`, `orderID` is not read as `orderId`, and flat `pnL` / `closeRate` are not read as the nested `unrealizedPnL`. A response in the example's shape is BROKER_RESPONSE_INVALID at the first schema field it lacks.
- Read:
  - `positions`: the same NEXUS-required fields and bounds as the portfolio parser, plus integer `leverage` and the optional nested `unrealizedPnL` (→ `pnL`, `closeRate`, `timestamp`).
  - `orders`: `orderId`, `instrumentId`, `isBuy`, `amount`, `units`, integer `leverage`, `openDateTime`; optional `rate`, SL/TP and flags.
  - `ordersForOpen`: `orderId`, `orderType`, `statusId`, `instrumentId`, `isBuy`, `amount`, integer `leverage`, `openDateTime`; optional `amountInUnits`; `mirrorId` must be 0.
- `orderType` and `statusId` are kept as raw codes. Their values have no documented meaning (NOT_VERIFIED), and NEXUS gives them none.
- Must be empty: `mirrors`, `ordersForClose`, `ordersForCloseMultiple` (closing flows are not read), and `stockOrders` / `entryOrders` / `exitOrders` when present.
- Ids are positive safe integers. Numbers are finite and bounded. Timestamps are ISO 8601 with a zone. Duplicate ids are refused. Unknown fields are ignored and never kept. Errors name the field path only.
- `credit` must be present and a finite number. `bonusCredit`, the total `unrealizedPnL` and `accountCurrencyId` are type-checked when present. None of them is returned. **Cash stays `not_read`**: no `cash = credit`.
- Only the observation tool uses this parser. Nothing is stored, and no snapshot changes.

### Observation (`--source=pnl`)

- The report is built from the in-memory JSON first, independently of the parser. The parser verdict is computed afterwards and reported separately, so a shape the parser refuses is still fully described.
- Per container, observed fields are split into:
  - `schemaDocumentedPresent`: in the schema;
  - `exampleOnlyPresent`: not in the schema, but in the reference example;
  - `undocumentedPresent`: in neither;
  - `documentedMissing`: schema fields that no element has.
- Object fields list their inner key names (`objectKeys`). The nested `unrealizedPnL` is compared with its schema (`nested.schemaMissing`, `nested.undocumentedPresent`).
- With `--pseudonymize-ids`, ids are pseudonymized in both spellings. Instrument ids (`instrumentID` or `instrumentId`) appear only with `--show-instrument-ids`. The report contains no value, key or account id. Nothing is written to disk.
- One invocation sends one request. There is no default source and **no automatic fallback**: an empty portfolio never triggers a pnl read, and the reverse never happens either. There is no retry, and HTTP ≠ 200 fails closed with the status only.

### Fixtures

`test/broker/etoro/o21a1-pnl-fixture.ts`:
- **(A) REFERENCE_SCHEMA fixtures**: DOCUMENTED / REFERENCE_SCHEMA, NOT LIVE_OBSERVED.
- **(B) The verbatim reference example position**: REFERENCE_EXAMPLE, NOT NORMATIVE, NOT LIVE_OBSERVED. It is used only to prove that the parser refuses it and that the report still describes it.

There is no invented live payload.

### Tests

New: `o21a1-pnl-validation.test.ts` (61 tests) and `o21a1-observation.test.ts` (30 tests). Updated:
- `o20-boundary.test.ts`: two operations.
- `o21a-observation.test.ts`: `--source=portfolio`, and one call site over the two fixed operations.

### Open

- An empty `/demo/pnl` response is LIVE_OBSERVED.
- A non-empty `/demo/pnl` response remains NOT LIVE_OBSERVED. Whether a non-empty element follows the REFERENCE_SCHEMA or the REFERENCE_EXAMPLE shape is unknown.
- The credential/account context was checked manually (see above).
- Further demo reads are currently not useful.
- Blocker: **`NON_EMPTY_DEMO_PORTFOLIO_NOT_LIVE_OBSERVED`**.
- Cash stays `not_read`.
- `PORTFOLIO_SAFETY_NOT_CONNECTED` remains.
- `BUILD_LOCKS.etoroDemoExecution` remains `true`.

## 12. O21B – first non-empty /demo/portfolio observation (2026-10-18)

### Observation

| Item | Value |
|---|---|
| Request | Exactly one direct `GET /api/v1/trading/info/demo/portfolio`, made manually by the operator in Windows PowerShell 5.1 (`$global:demoCheck`, a parsed `PSCustomObject`), **outside NEXUS**, with the existing demo credentials. |
| `clientPortfolio` keys | The 11 documented keys; none missing, none undocumented. |
| `positions` | **1 entry**. |
| Every other container | `mirrors`, `orders`, `stockOrders`, `entryOrders`, `exitOrders`, `ordersForOpen`, `ordersForClose`, `ordersForCloseMultiple`: empty arrays. |
| The position | `instrumentID` 100001, `isBuy` true, `units` 0.04229, `openRate` 2364.57, `amount` 100, `leverage` 1, `openDateTime` `2026-10-18T16:38:25.877Z`. Direction, units, open rate and time match the ETH buy position visible in the eToro UI (checked by the operator). |
| Position keys | Exactly the **35 documented `TradingDemoApi_Position` fields**, spelled as documented (`positionID`, `orderID`, …): none missing, none undocumented. |
| Values relevant to section 9.2 | `openDateTime` carries `Z`. `positionID` and `orderID` are positive integers within the safe range; the export script would have stopped otherwise. `stopLossRate` 0.0001 with `isNoStopLoss` true; `takeProfitRate` 238821.57 with `isNoTakeProfit` false; `isTslEnabled` false; `orderType` 17; `mirrorID` and `parentPositionID` 0. |

Not observed in this response: a pending order, a non-empty `ordersForOpen`, any account identity. NEXUS itself did not make this read. The mapping `instrumentID` 100001 → ETH is the operator's comparison with the UI. It is **not** a human-governed `etoro` mapping, and none was registered.

The key and kind statements above come from the pseudonymized export, which saw the response only after PowerShell parsed it. They are not a complete check of the original response text.

### Private pseudonymized export (operator's machine, not in the repository)

The operator exported `$global:demoCheck` with a local script. No new eToro call was made. The export:
- keeps the fields `parseDemoPortfolio` reads, with the values as PowerShell parsed them;
- leaves absent fields absent, and matches field names case-sensitively (no aliasing);
- replaces every non-zero `positionID` / `orderID` / `mirrorID` / `parentPositionID` with a sequential pseudonym from `9100000001` (here: `positionID` → `9100000001`, `orderID` → `9100000002`). The JSON type is kept and the mapping is not stored;
- keeps `instrumentID` (a public market identifier) and the original `credit`;
- drops `CID`, `bonusCredit` and every other field the parser does not read, and lists them in `droppedFields` by **name and JSON kind only**.

Limits:
- The values passed through PowerShell's JSON parser, not the raw response text. `amount` appears as `100.0` (a PowerShell decimal); JSON reads it as the number 100.
- The raw response is not stored anywhere in the repository.

### Repository fixture: additional privacy transformation

`test/broker/etoro/o21b-live-demo-portfolio-2026-10-18.pseudonymized.json` is that export with **one additional privacy transformation**: `clientPortfolio.credit` (a positive number in the export) is set to **`null`**. The transformation is recorded in the file as `provenance.repositoryRedaction`.

The repository fixture is therefore **not byte-identical** with the private export. Position values and the pseudonymized ids are unchanged.

Because `parseDemoPortfolio` requires `credit` to be present and non-null (O20 rule, unchanged), the redacted fixture **does not pass** the full portfolio parser.

### Offline parser tests

1. **Before the redaction, private export (one run, 2026-10-18, not reproducible from the repository):**
   - The unchanged `parseDemoPortfolio` received the private export's `body`, with the original `credit`.
   - Result: **accepted**, 1 position, 0 orders, every field read as listed above.
   - `openOrder` was `{ orderId: 9100000002, orderType: 17 }`.
2. **Reproducible repository tests (`test/broker/etoro/o21b-live-portfolio.test.ts`, redacted fixture):**
   - `parseDemoPortfolio` **refuses** the redacted whole response with `BROKER_RESPONSE_INVALID` / `clientPortfolio.credit is missing`. This is expected and pinned.
   - The existing `parsePosition` **accepts** the single position, with exactly the values of run 1.
   - The fixture has one position and every other container empty.
   - Kept plus dropped position keys are exactly the 35 documented fields.

No parser or production rule was changed or relaxed. Both runs test the real (pseudonymized) response, not a reconstructed example. The documented fixture of section 6 stays as it is.

### Still open

- Why both 2026-10-17 `/demo/portfolio` reads and both `/demo/pnl` reads were empty while a position was open in the UI: **unexplained**. Today's response came from a different, direct read path; nothing was compared that would explain the difference.
- `/demo/pnl` was **not** read again. Its non-empty shape (REFERENCE_SCHEMA vs REFERENCE_EXAMPLE) remains NOT LIVE_OBSERVED.
- A non-empty read **through NEXUS** (`etoro:observe-demo --source=portfolio`, or the sync adapter) had not been made at the time of O21B. Update: the observation-tool read was made later the same day (O21C, section 13); the sync adapter has still not read a non-empty portfolio.
- Section 9.2 semantics stay NOT_VERIFIED:
  - `units` vs NEXUS quantity;
  - the meaning of `stopLossRate` 0.0001 / `takeProfitRate` 238821.57 (placeholder vs real trigger);
  - `orderType` 17.
- `instrumentID` 100001 has no human-governed `etoro` mapping. Reconciliation would report `unmapped_broker_instrument`.
- Cash stays `not_read`. `PORTFOLIO_SAFETY_NOT_CONNECTED` remains. Every `BUILD_LOCKS` entry stays `true`. No order, no write, no new permission.

## 13. O21C – first non-empty /demo/portfolio read through NEXUS (2026-10-18)

### What was run

- Code: the merged state `bf7432f` (merge of PR #23), unchanged, built locally.
- Tool: the O21A observation tool, run once by the operator with the existing demo keys and `ETORO_TRADING_MODE=demo`:
  `etoro-observe-cli --source=portfolio --confirm-live-read --pseudonymize-ids --show-instrument-ids`
- Exactly one `GET /api/v1/trading/info/demo/portfolio` through the O20 transport:
  - no retry, no `/demo/pnl` read, no fallback;
  - no write, no order;
  - no file written by the tool.
- Evidence: the sanitized JSON report printed by the tool, stored unchanged as `docs/evidence/O21C_etoro_demo_portfolio_observation_2026-10-18.json`. The report contains no value, no key and no account id. Ids appear only as per-run HMAC pseudonyms whose salt was never output. Instrument ids appear in clear, as requested with `--show-instrument-ids`. Nothing else from the operator's session is recorded.

### Result

From the report (it states kinds, signs and counts, never values):

| Item | Report |
|---|---|
| Top level | `clientPortfolio` only; no unnamed keys. |
| `clientPortfolio` | The 11 documented keys; `undocumentedKeys` and `documentedMissing` empty. `credit`: positive non-integer number. `bonusCredit`: integer zero. |
| `positions` | **count 1**. `schemaDocumentedPresent` lists all **35** documented `TradingDemoApi_Position` fields. `documentedMissing`, `exampleOnlyPresent` and `undocumentedPresent` are empty. |
| Other containers | `mirrors`, `orders`, `stockOrders`, `entryOrders`, `exitOrders`, `ordersForOpen`, `ordersForClose`, `ordersForCloseMultiple`: arrays, count 0. |
| Position field kinds | `positionID`, `orderID`, `instrumentID`, `CID`: positive integers. `mirrorID`, `parentPositionID`: integer zero. `openDateTime`: ISO 8601 with `Z`. `units`, `openRate`, `stopLossRate`, `takeProfitRate`: positive non-integer numbers. `amount`, `leverage`: positive integers. `isBuy`, `isNoStopLoss`, `isNoTakeProfit`, `isTslEnabled`: booleans. |
| Instrument ids | `[100001]` |
| Pseudonymous ids | One per id field. `mirrorID` and `parentPositionID` share one pseudonym because both are 0 (the tool pseudonymizes the value 0 too). |
| Parser verdict | **`accepted`, positions 1, orders 0** |

This agrees with the O21B observation (section 12): the same 35 position fields, the same empty containers, the same instrument id. The report does not show values, so it does not by itself prove that the position is the same one; position ids are pseudonymized with a different method and salt in O21B and O21C and cannot be compared.

Exit code 0 of the tool is **not** the evidence for the parser result. The evidence is the `parser` field of the report.

### What O21C does and does not show

| | O21B (section 12) | O21C (this section) |
|---|---|---|
| Read path | Direct GET by the operator, **outside NEXUS** | NEXUS observation tool, O20 transport |
| Parser | Unchanged `parseDemoPortfolio`, run **offline** on a private pseudonymized export (accepted); the repository fixture is credit-redacted and refused as a whole by design | Unchanged `parseDemoPortfolio`, run **in the tool** on the live body (**accepted**) |
| Evidence in the repository | Pseudonymized, credit-redacted fixture plus offline tests | Sanitized observation report (no values) |

**Not confirmed by O21C:**
- **Sync and reconciliation:** the sync adapter / broker service has not read a non-empty portfolio; no snapshot was stored; no reconciliation ran.
- **Instrument mapping:** `instrumentID` 100001 has no human-governed `etoro` mapping. None was registered, and nothing was mapped automatically.
- **Cash semantics:** `credit` was checked by kind only. Cash stays `not_read`.
- **Portfolio safety:** `PORTFOLIO_SAFETY_NOT_CONNECTED` remains. No safety source was built or connected.
- **Section 9.2 semantics:** still NOT_VERIFIED (`units` vs NEXUS quantity, SL/TP values, `orderType`).
- **Other containers and endpoints:** a non-empty `orders` (or any other container) and a non-empty `/demo/pnl` are still not observed. This observation is not generalized to them.
- **Earlier empty responses:** why the 2026-10-17 responses were empty remains **unexplained**.

Safety boundaries unchanged:
- No production code changed.
- Every `BUILD_LOCKS` entry stays `true`. `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`.
- No further eToro call.
