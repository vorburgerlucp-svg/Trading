// R1 across real OS processes: separate Node.js processes (test/research/child/research-child.ts) with their own PostgreSQL
// connections on one isolated test database. Two pools in one process are not the same as two processes: here the worker lock,
// a hard kill during a request, and the credit budget are proven across process boundaries. Scripted provider, no network.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { researchRunLogName } from '../../src/research/research-run-log.js';
import { createTestDatabase, pgAvailable, pgInfo, pgSkipReason, type TestDatabase } from './db.js';

const CHILD = resolve(__dirname, '..', 'research', 'child', 'research-child.ts');
const HOOK = pathToFileURL(resolve(__dirname, '..', 'research', 'child', 'ts-resolve-hook.mjs')).href;
const TODAY = researchRunLogName(Date.parse('2026-10-07T15:31:30Z'));

interface Child {
  proc: ChildProcess;
  result: Promise<{ code: number | null; json: Record<string, unknown> | null; stderr: string }>;
}

function start(db: TestDatabase, dir: string, mode: 'run' | 'reserve', name: string, env: Record<string, string> = {}): Child {
  if (!pgInfo.available) throw new Error('no pg');
  const proc = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', HOOK, CHILD, mode], {
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', R1_CHILD_PG: JSON.stringify({ ...pgInfo.connection, database: db.name }), R1_CHILD_DIR: dir, R1_CHILD_NAME: name, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  const result = new Promise<{ code: number | null; json: Record<string, unknown> | null; stderr: string }>((done) => {
    proc.on('exit', (code) => {
      const line = out.trim().split('\n').at(-1) ?? '';
      let json: Record<string, unknown> | null = null;
      try {
        json = line ? (JSON.parse(line) as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
      done({ code, json, stderr: err.slice(0, 2000) });
    });
  });
  return { proc, result };
}

async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const databases: TestDatabase[] = [];
const dirs: string[] = [];
const children: ChildProcess[] = [];

describe.skipIf(!pgAvailable)('R1 across separate Node.js processes' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const c of children.splice(0)) if (c.exitCode === null) c.kill();
    for (const db of databases.splice(0)) await db.drop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function setup(): Promise<{ db: TestDatabase; dir: string }> {
    const db = await createTestDatabase();
    databases.push(db);
    const dir = mkdtempSync(join(tmpdir(), 'nexus-r1-'));
    dirs.push(dir);
    return { db, dir };
  }

  it('two worker processes: the second is refused by the lock while the first is inside its request; only one fetches', async () => {
    const { db, dir } = await setup();
    const a = start(db, dir, 'run', 'a', { R1_CHILD_BLOCK: '1' });
    children.push(a.proc);
    await until(() => existsSync(join(dir, 'inside-a')));
    const b = start(db, dir, 'run', 'b');
    children.push(b.proc);
    const rb = await b.result;
    expect(rb.json, rb.stderr).toMatchObject({ out: { kind: 'skipped', reason: 'LOCK_HELD' }, calls: 0 });
    writeFileSync(join(dir, 'open'), '');
    const ra = await a.result;
    expect(ra.json, ra.stderr).toMatchObject({ out: { kind: 'finished', status: 'completed', creditsUsed: 1 }, calls: 1 });
    expect(rb.json!.pid).not.toBe(ra.json!.pid);
  }, 120_000);

  it('a worker process killed during its request: the lock is freed, the next process records it as abandoned, its credit still counts, no duplicates', async () => {
    const { db, dir } = await setup();
    const a = start(db, dir, 'run', 'a', { R1_CHILD_BLOCK: '1', R1_CHILD_DAILY: '2' });
    children.push(a.proc);
    await until(() => existsSync(join(dir, 'inside-a')));
    a.proc.kill('SIGKILL'); // hard termination while the request is outstanding (result unknown)
    const ra = await a.result;
    expect(ra.json).toBeNull();
    const b = start(db, dir, 'run', 'b', { R1_CHILD_DAILY: '2' });
    children.push(b.proc);
    const rb = await b.result;
    expect(rb.json, rb.stderr).toMatchObject({ out: { kind: 'finished', status: 'completed', creditsUsed: 1, abandonedRuns: [expect.any(String)] }, calls: 1 });
    const credits = await db.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM append_only_records WHERE log_name = $1 AND payload->>'kind' = 'credit_reserved'", [TODAY]);
    expect(credits.rows[0]!.n).toBe('2'); // the killed process's reservation was written before its request and still counts
    const bars = await db.pool.query<{ rows: string; starts: string }>("SELECT count(*)::text AS rows, count(DISTINCT start_time)::text AS starts FROM market_bars WHERE instrument_id = 'rsx_crypto_btcusd'");
    expect(bars.rows[0]).toEqual({ rows: '7', starts: '7' });
  }, 120_000);

  it('the credit budget across processes: two processes reserve the last credit at the same moment, without the lock; exactly one gets it', async () => {
    const { db, dir } = await setup();
    const procs = ['x', 'y', 'z'].map((name) => start(db, dir, 'reserve', name));
    children.push(...procs.map((p) => p.proc));
    await until(() => ['x', 'y', 'z'].every((name) => existsSync(join(dir, 'ready-' + name))));
    writeFileSync(join(dir, 'go'), '');
    const results = await Promise.all(procs.map((p) => p.result));
    for (const r of results) expect(r.json, r.stderr).not.toBeNull();
    expect(results.filter((r) => r.json!.reserved === true)).toHaveLength(1);
    expect(results.filter((r) => r.json!.reserved === false).map((r) => r.json!.code)).toEqual(['DAILY_BUDGET_EXHAUSTED', 'DAILY_BUDGET_EXHAUSTED']);
    const credits = await db.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM append_only_records WHERE log_name = $1 AND payload->>'kind' = 'credit_reserved'", [TODAY]);
    expect(credits.rows[0]!.n).toBe('1');
  }, 120_000);
});
