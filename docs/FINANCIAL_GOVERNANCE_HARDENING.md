# Financial Gateway V1: Governance and Connector Binding Hardening

Status: design, written before implementation. Base: `36554432` (`feature/financial-connector-gateway-v1`, pushed). Branch:
`feature/financial-gateway-v1-governance-hardening`. Not merged.

Three integrity gaps are closed. No new capability, no real provider, no persistence, no trading.

1. Registry state could be changed from outside the event log.
2. Replayed registry events were not fully revalidated against projected state.
3. A runtime connector could claim a registry identity it did not have, merely by sharing a `connectorId`.

## 1. The reproduced bypass

Before this change, `FinancialConnectorRegistry.get()` returned the internal entry. The entry was frozen only at `registered`. `enabled`, `disabled`
and `activated_production` rebuilt it with an object spread, and the spread result was not frozen. After `enable`, the internal entry therefore accepted
writes:

```
register RESEARCH, enable
entry = registry.get(id)        // internal reference
entry.mode = 'PRODUCTION'       // accepted
production request              // served
```

A registry holding a RESEARCH connector served a PRODUCTION request without any human activation. The regression test in
`test/financial/governance.test.ts` reproduces this and must fail before the fix.

## 2. Immutable state (§2)

- Every `ConnectorEntry` and every journal item is deep-frozen when it is created. Nothing relies on TypeScript `readonly`.
- `get`, `register`, `enable`, `disable` and `activateProduction` return a deep-frozen clone, never the internal reference.
- `history` returns a deep-frozen copy of the journal.
- Writes into a returned value throw `TypeError` (strict mode). The registry state does not change.
- Capabilities cannot be widened: the list is frozen, and V1 has no event that changes it.

## 3. Replay is semantic (§3)

Every event is checked by one rule set. It runs when a live write is checked, and again on every replayed record. The two paths differ only in the error:

- Live write: a caller error (`FinancialGatewayError` with a code such as `CONNECTOR_ALREADY_REGISTERED`).
- Replay: a stored event that breaks a rule raises `FinancialGovernanceIntegrityError` (`code = 'GOVERNANCE_INTEGRITY_ERROR'`). `open()` fails closed.

A hash-valid record is not enough. The append-only hash proves that a row was not modified. It does not prove that the row was lawful.

Rules, by event type:

| Event | Rules |
|---|---|
| all | `eventId` is a registry id and equals the record id; `at` is canonical UTC; `reason` 1–500 characters; `by` is human or system with a valid id; `connectorId` is a valid identifier; no unexpected fields |
| `registered` | exactly one `entry`, no `gate`; `entry.connectorId === connectorId`; provider valid; transport valid; capabilities non-empty, implemented, unique; `mode` is `SHADOW` or `RESEARCH`; `enabled === false`; license shape valid; `registeredAt` is canonical and equals the event time; connector not already registered |
| `enabled` | target exists; actor human; target not already enabled |
| `disabled` | target exists; target currently enabled |
| `activated_production` | exactly one `gate` and no `entry`; target exists; actor human; target not already `PRODUCTION`; license serves production; target enabled; gate `passed === true` and shaped |

Times are normalised to canonical UTC when a live event is created, so a stored event always carries the form the rules check.

## 4. Runtime connector binding (§4)

Checked on every request, before the connector is called:

1. A constructor refuses two runtime connectors with the same `connectorId` (`CONNECTOR_ID_DUPLICATE`). It never chooses one silently.
2. `connectorId`, `provider` and `transport` of the runtime connector must equal the registry declaration (`CONNECTOR_IDENTITY_MISMATCH`).
3. The registry must allow the capability, and the runtime connector must expose it through `capabilities()` (`CONNECTOR_CAPABILITY_MISMATCH`).
4. A runtime connector that advertises more than the registry does not widen the registry's rights. The registry check stays first and refuses with `CAPABILITY_NOT_ALLOWED`.

The full order of checks is in [docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §22](FINANCIAL_CONNECTOR_GATEWAY_V1.md).

## 5. Payload envelope (§5)

- `retrievedAt` must be canonical UTC, exactly `YYYY-MM-DDTHH:mm:ss.sssZ`. A value that only parses is refused (`CONNECTOR_PAYLOAD_INVALID`).
- `rawPayloadHash` must be exactly 64 lowercase hex characters (SHA-256). `''`, `abc` and uppercase are refused (`CONNECTOR_PAYLOAD_INVALID`).
- Evidence is built from validated copies. A connector that keeps and later mutates its candidate or text blocks cannot change evidence it already produced.

## 6. New error codes

| Code | Meaning |
|---|---|
| `CONNECTOR_ID_DUPLICATE` | two runtime connectors share an id (constructor) |
| `CONNECTOR_IDENTITY_MISMATCH` | runtime provider or transport differs from the registry |
| `CONNECTOR_CAPABILITY_MISMATCH` | the registry allows a capability the runtime connector does not expose |
| `CONNECTOR_PAYLOAD_INVALID` | malformed `retrievedAt` or `rawPayloadHash` |
| `GOVERNANCE_INTEGRITY_ERROR` | stored registry history violates the rules (integrity error, not a caller code) |

## 7. Behaviour changes, called out

- `disable` of a connector that is not enabled now fails with `REGISTRATION_INVALID`.
- Activating a connector that is already `PRODUCTION` now fails with `REGISTRATION_INVALID`.
- A runtime connector that does not expose a registered capability now fails with `CONNECTOR_CAPABILITY_MISMATCH`, before the MCP tool map is consulted. Previously it failed with `TOOL_NOT_ALLOWED`.
- A runtime connector must declare the registry's provider and transport. Two existing test fixtures declared another provider or transport; they are aligned to the registry declaration. Their assertions are unchanged.

## 8. Not in scope

No PostgreSQL persistence, no DB evidence seal, no real provider, no new capability, no routing, no broker or trading path. The build locks and migrations
001–011 are unchanged.

## 9. Limitations

- Governance state is still in memory. Persistence and a DB seal are the next package.
- Binding is checked per request, not once at construction. Registrations can change after construction, so a per-request check is the one that holds.
- The replay rules are those of this version. A later rule change needs a versioned replay, not a silent edit.
