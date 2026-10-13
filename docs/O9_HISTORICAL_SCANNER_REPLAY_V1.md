# O9: Historical Scanner Replay V1

Status: design first. Base: `c5298b8` (O7 multi-instrument portfolio event loop merged and green).

## 1. Goal

NEXUS can already:

- store point-in-time market data with reproducibility anchors;
- compute deterministic Quant runs at an explicit `asOf`;
- select a point-in-time universe revision;
- run and persist one scanner decision;
- backtest one or multiple instruments.

What is missing is the orchestration layer that repeats the scanner over a historical timeline without silently using information learned later.

O9 adds a deterministic **Historical Scanner Replay** service. It produces an ordered series of scanner runs at explicit replay instants. Each step is reproducible from pinned universe and market-data storage anchors.

This is research infrastructure only. It does not create orders or unlock Live Trading.

## 2. Why this comes after O7

O7 solved portfolio execution across multiple instruments. The next requirement for realistic strategy research is to know **which instruments NEXUS would have selected at each historical decision point**.

Without historical scanner replay, a portfolio backtest can consume a hand-built instrument set but cannot yet prove that the set was selected without look-ahead.

O9 becomes the bridge:

`point-in-time universe -> point-in-time Quant -> scanner ranking -> historical scanner timeline -> later walk-forward / out-of-sample portfolio research`.

## 3. Non-goals

O9 V1 does not add:

- model training;
- walk-forward parameter optimization;
- out-of-sample scoring;
- portfolio allocation from scanner rank;
- broker execution;
- AI recommendations;
- dynamic capital limits;
- new indicators;
- new market-data providers.

Those build on the replay timeline later.

## 4. Explicit replay schedule

The caller supplies the exact ordered replay instants:

```
asOf: readonly string[]
```

O9 does not invent a cadence from bar timestamps.

Every instant must be canonical UTC, unique, and strictly increasing after normalization.

Examples:

- daily research: each regular-session close;
- weekly research: Friday close;
- intraday research: every 5-minute decision boundary.

A future scheduler may generate these instants, but the O9 core consumes an explicit schedule.

## 5. Two independent storage anchors

Historical replay must not change when new data is backfilled tomorrow.

Therefore the request pins both data domains independently.

### 5.1 Universe anchor

`universeStoredThrough` is the maximum universe ingest sequence visible to the replay.

Every universe selection uses:

```
select({
  universeId,
  sourceId,
  asOf,
  mode,
  storedThrough: universeStoredThrough
})
```

A later universe backfill cannot alter an already pinned replay.

### 5.2 Market-data anchors

Market data is pinned per instrument:

```
marketStoredThroughByInstrument: Record<instrumentId, ingestSeq>
```

Every Quant run and every snapshot price/volume read for an instrument uses exactly that same anchor.

A later price-bar or corporate-action backfill cannot alter an already pinned replay.

Missing anchors fail closed. O9 never silently falls back to today's storage head during a pinned replay.

## 6. Replay modes

O9 supports the existing replay modes:

- `historical_research`
- `decision_time`

The same mode is passed consistently to:

- universe selection;
- QuantService;
- market-data reads used to build scanner snapshots.

The service must not use `historical_research` for one dependency and `decision_time` for another inside the same step.

## 7. Scanner definition

The scanner definition is immutable for one O9 replay.

Changing any filter, ranking weight, interval, maxCandidates, useCase or definition version changes replay identity.

O9 never rewrites `definition.useCase`.

Consequences:

- a research scanner may accept historical reconstructions while carrying their evidence;
- a live-trading scanner run at a historical decision point still requires strict evidence and may reject candidates.

This distinction remains visible rather than being relaxed by the replay service.

## 8. Building one replay step

For each `asOf`:

1. select the point-in-time universe with the pinned universe anchor;
2. canonicalize members by `instrumentId`;
3. for every selected member:
   - use its pinned market-data anchor;
   - run QuantService at exactly this `asOf`;
   - build one ScannerSnapshot from market data visible at exactly this `asOf`;
4. call `runMarketScanner` with that universe selection and those snapshots;
5. persist the ScannerRun;
6. store the step manifest containing the scannerRunId, universe fingerprint and Quant run ids.

The next replay instant starts only after the current step is fully determined.

## 9. Scanner snapshot semantics

A replay snapshot must not mix one Quant input set with a different market-data read.

For one instrument and one `asOf`:

- Quant uses the configured source / interval / session / adjustment;
- snapshot last price comes from the latest final bar visible under the same replay mode and market anchor;
- average volume, when required, is computed only from bars visible under that same read boundary;
- `lastPriceAvailableAt` and `averageVolumeAvailableAt` come from the actual input evidence, never from `asOf` by assumption.

If no final bar is visible, the instrument has no snapshot.

V1 must not synthesize a price from a future bar, quote, adjusted series of another derivation, or the current wall clock.

## 10. Missing or unusable instruments

A universe member may have no usable snapshot at one historical instant.

O9 does not silently remove it from the universe.

Instead the scanner receives incomplete coverage so that the stored ScannerRun exposes:

- missing instruments;
- rejected instruments;
- incomplete ranking when appropriate.

A data-integrity failure, anchor mismatch, or point-in-time violation is different: those fail the replay step closed rather than being downgraded to ordinary missing coverage.

## 11. Replay result

O9 introduces:

`historical-scanner-replay:v1`

A replay result contains:

- replayRunId;
- inputFingerprint;
- scanner definition identity;
- replay mode;
- ordered `asOf` schedule;
- universe id / source id / universeStoredThrough;
- sorted market-data anchors;
- one ordered step per `asOf`.

Each step records at least:

```
{
  asOf,
  scannerRunId,
  scannerInputFingerprint,
  universeFingerprint,
  universeSnapshotRevisionId,
  quantRunIds: [{ instrumentId, quantRunId, storedThrough }],
  candidateInstrumentIds,
  rankingComplete
}
```

The step stores references, not duplicated Quant payloads.

## 12. Identity

`inputFingerprint` includes:

- `historical-scanner-replay:v1`;
- scanner definition;
- replay mode;
- complete normalized replay schedule;
- universe id and source id;
- universeStoredThrough;
- sorted marketStoredThroughByInstrument;
- snapshot-building policy version;
- Quant parameter overrides, if any;
- configured series source / interval / session / adjustment.

Map insertion order must never affect identity.

The replayRunId is derived from that fingerprint.

Changing only one storage anchor must change replay identity.

## 13. Determinism

With identical:

- replay request;
- pinned anchors;
- stored immutable inputs;
- algorithm versions;

O9 must reproduce:

- the same universe revision per step;
- the same Quant run ids;
- the same Scanner run ids;
- the same candidate order;
- the same replay fingerprint and replayRunId.

Wall-clock creation timestamps are not part of deterministic content.

## 14. No look-ahead invariants

O9 must prove:

1. A universe revision effective earlier but sealed after T is invisible to a `decision_time` step at T.
2. A bar learned after T is invisible to a `decision_time` Quant run at T.
3. A future bar never changes a previous step's candidates.
4. A future universe revision never changes a previous pinned step.
5. A later backfill with ingest sequence above the storedThrough anchors never changes the replay.
6. A scanner step uses only snapshots whose availability evidence is at or before its `asOf`.

## 15. Interaction with QuantService

O9 reuses QuantService; it does not reimplement indicator mathematics.

QuantService receives:

- instrumentId;
- source;
- interval;
- session;
- adjustment;
- exact `asOf`;
- exact market `storedThrough`;
- replay mode;
- optional fixed Quant parameters.

Every resulting QuantRunRecord is persisted by the existing QuantRunStore.

O9 records its quantRunId and storedThrough in the step manifest.

## 16. Interaction with UniverseStore

O9 depends only on the point-in-time selection contract:

```
select({ universeId, sourceId, asOf, mode, storedThrough })
```

It works with the PostgreSQL implementation in production and an in-memory test double.

Universe evidence is passed unchanged into `runMarketScanner`.

O9 never manufactures or edits universe evidence.

## 17. Interaction with ScannerRunStore

Every step persists its ScannerRun using the existing ScannerRunStore.

Idempotent save is expected.

Same scannerRunId with different content remains a conflict and fails closed.

The O9 replay manifest is a separate orchestration artifact and does not replace ScannerRun persistence.

## 18. Failure model

The replay fails closed on:

- invalid or non-monotonic schedule;
- missing universe anchor;
- missing market anchor for a selected instrument;
- anchor mismatch between Quant and snapshot construction;
- integrity errors from universe, market-data, Quant or scanner stores;
- non-canonical duplicate replay instants;
- mixed replay modes inside one step;
- scanner persistence conflict.

Ordinary scanner coverage gaps remain visible inside the ScannerRun and do not become silent exclusions.

## 19. RED test matrix

Before implementation, tests must show:

1. Two replay instants produce two ordered scanner steps.
2. Map insertion order of market anchors does not change identity.
3. A later market-data backfill above the pinned anchor does not change an old replay.
4. A later universe revision above the pinned anchor does not change an old replay.
5. `decision_time` hides a bar whose knowledge is after T.
6. `decision_time` hides a universe revision whose seal is after T.
7. `historical_research` may use a reconstruction but the evidence remains non-strict.
8. A missing universe member snapshot appears as incomplete scanner coverage, not as a silently smaller universe.
9. Future bar changes do not change earlier scannerRunIds or candidate lists.
10. Changing one historical input changes only the affected step and replay identity, not earlier unaffected step outputs.
11. Repeating the same pinned replay gives identical run ids and candidates.
12. Missing a selected member's marketStoredThrough anchor fails closed.
13. An unsorted or duplicate schedule is refused.
14. Existing Scanner V5, QuantService and universe-engine:v2 tests remain green.

## 20. Persistence

V1 may begin with an in-memory replay manifest store if the orchestration contract is still being proven.

Before O9 is considered production-auditable, PostgreSQL persistence must be append-only and include:

- replayRunId;
- input fingerprint;
- request/anchors;
- ordered step references;
- canonical payload hash;
- integrity verification on read.

No UPDATE/DELETE semantics are introduced.

## 21. What O9 enables next

Once O9 is stable, the next research layer can consume its immutable candidate timeline for:

- walk-forward windows;
- out-of-sample validation;
- portfolio entry rules based on historical scanner rank;
- scanner parameter benchmarking;
- model/AI shadow benchmarking without look-ahead.

## 22. Safety

O9 produces historical research evidence only.

Live Trading, Broker Orders and Physical Purchase remain LOCKED.
