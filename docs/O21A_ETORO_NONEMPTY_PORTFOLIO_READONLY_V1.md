# O21A – eToro Non-empty Demo Portfolio Read-only V1

Status: implemented. `/demo/portfolio` LIVE_OBSERVED twice (2026-10-17), HTTP 200, **empty** both times. `/demo/pnl` (O21A.1, section 11) DOCUMENTED, **not live-observed**. Base: `origin/main` = `ae6a984` (merge of PR #20, O21).

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
| Element schema of `positions` and `orders` | DOCUMENTED only |
| Any non-empty container | **NOT live-observed** |
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

`test/broker/etoro/o21a-documented-fixture.ts` is the official reference example, field for field. It is marked **documented fixture — NOT live-observed** (`FIXTURE_PROVENANCE = 'documented_fixture_not_live_observed'`). No real payload was copied, and there is no "real payload fixture". After the live read, the observation report is compared with this structure.

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
- Broker writes: 0. Real endpoints: 0. Allowed eToro read operations: still only `portfolio.demo`.

## 9. Remaining blockers

1. No live non-empty demo response observed. Every non-empty parse path rests on the documentation.
2. Semantics to confirm live: `units` vs NEXUS quantity (leverage/CFD vs real asset), sign/meaning of `stopLossRate`/`takeProfitRate` = 0, timestamp format (zone present?), whether ids fit safe integers.
3. Where an order placed via O21 appears before execution (`orders` vs `ordersForOpen`). `ordersForOpen` has no documented element schema; while non-empty, the whole read is refused.
4. Cash authority (`credit`, `bonusCredit`) not decided.
5. No account identity in the payload.
6. Human-governed `etoro` mappings must exist for the instruments held, before reconciliation can match.
7. The eToro demo portfolio safety source (next step) is not built.

## 10. First live read (after approval)

1. A human opens a small position in the eToro **demo** account (manually in the eToro UI; not through NEXUS — the O21 lock stays closed).
2. `npm run etoro:observe-demo -- --source=portfolio --confirm-live-read --show-instrument-ids` with demo keys in the environment.
3. Compare the report against section 2 and the documented fixture: `documentedMissing`, `undocumentedPresent`, kinds, parser verdict.
4. Record the result here as LIVE_OBSERVED, then decide on the mapping and the safety source.

## 11. O21A.1 – /demo/pnl read-only observation support

### Live observations of /demo/portfolio (2026-10-17)

| Read | Result |
|---|---|
| 1 (portfolio empty in the UI) | HTTP 200, one GET. `clientPortfolio` with all 11 documented keys, none undocumented, none missing; every container an empty array; `credit` a positive non-integer number, `bonusCredit` the integer 0; parser accepted (0 positions, 0 orders). |
| 2 (after a demo position was opened manually in the eToro UI) | HTTP 200, one GET. **Identical structure, every container still empty**; parser accepted (0/0). |

LIVE_OBSERVED is therefore the empty container structure of `/demo/portfolio`. The position visible in the UI was **not** in the response. The cause is not documented. The account/key scope of the user key (environment, login, agent-portfolio or sub-account token) is **unresolved**.

### Why /demo/pnl

The current official guides *Calculate Available Cash*, *Calculate Total Invested*, *Calculate Profit/Loss* and *Calculate Equity* all read `GET /api/v1/trading/info/demo/pnl` (or `/real/pnl`), not `/portfolio`. `/demo/portfolio` is still documented and not deprecated. O21A.1 adds `/demo/pnl` as a **second, separate** observation source. `/demo/portfolio` remains supported unchanged; the sync adapter, service and runtime still read only `/demo/portfolio`.

### Transport

`ETORO_ALLOWED_OPERATIONS` has exactly two fixed operations, both GET, both under `/trading/info/demo/`: `portfolio.demo` → `/trading/info/demo/portfolio` (unchanged) and `pnl.demo` → `/trading/info/demo/pnl`. There is no caller-supplied URL, no generic method, no real route and no write route. Only the observation tool references `pnl.demo` (enforced by a test).

### Evidence classes for /demo/pnl

| Class | Meaning |
|---|---|
| REFERENCE_SCHEMA | The property definitions of the official reference (checked 2026-10-17). **Normative.** |
| REFERENCE_EXAMPLE | The example response on the same page. **Not normative.** |
| LIVE_OBSERVED | A real response. **None yet for /demo/pnl.** |

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

- `/demo/pnl` is NOT LIVE_OBSERVED. Whether a live response follows the REFERENCE_SCHEMA or the REFERENCE_EXAMPLE shape is unknown; the report will show it.
- The account/key scope is unresolved (see above).
- Cash stays `not_read`.
- The next `/demo/pnl` read needs a separate, explicit approval, for exactly one run of `npm run etoro:observe-demo -- --source=pnl --confirm-live-read --pseudonymize-ids --show-instrument-ids`.
