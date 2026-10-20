# O22 – Proposal: release of the one controlled eToro demo cycle (B1)

Status: **proposal for review, not applied.** Nothing in this file changes the build. `BUILD_LOCKS.etoroDemoExecution = true` and `ETORO_DEMO_EXECUTION_ENABLED=0` stay until a human approves and merges the separate change described here.

Context: `docs/O22_ETORO_DEMO_TRADING_E2E_V1.md`, section 17 (review, runbook, success criterion, A1–A6).

## 1. Preconditions (all, in this order)

| # | Precondition | State 2026-10-19 |
|---|---|---|
| P1 | PR #25 (O22) reviewed by a human and merged into `main` | open (Draft) |
| P2 | **C1** (machine-checked test verdict), **C2** (no account read for a close), **C3** (request checked before the reservation) implemented and tested; reviewed and merged with PR #25 | implemented and tested on the O22 branch 2026-10-19 (3100/3100 locally); human review open |
| P3 | Operating rules (17.3) and the acceptance of the remaining residual risks A1, A3, A5, A6 recorded | operating rules set 2026-10-19; **A1, A3, A5, A6 accepted on 20.10.2026 for the one controlled demo test only** (17.6); success criterion unchanged |
| P4 | B2: account without position or order | closed 2026-10-19; checked again in runbook step 2 |
| P5 | B5: demo key `demoWrite=true`, `realWrite=false` | closed 2026-10-19; a key change needs a new `/me` check |
| P6 | B6: success criterion | decided 2026-10-19 |
| P7 | ETH/USD instrument, eToro mapping 100001, USD quote path | done 2026-10-19 |

## 1a. The release change (20.10.2026; not merged, not active)

PR #25 (O22) was merged into `main` as `6d3e433`. The release change was then set up again on that `main`:

| Branch | Content | Status |
|---|---|---|
| `feature/o22-b1-demo-release` (on `main` `6d3e433`) | the release diff of `e839b3f`, cherry-picked unchanged, plus the tests that close the test gaps of 1b and this documentation | **the change to review**; draft PR against `main`; not merged, not active. Checks: typecheck clean. Full local suite (`vitest --project unit --project pg`), run twice: **1st run 3133/3134** – the new test `test/pg/o22-release-runtime.pg.test.ts` › "enabled …" exceeded the global 60 s limit while the whole pg project ran in parallel (alone it takes about 10 s: 10.5 s measured); it then got its own limit of 180 s with unchanged assertions; **2nd run 3134/3134** (that test 9.1 s). |
| `feature/o22-demo-cycle-release` (`e839b3f`, on the pre-merge O22 head `8a5949f`) | the first draft of the release | superseded by the branch above; kept for traceability, not to be merged |
| `feature/o22-demo-cycle-relock` (`9a881a7`) | a draft of the re-lock content that restores a whole old tree | **obsolete; must not be merged**. The re-lock is a targeted revert of the merged release commit on the then current `main` (section 5a) |

The operator accepted A1, A3, A5 and A6 on 20.10.2026 for the one controlled demo test only; the success criterion is unchanged. The reviews so far are technical agent reviews; no human code review has taken place.

## 1b. Agent review of the release draft (20.10.2026, checked commit `e839b3f`)

A technical review by the separate review agent (an AI agent, read only; **not a human code review**), limited to the release diff `8a5949f..e839b3f` and the adapted tests. Result: **all checked points hold, no defect found.**

| Point | Result |
|---|---|
| Only the demo build lock is opened | holds: `safety.ts` sets only `etoroDemoExecution: false`; `app.ts` changes only the health type; the live, broker and physical gates read the unchanged three locks |
| No broker write without `ETORO_DEMO_EXECUTION_ENABLED=1` | holds, verified in the code: the flag defaults off (`config.ts`); the execution wiring and the only `HttpsDemoExecutionTransport` are built only with it (`bootstrap.ts`, `compose.ts`); without it every intent route answers `EXECUTION_DISABLED` (`app.ts`) |
| Budget, demo/real separation and every other protection | hold: no other code changed; gate, reservation re-check under the lock, operator authentication, kill switch, account safety for opens, config refusals of live trading and a real eToro mode, demo-only endpoints, policy hard-coded in `compose.ts` |
| Adapted tests | hold: value tests still assert the other three locks `true`; mocking the lock closed in the tests of a locked build is legitimate; no test transport can reach the network; `test/runtime/o22-release.test.ts` is genuinely unmocked |
| A write outside the one cycle | holds in code, with note b below |

**Test gaps (not defects):** (a) the unmocked release test proves "not enabled" through the service flag; the production path "not enabled" (the service is never built, every route `EXECUTION_DISABLED`) is proved by the mocked runtime tests and verified in the code, not by an unmocked runtime test; (b) with the lock open no test drives the real composition plus the HTTP routes – only the fixture service.

**Test gaps closed on `feature/o22-b1-demo-release`:** `test/pg/o22-release-runtime.pg.test.ts` runs the release build **without any mock of the lock** through the real entry path (configuration from the environment, PostgreSQL, `startRuntime`, the HTTP routes, operator authentication), with only the outside world simulated (a production-labelled fixture quote, the read-only eToro answers, a scripted broker; no network): (1) by default, without `ETORO_DEMO_EXECUTION_ENABLED`, no execution log is opened, the create and execute routes answer `EXECUTION_DISABLED`, the cycle route reports `execution: "disabled"`, and no broker request is made, although an execution transport was passed; (2) with `ETORO_DEMO_EXECUTION_ENABLED=1` the open goes through the real routes exactly once to the demo order endpoint, a second open is refused by the cycle budget (`CYCLE_OPEN_BUDGET_EXHAUSTED`), the routes still require the operator token, no ledger row is written and no key or token is stored.

**Note (operating rule):** the cycle budget is counted **per database** (the intent log), not per build. Started with `ETORO_DEMO_EXECUTION_ENABLED=1` against another or an empty database, this build would allow one more open and close. Therefore: this build runs the cycle **only against the operator's NEXUS database** used for the preparation, it is **never started with the flag against any other database**, and the re-lock follows right after the cycle (section 5a).

## 2. The change itself (a separate branch and PR, e.g. `feature/o22-demo-cycle-release`)

Exactly one functional line:

```diff
--- a/src/nexus/safety.ts
+++ b/src/nexus/safety.ts
-export const BUILD_LOCKS = Object.freeze({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: true } as const);
+export const BUILD_LOCKS = Object.freeze({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: false } as const);
```

Required follow-ups in the same change (no other behaviour):
- `src/runtime/app.ts` L22: the `buildLocks` type of the health answer (`etoroDemoExecution: true` → `false`).
- The comment above `BUILD_LOCKS` (`src/nexus/safety.ts` L11–12): state the release, its scope (one demo cycle, policy `etoro-demo-e2e-cycle-policy:v2`) and that it is re-locked afterwards.
- The tests that pin the lock deliberately are updated to the new value **and keep asserting `liveTrading`, `brokerOrders` and `physicalPurchase` = `true`**:
  `test/broker/etoro/o21-boundary.test.ts` L146, `test/broker/etoro/o21-build-lock.test.ts` L21 and L26, `test/broker/etoro/o21a1-observation.test.ts` L206, `test/financial/boundaries.test.ts` L61, `test/runtime/o18-app.test.ts` L19, `test/runtime/o18-runtime-config.test.ts` L92, `test/runtime/o18-services.test.ts` L74, `test/runtime/o20-config.test.ts` L83, `test/runtime/o21-config.test.ts` L67, `test/runtime/o21-runtime.test.ts` L155 and L158, `test/runtime/o21a-runtime.test.ts` L103, `test/runtime/o22-runtime.test.ts` L193 and L197.
- Tests that prove "execute is refused by the build lock" (13 occurrences of `EXECUTION_LOCKED_IN_BUILD` / `ETORO_DEMO_EXECUTION_LOCKED_IN_BUILD` in `test/broker/etoro/o21-build-lock.test.ts`, `o21-fixture.ts`, `test/runtime/o21-runtime.test.ts`, `test/runtime/o22-runtime.test.ts`, `test/pg/o21-runtime.pg.test.ts`) keep testing the locked state by mocking the safety module with `etoroDemoExecution: true` – the same `vi.mock('…/nexus/safety.js')` technique the service tests already use to unlock it (`o21-service.test.ts`, `o21-concurrency.test.ts`, `o22-account-safety-cycle.test.ts`). `o22-twelve-data-crypto-quote.test.ts` passes `buildLocked` as a gate input and is unaffected. No test may be deleted to make the release pass.

Unchanged by the release: `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`, `ETORO_TRADING_MODE=demo` (real refused), the cycle policy (100 USD, leverage 1, buy at market, one open + one close over the whole intent log), the account limits, the kill switch, the demo-only endpoints.

## 3. Configuration at run time (operator, not committed)

The worktree `.env`: `ETORO_ENABLED=1`, `ETORO_TRADING_MODE=demo`, `ETORO_DEMO_EXECUTION_ENABLED=1` only for the cycle; the demo keys of the `/me` check; operator id and token. The runtime on loopback.

## 4. Verification before the cycle

- `npm run typecheck` and the full suite (`vitest --project unit --project pg`) green on the release head; CI green.
- `GET /api/health`: `buildLocks` = `{ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: false }`, `liveTrading: locked`.
- Then the runbook (section 17.3), from step 1.

## 5. Closing the cycle: on success AND on any STOP (mandatory)

The same steps, in this order, whether the test passed, failed or was stopped at any step:

1. **Disable execution.** Set `ETORO_DEMO_EXECUTION_ENABLED=0` in the worktree `.env`. **Changing the `.env` alone proves nothing about a process that is already running**: the runtime reads its configuration only at start.
2. **Stop the affected runtime.** Stop every NEXUS runtime process of this worktree (`node dist/runtime/main.js`; check by the listening port and the process list that none is left). Then either leave it stopped, or start it again with the locked configuration (`ETORO_DEMO_EXECUTION_ENABLED=0`).
3. **Prove the locked state** on the process that is actually running (or prove that none runs):
   - `GET /api/broker/etoro/demo/cycle` answers `execution: "disabled"` (no budget, no reconciliation) – execution is off in the running process;
   - every `POST` intent route (`execute`, `cancel`) is refused (`EXECUTION_DISABLED`) and sends nothing;
   - after the re-lock is merged and deployed: `GET /api/health` shows `buildLocks.etoroDemoExecution: true` and the other three locks `true`.
4. **Report what is not settled.** One approved read-only sync, then the cycle route: every position or order that is not proved closed – an AMBIGUOUS intent, `closed_position_still_open`, `open_position_missing` after a close outside NEXUS, external positions, more than one position (17.5) – is reported explicitly **for manual clarification in the eToro demo account**. NEXUS never closes or retries on its own.
5. **Record the result:** the test verdict (`passed` / `failed` with the criterion / `incomplete` with the reason) and sanitized evidence in the O22 documentation.

## 5a. Re-lock (mandatory, a separate reviewed change)

- The re-lock is a **targeted revert of the release change on the state that is actually merged at that time**: `git revert <the merged release commit>` on a branch from the then current `main`, so every change made in between stays. It must **not** lay an old complete tree over later changes.
- Its content: `BUILD_LOCKS.etoroDemoExecution` back to `true`, the health type back to `true`, the pinned lock tests and the tests of a locked build back to their locked form (without the lock mock), and `test/runtime/o22-release.test.ts` and `test/pg/o22-release-runtime.pg.test.ts` removed – exactly the inverse of the release diff, nothing else. If the release reaches `main` as a merge commit, the revert names that merge commit with its first parent as the mainline (`git revert -m 1 <merge commit>`); for a squash merge, the squashed commit.
- Checks: typecheck and the full suite green; `GET /api/health` after deployment shows all four locks `true`.
- The existing branch `feature/o22-demo-cycle-relock` (`9a881a7`) is only a **draft** of that content: it is built on the release draft and restores the then locked tree as a whole. It is **not** to be merged as it is; it is replaced by the targeted revert once the release has been merged.

## 6. What this proposal does not do

It does not open the lock, change configuration, send an order, close a position, book anything, merge anything or raise any limit.
