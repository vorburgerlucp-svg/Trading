# Haiku independent review task: O16 Safety Alerting, Audit & Human Reset Authorization V1

Base under review: `feature/o16-safety-audit-reset-authorization-v1` at `8c3425a`.
Review branch: `feature/o16-haiku-review-hardening-v1`.

PR #15 is the merge candidate. Do not merge it.

## Review scope

Review:

- `src/safety/safety-alerting.ts`
- `src/safety/kill-switch-reset-authorization.ts`
- `src/safety/safety-governance-store.ts`
- `src/safety/safety-audit.ts`
- `src/audit/audit-log.ts`
- `test/safety/o16-safety-audit-reset-authorization.test.ts`
- `docs/O16_SAFETY_AUDIT_RESET_AUTHORIZATION_V1.md`

Read-only dependencies:

- O15 safety envelope
- O15 risk-day tracker
- O15 kill-switch store
- O15 safety service
- generic append-only log
- PostgreSQL append-only store

Do not merge PR #15.

## Purpose

Act as an independent second developer/reviewer.

O16 is governance only.

It may create:

- alerts;
- audit events;
- reset requests;
- human approval/rejection;
- reset authorization evidence.

It must never:

- reset/clear/arm/unlatch the O15 switch;
- enable live trading;
- place a broker order;
- set physical purchase allowed;
- mutate risk/capital limits.

The core invariant is:

> Authorization is not execution.

## High-priority suspected trust boundaries

Do not assume these are safe merely because feature CI is green.

### A. Persisted-trip provenance

Pure reset functions accept a `PortfolioSafetyRequest`.

Attack whether a caller can fabricate a self-consistent `previousKillSwitch: TRIPPED` object and obtain a valid reset request/authorization even though that trip was never loaded from `PortfolioKillSwitchStore`.

Likewise inspect:

`SafetyGovernanceStore.saveRequest(request, currentTripId)`

The `currentTripId` is caller-supplied.

Question:

- Is there a safe orchestration path that reads the current trip from append-only O15 storage itself?
- If not, treat that as a material integration gap.
- Prefer adding a safe service rather than pretending a pure function can authenticate persistence.

### B. Stale recovery

This is a primary attack.

A reset request binds a recovery decision at request time.

Check whether authorization later merely reuses that same historical source request.

Attack:

1. Trip at T0.
2. Portfolio is NORMAL at T1; reset request created.
3. Portfolio becomes DATA_HOLD / CAPACITY_BLOCK / hard breach at T2.
4. Human approves at T2.
5. Can authorization still be produced using the old T1 recovery source?

Authorization must not rely solely on stale recovery evidence.

Safest contract likely separates:

- request-time recovery source;
- authorization-time/current recovery source.

Current recovery must be freshly NORMAL at authorization time.

Also attack a request whose `requestedAt` is materially later than the source decision `asOf`.

### C. Governance log replay/order

Live append preconditions may be safe while reopen validation is not.

Attack raw/hash-valid histories such as:

- AUTHORIZED before APPROVED;
- APPROVED before REQUESTED;
- REJECTED then later APPROVED;
- AUTHORIZED then later APPROVED;
- two terminal events;
- two authorizations;
- approval for request A followed by authorization for request B using ids copied from A.

When validating an append-only history, only prior records may justify the current record.

A validator must not scan future records and retroactively legitimize an earlier invalid event.

### D. Concurrent terminal races

The generic AppendOnlyLog store owns the critical section.

Attack two processes/instances trying to:

- approve and reject the same request;
- authorize the same request twice;
- save two different requests for the same current trip if policy intends one active request.

Check whether preconditions see records committed by the other writer after catch-up.

### E. Request-time provenance/freshness

Attack:

- request time before source recovery asOf;
- request time equal source asOf;
- request time one millisecond after source asOf;
- stale recovery source reused hours later;
- request after trip but before the source snapshot existed.

Decide whether V1 should require `requestedAt === recoveryDecision.asOf` or define an explicit freshness tolerance.

Avoid an unbounded stale-recovery window.

### F. Authorization-time provenance

Authorization should prove:

- same current persisted trip as request;
- current trip has not changed;
- current recovery source is fresh;
- current recovery is NORMAL;
- no DATA_HOLD;
- no CAPACITY_BLOCK;
- no fresh hard breach.

Attack source substitution between request and authorization.

### G. Two-person rule

Attack actor ids:

- exact same id;
- upper/lower-case variation;
- leading/trailing spaces;
- Unicode lookalikes;
- control characters;
- empty ids;
- system/model actor cast at runtime.

Current V1 says opaque authenticated actor IDs. Decide and document canonical identity semantics.

No same-person approval bypass is acceptable.

### H. Timestamp/cooldown boundaries

Attack:

- approval one ms before cooldown;
- exactly at cooldown;
- one ms after;
- approval before request;
- request before trip;
- authorizedAt before approval;
- malformed UTC;
- non-canonical offsets;
- DST/offset strings;
- timestamp overflow.

No wall clock should enter deterministic core logic.

### I. TTL semantics

Attack:

- `evaluatedAt` one ms before expiry;
- exactly at expiry;
- one ms after expiry;
- authorization created after its expiry;
- manipulated `expiresAt`;
- huge TTL overflow.

State explicitly whether validity is inclusive or exclusive at `expiresAt`.

### J. Request/approval substitution

Try:

- approval from request A with request B;
- same request id but changed request fingerprint;
- changed reset policy;
- changed rationale;
- changed requester;
- changed trip fingerprint;
- changed recovery decision id/fingerprint.

Authorization must fail closed.

### K. Authorization tampering/reissue

Modify and recompute superficial fields:

- authorization id;
- fingerprint;
- requester/approver;
- recovery fingerprint;
- expiry;
- trip id;
- approval id;
- applyAllowed;
- liveOrderAllowed;
- physicalPurchaseAllowed.

Self-consistency is not source provenance; full verification must recompute from source artifacts.

### L. Rejection terminality

Attack:

- REJECT then APPROVE;
- REJECT then AUTHORIZE;
- two REJECT events;
- exact idempotent replay;
- same approval id with changed payload.

A rejected request must require a new request, not mutation.

### M. Alert severity

Attack O15 descriptors and O16 state combinations:

- TRIPPED with trip descriptor;
- TRIPPED with data-hold descriptor too;
- DATA_HOLD;
- CAPACITY_BLOCK;
- NORMAL;
- reordered reason/descriptor lists;
- duplicate descriptors.

No O15 `trip` descriptor may be downgraded below critical.

Check alert identity order normalization.

### N. Alert source provenance

`buildSafetyAlertBatch` receives only a decision.

Determine what it can prove structurally and what requires `verifyPortfolioSafetyDecision(request, decision)`.

The SafetyAudit path verifies decisions before recording, but callers may use alert builder independently.

Document or harden the boundary.

### O. Safety audit

Attack:

- same event id with changed payload;
- unverified/tampered O15 decision;
- alert batch for another decision;
- malformed occurredAt;
- audit event replay.

Confirm generic append-only idempotency still works after adding new event types.

### P. Pure/side-effect boundary

Reset authorization core must not import:

- broker;
- live execution;
- capital writes;
- model registry;
- champion board;
- network;
- wall-clock/random identity.

Governance/audit persistence may use append-only ports only.

### Q. No operational reset

Search the entire O16 diff for APIs/fields that could:

- write ARMED into O15 store;
- clear the O15 log;
- delete the trip;
- toggle live-trading policy;
- call broker place/order methods.

There must be no reset-application path in O16.

## Mutation testing

Run a focused mutation campaign if practical.

Prioritize:

- same-person comparison;
- request/source asOf relation;
- cooldown `<` vs `<=`;
- expiry boundary;
- recovery NORMAL check;
- approval decision check;
- governance terminal check;
- governance record-order validation;
- authorization safety booleans;
- alert severity mapping;
- verifier source recomputation.

Classify survivors as:

- real test gap;
- equivalent mutant;
- redundant guard.

Restore source byte-for-byte after mutation testing.

## Scope restrictions

Do not change:

- O9–O15 economic/risk semantics;
- broker adapters;
- Capital Engine accounting;
- model registry;
- ChampionBoard;
- live trading locks;
- physical purchase locks.

A tiny O15 integration API may be changed only if strictly required to source authoritative state; document it separately.

## Delivery

- Work only on `feature/o16-haiku-review-hardening-v1`.
- Keep commits small and reviewable.
- Do not weaken/delete existing tests.
- Run full `npm run check`.
- Push only after final full check is green.
- Do not merge PR #15.

Report:

1. commit hashes
2. files changed
3. full test count
4. mutation result
5. bugs found with severity
6. fixes made
7. guarantees already held/newly pinned
8. unresolved trust/provenance limits
9. recommendation: MERGE / MERGE NACH FIX / REJECT
