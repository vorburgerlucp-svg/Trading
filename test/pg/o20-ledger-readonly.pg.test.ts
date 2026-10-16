// The read-only ledger view of O20: opening an existing ledger writes nothing, and a missing ledger is refused and is not created.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerError } from '../../src/capital/ledger-errors.js';
import { PostgresLedgerStore } from '../../src/persistence/postgres/postgres-ledger-store.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

async function ledgerRows(db: TestDatabase, ledgerId: string): Promise<number> {
  const result = await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM ledgers WHERE ledger_id = $1', [ledgerId]);
  return result.rows[0]?.n ?? 0;
}

describe.skipIf(!pgAvailable)('O20 read-only ledger view' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    // The writable open creates the ledger row once. The read-only view is tested against that existing row.
    await PostgresLedgerStore.open(db.pool, { ledgerId: 'main' });
  });

  afterAll(async () => {
    await db.drop();
  });

  it('opening an existing ledger for reading writes nothing: the ledger row count is unchanged', async () => {
    const before = await ledgerRows(db, 'main');
    const store = await PostgresLedgerStore.openReadOnly(db.pool, 'main');
    expect(store.ledgerId).toBe('main');
    expect(await ledgerRows(db, 'main')).toBe(before);
  });

  it('the read-only view loads the stored history without writing', async () => {
    const store = await PostgresLedgerStore.openReadOnly(db.pool, 'main');
    expect(await store.loadAll()).toEqual([]);
  });

  it('a missing ledger is refused with store_unavailable, and the read-only open does not create it', async () => {
    expect(await ledgerRows(db, 'absent-ledger')).toBe(0);
    await expect(PostgresLedgerStore.openReadOnly(db.pool, 'absent-ledger')).rejects.toBeInstanceOf(LedgerError);
    await expect(PostgresLedgerStore.openReadOnly(db.pool, 'absent-ledger')).rejects.toMatchObject({ code: 'store_unavailable' });
    expect(await ledgerRows(db, 'absent-ledger')).toBe(0);
  });
});
