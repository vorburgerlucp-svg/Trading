# Migration history: committed migrations are immutable

Status: in force from 2026-10-09 (branch `feature/bar-knowledge-schema-repair`).

## Rules

1. **A committed migration is never edited, renamed, reordered or deleted.** A change of meaning is made by a new migration.
2. **A later migration is additive.** It adds columns, adds constraints (`NOT VALID` where existing rows must not be checked), and may replace a trigger function with `CREATE OR REPLACE`. It never drops or repurposes a column, a constraint or a trigger. The migrator enforces this (`assertNonDestructive` in `src/persistence/postgres/migrator.ts`): it refuses `DROP`, `TRUNCATE`, `DELETE FROM`, top-level `UPDATE … SET`, and destructive `ALTER TABLE` forms.
3. **Every database records the checksum of each migration it applies** (SHA-256 of the LF-normalised SQL). `verifyApplied` refuses to run when a recorded checksum differs from the file. This is fail closed on purpose.
4. **A migration committed in one form and rewritten in another breaks every database that applied the first form.** Repairing history means restoring the committed bytes, and expressing the new meaning in a later migration. The repair below did exactly that.
5. **Every checksum is pinned by a test** (`test/persistence/migration-immutability.test.ts`). The released 008 is kept as a fixture (`test/fixtures/migrations/008_market_bar_provenance.de4c3f4.sql`), and the upgrade test (`test/pg/schema-history.pg.test.ts`, test A) proves that a database which applied it upgrades through 009 without modification.

## History

| Version | Name | Status | SHA-256 checksum |
|---|---|---|---|
| 001 | `ledger` | committed, unchanged | `a314422d97c9eea5363b505e9541799bd10098d013c446307032079ccde3e8a1` |
| 002 | `append_only_logs` | committed, unchanged | `f0cb8d654368137ad910219403d4cea8bf6c25b0a69b703294764de42518e2db` |
| 003 | `domain_projections` | committed, unchanged | `0c7880adb6d870994f66be82371860c472828780a4c1e2e420ce1a49ceff7da6` |
| 004 | `market_data` | committed, unchanged | `c1f6859e4a6f6cd0169a83a01ba614a6f9e33ad96d4ab9cd56e22e6165a126b3` |
| 005 | `scanner_backtest_core` | committed, unchanged | `f4b702e97fb0a97c4aca35b7cad324804270923c4e2dafe876dccbe473c1c18d` |
| 006 | `evidence_seals` | committed, unchanged | `760a9c2745721a67c7f62fe939bf303d0aa8ebef0bf5aca90befbfabf2ada899` |
| 007 | `corporate_action_provenance` | committed, unchanged | `56d5af140de5c52215834b1d3551e41636c310b8800259fdd7a1d5ddad0a9021` |
| 008 | `market_bar_provenance` | committed in `de4c3f4`; **restored byte-for-byte** | `c8f14c983ead6a38fa14f08f298b3d228690603475e78084c8378a607f36861e` |
| 009 | `market_bar_knowledge_v2` | new, additive | `b2812e5e40906c397d914cac6af646d48f89154f8b3356fc2672bd8805cdf5ec` |
| 010 | `pit_universe_v1` | new, additive (PIT Universe V1, `universe-engine:v1`) | `3791efaed495bc77516a04fd33f5c460f62b0a3a34a93e813190aa42d30fe18a` |

Git blob of the restored 008: `9e5dbc28d4508a83e2e7534706ae6112867ec8df` (equal to the blob of `de4c3f4:db/migrations/008_market_bar_provenance.sql`).

## The repair (2026-10-09)

- `de4c3f4` committed 008 with the market-bar provenance model (`knowledge_provenance`, `revision_known_at`, `provenance_hash`).
- `ce4a919` rewrote that file in place to a different model. Databases that applied the `de4c3f4` 008 would fail the checksum check, so the rewrite was not acceptable.
- This repair restores 008 from `de4c3f4` byte-for-byte, and adds the knowledge/vintage model as migration 009. The 008 columns keep their meaning; 009 adds separate V2 columns (see `docs/BAR_KNOWLEDGE_EVIDENCE.md` §10).
- Databases that applied the `ce4a919` variant of 008 cannot be upgraded: their recorded checksum is that of a file that no longer exists. They must be recreated. Editing `schema_migrations` by hand is not a supported repair.

## Migration 010: the persistent Point-in-Time Universe (2026-10-09)

Additive only. It creates five tables and does not alter any table of 001–009: `universe_sources`, `universe_definitions`,
`universe_snapshot_revisions`, `universe_snapshot_members`, `universe_unresolved_members`. Each table is append-only: UPDATE, DELETE and
TRUNCATE are rejected by the trigger `nexus_reject_mutation()` from 001. The database also checks the revision order, the knowledge order,
the ingest sequence, the member count at commit, and that unresolved members appear only in a PARTIAL revision. Identity hashes are
recomputed and verified by the application on every read (`docs/PIT_UNIVERSE_V1.md`).

Migration 010 does not change the meaning of any earlier migration, and the migrator still refuses destructive statements in it.

## Verification

- `npm run check`: typecheck and the unit and PostgreSQL projects (PostgreSQL 17 is started by the test global setup, and every test database is built from the migration files).
- Test A (`schema-history.pg.test.ts`): a database that applied 001–007, a pre-provenance row, then the released 008 (`de4c3f4` bytes), then rows written under the released rule; the current migrator applies 009; 008's checksum still matches, the old rows are unchanged, their hashes verify, decision-time replay refuses them, and new revisions use the V2 model.
- Test B: a fresh database runs 001–009 and every path works.
- The golden hashes in `test/persistence/bar-compat.test.ts` were computed by the released code (`barProvenanceHash` of `de4c3f4`), not by the current code.
