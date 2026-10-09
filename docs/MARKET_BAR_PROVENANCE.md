# Market Bar Provenance (F9) — 2026-10-09

Status: inventory and decisions written before any change (base `9d0e640af766d3de40ce31675916b9e2b1e6b3c1`).
Branch: `feature/market-bar-provenance`. Not merged.

Goal: NEXUS must tell apart three things that the current bar model keeps in one field, `availableAt`:

1. **MARKET OBSERVABILITY**: when the bar was complete (or, for an in-progress bar, observed) at the source.
2. **DATA REVISION KNOWLEDGE**: when NEXUS can prove that this exact revision was available.
3. **HISTORICAL RECONSTRUCTION**: today's historical values are used, without claiming that this exact vintage was archived at the time.

## 1. Inventory of the current semantics (verified in code)

| Element | Where | Current behaviour |
|---|---|---|
| `MarketBar` | `src/market-data/market-data-types.ts` | `observedAt`, `availableAt`, `retrievedAt`; no provenance |
| `StoredBar` | same | `MarketBar` + `revision`, `ingestSeq`, `contentHash` |
| `observedAt` | Twelve Data `toBars` | final bar: window completion; in-progress bar: `retrievedAt` |
| `availableAt` | Twelve Data `toBars` | identical to `observedAt` (completion or retrieval) |
| `retrievedAt` | Twelve Data `toBars` | adapter clock (fetch time) |
| Twelve Data `toBars` | `src/market-data/providers/twelve-data.ts:227-273` | `isFinal = completion + settle <= retrieved`; `observedAt = availableAt = known`; no capture classification |
| `validateBar` | `src/market-data/bar-validation.ts` | `available <= retrieved + skew`; final intraday `available >= end`; `available >= start`; no provenance rule |
| `planBars` / `planIngest` | `market-data-store.ts:199-274`, `276-291` | first revision keeps the given `availableAt` (provider claim); revision >= 2: `max(given, retrievedAt, previous.availableAt)` |
| `visibleRevision` | `market-data-store.ts:393-400` | highest revision with `ingestSeq <= storedThrough` and `availableAt <= asOf` |
| PostgreSQL `market_bars` | `db/migrations/004_market_data.sql:104-130` | `observed_at`, `available_at`, `retrieved_at`; CHECKs `available_at >= start`, final intraday `available_at >= end`; no provenance column |
| PostgreSQL trigger | `004_market_data.sql:134-152` | revision 1: no availability check; revision >= 2: `available_at >= prev.available_at` and `available_at >= retrieved_at` |
| PostgreSQL read | `postgres-market-data-store.ts:330-347` | `DISTINCT ON`, `available_at <= asOf`, `ingest_seq <= storedThrough` |
| Quant cut | `src/quant/quant-engine.ts:274-281` | drops bars with `availableAt > asOf` and `startTime >= asOf`, drops non-final unless in-progress is requested |
| Quant input fingerprint | `quant-engine.ts` `fingerprintBars` | `[startTime, endTime, OHLC, volume, isFinal]`: **no `availableAt`, no provenance** |
| QuantResult | `src/quant/quant-types.ts` | `dataQuality`, `algorithmVersions`, `inputFingerprint`; nothing about bar provenance |
| DataQuality | `src/market-data/data-quality.ts` | `not_yet_available` if `availableAt > asOf`; `invalid_time` if a final bar's `availableAt < completion`; `usableForTrading` / `usableForBacktest` from fixed rules; no vintage rule |
| Scanner | `src/scanner/market-scanner.ts:57` | rejects a snapshot whose `quant.dataQuality.usableForTrading` is false; no vintage notion |
| BacktestQuality | `src/backtest/quality.ts`, `backtest-types.ts:BacktestQuality` | grade `A/B/C/INVALID` from dataComplete, universe, corporate actions, provider production, zero-cost, ambiguous bars, sample size; no bar provenance |
| Backtest engine | `backtest-engine.ts:41-43`, `:59-66`, `:242-253` | event queue and PIT state use `availableAt`; input fingerprint includes `availableAt` (`barFingerprint`) but no provenance |
| Quotes | `twelve-data.ts:352-375`, `planQuotes` | `availableAt = retrievedAt` in the only adapter path; the store takes any provided `availableAt` (see F10) |

### 1.1 Field semantics as they are today

- **`observedAt` currently means:** the instant the value was true at the source. For a final bar that is its window completion; for an in-progress bar it is the retrieval instant. Nothing reads it for a decision.
- **`availableAt` currently means:** the instant from which the bar may be used by a replay. For a first revision it is the provider's claim (equal to completion); for later revisions it is additionally floored by `retrievedAt` and by the previous revision. It is used as the knowledge gate everywhere, including for the first revision.
- **`retrievedAt` currently means:** when NEXUS fetched this revision. It is a floor only for revisions >= 2.
- **First revision semantics:** stored with the provider's `availableAt`, which is the bar completion. No retrieval floor. This is finding F9.
- **Later revision semantics:** `availableAt = max(provider availableAt, retrievedAt, previous availableAt)`. This protects against a correction becoming visible before NEXUS had it. It must be kept.

## 2. Findings

| Id | Severity | Finding | Evidence |
|---|---|---|---|
| F9 | HIGH | The first stored revision of a bar gets the provider's `availableAt` (completion) with no proof that this revision existed then. A bar retrieved years later passes the same replay gate as one captured live. The database does not check revision 1 against retrieval (the rule cannot be copied for bars: a historical first revision must be allowed). | `planIngest` `market-data-store.ts:264`; `004_market_data.sql:136-151`; Twelve Data `twelve-data.ts:250-266` |
| F9a | MEDIUM | The quant input fingerprint does not contain `availableAt` or any provenance. Two runs with identical OHLC but different knowledge produce the same `quantRunId`. | `quant-engine.ts` `fingerprintBars` |
| F9b | MEDIUM | DataQuality and BacktestQuality cannot tell a reconstructed bar from a captured one. Backtest grade is the same for both. | `data-quality.ts`, `quality.ts` |
| F10 | LOW (latent) | The quote store accepts any `availableAt` a caller supplies, and the quote revision 1 is unchecked, as for bars. The only adapter path sets `availableAt = retrievedAt`, so no current quote is affected. Not changed here. | `twelve-data.ts:352-375`; `planQuotes`; `004_market_data.sql:186-196` |

### 2.1 F9 reproduction (red test before the change)

`test/market-data/bar-provenance.test.ts`, scenario A: a bar completed in 2020 and first retrieved in 2026 is replayed in strict mode at a time after its retrieval. The current model returns it as if it had been strictly known from its completion, and it carries no marker that its vintage is unproven.

## 3. Decisions

### 3.1 Three time concepts, explicit fields

| Concept | Field | Meaning | Proof |
|---|---|---|---|
| Market observability | `observedAt` | final bar: window completion; in-progress bar: retrieval instant | calendar and provider timing; not knowledge |
| Historical replay gate | `availableAt` | `max(observedAt, revision floor, previous gate)`. Used by historical reconstruction. Never a knowledge claim | derived by the store; a provider value may only raise it |
| Revision knowledge | `knowledge.provenance`, `knowledge.revisionKnownAt` | when this exact revision was provably held | provenance (below) |
| Retrieval | `retrievedAt` | when NEXUS fetched this revision | NEXUS capture clock |

The name `availableAt` stays because quotes, corporate actions, the backtest queue and the PIT state share it. For bars it is documented as the historical gate and nothing else.

### 3.2 Provenance

`BarKnowledgeProvenance`:

- `captured_by_nexus`: NEXUS received this revision live. `revisionKnownAt = retrievedAt`. Strong.
- `provider_published_at`: the provider states a publication time for this revision. `revisionKnownAt` = that time, `<= retrievedAt`. Not used by Twelve Data (it publishes no such field); implemented and tested like the corporate-action path.
- `historical_bar_reconstruction`: a backfill. We know the window, today's OHLC and that the market existed then. We do not know whether this vintage existed then, nor whether later corrections were folded in. `revisionKnownAt = null`. Usable for historical reconstruction; never labelled as archived point-in-time data.
- `legacy_unproven`: a row stored before provenance existed. `revisionKnownAt = null`. Nothing is invented. Ingest refuses it.

### 3.3 Replay modes

- `historical_reconstruction` (the normal backtest mode until archived vintages exist): per key, the highest revision whose historical gate is `<= asOf` (and `ingestSeq <= storedThrough`). Results carry the bars' provenance and get `vintage_not_proven` / `legacy_provenance_unproven` quality.
- `strict_point_in_time`: per key, take the highest revision `hv` whose historical gate is `<= asOf`. If `hv` is proven and `max(observedAt, revisionKnownAt) <= asOf`, return it. If `hv` is proven but NEXUS did not hold it yet, return nothing for that key. If `hv` is not proven, throw `BAR_VINTAGE_NOT_PROVEN` (fail closed). This is never silent.

### 3.4 Revisions

- Revision >= 2 keeps the floor: `availableAt >= revisionKnownAt ?? retrievedAt` and `availableAt >= previous availableAt`.
- For proven revisions the knowledge must not go backwards: a later revision cannot be known before an earlier proven one (ingest quarantine, database trigger).
- A proven final bar cannot be known before its completion (`revisionKnownAt >= observedAt`).

### 3.5 Twelve Data policy (deterministic)

- Final bar, `retrievedAt - completion <= captureWindow(interval)` → `captured_by_nexus`, `revisionKnownAt = retrievedAt`.
- In-progress bar (`isFinal = false`) → `captured_by_nexus`, `revisionKnownAt = retrievedAt`. It is the current bar, fetched now.
- Anything else (a backfill, or a final bar retrieved after the window) → `historical_bar_reconstruction`, `revisionKnownAt = null`.
- `captureWindow = { intraday: 15 min, daily: 2 h }`. Explicit configuration, reviewed in code. The window must be shorter than what a provider would plausibly still revise (settlement is 60 s intraday and 15 min daily in our config) and long enough to cover one polling cycle. The exact value is a policy choice for the owner to confirm; a wrong choice only moves bars between the two classes, it never leaks knowledge.

### 3.6 Storage (migration 008, additive)

Columns on `market_bars`: `knowledge_provenance TEXT NULL`, `revision_known_at TIMESTAMPTZ NULL`, `provenance_hash CHAR(64) NULL`. Same row, not a separate table, for the same reason as corporate actions: one revision is one immutable row. Constraints and the revision trigger are replaced (function body only; the trigger is found by name). `observed_at` and `available_at` keep their meaning. Legacy rows keep NULL and are not rewritten.

The database constraints follow the provenance model, not the retrieval rule of corporate actions:

- captured: `revision_known_at = retrieved_at`
- provider_published: `revision_known_at NOT NULL AND revision_known_at <= retrieved_at`
- historical or legacy: `revision_known_at IS NULL`
- final proven: `revision_known_at >= observed_at`
- new rows must state provenance (`NOT VALID` for legacy rows)

### 3.7 Integrity

`barProvenanceHash` covers the bar identity (`instrumentId`, `source`, `interval`, `session`, `adjustment`, `startTime`), `contentHash`, `retrievedAt`, `observedAt`, `availableAt`, `knowledge.provenance` and `knowledge.revisionKnownAt`. The content hash stays economic (unchanged). Verified on every read.

### 3.8 Impact decisions

- **QuantResult** gets `barDataProvenance`: counts and booleans (`strictPointInTime`, `historicalReconstruction`, `legacyUnproven`, `knownAfterAsOf`). The quant input fingerprint includes `availableAt`, provenance and `revisionKnownAt`. The engine version becomes `quant-engine:v2` because the result shape changes. Stored v1 runs stay as they are; their replay is not guaranteed.
- **DataQuality** adds two warnings, `vintage_not_proven` and `legacy_provenance_unproven`. Warnings do not invalidate a series. `usableForTrading` requires that neither is present. `usableForBacktest` is unchanged.
- **Scanner**: no new logic. A snapshot whose quant run is not strict is rejected by the existing `usableForTrading` check, with an explicit reason.
- **BacktestQuality** gets `dataProvenance: 'STRICT_PIT_DATA' | 'HISTORICAL_RECONSTRUCTION' | 'LEGACY_UNPROVEN'`. A bar is strict for a backtest when it is proven and `max(observedAt, revisionKnownAt) <= availableAt`, that is, the engine used it only after NEXUS held it. Historical bars cap the grade at B, legacy bars at C. Returns never change the grade. The backtest engine version becomes `backtest-engine:v3`, since the quality output changes.
- **Quotes**: no change in this branch (see F10).

## 4. Regression tests

Written before the implementation, as required:

- `test/market-data/bar-provenance.test.ts`: A historical first revision, B live capture, C later correction, D historical correction, E legacy refused at ingest, H quant fingerprint, I no look-ahead, Twelve Data policy, DataQuality and BacktestQuality grading.
- `test/pg/bar-provenance.pg.test.ts`: F database combinations, G provenance tampering, roundtrip in a fresh process, legacy rows through migration 008.
- J (existing behaviour) is covered by the existing suite staying green, with the deliberate changes listed in section 7.

## 5. Implementation (this branch)

### 5.1 Model and replay rules

- `src/market-data/market-data-types.ts`: `BarKnowledgeProvenance`, `BarRevisionKnowledge`, `BarReplayMode`. `MarketBar.knowledge` is required on every bar. `StoredBar.provenanceHash`.
- `src/market-data/bar-replay.ts` (new, the one place for these rules):
  - `barUsableFromMs(bar)`: `availableAt` for an unproven revision; `max(availableAt, revisionKnownAt)` for a proven one. NEXUS never uses a proven revision before it held it, in either mode.
  - `classifyVisibleBar(bar, asOf)`: `usable`, `not_yet_held` (proven, held after asOf: absent) or `unproven` (historical reconstruction or legacy).
  - `countBarProvenance`, `BarVintageNotProvenError` (code `BAR_VINTAGE_NOT_PROVEN`).
- Replay, in the in-memory store and in PostgreSQL by the same rule: the highest revision whose historical gate is `<= asOf` is the visible one.
  - `historical_reconstruction` (default): an unproven visible revision is returned, labelled by its provenance.
  - `strict_point_in_time`: an unproven visible revision makes the read throw `BarVintageNotProvenError` (fail closed; nothing is dropped or substituted).
  - Both modes: a proven visible revision is returned only if `usable <= asOf`, otherwise the bar is absent.

### 5.2 Gates and revisions

- `availableAt` (historical gate): revision 1 keeps the value the caller gives, validated `>= observedAt`. Twelve Data gives the completion, as before. A provider value is a market-time claim for historical reconstruction; it never becomes knowledge.
- Revision >= 2: `max(given, revisionFloor, previous gate)`, where `revisionFloor = revisionKnownAt ?? retrievedAt`. Corrections keep the protection of section 3.4.
- Knowledge never moves backwards between proven revisions: the planner quarantines such a revision (`invalid_time`), and the database trigger refuses it.
- `validateBar`: a historical reconstruction has no knowledge time; a captured revision is known exactly at its retrieval; a final bar cannot be known before completion; `availableAt >= observedAt`. Ingest refuses `legacy_unproven`. Reads accept legacy rows as legacy.
- `barProvenanceHash` covers the bar identity, `contentHash`, `retrievedAt`, `observedAt`, `availableAt`, provenance and `revisionKnownAt`. Verified on every read.

### 5.3 Twelve Data policy (`src/market-data/providers/twelve-data.ts`)

- An in-progress bar is `captured_by_nexus` with `revisionKnownAt = retrievedAt`.
- A final bar is `captured_by_nexus` only when `retrievedAt - completion <= captureWindowMs`. The default is `{ intraday: 15 min, daily: 2 h }` (`DEFAULT_CAPTURE_WINDOW_MS`), configurable, reviewed in code.
- Any other fetch is `historical_bar_reconstruction` with `revisionKnownAt = null`.
- `observedAt` and `availableAt` are unchanged. No vintage or publication time is claimed; the provider publishes none.

### 5.4 Migration 008 (`db/migrations/008_market_bar_provenance.sql`, additive)

- Columns on `market_bars`: `knowledge_provenance`, `revision_known_at`, `provenance_hash`. NULL means legacy (no claim); no backfill, no invented times.
- CHECKs: provenance values (three; legacy is the NULL state); shape (proven needs `revision_known_at <= retrieved_at`, reconstruction needs NULL); `captured_by_nexus` equals retrieval; a final proven bar is not known before completion; hash format. `NOT VALID`: `market_bars_available_not_before_observed`, `market_bars_provenance_required`.
- `nexus_market_bar_revision()` replaced (the trigger is found by name). Revision 1 is not checked against retrieval: a historical first revision is legitimate. Revision >= 2: `available_at >= COALESCE(revision_known_at, retrieved_at)`, and knowledge does not move backwards.
- Migrations 001 to 007 are unchanged.

### 5.5 Impact

- **DataQuality**: `vintage_not_proven` (historical reconstruction, or unproven visible) and `legacy_provenance_unproven` are warnings. `usableForTrading` requires neither. `usableForBacktest` is unchanged. `not_yet_available` uses the usable instant.
- **QuantResult**: `barDataProvenance = { strictPointInTime, historicalReconstruction, legacyUnproven, provenBars, historicalBars, legacyBars }`. `strictPointInTime` only if every input bar is proven. The input fingerprint includes `observedAt`, `availableAt`, `retrievedAt`, provenance and `revisionKnownAt`. `QUANT_ENGINE_VERSION = quant-engine:v2`. `QuantRunRequest.replay` passes the mode to the store. Split adjustment gives derived bars honest knowledge (`derivedBarKnowledge`).
- **Scanner**: `ScannerDefinition.useCase`: `live_trading` (default: trading usability and strict provenance required) or `research` (valid data is enough). Each `ScannerCandidate` carries `strictPointInTime`. Existing definitions keep their meaning (no `useCase` means live).
- **BacktestQuality**: `dataProvenance` is `STRICT_PIT_DATA`, `HISTORICAL_RECONSTRUCTION` or `LEGACY_UNPROVEN`. Historical bars cap the grade at B, legacy bars at C, and the reason is recorded. The return never enters. The engine times each bar by its usable instant, so a proven bar is never used before NEXUS held it. The input fingerprint includes provenance. `BACKTEST_ENGINE_VERSION = backtest-engine:v3`.
- **Quotes**: not changed (see F10).

## 6. Tests

- `test/market-data/bar-provenance.test.ts` (18): A historical first revision; B live capture (before and after the retrieval, both modes); C later correction (both modes), and a reconstructed revision followed by a live correction; D reconstruction is not trading-usable, captured is; E legacy refused at ingest; H quant fingerprint; I no look-ahead through revisions (a guard, green before and after the change); Twelve Data policy (captured within the window, reconstruction when late, in-progress captured); DataQuality legacy warning; BacktestQuality recording, the provenance cap through the grading rule, and run ids.
- `test/pg/bar-provenance.pg.test.ts` (12, PostgreSQL 17.10): F database combinations (captured knowledge equals retrieval; reconstruction has no knowledge time; provider time not after retrieval; no knowledge before completion; `legacy_unproven` refused; new rows must state provenance; revision floor; knowledge monotone); roundtrip in a fresh process; G privileged change of provenance detected on read; E migration 008 on existing rows (not rewritten, labelled legacy, strict refuses); in-memory and PostgreSQL agree.
- `test/scanner/scanner-core.test.ts`: live refuses reconstructed candidates with the reason; research accepts and marks them.

## 7. Behaviour changes in existing tests (deliberate, reviewed)

- Fixture bars (`test/market-data/fixtures.ts`) are backfills by default, so they carry `vintage_not_proven`. The clean-series test now asserts that warning. The freshness and scanner fixtures that test trading use live-captured bars (retrieved one minute after completion). A PostgreSQL invariant accepts either of two equivalent constraint names for "a final bar is not available before it ended".
- The corporate-action migration test writes its bars after the migration that adds their columns.
- Migration lists now include 008; the `BACKTEST_ENGINE_VERSION` expectation is v3; `BacktestQuality` and `ScannerCandidate` carry the new fields.
- Stored runs of `quant-engine:v1` and `backtest-engine:v2` have no provenance fields. Their replay is not guaranteed identical, because the result shape changed.

## 8. Remaining limitations

1. **Unchanged content keeps its first label.** A re-delivery of identical content is "unchanged" (the content hash excludes provenance). A reconstruction first stored and later captured with identical content stays a reconstruction; only a changed revision can carry a proof. Decision needed if this order matters in practice.
2. **Strict replay cannot prove the absence of unknown later revisions.** It proves each revision it uses, and refuses when the highest visible revision is unproven.
3. **Capture window** `{ intraday: 15 min, daily: 2 h }` is a policy choice for the owner to confirm. A different value only moves bars between the two classes.
4. **Backtests are capped by corporate actions.** The V1 engine cannot state that corporate actions are modelled, so every V1 backtest grades at most C (pre-existing). The provenance dimension is recorded and visible; it becomes the binding cap once O2 models corporate actions.
5. **Evidence (O1)** does not yet read bar provenance of the cited quant or backtest runs. A decision that requires strong evidence should refuse runs without `barDataProvenance` or `dataProvenance`. This is the next step.
6. **Quotes (F10, latent):** the store accepts a caller's `availableAt` for quotes, and quote revision 1 is unchecked. The only adapter path uses `availableAt = retrievedAt`, so no current quote is affected.
7. **Derived swing labels:** `confirmedAt` now shows the usable instant (a label only).
8. **Provider first-revision gate** is still a provider claim in the market-time sense. It is validated only against observation time.
9. **Quant replay of v1 runs** is not guaranteed identical (see section 7).

## 9. Findings status

- **F9**: closed. Observability, revision knowledge and historical reconstruction are separate fields with separate replay rules. A historical bar can be used for research and is labelled; it cannot be presented as strict point in time. The database enforces the combinations.
- **F9a** (fingerprint lacked availability and provenance): closed.
- **F9b** (quality and backtest grade did not distinguish reconstructions): closed.
- **F10** (quotes, latent): open, documented, not changed.
