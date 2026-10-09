# Corporate Action Provenance (point-in-time) — 2026-10-09

Status: inventory written before any change (base `fe2554277c547bd254c59008667390f5ef07fced`).
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

## 3. Target semantics (decided, implemented in this branch)

- **effective time** = `exDate`. Economic adjustment of positions and prices. Independent of knowledge.
- **knowledge time** = `knowledgeAt`, stored only when `knowledgeProvenance` proves it. Never derived from exDate.
- **retrieval time** = `retrievedAt`. NEXUS fact, always recorded.
- **storage visibility** = `available_at` in the database. For new rows equal to `retrieved_at`. Legacy values are kept and are not used for any point-in-time decision.
- **information usability** (strategy, quant and scanner knowledge): `knowledgeAt <= asOf` **and** `retrievedAt <= asOf`, with `knowledgeAt` proven. The later of the two is the usable time.
- **data version at replay** (revisions): visible at asOf only when usable at asOf. A revision NEXUS has not yet retrieved or cannot prove is invisible.
- **economic reconstruction**: effective split adjustment for accounting. It may use the latest revision (ex-post), labelled as such. It is never a point-in-time information source.
