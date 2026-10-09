# Corporate Action Provenance (point-in-time) — 2026-10-09

Status: implemented on this branch (§4). Sections 1–2 are the inventory of the state before the change (base `fe2554277c547bd254c59008667390f5ef07fced`).
Branch: `feature/corporate-action-provenance`. Not merged.

Purpose: separate three things that the current code mixes into one field, `availableAt`:

1. **Economic effective time**: when a corporate action changes positions and prices (split ex-date).
2. **Information knowledge time**: when NEXUS, or a provably published source, knew the action.
3. **Provenance**: what proves the knowledge time.

The ex-date is never evidence of knowledge time.

## 1. Inventory of the current semantics (verified in code)

### 1.1 `CorporateAction` (`src/market-data/market-data-types.ts`)

| field | current meaning | where it is set | used by | hashed |
|---|---|---|---|---|
| `exDate` | local trading date of the venue (`YYYY-MM-DD`) | provider | `splitAdjustBars`: bars with trading date before exDate are adjusted; the ex-date bar is not | yes |
| `availableAt` | **stored visibility time**, used as the knowledge gate | provider adapter: `min(retrievedAt, exDate 00:00 venue local)` (`twelve-data.ts:385`) | `visibleRevision`, `readCorporateActions` (`available_at <= asOf`), `splitAdjustBars` (known at asOf) | **no** (`corporateActionContentHash` omits it) |
| `retrievedAt` | NEXUS request time of this record | adapter clock | validation (`availableAt <= retrievedAt + skew`), derived bar `retrievedAt` (max) | **no** |
| `announcedAt` | optional provider announcement time | never set by the Twelve Data adapter (no such field in its schema) | nothing reads it for decisions | yes, when present |
| `revision` | per key version number | store (`planIngest`) | `visibleRevision` (highest visible) | no (row key) |
| `ingestSeq` | gapless per-instrument ingest sequence | store | `storedThrough` anchor | no |
| `contentHash` | hash of the economic content | `corporateActionContentHash` | `assertIntact` on every read | — |

Semantics in one line each:

- **effective semantics:** `exDate` (local date). Ratio and cash amount are the economic content. Nothing else.
- **availableAt semantics:** provider-asserted storage visibility, derived as `min(retrieved, exDate)`. Not knowledge evidence.
- **retrievedAt semantics:** when NEXUS fetched this record. A retrieval fact, always recorded.
- **announcedAt semantics:** optional provider data. It is not used as knowledge and no current source supplies it.
- **revision semantics:** a different content for the same key is a new revision (`planIngest`). Identical content changes nothing. For revisions ≥ 2 the planner sets `availableAt = max(provider availableAt, retrievedAt, previous availableAt)`. For the first revision it stores the provider `availableAt` unchanged.

### 1.2 Twelve Data adapter (`src/market-data/providers/twelve-data.ts:381-398`)

- `/splits`: `date`, `from_factor`, `to_factor`. No announcement or publication field is parsed.
- `/dividends` (requested with `adjust=false`): `ex_date`, `amount`. No payment, declaration or publication field is parsed.
- `availableAt(exDate) = min(retrievedMs, zonedToUtc(exDate, 00:00))`. A backfill retrieved in 2026 for a 2020 split therefore gets `availableAt = 2020-08-31`. The existing test (`test/market-data/twelve-data.test.ts:263`) codifies this as "backfill: known by ex-date".
- Dividend currency: `dividends.currency` if valid, else `instrument.currency` (`twelve-data.ts:395`). An assumption, not a provider fact.

### 1.3 InMemory store (`src/market-data/market-data-store.ts`)

- `planCorporateActions` → `planIngest` (shared with bars and quotes; lines 190-265):
  - identical content → `unchanged`;
  - first record: `availableAt` = the given value (no lower bound from `retrievedAt`);
  - later revision: `availableAt = max(given, retrievedAt, previous.availableAt)`;
  - gapless `ingestSeq`; `storedThrough` is the sequence a computation saw.
- `visibleRevision` (line 356): highest `revision` with `ingestSeq <= storedThrough` and `availableAt <= asOf`.
- `readCorporateActions` (line 490): one visible revision per key, filtered by type, sorted by exDate.
- The file header (lines 6-7) claims that every revision is visible only from retrieval. That is true for revisions ≥ 2 only (see finding F2).

### 1.4 PostgreSQL store (`src/persistence/postgres/postgres-market-data-store.ts`)

- Same planner. Insert columns include `available_at`, `retrieved_at`, `announced_at`, `content_hash`.
- `readCorporateActions` (line 446): `DISTINCT ON (source_id, action_key)`, `available_at <= $asOf`, `ingest_seq <= $storedThrough`, `ORDER BY revision DESC`. Equivalent to `visibleRevision`.
- `assertIntact` on read: the content hash does not cover `availableAt` or `retrievedAt`.

### 1.5 `corporate_actions` table and triggers (`db/migrations/004_market_data.sql`, lines 199-240)

- Primary key `(instrument_id, source_id, action_key, revision)`. `ratio_to > ratio_from` for splits and `<` for reverse splits (DB-enforced, matches the spec's convention).
- `nexus_corporate_action_revision` (BEFORE INSERT):
  - `IF NOT FOUND THEN (first revision must be 1)` → **no availability check**;
  - `ELSIF` (revisions ≥ 2): revision +1, `available_at` monotone, **`available_at >= retrieved_at`**.
- The header comment (lines 15-16) says a new revision is never visible before it was retrieved. For the first revision the database does not enforce this (finding F3).
- Immutability (`corporate_actions_immutable`) and no-truncate triggers are in place.

### 1.6 `splitAdjustBars` (`src/market-data/corporate-actions.ts`)

- Input: raw bars only (throws `DataQualityError` otherwise; a typed error, but generic in the caller).
- Known = `availableAt <= asOf`; effective = known and `exDate <= asOf date`; pending = known and `exDate > asOf date`.
- Applies every effective split whose ex-date is after the bar's trading date. Derived bar `availableAt = max(bar, applied splits' availableAt)`.
- It is the only place where economic adjustment and knowledge are the same timestamp.

### 1.7 Consumers

- **Quant** (`src/quant/quant-service.ts:40-53`): `split_adjusted` = raw bars + `readCorporateActions(split, reverse_split)` at asOf and storedThrough → `splitAdjustBars`. The result records `series.adjustment` but no version of the derivation. `algorithmVersions` contains indicator versions only (`quant-engine.ts:37`).
- **Scanner**: no direct corporate-action input. It consumes quant results through snapshots, so its exposure is indirect.
- **Backtest**: no corporate-action input (`BacktestInput`). `corporateActions` in the quality context is caller-asserted. Bars may be `split_adjusted`; the engine does not check their provenance.
- **O1 evidence**: quant references are validated for existence, lineage, instrument and asOf. Nothing checks the corporate-action provenance of a split-adjusted quant run.

## 2. Findings

| id | severity | finding | evidence |
|---|---|---|---|
| F1 | **CRITICAL** | The provider rule `availableAt = min(retrievedAt, exDate)` lets a late-retrieved action look known at its ex-date. A strict information replay at the ex-date then uses hindsight. | `twelve-data.ts:385`, `twelve-data.test.ts:263` |
| F2 | HIGH | The retrieval floor is applied to revisions ≥ 2 only. The first record of a key keeps the provider's `availableAt`, so F1 reaches storage. | `market-data-store.ts:255-261` |
| F3 | HIGH | Database and comment disagree for the first corporate-action revision: the comment says "never visible before it was retrieved"; the trigger does not check `available_at >= retrieved_at` for revision 1. Probe: see the PostgreSQL regression test. | `004_market_data.sql` lines 200-224 |
| F4 | HIGH | `availableAt` is not part of the content hash. A privileged change of the visibility time is not detected on read. | `bar-validation.ts:227` |
| F5 | HIGH | `availableAt` serves as knowledge gate (`visibleRevision`, `splitAdjustBars`) while also being a storage visibility time. Knowledge and storage are not separable. | §1.3, §1.6 |
| F6 | MEDIUM | The provider delivers no announcement or publication time. Without a new provenance model, no historical knowledge time is provable. | §1.2 |
| F7 | MEDIUM | Quant results do not record which corporate-action derivation was used. Earlier `split_adjusted` runs cannot be told apart from later ones. | §1.7 |
| F8 | LOW | Dividend currency falls back to the instrument currency when the provider omits it. | `twelve-data.ts:395` |
| F9 | (adjacent, not changed here) | `market_bars` has the same first-revision gap as F3, and its `availableAt` is provider-asserted (bar end or retrieval). Bars need the same provenance treatment in a follow-up. | `004_market_data.sql` lines 134-152 |

Status after this branch: F1, F2, F3, F5, F7 resolved (§4). F4 partly: knowledge and retrieval are hashed; storage time is not hashed, but no decision reads it any more. F6: no provider in use supplies a publication time; the paths exist and are tested. F8 and F9 unchanged.

## 3. Target semantics (decided, implemented in this branch)

- **effective time** = `exDate`. Economic adjustment of positions and prices. Independent of knowledge.
- **knowledge time** = `knowledgeAt`, stored only when `knowledgeProvenance` proves it. Never derived from exDate.
- **retrieval time** = `retrievedAt`. NEXUS fact, always recorded.
- **storage visibility** = `available_at` in the database. For new rows equal to `retrieved_at`. Legacy values are kept and are not used for any point-in-time decision.
- **information usability** (strategy, quant and scanner knowledge): `knowledgeAt <= asOf`, with `knowledgeAt` proven by its provenance. `retrievedAt` is not part of this gate (see §4.4 for the reasoning and the open choice).
- **data version at replay** (revisions): a revision is visible at asOf only if its own knowledge is provable and `<= asOf`. A later revision that is not yet known at asOf is invisible, and the previous revision stays the answer.
- **economic reconstruction**: effective split adjustment for accounting. It may use the latest stored revision (ex-post), labelled with its provenance. It is never a point-in-time information source.

## 4. Implementation (this branch)

### 4.1 Model

| time | field | meaning | proven by |
|---|---|---|---|
| economic effective | `exDate` | the local trading date on which positions and prices change | the provider's record; not evidence of knowledge |
| knowledge | `knowledge.knowledgeAt` + `knowledge.provenance` | when the record is provably known | the provenance (below) |
| retrieval | `retrievedAt` | when NEXUS first held this record | NEXUS's capture clock |
| storage visibility | `storedAvailableAt` (DB `available_at`) | when the row was stored | storage only; never read for a decision |

Knowledge provenance (`CorporateActionKnowledgeProvenance`):

- `captured_by_nexus`: `knowledgeAt = retrievedAt`. The only proof the Twelve Data adapter can give: it publishes no announcement or publication time.
- `provider_published_at` / `provider_announced_at`: `knowledgeAt` is the provider's stated time, and `<= retrievedAt`. The announcement form needs `announcedAt == knowledgeAt`. Nothing writes these yet.
- `historical_effective_date_inference`: no knowledge time (`knowledgeAt = null`). Economic reconstruction only.
- `legacy_unproven`: rows stored before provenance existed. No knowledge time (`null`). Economic reconstruction only. Never ingested anew (refused at the ingest boundary).

A knowledge time is never derived from `exDate`. The ingest validation refuses a captured record whose knowledge differs from its retrieval, and any knowledge after its retrieval (`future_timestamp`).

### 4.2 Storage: migration 007 (additive; 004 unchanged)

Columns in `corporate_actions` (not a separate table): `knowledge_provenance TEXT NULL`, `knowledge_at TIMESTAMPTZ NULL`, `provenance_hash CHAR(64) NULL`.

Why the same row: the immutability trigger and the primary key already protect the row; a second table would need its own revision chain, its own immutability and a join on every read. Columns keep one revision = one row.

Constraints (CHECK, plus `NOT VALID` where legacy rows must stay):

- `corporate_actions_knowledge_provenance_values`: the enum.
- `corporate_actions_knowledge_shape`: NULL/NULL, or a proven provenance with a knowledge time `<= retrieved_at`, or an inferred record with no knowledge time.
- `corporate_actions_captured_is_retrieval`: `captured_by_nexus` implies `knowledge_at = retrieved_at`.
- `corporate_actions_provenance_hash_format`.
- `corporate_actions_provenance_required` (`NOT VALID`): new rows must state provenance and carry the hash. Legacy rows are not re-checked.

Function fix: `nexus_corporate_action_revision()` is replaced (the trigger is unchanged, found by name). It now refuses **any** revision with `available_at < retrieved_at`, including the first one (finding F3). The first-revision check of 004 was missing; the database and its comment now agree.

Legacy rows: not rewritten. Their `available_at` (provider `min(retrieved, exDate)`) stays as stored. The read path maps NULL provenance to `legacy_unproven` and never invents a knowledge time. Their `available_at` is not used for information.

### 4.3 Integrity

`provenance_hash` covers `retrievedAt`, the knowledge provenance and the knowledge time (with the content hash and the key). Every read verifies it, so a privileged change of any of them fails closed (`MARKET_DATA_INTEGRITY_ERROR`). The content hash still covers only the economic content: a re-fetch of the same record does not create a revision, and the first capture keeps its knowledge.

The storage time `storedAvailableAt` is not hashed. It is no longer read for any decision, so tampering with it cannot change an answer.

### 4.4 Revisions and information gate

- `selectReplayRevision` (`src/market-data/corporate-actions.ts`), one rule for the in-memory store and PostgreSQL:
  - information: candidates are revisions whose proven knowledge is `<= asOf`, plus unproven revisions NEXUS held by asOf (retrieved `<= asOf`, reported as unproven). The highest revision among candidates wins.
  - economic: the newest stored revision with `ingestSeq <= storedThrough`, ex-post.
- The gate is `knowledgeAt`, not `retrievedAt`. A provider publication time before NEXUS's capture is usable from that time, as the spec's use case B says (`knowledgeAt <= decisionAsOf`). **Open choice:** a live NEXUS could not have held that record before its capture. If the replay must also model NEXUS's own availability, the gate becomes `max(knowledgeAt, retrievedAt)`. That changes only provider-stated records captured after their publication. Twelve Data does not provide such records today, so the choice has no effect on the current data.

### 4.5 `splitAdjustBars`

- Information: an effective split enters only with proven knowledge. An effective split whose knowledge is unproven and which changes a bar of the window returns `status: 'CORPORATE_ACTION_TIMING_UNPROVEN'` with the structured reasons (`unproven`) and no bars. Quant turns that into a typed `CorporateActionTimingError`.
- Economic: applied on its ex-date, listed in `unprovenApplied` when its knowledge is unproven.
- Derived bars: `availableAt = max(bar, knowledge of the splits applied)`, `retrievedAt` likewise. A split not known at asOf is never used, even if a caller passes it.

### 4.6 Impact

- **Quant** (`quant-service.ts`): split-adjusted runs carry `derivation = { 'split-adjust': 'split-adjust:pit:v2' }` in `algorithmVersions` and in the input fingerprint. Raw runs are unchanged (no derivation key). Information refusal is typed.
- **Quant engine** (`quant-engine.ts`): `QuantInput.derivation` is optional; undefined keeps every raw identity.
- **O1 evidence** (`evidence-validation.ts`): a split-adjusted quant run without the current derivation version is blocking `CORPORATE_ACTION_TIMING_UNPROVEN`. Scanner runs have no direct corporate-action input; the candidate's quant run is the one checked, and only when a decision cites that quant run (a scanner-only citation names no candidate).
- **Scanner**: no direct corporate-action input; it consumes quant runs by id. Affected only through the quant check above.
- **Backtest**: no corporate-action input (O2 is out of scope). Bars are passed in; their `availableAt` carries the knowledge of the splits applied. A backtest over RAW bars that span a split is still unadjusted: a pre-existing gap, not changed here.

### 4.7 Twelve Data: before and after

| | before | after |
|---|---|---|
| split 2020-08-31 retrieved 2026-10-07 | `availableAt = 2020-08-31T04:00Z` ("known by ex-date") | `knowledge = captured_by_nexus, knowledgeAt = 2026-10-07T13:57:30Z`; no `availableAt` |
| reverse split announced for 2026-11-20, retrieved 2026-10-07 | `availableAt = 2026-10-07T13:57:30Z` | same capture knowledge; the ex-date is not a knowledge time |
| dividend | same as split | same as split |

### 4.8 Tests

- `test/market-data/corporate-action-provenance.test.ts`: F1 with the real adapter (Monday replay empty, Wednesday sees split); late retrieval Monday/Wednesday; early retrieval Friday with pending to Monday; provider publication time (visible from its time, refused when after retrieval); revisions (revision 2 not visible before its knowledge; storedThrough pins the past; economic is ex-post); no-look-ahead (later correction and later new split leave the series at T unchanged); refusals at ingest (legacy, captured knowledge mismatch, ex-date as knowledge, retrieval after storage).
- `test/market-data/corporate-actions.test.ts`: economic and information adjustment, pending, rounding, derived validity, unproven status for legacy and inferred records, economic application of unproven records, no use of a split not known at asOf.
- `test/quant/quant-engine.test.ts`: derivation version in the run, refusal with `CORPORATE_ACTION_TIMING_UNPROVEN` for inferred knowledge.
- `test/nexus/evidence-validation.test.ts`: derivation version check (current, missing, other version, raw run).
- `test/pg/corporate-action-provenance.pg.test.ts` (PostgreSQL 17.10): F3 first-revision trigger; NOT VALID provenance requirement for new rows; captured knowledge equal to retrieval; roundtrip across a fresh process (knowledge, provenance hash, revisions, replay); publication time gate; privileged change of knowledge detected on read; migration 007 on existing rows (legacy not rewritten, `legacy_unproven`, no invented knowledge, information refused with reason, economic labelled).

### 4.9 Remaining limitations

1. `market_bars` has the same first-revision gap as F3 (F9) and a provider-asserted `availableAt`. Not changed here; same treatment needed in a follow-up.
2. Legacy rows cannot be proven. Information on them is refused whenever they change a window; they are not repaired.
3. A replay before a late capture shows the raw series as NEXUS held it, with the discontinuity, and the run is not refused for it: at asOf NEXUS had no record of the split. That is the honest knowledge state. A quality warning on such runs would be a useful addition; it is not implemented.
4. No provider currently delivers `provider_published_at` or `provider_announced_at`. The paths are implemented and tested, but unused.
5. `announcedAt` is parsed nowhere in the adapter.
6. Dividend currency falls back to the instrument currency when the provider omits it (F8, unchanged).
7. The gate is `knowledgeAt` (see 4.4). The stricter `max(knowledgeAt, retrievedAt)` is an open choice.
8. O2 (backtest with corporate actions, position split logic, dividend ledger) is not implemented.
