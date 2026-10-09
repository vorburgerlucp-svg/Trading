# Evidence Reference Validation (O1) and Commit-Time Proof — 2026-10-09

Status: implemented on `feature/evidence-reference-validation`. Not merged.

Closes review item O1 (`docs/REVIEW_2026-10-08.md`) for quant, scanner and backtest references, including the
time proof that the first version lacked. Code: `src/nexus/evidence-validation.ts`, `src/persistence/evidence-seal.ts`,
wired into `src/nexus/nexus-brain.ts` (`decide`, `trace`, `rejection`).

## 1. Invariants

- The Brain reads through `getSealed()` only (`readOnlyScannerEvidence`, `readOnlyBacktestEvidence`, `readOnlyQuantEvidence`).
  Nothing reachable through these can save, delete or recompute a run. Frozen objects, one method.
- Validation runs after the store sync and before the first write of a decision.
- A refused decision is recorded as `REJECT` (`DECISION_RECORDED`, plus a `DecisionRecord`) with its blocking reason codes.
  No decision cycle runs and no evidence, blackboard or model entry is written.
- A cited run without a reader fails closed (`EVIDENCE_READER_NOT_CONFIGURED`). A store integrity error becomes a reason code,
  never "not found" and never a pass.
- Decision time is the request `asOf` (`Date.parse`, the same convention as the evidence store). `Date.now()` is never used
  in the validation.
- Validation results are deterministic: sorted issues, no clock, no randomness.
- Instrument identity is never guessed: from the persisted lineage (quant run, scanner candidate of that quant run), or from
  `opportunity.links.instrumentId`. A backtest without such an anchor is refused.
- Free text is not part of any lineage. Only ids, fingerprints, grades and data times.

## 2. Time proof (what is persisted, what is proven)

### 2.1 Inventory before this change

| Table / field | Written by | Used by the domain | Trust |
|---|---|---|---|
| `scanner_runs.recorded_at`, `backtest_runs.recorded_at`, `quant_runs.recorded_at` | database `DEFAULT now()` (transaction start) | no | not bound to the row's content; not read |
| `quant_runs.created_at` | caller (the quant engine's clock) | yes, as metadata | caller value, not a store time |
| scanner input availability (`lastPriceAvailableAt`, `averageVolumeAvailableAt`) | scanner engine | only inside the input fingerprint | not recoverable from the stored run |
| backtest data window (last equity point `at`) | backtest engine | yes (`dataCutoff`) | inside the hashed result |
| market bars `available_at` | ingest | yes, point-in-time reads | provider/ingest claim |

### 2.2 What is added

- **Commit seal** (`evidence_seals`, migration `006`). For every stored scanner, backtest and quant run:
  - `recordedAt` is read from the database clock (`clock_timestamp()`) **before** the run's transaction commits. It is a
    **lower bound** on the commit time.
  - `sealedAt` is read from the database clock **after** the commit, in its own statement. It is an **upper bound** on the
    commit time.
  - `seal_hash` binds kind, record id, result hash and both times. Stores verify it on every read.
  - The in-memory stores use an injected clock as a test double for the same two readings.
- **Input availability** for scanner runs: `inputsAvailableAt`, the latest availability of any in-universe input
  (`market-scanner:v2`). It is stored with the run, so it is covered by the run's result hash.

### 2.3 What the proof shows

| Claim | Proven by | Check |
|---|---|---|
| Run **was not** available at `asOf` | `recordedAt > asOf` (the commit is after `recordedAt`) | blocking `RESULT_RECORDED_AFTER_ASOF` |
| Run **was** available at `asOf` | `sealedAt <= asOf` (the commit is before `sealedAt`) | accepted |
| Commit may have landed after `asOf` | `recordedAt <= asOf < sealedAt` | blocking `RESULT_AVAILABILITY_UNPROVEN` |
| No seal (stored before this migration, or interrupted between commit and seal) | no row | blocking `RESULT_AVAILABILITY_UNPROVEN` |
| Scanner inputs available at `asOf` | `inputsAvailableAt <= asOf` (engine-computed, covered by the result hash) | `EVIDENCE_FROM_FUTURE` if later; `DATA_AVAILABILITY_UNPROVEN` if absent (v1 runs, no inputs) |
| Backtest data available at `asOf` | last equity point `<= asOf` (inside the hashed result) | `EVIDENCE_FROM_FUTURE` if later |
| Quant data available at `asOf` | `quant.asOf <= asOf`; the market-data read is point-in-time (`availableAt <= asOf`) | `EVIDENCE_FROM_FUTURE` if later. Engine-attested, see limits |

### 2.4 What the proof does NOT show (limits)

- **`recordedAt` alone is not availability.** The seal's two readings are what prove it. A run with only `recordedAt <= asOf`
  is refused (`RESULT_AVAILABILITY_UNPROVEN`).
- **Input data availability is engine-attested.** Scanner `inputsAvailableAt` and the quant point-in-time read are computed
  by the engine and stored. They are not re-derived from the market data. Whether a provider's `availableAt` was true is a
  provenance claim outside this proof.
- **Database write access.** The seal is tamper-evident against a single-field change (`recorded_at` or `sealed_at` altered
  without the hash), and the immutability triggers refuse ordinary `UPDATE`/`DELETE`. A privileged writer who rewrites the run,
  its result hash and the seal together is not detected. Detection needs external anchoring: publishing the seal-hash
  chain head to a store the database administrator does not control. This is open (see section 8).
- **Clock source.** The database clock is used, not the application clock. `clock_timestamp()` is not guaranteed monotonic
  across a clock adjustment of the database host.
- **No backfill.** Legacy runs stay unsealed. A backfilled time would be an invented timestamp. They are refused as historical
  evidence until re-computed and sealed under a new id.
- **A crash between commit and seal** leaves a run without a seal. It stays refused. Repair (re-seal) is not implemented.

## 3. Checks and reason codes

| Check | Result |
|---|---|
| Phantom scanner / backtest / quant id | blocking `*_EVIDENCE_NOT_FOUND` |
| Store returns a different id, or integrity check fails (incl. seal verification) | blocking `*_EVIDENCE_INTEGRITY_FAILED` |
| Result recorded after `asOf` | blocking `RESULT_RECORDED_AFTER_ASOF` |
| Result availability not provable at `asOf` (no seal, or commit bound after `asOf`) | blocking `RESULT_AVAILABILITY_UNPROVEN` |
| Scanner, quant or backtest data later than `asOf` | blocking `EVIDENCE_FROM_FUTURE` |
| Scanner without input availability time | blocking `DATA_AVAILABILITY_UNPROVEN` |
| Scanner candidate must carry the cited quant run; quant asOf must equal scanner asOf | blocking `SCANNER_QUANT_LINEAGE_MISMATCH` |
| Scanner ranking incomplete | warning; blocking if `requiresCompleteUniverse` (`SCANNER_RANKING_INCOMPLETE`) |
| Backtest quality INVALID | blocking `BACKTEST_INVALID` |
| Backtest without equity series | blocking `BACKTEST_AVAILABILITY_UNVERIFIABLE` |
| Instrument mismatch (quant, candidate, opportunity, backtest) | blocking `CROSS_INSTRUMENT_EVIDENCE` |
| Backtests without any instrument anchor | blocking `EVIDENCE_INSTRUMENT_UNKNOWN` |
| Backtest strength | `strong` only for grade A without insufficient sample; otherwise `weak` plus `BACKTEST_WEAK_EVIDENCE` |
| Insufficient sample (e.g. 3 trades, 100 % win rate) | warning `BACKTEST_INSUFFICIENT_SAMPLE`, strength `weak` |
| Backtest from `backtest-engine:v1` (no warm-up gate) | blocking `BACKTEST_WARMUP_UNPROVEN`: early decisions cannot be shown to have had enough history (O3) |
| Backtest with `preferredWarmupMet = false` | warning `BACKTEST_PREFERRED_WARMUP_NOT_MET`; admissible, marked, strength unchanged (O3) |

## 4. Weak evidence: effect on the decision

Weak evidence is never counted into strength. Three weak backtests are still weak, and the effect below is the same as for one.
No weights are invented here. The grades and the sample threshold (`minimumTrades`) are the existing `BacktestQualityContext`
rules; the system defines no default minimum sample. That threshold is a caller decision and an open owner question.

| Situation | Effect | Reason code (in `reasonCodes`, `DecisionRecord`, audit) |
|---|---|---|
| INVALID backtest cited | refused before any cycle (REJECT) | `BACKTEST_INVALID` |
| Backtests cited, none strong | cannot be `RECOMMEND` | `WEAK_BACKTEST_EVIDENCE_ONLY` |
| Caller requires strong backtest evidence (`requiresStrongBacktest`), none strong | cannot be `RECOMMEND` | `BACKTEST_STRONG_EVIDENCE_REQUIRED` |
| Strong backtest present | no impact | none |

The rule "cited backtest evidence without a strong one blocks RECOMMEND" is conservative by design: the decision cannot be
approved on weak backtest evidence it cites. A caller that wants approval on other grounds drops the weak citation.
Whether the owner wants weak evidence to lower confidence instead of blocking is an open decision.

## 5. Audit

- A refusal is `DECISION_RECORDED` with `outcome: REJECTED_EVIDENCE`, `finalAction: REJECT`, the reason codes and the full
  validation. The `DecisionRecord` is saved with `finalAction: REJECT`. `brain.rejection(decisionId)` returns it.
- `TASK_CREATED` is no longer used for refusals. It marks a task that entered the decision cycle. The earlier use for refusals
  was misleading, because no task was created in the cycle.
- An accepted decision carries `evidenceReferences` (lineage, warnings, seals, impact) in its `TASK_CREATED` event. The
  `trace()` reconstruction reads the lineage from there.
- `trace()` throws for a refused decision and points to `rejection()`, instead of returning a partial trace.

### 5.1 Why there is no dedicated `EVIDENCE_VALIDATED` event (conflict with the guard)

A dedicated audit event type needs `audit_events.type` to allow one more value. That check is an inline `CHECK` in
`003_domain_projections.sql`, and extending it means `ALTER TABLE audit_events DROP CONSTRAINT ...`. The migration guard
(`src/persistence/postgres/migrator.ts`, rule `ALTER_DROP`) refuses every `ALTER TABLE ... DROP`, deliberately. That guard
is an integrity control and is not bypassed here.

Proposal for an owner-reviewed change (not implemented):
1. Keep the guard. Add one narrow, explicit rule: a migration may replace the value list of a named `CHECK` constraint on
   `audit_events.type` only when the new list is a strict superset of the old list, verified by the migrator from the SQL
   text itself (parse both `IN (...)` lists, reject any removed value), and the migration names the constraint.
2. The test suite gets one case per rule: a superset passes, a removed value is refused, a non-constraint `DROP` is refused.
3. Only then add `EVIDENCE_VALIDATED`. Until then, `DECISION_RECORDED` carries the refusal.

## 6. Migration and existing data

- `db/migrations/006_evidence_seals.sql`: one new table `evidence_seals` with immutability and no-truncate triggers (the same
  pattern as the other history tables). No existing table or row is changed. The `recorded_at` column of the run tables now
  receives the same value as the seal's `recordedAt` (explicit insert). Its old `DEFAULT now()` remains for legacy writers.
- Runs stored before migration 006 have no seal. They are refused as historical evidence (section 2.4).
- No backfill, no re-sealing, no rewrite of stored runs.
- `migrations-codec` and the adversarial suite pin the migration list to 1..6. Updated accordingly.

## 7. Compatibility and versioning

- `MARKET_SCANNER_VERSION` is `market-scanner:v2`. The version is part of the scanner input fingerprint, so the same inputs get a
  new `scannerRunId` under v2. A v1 run is never re-stored with different content under its old id, which would otherwise be a
  conflict. Existing runs and their ids are unchanged.
- The lineage that enters the decision input fingerprint is `evidence-lineage:v2`. It adds `inputsAvailableAt` and the lineage
  version. Commit seals are not in it, so the fingerprint stays deterministic across environments. Decisions recorded before this
  change are not recomputed. Their stored fingerprints remain valid for them.
- Backtest run ids and result hashes are unchanged (the backtest result type is unchanged).
- The `DecisionRequest` gains `requiresStrongBacktest` (default false, so existing callers are unaffected).

## 8. PostgreSQL is required for the complete check

- `npm run check` runs typecheck and the unit and PostgreSQL projects. If the PostgreSQL integration tests cannot run (missing
  binaries, a start failure, an invalid `NEXUS_TEST_DATABASE_URL`), the project fails with the reason and the fix. It no longer
  skips the tests and reports green.
- `npm run check:fast` runs typecheck and unit tests only. Its last line says it is **not** a complete check.
- `NEXUS_PG_BIN_DIR` points the test server at a PostgreSQL 17 `bin` directory (containing `postgres` and `initdb`) when the
  platform package is not usable.
- Windows: the platform package `@embedded-postgres/windows-x64` is silently not installed when the repository path is longer
  than 260 characters, because npm skips optional packages it cannot extract. The failure message names this cause. The
  project does not change the system setting for long paths. Enabling it or moving the repository is a decision for the owner.
- Verified both ways: with PostgreSQL 17.10 running, the full check passes and the PostgreSQL tests run. With
  `NEXUS_PG_BIN_DIR` pointing nowhere, `npm run check` exits with status 1.

## 9. Remaining gaps and blockers

1. **External anchoring** of seal hashes against a privileged database writer. Without it the seal detects single-field
   tampering only. Owner decision: where the anchor lives.
2. **Re-seal path** for runs interrupted between commit and seal. Until then such runs stay refused.
3. **Quant input availability** is engine-attested (point-in-time read), not persisted per run.
4. **Provider availability** (`availableAt` of market bars) is a provenance claim outside this proof.
5. **Minimum sample threshold.** No system-wide default. It is the caller's `minimumTrades` today.
6. **Strength is not weighted** beyond the approval block in section 4. Lowering confidence for weak evidence is undecided.
7. **Guard conflict** for a dedicated audit event type (section 5.1). Owner-reviewed guard change needed.
8. **Unknown fields in a run** are not rejected by the store (LOW). A caller can add a property to a run; it becomes part of the
   hashed content. The seal is unaffected, since it is store-assigned.
9. **Canonical JSON** maps `undefined` inside arrays to `null` (LOW, unchanged).

Blocker for "future evidence is fully protected": items 1 and 4. Without them the claim is limited to the proven cases in
section 2.3, not to every possible write path.
