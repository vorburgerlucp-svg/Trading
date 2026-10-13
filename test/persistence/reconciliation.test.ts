import { describe, expect, it } from 'vitest';
import { accounts } from '../../src/capital/accounts.js';
import { CapitalEngine } from '../../src/capital/capital-engine.js';
import { CapitalLedger } from '../../src/capital/capital-ledger.js';
import { InMemoryLedgerStore } from '../../src/capital/ledger-store.js';
import { verifyStoredLedger } from '../../src/capital/ledger-integrity.js';
import {
  InMemoryLedgerSnapshotStore,
  LedgerReconciliationService,
  snapshotStateHash,
  takeSnapshot,
  totalsOf,
  type LedgerSnapshot,
} from '../../src/capital/ledger-reconciliation.js';
import { chf } from '../../src/money/money.js';
import { fixedClock, policy, sequentialIds, T0 } from '../helpers.js';

const bank = accounts.bank('ubs');

async function bookedLedger(store = new InMemoryLedgerStore()) {
  const clock = fixedClock();
  const ledger = await CapitalLedger.open(store, { clock: clock.now });
  const engine = new CapitalEngine(ledger, { policy: policy(), clock: clock.now, newId: sequentialIds('r') });
  await engine.deposit({ to: bank, amountChf: chf('500.00'), id: 'dep-1' });
  await engine.recordExpense({ category: 'fee', feeKind: 'bank', amountChf: chf('12.70'), paidFrom: bank, id: 'fee-1' });
  return { store, ledger, engine };
}

/** A cache that was written with wrong numbers but a self-consistent state hash (e.g. a projection bug). */
function wrongCache(snapshot: LedgerSnapshot, account: string, amountMinor: string): LedgerSnapshot {
  const balances = snapshot.balances.map((b) => (b.account === account ? { ...b, amountMinor } : b));
  const unsigned = { ...snapshot, balances, totals: totalsOf(balances) };
  return { ...unsigned, stateHash: snapshotStateHash(unsigned) };
}

describe('LedgerReconciliationService', () => {
  it('Ledger-abgeleitetes Cash CHF 487.30 = Snapshot CHF 487.30 → MATCH', async () => {
    const { store, ledger } = await bookedLedger();
    const snapshots = new InMemoryLedgerSnapshotStore();
    await snapshots.save(takeSnapshot(ledger, T0));
    const result = await new LedgerReconciliationService(store).reconcileSnapshot((await snapshots.latest('main'))!);
    expect(result.status).toBe('MATCH');
    expect(result.checks.find((c) => c.name === 'cashMinor')).toEqual({ name: 'cashMinor', ledger: '48730', snapshot: '48730', match: true });
  });

  it('CHF 487.30 vs. CHF 477.30 im Cache → RECONCILIATION_FAILURE, nichts wird still korrigiert', async () => {
    const { store, ledger } = await bookedLedger();
    const cached = wrongCache(takeSnapshot(ledger, T0), bank, '47730');
    const result = await new LedgerReconciliationService(store).reconcileSnapshot(cached);
    expect(result.status).toBe('RECONCILIATION_FAILURE');
    expect(result.differences).toContainEqual({ account: bank, currency: 'CHF', field: 'amount', ledger: '48730', snapshot: '47730' });
    expect(result.checks.find((c) => c.name === 'cashMinor')).toMatchObject({ ledger: '48730', snapshot: '47730', match: false });
    // The ledger is untouched; the snapshot object is untouched.
    expect(ledger.balance(bank).amount).toBe(chf('487.30'));
    expect(cached.balances.find((b) => b.account === bank)?.amountMinor).toBe('47730');
  });

  it('ein beschädigter Snapshot (Inhalt passt nicht zum State-Hash) ist ungültig', async () => {
    const { store, ledger } = await bookedLedger();
    const snapshot = takeSnapshot(ledger, T0);
    const corrupted = { ...snapshot, balances: snapshot.balances.map((b) => (b.account === bank ? { ...b, amountMinor: '1' } : b)) };
    expect((await new LedgerReconciliationService(store).reconcileSnapshot(corrupted)).status).toBe('SNAPSHOT_INVALID');
  });

  it('Snapshot aus einer anderen (umgeschriebenen) Historie ist ungültig', async () => {
    const { ledger } = await bookedLedger();
    const snapshot = takeSnapshot(ledger, T0);
    const other = await bookedLedger(new InMemoryLedgerStore());
    await other.engine.deposit({ to: bank, amountChf: chf(1), id: 'dep-extra' });
    const otherStoreReport = await new LedgerReconciliationService(other.store).reconcileSnapshot({ ...snapshot, sequence: 2, ledgerHash: 'f'.repeat(64), stateHash: snapshotStateHash({ ...snapshot, sequence: 2, ledgerHash: 'f'.repeat(64) }) });
    expect(otherStoreReport.status).toBe('SNAPSHOT_INVALID');
    expect(otherStoreReport.issues[0]).toMatch(/history changed/);
  });

  it('ein Snapshot älterer Sequenz bleibt gültig und wird gegen die Historie bis dorthin geprüft', async () => {
    const { store, ledger, engine } = await bookedLedger();
    const old = takeSnapshot(ledger, T0);
    await engine.deposit({ to: bank, amountChf: chf(100), id: 'dep-2' });
    const service = new LedgerReconciliationService(store);
    expect((await service.reconcileSnapshot(old)).status).toBe('MATCH');
    expect((await service.reconcileProjection(ledger, T0)).status).toBe('MATCH');
  });

  it('Reconciliation verweigert eine manipulierte Historie (FINANCIAL_INTEGRITY_ERROR)', async () => {
    const { store, ledger } = await bookedLedger();
    const snapshot = takeSnapshot(ledger, T0);
    store.tamperForTest(2, (e) => ({ ...e, description: 'rewritten' }));
    await expect(new LedgerReconciliationService(store).reconcileSnapshot(snapshot)).rejects.toMatchObject({ code: 'FINANCIAL_INTEGRITY_ERROR' });
    expect((await verifyStoredLedger(store)).issues[0]?.code).toBe('HASH_MISMATCH');
  });
});
