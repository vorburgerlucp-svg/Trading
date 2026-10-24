// O22 Plan C on a real PostgreSQL with two processes (own pools, own logs, isolated test database): one activation per cycle and at
// most one active cycle, whatever the order of arrival; one cycle's budget holds under concurrent opens; a cycle closed while a write
// is reserved stops that write; a crash right after the activation leaves a complete record. No network: scripted answers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import type { AppendOnlyStore } from '../../src/persistence/append-only-log.js';
import type { AttemptRecord, IntentEvent as IntentRecordPayload } from '../../src/broker/etoro/execution/etoro-demo-execution-service.js';
import { CYCLE_ACTIVATION_STATEMENT, policyHashOf, type DemoCycleRecord } from '../../src/broker/etoro/execution/demo-cycles.js';
import { DEFAULT_DEMO_EXECUTION_POLICY, type DemoExecutionPolicy } from '../../src/broker/etoro/execution/execution-gate.js';
import { HUMAN, ScriptedBroker, TEST_ACCESS, approvedOpen, o21Fixture, orderAccepted, type Fixture, type O21Stores } from '../broker/etoro/o21-fixture.js';
import { BarrierStore, FaultStore, HoldStore, InjectedCrash, WriteBarrier } from '../broker/etoro/o22-fault-store.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// TEST ONLY: the write path needs the compile-time lock open for this module.
vi.mock('../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});

const HOUR = 60 * 60 * 1000;
const policyOf = (version: string): DemoExecutionPolicy =>
  Object.freeze({ ...DEFAULT_DEMO_EXECUTION_POLICY, version: ('etoro-demo-cycle-policy:' + version) as DemoExecutionPolicy['version'], maxOpenSubmissions: 1, maxCloseSubmissions: 1 });
const authorize = (version: string) => ({ policyHash: policyHashOf(policyOf(version)), statement: CYCLE_ACTIVATION_STATEMENT });

interface ProcessStores {
  execution: O21Stores;
  cycles: AppendOnlyStore<DemoCycleRecord>;
}

async function stores(pool: PgPool, wrap: { attempts?: (s: AppendOnlyStore<AttemptRecord>) => AppendOnlyStore<AttemptRecord>; cycles?: (s: AppendOnlyStore<DemoCycleRecord>) => AppendOnlyStore<DemoCycleRecord> } = {}): Promise<ProcessStores> {
  const attempts = await PostgresAppendOnlyStore.open<AttemptRecord>(pool, 'etoro-demo-execution-attempts');
  const cycles = await PostgresAppendOnlyStore.open<DemoCycleRecord>(pool, 'etoro-demo-cycles');
  return {
    execution: {
      intents: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-intents'),
      attempts: wrap.attempts ? wrap.attempts(attempts) : attempts,
      confirmations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-broker-confirmations'),
      reconciliations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-reconciliations'),
    },
    cycles: wrap.cycles ? wrap.cycles(cycles) : cycles,
  };
}

const databases: TestDatabase[] = [];
const posts = (broker: ScriptedBroker) => broker.requests.filter((r) => r.method === 'POST').length;

describe.skipIf(!pgAvailable)('O22 Plan C cycles, two processes on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  async function twoProcesses(wrapA: Parameters<typeof stores>[1] = {}, wrapB: Parameters<typeof stores>[1] = {}): Promise<{ a: Fixture; b: Fixture; broker: ScriptedBroker }> {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const sa = await stores(db.pool, wrapA);
    const sb = await stores(db.extraPool(), wrapB);
    const a = await o21Fixture({ stores: sa.execution, cycles: sa.cycles, sharedBroker: broker });
    const b = await o21Fixture({ stores: sb.execution, cycles: sb.cycles, sharedBroker: broker });
    return { a, b, broker };
  }

  it('both processes activate the same cycle at once: one activation record, the other is refused', async () => {
    const { a, b } = await twoProcesses();
    await a.service.defineCycle({ cycleId: 'cycle-1', policy: policyOf('one'), maxActiveMs: HOUR }, HUMAN);
    const results = await Promise.allSettled([a.service.activateCycle('cycle-1', authorize('one'), HUMAN), b.service.activateCycle('cycle-1', authorize('one'), HUMAN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'CYCLE_REFUSED' });
    await a.cycles!.sync();
    expect(a.cycles!.all().filter((r) => r.payload.kind === 'activated')).toHaveLength(1);
  }, 60_000);

  it('two drafts activated at once, both decided before either wrote (barrier): at most one cycle becomes active', async () => {
    const barrier = new WriteBarrier(2);
    let armed = false;
    const gated = (s: AppendOnlyStore<DemoCycleRecord>): AppendOnlyStore<DemoCycleRecord> => ({ loadAll: () => s.loadAll(), loadAfter: (n) => s.loadAfter(n), writeExclusive: (k, d) => (armed ? new BarrierStore(s, barrier) : s).writeExclusive(k, d) });
    const { a, b } = await twoProcesses({ cycles: gated }, { cycles: gated });
    await a.service.defineCycle({ cycleId: 'cycle-1', policy: policyOf('one'), maxActiveMs: HOUR }, HUMAN);
    await a.service.defineCycle({ cycleId: 'cycle-2', policy: policyOf('two'), maxActiveMs: HOUR }, HUMAN);
    armed = true;
    const results = await Promise.allSettled([a.service.activateCycle('cycle-1', authorize('one'), HUMAN), b.service.activateCycle('cycle-2', authorize('two'), HUMAN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'CYCLE_REFUSED', reasons: ['ANOTHER_CYCLE_ACTIVE'] });
    expect((await a.service.listCycles()).filter((c) => c.status === 'active')).toHaveLength(1);
  }, 60_000);

  it('both processes execute different opens of the same cycle at once: its budget of one lets exactly one write through', async () => {
    const { a, b, broker } = await twoProcesses();
    await a.service.defineCycle({ cycleId: 'cycle-1', policy: policyOf('one'), maxActiveMs: HOUR }, HUMAN);
    await a.service.activateCycle('cycle-1', authorize('one'), HUMAN);
    const first = await approvedOpen(a, { strategyRunId: 'run-pg-1' });
    const second = await approvedOpen(b, { strategyRunId: 'run-pg-2', etoroInstrumentId: 1002, instrumentId: 'ins_o21_msft' });
    broker.next(orderAccepted(), orderAccepted(13902599));
    const results = await Promise.allSettled([a.service.execute(first, HUMAN), b.service.execute(second, HUMAN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(posts(broker)).toBe(1);
    expect(await b.service.cycleBudget()).toMatchObject({ cycleId: 'cycle-1', openSubmissions: 1 });
  }, 60_000);

  it('B closes the cycle while A holds a reserved open (SUBMITTING, attempt started): A does not send it', async () => {
    let hold: HoldStore<AttemptRecord> | null = null;
    const { a, b, broker } = await twoProcesses({ attempts: (s) => (hold = new HoldStore(s)) });
    await a.service.defineCycle({ cycleId: 'cycle-1', policy: policyOf('one'), maxActiveMs: HOUR }, HUMAN);
    await a.service.activateCycle('cycle-1', authorize('one'), HUMAN);
    const id = await approvedOpen(a);
    hold!.hold('after', (p) => p.operation === 'demo.order.open' && p.phase === 'started');
    broker.next(orderAccepted());
    const execution = a.service.execute(id, HUMAN);
    execution.catch(() => undefined);
    await hold!.reached;
    await b.service.closeCycle('cycle-1', HUMAN);
    hold!.release();
    await expect(execution).rejects.toMatchObject({ code: 'GATE_REFUSED', reasons: ['CYCLE_NOT_ACTIVE'] });
    expect(broker.requests).toHaveLength(0);
    expect((await b.service.get(id)).state).toBe('REJECTED');
    // The reservation spent the closed cycle's budget; it is never given back.
    expect(await b.service.cycleBudget('cycle-1')).toMatchObject({ openSubmissions: 1 });
  }, 60_000);

  it('P4: B closes the cycle after A passed the gate and before A reads the cycle for its reservation: refused there, nothing reserved, no budget spent', async () => {
    // The hold point: an open reads the stored snapshot twice in execute: in the gate (read 1) and right before the reservation
    // (read 2), which comes BEFORE the cycle log is read for the reservation. A is held on read 2, B closes the cycle meanwhile.
    const gate = { armed: false, reads: 0, reached: null as null | (() => void), release: null as null | (() => void) };
    const reached = new Promise<void>((resolve) => (gate.reached = resolve));
    const released = new Promise<void>((resolve) => (gate.release = resolve));
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const sa = await stores(db.pool);
    const sb = await stores(db.extraPool());
    const a = await o21Fixture({
      stores: sa.execution,
      cycles: sa.cycles,
      sharedBroker: broker,
      positionSource: {
        latest: async () => {
          if (gate.armed) {
            gate.reads += 1;
            if (gate.reads === 2) {
              gate.reached!();
              await released;
            }
          }
          return { snapshot: { observedAt: a.clock.now.toISOString(), freshness: 'fresh' as const, positionCount: 0, positions: [], access: TEST_ACCESS.stamp() }, problem: null };
        },
      },
    });
    const b = await o21Fixture({ stores: sb.execution, cycles: sb.cycles, sharedBroker: broker });
    await a.service.defineCycle({ cycleId: 'cycle-1', policy: policyOf('one'), maxActiveMs: HOUR }, HUMAN);
    await a.service.activateCycle('cycle-1', authorize('one'), HUMAN);
    const id = await approvedOpen(a);
    gate.armed = true;
    broker.next(orderAccepted());
    const execution = a.service.execute(id, HUMAN);
    execution.catch(() => undefined);
    await reached;
    expect(gate.reads).toBe(2); // the gate (read 1) passed: A is between its gate and its reservation
    await b.service.closeCycle('cycle-1', HUMAN);
    gate.release!();
    await expect(execution).rejects.toMatchObject({ code: 'GATE_REFUSED', reasons: ['CYCLE_NOT_ACTIVE'] });
    expect(broker.requests).toHaveLength(0);
    // Refused IN the reservation step: no SUBMITTING record, the intent stays APPROVED, and the closed cycle's budget is untouched.
    expect(b.intents.all().some((r) => r.payload.intentId === id && r.payload.state === 'SUBMITTING')).toBe(false);
    expect((await b.service.get(id)).state).toBe('APPROVED');
    expect(await b.service.cycleBudget('cycle-1')).toMatchObject({ openSubmissions: 0 });
  }, 60_000);

  it('window 2 (review R2): B closes the cycle after A read the cycle log and before A reserves: the reservation sees the close in its own critical section: nothing reserved, no budget spent', async () => {
    // A is held right before its SUBMITTING write enters the intent log's lock; its read of the cycle log for the reservation is done.
    let hold: HoldStore<IntentRecordPayload> | null = null;
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const sa = await stores(db.pool);
    const sb = await stores(db.extraPool());
    const a = await o21Fixture({ stores: { ...sa.execution, intents: (hold = new HoldStore(sa.execution.intents)) }, cycles: sa.cycles, sharedBroker: broker });
    const b = await o21Fixture({ stores: sb.execution, cycles: sb.cycles, sharedBroker: broker });
    await a.service.defineCycle({ cycleId: 'cycle-1', policy: policyOf('one'), maxActiveMs: HOUR }, HUMAN);
    await a.service.activateCycle('cycle-1', authorize('one'), HUMAN);
    const id = await approvedOpen(a);
    hold!.hold('before');
    broker.next(orderAccepted());
    const execution = a.service.execute(id, HUMAN);
    execution.catch(() => undefined);
    await hold!.reached;
    await b.service.closeCycle('cycle-1', HUMAN);
    hold!.release();
    // The reservation read the cycle log inside its own transaction (the guard): it saw CLOSING and refused. On e431079 (the copy read
    // before) SUBMITTING was recorded here and the closed cycle's budget counted it; that residual is gone.
    await expect(execution).rejects.toMatchObject({ code: 'GATE_REFUSED', reasons: ['CYCLE_NOT_ACTIVE'] });
    expect(broker.requests).toHaveLength(0);
    expect((await b.service.get(id)).history.map((h) => h.state)).toEqual(['CREATED', 'RISK_APPROVED', 'APPROVED']);
    expect(await b.service.cycleBudget('cycle-1')).toMatchObject({ openSubmissions: 0 });
    // A new cycle is not affected: it has its own count. (The refused intent is still APPROVED, a pending approval: it blocks the next
    // activation until it is withdrawn or expired.)
    await b.service.defineCycle({ cycleId: 'cycle-2', policy: policyOf('two'), maxActiveMs: HOUR }, HUMAN);
    await expect(b.service.activateCycle('cycle-2', authorize('two'), HUMAN)).rejects.toMatchObject({ reasons: ['PRIOR_INTENT_PENDING'] });
    await b.service.withdraw(id);
    await b.service.activateCycle('cycle-2', authorize('two'), HUMAN);
    expect(await b.service.cycleBudget()).toMatchObject({ cycleId: 'cycle-2', openSubmissions: 0 });
    expect(await b.service.cycleBudget('cycle-1')).toMatchObject({ openSubmissions: 0 });
  }, 60_000);

  it('A crashes right after its activation record committed: B sees the active cycle, and a second activation is refused', async () => {
    let fault: FaultStore<DemoCycleRecord> | null = null;
    const { a, b } = await twoProcesses({ cycles: (s) => (fault = new FaultStore(s)) });
    await a.service.defineCycle({ cycleId: 'cycle-1', policy: policyOf('one'), maxActiveMs: HOUR }, HUMAN);
    fault!.crashAt((r) => r.kind === 'activated', 'after');
    await expect(a.service.activateCycle('cycle-1', authorize('one'), HUMAN)).rejects.toBeInstanceOf(InjectedCrash);
    expect((await b.service.listCycles()).map((c) => c.status)).toEqual(['active']);
    await expect(b.service.activateCycle('cycle-1', authorize('one'), HUMAN)).rejects.toMatchObject({ code: 'CYCLE_REFUSED' });
  }, 60_000);
});
