# O16 – Safety Alerting, Append-Only Audit & Human Reset Authorization V1

Base: O15 merged at `947a873`.

## Goal

O16 adds governance around the O15 portfolio safety envelope without adding any execution authority.

It provides:

- deterministic alert batches derived from O15 decisions;
- append-only, hash-chained safety audit records;
- reset requests bound to the persisted O15 trip identity;
- four-eyes reset authorization;
- explicit recovery-evidence binding.

O16 does **not**:

- reset the O15 kill switch;
- turn `TRIPPED` into `ARMED`;
- unlock a broker;
- enable live orders;
- enable physical purchases;
- mutate the capital ledger.

The central invariant is:

> Authorization is not execution.

## Alert batching

`createSafetyAlertBatch(decision)` converts the existing O15 `PortfolioSafetyDecision.alerts` into a deterministic governance artifact.

Identity is derived from:

- decision id;
- decision input fingerprint;
- decision timestamp;
- safety state;
- persisted kill-switch state;
- trip id;
- complete alert descriptors.

O16 deliberately defines no alert transport. Delivery to email, Slack, pager or another channel is a later adapter layer.

## Append-only audit

`SafetyAuditStore` uses the existing generic `AppendOnlyLog`.

Audit events cover:

- `ALERT_BATCH`;
- `RESET_REQUESTED`;
- `RESET_AUTHORIZED`.

The store exposes append, read, sync and head-hash operations only.

There is no update, delete, reset, clear, arm, unlatch or execution API.

## Reset request

A reset request can only be created against a currently `TRIPPED` O15 kill switch.

It binds:

- original `tripId`;
- original `triggeringDecisionFingerprint`;
- canonical request time;
- requester identity;
- SHA-256 recovery evidence hash;
- human justification.

A request is invalid if the kill switch is not tripped or the persisted trip identity is malformed.

## Four-eyes authorization

`authorizeResetRequest` requires a second human identity.

Rules:

- requester and approver must differ;
- approval cannot predate the request;
- the current persisted trip must still match the request;
- recovery evidence remains bound into the authorization artifact.

The resulting authorization pins:

- `authorizationOnly: true`;
- `resetExecuted: false`;
- `liveTradingUnlocked: false`.

This is intentional. O16 creates evidence that a reset may be considered by a future, separately reviewed execution milestone. It does not execute one.

## Failure-closed behavior

Authorization fails if:

- the kill switch is no longer the same persisted trip;
- timestamps are non-canonical;
- recovery evidence is malformed;
- requester/approver identity is missing;
- the same human attempts request and approval;
- approval predates request.

## Live-trading boundary

O16 does not alter the O15 decision fields:

- `liveOrderAllowed` remains false;
- `physicalPurchaseAllowed` remains false.

O16 contains no broker-adapter call and no kill-switch reset mutation.

## Future milestone

A later milestone may implement reset execution, but only after independently defining:

1. the authoritative recovery checks;
2. which human roles may approve;
3. how authorization expiry works;
4. how the execution is atomically audited;
5. how broker/live locks remain independently gated;
6. how a reset race with a new trip fails closed.

Until that milestone exists, an O16 authorization artifact is non-executable evidence only.
