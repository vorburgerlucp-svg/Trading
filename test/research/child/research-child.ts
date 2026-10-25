// TEST ONLY: one research process for the R1 multi-process tests (test/pg/research-processes.pg.test.ts). It is a separate
// Node.js process with its own PostgreSQL connections; it uses the scripted provider (no network) and prints one JSON line.
//   run      one worker run (R1_CHILD_BLOCK=1: inside the first request, signal "inside-<name>" and wait for "open")
//   reserve  wait for "go", then reserve one credit with a daily budget of 1, without the worker lock
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool } from '../../../src/persistence/postgres/pool.js';
import { AppendOnlyLog } from '../../../src/persistence/append-only-log.js';
import { PostgresAppendOnlyStore } from '../../../src/persistence/postgres/postgres-append-only-store.js';
import { CreditBudget, ResearchBudgetError } from '../../../src/research/research-budget.js';
import { PostgresWorkerLock } from '../../../src/research/research-lock.js';
import { openResearchStores } from '../../../src/research/research-postgres.js';
import { researchRunLogName, type ResearchRunRecord } from '../../../src/research/research-run-log.js';
import { BTC_ENTRY, FakeClock, ScriptedTwelveData, catalogOf, harness } from '../research-fixtures.js';

const NOW = '2026-10-07T15:31:30Z';
const mode = process.argv[2];
const name = process.env.R1_CHILD_NAME ?? 'child';
const dir = process.env.R1_CHILD_DIR!;
const pool = createPool({ ...JSON.parse(process.env.R1_CHILD_PG!), max: 3, applicationName: 'nexus-research-child-' + name });

async function waitFor(file: string): Promise<void> {
  while (!existsSync(join(dir, file))) await new Promise((resolve) => setTimeout(resolve, 25));
}

async function main(): Promise<unknown> {
  if (mode === 'run') {
    const stores = await openResearchStores(pool);
    const transport = new ScriptedTwelveData();
    if (process.env.R1_CHILD_BLOCK === '1') {
      transport.beforeAnswer = async () => {
        writeFileSync(join(dir, 'inside-' + name), String(process.pid));
        await waitFor('open');
      };
    }
    const h = harness({ runIdPrefix: 'p' + process.pid, stores, lock: new PostgresWorkerLock(pool), transport, catalog: catalogOf([BTC_ENTRY]), clock: new FakeClock(NOW), settings: { budget: { dailyCredits: Number(process.env.R1_CHILD_DAILY ?? 400), minuteCredits: 6 } } });
    const out = await h.run();
    return { pid: process.pid, out, calls: transport.calls.length };
  }
  if (mode === 'reserve') {
    const clock = new FakeClock(NOW);
    const logName = researchRunLogName(clock.ms);
    const log = await AppendOnlyLog.open<ResearchRunRecord>(logName, await PostgresAppendOnlyStore.open<ResearchRunRecord>(pool, logName));
    const budget = new CreditBudget({ budget: { dailyCredits: 1, minuteCredits: 8 }, runId: 'proc-' + name, log, records: () => log.all().map((r) => r.payload), clock: clock.now, sleep: clock.sleep, deadlineMs: clock.ms + 60_000 });
    writeFileSync(join(dir, 'ready-' + name), String(process.pid));
    await waitFor('go');
    try {
      await budget.reserve(1, '/time_series');
      return { pid: process.pid, reserved: true };
    } catch (error) {
      if (error instanceof ResearchBudgetError) return { pid: process.pid, reserved: false, code: error.code };
      throw error;
    }
  }
  throw new Error('unknown mode ' + mode);
}

main()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error: unknown) => {
    console.log(JSON.stringify({ pid: process.pid, error: (error as Error).message }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
