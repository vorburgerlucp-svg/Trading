# O22 Plan C – Independent demo cycles (24.10.2026)

**Scope:** code, tests and a proposal only. **This is not a trading release:**
- no cycle is defined or activated anywhere;
- the runtime opens no cycle log, so its behavior is unchanged: O22 policy v2, budget exhausted;
- all four build locks stay closed;
- no broker request was made;
- the O22 database is unchanged.

## 1. Architecture

**A cycle is a record in its own append-only log** (`etoro-demo-cycles`, `src/broker/etoro/execution/demo-cycles.ts`). Three steps, each recorded once under a fixed record id (`<cycleId>:defined|activated|closed`):

| Step | Who | Recorded | Refused when |
|---|---|---|---|
| `defined` (draft) | a human (`defineCycle`) | cycle id, **its own policy** (limits, budget, sides, order types, instruments), its hash, the maximum active time | the id is invalid or used; the policy version is not `etoro-demo-cycle-policy:…` or was used by another cycle; the budget is not 1–3 per kind; the active time is not 1 ms to 7 days |
| `activated` | a human (`activateCycle`) who names the **policy hash** and makes the statement `ACTIVATE_DEMO_CYCLE_WITH_THIS_POLICY` | approver, time, `activeUntil` = activation time + maximum active time, the intent log size checked | not a draft, wrong hash or statement, another cycle active, kill switch tripped, or an earlier broker state not settled (below) |
| `closed` | a human (`closeCycle`) | approver, time, **the cycle's test verdict** over its own intents (`passed` / `failed` / `incomplete` / `not_evaluated`), the failures | the cycle is not active |

The definition and activation steps run their rule again inside the cycle log's lock, after catching up with every process. So there is at most one activation per cycle and at most one active cycle, whatever the order of arrival.

**Binding intents to a cycle:**
- **Binding at creation.** With a cycle log, every new intent is bound at creation to the cycle active at that moment (`bindCycle`). The intent id is computed over the cycle id, so the same input gives another intent in another cycle. `cycleId` is **never taken from input**: the input field is refused as unknown.
- **Without an active cycle nothing is created** (`CYCLE_NOT_ACTIVE`).
- **The policy of an intent** is the policy of its cycle, fixed at definition. Its **budget** counts only the intents of that cycle that reached `SUBMITTING`.
- **When the cycle is checked.** Every gate check (create, execute) and the reservation require the intent's cycle to be the active one and not past `activeUntil` (`CYCLE_NOT_ACTIVE`, `INTENT_NOT_OF_ACTIVE_CYCLE`).
- **Closed cycle, held write.** After the reservation, and before the write, the cycle log is read again. A cycle closed or expired in the meantime stops the write (`NOT_SENT_CYCLE_NOT_ACTIVE`). A close record therefore stops every later write, also one that is already reserved.
- **Which check catches a close, by window** (the cycle log has no transaction with the intent log):

  | The cycle is closed … | Caught by | Effect |
  |---|---|---|
  | before the gate | the gate (create, execute) | refused, nothing recorded |
  | after the gate, before the cycle log is read for the reservation | the reservation check (P4) | refused, **no `SUBMITTING`, no budget spent** |
  | after that read, before or during the reservation ("window 2") | the re-read after the reservation (P5) | **not sent** (`REJECTED`), but the closed cycle's budget **is spent** (residual, see below) |
  | after the write was sent | – | the write was made while the cycle was active |
- **A close closes only an open of its own cycle** (book check `closeTargetKnown`).

**Gate rules across all cycles.** These stay **global**:
- the kill switch and the account safety;
- quotes, the access fingerprint and the D4 evidence;
- open positions, exposure, one live intent per instrument, no new risk while anything is ambiguous, duplicates.

An old live position therefore blocks a new cycle's open, whichever cycle it belongs to.

**The build lock is independent of cycles.** No cycle and no policy opens it. Every write is still `EXECUTION_LOCKED_IN_BUILD` (`o22-plan-c-locked.test.ts`, without the test mock).

**Without a cycle log, behavior is unchanged.** The service then behaves exactly as before: the service policy, the budget of the whole intent log, and an unchanged `cycleBudget` answer. The runtime does not open the log, so a merge changes nothing in production.

## 2. Activation preconditions (requirement 6)

`cycleActivationRefusals` reads **every** intent: of every cycle, and the intents from before cycles, such as O22.

| Condition | Refusal |
|---|---|
| Nothing is in flight, ambiguous or unconfirmed: no `SUBMITTING`, `SUBMITTED`, `ACCEPTED`, `AMBIGUOUS`, `RECONCILED` or `PARTIALLY_FILLED` | `PRIOR_INTENT_UNRESOLVED` |
| Every filled open's position is closed by a **filled NEXUS close** | `PRIOR_POSITION_NOT_CLOSED_BY_NEXUS` |
| No intent is waiting for approval or execution and still unexpired | `PRIOR_INTENT_PENDING` |
| The kill switch is armed | `KILL_SWITCH_TRIPPED` |

**A position closed by hand is not settled for a new cycle (requirement 7), even when attested (Plan B).** The attestation ends its liveness, but it does not end the cycle. The cycle's close record carries `failed` with `POSITION_CLOSED_EXTERNALLY`. Accepting such a position for a new cycle would need a separate, explicitly approved policy, which this code does not contain.

**Consequence for O22.** The O22 open is `SUBMITTED`, so **every activation is refused** with `PRIOR_INTENT_UNRESOLVED` (tested with an O22-like history). Cycle 2 can only be activated once O22 is settled. That needs at least an authorized status read, and then, because the position was closed by hand, a separate decision (see the Plan B and R3 documents).

**No race across logs.** The intent facts are read just before the activation, not inside the cycle log's lock. That cannot open a race, because:
- a settled intent never becomes unsettled again (the state machine only moves forward);
- an intent of a closed cycle can never be sent (the re-read after the reservation);
- an intent from before cycles can never be sent by a process with cycles (no cycle id).

### Window 2: a residual, not an atomic guarantee

A has read the cycle log for its reservation, B then closes the cycle, and A reserves. Tested deterministically on PostgreSQL: A is held right before its `SUBMITTING` write.

| Question | Answer |
|---|---|
| Is a broker order prevented? | **Yes.** The re-read after the reservation sees the close, and nothing is sent. |
| Is budget spent anyway? | **Yes:** the closed cycle counts one reservation that was never sent (`SUBMITTING` → `REJECTED`, attempt `not_sent`). A new cycle is not affected: it has its own count. The record is never reset. |
| Can the cycle log be synchronized bindingly before the reservation? | **No.** The reservation's check runs inside the intent log's transaction and does no I/O. A close committed after the last read of the cycle log and before that transaction is not seen there. |
| Would an additional lock or transaction be needed? | **Yes**, for an atomic decision. For example, the reservation's transaction would also take a shared row lock on the cycle log's head (`SELECT … FOR SHARE`) and read the cycle state in it, while `closeCycle` takes that row lock exclusively. The lock order would be intent log first, then cycle log; `closeCycle` takes no intent lock, so no deadlock. That needs an extension of the append-only store (two logs in one transaction). **Not implemented.** |

**Effect of the residual.** The closed cycle's budget can end higher than the number of orders actually sent. Such a cycle can never take a write again. No order is sent, no other cycle's budget changes, and the never-sent reservation is recorded as such.

It is a residual in accounting, not in trading. **Plan C is therefore not released without restriction:** the residual must be accepted, or the store extension above implemented, before cycle budgets are used as a hard audit figure.

## 3. Budget separation (requirements 3, 4, 9, 10)

- **Separate count.** A cycle's budget is the count of *its own* intents with `SUBMITTING`. A new cycle starts at 0 because no intent has its id; **no old count is changed or reset**. Defining and activating write nothing to the intent and attempt logs (tested).
- **No double spend.** The count runs inside the intent log's lock in the reservation step. Two processes executing different opens of the same cycle send exactly one write with a budget of one (PostgreSQL test).
- **No reuse.** An intent of a closed cycle is refused in that cycle and in every later one. An intent from before cycles (O22) is refused by a process with cycles. An old approval blocks the next activation until it has expired, and is then never executed (`EXPIRED`; tested).
- **Crashes.** Each cycle step is a single record. A crash after the activation record leaves an active cycle, and a second activation is refused (PostgreSQL test). A crash after a reservation leaves the budget spent, as before (fail closed).

## 4. Risk limits for cycle 2 (proposal, phase 4)

`DEMO_CYCLE_2_POLICY_DRAFT` and `DEMO_CYCLE_2_MAX_ACTIVE_MS_DRAFT` (24 h) are **inactive constants**: nothing references them outside the tests.

| Requested limit | How it is met |
|---|---|
| eToro demo account only | the build (`ETORO_TRADING_MODE=demo` only, fixed `/demo/` paths), unchanged |
| At most 1 open, 1 close | `maxOpenSubmissions: 1`, `maxCloseSubmissions: 1` (per cycle) |
| At most 100 USD | `maxOrderInvestmentUsd: '100'`, `maxGrossExposureUsd: '100'` |
| Leverage 1 | `maxLeverage: 1` |
| At most 1 active position | `maxOpenPositions: 1` (global across cycles) |
| No automatic retry on an ambiguous result | unchanged: an `AMBIGUOUS` intent is never resent; an ambiguous close is never reconciled; the budget is spent from `SUBMITTING` on |
| No further orders without separate authorization | each intent needs a human approval; the budget is exhausted after one open and one close; a new cycle needs a new definition and activation |
| No trading release from a passed result | a `passed` verdict changes no lock and no policy; the build lock stays closed |

**Additional limits, now in the draft:**
- a single instrument: `allowedEtoroInstrumentIds: [100001]` (ETH), new gate check `CYCLE_INSTRUMENT_NOT_ALLOWED`;
- buy at market only;
- an active time of 24 h, after which nothing is created or sent.

**Additional limits proposed, not yet implemented (each a separate decision):**
1. **A cancel budget.** A cancel is a write, but it is not counted. With market-only opens, a cancel is only possible for a market order still pending, for example outside trading hours. Proposal: `maxCancelSubmissions: 1` per cycle.
2. **A mandatory stop-loss** at a fixed distance, for a crash between open and close. eToro accepts `stopLoss` for a buy; the gate does not require it yet.
3. **A trading-hours window** for the open: ETH is traded 24/7, other instruments are not.
4. **The access fingerprint as a precondition of activation.** The process must have a broker access key; today that is checked at every open and close.
5. **The account identity (`demoCid`)** before any further write cycle (section 5).
6. **A four-eyes approval** (the approver ≠ the definer) where a second person is available.
7. **A minimum gap between open and close**, and a maximum holding time after which the operator is alerted.

## 5. Decision template: the broker account identity (`demoCid`), phase 5

**Basis** (code and reference only, no broker request):
- `GET /api/v1/me` documents `gcid`, `realCid` and `demoCid` (`etoro-me-scopes.ts`);
- NEXUS keeps only the scope names;
- `demoCid` was never observed live.

| Topic | Proposal | Decision needed |
|---|---|---|
| **Verify the field** | One authorized `/me` read with a reduced report: whether `demoCid` is present and its JSON type, never its value | yes: a broker request |
| **Pseudonym** | HMAC-SHA256 under a NEXUS key (like the access fingerprint, own key id) over `nexus-broker-account:v1`, broker, `demo` and `demoCid`. Kept in memory only; stored only as `{ version, keyId, pseudonym }` | yes: processing an account identifier, even only transiently |
| **Where** | A `/me` read before every write attempt and with every sync, both stamped with the pseudonym. Every open, close, cancel and attestation then requires the same pseudonym on the open's attempt and on the snapshots. Fail closed: no pseudonym, no write | yes: one extra broker request per sync and write (rate limit, latency) |
| **Rotation of the eToro keys** | The pseudonym stays the same for the same account, so continuity holds across a new key pair. This is the gap the access fingerprint cannot close | – |
| **Rotation of the NEXUS key** | As for the access fingerprint: current and previous key id. A rotated-out key gives `unknown_key` and refuses | operation |
| **Existing O22 records** | Unchanged and without a pseudonym, never mapped after the fact. Every decision that depends on them stays fail closed. Settling O22 would need an explicitly decided, reviewed legacy exception | yes, if O22 is to be settled |
| **Identity not available** (`/me` fails, the field is missing, a rate limit, a new format) | Fail closed: no write. Reads may be stored, but without a pseudonym; a decision relying on them is refused | – |
| **Real money** | `realCid` is never read or processed; the build allows demo only | – |

**Recommendation.** Verify the field once with an authorized, reduced `/me` read. Then implement the pseudonym as a separate PR, before any further write cycle.

## 6. Tests

| File | Count | Content |
|---|---|---|
| `test/broker/etoro/o22-plan-c-cycles.test.ts` | 22 | **Rules:** definition, activation (every refusal, every unresolved state, a hand-closed position, a pending and an expired approval, the O22 case), use of the active cycle only, the projection, the strictness of the cycle 2 draft. **Service:** without an active cycle nothing is created; only humans; without the log the steps are unavailable; binding and the own budget; budget isolation between two cycles with nothing reset; an unsettled position and a hand-closed attested position block the next cycle, and the close verdict is `failed` with `POSITION_CLOSED_EXTERNALLY`; an intent of a closed cycle and one from before cycles are never executed; expiry; the kill switch; the instrument allowlist; close and re-activation refused. **Budget isolation from O22:** a spent budget from before cycles stays spent and byte for byte unchanged, the cycle starts at 0 and counts only its own intents, and the old intent is never executed. **P16:** a close in cycle 2 of an open of cycle 1, with a cycle state written directly to the log so that no earlier rule refuses: the only refusal is `CLOSE_TARGET_UNKNOWN` |
| `test/broker/etoro/o22-plan-c-locked.test.ts` | 1 | Without the lock mock: all four locks closed, and with an active cycle the write is `EXECUTION_LOCKED_IN_BUILD`, 0 broker requests, budget unchanged |
| `test/pg/o22-plan-c-cycles.pg.test.ts` | 7, two processes | the same activation at once (one record); two drafts with a barrier (one active); two opens of one cycle (one write); the cycle closed while a reserved write is held (not sent, budget stays spent); **P4:** the cycle closed after A passed the gate and before A read the cycle for its reservation, with A held deterministically on its second snapshot read (refused in the reservation, no `SUBMITTING`, budget 0); **window 2:** the cycle closed after A read the cycle log and before A reserves (no order, the closed cycle's budget spent, a new cycle at 0); a crash after the activation record |

**Counter-proof (24.10.2026, one mutation at a time, one test worker, memory checked before each, `src` restored and checked after each).** Each rule was removed on its own, and the 30 Plan C tests were run:

| # | Removed | Failing | | # | Removed | Failing |
|---|---|---|---|---|---|---|
| P1 | the budget counts only its cycle | 2 | | P11 | the policy hash | 1 |
| P2 | new intents bound to the cycle | 14 | | P12 | the activation statement | 1 |
| P3 | the gate checks the cycle | 1 | | P13 | no reused policy version | 1 |
| P4 | the reservation checks the cycle | 1 | | P14 | a bounded budget | 1 |
| P5 | the re-read after the reservation | 2 | | P15 | `activeUntil` | 2 |
| P6 | unresolved earlier intents | 3 | | P16 | a close only in its own cycle | 1 |
| P7 | positions closed by NEXUS | 3 | | P17 | the cycle's own policy | 2 |
| P8 | pending approvals | 3 | | P18 | the re-check in the cycle log's lock | 1 |
| P9 | another active cycle | 2 | | P19 | only an active cycle can be closed | 1 |
| P10 | the kill switch | 2 | | | | |

**19 of 19 detected.**

## 7. Overlap with PR #34 (cancel bound to the open attempt)

- **Shared file:** only `src/broker/etoro/execution/etoro-demo-execution-service.ts`, in separate regions:
  - #34 changes `cancel()`, adds `cancelRefusals` and one import;
  - Plan C changes create, execute, book, `cycleBudget` and the imports, and adds the cycle methods.
- **Textual merge:** a trial merge computed in memory (`git merge-tree --write-tree`, no branch or worktree changed) shows **no conflict**. The branches were **not** merged. Whichever PR is merged second must be rebased or merged onto the other, and its full test suite run again on the result.
- **Semantics:**
  - `cancel()` is **not** bound to a cycle in Plan C. A cancel removes a pending order of any cycle, spends no budget and keeps the #34 checks (open attempt, order binding, access).
  - With market-only cycle policies, a cancel is only possible for a market order still pending.
  - A cancel budget per cycle is proposed in section 4.
