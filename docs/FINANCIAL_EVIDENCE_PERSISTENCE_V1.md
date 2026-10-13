# Financial Evidence Persistence + DB Knowledge Seal V1

Status: design, written before implementation. Base: `b8a184a` (`feature/financial-gateway-v1-governance-hardening`, pushed). Branch:
`feature/financial-evidence-persistence-v1`. Not merged.

The branch stores normalized `FinancialEvidence` in PostgreSQL, immutably, with a database-clock knowledge seal. It answers five questions:

1. What exact external financial evidence did NEXUS store?
2. Has the stored record changed?
3. When can NEXUS prove the database already held that exact evidence?
4. Was that evidence available at a historical `asOf`?
5. Is a missing seal honestly treated as unproven?

It does not connect a real provider, and it does not make financial evidence sufficient for capital approval.

**What a seal proves:** when NEXUS's durable database held the record. It does not prove provider correctness, provider publication authenticity,
licensing beyond the stored policy, economic truth, source quality, or trading profitability.

## 1. Existing architecture followed

This follows the commit-seal semantics of migration 006 (scanner, backtest, quant runs) and migration 011 (universe revisions). It adds no fourth timing
concept. The financial seal has its own table and its own version string, because `evidence_seals.kind` in 006 is locked and must not change.

| Concept | 006 / 011 | This branch |
|---|---|---|
| `recordedAt` | read before the commit: lower bound | same |
| `sealedAt` | read after the commit in its own statement: upper bound | same |
| `COMMIT_SEAL` | the bracket around the commit that stored the record | same |
| `PRESENCE_ATTESTATION` | a later seal that found the record already stored (crash gap) | same, with one stricter rule (§6) |
| clock | database clock (`clock_timestamp()`) | same; no application clock anywhere in the seal path |
| immutability | `nexus_reject_mutation()` on UPDATE, DELETE, TRUNCATE | same |
| seal binds the record | BEFORE INSERT trigger checks `result_hash` | same, as `record_hash` |

## 2. Evidence v2: self-verifying

v1 stored only `queryFingerprint`, not the canonical request it was computed from. A row could not recompute its own identity. Since no real financial
data exists, the bump is made now, explicitly: `financial-evidence:v2`. v1 semantics are not changed silently.

v2 adds `request`, a frozen snapshot of the validated request fields:

- contains only `capability`, `connectorId`, `asOf`, `environment`, and the capability's own fields (`instrumentId`, `currency`, `period`);
- excludes `requestId` (correlation metadata, not semantic identity);
- contains no secret, no tool name, no URL, and no arbitrary provider JSON.

`verifyFinancialEvidence(...)` rebuilds the request through `parseFinancialRequest`, so a snapshot that the request model would not accept is refused.

## 3. Record identity and semantic identity

- `queryFingerprint = hashOf(request)`. The caller's value is never trusted; it is recomputed.
- `contentHash = hashOf({ data, textBlocks })`, where each text block contributes `{ source, originalHash, quarantined, flags }` in array order. A
  stored record can be verified without the original text of quarantined blocks, because `originalHash` is kept.
- `semanticHash = hashOf(identity projection)`, where the projection is:

  ```
  schemaVersion, connectorId, provider, transport, capability,
  queryFingerprint, instrumentId, contentHash, effectiveAt, providerPublishedAt,
  license { status, redistribution }, provenancePolicyVersion
  ```

- `evidenceId = 'fe_' + semanticHash`. It is recomputed on every read and every save.

**Not in identity:** `requestId`, `retrievedAt`, `nexusReceivedAt`, `createdAt`. These are process-instance metadata.

**Record hash:** `recordHash = hashOf(complete record)`, including its process receipt times. It identifies the exact first persisted record. The seal
binds `recordHash`, because a DB proof must identify the exact record it held.

V1 evidence IDs are intentionally not stable into v2. No production financial evidence exists, so no migration of real data is required.

## 4. Process receipt times remain claims

`retrievedAt` (the connector's clock), `nexusReceivedAt` (the gateway's clock), and `createdAt` are useful provenance. They are not database knowledge
proof. Only the database seal proves when NEXUS's durable database held the record. `providerPublishedAt` is provider provenance. It is not a
cryptographic publication proof, and sealing a row does not upgrade it.

## 5. DB commit-time seal (`COMMIT_SEAL`)

Under the save lock (§7):

1. `BEGIN`; read `recordedAt` from the database clock; insert the record; `COMMIT`.
2. Read `sealedAt` from the database clock in its own statement; insert the seal.

Therefore `recordedAt <= commit <= sealedAt`. Availability at `asOf` is proven only by `sealedAt <= asOf`. Non-availability is proven only by
`recordedAt > asOf` on a `COMMIT_SEAL`.

No application clock enters the seal path. A static test scans the store and the seal code for `Date.now` and `new Date`.

## 6. Presence attestation and its limit

A record can be committed while its seal is never written (a crash in between). On retry, the exact record is found and has no seal. The store then
writes a `PRESENCE_ATTESTATION` at retry-time database clocks.

It proves: the record existed by `sealedAt`. It never claims the original commit time.

**Stricter rule (not in the universe store):** a `PRESENCE_ATTESTATION` with `recordedAt > asOf` does **not** prove non-availability. The record may
have existed long before the attestation began. `financialKnowledgeAt` returns `UNPROVEN` there, never `PROVEN_NOT_AVAILABLE`.

## 7. Idempotency and concurrency

- A save takes a **session-level** advisory lock keyed by the semantic hash, and holds it through the commit seal. A transaction-level lock would
  be released at commit, before the seal is written, and a concurrent saver could then attest the record and fix the proof kind at
  `PRESENCE_ATTESTATION` where a `COMMIT_SEAL` was possible.
- Same semantic evidence fetched later, with different process times: `ALREADY_APPLIED`. The first record, its `recordHash`, its `createdAt`, and its
  first seal are **not** overwritten. Earliest durable knowledge is kept.
- The same `evidenceId` with a different semantic identity is an integrity error (`FinancialEvidenceConflictError`). Last-write-wins never happens.
- Two processes saving the same evidence concurrently produce one `APPLIED`, one `ALREADY_APPLIED`, one row, one valid seal.

## 8. Strict point-in-time read

`readAvailable({ asOf, instrumentId?, connectorId?, capability? })` returns only records with a verified seal and `sealed_at <= asOf`. It is ordered
by `sealed_at, evidence_id` explicitly. Natural row order is never relied on.

- Unsealed evidence never appears.
- A later `PRESENCE_ATTESTATION` never makes evidence visible at an earlier `asOf`.
- `effectiveAt` is **not** a filter. Future guidance that is publicly known today is available today. Economic time, provider publication time and
  NEXUS knowledge time are kept apart, and strict PIT concerns only `sealed_at`.

## 9. Unsealed evidence

A row without a seal is `UNPROVEN`. `getSealed` returns the record with a null seal. No historic seal is ever generated from application memory,
from `retrievedAt`, from `nexusReceivedAt`, or from `providerPublishedAt`.

`financialKnowledgeAt(sealed, asOf)`:

| Condition | Result |
|---|---|
| seal is `COMMIT_SEAL` or `PRESENCE_ATTESTATION`, and `sealedAt <= asOf` | `PROVEN_AVAILABLE` |
| seal is `COMMIT_SEAL`, and `recordedAt > asOf` | `PROVEN_NOT_AVAILABLE` |
| anything else (including a presence attestation after `asOf`) | `UNPROVEN` |

## 10. Store and verification

`verifyFinancialEvidence` recomputes, and fails closed on any mismatch: schema version; request validity; `queryFingerprint`; `instrumentId`
consistency with the request; `contentHash`; `evidenceId`; timestamp formats; `rawPayloadHash` format; text-block binding (`originalHash` for
non-quarantined text, the quarantine notice and flags for quarantined text, `evidenceId` binding); license shape; provenance version; O1 and
knowledge-proof constants.

The PostgreSQL store verifies **before** any write. A caller-constructed forged `FinancialEvidence` is refused even though TypeScript accepts it.
Every read decodes JSON losslessly, verifies the evidence, recomputes `recordHash` and `semanticHash`, checks the indexed columns against the record,
and verifies the seal when present.

Decimals stay exact strings from gateway to JSON, PostgreSQL, readback and verification. There is no number coercion and no implicit FX.

## 11. Seal hash

Version `financial-knowledge-seal:v1`. The seal hash binds `proofKind`, `evidenceId`, `recordHash`, `recordedAt` and `sealedAt`. Any change to one of
them fails verification. A trigger rejects a seal whose `record_hash` does not match the stored record.

## 12. Versions

| Version | Meaning |
|---|---|
| `financial-evidence:v2` | evidence schema with the canonical request snapshot |
| `financial-evidence-store:v1` | the PostgreSQL store contract |
| `financial-knowledge-seal:v1` | the seal hash and proof rules |
| `financial-pit-read:v1` | the strict point-in-time read |

The gateway (`financial-gateway:v1`), registry (`financial-connector-registry:v1`), MCP transport, and license policy keep their versions. The gateway
produces v2 evidence, and that is recorded here rather than silently changed.

## 13. Migration 012

`012_financial_evidence.sql` is the only new migration. Migrations 001–011 are byte-identical. The CHECK in 006 is untouched, and the financial seal
lives in its own table.

- `financial_evidence`: primary key `evidence_id` (`fe_` + 64 hex); `schema_version`; identity columns; `query_fingerprint`, `semantic_hash`,
  `record_hash` as `CHAR(64)`; `effective_at`, `provider_published_at`, `retrieved_at`, `nexus_received_at`, `created_at`, `recorded_at` as
  `TIMESTAMPTZ`; the full `record` as `JSONB`; a CHECK that `record->>'evidenceId' = evidence_id`.
- `financial_evidence_seals`: primary key `evidence_id` referencing the record; `proof_kind`; `record_hash`; `recorded_at`; `sealed_at`; `seal_hash`;
  a CHECK `recorded_at <= sealed_at`.
- A BEFORE INSERT trigger on the seal checks the stored `record_hash`.
- `nexus_reject_mutation()` on UPDATE, DELETE and TRUNCATE for both tables.
- Indexes, only those named for research reads: `instrument_id`, `capability`, `connector_id`, `provider_published_at`, `effective_at`, and
  `financial_evidence_seals (sealed_at)`.

## 14. Trust boundary

A fully privileged database owner who rewrites a record, its `record_hash`, its seal and its `seal_hash` consistently defeats any in-database hash
scheme. NEXUS does not claim cryptographic protection against the database owner. An external transparency log, a signed seal, or WORM storage is
the stronger option and is out of scope for V1.

Tampering that does not update everything consistently is detected on read. Tests cover changes to the stored data, the record hash, each seal field
individually, and the seal-to-record binding.

## 15. O1 limitation

A valid financial DB seal upgrades knowledge-timing confidence. It does not upgrade source quality. No real financial provider is connected.
`strongO1Eligible` stays `false` for every evidence. The reason is `UNSEALED_EXTERNAL_EVIDENCE` when no seal is proven, and
`FINANCIAL_SOURCE_NOT_PRODUCTION_VERIFIED` when a seal exists. Eligibility is false in both cases. Persistence does not touch the broker, risk limits,
capital allocation, the build locks, `TRADING_MODE` or `ALLOW_LIVE_TRADING`.

## 16. Service orchestration

Persistence stays out of the gateway. `FinancialEvidenceService.fetchAndPersist(request)` runs `gateway.fetch`, then `store.save`, then
`store.getSealed`, and returns the exact persisted record with its seal. The gateway remains the provider, schema and security boundary.

## 17. Registry persistence

The connector registry already uses the generic `AppendOnlyStore`. It is proven against `PostgresAppendOnlyStore` with the log name
`financial-connectors`. No second registry persistence system and no registry migration are added.

## 18. Limitations

- No real provider. Fixture providers only.
- The universe store has the same concurrency gap: its ingest lock is transaction-level, released before its seal is written, so a concurrent ingest
  can record a `PRESENCE_ATTESTATION` where a `COMMIT_SEAL` was possible. This branch does not change the universe store. It is reported as a finding.
- The DB trust boundary in §14.
- `financial_evidence` stores quarantined text excerpts as data. They are never executed or interpreted as instructions.
