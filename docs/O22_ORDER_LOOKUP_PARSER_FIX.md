# O22 – Diagnosis and fix of the refused `orders:lookup` answer (20.10.2026)

**Scope: a parser and reconciliation fix. It is not a trading release.** All four build locks stay closed in this branch (`liveTrading`, `brokerOrders`, `physicalPurchase`, `etoroDemoExecution` = true). It sends nothing and books nothing. It also resets no budget and changes no stored record. No key, header, account id, order id or position id is recorded here, in a test or in a commit.

## 1. Diagnosis (one read-only GET)

After the controlled demo cycle (`O22_DEMO_CYCLE_RESULT_2026-10-20.md`), step 7 (`refresh`) was refused with `BROKER_RESPONSE_INVALID`. The cause was found with **one** read-only `GET demo/orders:lookup` for the stored order:

- It used the existing demo execution transport and the existing credentials.
- It made no write request, did not start the runtime and made no state transition.
- The raw body was evaluated in memory only.
- The output contained field paths, kinds and only the non-identifying enum values.

Result:

- HTTP 200.
- 25 top-level fields, matching the official reference.
- `status` has the fields `id`, `name` and `errorCode`.
- `asset` has the fields `currency`, `instrumentId`, `leverage`, `settlementType`, `side` and `symbol`.
- `positionExecutions` has exactly one entry with a positive integer `positionId` and `state` `"open"`.
- `positionsToClose` is empty.

| Field | Observed | Parser before the fix |
|---|---|---|
| `status.id` / `status.name` | documented id / `"Filled"` | accepted |
| `status.errorCode` | 0 | accepted |
| `orderId`, `asset.instrumentId`, `positionExecutions[0].positionId` | positive integers | accepted |
| `action` / `transaction` / `type` | `"open"` / `"buy"` / `"mkt"` | accepted |
| **`asset.settlementType`** | **`"REAL"`** | **refused**: the reference documents `cfd, real, realFutures, marginTrade`, and the check compared case-sensitively |
| `asset.side`, `asset.symbol`, `asset.currency` | `"long"`, `"ETH"`, `"USD"` | not read |
| `orderCurrency`, `requestType`, `openActionType`, `stopLossType` | `"usd"`, `"byAmount"`, `"customer"`, `"fixed"` | not read |

**Root cause:** `asset.settlementType` came back upper case (`"REAL"`), while the parser accepted only the documented lower-case spelling. The parser refused the whole answer at that field. The checks that come after the parser were therefore never evaluated:

- the order id compared with the stored order;
- the instrument.

They are evaluated for the first time on the next approved read.

## 2. The fix

1. **`asset.settlementType`**
   - It is compared with the four documented values without regard to letter case.
   - It is returned in the documented spelling (`"REAL"` → `real`).
   - Only an exact case-insensitive match is accepted. Anything else is still refused: no trimming, no prefix match, no number, no other word.
   - A missing value stays "not stated". All other enums (`action`, `transaction`, …) stay strictly case-sensitive.
2. **Diagnostic reason codes.** Every `BROKER_RESPONSE_INVALID` of the demo execution layer now carries a fixed, privacy-safe reason code.
   - The runtime passes the code on as the error's `reasons`, like the gate reasons.
   - A field refusal gets `INVALID_<FIELD PATH>`, for example `INVALID_ASSET_SETTLEMENTTYPE` or `INVALID_POSITIONEXECUTIONS_POSITIONID`. The code is derived only from the path written in the code, never from a value.
   - The checks have their own codes: `ORDER_ID_MISMATCH`, `INSTRUMENT_MISMATCH`, `ACTION_MISMATCH`, `TRANSACTION_MISMATCH`, `POSITION_NOT_UNIQUE`, `FILL_WITHOUT_POSITION`, `POSITION_WITHOUT_FILL`, `POSITION_CONTRADICTS_EARLIER_READ`, `ORDER_DOES_NOT_MATCH_INTENT`, `REFERENCE_ID_MISMATCH`, `POSITION_ID_MISMATCH` and `UNEXPECTED_HTTP_STATUS`.
   - The free-text detail is never copied into the API answer.
3. **Order status of an open (`applyStatus`)**. Before this fix, these checks applied only to the AMBIGUOUS reconciliation. They now apply to every order status read of an open, in addition to the existing checks of the order id and the instrument:
   - the read must state `action` `open`;
   - the read must state the intent's direction: `buy` for a buy, `sellShort` for a sell. A missing value is not a match.
   - A fill (also a partial fill) must name **exactly one** position.
   - A pending or rejected order must name none.
   - No read may name more than one position.
   - Every read must name the same position as the earlier reads of the intent.

   Every check runs **before** anything is recorded. A refused answer stores no confirmation and changes no state. Without a confirmed position, no close can be prepared (`closePositionOf` needs exactly one).

4. **No partial record (review finding on PR #28).** Before this correction, the AMBIGUOUS reconciliation stored the `found` reconciliation and the step to `RECONCILED` *before* `applyStatus` ran the checks above. A `Filled` without a unique position was then refused, but only after state had already been persisted. `applyStatus` also stored the confirmation before it checked the transition.
   - Every check now runs in one write-free step (`planStatus`): order id, instrument, action, direction, positions and the allowed transition. For the AMBIGUOUS path, it also covers `AMBIGUOUS → RECONCILED` and the transition from `RECONCILED`.
   - This step runs before the first record. A refused answer leaves no `found` reconciliation, no confirmation and no state change, and the intent stays `AMBIGUOUS`.
   - Through the public paths, a refused transition is currently not reachable: every state `refresh` accepts allows every target. The reordering is a safeguard.

**What stays unchanged:**

- The append-only histories, idempotency rules, at-most-once guarantees and the cycle budget (a refused read does not free it).
- `refresh()` only reads (GET). It is refused in `FILLED`.
- The reconciliation reports a position that no confirmed read bound as external. It never takes such a position over.

## 3. Tests (offline, no network)

- **`test/broker/etoro/o22-order-lookup-parser.test.ts` (25 tests, no lock mock):**
  - the live-like structure with `"REAL"`;
  - every documented settlement type in any case, and refused variants;
  - strict other enums;
  - pending and partial statuses, and unknown status ids;
  - missing, null and invalid fields, and invalid position ids;
  - no value in a refusal;
  - the runtime reason mapping;
  - the four build locks closed.
- **`test/broker/etoro/o22-order-lookup-refresh.test.ts` (36 tests, lock mocked for this module only):**
  - the live-like answer → `FILLED` with one position and `real`;
  - pending → partial → filled;
  - another order id, instrument, action or direction;
  - missing action or transaction;
  - two positions, a fill without a position, a pending or rejected order with a position;
  - a contradicting later read, an unknown status, an invalid settlement type or position id, a missing order id.

  Each refusal checks that:
  - the state is unchanged and nothing was recorded;
  - only a GET was sent;
  - no close is possible.

  An AMBIGUOUS block (11 tests) covers a fill without a position, two positions, a contradictory `positionsToClose`, a pending or rejected order with a position, an invalid position id, and another instrument or direction. For each, it asserts:
  - the state stays `AMBIGUOUS` with the history unchanged;
  - there is no reconciliation and no confirmation;
  - only a GET was sent and exactly one write ever;
  - the budget is unchanged and no close is possible.

  A valid answer afterwards, even after a restart, reconciles exactly once. On the previous commit `da4fbfa`, 8 of the 11 fail; the other 3 were already refused before any record.

  It also covers:
  - a repeated refresh after a restart, where the open was written exactly once and `FILLED` is final;
  - a budget that stays spent;
  - the reconciliation, where the position stays external and the open `outcome_pending`.
- **Test data:** `test/broker/etoro/o22-order-lookup-fixture.ts` is a synthetic answer with the observed structure; all ids, amounts and times are artificial.
- **Proof the tests catch the defect:** run on the source before the fix, 47 of the 50 new tests fail, including the live-like case.
- **One adjusted O21 test:** it had accepted a `Filled` without a position as `FILLED`. It now expects the refusal `FILL_WITHOUT_POSITION`, and its point (no close without a confirmed position) is still asserted.

## 4. State of the ETH demo position

**Unchanged and unresolved:**

- NEXUS's open intent stays `SUBMITTED`.
- The budget is open 1/1 and close 0/1.
- The ledger has 0 transactions.

This fix records nothing for it. A later refresh would need:

- a build with this fix;
- the execution routes switched on (`ETORO_DEMO_EXECUTION_ENABLED=1`). The routes exist only then; the build lock refuses writes, not the read-only `refresh`;
- an explicit decision by the operator. **It is not authorized by this change.**

A later refresh would bind the position only if:

- the order id, instrument, action, direction and the unique position all match;
- every check above passes.

Until then, the position is closed by hand only and no automatic close is possible.
