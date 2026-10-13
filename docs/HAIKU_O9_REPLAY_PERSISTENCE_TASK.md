# Haiku task: O9 Replay Persistence & Integrity Hardening

Base: main at `bb8a8a7`.
Branch: `feature/o9-replay-persistence-hardening-v1`.

## Purpose

Strengthen O9 Historical Scanner Replay with an append-only persistence layer and independent integrity verification.

Do **not** touch the O10 branch or O10 files. This task must be mergeable independently.

## Scope

Implement persistence for `HistoricalScannerReplayResult` from:

- `src/scanner/historical-scanner-replay.ts`

### Required API

Create:

- `src/scanner/historical-scanner-replay-store.ts`

with:

- `HistoricalScannerReplayStore`
- `InMemoryHistoricalScannerReplayStore`
- `HistoricalScannerReplayConflictError`
- `HistoricalScannerReplayIntegrityError`
- `verifyHistoricalScannerReplayResult(result)`

Suggested contract:

```ts
interface HistoricalScannerReplayStore {
  save(result: HistoricalScannerReplayResult): Promise<'APPLIED' | 'ALREADY_APPLIED'>;
  get(replayRunId: string): Promise<HistoricalScannerReplayResult | null>;
  getSealed(replayRunId: string): Promise<Sealed<HistoricalScannerReplayResult> | null>;
}
```

Reuse existing persistence primitives and patterns from:

- `src/scanner/scanner-store.ts`
- `src/quant/quant-run-store.ts`
- `src/persistence/evidence-seal.ts`
- `src/persistence/canonical-json.ts`

## Verification requirements

The verifier must fail closed when any of these are inconsistent:

1. `engineVersion !== historical-scanner-replay:v1`
2. invalid/non-hex 64-char `inputFingerprint`
3. `replayRunId !== 'hsr_' + inputFingerprint.slice(0, 40)`
4. `definitionId` / `definitionVersion` empty
5. `asOf` not strictly increasing
6. number/order of `steps` does not match `asOf`
7. any `step.asOf` differs from matching replay `asOf`
8. duplicate `scannerRunId`
9. duplicate instrument entries inside one step's `quantRunIds`
10. `quantRunIds` not sorted canonically by instrumentId
11. duplicate `candidateInstrumentIds`
12. `candidateInstrumentIds` not sorted by scanner rank order is allowed; do not alphabetically rewrite them
13. negative/non-integer `universeStoredThrough`
14. negative/non-integer market anchors
15. market anchor keys not canonicalized in stored result
16. child quant `storedThrough` differs from the replay's pinned anchor for that instrument
17. unknown child instrument without a pinned market anchor
18. tampered stored payload/hash
19. tampered evidence seal
20. same replayRunId with different content => conflict

Do not silently repair malformed results.

## Append-only semantics

In-memory store behavior:

- first save => `APPLIED`
- byte/content-identical second save => `ALREADY_APPLIED`
- same replayRunId with different content => throw conflict
- serialize stored result so later caller mutation cannot alter the audit record
- seal with existing `EvidenceSeal` pattern

## Tests

Create:

- `test/scanner/o9-historical-scanner-replay-store.test.ts`

Minimum cases:

1. valid O9 result saves and reads back
2. same result is idempotent
3. mutation after save cannot mutate stored record
4. same id / changed content => conflict
5. tampered input fingerprint => integrity error
6. tampered run id => integrity error
7. unsorted/duplicate schedule => integrity error
8. step order/asOf mismatch => integrity error
9. duplicate scannerRunId => integrity error
10. child quant anchor mismatch => integrity error
11. unknown instrument anchor => integrity error
12. duplicate quant instrument => integrity error
13. malformed market anchors => integrity error
14. tampered stored payload => integrity error
15. tampered seal => integrity error

## Optional PostgreSQL

Do **not** add a DB migration unless the existing repo conventions make it clearly safe and fully testable in the current CI.

Priority is a correct verifier + in-memory reference store. PostgreSQL persistence can be a follow-up PR if required.

## Safety and preservation

Do not change:

- O9 replay algorithm
- scanner ranking
- Quant math
- universe selection
- O7 portfolio engine
- O6 timing
- O5 sizing
- live trading locks

All existing tests must remain green.

## Delivery

Commit in small steps, push to this branch, and report:

- commit hashes
- files changed
- test counts
- any unresolved concern
