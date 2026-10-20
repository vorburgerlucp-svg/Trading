# O22 – Result of the controlled eToro demo cycle (20.10.2026)

**Test verdict: NOT PASSED – stopped at runbook step 7 (`incomplete`).** The open was sent once and accepted by eToro; NEXUS could not read its order status (`orders:lookup` answer refused by the parser), so the fill and the position could not be proved and the regular close through NEXUS was not possible. **One ETH demo position is open and needs manual clarification.** No key, header, account id or broker order id is recorded here.

## Build and preparation

- `main` at `7a2eef3` (merge of PR #26, release of the demo lock); tree identical to the reviewed release `38b08d4`. Run from the local branch `run/o22-demo-cycle` in the O22 worktree.
- Pre-checks (read only): eToro demo mode, `TRADING_MODE` paper and live trading locked (defaults); ETH/USD `ins_adcd4ec5-84ff-402c-8971-2c333e2b18fc` crypto, USD, active; eToro 100001 mapped to it; kill switch armed (log sequence 0); no execution log (budget 0/1, 0/1); no ledger rows.
- First start refused: `LedgerError store_unavailable` – the ledger `main` did not exist in the NEXUS database (the runtime opens it read-only for the broker reconciliation). Nothing was sent. With the operator's approval the empty ledger `main` was initialised once through the regular path `PostgresLedgerStore.open(pool, { ledgerId: 'main' })`: base currency CHF, no transaction, line, balance or reservation.

## The cycle (runbook 17.3)

| Step | Time (UTC) | Result |
|---|---|---|
| 1 health | 07:48 | paper, live trading locked; locks: `liveTrading`, `brokerOrders`, `physicalPurchase` true, `etoroDemoExecution` false; execution enabled, market data production, operator auth configured |
| 2 sync + cycle | 07:48:42 | 0 positions, 0 open orders, reconciliation `consistent`, policy v2, budget open 0/1, close 0/1 |
| 3 quote | 07:48 | USD, `twelvedata:quote:production`, 58.5 s old (1st try) |
| 4 create | 07:48:56 | open intent `eint_f10e871f377f0e43509e3bf8ab1f94329cdfd49f`: buy ETH, market, 100 USD, leverage 1 – `RISK_APPROVED`, no gate reason (the account safety source read `/demo/pnl` once) |
| 5 approve | 07:49 | `APPROVED` by `luc-vorburger` |
| 6 quote + execute once | 07:49 | quote 21.2 s old (1st try); execute: one write, HTTP 200, `SUBMITTED` (broker order id recorded) |
| 7 refresh | 07:49 | **`BROKER_RESPONSE_INVALID`** ("the broker response does not match the expected read-only schema") for the order status read. Not repeated; stop. |

One read-only sync afterwards (07:49:52): **1 position** – eToro instrument 100001 (ETH), direction buy, amount 100 USD, leverage 1, opened 07:49:22 – and 0 open orders. The cycle route reports the reconciliation `unknown` (`OUTCOME_PENDING`, `EXTERNAL_POSITIONS_PRESENT`) and the test verdict `incomplete` (`OPEN_PENDING`, `ACTIVITY_NOT_YET_ATTRIBUTABLE`): without a valid order status NEXUS cannot bind the position to its open. The timing and the parameters match the NEXUS order, but that is **not** a proof by NEXUS's rules.

## Stored state (read only, after the stop)

- Intent log: `CREATED → RISK_APPROVED → APPROVED → SUBMITTING → SUBMITTED`; attempts: one `demo.order.open` started and finished `accepted` (HTTP 200); one confirmation `open_accepted` without position; no reconciliation record.
- **Budget: open 1/1 spent, close 0/1.** A new open is refused; a close through NEXUS needs a broker-confirmed position, which is missing.
- Ledger: `main` exists (CHF), **0 transactions**. Kill switch unchanged (sequence 0).

## Closing state (proved)

- `ETORO_DEMO_EXECUTION_ENABLED=0` in the worktree `.env`.
- The runtime process was stopped (one process before, **0 after**); port 8799 not listening; `/api/health` not reachable. A `.env` change alone was not taken as proof.
- Re-lock prepared: branch `feature/o22-b1-relock`, `git revert -m 1 7a2eef3` on the current `main` (no later changes on `main`; the tree equals the locked `6d3e433`).

## Open for the operator

1. **Manual clarification of the open ETH demo position** (100 USD, opened 07:49:22 UTC) in the eToro demo account. NEXUS does not close it. If it is closed by hand, a read-only sync then shows the account empty; the NEXUS open intent stays `SUBMITTED` (its outcome was never proved).
2. **The cause of the refused `orders:lookup` answer** (first live response of this endpoint): it is not known which field differs. Finding it needs the sanitized structure of one live answer (for example one approved read-only observation that reports keys and kinds only, like the existing observation tool) and then a reviewed parser change.
3. Whether the re-lock is merged now; a later attempt needs a new reviewed release and – because the open budget of this database is spent – a deliberate decision about the budget.
