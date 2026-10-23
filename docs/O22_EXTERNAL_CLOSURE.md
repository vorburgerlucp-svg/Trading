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

**Review of PR #33:** the sections R1 (races across logs), R2 (snapshot consistency) and R3 (account identity) below record what the review found and changed.

**The route:**
- **Authentication:** it needs the authenticated operator, like every mutating demo route: operator token, loopback origin only.
- **Body:** exactly `{ positionId, snapshotId, statement: "POSITION_CLOSED_OUTSIDE_NEXUS", accountStatement: "SAME_ETORO_DEMO_ACCOUNT" }` (see R3). A body that names an actor (`attestedBy`, …) is refused.
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
| 10 | **The snapshot is complete and consistent (R2):** see the R2 section. Every stored observation must be consistent too. | `SNAPSHOT_INCOMPLETE`, `SNAPSHOT_HISTORY_INCONSISTENT` |
| 11 | **The snapshot no longer shows the position**, and it does not show the open's order as pending. | `POSITION_STILL_IN_SNAPSHOT`, `OPEN_ORDER_STILL_AT_BROKER` |
| 12 | **An authenticated human operator makes the explicit statement.** A strategy, a malformed actor or another statement is refused. | `OPERATOR_INVALID`, `CLAIM_INVALID` |
| 13 | **One attestation per position.** The record id is fixed, and the rule runs again inside the attestation log's lock after catching up with every process. | `ALREADY_ATTESTED` |
| 14 | **The record keeps all its evidence** (revision-safe): the binding confirmation id and its time, the snapshot id, its time and sync-log position, its position count, the continuity snapshot (R3), the heads of the intent and confirmation logs (count and hash), the number of observations checked, the operator and the time. | – |
| 15 | **Continuity (R3):** an earlier consistent snapshot, observed after the order was submitted, showed the position, with the intent's instrument and direction, as opened by exactly the open's broker order. | `ACCOUNT_CONTINUITY_NOT_SHOWN` |
| 16 | **The operator states the account (R3):** the claim carries `accountStatement: "SAME_ETORO_DEMO_ACCOUNT"`. The record stores it together with `accountIdentity: "not_verified"`. | `CLAIM_INVALID` |
| 17 | **Effect only while no NEXUS close may have been sent (R1):** see the R1 section. | – (no effect; reconciliation `external_closure_without_effect`) |

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

## R1 – Races across logs (review of PR #33)

**Finding (corrected).** The first version of this document said that the close's book check and the D4 snapshot evidence protect against a concurrent NEXUS close. **That was wrong.** The two sides write to different logs (attestation log, intent log) with no transaction across them:
- the attestation decides on the intent log as it was read just before its write;
- the close decides on the attestation log as it was read just before its reservation.

Two forced races on PostgreSQL showed it on the code of `35ca4c0` (`test/pg/o22-external-closure-race.pg.test.ts`). In both, the close was sent **and** the attestation ended the position's liveness. The precondition is a flip of the stored snapshots: one snapshot without the position for the attestation, then a newer one with it for the close. That is exactly the inconsistent broker data a fail-closed design must survive.

**Fix: both sides write first, then read the other (Dekker principle).**
- **The close.** After its reservation (`SUBMITTING` recorded, attempt `started`) and before the broker write, it catches up with the attestation log. If an attestation of its position exists, it is **not sent**:
  - the attempt is recorded as `not_sent` with `EXTERNAL_CLOSURE_ATTESTED`;
  - the intent becomes `REJECTED` (`NOT_SENT_EXTERNAL_CLOSURE_ATTESTED`);
  - the close budget stays spent (it is spent by `SUBMITTING`).
- **The attestation.** Its effect is decided **at read time** (`externalClosureEffective`). It has **no effect** while a NEXUS close of its position is in a state in which it may have been sent or was filled: `SUBMITTING`, `SUBMITTED`, `ACCEPTED`, `PARTIALLY_FILLED`, `FILLED`, `AMBIGUOUS` or `RECONCILED`. The view then shows `effective: false`, and the reconciliation reports `external_closure_without_effect` (`inconsistent`).

The PostgreSQL reads are committed reads. If the close's read does not see the attestation, the attestation was committed after that read, and then every later read sees the close as possibly sent. So **an attestation can never end the liveness of a position while a NEXUS close of it may have been sent.** Both orders are tested.

**A crash between the reservation and that read** leaves the close in `SUBMITTING` and later `AMBIGUOUS`. The attestation then stays without effect: fail closed, the position stays live.

**Other races:**
- **Snapshot sync.** A newer snapshot showing the position can be stored while the attestation is being written; the snapshot log is not part of its lock. The attestation is then recorded on the snapshot that was newest at its read. The contradiction is not lost:
  - the reconciliation reports `closed_externally_contradicted` (`inconsistent`);
  - every open is refused (`EXTERNALLY_CLOSED_POSITION_SHOWN_AT_BROKER`).

  This is tested with a held write on PostgreSQL. Because the attested position is no longer a close target, NEXUS cannot close it then; it can be closed by hand.
- **Broker status reads.** An attestation needs the open `FILLED` (final), or `PARTIALLY_FILLED` with a final read. A later status read can neither change the state nor contradict the bound position (`assertConsistentWithStoredReads`). A `refresh` of the attested open is refused, and nothing is recorded (tested).
- **Two attestations.** The fixed record id plus the re-check in the lock: see above, tested with a barrier.

## R2 – Snapshot consistency (review of PR #33)

`snapshotContentProblems` (`etoro-broker-service.ts`) checks a stored snapshot's content:

| Check | Code |
|---|---|
| `positionCount` equals the stored positions | `POSITION_COUNT_MISMATCH` |
| `openOrderCount` equals the stored orders | `ORDER_COUNT_MISMATCH` |
| The coverage says `verified_empty` exactly when the list is empty (positions, orders) | `POSITION_COVERAGE_CONTRADICTED`, `ORDER_COVERAGE_CONTRADICTED` |
| No position or order appears twice | `DUPLICATE_POSITION`, `DUPLICATE_ORDER` |
| The snapshot id is the hash of its content, as `sync()` derives it | `CONTENT_HASH_MISMATCH` |

`sync()` produces consistent content by construction. These checks catch a corrupted, forged or wrongly migrated record:
- **Attestation:** refused if the claimed snapshot is inconsistent (`SNAPSHOT_INCOMPLETE`) or if **any** stored observation is (`SNAPSHOT_HISTORY_INCONSISTENT`).
- **D4 close evidence and the open check:** `latestStoredSnapshot()` returns `inconsistent`, which leads to `CLOSE_POSITION_EVIDENCE_INCONSISTENT`, or for an open to `EXTERNAL_CLOSURE_NOT_VERIFIABLE`.

## R3 – Account identity (review of PR #33)

**What is guaranteed technically: no binding to one account.** NEXUS stores no eToro account identity:
- the customer id (`CID`) of positions and orders is deliberately not kept (`etoro-validation.ts`);
- `/api/v1/me` is reduced to the scope names (`etoro-me-scopes.ts`);
- the snapshot content has `accountId: null` and `coverage.accountIdentity: "not_observed"`.

Nothing in the stored data proves that the order and a later portfolio snapshot belong to the same eToro demo account. **No such binding is claimed:** the record says `accountIdentity: "not_verified"`.

The risk: a portfolio read made with **other credentials** (another account) does not show the position, and would look like proof that it was closed.

**Implemented: two fail-closed controls.**
1. **Continuity (technical, partial).** The attestation needs an earlier consistent snapshot, observed after the order was submitted, that shows the position as opened by **exactly the open's broker order** (`openOrder.orderId`), with the intent's instrument and direction.
   - **What it shows:** the portfolio reads were, at that time, of the account that holds NEXUS's order. This assumes eToro order ids are unique across accounts; the reference describes `orderID` as the order's id.
   - **What it cannot show:** that the later evidence snapshot was read with the same credentials.
   - **For O22:** the snapshot of 20.10. 07:49:52 meets this condition, and both stored O22 snapshots pass every R2 check, including the content hash. This was checked read-only on 23.10.2026 (`nexus_readonly`, the repository's own decoder and hash; only yes/no and counts were output).
2. **The operator's statement (organizational).** The claim must carry `accountStatement: "SAME_ETORO_DEMO_ACCOUNT"`: the operator confirms that the order and every portfolio read come from the same demo account (the same configured credentials). It is recorded.

**Considered and not implemented:**
- **Storing the CID, or the `demoCid` of `/me`.** That would put an account identifier into the database, which the project's privacy rule excludes. It needs a separate decision.
- **A keyed fingerprint of the credentials on every write attempt and every sync record** (for example an HMAC under the user key, truncated, irreversible). It would detect a change of credentials between the order and the evidence snapshot. It would *not* prove the account (one account can have several keys; that case would be refused, which is fail closed).
  - It needs schema changes to the attempt and sync records, and a decision on storing key-derived values.
  - It does not cover the existing O22 records: no fingerprint was stored for them.

**Conclusion for production use: not released on this basis alone.**
- The bridge between the continuity snapshot and the evidence snapshot is only the operator's statement.
- For O22 that remains the only control, because the existing records carry no fingerprint.
- Production use needs an explicit decision that this residual risk is accepted (demo account, no ledger effect, liveness only), or the fingerprint first.

## Tests

| File | Count | Content |
|---|---|---|
| `test/broker/etoro/o22-external-closure.test.ts` | 54, offline | Complete attestation (references, nothing else touched, budget unchanged, intent stays `FILLED`); liveness ended (new open no longer blocked, close refused); reconciliation and verdict; missing evidence (`SUBMITTED` open as in O22, no snapshot, snapshot still with the position, snapshot before the binding, lost snapshot record, crash between snapshot and sync record); contradictions (later snapshot with the position, same time with other content, pending open order, approved NEXUS close until withdrawn); manipulation (other position id, invalid claims, actor in the body, non-human actors, unknown ids); second attestation; crash before and after the commit; late snapshots before and after the attestation; every reason of the pure rule; the open check. Review: continuity (missing, another order, no order, another direction, before the order), every R2 inconsistency of the claimed snapshot and of an older one, the content hash, the read-time effect rule for every close state, a refresh of the attested open. |
| `test/pg/o22-external-closure-race.pg.test.ts` | 3, two processes, forced with held writes | R1: the attestation commits between the close's reservation and its write (close not sent, attestation in effect); the close is sent before the attestation commits (attestation without effect, position stays live); a newer snapshot with the position is stored while the attestation is held (recorded, contradicted, every open refused). |
| `test/broker/etoro/o22-close-position-evidence-store.test.ts` | +1 | R2 in the D4 path: an inconsistent newest snapshot is not used. |
| `test/pg/o22-external-closure.pg.test.ts` | 7, two processes, isolated test database | Simultaneous attestation (one record); the same with a barrier (both decided before either wrote); attestation by the process that never read the portfolio itself, liveness then ended in the other one; a NEXUS close approved in B refuses A; a newer snapshot from B refuses A; crash after and before the commit in A. |
| `test/runtime/o21-runtime.test.ts` | +2 | The route over real HTTP: operator authentication required, body without an actor, reason codes passed on, 0 broker requests; without operator configuration refused. |

**Counter-proof (review state).** Each safety rule was removed on its own from the new code, and the tests of Plan B and of the review were run again (76 tests: unit, PostgreSQL, races, D4 store):

| Removed | Failing tests |
|---|---|
| Liveness rule | 2 |
| Newest-snapshot rule | 4 |
| Position cross-check | 1 |
| Verdict failure | 1 |
| Open check | 2 |
| Re-check in the lock **and** fixed id | 1 |
| Unresolved NEXUS close | 3 |
| Checked binding read | 1 |
| Snapshot after the binding | 2 |
| Incomplete history | 1 |
| Pending open order | 1 |
| Fill state | 2 |
| R1: the close's second read after its reservation | 1 |
| R1: read-time effect rule | 2 |
| R2: consistency of the whole history | 9 |
| R2: consistency of the claimed snapshot | 8 |
| R2: `latestStoredSnapshot` (D4 path) | 1 |
| R2: order count | 3 |
| R2: coverage | 2 |
| R2: content hash | 2 |
| R3: continuity, opening order | 2 |
| R3: continuity, after the order | 1 |
| R3: account statement | 1 |

Removing only the re-check in the lock is not detected, because the fixed record id alone already prevents a second record (double protection).

**The two R1 race tests were written before the fix and run on `35ca4c0`: both failed** (the close was sent and the attestation took effect). They pass with the fix.

## What is still missing before production use on the O22 database

None of the following is authorized by this change. Each needs its own decision.

1. **A checked status read of the O22 open.** It is `SUBMITTED`; the attestation refuses with `OPEN_NOT_FILLED` until an authorized read-only `orders:lookup` (`refresh`) records `FILLED` with exactly one position. The stored snapshot binding of 20.10. (D6) is deliberately **not** accepted in place of a status read.
2. **A read-only sync after the hand close.** It provides the newest complete snapshot without the position. The last stored snapshot (20.10.) still shows it.
3. **Starting the runtime** with `ETORO_DEMO_EXECUTION_ENABLED=1` and operator authentication, and the attestation by the operator over the route.
   - **First start:** creates the empty log `etoro-demo-external-closures` in the database (`INSERT … ON CONFLICT DO NOTHING`).
   - **Refresh with a closed lock:** a `refresh` is a broker read and is not locked by the build lock. Whether to run it is a separate decision.
4. **Human review** of this PR and CI.
5. **For a new cycle:** a new budget (Plan C: new policy version). The attestation does not release the exhausted O22 budget.
