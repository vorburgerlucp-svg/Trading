# O22 – Closure of the first controlled demo cycle (as of 23.10.2026)

**Verdict: the cycle is NOT passed and NOT proved by NEXUS.** The open was sent once and accepted. According to the operator, the position was then closed by hand in the eToro demo account, outside NEXUS (an observation; see section 3). NEXUS proved neither the fill, nor the binding of the position to its order, nor the close. **No success is claimed.** This document records nothing in the database and authorizes nothing. No key, header, account id, order id or position id is recorded here.

## 1. Code and repository

- At the time of writing, `main` was at `53d2848`, with PR #27 (re-lock, `4a10a1c`), PR #28 (parser fix, `f871868`) and PR #29 (crash-safe status check, `53d2848`) merged on 20.10.2026. Its tree is identical to the reviewed `c7dc62a`.
- NEXUS CI is green on `53d2848`.
- **Build locks on `main`:** `liveTrading`, `brokerOrders`, `physicalPurchase` and `etoroDemoExecution` are all `true` (closed).
- At the time of writing, the local `main` was fast-forwarded only. The tree was clean, and no foreign change was touched.

## 2. Stored state of the cycle (read only, 23.10.2026)

The database was read as `nexus_readonly` with `default_transaction_read_only=on`. No broker request was made, and the runtime was not started.

| Log | Content |
|---|---|
| Intent (`etoro-demo-execution-intents`) | `CREATED` 07:48:58 → `RISK_APPROVED` 07:48:59 → `APPROVED` 07:49:08 → `SUBMITTING` 07:49:21 → **`SUBMITTED`** 07:49:22 (UTC, 20.10.). Nothing after it. |
| Attempts | one `demo.order.open`: `started` then `finished accepted`, HTTP 200. No other write of any kind. |
| Broker confirmations | one `open_accepted` without a position. **No order status read.** |
| Execution reconciliations | none |
| Sync events / snapshots | two syncs on 20.10. One at 07:48:42 showed 0 positions and 0 orders. One at 07:49:52 showed **1 position**: instrument 100001, buy, leverage 1, opened 07:49:22, 0 orders. **There is no sync after the manual close.** |
| Account valuations | two, both before the write (07:49:21) |
| Kill switch (`portfolio-kill-switch`) | no record: never tripped, armed |
| Ledger | ledger `main` (CHF) exists; **0 transactions, 0 lines** |
| Cycle budget (policy v2) | **open 1/1 spent, close 0/1.** It is counted over the whole intent log and can never be reset. |

## 3. The manual close: observation, not verified broker history

| | Source | Status |
|---|---|---|
| The position was closed by hand in the eToro demo account | operator's statement | **observed, not technically verified** |
| The virtual portfolio was then shown as empty | the operator's screenshot / app view | **observed, not technically verified** |
| A portfolio read without the position | none: the last NEXUS snapshot (20.10. 07:49:52) still shows it open | **not available** |
| Close time, close price, P&L, fees | none | **not available** |
| Broker trade history of the close | NEXUS has no read of it. The read-only operations are: O20 `portfolio.demo`, `pnl.demo`, `instrument.metadata.100001`, `identity.me` (`etoro-readonly.ts`), and the execution layer's `demo.order.lookup` (`orders:lookup` by order id or reference id) and `demo.closeOrder.info` (`close-orders/{orderId}`, needs the id of a close order NEXUS sent) (`etoro-demo-execution-endpoints.ts`). None of them is a trade history. `orders:lookup` reports a state for each position execution (`"open"` on 20.10.); whether it shows a hand close is **not verified**. | **not available** |

The NEXUS records therefore say: one open accepted, and one position seen open 30 s later. The close exists only as an observation outside NEXUS.

## 4. Evidence still missing for a unique attribution

1. **Order → position binding.** No status read (`orders:lookup`) of the stored order was ever accepted. The one diagnostic read of 20.10. was refused by the old parser before the order id and instrument checks, and its position id was not compared. Since PR #28 the parser accepts the observed structure. **One authorized read-only `orders:lookup`** of the stored order would bind the order id to exactly one position id, and show whether the order is filled.
   *Audit addition (23.10.2026, D6):* the stored snapshot of 20.10. 07:49:52 names the stored NEXUS order as the opening order of its one position. That technically binds the order to the position in stored broker data, without a status read. See section 7.
2. **The position seen on 20.10. is that position.** This needs the same position id in the snapshot of 07:49:52 and in the order status read. Today, only timing and parameters match, which by NEXUS rules is no proof.
   *Audit correction (D6):* not only timing and parameters match. The snapshot's `openOrder.orderId` equals the stored order id. What is still missing is a status read in the sense of the NEXUS rules.
3. **The close.** This needs:
   - a portfolio read after the close that no longer shows the bound position (one authorized read-only sync);
   - a broker record of the close: time, rate, P&L. NEXUS has no allowed operation for that, so it would need a new, reviewed read-only endpoint.
4. **That the close was the operator's, not a stop-loss or other closure.** This is the operator's statement only; broker history would prove it.

None of these reads is authorized by this document. Each needs a separate decision.

## 5. Why the database blocks every further cycle (by design)

The open intent stays `SUBMITTED`, and NEXUS has **no path** for a position closed outside NEXUS:

- **Gate on a new open.** A new open is refused with:
  - `CYCLE_OPEN_BUDGET_EXHAUSTED` (budget 1/1);
  - `OPEN_POSITIONS_ABOVE_LIMIT`: the `SUBMITTED` intent counts as live at the broker (`maxOpenPositions` 1);
  - `INSTRUMENT_HAS_LIVE_POSITION_OR_ORDER` for ETH;
  - `GROSS_EXPOSURE_ABOVE_LIMIT` (100 USD live + 100 USD new > 100 USD);
  - and, depending on the moment, the freshness checks of quote, safety decision and sync.
- **A later `refresh`, after an authorized read, would at best reach `FILLED`.** A `FILLED` open still counts as live until a **NEXUS** close of its position is `FILLED`. A hand close does not count. With a new snapshot taken after that `FILLED` entry, the cycle reconciliation would then report `open_position_missing`, which is `inconsistent`; with the existing snapshot of 20.10. (taken before such an entry) it reports `snapshot_predates_intent`, which is `unknown`.
- **NEXUS cannot close the position.** Today the close is blocked because the open is `SUBMITTED`: a close needs an open that is `FILLED` or `PARTIALLY_FILLED` with exactly one position confirmed by a broker status read (`closePositionOf`, `closeTargetKnown`). Those checks use the NEXUS logs only. On the code of `78dc9be` they did not check whether the broker still shows the position: after a `refresh` to `FILLED`, a close of the already closed position would have been accepted, and with the lock and the switch open it would have been sent and spent the close budget (audit D4). The fix (PR from `fix/o22-close-position-evidence`) requires a fresh, complete stored broker snapshot that still shows the position; see `O22_CLOSE_POSITION_EVIDENCE.md`. Until that is merged: never `refresh` followed by a close on this database.

This is safe (nothing can be sent), but it means **no new demo cycle is possible on this database** without a reviewed change.

## 6. Plan for the next controlled demo cycle (proposal; nothing authorized)

Each step needs its own review and approval. No new budget, order, close, broker write or release follows from this plan.

**A. Close the evidence of cycle 1 (read-only, optional, each read separately authorized)**

1. One `orders:lookup` of the stored order through the fixed parser, as a **dry evaluation without `refresh`**: no record, no state change. **Such a tool does not exist yet** (the diagnostic script of 20.10. was a local, unversioned script). It must first be written, tested and reviewed as a read-only tool. It would confirm the order → position binding through a status read.
2. One portfolio sync, which would give the absence of the position.
3. Decide whether a broker close history is needed. If so, specify and review a new fixed read-only endpoint first.

**B. A recorded, reviewed way to settle an externally closed position (code, then review)**

- An append-only **operator attestation** "closed outside NEXUS". It is permitted only when all of these hold:
  - an authorized status read bound the order to exactly one position;
  - a later snapshot no longer shows it;
  - the operator confirms it.

  It ends the open's liveness without claiming a fill or close by NEXUS, books nothing, and is visible as `closed_externally` in the reconciliation and the test verdict, never as `passed`.
- Without all of this evidence, the intent stays as it is (safe stop).

**C. A budget for a new cycle (decision, then code)**

The O22 budget can never be reset, and that stays so. A new cycle needs a deliberate, recorded scope, for example a **new policy version** whose budget counts only the intents created under it, with the earlier cycle's intents remaining in the log and still blocking while they are live. The alternative, a fresh database, loses the history and is not proposed.

**D. Before any new demo write**

- Read-only checks:
  - all locks closed;
  - CI green;
  - the cycle route `consistent` on a fresh snapshot;
  - no live or ambiguous intent;
  - kill switch armed.
- A new release PR that opens only `etoroDemoExecution`, with its re-lock prepared in advance, as with B1/#27.
- The runbook (17.3) amended:
  - step 7 (`refresh`) is expected to pass now;
  - if it does not, the stop and the evidence above apply;
  - a hand close counts as a manual intervention and fails the test.

**Next safe development step:** B, the reviewed attestation of an externally closed position, as code and tests only, with all locks closed. Before it, A.1 and A.2 as two separately authorized read-only reads, if the evidence of cycle 1 is to be completed.

## 7. Corrections after the audit of 23.10.2026

A read-only audit (an AI agent, not a human review) checked this document against the code at `78dc9be` and the database. The statements below were corrected in place. The historical facts are unchanged; the original wording is kept here.

| # | Section | Original statement | Correction |
|---|---|---|---|
| D1 | 3 | "NEXUS has no read of it: the allowed reads are portfolio, pnl, instrument metadata and `/me`." | All read-only operations are listed, including the execution layer's `orders:lookup` and `close-orders/{orderId}`. The conclusion is unchanged: there is no trade history. |
| D2 | 5 | "The cycle reconciliation would then report `open_position_missing`" | Only with a new snapshot taken after the `FILLED` entry. With the snapshot of 20.10. the result is `snapshot_predates_intent` (`unknown`). |
| D3 | verdict | "The position was closed by hand by the operator" | Marked as the operator's observation. |
| D4 | 5 | **NEXUS cannot close the position.** The close budget is still 0/1, but a close needs a broker-confirmed open position, which no longer exists. | The close checks were log-based and did not check the broker's current position (fixed by a separate code PR). |
| D5 | 6 A.1 | "run as a dry evaluation without `refresh`" | The tool does not exist yet and must be developed first. |
| D6 | 4 | 2. **The position seen on 20.10. is that position.** This needs the same position id in the snapshot of 07:49:52 and in the order status read. Today, only timing and parameters match, which by NEXUS rules is no proof. | **New finding from stored data (no broker request):** in the stored snapshot of 20.10. 07:49:52, the one position states as its opening order (`openOrder.orderId`) exactly the broker order id that NEXUS stored for the open (`open_accepted`). The order → position binding is therefore **technically shown in stored broker data**. It is not a status read in the sense of the NEXUS rules (`FILLED` and the position binding of the execution layer still need one), and the identity of the two id spaces rests on the reference's description of `orderID`. |
| I1 | 1 | "`main` is at `53d2848`" | Marked as the state at the time of writing; `main` is now `78dc9be` (PR #30). |
| I2 | 5 | three gate reasons | `GROSS_EXPOSURE_ABOVE_LIMIT` and the freshness checks added. |
