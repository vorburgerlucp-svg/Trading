import { afterEach, describe, expect, it } from 'vitest';
import { accounts } from '../../src/capital/accounts.js';
import { CapitalLedger } from '../../src/capital/capital-ledger.js';
import { negChf, chf } from '../../src/money/money.js';
import { verifyMigrations } from '../../src/persistence/postgres/migrator.js';
import { PostgresLedgerStore } from '../../src/persistence/postgres/postgres-ledger-store.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

describe.skipIf(!pgAvailable)('PostgreSQL smoke' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase | null = null;
  afterEach(async () => {
    await db?.drop();
    db = null;
  });

  it('Migrationen sind angewendet; eine Buchung geht hin und zurück', async () => {
    db = await createTestDatabase();
    expect(await verifyMigrations(db.pool)).toEqual({ upToDate: true, pending: [] });
    const store = await PostgresLedgerStore.open(db.pool, { ledgerId: 'main' });
    const ledger = await CapitalLedger.open(store);
    const result = await ledger.append({
      id: 'd1',
      occurredAt: '2026-10-01T08:00:00.000Z',
      type: 'deposit',
      description: 'Deposit',
      postings: [
        { account: accounts.bank('ubs'), amount: chf('100.05') },
        { account: accounts.contributions, amount: negChf(chf('100.05')) },
      ],
    });
    expect(result.status).toBe('APPLIED');
    const reopened = await CapitalLedger.open(await PostgresLedgerStore.open(db.pool, { ledgerId: 'main' }));
    expect(reopened.all()).toEqual([result.entry]);
    expect(reopened.balance(accounts.bank('ubs')).amount).toBe(chf('100.05'));
  });
});
