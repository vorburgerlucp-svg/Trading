# R1: Shadow Research MVP (isolated market data collector)

Status: **implemented and tested on a development branch. Not activated.**
- No research database exists.
- No task is registered.
- No provider request has been made.
- No data clearance has been given.

## 1. What R1 is

R1 is a separate, small NEXUS process that collects **completed 15-minute bars** of a few catalog instruments from Twelve Data. It stores them through the existing `MarketDataService` and PostgreSQL market data store, with validation, revisions, quarantine, and knowledge and vintage labels. It records every run in a versioned, hash-chained run protocol.

R1 does **not** contain any of the following:
- a strategy;
- a model call;
- an outcome evaluation;
- a quote or bid/ask collection (Twelve Data `/quote` carries no bid/ask);
- a broker connection or an order function;
- an HTTP server.

## 2. Modules (`src/research/`)

| Module | Responsibility |
|---|---|
| `research-main.ts` | Entry point: **one bounded run, then exit**. Reads only `.env.research`. Has a hard stop after the deadline plus 20 s |
| `research-config.ts` | Environment, read once. Refuses broker, trading, operator and production variables; any other database or role; limits above the plan; the demo key |
| `research-catalog.ts` | Versioned instrument catalog (`research-catalog:v1`, at most 10 instruments, interval `15m` only), validated strictly and fingerprinted |
| `research-worker.ts` | One run: memory gate, lock, abandoned runs, clearance gate, catalog = registry, then per instrument a bounded fetch of the missing completed bars |
| `final-bars-provider.ts` | Research view of the provider. Final bars only, so in-progress bars are dropped and counted. Quotes and searches are refused |
| `research-budget.ts` | Credit budget (day and rolling minute) and the **guarded fetch**: only `https://api.twelvedata.com/time_series`, and a credit is reserved in the protocol **before** the request |
| `research-lock.ts` | PostgreSQL session advisory lock: one worker. It is released automatically when the connection or process dies |
| `research-run-log.ts` | Run protocol `research-run:v1`, one append-only log per UTC day (`research-runs-v1.YYYY-MM-DD`) |
| `research-status.ts`, `research-status-cli.ts` | Read-only status: runs, credits, coverage and gaps per instrument |
| `research-postgres.ts` | Research pool (`statement_timeout`, optionally `default_transaction_read_only`), identity and schema check on the open connection, stores |
| `research-migrate.ts` | Applies the repository migrations to `nexus_research` only |

## 3. Isolation (proved by `test/research/research-isolation.test.ts`)

**Import graph.** The complete import graph of every research entry point is followed from the source text, including `export … from`, `import type` and dynamic `import()`.
- **Executed code** may come only from `src/research`, `src/market-data`, `src/persistence`, `src/money`, plus one leaf error class (`src/capital/ledger-errors.ts`, which must have no import).
- **Not even a type** may come from `src/broker`, `src/runtime`, `src/nexus` (build locks), `src/ai`, `src/safety`, `src/evaluation`, `src/inventory`, the rest of `src/capital`, or any path containing `execution` or `etoro`.
- **External modules:** only `pg` and a short list of Node built-ins. That list excludes `child_process`, `worker_threads` and `cluster`.

**`research:status`.** Its graph contains neither the worker, the budget, the lock, the migration step, the `MarketDataService` nor the Twelve Data provider. It opens a `default_transaction_read_only` session and read-only stores, so PostgreSQL itself refuses every write (PostgreSQL test).

**Configuration.** The process refuses to start if any of these is set:
- `ETORO_*`;
- any variable containing `BROKER`;
- `NEXUS_OPERATOR_*`;
- `TRADING_MODE`, `ALLOW_LIVE_TRADING`;
- `DATABASE_URL` (the productive database);
- `NEXUS_TWELVE_DATA_DEMO`.

Only the names are reported, never the values.

**Database identity.** The database must be `nexus_research` (or `nexus_research_<suffix>` for a restore test), and the role a `nexus_research…` role. `postgres`, `nexus_app` and `nexus_readonly` are refused.

The check runs twice: on the URL, and again on the open connection (`current_database()`, `current_user`). The worker also refuses a schema that is not exactly the repository's migrations.

**Build locks.** Unchanged and closed. The isolation test asserts all four.

## 4. Data semantics

- **Completed bars only.** A bar is requested only after it is complete. For a bar start `s`, that means the session calendar's bar end plus the provider's 60-second settlement delay. The `to` bound excludes the forming bar. An in-progress bar returned anyway is never stored.
- **Point in time, unchanged from the market data layer.**
  - `observedAt`: market completion.
  - `availableAt`: replay gate.
  - `retrievedAt` = `knowledge.knownAt`: NEXUS's capture.
  - `vintage`: `contemporaneous` only for a fetch within 15 minutes of completion; otherwise `historical_reconstruction`.
- **Backfill is never a live observation.** A catch-up after a gap stays labelled `historical_reconstruction` (tested). In a `decision_time` replay a bar is visible only from the moment NEXUS held it (tested).
- **Raw prices** (`adjustment: raw`). An adjusted series would change retroactively at every split.
- **Gaps.** Catch-up is limited (`NEXUS_RESEARCH_MAX_CATCH_UP_HOURS`, default 24). The time before it stays a recorded gap (`gapBefore`), and `research:status` lists missing expected bars of the last 24 hours.
- **Invalid provider rows** are quarantined by the existing store (tested).

## 5. Run protocol, budget, lock, crash

**Run protocol records:**
- `run_started` (code version, catalog fingerprint, settings fingerprint, clearance reference);
- `credit_reserved` (**before** each request);
- `run_finished` (status and per-instrument counts);
- `run_skipped` (`LOCK_HELD`, `LOW_MEMORY`);
- `run_abandoned` (written by the next run that holds the lock).

**Statuses:** `completed`, `deadline_reached`, `budget_exhausted`, `license_not_cleared`, `catalog_mismatch`, `failed`.

**Credit budget.**
- Defaults: 400 credits per UTC day (the plan has 800) and 6 per rolling minute (the plan has 8). The configuration refuses values above the plan.
- A reserved credit counts whether or not its request succeeded, also for a run that crashed.
- The minute budget waits only if that fits before the deadline; otherwise it refuses.
- The limits are checked again **inside the log's critical section** (append precondition), so two writers can never both take the last credit, even without the worker lock. This was tested with three separate Node.js processes.

**Run ids.** Random. A reused id makes the run fail before any request.

**Lock.** One PostgreSQL session advisory lock (key `0x4e585253, 1`). A second process is skipped (`LOCK_HELD`, exit code 0). A killed process loses its connection and with it the lock (tested with a hard-killed process).

**Idempotency.** A repeated run requests nothing that is stored and creates no duplicate bar rows or protocol records (tested on PostgreSQL). After a crash, the next run records the dead run as abandoned and continues from the stored data.

**Resources.**
- Free memory below `NEXUS_RESEARCH_MIN_FREE_MEMORY_MB` (default 2048) skips the run before the lock.
- Run deadline: `NEXUS_RESEARCH_MAX_RUN_SECONDS`, default 240, plus a hard process stop 20 s later.
- `--max-old-space-size=512`, pool of at most 3 connections, `statement_timeout` 60 s, no background process.

**Exit codes:**
- 0: completed, or skipped because another worker runs;
- 2: needs attention (budget, deadline, clearance, catalog, low memory);
- 1: failure.

## 6. Twelve Data terms (checked 2026-10-25; not legal advice)

**Source:** <https://twelvedata.com/terms>, "Last Updated: January 1, 2026" (read through a web summary, quotes as returned).

- **Internal use only.** The license is granted "solely for Internal Use" (2.1). "Use Free Tier data for commercial purposes" is prohibited (2.3(l)).
- **Storage limit, not specified.** It is prohibited to "store or cache Data beyond permitted timeframes specified in the Documentation" (2.3(g)). Data may be retained "for duration permitted by subscription" and "subject to any Third-Party Provider restrictions" (16.1). **The public API documentation states no such timeframe:** the part that was read only recommends caching. **Whether long-term storage on the Basic plan is permitted is therefore not confirmed.**
- **Deletion on termination.** All data must be deleted within 30 days; certification may be requested (16.2, 12.5).
- **Derived data.** It may be created if it cannot be reverse-engineered into the original data (2.2(c)).
- **No redistribution** without an add-on (2.2(e), 2.3(b)).
- **Third-party rights.** Exchanges and other providers have their own rights and enforcement (3.1, 3.2(f), 14.11).
- **Limits.** The Basic plan has 800 API credits per day and 8 per minute; `/time_series` costs 1 credit per symbol ([support article](https://support.twelvedata.com/en/articles/5194820-api-credits-limits)).

**Consequence in code.** Without `NEXUS_RESEARCH_DATA_CLEARANCE`, R1 fetches and stores **nothing** (`license_not_cleared`, tested).

**Recommendation.** Ask Twelve Data in writing whether private, non-commercial research storage of 15-minute bars for a few symbols is permitted, and for how long, on the Basic plan (or which plan permits it). Record the answer and the owner decision as the clearance reference.

Deletion stays possible despite the append-only tables (whose triggers reject `DELETE`): research data lives in its own database, which can be dropped as a whole, backups included.

## 7. Setting up `nexus_research` (NOT done; each step needs approval)

1. As `postgres` in `postgres`, run `ops/research/db/1-roles-and-database.sql`. It creates the roles `nexus_research_app` (owner) and `nexus_research_readonly` (read-only sessions), and the database from `template0`.
   - Nobody else may connect to the new database.
   - The research roles may not connect to `nexus`.
   - No password is set by the script.
2. Set the passwords interactively (`\password nexus_research_app`, `\password nexus_research_readonly`).
3. As `postgres` in `nexus_research`, run `ops/research/db/2-schema-privileges.sql`. It refuses to run in any other database.
4. With `.env.research` holding the owner URL, run `npm run build`, then `npm run research:migrate`. This applies migrations 001–013, the same files and checksums as the productive database.
   - The tables of the ledger, audit and similar areas exist but stay empty; R1 uses `instruments`, the market data tables and `append_only_logs/records`.
   - The research instance never migrates by itself.
5. Run `ops/research/db/3-verify.sql`. Every row must be `true`.
6. **Backup:** daily `pg_dump -Fc nexus_research` into a folder on another disk.
   - Weekly, restore it as `nexus_research_restore` (accepted by the identity check).
   - Then verify it read-only with `npm run research:status` against the restored database. Opening the logs verifies their hash chains.

The O22 database and its evidence are never touched by any of these steps.

## 8. A controlled one-time test run (later, after approval)

**Preconditions:**
- the database is set up (section 7);
- the clearance is decided and recorded;
- the research checkout is a reviewed tag;
- `.env.research` has no other variables;
- at least 2 GB of RAM are free.

**Steps:**
1. `npm run research:status`: read-only; shows no runs.
2. Use a catalog with **one** instrument (for example BTC/USD) and `NEXUS_RESEARCH_DAILY_CREDIT_LIMIT=5`.
3. `npm run research:run` once, manually. Expected: `completed`, 1–2 credits.
4. `npm run research:status`: the run, its credits, stored bars and their vintages.
5. Run `npm run research:run` a second time immediately. Expected: `up_to_date`, 0 credits (idempotency).

## 9. Before the automatic 15-minute operation (later, after approval)

1. Run the one-time test (section 8) successfully on at least two different days.
2. Decide the catalog (the example has 6 instruments, about 300 credits per day, about 40 % of the plan).
3. Review `ops/research/nexus-research-task.draft.xml` and `run-research.ps1`:
   - the task starts at :02, :17, :32, :47;
   - `IgnoreNew`, at most 6 minutes;
   - below-normal priority, no wake-up, no catch-up burst, not on battery.
4. Register the task (`schtasks /Create /XML … /TN "\NEXUS\NEXUS Research R1"`). Enabling it is a separate decision.
5. Watch for one week: daily `research:status`; acceptance needs few abandoned runs and documented gaps (PC sleep, updates). Run a restore test.

## 10. Tests

| File | What |
|---|---|
| `test/research/research-isolation.test.ts` | Import graphs of all research entry points; status cannot fetch or write; build locks closed |
| `test/research/research-worker.test.ts` | Completed bars only; vintage labels; decision-time replay; idempotent repetition; session awareness; gaps; quarantine; clearance gate; memory gate; lock held; catalog mismatch; day and minute budget (also across runs and crashes); deadline; provider failures; crash and restart; a lost request with an unknown result; stale or empty answers; unavailable database; reused run id; guarded fetch (origin, path, reservation before the request) |
| `test/research/research-config-catalog.test.ts` | Configuration refusals (names only, never values); database and role guard; limits; catalog validation; final-bar filter; status summary; exit codes; operations drafts |
| `test/pg/research-worker.pg.test.ts` | Two pools: lock, lock lost with its session, idempotency in the database, crash and restart, atomic budget, read-only status, identity and schema check, instrument projection |
| `test/pg/research-processes.pg.test.ts` | **Separate Node.js processes:** lock across processes, hard kill during a request, budget across three processes |

Regular tests make no network request: the provider is a scripted transport.

## 11. Not in R1 (next steps)

- **R2:** versioned outcome evaluation on sealed trade plans, plus quarantine of unvalidated learning scores. Separate PR.
- **R3:** reference strategy and hypothetical signals (`research-signals`, `research-outcomes`).
- **Bid/ask:** a separate provider with measured quotes (R4). Twelve Data delivers none.
