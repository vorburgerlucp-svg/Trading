# Point-in-Time Universe V1 (universe-engine:v1)

Status: implemented on `feature/pit-universe-v1` (base `c047078`). Not merged. Sections 1–4 are the design record written before the
implementation; sections 5–16 describe what was built and verified.

## 1. Inventory (what existed at c047078)

| Element | Where | Finding |
|---|---|---|
| `InstrumentUniverse.pointInTimeSafe` | `src/scanner/universe.ts` (deleted) | A caller boolean. `register()` stored it verbatim; nothing proved it. |
| `UniverseMembership` (`validFrom`, `validTo`, `availableAt`) | same | Membership as a window list, not a complete snapshot. It cannot show that no member is missing. |
| `UniverseSnapshot.pointInTimeSafe` | same | Copied from the caller's universe. |
| `runMarketScanner` | `src/scanner/market-scanner.ts` | `universePointInTimeSafe` copied from the snapshot. `rankingComplete = coverage.complete`, which measures snapshot coverage only. A partial universe could produce `rankingComplete: true`. |
| `ScannerRun` | `src/scanner/scanner-types.ts` | `universePointInTimeSafe: boolean`, `universeFingerprint`. |
| `InstrumentRegistry` | `src/market-data/instrument-registry.ts` | `resolve(provider, providerSymbol, at, exchange)` is time-aware and does not look at `active`. A good identity source. |
| O1 evidence | `src/nexus/evidence-validation.ts` | `evidence-lineage:v3`. No universe reason codes. |
| Backtest quality | `src/backtest/quality.ts` | `context.pointInTimeUniverse` (caller boolean) could keep a run at grade A. |
| Scanner tables | `db/migrations/005_scanner_backtest_core.sql` | `universe_point_in_time_safe BOOLEAN`, `universe_fingerprint CHAR(64)`. Immutable. |

Defect, reproduced by red tests before the fix (`test/universe/pit-caller-trust.test.ts`): a caller could register `pointInTimeSafe: true`
for a universe from a test source; the scanner reported `universePointInTimeSafe: true`, and a backtest with `pointInTimeUniverse: true`
graded A. Three red tests failed with `expected true to be false` / `expected 'A' not to be 'A'`.

## 2. Canonical model: complete snapshots

Source truth is an immutable **complete constituent snapshot**: "according to source S, this was the complete member set effective at E".
A delta history cannot prove the absence of a member without a complete baseline, so deltas are not canonical in V1.

- `UniverseDefinition`: `universeId`, `definitionVersion`, `name`. Registered once; a different content for the same id is `UNIVERSE_CONFLICT`.
- `UniverseSource`: `sourceId`, `provider`, `dataset`, `environment` (`production` | `demo` | `test_fixture`), `license` (a known licence
  class), `licenseNote?`. Only `environment = production` is production evidence. A different content for the same id is `UNIVERSE_CONFLICT`.
- `StoredUniverseRevision`: one row per revision of a snapshot key: `snapshotKey`, `snapshotRevisionId`, `universeId`, `definitionVersion`,
  `sourceId`, `effectiveAt`, `retrievedAt`, `knowledgeSource`, `knownAt`, `vintage`, `vintagePolicy`, `completeness` (`COMPLETE` | `PARTIAL`),
  `revision`, `contentHash`, `provenanceHash`, `ingestSeq`, `memberCount`, `members`, `unresolvedMembers`.
- `UniverseSnapshotMember`: `instrumentId` (the permanent NEXUS id, resolved at `effectiveAt`), `sourceMemberKey` (the source's own key),
  `providerSymbol`, `providerInstrumentId`. The instrument's current `active` flag is never read.

## 3. Two time axes, kept apart

- `effectiveAt`: the constituent set is in force from this instant until the next effective complete snapshot of the same source.
- `knownAt`: when NEXUS could know this exact revision. `captured_by_nexus` means `knownAt = retrievedAt`. `provider_published_at` means a
  provider-stated publication time, never after `retrievedAt`, never invented.
- `vintage` (policy `universe-vintage:v1`): `contemporaneous` iff `knownAt <= effectiveAt`; otherwise `historical_reconstruction`. A snapshot
  effective in 2020 and learned in 2026 is a reconstruction, always.

## 4. Replay modes and selection

For a universe, a source and a requested `asOf`:

- `decision_time`: candidates are revisions with `effectiveAt <= asOf` and `knownAt <= asOf`. The greatest `effectiveAt` wins, then the
  greatest `revision`. A later-effective snapshot NEXUS did not yet know is not used, and nothing from after `asOf` is visible.
- `historical_research`: candidates are revisions with `effectiveAt <= asOf` regardless of `knownAt`. The result is labelled through
  `vintage` and `decisionTimeKnowledgeProven`.
- Future-effective snapshots (`effectiveAt > asOf`) are never selected in either mode.
- No fallback: with no candidate, the selection is `UNAVAILABLE`. A caller cannot substitute a present-day list.
- A source is named in the selection. Lists are never merged across sources.

## 5. Completeness

Each snapshot states `COMPLETE` or `PARTIAL`. Completeness is source evidence, never inferred from `memberCount > 0` or from the absence of
errors. A `PARTIAL` snapshot never gives `complete = true` and never makes a ranking complete.

## 6. Missing mappings (silent loss is forbidden)

Each member is resolved to a NEXUS `instrumentId` by a `MemberResolver`. The production resolver is `registryResolver`
(`src/universe/instrument-identity.ts`), which calls `InstrumentRegistry.resolve(source.provider, providerSymbol, effectiveAt, exchange)`.
The ticker is never the identity: a symbol means something only at the instant it was mapped.

- A `COMPLETE` snapshot with any unresolved member is refused (`UNIVERSE_MEMBER_UNRESOLVED`). Nothing is stored.
- A `PARTIAL` snapshot may be stored. Its unresolved members are persisted and visible in `unresolvedMembers`. It is never complete.
- Duplicate instruments and duplicate `sourceMemberKey` values are refused in both cases.

## 7. Revisions and immutability

A snapshot key is `universeId | sourceId | effectiveAt`. Ingesting the same key with identical content is idempotent (`ALREADY_APPLIED`; the
first knowledge stands). Ingesting different content creates the next revision (`revision = n + 1`). A revision learned before the revision it
follows is refused (`UNIVERSE_KNOWLEDGE_REGRESSION`). Nothing is overwritten or removed: no UPDATE, DELETE or TRUNCATE on any universe table.

## 8. Identity and hashing

- `snapshotKey = 'uk_' + sha256({universeId, sourceId, effectiveAt})[0..40]`.
- `contentHash = sha256(canonical{universeId, definitionVersion, sourceId, effectiveAt, completeness, members sorted by instrumentId,
  unresolvedMembers sorted by sourceMemberKey})`. Member input order never changes the hash.
- `provenanceHash = sha256(canonical{snapshotKey, revision, retrievedAt, knownAt, knowledgeSource, vintage, vintagePolicy, ingestSeq})`.
- `snapshotRevisionId = 'urev_' + sha256({snapshotKey, revision, contentHash, provenanceHash})[0..40]`. It is deterministic and binds the input.
- `ingestSeq`: the global ingest order. In memory it is a counter. In PostgreSQL it is `MAX(ingest_seq) + 1`, decided under the advisory lock
  that serialises universe ingests.

## 9. Derived evidence (replaces the caller boolean)

`UniverseEvidence`, computed from the selected revision, the mode and `asOf`. It is never accepted from a caller:

```
status (SELECTED | UNAVAILABLE), universeId, definitionVersion, sourceId, sourceProduction,
snapshotKey, snapshotRevisionId, revision, effectiveAt, knownAt, vintage, completeness, complete,
decisionTimeKnowledgeProven   (knownAt <= asOf)
contemporaneousVintage        (vintage = contemporaneous)
historicalReconstruction      (not contemporaneous, or knownAt > asOf)
strictDecisionTime            (complete && sourceProduction && decisionTimeKnowledgeProven && contemporaneousVintage)
replayMode, asOf, memberCount, fingerprint
```

`fingerprint = hash({kind: 'universe-evidence:v1', ...fields})`. The verifier recomputes it from the evidence's own fields
(`evidenceFingerprintMatches`), so an edited evidence object is refused even when it keeps its old fingerprint.

## 10. Scanner integration

- `runMarketScanner(definition, universeSelection, snapshots, asOf)`: the universe is a `UniverseSelection`, not a caller snapshot.
- `ScannerRun.universeEvidence` carries the derived evidence; `ScannerRun.universeFingerprint` equals its fingerprint.
- Live scanner (`useCase` not `research`): the universe must be `SELECTED`, complete, from a production source, known at `asOf`, and
  contemporaneous. Otherwise every candidate is rejected with the matching reason (`UNIVERSE_EVIDENCE_UNPROVEN`, `UNIVERSE_COVERAGE_INCOMPLETE`,
  `UNIVERSE_SOURCE_NOT_PRODUCTION`, `UNIVERSE_HISTORICAL_RECONSTRUCTION`).
- Research scanner: the reconstruction is allowed and is carried as evidence (never called strict).
- `rankingComplete = coverage.complete && universeEvidence.complete && (research || no universe block)`.
- The input fingerprint includes `universeEvidence` and the universe members, so the snapshot revision is part of the run's identity.
- The column `scanner_runs.universe_point_in_time_safe` (migration 005, name unchanged) is written from `universeEvidence.strictDecisionTime`.
- Version: `market-scanner:v4`.

## 11. O1 evidence

Reason codes, applied to every cited scanner run:

- No universe evidence on the run: `UNIVERSE_EVIDENCE_UNPROVEN` (blocking).
- `UNAVAILABLE` universe: `UNIVERSE_EVIDENCE_UNPROVEN` (blocking, for every decision).
- Otherwise, for a decision that requires the complete universe (`requiresCompleteUniverse`): an unproven, incomplete or non-production
  universe is blocking (`UNIVERSE_EVIDENCE_UNPROVEN`, `UNIVERSE_COVERAGE_INCOMPLETE`, `UNIVERSE_SOURCE_NOT_PRODUCTION`). Without it these are
  warnings.
- `UNIVERSE_HISTORICAL_RECONSTRUCTION`: always a warning. Never described as strict.

`EvidenceLineage.scanner.universe` carries the universe identity: status, snapshot key and revision id, revision, effectiveAt, knownAt, vintage,
complete, decisionTimeKnowledgeProven, strictDecisionTime, sourceProduction, historicalReconstruction, fingerprint.
`EVIDENCE_LINEAGE_VERSION` is `evidence-lineage:v4`.

## 12. Backtest quality (O8, partial)

- `BacktestInput.universe?: UniverseEvidence` is the only universe trust path.
- `BacktestQualityContext.pointInTimeUniverse` is deprecated (`universe-engine:v1`): it no longer affects the grade. When it is true without
  universe evidence, the run gets `CALLER_UNIVERSE_CLAIM_NOT_PROVEN` (grade C).
- No universe evidence: grade C (`UNIVERSE_EVIDENCE_NOT_PROVIDED`). `UNAVAILABLE`: C (`UNIVERSE_EVIDENCE_UNPROVEN`). Incomplete: C
  (`UNIVERSE_COVERAGE_INCOMPLETE`). Non-production source: C (`UNIVERSE_SOURCE_NOT_PRODUCTION`). Reconstruction: B
  (`UNIVERSE_HISTORICAL_RECONSTRUCTION`). Strict: no universe downgrade.
- Version: `backtest-engine:v8`.
- Limitation: a backtest cites one universe revision (membership effective at the run's start). Per-bar membership across the window is not
  modelled in V1.

## 13. Persistence

Migration `010_pit_universe_v1.sql` (additive; checksum `3791efae…fe18a`). Tables: `universe_sources`, `universe_definitions`,
`universe_snapshot_revisions` (the canonical payload in `result` JSONB, with `result_hash`), `universe_snapshot_members`,
`universe_unresolved_members`.

- Every table is append-only. Triggers reuse `nexus_reject_mutation()` from 001 for UPDATE, DELETE and TRUNCATE.
- The database enforces: the next revision number of a key; no knowledge regression within a key; the next `ingest_seq`; the member count
  equals the member rows at commit (a deferred constraint trigger); unresolved members only in a PARTIAL revision; the knowledge shape of a
  captured or provider-published revision; the vintage that follows from its times.
- The identity hashes are not reproducible in SQL (they use the application's canonical JSON), so the read path recomputes them. A read
  rebuilds a revision from its header and member rows, then checks the stored payload hash, the rebuilt content, the provenance hash, the
  snapshot key, the vintage, the member count and the revision id. A mismatch is `UNIVERSE_INTEGRITY_FAILED`. Nothing is repaired.
- The PostgreSQL and in-memory stores run the same functions (`prepareRevision`, `planRevision`, `selectRevision`, `evidenceOf`,
  `assertRevisionIntegrity`), and `test/pg/pit-universe.pg.test.ts` checks that their outputs are equal.
- Member inserts use one `unnest` statement per child table, whatever the member count. No per-member round trip, no O(n²) lookup.

`storedThrough`: a selection may take `storedThrough` (an ingest sequence). A later backfill has a higher `ingestSeq` and is invisible to a
replay that stored through an earlier sequence. The scanner run records the snapshot revision id, which is part of its evidence.

## 14. Regressions

In-memory (red first, then the fix): `test/universe/pit-caller-trust.test.ts`, `test/universe/pit-universe.test.ts`,
`test/universe/instrument-identity.test.ts`, `test/scanner/scanner-universe-integrity.test.ts`, the O1 universe cases in
`test/nexus/evidence-validation.test.ts`.

Covered: a caller boolean cannot make the universe strict; a test source is never production; survivorship (2020 keeps delisted C; present-day
A, B, D, E never substitute); the historical fingerprint does not move when today's list changes; a reconstruction is never strict; future-effective
snapshots are not selected early; revision replay (decision_time never sees a later revision); a late correction; `storedThrough` ignores a later
backfill; identical content is idempotent; a knowledge regression is refused; a ticker change keeps the instrument (permanent id); the `active` flag
is never read; a COMPLETE snapshot with an unresolved member stores nothing; a PARTIAL snapshot stores its gaps visibly; two sources are not merged;
member order does not change the fingerprint; a changed member changes the hash; an edited scanner evidence is refused.

PostgreSQL (`test/pg/pit-universe.pg.test.ts`): a fresh database runs 001–010 with 001–009 checksums unchanged; a roundtrip; the in-memory and
PostgreSQL stores agree on identities, sequence and evidence for every replay query; the historical reconstruction; revision replay; backfill;
future-effective; unresolved refused and nothing stored; PARTIAL visible; the database refuses an unresolved member in a COMPLETE revision; the
database enforces the next revision number and the commit-time member count; append-only UPDATE, DELETE and TRUNCATE on every table; identical
content idempotent and different content conflicting; payload tampering refused, including a payload rewritten with its own hash; member
tampering (changed, deleted) refused; header and source tampering refused; a second process sees the same state; 1000 members.

Process note: the PostgreSQL store and migration were written before `test/pg/pit-universe.pg.test.ts` in this branch. The in-memory regressions
came first. The PostgreSQL regressions passed at their first run. Their value is in the negative cases they assert (tampering and append-only
refusals), which were not exercised by any earlier test.

## 15. Scope boundaries

Not implemented: F10, O5 sizing, patterns, multi-timeframe, learning, multi-instrument portfolio, live broker, AI interpretation. No real
licensed constituent provider is integrated, and no S&P-style list is hard-coded. A manually imported source with explicit provenance is valid
research data, and it is never automatically contemporaneous PIT evidence.

## 16. Verification and limitations

Verification (see the final report for the run): `npm run check` = typecheck, unit project, PostgreSQL project (PostgreSQL 17.10 started by the
test global setup). Migrations 001–009 are byte-identical to `c047078`.

Limitations, stated plainly:

1. **Knowledge time is asserted by the ingest.** A captured revision's `knownAt` is the `retrievedAt` the ingesting process supplies. It is not
   sealed by the database clock as scanner runs are (`src/persistence/evidence-seal.ts`). A backdated retrieval is not detectable in V1. This is
   the most important gap for "when did NEXUS know this exact revision".
2. **No real source.** Tests use a fixture source and provider instrument ids. No constituent provider adapter exists, and the source's licence
   class is not reviewed (`unreviewed` by default).
3. **Identity depends on the registry's mappings.** `registryResolver` resolves through `InstrumentRegistry`. A COMPLETE snapshot is refused for
   any symbol without a mapping at the effective instant. Keeping the mappings right is an operational responsibility, not checked here.
4. **Identity hashes are checked on read, not in SQL.** A privileged writer that bypasses the triggers can insert a revision the database
   accepts. The read path then refuses it. It is not rejected at write time.
5. **One universe revision per backtest.** Per-bar membership across a window is not modelled.
6. **`provider_published_at` is validated but not exercised** against a real provider.
7. The column `scanner_runs.universe_point_in_time_safe` keeps its legacy name; it holds `strictDecisionTime`.

Recommended next step: seal universe revisions with the database clock and bind captured retrievals to a source-side manifest (closing
limitation 1). Then integrate one licensed constituent source behind the source registry, with its licence reviewed, and run it through the
same ingest and replay tests.
