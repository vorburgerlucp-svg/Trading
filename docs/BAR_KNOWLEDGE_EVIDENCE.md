# Bar Knowledge and Evidence Integration — 2026-10-09

Status: decisions and inventory written before any change. Base `de4c3f4db8042acda620b566b15073d06e632ee0`.
Branch: `feature/bar-knowledge-evidence-integration`. Not merged.
Supersedes, in part, `docs/MARKET_BAR_PROVENANCE.md` (F9): the single flag `historical_bar_reconstruction` is split into two questions.

## 1. The semantic conflict (reproduced)

The previous model answered two different questions with one label, `historical_bar_reconstruction`:

1. Is the exact market-time vintage proven? (No, for a backfill.)
2. Is the bar usable as strict decision-time knowledge? (Also no, because `revisionKnownAt = null`.)

Example: a daily bar of 2020-01-10 21:00 is first retrieved on 2026-10-09 12:00. A live decision at 12:30 on that day knows the value since 12:00. The old model refused it (`revisionKnownAt = null`), although NEXUS did hold this exact received value from 12:00. A replay in 2020 must not see it, and the old model could not tell those two cases apart.

Reproduced: `test/market-data/bar-knowledge.test.ts` scenario "same backfill known after retrievedAt", red on `de4c3f4`: a decision at 12:30 on the retrieval day returns no bar.

## 2. Model: two independent questions

| Question | Field | Values |
|---|---|---|
| Did NEXUS hold exactly this revision at asOf? (decision-time knowledge) | `knownAt`, `knowledgeSource` | `knownAt` is the instant NEXUS held it; `knowledgeSource`: `captured_by_nexus` (NEXUS received the provider response; `knownAt = retrievedAt`), `provider_published_at` (the provider states a publication time, `knownAt <= retrievedAt`), `legacy_unproven` (no knowledge time; `knownAt = null`) |
| Was this revision already the market's value at its observation time? (vintage) | `vintage`, `vintagePolicy` | `contemporaneous` (proven by the vintage policy or the provider's publish time), `historical_reconstruction` (not proven), `legacy_unproven` |

Derived, never stored independently:

- `decisionTimeKnowledgeProven(bar, asOf)`: source is not legacy and `knownAt <= asOf`.
- `contemporaneousVintageProven(bar)`: `vintage === 'contemporaneous'`.

The two questions never share a boolean.

## 3. Capture window: a versioned vintage policy only

`BAR_VINTAGE_POLICY_VERSION = 'bar-vintage:v1'`. Its window (`{ intraday: 15 min, daily: 2 h }`) decides only `vintage`:

- final bar with `retrievedAt - observedAt <= window` (boundary inclusive): `vintage = contemporaneous`;
- in-progress bar: `contemporaneous`;
- otherwise: `historical_reconstruction`.

The window never decides `knownAt`. `knownAt = retrievedAt` for every bar NEXUS received, including backfills. The policy version is stored per bar and included in the bar provenance hash and in the quant input fingerprint.

## 4. Replay modes (renamed)

- `historical_research`: bars are visible by their market gate (`availableAt`, with the revision floor below). Bars that NEXUS held only later are used, and the result says so (`decisionTimeKnowledgeProven = false`). Research is allowed to use reconstructions.
- `decision_time`: a bar is usable only if `knownAt <= asOf`. A bar NEXUS did not yet hold is absent (not an error: that is the honest knowledge state). A legacy visible revision throws `BAR_KNOWLEDGE_NOT_PROVEN` (fail closed). Vintage is not required here.

Revision floor (unchanged protection): a revision >= 2 is visible by its market gate only from `knownAt` (or `retrievedAt`). A correction is therefore never visible before NEXUS held it, in either mode.

## 5. Quant result

```
barDataProvenance {
  decisionTimeKnowledgeProven: boolean   // every input bar: proven source, knownAt <= asOf
  allBarsContemporaneousVintage: boolean
  historicalReconstruction: boolean
  legacyUnproven: boolean
  latestFinalBarContemporaneous: boolean // the signal bar (see 6)
  barCount, knownBars, contemporaneousBars, historicalBars, legacyBars
}
```

No probabilities. `QUANT_ENGINE_VERSION = quant-engine:v3`. The input fingerprint includes `observedAt`, `availableAt`, `retrievedAt`, `knownAt`, `knowledgeSource`, `vintage` and `vintagePolicy` per bar.

## 6. Live scanner: which bars must be proven

A live decision (`definition.useCase = live_trading`, the default) is accepted when:

- every used bar was known at the decision asOf (`decisionTimeKnowledgeProven`);
- the data is fresh, from a production source, and passes calendar and data-quality checks;
- the latest signal bar is contemporaneous (`latestFinalBarContemporaneous`).

The signal bar is exactly one bar: the last final bar at or before asOf. The decision reads its close and the indicators computed up to it, and the trade trigger is a comparison against that close. It must be what the market showed then. Warm-up bars enter as history. Their vintage uncertainty stays visible in `allBarsContemporaneousVintage` and `historicalBars`, but it does not block the decision.

## 7. Backtest

`BacktestInput.replay` (default `historical_research`):

- research timing: a bar is used at its market gate;
- decision timing: a bar is used at `max(gate, knownAt)`, so the engine never acts before NEXUS held the bar.

`dataProvenance`:

- `LEGACY_UNPROVEN`: any legacy bar;
- `STRICT_PIT_DATA`: every bar was known at its simulated use time AND has contemporaneous vintage. The first condition is the necessary one from the specification. The vintage condition is added because a backtest's simulated timeline is market history: a backfill replayed at retrieval time is not a simulation of that history;
- `HISTORICAL_RECONSTRUCTION`: otherwise.

Grade caps: STRICT none, HISTORICAL at most B, LEGACY at most C. The return never enters.

## 8. O1 evidence

- Lineage (`EVIDENCE_LINEAGE_VERSION = evidence-lineage:v3`) carries the quant `barKnowledge` block and, for scanner candidates, the candidate's `barKnowledge` block.
- Quant evidence with `decisionTimeKnowledgeProven = false` (including runs that predate this model): blocking `BAR_KNOWLEDGE_NOT_PROVEN`.
- Quant evidence with `allBarsContemporaneousVintage = false` but knowledge proven: admissible, warning `BAR_VINTAGE_NOT_CONTEMPORANEOUS`. Never reported as contemporaneous vintage.
- Live scanner candidate with `decisionTimeKnowledgeProven = false`: blocking. A research scanner: warning `SCANNER_RESEARCH_EVIDENCE`, and the lineage shows its flags.
- Backtest evidence is strong only if `grade = A`, the sample is sufficient and `dataProvenance = STRICT_PIT_DATA`. Otherwise weak (`BACKTEST_WEAK_EVIDENCE`). Runs without `dataProvenance` are weak.

## 9. Versions and old runs

| Artefact | Version |
|---|---|
| Bar vintage policy | `bar-vintage:v1` |
| Quant engine | `quant-engine:v3` |
| Market scanner | `market-scanner:v3` |
| Backtest engine | `backtest-engine:v4` |
| Evidence lineage | `evidence-lineage:v3` |

Old stored runs are not rewritten. Any run without the new fields is treated as unproven by O1 (fail closed), never interpreted as new evidence.

## 10. Storage: migration 008 is rewritten, not 009

`008_market_bar_provenance` was created on the unreleased branch `feature/market-bar-provenance` and has not been applied to any environment outside the test databases, which are rebuilt on every run. Its content is rewritten in place to the model above.

Reason: the migrator refuses `ALTER TABLE ... DROP` (`ALTER_DROP`). The old constraints (`knowledge_shape`, `captured_is_retrieval`, the trigger function) must be replaced, and a later migration cannot remove them. Keeping them would forbid the new combinations.

Consequence: any database that applied the `de4c3f4` version of 008 fails the checksum verification and must be recreated. This is fail closed by design. The decision needs your confirmation before this branch is merged.

## 11. Unchanged in this branch

- Quotes (F10): not touched. The change does not alter the quote path.
- Corporate actions: unchanged.
- O2 (position split accounting, dividends): not implemented.
- Live Trading LOCKED, Physical Purchase LOCKED, AI providers NOT CONNECTED.

## 12. Open items (documented, not built)

1. Identical-content re-fetch (`historical reconstruction first, same content later`): the content hash excludes provenance, so identical content stays "unchanged" and keeps its first label. A separate knowledge event for the same content would need its own table (an append-only knowledge log keyed by bar identity and content hash). It is not built in this branch: it would be a larger schema change.
2. Whether a live decision may rely on a warm-up bar whose only proof is "known since retrieval": the model says yes, by 6. Confirm before any real money is involved.
3. The capture-window values remain a policy choice for the owner to confirm.

## 13. Implementation status

Implemented on `feature/bar-knowledge-evidence-integration`. `npm run check`: typecheck clean, 46 of 46 files, 541 of 541 tests, PostgreSQL 17.10 ran.

### 13.1 Where the model lives

| Concern | Module |
|---|---|
| Two questions and replay modes | `src/market-data/market-data-types.ts`, `src/market-data/bar-replay.ts` |
| Vintage policy (`BAR_VINTAGE_POLICY_VERSION = bar-vintage:v1`) | `src/market-data/bar-vintage.ts` |
| Ingest and read validation, provenance hash | `src/market-data/bar-validation.ts` |
| In-memory store (both modes) | `src/market-data/market-data-store.ts` |
| PostgreSQL store (both modes, same rule) | `src/persistence/postgres/postgres-market-data-store.ts` |
| Schema (rewritten in place) | `db/migrations/008_market_bar_provenance.sql` |
| Twelve Data: knowledge = retrieval, vintage = policy | `src/market-data/providers/twelve-data.ts` |
| Data quality: decision-time knowledge and signal-bar vintage | `src/market-data/data-quality.ts` |
| Quant result, fingerprint, replay mode | `src/quant/quant-engine.ts`, `quant-types.ts`, `quant-service.ts` |
| Scanner: live trading versus research, candidate knowledge | `src/scanner/market-scanner.ts`, `scanner-types.ts` |
| Backtest: timing by mode, quality by knowledge at use and vintage | `src/backtest/backtest-engine.ts`, `quality.ts`, `point-in-time.ts`, `backtest-types.ts` |
| O1 evidence lineage and knowledge gate | `src/nexus/evidence-validation.ts` |

### 13.2 Deviations from the brief, and why

1. **Derived booleans are not stored.** `decisionTimeKnowledgeProven` and `contemporaneousVintageProven` are derived from `knownAt`/`knowledgeSource` and `vintage`. Storing them next to their source would allow them to disagree.
2. **Mode names.** `historical_research` and `decision_time` replace `historical_reconstruction` and `strict_point_in_time`, which described the data rather than the question.
3. **Backtest STRICT_PIT_DATA needs two conditions**, not one: known at the simulated use time (necessary by the specification) and contemporaneous vintage. A simulated timeline is market history. Replaying a backfill at its retrieval time simulates a different market, so it is not strict.
4. **Derived bars with unproven inputs** (split adjustment with an unproven split) carry `legacy_unproven` with no time and no vintage. They make no claim.
5. **Final-bar knowledge tolerates five minutes of retrieval clock skew**, in the application and in the database, the same tolerance the other retrieval checks use.
6. **Scanner default.** A scanner definition without `useCase` is a live scanner. Research must be requested.
7. **Migration 008 is rewritten in place** (section 10). This is the one decision that needs your confirmation before the branch is merged.

### 13.3 The signal bar

Exactly one bar: the last final bar at or before asOf. The decision reads its close and the indicators computed up to it. Its vintage must be contemporaneous for a live candidate (`latest_bar_vintage_not_proven` / `latest signal bar is not contemporaneous`). Warm-up history is not required to be contemporaneous. Its uncertainty is visible in `allBarsContemporaneousVintage` and `historicalBars`.

With the 2 h window, a daily bar completed at 20:00 UTC and retrieved at 22:01 is a historical reconstruction (two minutes beyond the window). A live decision then degrades to research. The tests cover the boundary (22:00 contemporaneous, 22:01 not) and the degraded live refusal.

### 13.4 Versions

| Artefact | Version |
|---|---|
| Bar vintage policy | `bar-vintage:v1` |
| Quant engine | `quant-engine:v3` |
| Market scanner | `market-scanner:v3` |
| Backtest engine | `backtest-engine:v4` |
| Evidence lineage | `evidence-lineage:v3` |

Old runs are not rewritten. A quant run without `barDataProvenance`, a scanner candidate without `barKnowledge`, or a backtest without `dataProvenance` is treated as unproven by O1 (blocking for quant and live candidates, weak for backtests).

### 13.5 Test map

| Mandatory test | Where |
|---|---|
| Old backfill unknown before retrievedAt; known after it | `bar-knowledge.test.ts` A |
| Historical vintage remains unproven | A (`historical vintage stays unproven`) |
| Contemporary capture | B |
| Capture-window boundary exactly equal | B (in memory), G (real adapter, daily and 5 min) |
| Strict historical replay rejects future retrieval | C |
| Historical research accepts reconstruction | C |
| Live scanner: reconstructed warm-up and live signal bar | D (EMA200 computed, candidate flags) |
| Live scanner: reconstructed signal bar refused; research accepts | D |
| Quant fingerprint changes with provenance and policy | E |
| No look-ahead | E (corrections, bars known later, research visibility) |
| Legacy: no invented knowledge, fail closed | F, PostgreSQL legacy migration test |
| Twelve Data policy | G |
| Data quality and backtest grading | H, I |
| O1 lineage carries provenance; blocks knowledge-not-proven; does not claim reconstruction as strict vintage | `evidence-validation.test.ts`, O1 block |
| Strong backtest evidence respects dataProvenance | `evidence-validation.test.ts`, O1 block |
| PostgreSQL roundtrip, combinations, tampering | `bar-knowledge.pg.test.ts` |

### 13.6 Remaining limitations

1. Identical-content re-fetch (section 12, item 1): not built. A separate knowledge log would be a larger schema change.
2. The capture-window values remain a policy choice (section 12, item 3).
3. The store keeps no separate knowledge log. A revision's knowledge is the `knownAt` of that revision's row.
4. F10 (quotes): open, unchanged.
5. O2 (position split accounting, dividends): not implemented.
6. A V1 backtest still grades at most C, because corporate actions are not modelled (pre-existing).
7. Live Trading LOCKED, Physical Purchase LOCKED, AI providers NOT CONNECTED.
