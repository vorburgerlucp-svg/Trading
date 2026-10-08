// End-to-end: a full NEXUS decision with every store on PostgreSQL, then a "restart" with new pools.
// The decision must be completely reconstructable from the database, and the normalized tables
// (decision_records, decision_evidence, decision_model_runs, model_runs, audit_events) must agree.

import { afterEach, describe, expect, it } from 'vitest';
import { ChampionBoard } from '../../src/ai/champion-challenger.js';
import { ModelPerformance } from '../../src/ai/model-performance.js';
import { ModelRegistry } from '../../src/ai/model-registry.js';
import { modelKey } from '../../src/ai/model-types.js';
import { AuditLog } from '../../src/audit/audit-log.js';
import { DecisionRecordStore } from '../../src/audit/decision-records.js';
import { SharedBlackboard } from '../../src/blackboard/shared-blackboard.js';
import { accounts } from '../../src/capital/accounts.js';
import { CapitalEngine } from '../../src/capital/capital-engine.js';
import { CapitalLedger } from '../../src/capital/capital-ledger.js';
import { LedgerReconciliationService, takeSnapshot } from '../../src/capital/ledger-reconciliation.js';
import { EvidenceStore } from '../../src/evidence/evidence-store.js';
import { NexusMemory } from '../../src/memory/nexus-memory.js';
import { chf } from '../../src/money/money.js';
import { NexusBrain, readOnlyCapital } from '../../src/nexus/nexus-brain.js';
import { loadSafetyConfig } from '../../src/nexus/safety.js';
import { openPostgresStores } from '../../src/persistence/postgres/postgres-stores.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import { fixedClock, policy, sequentialIds, T0 } from '../helpers.js';
import { byRole, decisionRequest, evidenceRef, GENEROUS_ALLOCATION, HUMAN, MODELS, opinion, ScriptedAdapter, task } from '../nexus/fakes.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

async function nexusOn(pool: PgPool, prefix: string) {
  const clock = () => new Date(T0);
  const stores = await openPostgresStores(pool, { ledgerId: 'main' });
  const ledger = await CapitalLedger.open(stores.ledger, { clock: fixedClock().now });
  const engine = new CapitalEngine(ledger, { policy: policy(), clock: fixedClock().now, newId: sequentialIds(prefix + '-cap-') });
  const evidence = await EvidenceStore.open(stores.evidence, { clock });
  const blackboard = await SharedBlackboard.open(evidence, stores.blackboard, { clock, newId: sequentialIds(prefix + '-bb-') });
  const memory = await NexusMemory.open(stores.memory, { clock });
  const audit = await AuditLog.open(stores.audit, { clock });
  const decisions = await DecisionRecordStore.open(stores.decisions, { clock });
  const performance = new ModelPerformance(memory);
  const registry = await ModelRegistry.open(stores.registry, { clock, newId: sequentialIds(prefix + '-reg-') });
  const champions = await ChampionBoard.open({ performance, store: stores.champions });
  const council = [
    new ScriptedAdapter('openai', 'test-gpt', byRole({ analyst: opinion({ claims: [{ category: 'fact', statement: 'AAPL last price 227.50 USD', evidenceRefIds: ['price-aapl'] }] }) })),
    new ScriptedAdapter('anthropic', 'test-claude', byRole({})),
    new ScriptedAdapter('google', 'test-gemini', byRole({})),
  ];
  const brain = new NexusBrain({
    clock,
    newId: sequentialIds(prefix + '-n'),
    registry,
    performance,
    champions,
    adapters: new Map(council.map((a) => [modelKey(a.provider, a.model), a] as const)),
    evidence,
    blackboard,
    memory,
    audit,
    decisions,
    capital: readOnlyCapital(engine),
    allocationPolicy: GENEROUS_ALLOCATION,
    safety: loadSafetyConfig({ TRADING_MODE: 'paper', ALLOW_LIVE_TRADING: 'false' }),
    modelTimeoutMs: 2_000,
  });
  return { stores, ledger, engine, evidence, registry, brain, audit, decisions };
}

describe.skipIf(!pgAvailable)('NEXUS on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase | null = null;
  afterEach(async () => {
    await db?.drop();
    db = null;
  });

  it('Entscheidung wird vollständig persistiert und nach einem Neustart identisch rekonstruiert', async () => {
    db = await createTestDatabase();
    const first = await nexusOn(db.extraPool(), 'p1');
    await first.engine.deposit({ to: accounts.brokerCash('ibkr'), amountChf: chf(5000), id: 'bank-in:0001' });
    for (const m of Object.values(MODELS)) await first.registry.registerActive(m, { at: T0, by: HUMAN, reason: 'initial council' });
    await first.evidence.register(evidenceRef({ id: 'price-aapl' }));
    await first.evidence.register(evidenceRef({ id: 'quant-aapl', type: 'quant_calculation', freshnessMs: undefined, source: 'nexus-quant (test)' }));

    const decision = await first.brain.decide(decisionRequest(task({ id: 'task-pg-1', importance: 'high' })));
    expect(decision.outcome).toBe('RECOMMEND');
    const trace = first.brain.trace(decision.decisionId)!;

    // "Restart": completely new objects and connection pools, everything loaded from PostgreSQL.
    const second = await nexusOn(db.extraPool(), 'p2');
    const reloaded = second.brain.trace(decision.decisionId)!;
    expect(reloaded).toEqual(trace);
    expect(second.decisions.get(decision.decisionId)).toEqual(first.decisions.get(decision.decisionId));
    expect(second.registry.list()).toEqual(first.registry.list());
    expect(second.ledger.all()).toEqual(first.ledger.all());

    const q = (sql: string, params: unknown[] = []) => db!.pool.query(sql, params).then((r) => r.rows);
    const [record] = await q('SELECT final_action, reason_codes, capital_state_ref, input_fingerprint FROM decision_records WHERE decision_id = $1', [decision.decisionId]);
    expect(record).toMatchObject({ final_action: 'RECOMMEND', capital_state_ref: decision.capitalStateRef, input_fingerprint: trace.record.inputFingerprint });
    expect((await q('SELECT evidence_id FROM decision_evidence WHERE decision_id = $1 ORDER BY evidence_id', [decision.decisionId])).map((r) => r.evidence_id)).toEqual(
      [...trace.record.evidenceRefs].sort(),
    );
    const runs = await q('SELECT run_id, status, confidence_score, calibrated_probability, calibration_method, prompt_version FROM model_runs WHERE decision_id = $1 ORDER BY run_id', [decision.decisionId]);
    expect(runs.map((r) => r.run_id)).toEqual([...trace.record.modelRuns].sort());
    expect(runs.every((r) => r.calibrated_probability === null && r.calibration_method === null && r.prompt_version === '1.1.0')).toBe(true);
    expect(runs.filter((r) => r.status === 'ok').every((r) => r.confidence_score !== null)).toBe(true);
    expect((await q('SELECT count(*)::int AS n FROM decision_model_runs WHERE decision_id = $1', [decision.decisionId]))[0].n).toBe(trace.record.modelRuns.length);
    const types = (await q('SELECT type FROM audit_events WHERE decision_id = $1', [decision.decisionId])).map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(['TASK_CREATED', 'MODEL_SELECTED', 'CRITIC_STARTED', 'MODEL_RESPONSE_RECEIVED', 'BLACKBOARD_ENTRY', 'CONSENSUS_CREATED', 'QUANT_RESULT', 'RISK_DECISION', 'CAPITAL_PROPOSAL', 'DECISION_RECORDED']));
    expect(types).not.toContain('ORDER_EXECUTION');

    // The capital state the decision used is referenced by its exact ledger position.
    expect(decision.capitalStateRef).toBe('ledger:main@1:' + second.ledger.all()[0]!.hash + '#asOf=' + T0);
  });

  it('Snapshots in PostgreSQL: richtige Reihenfolge auch ab 10 Stück, Reconciliation gegen die DB', async () => {
    db = await createTestDatabase();
    const n = await nexusOn(db.pool, 'p');
    for (let i = 1; i <= 12; i++) {
      await n.engine.deposit({ to: accounts.bank('ubs'), amountChf: chf(i), id: 'dep-' + i });
      await n.stores.snapshots.save(takeSnapshot(n.ledger, T0));
    }
    const latest = await n.stores.snapshots.latest('main');
    expect(latest?.sequence).toBe(12);
    const service = new LedgerReconciliationService(n.stores.ledger);
    expect((await service.reconcileSnapshot(latest!)).status).toBe('MATCH');
    expect((await service.reconcileProjection(n.ledger, T0)).status).toBe('MATCH');
  });
});
