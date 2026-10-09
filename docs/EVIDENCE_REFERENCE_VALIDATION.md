# Evidence Reference Validation (O1) — 2026-10-09

Status: implemented on `feature/evidence-reference-validation`. Not merged.

Closes the review item O1 (`docs/REVIEW_2026-10-08.md`) for quant, scanner and backtest references.
Code: `src/nexus/evidence-validation.ts`, wired into `src/nexus/nexus-brain.ts` (`decide`, `trace`).

## Invariants

- The Brain reads runs through `get()` only. The readers are built with `readOnlyScannerEvidence`,
  `readOnlyBacktestEvidence` and `readOnlyQuantEvidence`, which expose nothing else. The Brain never saves,
  deletes or recomputes a run. These readers reuse the existing store `get()` methods (no duplicate store).
- Validation runs after the store sync and before the first write of a decision. A refused decision writes
  no evidence, no blackboard entry and no decision record.
- A refused decision is audited as `TASK_CREATED` with `outcome: REJECTED_EVIDENCE` and the blocking issues.
- A cited run without its reader fails closed (`EVIDENCE_READER_NOT_CONFIGURED`). There is no silent fallback.
- Store integrity errors (hash mismatch on read) become reason codes, never "not found" and never a pass.
- Decision time is the request `asOf` (`Date.parse`, same convention as the evidence store). `Date.now()` is never used.
- Validation results are deterministic: issues are sorted, no clock, no randomness.
- Instrument identity is never guessed. It comes from the persisted lineage (quant run, scanner candidate of
  that quant run) or from `opportunity.links.instrumentId`. A backtest without such an anchor is refused.
- Free text is not part of the lineage. Only ids, fingerprints, grades and timestamps are stored.

## Checks and reason codes

| Check | Result |
|---|---|
| Phantom scanner / backtest / quant id | blocking `*_EVIDENCE_NOT_FOUND` |
| Store returns a different id, or integrity check fails | blocking `*_EVIDENCE_INTEGRITY_FAILED` |
| Scanner candidate must carry the cited quant run | blocking `SCANNER_QUANT_LINEAGE_MISMATCH` |
| Quant asOf must equal scanner asOf | blocking `SCANNER_QUANT_LINEAGE_MISMATCH` |
| Scanner, quant or backtest data later than decision asOf | blocking `EVIDENCE_FROM_FUTURE` |
| Scanner ranking incomplete | warning; blocking if `requiresCompleteUniverse` (`SCANNER_RANKING_INCOMPLETE`) |
| Backtest quality INVALID | blocking `BACKTEST_INVALID` |
| Backtest without equity series (no data window) | blocking `BACKTEST_AVAILABILITY_UNVERIFIABLE` |
| Backtest strength | `strong` only for grade A without insufficient sample; otherwise `weak` plus `BACKTEST_WEAK_EVIDENCE` |
| Insufficient sample (e.g. 3 trades, 100 % win rate) | warning `BACKTEST_INSUFFICIENT_SAMPLE`, strength `weak` |
| Instrument mismatch between quant, candidate, opportunity or backtest | blocking `CROSS_INSTRUMENT_EVIDENCE` |
| Backtests without any instrument anchor | blocking `EVIDENCE_INSTRUMENT_UNKNOWN` |
| Backtest creation time | warning `BACKTEST_RECORDING_TIME_NOT_RECORDED` (always, see gaps) |

## Known gaps (not provable with the current data structures)

1. **Backtest creation time.** `BacktestRunResult` has no `createdAt`/`availableAt`. The validation proves that
   the data window ends at or before `asOf`. It cannot prove that the run existed before `asOf`. A backtest over
   2020–2025 computed later would pass the window check. This is reported as a warning, never as proof.
   Fix options: a `recordedAt` in the store envelope, outside the hashed result (like `QuantRunRecord.createdAt`).
   That needs a schema change and a decision by the owner.
2. **Scanner availability.** `ScannerRun` does not persist the snapshot availability times
   (`lastPriceAvailableAt`, `averageVolumeAvailableAt`). They are checked at computation time only.
   The stored run proves the cut at `asOf`, not the individual availability times.
3. **Strength is not yet weighted.** `strength` and the warnings are part of the decision and the audit trail.
   They do not yet change consensus or the outcome. A weak backtest can therefore still be cited without a
   reduction in the decision's confidence.
4. **Quant quality.** The quant reference is checked for existence, instrument and asOf. Its `mode` and
   `usableForTrading` are not checked yet.
5. **No maximum evidence age.** An older, valid scanner run can be cited at a later decision time.
6. **Caller-asserted backtest quality context** (O8) is still open. `dataComplete`, `providerProduction`,
   `pointInTimeUniverse` and `corporateActions` are supplied by the caller.
7. **Scanner `lastPrice`** is a caller value with a caller-supplied availability time. It is not cross-checked
   against the quant bar series.
8. **Audit event type.** A dedicated `EVIDENCE_VALIDATED` event would need a change to the `audit_events` CHECK
   constraint. The migration guard refuses `ALTER TABLE … DROP` by design, so the event rides on `TASK_CREATED`
   instead. A new migration that drops and re-adds the constraint needs an explicit owner decision.
9. **Canonical JSON** maps `undefined` inside arrays to `null`, so `[undefined]` and `[null]` hash the same
   (LOW). The persisted JSON is identical, so no stored result is misread.

## Behaviour change

`inputFingerprint` now includes `evidenceLineage`. Decisions recorded before this change keep their stored
fingerprint, which is not recomputed. New fingerprints differ from old ones even for the same inputs.
