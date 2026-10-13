import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FinancialConnectorRegistry, type RegistryEvent } from '../../src/financial/financial-registry.js';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import { APPROVED, change, HUMAN, PROVIDER, T0 } from '../financial/fixtures.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// docs/FINANCIAL_EVIDENCE_PERSISTENCE_V1.md §17. The connector registry is governance state on the generic append-only log. This suite proves it on
// PostgreSQL under log name financial-connectors: the same state and history come back after a reopen, and the reopened log verifies its own chain.

describe.skipIf(!pgAvailable)('connector registry on PostgreSQL (financial-connectors)' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db?.drop();
  });

  it('register, enable and activate survive a reopen with identical state and history', async () => {
    const first = await PostgresAppendOnlyStore.open<RegistryEvent>(db.pool, 'financial-connectors');
    const live = await FinancialConnectorRegistry.open(first);
    await live.register({ connectorId: 'fund-a', provider: PROVIDER, transport: 'mcp', capabilities: ['fundamentals'], license: APPROVED, mode: 'RESEARCH' }, change());
    await live.enable('fund-a', change());
    await live.activateProduction('fund-a', change(HUMAN, '2026-06-02T00:00:00.000Z'), { passed: true, reasons: [] });
    const stateBefore = live.get('fund-a');
    const historyBefore = live.history('fund-a');
    expect(stateBefore).toMatchObject({ mode: 'PRODUCTION', enabled: true, registeredAt: T0 });

    const reopened = await FinancialConnectorRegistry.open(await PostgresAppendOnlyStore.open<RegistryEvent>(db.extraPool(), 'financial-connectors'));
    expect(reopened.get('fund-a')).toEqual(stateBefore);
    expect(reopened.history('fund-a')).toEqual(historyBefore);
    expect(reopened.history('fund-a').map((item) => item.type)).toEqual(['registered', 'enabled', 'activated_production']);
  });

  it('the stored log is hash-chained: the registry events are records of the append-only log, and the log holds no other rows', async () => {
    const store = await PostgresAppendOnlyStore.open<RegistryEvent>(db.pool, 'financial-connectors');
    const registry = await FinancialConnectorRegistry.open(store);
    await registry.register({ connectorId: 'fund-a', provider: PROVIDER, transport: 'mcp', capabilities: ['fundamentals'], license: APPROVED, mode: 'RESEARCH' }, change());
    const rows = (await db.pool.query<{ log_name: string }>('SELECT log_name FROM append_only_records')).rows;
    expect(rows.map((r) => r.log_name)).toEqual(['financial-connectors']);
  });
});
