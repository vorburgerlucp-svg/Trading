# Financial Connector Gateway V1

Status: design, written before implementation. Base: `c57eb63` (`feature/pattern-engine-v1c-flags-candles`).
Branch: `feature/financial-connector-gateway-v1`. Not merged.

The gateway is a provider-neutral, read-only boundary for external financial evidence (fundamentals, earnings, analyst estimates, news, portfolio
reads). It lets NEXUS use providers such as LSEG, Alpha Vantage, Massive, Morningstar, IBKR (read), Alpaca (read), future MCP servers and future
REST providers, without coupling NEXUS to Claude, OpenAI, Gemini or any single vendor.

```
External finance source
        ↓
Connector adapter (provider-specific: maps capability → approved read operation)
        ↓
Transport: MCP (allowlisted read tools) | REST (resilient HTTP) | internal
        ↓
Schema validation (raw → normalized, fail closed)
        ↓
FinancialEvidence (deterministic identity, provenance, license, time semantics)
        ↓
NEXUS deterministic workflow  →  Blackboard / context (models receive data only)
```

Read-only. No order execution, money movement, withdrawal or position change exists in this layer.

## 1. Existing architecture respected

- **Market bars and quotes** stay owned by `MarketDataProvider` and `MarketDataService`. The gateway never produces a second OHLC pipeline. A finance
  connector that exposes prices may be identified as `market_data_reference` (V1 capability enum), but it is not an authoritative price source.
- **Instrument identity** goes through `InstrumentRegistry` (`mappingAt`). Ticker is never the canonical identity.
- **Resilience:** `ResilientCaller` (`src/market-data/providers/resilience.ts`) is reused, not duplicated: timeout, bounded retries, `Retry-After`,
  pacing and the circuit breaker.
- **External text:** `toUntrustedBlock` and `scanForInjection` (`src/security/untrusted-input.ts`) are reused.
- **Governance:** the connector registry follows the event-sourced `ModelRegistry` pattern (append-only log, governance rules checked on every replay).
- **Broker:** `BrokerAdapter` is a separate boundary. The gateway does not import it, and no gateway type can reach it.
- **Locks:** `BUILD_LOCKS` (`liveTrading`, `brokerOrders`, `physicalPurchase`) are unchanged. The gateway has no code path that reads or writes them.

## 2. Trust boundaries

| Boundary | Trust | Rule |
|---|---|---|
| External provider / MCP server | Untrusted | Its responses are data. Its advertised tools never extend an allowlist. Its text is quarantined input. |
| Connector adapter | Trusted code, provider-specific | Chooses the approved operation for a capability. Holds no NEXUS state. Gets only its own credential reference. |
| Transport (MCP, REST) | Trusted code | Transport only. Domain code never names a tool or URL. |
| Gateway | Trusted | Validates requests, enforces mode, license and capability, validates responses, builds evidence. |
| Model | Untrusted for control | Asks for a capability, never a tool name. Receives evidence as data only. |

No connector may reach: `BrokerAdapter`, the Capital Engine, risk limits, the live-trading switch, the model registry governance, deployment, or
credentials of another connector.

## 3. Capabilities

`FinancialCapability` (exact enum, V1):

`fundamentals`, `financial_statements`, `earnings`, `earnings_estimates`, `analyst_estimates`, `macro`, `economic_calendar`, `news`,
`company_events`, `institutional_holdings`, `insider_transactions`, `options_reference`, `portfolio_read`, `broker_account_read`,
`market_data_reference`.

Not in V1, and not in the enum: `order_execution`, `money_transfer`, `withdrawal`, `position_change`. A test asserts they are absent.

**Implemented payload validators in V1:** `fundamentals`, `news`, `portfolio_read`. `earnings` and `analyst_estimates` are reserved until their validators
land with their own tests (a follow-up). Every other enum value is reserved too. A connector declaring a reserved value fails registration with
`CAPABILITY_NOT_IMPLEMENTED`, so no capability is advertised without a validator.

## 4. Connector lifecycle

1. **Register** (`FinancialConnectorRegistry.register`): connector id, provider, transport, capability allowlist, license, environment, mode.
   New connectors start in `SHADOW` or `RESEARCH`, never `PRODUCTION`. The capability allowlist is held by the registry, not by the connector.
2. **Enable / disable:** a human may enable. The system may disable (a safety action). A disabled connector fails closed before any network or tool call.
3. **Activate to PRODUCTION:** requires a human actor (`kind: 'human'`), a reason, a license of `production_approved`, a non-empty capability
   allowlist, the connector enabled, and a passed schema and benchmark gate. A connector cannot activate itself, and external data cannot change its rights.
4. **Connection:** `connected`, `not_connected` or `degraded`. A connector without credentials reports `not_connected`. Requests fail with
   `DATA_NOT_CONNECTED`. An empty result is never returned as a stand-in for missing data.
5. **Health:** state, last success and failure, failure kind, consecutive failures, latency. Health is observed only. It never changes a mode,
   a license, a capability or any risk limit in V1.

## 5. Modes and environments

Environment of a request: `research`, `shadow`, `production`.

| Mode | Serves environment |
|---|---|
| `SHADOW` | `shadow` |
| `RESEARCH` | `research`, `shadow` |
| `PRODUCTION` | `research`, `shadow`, `production` |

A request whose environment the connector's mode does not serve fails with `MODE_NOT_ALLOWED`.

## 6. License policy (`financial-license-policy:v1`)

`FinancialSourceLicense`: `status` ∈ `unreviewed | research_only | production_approved | restricted`, `redistribution` ∈ `unknown | forbidden |
internal_only | allowed`, optional `note`.

| License status | research | shadow | production |
|---|---|---|---|
| `production_approved` | yes | yes | yes, if redistribution is `internal_only` or `allowed` |
| `research_only` | yes | yes | no |
| `unreviewed` | yes, labelled `unreviewed` | yes, labelled `unreviewed` | no |
| `restricted` | no | no | no |

Evidence always carries its license. Evidence from an `unreviewed` source is never described as production-approved. A production request on a
non-approved source fails with `LICENSE_NOT_ALLOWED`.

## 7. Requests

`FinancialEvidenceRequest` is a discriminated union by capability. Every request carries:

`requestId`, `capability`, `connectorId` (required; see §13), `asOf`, `environment`.

Where applicable: `instrumentId` (NEXUS identity), `from`, `to`, `currency`, `period`. There is no field for an arbitrary tool name, URL, method or
JSON body. `parseFinancialRequest(unknown)` builds a request from a known shape only and rejects anything else (`REQUEST_INVALID`). Models never produce
a request object directly: the deterministic workflow does.

## 8. Connector interface

```
interface FinancialConnector {
  readonly connectorId: string;
  readonly provider: string;
  readonly transport: 'mcp' | 'rest' | 'internal';
  connection(): 'connected' | 'not_connected' | 'degraded';
  capabilities(): readonly FinancialCapability[];
  fetch(request: FinancialEvidenceRequest, mapping: ProviderInstrumentMapping | null): Promise<ConnectorPayload>;
  health(): FinancialConnectorHealth;
}
```

There is no generic `executeAnything(toolName, args)` on the domain-facing interface. `fetch` receives a frozen copy of the request, so an adapter cannot mutate
the caller's object.

## 9. MCP transport (`mcp-financial-transport:v1`)

- `McpReadClient`: `connection()` and `callReadTool(serverId, toolName, args)`. It is transport only.
- An MCP connector declares a **static allowlist** `capability → tool name`. The map is fixed at construction. Tools the server advertises are data
  and never enter the map.
- A call to any tool name outside the map is refused (`TOOL_NOT_ALLOWED`). No call is made.
- The adapter's `map` also receives the provider symbol that was sent for the request. An answer can then be checked against the symbol that was asked
  for, which keeps a ticker rename honest (§15).
- Write tools are refused even if mapped: names matching `buy`, `sell`, `submit_order`, `place_order`, `modify_order`, `cancel_order`,
  `transfer`, `withdraw`, `change_position`, and similar, are rejected at construction (`WRITE_TOOL_REFUSED`). The check is by name: a write verb as a
  whole word (`place_order`), a run-together compound (`placeorder`, `transferfunds`), or a position change. It is a tripwire. The fixed allowlist is
  the control, and a read name that only contains a word such as `positions` (`get_open_positions`) stays allowed.
- A response that names a next tool (`nextTool`, `call`, `tool`, an instruction) is treated as data and ignored. The connector makes exactly the
  calls its map defines.

## 10. REST transport

- A REST connector uses `ResilientCaller` with an injected `FetchLike`. HTTP statuses map to transport errors: `429` → `rate_limited` (with `Retry-After`),
  `5xx` → `provider_unavailable`, `401`/`403` → `auth_failed`, `404` → `not_found`, `400` → `bad_request`. Timeouts and network failures are classified by
  the shared resilience code. Retries are bounded. Circuit-open calls send no request.
- Authentication: the connector receives a credential **reference** and resolves it through a `SecretProvider`. The secret is placed only in the
  request header, never in the URL, a log, an error, evidence or a hash.

## 11. Secret handling

- `SecretProvider.get(credentialRef): string | undefined`. A `credentialRef` is a configuration name (`alpha-vantage-prod`), matched by
  `^[a-z0-9][a-z0-9-]{0,62}$`.
- Registry events, evidence, hashes, logs and errors contain only the reference, never the value.
- Error text from a provider is redacted for every secret value the transport knows, before it leaves the transport.
- No connector embeds a key in source or tests.

## 12. External text is untrusted

- News, analyst commentary, filing text and any provider or MCP text is normalized into **text blocks**. Each block is passed through
  `toUntrustedBlock(...)`: flagged text is replaced by `QUARANTINE_NOTICE`, the flags are kept, and the hash of the original text is recorded for audit.
- A text block is data. It is never concatenated into a system, developer or tool instruction, a risk rule or a broker parameter.
- The provider's text cannot select the next tool. The gateway has no method that takes a tool name from a response.

## 13. Explicit connector selection

A request must name `connectorId`. Without it the gateway fails with `CONNECTOR_SELECTION_REQUIRED`. Automatic routing is not in V1: there is no
measured provider quality yet. A `FinancialConnectorRouter` comes later, after measurement.

## 14. Schema validation

Each capability has a validator. A connector's raw payload is validated, normalized into the domain shape, and fails closed on any mismatch:

- unknown fields are rejected (`SCHEMA_INVALID`);
- timestamps are required where declared, and must parse as UTC instants;
- financial numbers are exact decimal strings. `NaN`, `Infinity` and binary floats are rejected;
- currency is an explicit ISO 4217 code. A payload currency that differs from the request currency fails with `CURRENCY_MISMATCH`; there is **no
  implicit FX conversion** (USD → CHF is never inferred);
- missing optional values remain `null`. A missing value is never synthesized as `0`;
- the instrument of the response must match the mapping resolved for the request (`INSTRUMENT_MAPPING_MISMATCH`).

Raw payloads are not stored in the evidence. The evidence keeps `rawPayloadHash` and the normalized data.

## 15. Instrument identity

- Requests name the NEXUS `instrumentId`.
- The gateway resolves the provider symbol with `InstrumentRegistry.mappingAt(instrumentId, provider, asOf)`. No mapping at `asOf` fails with
  `INSTRUMENT_MAPPING_MISSING`.
- Evidence records the NEXUS `instrumentId` as the identity. The provider symbol is recorded as a reference only.
- A ticker rename creates a new mapping window. The `instrumentId` is unchanged, so it is the same company.

## 16. Financial evidence envelope (`financial-evidence:v1`)

```
FinancialEvidence {
  evidenceId                 deterministic
  schemaVersion              'financial-evidence:v1'
  connectorId, provider, transport, capability
  instrumentId?              NEXUS identity
  queryFingerprint           hash of the canonical request
  effectiveAt?               economic / effective time (from the request or payload)
  providerPublishedAt?       when the provider published it (from the payload)
  retrievedAt                when the transport completed the fetch (process time)
  nexusReceivedAt            when the gateway accepted the response (process time)
  knowledgeProof             'PROCESS_RECEIPT_UNSEALED' (V1 only)
  rawPayloadHash             hash of the raw response
  contentHash                hash of the normalized data and text-block hashes
  data                       typed, normalized payload (one shape per capability)
  textBlocks?                UntrustedBlock-shaped text, quarantined where flagged
  license                    the source license at the time of the request
  provenance                 { policyVersion, connectorMode, licenseStatus, connectionState }
  o1Status                   'EXTERNAL_FINANCIAL_EVIDENCE_UNSEALED' (V1 only)
  quality                    { schemaValid: true, mappingVerified, currencyExplicit, degraded }
  createdAt                  process time of creation (not part of identity)
}
```

**Time semantics.** `effectiveAt`, `providerPublishedAt`, `retrievedAt` and `nexusReceivedAt` are never collapsed. `providerPublishedAt` does **not**
prove that NEXUS held the evidence at that time.

**Knowledge proof.** V1 has no database seal for this evidence. The only value is `PROCESS_RECEIPT_UNSEALED`: the process received it at
`nexusReceivedAt`. It is not historical point-in-time proof. The name `DATABASE_SEALED` is not used anywhere in V1.

**Identity** (`financial-evidence:v1`):

```
evidenceId = 'fe_' + hashOf({
  schemaVersion, connectorId, provider, transport, capability,
  canonicalRequest, instrumentId, contentHash, effectiveAt, providerPublishedAt,
  license (status, redistribution), provenancePolicyVersion
})
```

`createdAt`, `retrievedAt` and `nexusReceivedAt` are excluded, and so is the `requestId`, a caller correlation id that is not part of what was asked. In
V1, `createdAt` equals `nexusReceivedAt`. The same normalized response and the same request under the same policy versions give
the same id. A different publish time, content, instrument, connector or schema changes it.

**Immutability.** Evidence is deep-frozen. Request objects passed to adapters are frozen copies.

## 17. Research-only consequence

`PROCESS_RECEIPT_UNSEALED` evidence may be used for research, display, analyst context, shadow evaluation and experiments. It must not qualify as strong
O1 capital evidence and must not unlock live trading. `strongO1Eligible(evidence)` returns `false` for every V1 evidence, with the reason
`UNSEALED_EXTERNAL_EVIDENCE`. Promotion requires the later persistence and seal version.

## 18. Model integration

Models never call a connector. The architecture is:

```
Model asks for an evidence need
  → NEXUS deterministic workflow
  → FinancialDataGateway
  → normalized evidence
  → Blackboard / context (as data)
```

There is no `Claude → IBKR`, `OpenAI → LSEG` or `Gemini → Alpha Vantage` path. A static test asserts that `src/ai` does not import `src/financial`.

## 19. Portfolio read and the broker boundary

- `portfolio_read` and `broker_account_read` are read-only evidence (cash balances, positions, unrealized P&L, open orders as read data).
- The gateway exposes no `placeOrder`, `cancelOrder` or `modifyOrder`.
- IBKR market and account data belong to a read connector. IBKR execution belongs to `BrokerAdapter`. One type never serves both. A read connector
  cannot be cast to an execution connector.

## 20. Versions

`financial-gateway:v1`, `financial-evidence:v1`, `financial-connector-registry:v1`, `mcp-financial-transport:v1`, `financial-license-policy:v1`,
`financial-untrusted-policy:v1`. Each enters the evidence identity or the registry state it governs.

## 21. Persistence

None in V1. The registry uses an in-memory append-only log, as `ModelRegistry` does by default. Migrations 001–011 are unchanged. Persistence, the
database seal and a retention policy for raw artifacts come in a later version.

## 22. Failure semantics

| Code | Meaning | Retryable |
|---|---|---|
| `CONNECTOR_SELECTION_REQUIRED` | no `connectorId` | no |
| `CONNECTOR_NOT_FOUND` | unknown connector | no |
| `CONNECTOR_DISABLED` | connector disabled (no call made) | no |
| `DATA_NOT_CONNECTED` | no credentials or not configured | no |
| `DATA_DEGRADED` | connector degraded and environment is production | no |
| `CAPABILITY_NOT_ALLOWED` | capability not in the registry allowlist | no |
| `CAPABILITY_NOT_IMPLEMENTED` | capability has no validator | no |
| `MODE_NOT_ALLOWED` | environment not served by the mode | no |
| `LICENSE_NOT_ALLOWED` | license does not permit the environment | no |
| `REQUEST_INVALID` | request outside the typed union | no |
| `TOOL_NOT_ALLOWED` / `WRITE_TOOL_REFUSED` | MCP tool outside the map, or a write tool | no |
| `SCHEMA_INVALID` | provider data failed validation | no |
| `INSTRUMENT_MAPPING_MISSING` / `INSTRUMENT_MAPPING_MISMATCH` | identity not resolved or not matching | no |
| `CURRENCY_MISMATCH` | payload currency differs from request | no |
| `PERIOD_MISMATCH` | payload period differs from the requested period; nothing is substituted | no |
| transport errors | `rate_limited`, `timeout`, `provider_unavailable`, `circuit_open`, `auth_failed`, `not_found`, `bad_request` | per `ResilientCaller` |

Checks run in this order: selection, registration, enabled, capability allowlist, license, mode, connection, instrument mapping, the connector call
(its tool map), payload validation, requested currency and period, provider symbol. The license comes before the mode, so an unapproved source reports
its license.

A failure never returns empty evidence. Health records the failure and changes no mode, license or risk setting.

## 23. Test matrix

Unit tests, no network. The MCP connector is fixture-only; the REST contract uses an injected fake fetch. No paid provider is contacted in CI.

Covered: registration and modes, human activation, capability match and escalation, disabled and not-connected connectors, explicit selection,
the MCP allowlist and write-tool refusal, REST schema, timeout, rate limit and circuit breaker, secret absence from every output, deterministic and
`createdAt`-free identity, instrument mapping and ticker rename, null versus zero, explicit currency, prompt injection quarantine, provider tool
requests ignored, portfolio read isolation, broker boundary, license distinction, no O1 promotion, mutation isolation, and the safety-lock regression.

## 24. Red team

The tests try to: call an arbitrary MCP tool; let a model supply a tool name; turn news text into an instruction; leak a token into a hash;
let a provider enable itself; treat unreviewed data as production-approved; reach the broker from a read connector; create a second instrument on a
rename; turn malformed JSON into evidence; turn null into zero; infer USD as CHF; treat `providerPublishedAt` as NEXUS-held time; call a process
receipt database proof; call the network when disabled; trigger a second tool from a response; let health change risk; introduce a provider quality score.

## 25. Limitations

- No real provider is connected. Every planned provider is `NOT CONNECTED`.
- No persistence and no database seal. V1 evidence is research, display and shadow evidence only.
- No automatic provider routing and no provider quality ranking.
- The normalization schemas are a first freeze of the shape. A real provider may require a new schema version.
- The injection scanner is heuristic. Architectural separation, not the scanner, is the primary defence.
- `earnings` and `analyst_estimates` have no validator yet, so registration refuses them.
- Portfolio positions are keyed by provider symbol. They are not yet mapped to NEXUS instruments.
- Raw payloads are hashed (`rawPayloadHash`) and not stored. Quarantined text is replaced by the notice, and only its hash is kept.
- The write-tool check is by name and therefore conservative and incomplete. The fixed allowlist is the real control.

## 26. Future production path

1. One real read-only provider adapter (credentials supplied by the owner, never embedded), reviewed for license and capability.
2. Financial evidence persistence: append-only storage with a DB knowledge seal and a retention policy for raw artifacts.
3. A measured connector-quality benchmark, then an explicit `FinancialConnectorRouter`.
