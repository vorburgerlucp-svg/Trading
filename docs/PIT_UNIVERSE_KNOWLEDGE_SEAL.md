# PIT Universe V2: database-sealed knowledge time (universe-engine:v2)

Status: implemented on `feature/pit-universe-knowledge-seal` (base `f17edba`). Not merged.
It closes the HIGH from `docs/PIT_UNIVERSE_V1.md` §16, limitation 1: a caller could backdate `retrievedAt` and `knownAt` and make a snapshot
look known before NEXUS could prove it.

## 1. The HIGH, reproduced

Under universe-engine:v1 the store took `retrievedAt` and `knownAt` from the caller. For `captured_by_nexus` it required
`knownAt = retrievedAt`, and nothing else. A snapshot actually stored in 2026 but claimed retrieved and known in 2020 was:

- `decisionTimeKnowledgeProven = true` at a 2020 asOf,
- `contemporaneousVintage = true`,
- `strictDecisionTime = true`.

The RED regression (`test/universe/pit-knowledge-seal.test.ts`, case A) failed on the v1 code with `expected true to be false`.

## 2. Two kinds of time, kept apart

| Field | Source | Meaning | Trusted for knowledge? |
|---|---|---|---|
| `retrievedAt`, `knownAt`, `knowledgeSource`, `vintage` (stored revision) | caller / ingesting process | The source or ingest CLAIM | No. Kept as provenance |
| `recordedAt`, `sealedAt` (timing proof) | the store's clock (the database clock in production) | NEXUS's own bracket around the commit | Yes, under §5 |

Source and provider timestamps are never erased. In the evidence they appear as `claimedKnownAt`, `claimedRetrievedAt` and `claimedVintage`.
The stored revision fields keep their meaning, and migration 010 is unchanged.

## 3. The timing proof

A `UniverseTimingProof` binds: `snapshotRevisionId`, `proofKind`, `resultHash` (the hash of the stored revision), `recordedAt`, `sealedAt`, `sealHash`.

- `recordedAt` is read **before** the revision's commit. It is a lower bound on the commit time.
- `sealedAt` is read **after** the commit, in its own statement. It is an upper bound on the commit time.
- Proof that NEXUS held the exact revision by `T` is `sealedAt <= T`. `recordedAt` alone proves nothing.

The seal lives in `universe_revision_seals` (migration 011). It is a separate table because migration 006 restricts `evidence_seals.kind`, and
that CHECK is not touched.

`proofKind`:

- `COMMIT_SEAL`: the bracket around the commit that stored the revision.
- `PRESENCE_ATTESTATION`: a later seal, written when a retry finds the revision already stored and unsealed (see §7). It proves the revision
  existed by its `sealedAt`. It never claims the original commit time.

## 4. Derived evidence (universe-engine:v2, `universe-evidence:v2`)

Derived from the selected revision, its verified timing proof, the mode and `asOf`. Never accepted from a caller.

| Field | Meaning |
|---|---|
| `knowledgeProof` | `COMMIT_SEALED`, `PRESENCE_ATTESTED`, or `UNSEALED` (no proof: legacy, or a commit whose seal was never written) |
| `storeRecordedAt`, `storeSealedAt`, `timingProofHash` | the proof's identity |
| `claimedKnownAt`, `claimedRetrievedAt`, `claimedKnowledgeSource`, `claimedVintage` | the claim, as provenance |
| `effectiveAt`, `effectiveByAsOf` | the source's claim of economic time (see §6) |
| `decisionTimeKnowledgeProven` | a proof exists and `storeSealedAt <= asOf` |
| `contemporaneousVintageProven` | a proof exists and `storeSealedAt <= effectiveAt` |
| `historicalReconstruction` | not contemporaneous, or not known by asOf |
| `strictDecisionTime` | `complete && sourceProduction && decisionTimeKnowledgeProven && contemporaneousVintageProven` |

`universeEvidenceIsConsistent` recomputes the fingerprint and every derived boolean from the stored facts. An edited object fails it.

## 5. Trust model: what the proof does and does not prove

The database seal proves **when this NEXUS database held the exact stored revision**, under the existing database trust model.

It does **not** prove:

- that the provider originally published the revision at that time;
- that the source file was authentic;
- that a privileged database writer cannot rewrite the revision, its seal and the hash together;
- that the provider's history has never been corrected.

A privileged writer can still forge a whole history. The read path detects every partial edit (§8), not a complete, consistent rewrite. This
is the same limit the existing evidence seals have. It is stated, not hidden.

## 6. What "contemporaneous" means now

A snapshot is contemporaneous only when NEXUS's proof says it existed no later than its effective instant (`storeSealedAt <= effectiveAt`).
The claimed `knownAt` is never used for this.

A snapshot effective in 2020 and sealed in 2026 is a historical reconstruction, even if its metadata says 2020. It can be used for research. It
is never strict.

`effectiveAt` is still the source's claim of when the constituent set took effect. Effectiveness is claimed, not proven. Knowledge is proven.

`provider_published_at` stays supported. A provider's stated publication time is provenance only. No trusted provider-publication proof exists in
this branch, so `strictDecisionTime` never uses it.

## 7. The commit/seal gap

A crash can happen after the commit and before the seal is written. The result is a committed revision with no proof. Behaviour:

- The revision remains readable and selectable in `historical_research`, with `knowledgeProof = UNSEALED`.
- It is never strict, and it is never selected in `decision_time`.
- No seal is invented, and no historical timestamp is backfilled.

Retry. A later ingest of identical content finds the revision already stored. If it has no seal, the retry writes a
`PRESENCE_ATTESTATION` at the retry's own clock readings. That proves the revision existed by the retry's `sealedAt`. Decision time may use it from
that moment on. It never claims the original commit time, which cannot be reconstructed.

`APPLIED` is returned only after its seal is written. If the seal write fails, the caller receives an error, the revision stays committed and
unsealed, and a retry attests it.

## 8. Tamper detection

On every read, the store checks:

- the stored result hash against the rebuilt revision (v1 rule, unchanged);
- the timing proof: `snapshotRevisionId`, `resultHash` against the revision, `sealHash` against its fields, and `recordedAt <= sealedAt`.

A mismatch is `UNIVERSE_INTEGRITY_FAILED`. The read fails, and so does decision-time evidence. Nothing is repaired.

A seal written for another revision, a seal for an altered result, and a seal moved to another revision all fail closed. The database itself
refuses a seal whose `result_hash` is not the stored revision's, and a seal whose `recorded_at` is after `sealed_at`.

## 9. Selection

- `decision_time`: a candidate needs a verified proof with `sealedAt <= asOf`, and must be effective by `asOf`. The latest effective key wins,
  then its latest such revision. A revision sealed after `asOf` is never used, and a later correction is invisible until it is sealed.
- `historical_research`: effective by `asOf`, regardless of proof. It returns the newest ex-post revision, labelled by its evidence.
- Future-effective revisions are unavailable until their effective instant.
- `storedThrough` applies to both modes. A later sealed backfill cannot change an older stored-through replay.

## 10. Store clock

The clock is read twice per ingest. In production it is the database clock (`clock_timestamp()` through `databaseClock`). The in-memory store
takes an injected clock, a test double, and reads it at the same two points. PostgreSQL also accepts an injected clock. That is a test seam only,
so the two stores can be compared on identical readings. The database-clock path is tested separately (`test/pg/pit-knowledge-seal.pg.test.ts`).

A claimed retrieval later than the store's own reading is refused: a claim cannot describe a retrieval NEXUS had not performed yet.

## 11. Versions and consumers

- `universe-engine:v2`, `universe-vintage:v2` (the policy the evidence applies to proofs), `universe-timing:v1` (the seal).
- `universe-engine:v1` stored evidence remains readable. It is never silently upgraded: consumers treat it as `UNSEALED`, whatever its stored flags say.
- `market-scanner:v5`. Live universe strength requires a sealed proof by asOf and a contemporaneous one. The live reasons are
  `UNIVERSE_KNOWLEDGE_NOT_SEALED`, `UNIVERSE_KNOWLEDGE_AFTER_DECISION` and `UNIVERSE_HISTORICAL_RECONSTRUCTION`.
- `evidence-lineage:v5`. The O1 reasons are blocking for a decision that requires the complete universe, and warnings otherwise. A
  `UNIVERSE_HISTORICAL_RECONSTRUCTION` warning is always visible and never called strict.
- `backtest-engine:v9`. A caller-claimed universe with no proof is grade C (`UNIVERSE_KNOWLEDGE_NOT_SEALED`). A reconstruction is grade B. Strict is
  unchanged. v8 runs are not reinterpreted.

The scanner and backtest verifiers re-check the universe evidence they carry (`universeEvidenceIsConsistent`). An edited scanner run or backtest
run fails the save and the read.

## 12. Source artifact boundary (not implemented)

A `sourceArtifactId` / `sourceArtifactHash` audit hook would bind a revision to the exact imported file. A caller-supplied hash does not prove
publication time, and `strictDecisionTime` does not depend on it. It is the next real-source step, not part of this branch.

## 13. Limitations

1. **The proof is only as strong as the database trust model** (§5).
2. **The source's claim of `effectiveAt` is not proven.** Only knowledge is proven.
3. **No real provider.** Tests use a fixture source. Its environment is `test_fixture`, and it is never production evidence.
4. **In-process objects are not unforgeable.** Code that holds a store's internals can construct an evidence object. The persistent evidence is
   bound to the database rows only when it is read back.
5. **A backtest cites one universe revision** (membership at the run start), as in v1.
6. **`provider_published_at` is validated but unproven** until a trusted provider manifest exists.
