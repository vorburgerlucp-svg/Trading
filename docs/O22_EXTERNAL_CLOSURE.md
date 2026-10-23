# O22 Plan B – Recording a position closed outside NEXUS (23.10.2026)

**Scope:** code and tests only. **This is not a trading release, and nothing was run in production:**
- all four build locks stay closed;
- no broker request was made;
- the O22 database was not touched;
- no budget was reset.

## Problem

In cycle 1 the position was closed by hand outside NEXUS. NEXUS has no record type for that. As a result:
- an open stays live for NEXUS until a **NEXUS** close of its position is `FILLED` (`book()`, `LIVE_AT_BROKER_STATES`);
- a hand-closed position therefore counts against `maxOpenPositions`, the exposure limit and "one live intent per instrument", **with no end date**;
- the cycle reconciliation reports it as `open_position_missing` (`inconsistent`).

## Architecture

**A separate append-only record, not an intent state.** The log `etoro-demo-external-closures` holds `ExternalClosureRecord`s (schema `etoro-demo-external-closure:v1`).

- **Intent and broker records stay untouched.** The intent keeps its state (`FILLED`), and its history is not changed.
- **No confirmation is written.** No broker confirmation, attempt or reconciliation record is added, so a NEXUS close order cannot be faked and no execution is backfilled.
- **No booking or budget change.** No ledger posting is made; the budget counts the intents that reached `SUBMITTING`, and that count does not change.
- **One record per position.** The record id is `eext_` plus the hash of (open, position).

| Part | File |
|---|---|
| The rule (pure): evidence complete or not, with fixed reason codes | `src/broker/etoro/execution/external-closure.ts` (`externalClosureRefusals`) |
| Recording, check in the lock, liveness, open check | `etoro-demo-execution-service.ts` (`attestExternalClosure`, `book()`, `runGate`, reservation) |
| Open check (pure) | `external-closure.ts` (`externalClosureOpenRefusals`), wired through `execution-gate.ts` |
| Reconciliation | `demo-cycle-reconciliation.ts`: `closed_externally`, `closed_externally_contradicted` |
| Test verdict | `demo-cycle-test-verdict.ts`: failure `POSITION_CLOSED_EXTERNALLY` |
| Runtime | `bootstrap.ts` (PostgreSQL log), `compose.ts`, `services.ts`, `app.ts`: `POST /api/broker/etoro/demo/intents/{id}/closed-externally` |

**The route:**
- **Authentication:** it needs the authenticated operator, like every mutating demo route: operator token, loopback origin only.
- **Body:** exactly `{ positionId, snapshotId, statement: "POSITION_CLOSED_OUTSIDE_NEXUS" }`. A body that names an actor (`attestedBy`, …) is refused.
- **Cross-checks, not sources:** the position and the snapshot in the body are compared with what the stored evidence names.
- **Locks:** the route makes no broker request and is therefore not blocked by `BUILD_LOCKS.etoroDemoExecution`. It needs `ETORO_DEMO_EXECUTION_ENABLED=1` (otherwise `EXECUTION_DISABLED`). Without the stored sync history (eToro read-only) it answers `EXTERNAL_CLOSURE_NOT_AVAILABLE`.

## Safety invariants

Every condition is required. Otherwise the result is `EXTERNAL_CLOSURE_REFUSED` with the reasons, and **nothing is recorded** (fail closed).

| # | Invariant | Refusal |
|---|---|---|
| 1 | **The open exists and is an open.** | `OPEN_NOT_FOUND`, `NOT_AN_OPEN` |
| 2 | **The open is filled.** It is `FILLED`, or `PARTIALLY_FILLED` with a read stating the partial fill **final**. A `SUBMITTED` open (the O22 case) is refused. | `OPEN_NOT_FILLED` |
| 3 | **The binding comes from a checked order status read.** The open's first fill entry carries a confirmation, and that confirmation is: an `order_status` read of this open, with a fill outcome, of the open's broker order, checked for exactly this transition (`target`). | `BINDING_NOT_CHECKED`, `BINDING_ORDER_MISMATCH` |
| 4 | **The binding is unique.** That read names exactly one position, and no fill read of the open names another. | `BINDING_NOT_UNIQUE` |
| 5 | **The claim names that position.** The position is never taken from the claim. | `POSITION_ID_MISMATCH` |
| 6 | **No NEXUS close of the position is filled, in progress or unresolved.** Closes that are `REJECTED`, `CANCELLED` or `EXPIRED` are allowed. | `NEXUS_CLOSE_FILLED`, `NEXUS_CLOSE_UNRESOLVED` |
| 7 | **The snapshot is in the stored history.** The history is complete (no successful sync without a readable snapshot record), and the named snapshot was observed. | `SNAPSHOT_HISTORY_INCOMPLETE`, `SNAPSHOT_NOT_FOUND` |
| 8 | **The snapshot is the one newest successful observation.** No later observation exists, and none has the same time with another content. A snapshot id is the hash of its content, so the evidence is always the newest observation of that content. | `SNAPSHOT_NOT_NEWEST`, `SNAPSHOT_AMBIGUOUS` |
| 9 | **The snapshot is later than the binding.** It was observed strictly after the open's fill entry and after the confirming read. | `SNAPSHOT_PREDATES_BINDING` |
| 10 | **The snapshot is complete:** the listed positions equal the stated count. | `SNAPSHOT_INCOMPLETE` |
| 11 | **The snapshot no longer shows the position**, and it does not show the open's order as pending. | `POSITION_STILL_IN_SNAPSHOT`, `OPEN_ORDER_STILL_AT_BROKER` |
| 12 | **An authenticated human operator makes the explicit statement.** A strategy, a malformed actor or another statement is refused. | `OPERATOR_INVALID`, `CLAIM_INVALID` |
| 13 | **One attestation per position.** The record id is fixed, and the rule runs again inside the attestation log's lock after catching up with every process. | `ALREADY_ATTESTED` |
| 14 | **The record keeps all its evidence** (revision-safe): the binding confirmation id and its time, the snapshot id, its time and sync-log position, its position count, the heads of the intent and confirmation logs (count and hash), the number of observations checked, the operator and the time. | – |

**Effect.** The position of the attested open no longer counts as live in `book()`. Specifically:
- it drops out of `maxOpenPositions`, exposure and "one live intent per instrument";
- a close of it is refused with `CLOSE_TARGET_UNKNOWN`.

The budget is unchanged. Policy v2 therefore stays exhausted (open 1/1), so **no new cycle becomes possible this way** (Plan C).

**Contradiction after the record.** If a later stored snapshot shows the attested position again:
- the reconciliation reports `closed_externally_contradicted` (`inconsistent`);
- **every open** is refused with `EXTERNALLY_CLOSED_POSITION_SHOWN_AT_BROKER`.

That check runs in the gate (create and execute) and again right before the reservation. Once an attestation exists, an open also needs a fresh, complete stored snapshot (`EXTERNAL_CLOSURE_NOT_VERIFIABLE`).

**The O22 test verdict stays NOT passed.** An attestation adds the failure `POSITION_CLOSED_EXTERNALLY`, because a hand close is a manual intervention.

## Concurrency and crashes

- **Write.** The record is a single append to one log. A crash before the commit leaves nothing; a crash after it leaves the complete record. There is no state spread over two logs.
- **Two processes.** The fixed record id and the rule's re-check inside the lock (against the caught-up attestation log) let exactly one record through. The `BarrierStore` test proves this with both processes deciding on the same stored state before either writes.
- **Read order.** The snapshot history is read first (it catches up with the sync log, then the snapshot log), and the execution logs after it.

**Not atomic across logs:**
- The intent and confirmation logs are caught up **just before** the write, not inside the attestation lock; there is no transaction across logs.
- Against a NEXUS close that is reserved concurrently, two other things protect:
  - the close's reservation catches up with the attestation log right before `SUBMITTING`, and its book check then refuses (`CLOSE_TARGET_UNKNOWN`);
  - the close needs a fresh stored snapshot that **still shows** the position (D4), while the attestation needs the newest one **not** to show it.

  Both can pass in the same window only if a contradicting snapshot is stored in between. That snapshot would then appear as `closed_externally_contradicted`.

## Tests

| File | Count | Content |
|---|---|---|
| `test/broker/etoro/o22-external-closure.test.ts` | 40, offline | Complete attestation (references, nothing else touched, budget unchanged, intent stays `FILLED`); liveness ended (new open no longer blocked, close refused); reconciliation and verdict; missing evidence (`SUBMITTED` open as in O22, no snapshot, snapshot still with the position, snapshot before the binding, lost snapshot record, crash between snapshot and sync record); contradictions (later snapshot with the position, same time with other content, pending open order, approved NEXUS close until withdrawn); manipulation (other position id, invalid claims, actor in the body, non-human actors, unknown ids); second attestation; crash before and after the commit; late snapshots before and after the attestation; every reason of the pure rule; the open check. |
| `test/pg/o22-external-closure.pg.test.ts` | 7, two processes, isolated test database | Simultaneous attestation (one record); the same with a barrier (both decided before either wrote); attestation by the process that never read the portfolio itself, liveness then ended in the other one; a NEXUS close approved in B refuses A; a newer snapshot from B refuses A; crash after and before the commit in A. |
| `test/runtime/o21-runtime.test.ts` | +2 | The route over real HTTP: operator authentication required, body without an actor, reason codes passed on, 0 broker requests; without operator configuration refused. |

**Counter-proof.** Each safety rule was removed on its own from the new code, and the new tests were run again:

| Removed | Failing tests |
|---|---|
| Liveness rule | 2 |
| Newest-snapshot rule | 4 |
| Position cross-check | 1 |
| Verdict failure | 1 |
| Open check | 1 |
| Re-check in the lock **and** fixed id | 1 |
| Unresolved NEXUS close | 3 |
| Checked binding read | 1 |
| Snapshot after the binding | 2 |
| Incomplete history | 1 |
| Pending open order | 1 |
| Fill state | 2 |

Removing only the re-check in the lock is not detected, because the fixed record id alone already prevents a second record (double protection).

## What is still missing before production use on the O22 database

None of the following is authorized by this change. Each needs its own decision.

1. **A checked status read of the O22 open.** It is `SUBMITTED`; the attestation refuses with `OPEN_NOT_FILLED` until an authorized read-only `orders:lookup` (`refresh`) records `FILLED` with exactly one position. The stored snapshot binding of 20.10. (D6) is deliberately **not** accepted in place of a status read.
2. **A read-only sync after the hand close.** It provides the newest complete snapshot without the position. The last stored snapshot (20.10.) still shows it.
3. **Starting the runtime** with `ETORO_DEMO_EXECUTION_ENABLED=1` and operator authentication, and the attestation by the operator over the route.
   - **First start:** creates the empty log `etoro-demo-external-closures` in the database (`INSERT … ON CONFLICT DO NOTHING`).
   - **Refresh with a closed lock:** a `refresh` is a broker read and is not locked by the build lock. Whether to run it is a separate decision.
4. **Human review** of this PR and CI.
5. **For a new cycle:** a new budget (Plan C: new policy version). The attestation does not release the exhausted O22 budget.
