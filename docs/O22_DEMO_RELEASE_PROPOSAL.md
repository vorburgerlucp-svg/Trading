# O22 – Proposal: release of the one controlled eToro demo cycle (B1)

Status: **proposal for review, not applied.** Nothing in this file changes the build. `BUILD_LOCKS.etoroDemoExecution = true` and `ETORO_DEMO_EXECUTION_ENABLED=0` stay until a human approves and merges the separate change described here.

Context: `docs/O22_ETORO_DEMO_TRADING_E2E_V1.md`, section 17 (review, runbook, success criterion, A1–A6).

## 1. Preconditions (all, in this order)

| # | Precondition | State 2026-10-19 |
|---|---|---|
| P1 | PR #25 (O22) reviewed by a human and merged into `main` | open (Draft) |
| P2 | **C1** (machine-checked test verdict), **C2** (no account read for a close), **C3** (request checked before the reservation) implemented and tested; reviewed and merged with PR #25 | implemented and tested on the O22 branch 2026-10-19 (3100/3100 locally); human review open |
| P3 | Operating rules (17.3) and the acceptance of the remaining residual risks A1, A3, A5, A6 recorded | operating rules set 2026-10-19; acceptance open |
| P4 | B2: account without position or order | closed 2026-10-19; checked again in runbook step 2 |
| P5 | B5: demo key `demoWrite=true`, `realWrite=false` | closed 2026-10-19; a key change needs a new `/me` check |
| P6 | B6: success criterion | decided 2026-10-19 |
| P7 | ETH/USD instrument, eToro mapping 100001, USD quote path | done 2026-10-19 |

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

## 5. Re-lock after the cycle (mandatory)

- Immediately after step 9 (or after any STOP): `ETORO_DEMO_EXECUTION_ENABLED=0`.
- A follow-up change sets `etoroDemoExecution: true` again and restores the pinned tests. The spent budget would refuse further writes anyway; the lock makes it explicit.
- The result (test verdict `passed` / `failed` with the failed criterion) and sanitized evidence are recorded in the O22 documentation.

## 6. What this proposal does not do

It does not open the lock, change configuration, send an order, close a position, book anything, merge anything or raise any limit.
