// R2 on PostgreSQL: sealed plans and v2 evaluations in append-only logs (no migration: the generic log tables), two processes
// (two pools), and the learning quarantine on the persistent memory: a second process stores v2 observations, the first
// process's routing scores do not move.
import { afterEach, describe, expect, it } from 'vitest';
import { ModelPerformance, type PerformanceObservation } from '../../src/ai/model-performance.js';
import { NexusMemory } from '../../src/memory/nexus-memory.js';
import type { MemoryRecordInput } from '../../src/memory/memory-types.js';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import { memoryProjector } from '../../src/persistence/postgres/projectors.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import { EVALUATION_V2_LOG, EvaluationLedgerV2, TRADE_PLAN_LOG, TradePlanLedger, type SealedPlanRecord } from '../../src/evaluation/v2/plan-ledger.js';
import { evaluateDecisionFromLedger, evaluateDecisionV2, type EvaluationV2 } from '../../src/evaluation/v2/outcome-eval-v2.js';
import { AFTER, CAL, bars, plan } from '../evaluation/v2/fixtures.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

const databases: TestDatabase[] = [];
const at = (iso: string) => () => new Date(iso);

async function memoryOf(pool: PgPool): Promise<NexusMemory> {
  return NexusMemory.open(await PostgresAppendOnlyStore.open<MemoryRecordInput>(pool, 'memory', { projector: memoryProjector }));
}

function obs(i: number, score: number, scoringMethod?: string): PerformanceObservation {
  return { modelKey: 'openai/test-gpt', domain: 'equities', subtask: 'technical_interpretation', role: 'analyst', decisionId: 'd' + i + (scoringMethod ?? ''), score, shadow: false, occurredAt: '2026-10-01T10:00:00.000Z', availableAt: '2026-10-02T10:00:00.000Z', ...(scoringMethod ? { scoringMethod } : {}) };
}

describe.skipIf(!pgAvailable)('R2 learning evaluation v2 on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  async function database(): Promise<TestDatabase> {
    const db = await createTestDatabase();
    databases.push(db);
    return db;
  }

  it('a plan is sealed once across processes: the same plan is idempotent, a different plan under the same id is refused', async () => {
    const db = await database();
    const a = await TradePlanLedger.open(await PostgresAppendOnlyStore.open<SealedPlanRecord>(db.pool, TRADE_PLAN_LOG), { clock: at('2026-10-07T09:50:00.000Z') });
    const b = await TradePlanLedger.open(await PostgresAppendOnlyStore.open<SealedPlanRecord>(db.extraPool(), TRADE_PLAN_LOG), { clock: at('2026-10-07T09:51:00.000Z') });
    const results = await Promise.allSettled([a.seal(plan()), b.seal(plan({ stopLoss: '90' }))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const winner = (await a.get('plan-1'))!;
    expect(await b.get('plan-1')).toEqual(winner);
    // The seal time is the stored record's: a later re-seal of the same plan does not move it.
    expect(await b.seal(winner.plan)).toEqual(winner);
    const rows = await db.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM append_only_records WHERE log_name = $1', [TRADE_PLAN_LOG]);
    expect(rows.rows[0]!.n).toBe('1');
  }, 60_000);

  it('a sealed plan read back from the database evaluates; the evaluation is recorded once and survives a restart', async () => {
    const db = await database();
    const ledger = await TradePlanLedger.open(await PostgresAppendOnlyStore.open<SealedPlanRecord>(db.pool, TRADE_PLAN_LOG), { clock: at('2026-10-07T09:50:00.000Z') });
    await ledger.seal(plan(), '100');
    const restarted = await TradePlanLedger.open(await PostgresAppendOnlyStore.open<SealedPlanRecord>(db.extraPool(), TRADE_PLAN_LOG));
    const s = (await restarted.get('plan-1'))!;
    const e = evaluateDecisionV2({ decision: { decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: s }, bars: bars([['100', '101', '99', '100'], ['100', '111', '99', '109']]), calendar: CAL, evaluatedAt: AFTER });
    expect(e).toMatchObject({ status: 'EVALUATED', valueR: '2', planSealedAt: '2026-10-07T09:50:00.000Z' });
    const evaluations = await EvaluationLedgerV2.open(await PostgresAppendOnlyStore.open<EvaluationV2>(db.pool, EVALUATION_V2_LOG));
    expect(await evaluations.record(e)).toBe('APPLIED');
    const other = await EvaluationLedgerV2.open(await PostgresAppendOnlyStore.open<EvaluationV2>(db.extraPool(), EVALUATION_V2_LOG));
    expect(await other.record(e)).toBe('ALREADY_APPLIED');
    expect(await other.all()).toEqual([e]);
  }, 60_000);

  it('authenticity across processes: a research plan sealed by one process is read from the database by another and verified', async () => {
    const db = await database();
    const writer = await TradePlanLedger.open(await PostgresAppendOnlyStore.open<SealedPlanRecord>(db.pool, TRADE_PLAN_LOG), { clock: at('2026-10-07T09:50:00.000Z') });
    await writer.seal(plan({ origin: 'research' }), '100');
    const reader = await TradePlanLedger.open(await PostgresAppendOnlyStore.open<SealedPlanRecord>(db.extraPool(), TRADE_PLAN_LOG));
    const e = await evaluateDecisionFromLedger({ ledger: reader, planId: 'plan-1', decision: { decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat' }, bars: bars([['100', '101', '99', '100'], ['100', '111', '99', '109']]), calendar: CAL, evaluatedAt: AFTER });
    expect(e).toMatchObject({ status: 'EVALUATED', authenticity: 'sealed_before_outcome', planSealedAt: '2026-10-07T09:50:00.000Z' });
    // A stored plan changed directly in the database (bypassing the log rules) is detected when it is read.
    const admin = await db.privilegedClient();
    try {
      await admin.query('ALTER TABLE append_only_records DISABLE TRIGGER USER');
      await admin.query("UPDATE append_only_records SET payload = jsonb_set(payload, '{plan,stopLoss}', '\"80\"') WHERE log_name = $1", [TRADE_PLAN_LOG]);
      await admin.query('ALTER TABLE append_only_records ENABLE TRIGGER USER');
    } finally {
      await admin.end();
    }
    await expect(TradePlanLedger.open(await PostgresAppendOnlyStore.open<SealedPlanRecord>(db.extraPool(), TRADE_PLAN_LOG))).rejects.toThrow();
  }, 60_000);

  it('quarantine on the persistent memory: v2 observations written by another process do not change published scores', async () => {
    const db = await database();
    const routing = new ModelPerformance(await memoryOf(db.pool));
    for (let i = 0; i < 25; i++) await routing.record('v1-' + i, obs(i, 0.8));
    const before = routing.published('openai/test-gpt', 'equities', 'technical_interpretation', '2026-12-01T00:00:00.000Z');
    expect(before).not.toBeNull();
    const analysis = new ModelPerformance(await memoryOf(db.extraPool()));
    for (let i = 0; i < 40; i++) await analysis.record('v2-' + i, obs(i, 0, 'outcome-eval:v2'));
    await routing.sync();
    expect(routing.published('openai/test-gpt', 'equities', 'technical_interpretation', '2026-12-01T00:00:00.000Z')).toEqual(before);
    expect(routing.quarantinedObservations('openai/test-gpt', '2026-12-01T00:00:00.000Z')).toHaveLength(40);
    const stored = await db.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM append_only_records WHERE log_name = 'memory' AND payload->'content'->>'scoringMethod' = 'outcome-eval:v2'");
    expect(stored.rows[0]!.n).toBe('40');
  }, 60_000);
});
