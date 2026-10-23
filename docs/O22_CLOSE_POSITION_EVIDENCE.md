# O22 D4 – A close needs the broker's evidence that its position is still open (23.10.2026)

**Scope:** a fail-closed safeguard for demo closes. **This is not a trading release:** all four build locks stay closed, and nothing is sent, booked or reset.

## Finding (audit of 23.10.2026, D4)

A close was allowed on the NEXUS logs alone:

- `closePositionOf` and the book check `closeTargetKnown` required an open that was `FILLED` (or `PARTIALLY_FILLED`) with exactly one position confirmed by a broker status read.
- Neither of them checked whether the broker still showed that position.
- The gate deliberately skipped the sync check for closes, so that "a position NEXUS opened … stays closable when the sync is failing".

A position closed by hand (as in cycle 1), or by a stop-loss, could therefore be submitted for closing again. With the lock and the switch open, that write would have been sent and would have spent the close budget. The regression test proves it: on the code before this change, the hand-closed case **sends** the close.

## Change

- **The evidence.** `closePositionRefusals` (`execution-gate.ts`) checks a close against the latest **stored** read-only broker snapshot (O20 sync; no broker request). It refuses unless all of these hold:

  | Condition | Reason code |
  |---|---|
  | A snapshot exists. | `CLOSE_POSITION_EVIDENCE_MISSING` |
  | The snapshot is `fresh` and at most `maxBrokerSyncAgeMs` old (5 min), and not in the future. | `CLOSE_POSITION_EVIDENCE_STALE` |
  | The snapshot was taken at or after NEXUS bound the position (the open's first `FILLED` / `PARTIALLY_FILLED` entry). | `CLOSE_POSITION_EVIDENCE_PREDATES_BINDING` |
  | The snapshot is complete: the listed positions equal the stated count. | `CLOSE_POSITION_EVIDENCE_INCOMPLETE` |
  | The position id appears **exactly once**: absent gives the first code (closed by hand, by a stop-loss, or not visible); twice gives the second. | `CLOSE_POSITION_NOT_OPEN_AT_BROKER` / `CLOSE_POSITION_AMBIGUOUS` |
  | It has the intent's eToro instrument and direction, and, when the broker states the opening order (`openOrder.orderId`), that order is the open's broker order. | `CLOSE_POSITION_MISMATCH` |

- **Where it is checked.**
  1. In the gate **at creation**: the close is `REJECTED`, and nothing is spent.
  2. In the gate **at execution**: `GATE_REFUSED`, and the intent stays `APPROVED`.
  3. **Once more in the reservation step**, inside the intent-log lock, just before `SUBMITTING`. The age is re-evaluated at that moment.

  A refusal at any of these points sends nothing and spends **no close budget**, because the budget is spent only by `SUBMITTING`.
- **Wiring.** The runtime passes the latest stored snapshot of the O20 broker service (`compose.ts`). Without eToro, or without a snapshot, every close is refused.
- **Deliberate trade-off.** A close now needs a recent successful read-only sync, just as an open does. If the sync fails or is stale, NEXUS refuses the close; the position can still be closed by hand. This replaces the earlier rule that a close does not depend on the sync. No close is sent on old evidence.

## What it cannot guarantee

A snapshot is a past observation. Between the read (at most 5 minutes old) and the write, the broker state can change, for example through a hand close or a stop-loss. NEXUS cannot exclude that: the broker API offers no compare-and-set. The broker then refuses or does not execute the close. That attempt still counts against the close budget, which is spent from `SUBMITTING` on and never resent. The freshness limit keeps the window short; it does not close it.

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
- **On the code before this change, 28 of the 30 tests fail.** In particular, the hand-closed case sends the close.
- **The test fixture** (`o21-fixture.ts`) now provides a stored snapshot. By default it shows the default test position, fresh and complete; tests can replace it or remove it.
