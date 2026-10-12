# Historical Financial Source Attestation V1

Status: design, written before implementation. Base: `4c6e758` (`feature/sec-edgar-companyfacts-hardening`). Branch:
`feature/historical-financial-source-attestation-v1`. Not merged.

This layer answers a different question from NEXUS's database knowledge seal. It never replaces it.

Schema: `financial-source-attestation:v1`. Policy: `sec-filing-date-next-ny-day:v1`. Provider: `sec-edgar` only in V1.

## 1. Definitions

| Concept | Question it answers | Source of the answer | Where it lives |
|---|---|---|---|
| DB knowledge | When did NEXUS durably hold this `FinancialEvidence` record? | The database clock, sealed by migration 012 (`financial-knowledge-seal:v1`). | `financial_evidence_seals` |
| Source attestation | What does an official external source support about the historical existence of the filing that the equivalent data came from? | An official SEC filing date, an official archive header, and deterministic selection that is re-verified. | `financial_source_attestations` (migration 013) |
| Economic time | When did the economic event the data describes happen? | The period end, such as `2024-09-28`. | `effectiveAt` (null for SEC V1) |
| Provider metadata | What did the provider claim about its own publication or retrieval? | The provider's own fields, kept as provenance. | `providerPublishedAt`, `retrievedAt` (SEC V1: `providerPublishedAt` is null) |
| Historical-research eligibility | May a backtest or research replay use this record as of a past date? | A replay policy that names its basis: a DB seal, or a source attestation. | `readForReplay`, never `readAvailable` |

These are four different facts. A source attestation is not a knowledge proof, and a DB seal is not an official source claim. `providerPublishedAt` is never
written from either of them, and `readAvailable` keeps its meaning.

## 2. Official SEC semantics gate (performed before design)

Official sources consulted on the day of this work:

- SEC EDGAR Filer Manual, Volume II, Chapter 10 (December 2022 edition), §10.1 "Filing Date of Electronically Transmitted Submissions". It says that
  a live submission begun after 5:30 P.M. Eastern and accepted gets a filing date of 6:00 A.M. the next business day. A submission begun at or before
  5:30 P.M. gets that day's filing date if accepted.
- SEC EDGAR API documentation (`sec.gov/search-filings/edgar-application-programming-interfaces`). It says the JSON structures "are updated throughout the
  day, in real time, as submissions are disseminated". The submissions API has a typical processing delay under one second. The XBRL APIs, which include
  companyfacts, have a typical delay under one minute. The bulk ZIP files are republished nightly at about 3:00 a.m. ET.
- EDGAR Public Dissemination Service Technical Specification (2012 edition). It says acceptance and dissemination "usually takes no longer than two (2)
  minutes from the receipt of submission by EDGAR". Its control-block field description labels the acceptance time as "Time (EST)". The extraction
  of that table is garbled, so the label is quoted from the field description, and the document does not say whether it holds during daylight time.
- An official example archive header (`sec.gov/Archives/edgar/data/1122304/000119312515118890/0001193125-15-118890-index-headers.html`). It shows the
  fields `ACCESSION NUMBER`, `CONFORMED SUBMISSION TYPE`, `FILED AS OF DATE` (YYYYMMDD), `ACCEPTANCE-DATETIME` (14 digits) and `CENTRAL INDEX KEY`.

Gate result: **no contradiction found. `SEC_SOURCE_TIME_MODEL_BLOCKER` is not triggered.** The model is consistent with the sources. Its conservative
next-day rule covers the acceptance and dissemination window, including filings accepted late in the day, which take the next day's filing date.

Limitations of this gate, stated plainly:

- The Filer Manual edition read is the December 2022 Chapter 10. A later edition exists. Section 10.1 must be rechecked in the current edition before a
  production claim.
- The dissemination specification is from 2012.
- No official statement was found that says there is no exact timestamp for when filing content first became publicly available on `sec.gov`. This design
  does not claim one. It does not rely on that statement either.
- The time zone of `ACCEPTANCE-DATETIME` is not confirmed. The 2012 specification labels it EST, and daylight handling is unknown. It is therefore kept as
  raw text and never converted (§16).

## 3. Forbidden shortcuts

- `acceptanceDateTime` is never used as an exact historical public-availability timestamp.
- A filing date is never placed at `00:00:00Z` or `23:59:59Z` of its day to stand in for a time.
- No intraday instant is invented.
- `providerPublishedAt` on an existing `FinancialEvidence` record is not changed. SEC V1 keeps `providerPublishedAt = null` and `effectiveAt = null`.

## 4. V1 date policy (`sec-filing-date-next-ny-day:v1`)

A filing with official `filingDate = D` is eligible for historical research only when:

    newYorkDate(asOf) > D          (strict)

This is a conservative research policy. It is **not** a claim that midnight of the next date is the exact dissemination time.

- `D = 2024-11-01`: any `asOf` whose New York calendar date is `2024-11-01` is not eligible, at any time of day.
- The first instant whose New York calendar date is `2024-11-02` is eligible.

The comparison uses the America/New_York calendar date, not the UTC date. It is computed by one helper (`newYorkDateOf`). The code never compares `asOf.slice(0, 10)` for this
policy. Tests cover EST, EDT, the spring and autumn transitions, 23:59 and 00:00 New York time, and cases where the UTC date differs from the New York date.

## 5. Use cases

    type FinancialReplayUseCase = 'decision_time' | 'historical_research';

- `decision_time`: DB knowledge seal only. Source attestations are never returned.
- `historical_research`: DB knowledge seal, or a verified SEC source attestation.

Source attestations may be consumed only for `historical_research`. They never authorize live or paper trading, capital allocation, risk approval, order
generation, portfolio mutation, or O1 approval.

## 6. Existing semantics that do not change

- `FinancialEvidenceStore.readAvailable()` returns only records whose DB seal proves NEXUS knew them by `asOf`. It does not return source-attested records.
- `financialKnowledgeAt()` is unchanged.
- `FinancialEvidence` is unchanged, and so are `evidenceId`, `queryFingerprint`, `contentHash`, `rawPayloadHash`, `recordHash`, and the DB seal.
- `strongO1Eligible()` stays `false`. A source attestation does not upgrade it.
- The `o1Status` of an evidence record is unchanged.

## 7. Replay path

`readForReplay({ asOf, useCase, instrumentId?, connectorId?, capability?, provider? })` returns records, each with an explicit `basis`:

- `DB_KNOWLEDGE_SEAL`: the record is sealed by `asOf`.
- `SEC_SOURCE_ATTESTATION`: the record is attested and the New York policy allows it, and the record is not sealed by `asOf`.

If both exist, the DB seal is the basis, because it is the stronger local knowledge. The bases are never mixed silently. Results are ordered by evidence id.

Source-attestation results use a separate vocabulary and never use `PROVEN_AVAILABLE`:

- `SOURCE_ATTESTED_RESEARCH_AVAILABLE`
- `SOURCE_NOT_YET_ELIGIBLE`
- `SOURCE_ATTESTATION_MISSING`
- `SOURCE_ATTESTATION_INVALID`

The DB knowledge vocabulary (`PROVEN_AVAILABLE`, `PROVEN_NOT_AVAILABLE`, `UNPROVEN`) is unchanged.

## 8. SEC V1 scope

The implementation supports only `provider = sec-edgar`, `connectorId = sec-edgar-fundamentals-rest` and `capability = fundamentals`. Massive, news,
portfolio, Twelve Data and broker data are not attested. The interfaces are provider-neutral, and only SEC has an implementation.

## 9. Attestation preconditions

A source attestation is a sidecar to an existing `FinancialEvidence` record. The attestor loads the record with `getSealed(evidenceId)` and requires:

- the evidence exists, and `verifyFinancialEvidence` passes;
- the record hash of the stored record matches the seal;
- the DB seal integrity check passes, when a seal exists;
- provider `sec-edgar`, connector `sec-edgar-fundamentals-rest`, capability `fundamentals`.

No new `FinancialEvidence` record is constructed, and the existing one is not mutated.

## 10. Re-verifying the semantic data

The attestor does not trust a caller-supplied accession. It re-fetches the SEC submissions and companyfacts, and reconstructs the fundamentals with the shared
`submissionsOf`, `companyFactsOf` and `selectFundamentals`. It requires:

- the mapped CIK from the instrument registry at `request.asOf`;
- the reconstructed canonical candidate equal to the stored `evidence.data` (canonical hash equality);
- exactly one selected accession;
- the selected-facts projection hash.

When the current SEC representation no longer reproduces the stored values, the attestor stops with `SOURCE_SEMANTIC_MISMATCH` and creates no attestation.

## 11. The caller cannot supply accession, filing date, form, CIK or source availability

The attest API takes a `SealedFinancialEvidence` and nothing else. The accession, form, CIK and filing date come from the deterministic selection and the
official submissions row. Any extra property on the input object is ignored, and never used as a source claim.

## 12. Official archive artifact

After selection identifies the accession, the attestor fetches the filing-specific archive header:

    https://www.sec.gov/Archives/edgar/data/{CIK_WITHOUT_LEADING_ZEROES}/{ACCESSION_WITHOUT_DASHES}/{ACCESSION}-index-headers.html

It is built only from the validated mapped CIK and the selected accession. There is no caller-defined URL. Foreign redirects are refused. The fetch uses the
same platform transport as the connector, with `redirect: 'error'`.

## 13. Archive header validation

From the artifact the attestor requires:

- `ACCESSION NUMBER` equals the selected accession;
- `CONFORMED SUBMISSION TYPE` equals the selected form, exactly `10-Q` or `10-K`;
- `FILED AS OF DATE` (YYYYMMDD) equals the submissions `filingDate`;
- `CENTRAL INDEX KEY` includes the mapped CIK, zero-padded to ten digits. A header may name several filers. The mapped CIK must be among them.

Any mismatch fails closed with `SOURCE_ARTIFACT_MISMATCH`. The header size is bounded at 2 MiB. `Content-Length` is checked before the body is read, and the body is
checked again after it is read. Transport limitation: the body is read whole before the post-read check, as in the SEC connector (see §21).

## 14. Accepted post-acceptance corrections

SEC may correct a header after acceptance. A corrected `FILED AS OF DATE` that no longer equals the submissions `filingDate` fails closed, because the
evidence cannot then be attested consistently. This is a deliberate refusal, not an inference.

## 15. Artifact hash and conflicts

`sourceArtifactHash` is the lowercase SHA-256 of the exact artifact text. It is part of the attestation identity. A changed artifact for the same accession
produces a different attestation. Both immutable observations are kept, and neither is overwritten.

At replay, if two verified attestations for the same evidence are eligible, with different identities, `readForReplay` fails closed with
`SOURCE_ATTESTATION_CONFLICT`.

## 16. ACCEPTANCE-DATETIME

The raw 14-digit value (`YYYYMMDDHHMMSS`) is kept as `sourceAcceptanceRaw` when the header carries it, and null otherwise. It is metadata only. It is never
converted to UTC, never written to `providerPublishedAt`, and never used to pass the research availability gate.

## 17. Selected-facts projection

`selectedFactsHash` is the hash of the deterministic, sorted list of selected facts: taxonomy, concept, unit, accession, start, end, and the exact source
lexeme of the value. The provider's array order is not hashed.

## 18. Evidence binding

Every attestation binds: `evidenceId`, `evidenceRecordHash`, `evidenceContentHash`, `instrumentId`, `provider`, `connectorId`, `capability`, `cik`,
`sourceId` (the accession), `sourceForm`, `sourceFilingDate`, `selectedFactsHash`, `sourceArtifactHash` and `policyVersion`. An attestation for another
evidence record is never reusable: the verification compares every bound field against the evidence it is checked with.

## 19. Model and identity

The record fields are:

    schemaVersion, policyVersion, evidenceId, evidenceRecordHash, evidenceContentHash, provider, connectorId, capability, instrumentId, cik, sourceId,
    sourceForm, sourceFilingDate, sourceAcceptanceRaw, sourceArtifactUrl, sourceArtifactHash, selectedFactsHash

The identifier is `fsa_` followed by 64 hex digits:

    attestationId = 'fsa_' + hashOf({ schemaVersion, policyVersion, evidenceId, evidenceRecordHash, evidenceContentHash, provider, connectorId,
                                      capability, instrumentId, cik, sourceId, sourceForm, sourceFilingDate, sourceArtifactUrl, sourceArtifactHash,
                                      selectedFactsHash })

`attestationHash` is the hash of the whole record, including `attestationId` and `sourceAcceptanceRaw`. Verification recomputes both. No stored hash is
trusted.

**Not part of semantic identity:** the insertion time, the runtime User-Agent, retrieval timing, and the process clock.

**Creation time (`createdAt`).** The application cannot know the database insertion time before insertion, so the record has no `createdAt` field. The
creation time is the database column `attested_at`, set by a trigger from the PostgreSQL clock. It is outside the hashed record and outside the identity.

## 20. Storage (migration 013)

Migration 013 is additive. Migrations 001–012 are not changed. The table is `financial_source_attestations`, with indexed columns and the complete canonical
record in `record JSONB`:

- `attestation_id` (primary key), `evidence_id` (foreign key to `financial_evidence`), `evidence_record_hash`, `provider`, `connector_id`, `capability`,
  `instrument_id`, `cik`, `source_id`, `source_form`, `source_filing_date DATE`, `source_artifact_hash`, `selected_facts_hash`, `policy_version`,
  `record_hash`, `attested_at TIMESTAMPTZ`, `record JSONB`.
- CHECK constraints on shape and on the allowed values of provider, connector, capability, form and policy.
- A binding trigger, before insertion: the referenced evidence exists, its stored `record_hash` equals `evidence_record_hash`, and the indexed columns equal
  the record's own fields.
- A clock trigger, before insertion: `attested_at` is set from `clock_timestamp()`. The application cannot supply it or backdate it.
- Append-only: UPDATE, DELETE and TRUNCATE are rejected through `nexus_reject_mutation()`, as in 001 and 012.

## 21. Store contract and concurrency

`FinancialSourceAttestationStore` has `save`, `get`, `getForEvidence` and `readEligible`.

- `save` verifies the attestation before any database write. It runs in one transaction under a transaction-level advisory lock keyed by the attestation
  identity. A concurrent identical save waits, then finds the row and returns `ALREADY_APPLIED`. Nothing is written in two steps, so no presence or commit
  gap can make the state ambiguous.
- `save` reads the row back and verifies it again.
- `readEligible` filters by provider, connector, capability, instrument, and `source_filing_date < newYorkDate(asOf)`. The reader then applies the policy
  helper again to every row.
- Every read verifies the record, recomputes its hashes, and checks its indexed columns against the record.

Transport limitation, unchanged from the connector: the response body is read whole before the post-read size check. A streaming reader remains a separate
item, and this branch does not change it.

## 22. CompanyFacts evolution

The full CompanyFacts document changes as new filings arrive. The current document's raw hash is therefore **not** required to equal the raw hash of the
evidence. Attestation requires:

- the same canonical evidence data;
- the same selected accession;
- the same selected fact semantics.

This is intentional. The attestation proves the selection, not the bytes of the whole document.

## 23. Source limitation

V1 attests that SEC's current structured data links the selected facts to an official filing accession, and that the official archive carries matching
filing metadata. It does not cryptographically prove the exact second when an XBRL fact first became public, and it does not claim that it does.

## 24. Unchanged scope

- Amendments: `10-Q/A` and `10-K/A` remain excluded (SEC V1 §11). No amendment handling is added.
- Q4 remains refused (§9). Q4 is not derived.
- Fundamentals mappings, null policies for EBIT, debt, capex and free cash flow, currency, duration windows, the exact-number parser, the submissions and
  CompanyFacts hardening, the DB seal, O1, response-size handling and pacing are not changed.

## 25. SEC access policy

The attestor uses `SEC_USER_AGENT`, which is validated exactly as the connector validates it. There is no API key and no `Authorization` header. A missing
contact means `not_connected`, and nothing is invented. Requests are paced at no more than 8 per second in this process, through the same `ResilientCaller`
minimum interval. The fixed allowed hosts are `data.sec.gov` for the JSON documents and `www.sec.gov` for the archive header. Any other host, and any
redirect, is refused.

## 26. Errors

- `SOURCE_ATTESTATION_UNSUPPORTED`: provider, connector or capability is not SEC fundamentals.
- `SOURCE_ATTESTATION_INVALID`: verification of a record or of a binding failed.
- `SOURCE_SEMANTIC_MISMATCH`: the reconstructed canonical data or selection differs from the stored evidence.
- `SOURCE_ARTIFACT_MISMATCH`: the official archive header disagrees with the selection.
- `SOURCE_ATTESTATION_CONFLICT`: two different verified attestations are eligible for the same evidence, or a store identity collides.

`DATA_NOT_CONNECTED` is not reused for a semantic mismatch.

## 27. Tests and mutation plan

RED tests come before implementation for: the same-day refusal, the next New York day, the DST and time zone cases, the caller that tries to backdate,
the wrong accession, the wrong CIK, the wrong form, the wrong filing date, a changed artifact hash, a canonical mismatch, a selected-facts mismatch,
`decision_time` refusing the attestation, a source-attested record that `readAvailable` must not return, and O1 staying `false`.

PostgreSQL tests cover the core proof (sealed in 2026, attested to 2024: `readAvailable(2025)` returns nothing, `readForReplay(historical_research, 2025)`
returns the record with basis `SEC_SOURCE_ATTESTATION`, and `readForReplay(decision_time, 2025)` returns nothing), direct tamper attempts, and concurrent
saves.

The mutation campaign breaks at least: the strict `>`, the New York date, `decision_time` accepting attestations, O1, the record hash binding, the accession
check, canonical equality, the artifact hash, the selected-facts hash, a caller-supplied filing date, the wrong form, an unsupported provider, the policy
version, DB mutation, and attestation hash verification.

## 28. Live smoke

`test/live/sec-edgar-source-attestation.live.test.ts` runs only when `SEC_USER_AGENT` is valid. It makes no assertion about revenue or EPS. CI makes no SEC
request.
