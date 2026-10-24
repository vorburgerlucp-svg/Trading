# O22 Plan B review R3 – Broker access fingerprint (24.10.2026)

**Scope:** code and tests only. **This is not a trading release:**
- all four build locks stay closed;
- no broker request was made;
- the O22 database was not changed;
- no budget was reset.

## 1. Analysis

**eToro authentication.** Every request carries two headers, `x-api-key` and `x-user-key` (`etoro-transport.ts`, `etoro-demo-execution-transport.ts`). The runtime reads both from `ETORO_API_KEY` / `ETORO_USER_KEY` and passes the **same** pair (`etoroCredentials(config)`) to both transports:
- the read-only transport: portfolio, pnl, metadata, `/me`;
- the execution transport: open, close, cancel, status reads.

**Demo and real.** Four separate layers keep NEXUS in the demo environment:

| Layer | What it does |
|---|---|
| Configuration | refuses `ETORO_TRADING_MODE=real` at start (`LIVE_TRADING_REFUSED`) |
| Paths | every read and write path is a fixed literal containing `/demo/` (`etoro-readonly.ts`, `etoro-demo-execution-endpoints.ts`) |
| Broker | according to the reference, "each key can only be used for one environment"; the operator confirmed the key environment Demo (O21A) |
| Build | the build lock `etoroDemoExecution` stays closed |

**A pseudonymous account identity: possible in principle, not available now.**
- **The portfolio carries no account identifier.** The live observation of 18.10. has none: its position keys contain no `CID`. The `CID` of the documented schema is deliberately not kept (`etoro-validation.ts`).
- **`GET /api/v1/me` documents `gcid`, `realCid` and `demoCid`.** NEXUS reduces the answer to the scope names (`etoro-me-scopes.ts`). `demoCid` was **never observed live**: the operator reported a successful `/me`, and nothing of it was stored.
- **What an HMAC of `demoCid` would need:**
  1. a broker request to verify the field (not allowed in this task);
  2. an extra `/me` read for every sync and write, against the rate limit;
  3. a decision to process an account identifier, even only transiently.

  It would be the stronger proof (same account, not only the same keys) and is the recommended follow-up. It is **not** implemented.

## 2. Design: a fingerprint of the configured access

`src/broker/etoro/etoro-access-fingerprint.ts`.

**Computation.**
- **Function:** HMAC-SHA256 under a **separately managed NEXUS key** (`NEXUS_BROKER_ACCESS_KEY`).
- **Message:** `nexus-broker-access-fingerprint:v1`, broker `etoro`, environment `demo`, SHA-256(`x-api-key`) and SHA-256(`x-user-key`). The message exists only in memory.
- **Domain separation:** version, broker and environment are part of the message. A configuration for another environment therefore never matches.

**What is stored.** Only `{ version, keyId, fingerprint }` (64 hex characters).
- Never a broker key, the HMAC key or any account data.
- Without the HMAC key the fingerprint can be neither reversed nor recomputed, and it cannot be linked across HMAC keys.

**Configuration** (`config.ts`):
- `NEXUS_BROKER_ACCESS_KEY_ID` / `NEXUS_BROKER_ACCESS_KEY`, and during a rotation `NEXUS_BROKER_ACCESS_PREVIOUS_KEY_ID` / `NEXUS_BROKER_ACCESS_PREVIOUS_KEY`.
- The key is 32 to 512 printable characters, and the id 1 to 32 characters (`a-z0-9._-`).
- Each id and key come as a pair. The previous key only with a current one. Ids and keys must differ. No key may be a broker key or the operator token.
- Refusals name the variable, never a value. The summary shows only `configured` and the key ids.

**Where it is stamped:**
- every successful sync record (`etoro-sync-events`: `access`);
- every `started` write attempt (`etoro-demo-execution-attempts`: `access`), for open, close and cancel.

The stamp is part of the same record, so a crash leaves either the complete stamped record or nothing.

**Where it is checked** (fail closed: only `match` passes):

| Decision | Checked against the configured access | Refusal (prefix + `_ACCESS_MISMATCH` / `_NOT_SHOWN` / `_KEY_UNKNOWN` / `_NOT_CONFIGURED`) |
|---|---|---|
| Every **open** (gate at create and execute, and again in the reservation) | the newest stored snapshot | `BROKER_SNAPSHOT_…` |
| Every **close** (same three places) | the close's evidence snapshot, and the `started` attempt of the open it closes | `CLOSE_POSITION_EVIDENCE_…`, `CLOSE_TARGET_OPEN_…` |
| The **attestation** of an external closure | the open's attempt, the continuity snapshot and the evidence snapshot | `OPEN_ATTEMPT_…`, `CONTINUITY_SNAPSHOT_…`, `EVIDENCE_SNAPSHOT_…` |
| Without the gate's access result | – | `BROKER_ACCESS_NOT_CHECKED` |

**The verdicts:**
- `match` (current or previous key);
- `mismatch` (other credentials or environment, malformed or forged stamp);
- `missing` (no stamp);
- `unknown_key` (stamped under a key that is not configured);
- `not_configured` (no NEXUS key in this process).

**Key rotation:**
1. Generate a new key with a new id. Set it as the current key, and the old pair as the previous key, then restart.
2. New records are stamped with the new id. Old records are checked under the previous key.
3. Keep the previous key as long as a record you still rely on carries its id: an open position's attempt, or the snapshots of a pending attestation.
4. Then remove it. Records under a removed key give `unknown_key` and refuse (fail closed); they are never re-stamped.

During a rotation, a process that only knows the old key cannot check new stamps (`unknown_key`), so all processes should be restarted together. A change of the **eToro** keys always gives `mismatch`. This is deliberate: NEXUS cannot tell a new key pair of the same account from another account.

## 3. What the fingerprint proves, and what it does not

| Claim | Proved? |
|---|---|
| Two records were made with **the same configured eToro credentials** (`x-api-key`, `x-user-key`) **for the demo environment** | **yes**, as far as HMAC-SHA256 and the secrecy of the NEXUS key hold |
| The process configuration that made a record had those credentials | yes. Both transports get the pair from the same configuration, but the fingerprint covers the configuration, not the bytes on the wire |
| The broker served **the same eToro account** for both records | **no.** NEXUS has no verified account identity (no CID, no `demoCid`) |
| A key pair belongs to a particular account | **no** |
| A position that is missing from a snapshot was closed (and not hidden by a broker fault) | **no:** that is the operator's statement plus the snapshot rules |
| Anything about records made before this change, such as **all O22 records** | **no:** they carry no stamp |

**Same credentials is not the same account.**
- One account can have several key pairs. A new pair gives another fingerprint, and that is refused (fail closed, never wrongly accepted).
- One key pair belongs to one account at a time, but the broker could in theory re-assign it. The fingerprint cannot see that.
- **What it closes:** the gap of R3, a portfolio read **with other configured credentials** made to look like proof that a position was closed.
- **What it does not close:** the gap of a different account behind the same credentials. Only a verified account identity would close that (`demoCid`, see section 1).

## 4. The O22 records

They are unchanged and get no stamp after the fact:
- the open's write attempt of 20.10. and both snapshots of 20.10. carry no `access`;
- **an attestation of the O22 open is therefore refused.** Today it is refused with `OPEN_NOT_FILLED`, since the open is `SUBMITTED`. Even after an authorized status read records `FILLED`, it is still refused with `OPEN_ATTEMPT_ACCESS_NOT_SHOWN` and `CONTINUITY_SNAPSHOT_ACCESS_NOT_SHOWN`;
- **a NEXUS close of the O22 position is refused** with `CLOSE_TARGET_OPEN_ACCESS_NOT_SHOWN`, and the position is closed anyway.

**Plan B can therefore not settle O22 with this code.** That would need a separately decided and reviewed exception for records made before the fingerprint existed. It is not part of this change, and it would bring back exactly the gap that R3 describes.

## 5. Tests

| File | Count | Content |
|---|---|---|
| `test/broker/etoro/o22-access-fingerprint.test.ts` | 18 | **Primitive:** deterministic, no key in the stamp; other credentials and other environment do not match; another HMAC key gives another fingerprint; rotation with and without the previous key, and a changed key pair during a rotation; missing, malformed and forged stamps; no key configured; invalid keys and ids. **Configuration:** pairs, previous needs current, ids and keys differ, no broker key, no value in a message or the summary. **Use:** every sync and write attempt stamped and no key in any record; account switch refuses open, close and attestation; a process without a key refuses everything; unstamped (O22-like) reads are refused and never filled in; key rotation across a restart; restart with other credentials refuses the old open's close. |
| `test/pg/o22-access-fingerprint.pg.test.ts` | 3, two processes | Another account in B refuses A's open and both attestations; during a rotation B checks A's old stamps and A cannot check B's new ones; a crash right after B's stamped read commits leaves a complete stamped record that A relies on. |
| `test/pg/o21-runtime.pg.test.ts` | extended | Over `startRuntime` with the environment: the stored sync carries the key id, and the key appears nowhere in the database or the responses. |
| Existing tests | adapted | The fixtures configure a test key (a marker, not a secret) and stamp their reads. Runtime tests that expect an open to pass store one stamped read first (`test/runtime/broker-access-seed.ts`). One runtime test keeps running without a key. |

**Counter-proof.** Each rule was removed on its own from the new code, and the tests above, the Plan B tests and the runtime PostgreSQL test (82 tests) were run again:

| Removed | Failing tests |
|---|---|
| The HMAC comparison (every stamp matches) | 9 |
| The environment in the message | 1 |
| The user key in the message | 6 |
| The previous key (rotation) | 3 |
| A missing stamp is refused | 3 |
| The gate uses the access refusals | 6 |
| A close checks the open's attempt | 2 |
| The reservation checks the access again | 1 |
| The attestation checks the access | 7 |
| Syncs are stamped | 34 |
| An open checks the newest snapshot | 6 |
| The configuration refuses a broker key as access key | 1 |
