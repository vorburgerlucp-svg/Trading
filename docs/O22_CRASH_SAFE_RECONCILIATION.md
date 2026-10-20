# O22 – Crash-safe status check and parallel processes (20.10.2026)

**Scope: persistence and recovery of the demo status check. It is not a trading release.** It is stacked on the parser fix (PR #28), which is stacked on the re-lock (PR #27). All four build locks stay closed. Nothing here sends, books, resets a budget or changes a stored record of the real demo account.

## 1. The logs and the gaps

One status check writes to three separate append-only logs:

- `etoro-demo-execution-intents`: the states;
- `etoro-demo-broker-confirmations`: the status reads;
- `etoro-demo-execution-reconciliations`: the `found` / `not_found` lookups by reference.

Each log has its own critical section: a PostgreSQL transaction with `SELECT … FOR UPDATE` on the log head row, then a catch-up with other processes, then the precondition. No transaction spans two logs. A status check is therefore a sequence of records:

| Path | Records |
|---|---|
| SUBMITTED / ACCEPTED / PARTIALLY_FILLED | ① confirmation → ② state (e.g. `FILLED`) |
| AMBIGUOUS | ① `found` reconciliation → ② `RECONCILED` → ③ confirmation → ④ state |

**Before this change**, a crash between two of these records was handled as follows:

| Crash after | Effect before this change |
|---|---|
| `found` | A new lookup wrote a second `found` record. |
| `RECONCILED` | **Blocked for good.** The order id came only from confirmations, so `refresh` refused with "no broker order id". |
| a confirmation | The stored, checked evidence was ignored, and a new read was needed. |

Two processes could also store contradicting confirmations, because the evidence checks ran on a process-local, possibly stale view. A confirmation was also not bound to the state it had been checked against.

## 2. Decision: deterministic, idempotent roll-forward (no cross-log transaction)

A transaction across logs would need a new multi-log store API with a new lock order across the head rows of several logs. That would be a deep change to the persistence layer that every other log relies on. The existing building blocks are enough for a deterministic recovery:

- **Each record states what it was checked for.**
  - A status read stores `appliesFrom`, the state it was fully checked against, and `target`, the state it leads to (or `null`).
  - A `found` record stores `checked: true`, which means the whole answer was checked before it was written.
- **A transition accepts only matching evidence.**
  - A status read can carry only the transition it was checked for: of its intent, from `appliesFrom`, to `target`.
  - `RECONCILED` needs a checked `found` record of the intent.
  - A stale read can therefore never move a state that has changed in the meantime.
- **Roll-forward (`rollForward`, public `recover(intentId)`).** It makes **no broker request**. It completes what the stored evidence proves:
  - AMBIGUOUS with a checked `found` record → `RECONCILED`;
  - a status read stored for the current state whose transition is missing → that transition.

  Every step is an ordinary transition. It has a fixed record id per state and a precondition on the current state under the log lock. A repeated or concurrent recovery therefore records each step exactly once. `refresh` runs the roll-forward first, and reads the broker only when the evidence does not decide yet.
- **The order id of a `RECONCILED` intent** comes from its `found` record. `RECONCILED` is no longer blocked: the next `refresh` reads the order by that id (one GET).
- **Persistent preconditions** inside the log locks, after catching up with every process:
  - **`found`:** if another process already found the same order, the second process stops with `RECONCILIATION_PENDING` (refresh again). If it found another order, it stops with `RECONCILIATION_CONFLICT`.
  - **confirmation:** a new status read must agree with every stored read of the intent:
    - the same order (`ORDER_ID_CONTRADICTS_EARLIER_READ`);
    - the same position (`POSITION_CONTRADICTS_EARLIER_READ`);
    - never back from a fill to an unfilled outcome, and never another outcome once a final one is stored (`STATUS_CONTRADICTS_EARLIER_READ`).

  A stale check of a second process can therefore not store a contradicting read.
- **Safe stop.** In each of these cases the process stops and stays where it is, AMBIGUOUS or its current state:
  - contradicting `found` records (`RECONCILIATION_CONFLICT`);
  - a `found` record that was not checked (older code), which is never rolled forward;
  - a read stored for another state;
  - any contradiction above.

  Nothing is guessed. **A broker write is never repeated:** the execute path is unchanged, and recovery and refresh only read.

## 3. Tests

- **`test/broker/etoro/o22-fault-store.ts`:** a store wrapper that simulates a crash at a chosen record. With `before`, the write rolls back. With `after`, it commits and then the process dies.
- **`test/broker/etoro/o22-recovery-scenarios.ts`:** shared scenarios with the invariants:
  - `FILLED` once, with exactly one position;
  - exactly **one** broker write ever, and the budget at open 1/1 and close 0/1;
  - every stored read agrees;
  - the `FILLED` step carries the read checked for it;
  - exactly one checked `found` on the AMBIGUOUS path;
  - `recover()` sends no request, and a restart reads at most one GET;
  - a further `refresh` sends nothing.
- **`test/broker/etoro/o22-crash-recovery.test.ts` (in memory, 19 tests):**
  - a crash before and after every step of both paths (12 cases);
  - `RECONCILED` without a read is not blocked;
  - a repeated `recover()` is idempotent;
  - the safe stops: conflicting `found` records, an unchecked `found`, a read for another state, a partial fill followed by pending;
  - two processes with a stale contradicting read.
- **`test/pg/o22-crash-recovery.pg.test.ts` (real PostgreSQL, own pool per process, 17 tests):**
  - a crash before and after every step of both paths, with the restart on another pool (12 cases);
  - two processes refreshing the same AMBIGUOUS intent at once;
  - two processes that find different orders → `RECONCILIATION_CONFLICT`;
  - a stale contradicting read → refused;
  - a stale but agreeing read → no second state;
  - two processes recovering at once → each step recorded once.
- **On the service code before this change** (`82c5e4c`), all 19 in-memory tests fail. Some of them fail simply because `recover()` did not exist yet. The blocked `RECONCILED`, the duplicate `found` and the stale contradiction are real failures of the old code.

## 4. Remaining risks

1. **Still no cross-log atomicity.** A crash leaves a gap; it is no longer corrupted state. The gap closes on the next `recover()` or `refresh()`, which an operator or a later process triggers: there is **no automatic background recovery** and no recovery at startup. Until then, the view can show the earlier state while a newer checked read is already stored.
2. **A crash before the confirmation commits needs one more read-only GET** after the restart. That is a broker read, which needs the execution routes and an operator decision. For the real ETH intent, **no refresh is authorized**.
3. **`RECONCILIATION_PENDING` on a lost race.** The losing process does not complete the check itself: it stops, and the next `refresh` / `recover()` completes it.
4. **Stricter evidence rules can stop a legitimate sequence:** a fill followed by a broker-reported `cancelled` or `pending`, or a final outcome followed by a correction. Each of these stops safely (the intent stays where it is) and needs manual clarification.
5. **Records of older code:** a `found` record without `checked` and status reads without `appliesFrom` are never used for roll-forward. Such an intent needs a new, fully checked read. The real database holds only the `open_accepted` confirmation of the ETH open, no status read and no reconciliation.
6. **One clock per machine:** as in the operating rules of 17.6 (N7).
7. **The re-lock (PR #27) is still open.** `main` (`7a2eef3`) has the demo execution lock open until #27 is merged. #28 and this PR are stacked on #27 and must not be merged before it. Neither is a trading release.
