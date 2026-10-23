# O22 D4 – A close needs the broker's evidence that its position is still open (23.10.2026)

**Scope:** a fail-closed safeguard for demo closes. **This is not a trading release:** all four build locks stay closed, and nothing is sent, booked or reset.

## Finding (audit of 23.10.2026, D4)

A close was allowed on the NEXUS logs alone:

- `closePositionOf` and the book check `closeTargetKnown` required an open that was `FILLED` (or `PARTIALLY_FILLED`) with exactly one position confirmed by a broker status read.
- Neither of them checked whether the broker still showed that position.
- The gate deliberately skipped the sync check for closes, so that "a position NEXUS opened … stays closable when the sync is failing".

A position closed by hand (as in cycle 1), or by a stop-loss, could therefore be submitted for closing again. With the lock and the switch open, that write would have been sent and would have spent the close budget. The regression test proves it: on the code before this change, the hand-closed case **sends** the close.

## Change

- **The evidence.** `closePositionRefusals` (`execution-gate.ts`) checks a close against the newest **stored** read-only broker snapshot (O20 sync; no broker request), as stored by any NEXUS process. It refuses unless all of these hold:

  | Condition | Reason code |
  |---|---|
  | The newest successful sync's snapshot record can be read. | `CLOSE_POSITION_EVIDENCE_UNREADABLE` |
  | No other successful sync has the same `observedAt` with a different snapshot (one newest observation). | `CLOSE_POSITION_EVIDENCE_AMBIGUOUS` |
  | A snapshot exists. | `CLOSE_POSITION_EVIDENCE_MISSING` |
  | The snapshot is `fresh` and at most `maxBrokerSyncAgeMs` old (5 min), and not in the future. | `CLOSE_POSITION_EVIDENCE_STALE` |
  | The snapshot was taken at or after NEXUS bound the position (the open's first `FILLED` / `PARTIALLY_FILLED` entry). | `CLOSE_POSITION_EVIDENCE_PREDATES_BINDING` |
  | The snapshot is complete: the listed positions equal the stated count. | `CLOSE_POSITION_EVIDENCE_INCOMPLETE` |
  | The position id appears **exactly once**: absent gives the first code (closed by hand, by a stop-loss, or not visible); twice gives the second. | `CLOSE_POSITION_NOT_OPEN_AT_BROKER` / `CLOSE_POSITION_AMBIGUOUS` |
  | It has the intent's eToro instrument and direction, and, when the broker states the opening order (`openOrder.orderId`), that order is the open's broker order. | `CLOSE_POSITION_MISMATCH` |

- **Where it is checked.**
  1. In the gate **at creation**: the close is `REJECTED`, and nothing is spent.
  2. In the gate **at execution**: `GATE_REFUSED`, and the intent stays `APPROVED`.
  3. **Once more right before the reservation**: the evidence is **read again from the store** (review R2) and checked in full in the reservation step, inside the intent-log lock, just before `SUBMITTING`: position, instrument, direction, opening order, completeness, binding and age (at that moment). A position that disappeared from a snapshot stored after the gate is refused here.

  A refusal at any of these points sends nothing and spends **no close budget**, because the budget is spent only by `SUBMITTING`.
- **Wiring (review R1).** The runtime passes `storedPositionSource` (`demo-execution-sources.ts`, used by `compose.ts`). Every read calls `EtoroBrokerService.latestStoredSnapshot()`, which first catches up with the sync log and then with the snapshot log in PostgreSQL (the order of `snapshotHistory()`: a sync record is stored after its snapshot, so every sync seen has its snapshot), and only then picks the newest successful observation (`compareObservations`). A process therefore never relies on its own in-memory copy, which does not contain snapshots stored by another process. Without eToro, or without a snapshot, every close is refused.
- **Deliberate trade-off.** A close now needs a recent successful read-only sync, just as an open does. If the sync fails or is stale, NEXUS refuses the close; the position can still be closed by hand. This replaces the earlier rule that a close does not depend on the sync. No close is sent on old evidence.

## Locks, order and races (review of PR #31)

- **Lock order.** The evidence is read with plain catch-up reads of the sync and snapshot logs (`SELECT … ORDER BY sequence`, no row lock), **before** the intent-log lock is taken. The reservation precondition runs synchronously inside the intent-log transaction (`SELECT … FOR UPDATE` on its head row) and takes no other lock and does no I/O. A sync writes only to the snapshot, reconciliation and sync logs, one lock at a time, and never to the intent log. No transaction holds two log locks, so there is no lock order between logs and no deadlock. The intent-log lock has a `lock_timeout`.
- **Transaction boundaries.** There is no transaction across logs. The snapshot read and the `SUBMITTING` append are separate: a snapshot stored by another process **after** the second read and before the broker write is not seen. That window is the time of one intent-log append plus the write itself.
- **Concurrent closes** of the same position are serialized by the intent-log lock (`bookRefusals`): at most one `SUBMITTING`, at most one write.

## What it cannot guarantee

A snapshot is a past observation. Between the read (at most 5 minutes old) and the write, the broker state can change, for example through a hand close or a stop-loss. NEXUS cannot exclude that: the broker API offers no compare-and-set. The broker then refuses or does not execute the close. That attempt still counts against the close budget, which is spent from `SUBMITTING` on and never resent. The freshness limit keeps the window short; it does not close it. Reading the store again right before the reservation narrows the window inside NEXUS (a newer stored snapshot is seen), but the gap between the last database read and the broker call remains (time of check vs. time of use). No atomic guarantee is claimed.

## Tests

- **`test/broker/etoro/o22-close-position-evidence.test.ts`** (27 tests, offline):
  - every reason of the pure check;
  - a refusal at creation for each of these cases: the position closed by hand, no snapshot, a stale snapshot, another position id, a duplicate position;
  - a refusal at execution after a hand close;
  - evidence that turns stale between the gate and the reservation, refused in the reservation step;
  - one close write when the evidence is fresh;
  - a crash before `SUBMITTING` commits, followed by a restart in which the snapshot no longer shows the position: refused.

  Every refusal is checked for: no write, close budget 0.
- **`test/pg/o22-close-position-evidence.pg.test.ts`** (3 tests, two processes on PostgreSQL):
  - a concurrent execute of the same close produces exactly one write;
  - a position closed by hand: both processes refuse, with no write and no budget spent;
  - a stale snapshot in one process and a fresh one in the other: the stale one refuses, and at most one write is sent.
- **`test/broker/etoro/o22-close-position-evidence-store.test.ts`** (10 tests, offline, review R1/R2):
  - `latestStoredSnapshot` sees a newer snapshot stored by another process (while the not caught-up `latestSnapshot` does not); `none`, `ambiguous`, the same content twice (not ambiguous), `unreadable`;
  - `storedPositionSource` maps position, instrument, direction and opening order, and passes problems on; a problem refuses the close;
  - the position disappears, or the store turns ambiguous, between the gate and the reservation: refused in the reservation step, no write, no budget;
  - an open never reads the evidence.
- **`test/pg/o22-close-position-evidence-runtime.pg.test.ts`** (4 tests, two processes on PostgreSQL, review R4): each process has its own `EtoroBrokerService` over the runtime's PostgreSQL logs (`etoro-snapshots`, `etoro-reconciliations`, `etoro-sync-events`) and reads them through `storedPositionSource`, as `compose.ts` wires it. Only the portfolio transport is a fixture.
  - process B stores a newer snapshot without the position, process A (whose own copy still shows it, fresh) executes the close: refused, no close write, close budget 0;
  - B stores that snapshot between A's gate and A's reservation: refused in the reservation step;
  - concurrent closes with the position still open: B sees A's snapshot from the store, exactly one close write;
  - concurrent closes after B stored the snapshot without the position: both refuse, nothing sent.
- **Counter-proof.**
  - On the code before D4, 28 of the first 30 tests fail. In particular, the hand-closed case sends the close.
  - With the catch-up of R1 removed, 5 of the 14 review tests fail; in the PostgreSQL case process A **sends** the close.
  - With the reservation using the gate's evidence again (R2 removed), 3 of the 14 fail; in the PostgreSQL case the close is **sent**.
  - The review tests use the new interfaces and do not compile on the code before the review; the counter-proof is therefore made by removing each part of the fix on the new code.
- **The test fixture** (`o21-fixture.ts`) now provides a stored snapshot. By default it shows the default test position, fresh and complete; tests can replace it or remove it.
