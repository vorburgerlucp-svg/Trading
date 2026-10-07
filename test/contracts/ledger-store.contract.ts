// Contract suite for LedgerStore implementations. The SAME tests run against InMemoryLedgerStore and
// PostgresLedgerStore, so development and production cannot drift apart semantically.
// "Instances" = several CapitalLedger/CapitalEngine objects on the same stored ledger, i.e. several
// NEXUS server processes (for PostgreSQL: separate connection pools).

import { afterEach, describe, expect, it } from 'vitest';
import { accounts } from '../../src/capital/accounts.js';
import { CapitalEngine } from '../../src/capital/capital-engine.js';
import { CapitalLedger, GENESIS_HASH } from '../../src/capital/capital-ledger.js';
import type { JournalEntry, Posting } from '../../src/capital/capital-types.js';
import { computeEntryHash, verifyLedgerEntries } from '../../src/capital/ledger-integrity.js';
import type { LedgerStore } from '../../src/capital/ledger-store.js';
import { Decimal } from '../../src/money/decimal.js';
import { chf, formatChf, negChf, rappen } from '../../src/money/money.js';
import { hashOf } from '../../src/persistence/canonical-json.js';
import { fixedClock, policy, sequentialIds, T0 } from '../helpers.js';

export interface LedgerStoreHarness {
  /** A new handle onto the SAME stored ledger (a new "server process"). */
  connect(): Promise<LedgerStore>;
  cleanup(): Promise<void>;
}

const ibkr = accounts.brokerCash('ibkr');
const bank = accounts.bank('ubs');

async function instance(harness: LedgerStoreHarness, idPrefix: string) {
  const clock = fixedClock();
  const ledger = await CapitalLedger.open(await harness.connect(), { clock: clock.now });
  const engine = new CapitalEngine(ledger, { policy: policy(), clock: clock.now, newId: sequentialIds(idPrefix) });
  return { ledger, engine };
}

export function ledgerStoreContract(label: string, makeHarness: () => Promise<LedgerStoreHarness>): void {
  describe('LedgerStore contract: ' + label, () => {
    let harness: LedgerStoreHarness | null = null;
    const open = async () => (harness = await makeHarness());
    afterEach(async () => {
      await harness?.cleanup();
      harness = null;
    });

    it('Replay: Ledger vollständig neu laden → identischer CapitalState und identische Historie', async () => {
      const h = await open();
      const { ledger, engine } = await instance(h, 'a');
      await engine.deposit({ to: bank, amountChf: chf('1000.00'), id: 'bank:ubs:0001' });
      await engine.transfer({ from: bank, to: ibkr, amountChf: chf('600.00'), feeChf: chf('1.50') });
      await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: '3', grossAmountChf: chf('100.00'), feeChf: chf('0.85') });
      await engine.recordTradeSell({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: '1', grossProceedsChf: chf('40.00'), feeChf: chf('0.85') });
      await engine.reserveCash({ reservationId: 'ord-1', from: ibkr, amountChf: chf('50.00'), purpose: 'open_order' });
      await engine.recordExpense({ category: 'fee', feeKind: 'custody', amountChf: chf('2.00'), owedTo: accounts.payable('ibkr') });
      const { entry: buy } = await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'XYZ', quantity: '0.12345678', grossAmountChf: chf('12.34') });
      await engine.reverse({ entryId: buy.id, reason: 'duplicate fill' });

      const replayed = await instance(h, 'b');
      expect(replayed.ledger.all()).toEqual(ledger.all());
      expect(replayed.engine.snapshot({ asOf: T0 })).toEqual(engine.snapshot({ asOf: T0 }));
      expect(replayed.ledger.verifyIntegrity()).toEqual({ ok: true });
      expect(formatChf(replayed.engine.capitalState({ asOf: T0 }).cash.brokerCashChf)).toBe(formatChf(engine.capitalState({ asOf: T0 }).cash.brokerCashChf));
    });

    it('Duplicate Fill: derselbe Broker-Fill zehnmal (parallel, drei Instanzen) → genau einmal verbucht', async () => {
      const h = await open();
      const servers = await Promise.all([instance(h, 'a'), instance(h, 'b'), instance(h, 'c')]);
      await servers[0]!.engine.deposit({ to: ibkr, amountChf: chf(500), id: 'bank-transfer:0001' });
      const fill = { id: 'broker-fill:ibkr:ORDER123:FILL4', brokerId: 'ibkr', instrumentId: 'ACME', quantity: '2', grossAmountChf: chf('200.00'), feeChf: chf('1.00'), occurredAt: T0 };
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => servers[i % 3]!.engine.recordTradeBuy({ ...fill })));
      expect(results.filter((r) => r.status === 'APPLIED')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'ALREADY_APPLIED')).toHaveLength(9);

      const fresh = await instance(h, 'z');
      expect(fresh.ledger.size).toBe(2);
      expect(fresh.ledger.balance(accounts.position('ibkr', 'ACME')).quantity.toString()).toBe('2');
      expect(formatChf(fresh.ledger.balance(ibkr).amount)).toBe('299.00');
      // Same id, different content: never booked, never overwritten.
      await expect(servers[1]!.engine.recordTradeBuy({ ...fill, quantity: '3' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    });

    it('Parallel Spend: 100 CHF, zwei Server kaufen gleichzeitig je 80 CHF → nur einer erfolgreich, nie −60', async () => {
      const h = await open();
      const a = await instance(h, 'a');
      const b = await instance(h, 'b');
      await a.engine.deposit({ to: ibkr, amountChf: chf(100), id: 'dep-1' });
      const results = await Promise.allSettled([
        a.engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'AAA', quantity: 1, grossAmountChf: chf(80), id: 'trade-a' }),
        b.engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'BBB', quantity: 1, grossAmountChf: chf(80), id: 'trade-b' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: 'guard_rejected' });
      const fresh = await instance(h, 'z');
      expect(formatChf(fresh.ledger.balance(ibkr).amount)).toBe('20.00');
    });

    it('veralteter Server: sieht Buchungen anderer Server, bevor er prüft (kein Double Spend)', async () => {
      const h = await open();
      const a = await instance(h, 'a');
      await a.engine.deposit({ to: ibkr, amountChf: chf(100), id: 'dep-1' });
      const b = await instance(h, 'b'); // B believes 100 CHF are available ...
      await a.engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'AAA', quantity: 1, grossAmountChf: chf(90), id: 'trade-a' });
      expect(formatChf(b.ledger.balance(ibkr).amount)).toBe('100.00'); // ... its local view is stale
      await expect(b.engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'BBB', quantity: 1, grossAmountChf: chf(50), id: 'trade-b' })).rejects.toMatchObject({ code: 'guard_rejected' });
      expect(formatChf(b.ledger.balance(ibkr).amount)).toBe('10.00'); // caught up inside the critical section
      await b.engine.refresh();
      expect(b.ledger.size).toBe(2);
    });

    it('Concurrent Hash Append: 50 parallele Buchungen über 5 Server → lückenlose Sequenz und gültige Kette', async () => {
      const h = await open();
      const servers = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((p) => instance(h, p)));
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => servers[i % 5]!.engine.deposit({ to: bank, amountChf: chf(i + 1), id: 'dep-' + String(i).padStart(2, '0'), occurredAt: T0 })),
      );
      expect(results.every((r) => r.status === 'APPLIED')).toBe(true);
      const fresh = await instance(h, 'z');
      const entries = fresh.ledger.all();
      expect(entries.map((e) => e.sequence)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      expect(verifyLedgerEntries(entries, { allowedCurrencies: ['CHF'] }).ok).toBe(true);
      expect(new Set(entries.map((e) => e.hash)).size).toBe(50);
      expect(formatChf(fresh.ledger.balance(bank).amount)).toBe('1275.00'); // 1 + 2 + ... + 50
    });

    it('Atomarität: eine Buchung mit ungültiger 4. von 6 Lines wird ganz abgelehnt (0 Teilbuchungen)', async () => {
      const h = await open();
      const store = await h.connect();
      const postings: Posting[] = [
        { account: bank, amount: chf(10) },
        { account: accounts.contributions, amount: negChf(chf(10)) },
        { account: bank, amount: chf(5) },
        { account: bank, amount: rappen(700n), currency: 'XXX' }, // line 4: currency not enabled
        { account: accounts.contributions, amount: rappen(-700n), currency: 'XXX' },
        { account: accounts.contributions, amount: negChf(chf(5)) },
      ];
      const unsigned = {
        sequence: 1,
        id: 'atomic-1',
        occurredAt: T0,
        recordedAt: T0,
        type: 'deposit' as const,
        description: 'six lines, one invalid',
        postings,
        refs: {},
        source: 'import' as const,
        requestFingerprint: hashOf({ test: 'atomic' }),
        prevHash: GENESIS_HASH,
      };
      const entry: JournalEntry = { ...unsigned, hash: computeEntryHash(unsigned) };
      await expect(store.writeExclusive(0, () => ({ kind: 'append', entry, result: null }))).rejects.toMatchObject({ code: 'store_rejected' });
      expect(await store.loadAll()).toEqual([]);

      const { engine, ledger } = await instance(h, 'a');
      await engine.deposit({ to: bank, amountChf: chf(1), id: 'after-failure' });
      expect(ledger.all().map((e) => e.sequence)).toEqual([1]);
    });

    it('Invalid Currency: CHF-only → expliziter Fehler, keine stille Umrechnung', async () => {
      const h = await open();
      const { ledger } = await instance(h, 'a');
      await expect(
        ledger.append({
          id: 'usd-1',
          occurredAt: T0,
          type: 'deposit',
          description: 'USD deposit',
          postings: [
            { account: bank, amount: rappen(1000n), currency: 'USD' },
            { account: accounts.contributions, amount: rappen(-1000n), currency: 'USD' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'unsupported_currency' });
      expect(await (await h.connect()).loadAll()).toEqual([]);
    });

    it('Storno über zwei Server gleichzeitig → genau einmal', async () => {
      const h = await open();
      const a = await instance(h, 'a');
      const b = await instance(h, 'b');
      const { entry } = await a.engine.deposit({ to: bank, amountChf: chf(100), id: 'dep-1' });
      const results = await Promise.allSettled([
        a.engine.reverse({ entryId: entry.id, reason: 'wrong', id: 'rev-a' }),
        b.engine.reverse({ entryId: entry.id, reason: 'wrong', id: 'rev-b' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const fresh = await instance(h, 'z');
      expect(fresh.ledger.size).toBe(2);
      expect(fresh.ledger.balance(bank).amount).toBe(0n);
    });

    it('Mengen und Rappen überleben den Roundtrip exakt (keine Float-Logik)', async () => {
      const h = await open();
      const { engine } = await instance(h, 'a');
      await engine.deposit({ to: ibkr, amountChf: chf('90071992547409.93'), id: 'big' }); // 2^53 + 1 Rappen: not representable as a float
      await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'BTC', quantity: '0.000000012345678901', grossAmountChf: chf('0.01'), id: 'tiny' });
      const fresh = await instance(h, 'z');
      expect(formatChf(fresh.ledger.balance(ibkr).amount)).toBe('90071992547409.92');
      expect(fresh.ledger.balance(accounts.position('ibkr', 'BTC')).quantity.eq(Decimal.from('0.000000012345678901'))).toBe(true);
    });
  });
}
