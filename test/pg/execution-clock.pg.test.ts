import { afterEach, describe, expect, it } from 'vitest';
import { BacktestRunIntegrityError } from '../../src/backtest/backtest-store.js';
import { PostgresBacktestRunStore } from '../../src/persistence/postgres/postgres-scanner-backtest-store.js';
import { SPLIT_ROWS, run, series, strategy } from '../backtest/o2-fixtures.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// Execution clock persistence (execution-clock:v1): fill timing and the execution-clock identity round-trip; a tampered execution instant fails closed.

describe.skipIf(!pgAvailable)('execution clock on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase | null = null;
  afterEach(async () => {
    await db?.drop();
    db = null;
  });

  it('fill timing and the execution-clock identity round-trip losslessly', async () => {
    db = await createTestDatabase();
    // Entry decided on 10-05 fills at the 10-06 open; a gap stop on the 10-09 open exits at that open.
    const rows = [...SPLIT_ROWS.slice(0, 4).map((r) => r), ['2026-10-09', '19', '19', '18', '19'] as const];
    const r = run(series(rows), strategy({ enterAt: 1, exitAt: 100, stop: '80', target: '120' }));
    expect(r.fills.every((f) => f.timing.kind === 'OPEN_EXACT')).toBe(true);
    await new PostgresBacktestRunStore(db.pool).save(r);
    const back = await new PostgresBacktestRunStore(db.pool).get(r.backtestRunId);
    expect(back!.fills.map((f) => f.timing)).toEqual(r.fills.map((f) => f.timing));
    expect(back!.executionClock).toEqual(r.executionClock);
    expect(back!.engineVersion).toBe('backtest-engine:v8');
  });

  it('a tampered execution instant of a fill is rejected on read', async () => {
    db = await createTestDatabase();
    const r = run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 1, exitAt: 100 }));
    await new PostgresBacktestRunStore(db.pool).save(r);
    const privileged = await db.privilegedClient();
    try {
      await privileged.query("SET session_replication_role = 'replica'");
      await privileged.query(`UPDATE backtest_runs SET result = jsonb_set(result, '{fills,0,timing,executionAt}', '"2026-10-05T04:00:00.000Z"') WHERE backtest_run_id = $1`, [r.backtestRunId]);
    } finally {
      await privileged.end();
    }
    await expect(new PostgresBacktestRunStore(db.pool).get(r.backtestRunId)).rejects.toBeInstanceOf(BacktestRunIntegrityError);
  });

  it('a v8 run whose fill disagrees with its recorded open is refused at save: the clock check applies from v7 on, not only to v7', async () => {
    db = await createTestDatabase();
    const r = run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 1, exitAt: 100 }));
    expect(r.engineVersion).toBe('backtest-engine:v8');
    const [first, ...rest] = r.fills;
    const broken = { ...r, fills: [{ ...first!, at: '2026-10-05T04:00:00.000Z' }, ...rest] };
    await expect(new PostgresBacktestRunStore(db.pool).save(broken)).rejects.toThrow(/does not execute at its recorded open/);
    expect(await new PostgresBacktestRunStore(db.pool).get(r.backtestRunId)).toBeNull();
  });
});
