// O22 Plan C, without the test mock of the build lock: an active cycle with its own policy and budget opens no lock. Every demo write
// is still refused by BUILD_LOCKS.etoroDemoExecution, before any broker request, and no budget is spent.
import { describe, expect, it } from 'vitest';
import { InMemoryAppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import { BUILD_LOCKS } from '../../../src/nexus/safety.js';
import { CYCLE_ACTIVATION_STATEMENT, DEMO_CYCLE_2_POLICY_DRAFT, policyHashOf, type DemoCycleRecord } from '../../../src/broker/etoro/execution/demo-cycles.js';
import { DEFAULT_DEMO_EXECUTION_POLICY } from '../../../src/broker/etoro/execution/execution-gate.js';
import { CREATOR, HUMAN, o21Fixture, openInput } from './o21-fixture.js';

describe('Plan C: a cycle never opens a build lock', () => {
  it('all four locks stay closed; with an active cycle every execute is EXECUTION_LOCKED_IN_BUILD with 0 broker requests', async () => {
    expect(BUILD_LOCKS).toEqual({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: true });
    const f = await o21Fixture({ cycles: new InMemoryAppendOnlyStore<DemoCycleRecord>() });
    const policy = Object.freeze({ ...DEFAULT_DEMO_EXECUTION_POLICY, version: 'etoro-demo-cycle-policy:locked-1' as const, maxOpenSubmissions: 1, maxCloseSubmissions: 1 });
    await f.service.defineCycle({ cycleId: 'cycle-1', policy, maxActiveMs: 60 * 60 * 1000 }, HUMAN);
    await f.service.activateCycle('cycle-1', { policyHash: policyHashOf(policy), statement: CYCLE_ACTIVATION_STATEMENT }, HUMAN);
    // As without cycles: creation and approval record no write; the lock refuses the write itself.
    const created = await f.service.create(openInput(), CREATOR);
    expect(created.state, created.gateReasons.join(',')).toBe('RISK_APPROVED');
    await f.service.approve(created.intentId, HUMAN);
    await expect(f.service.execute(created.intentId, HUMAN)).rejects.toMatchObject({ code: 'EXECUTION_LOCKED_IN_BUILD' });
    expect((await f.service.get(created.intentId)).state).toBe('APPROVED');
    expect(f.broker.requests).toHaveLength(0);
    expect(await f.service.cycleBudget()).toMatchObject({ cycleId: 'cycle-1', openSubmissions: 0 });
    // The cycle 2 draft is a constant that nothing uses: no cycle is defined with it here, and nothing is activated.
    expect(DEMO_CYCLE_2_POLICY_DRAFT.version).toBe('etoro-demo-cycle-policy:cycle-2-draft.1');
  });
});
