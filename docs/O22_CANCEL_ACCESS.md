# O22 – Cancel bound to the open attempt and the broker access (24.10.2026)

**Scope:** code and tests only. **This is not a trading release:**
- all four build locks stay closed;
- no broker request and no cancel was sent;
- the O22 database is unchanged.

## Review of `cancel()` (on `e31de55`)

| Question | Finding before this change |
|---|---|
| Does the current broker access match the original open attempt? | **Not checked.** The cancel attempt was stamped (PR #33), but nothing compared the stamp of the open attempt with the configured access. |
| Can a changed configuration cancel an order of the wrong account? | **Yes, in principle.** A process with other eToro credentials would send `DELETE /orders/{orderId}` for an order id taken from the logs. Whether the broker refuses a foreign order id is not verified. |
| Are order id, original attempt and current configuration bound uniquely? | **No.** The order id came from the projection: the first confirmation with an order id. It was not checked that it was the broker's answer to the intent's one open attempt. |
| Races across instances? | The cancel attempt is reserved under the attempt log's lock. A fixed attempt id per attempt number and a re-check of the earlier cancels mean at most one cancel per attempt number. That rule was correct. |
| At most once? | **Kept.** An accepted, ambiguous or unfinished cancel blocks every further one. Only a cancel the broker conclusively refused allows another. |

## The control (`src/broker/etoro/execution/cancel-guard.ts`)

It runs **before** the write and **again inside the attempt log's lock**, on the caught-up attempts. The open attempt and its stamp live in that log, so the second check sees what every process recorded. If any condition fails, the cancel is refused (`GATE_REFUSED`), the refusal is recorded (`gate` attempt, `refused`), and **nothing is sent**.

| Condition | Refusal |
|---|---|
| Exactly one started open attempt of the intent | `CANCEL_OPEN_ATTEMPT_NOT_UNIQUE` |
| The order to cancel is the one the broker named for exactly that attempt: its `open_accepted` answer with the same request id, or a checked "found" reconciliation of its reference id (after an ambiguous submission) | `CANCEL_ORDER_NOT_BOUND_TO_ATTEMPT` |
| That attempt was sent with the configured broker access (current or previous key) | `CANCEL_TARGET_OPEN_ACCESS_MISMATCH` / `_NOT_SHOWN` / `_KEY_UNKNOWN` / `_NOT_CONFIGURED` |

**What the access check covers:**
- it shows the **same configured credentials**, not a verified account (see `O22_BROKER_ACCESS_FINGERPRINT.md`);
- an open sent before the fingerprint existed carries no stamp, so its order cannot be cancelled by NEXUS (`…_NOT_SHOWN`). The O22 open is `SUBMITTED`, not `ACCEPTED`, so this does not matter there.

**No exception for risk-reducing cancels.** A cancel only removes a pending order, but an exception (for example "cancel even without access proof") would allow exactly the cross-account write described above. It is **not implemented**. If it is ever wanted, it must be:
- a separate, documented policy with its own version;
- explicitly approved by a human, not configurable;
- covered by its own tests;
- recorded on every cancel it allows.

## Tests

- **`test/broker/etoro/o22-cancel-access.test.ts`** (16, offline):
  - with the same access, one stamped cancel is sent, and a second one is refused;
  - other credentials: no cancel, the refusal is recorded, and the original configuration can still cancel;
  - no key: refused;
  - key rotation with and without the previous key;
  - an order found by reference after an ambiguous submission can be cancelled;
  - every case of the pure rule.
- **`test/pg/o22-cancel-access.pg.test.ts`** (5, two processes):
  - concurrent cancels send exactly one;
  - with a barrier, both decided before either wrote: exactly one;
  - B with other credentials sends nothing while A cancels once;
  - a second open attempt that appears between A's check and A's lock (data no code path writes, appended by B as a test) is refused inside the lock, and nothing is sent;
  - a crash right after A's started cancel attempt (nothing sent) makes B refuse another cancel.

**Counter-proof.** Each rule was removed on its own, and the cancel tests and the O21 service tests were run again:

| Removed | Failing tests |
|---|---|
| The check before the write | 2 |
| The check inside the lock | 1 |
| Both | 4 |
| Exactly one open attempt | 1 |
| The order bound to the attempt | 5 |
| The reconciliation must be checked | 1 |
| The access check | 6 |

The check before the write refuses every case a regular code path can produce. The check inside the lock only matters for data that appears in between; it is proved by a forced test.
