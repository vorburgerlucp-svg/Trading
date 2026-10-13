import { describe, expect, it } from 'vitest';
import { accounts } from '../src/capital/accounts.js';
import { CapitalLedger, GENESIS_HASH, InMemoryLedgerStore, LedgerError } from '../src/capital/capital-ledger.js';
import type { JournalEntryDraft } from '../src/capital/capital-types.js';
import { FinancialIntegrityError, InMemoryLedgerCheckpointStore } from '../src/capital/ledger-integrity.js';
import { Decimal } from '../src/money/decimal.js';
import { chf, negChf, rappen } from '../src/money/money.js';
import { fixedClock, T0 } from './helpers.js';

const bank = accounts.bank('ubs');

function depositDraft(id: string, amount: string, occurredAt = T0): JournalEntryDraft {
  return {
    id,
    occurredAt,
    type: 'deposit',
    description: 'Deposit ' + amount,
    postings: [
      { account: bank, amount: chf(amount) },
      { account: accounts.contributions, amount: negChf(chf(amount)) },
    ],
  };
}

describe('CapitalLedger', () => {
  it('hängt ausgeglichene Buchungen mit Hash-Kette an', async () => {
    const ledger = await CapitalLedger.inMemory({ clock: fixedClock().now });
    const first = (await ledger.append(depositDraft('d1', '100'))).entry;
    const second = (await ledger.append(depositDraft('d2', '50'))).entry;

    expect(first.sequence).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.prevHash).toBe(first.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger.balance(bank).amount).toBe(chf(150));
    expect(ledger.verifyIntegrity()).toEqual({ ok: true });
  });

  it('lehnt unausgeglichene Buchungen ab (Geld entsteht nie aus dem Nichts)', async () => {
    const ledger = await CapitalLedger.inMemory();
    const draft: JournalEntryDraft = {
      ...depositDraft('bad', '100'),
      postings: [
        { account: bank, amount: chf(100) },
        { account: accounts.contributions, amount: negChf(chf('99.99')) },
      ],
    };
    await expect(ledger.append(draft)).rejects.toMatchObject({ code: 'unbalanced' });
    expect(ledger.size).toBe(0);
  });

  it('ist idempotent: gleiche ID + gleicher Inhalt → ALREADY_APPLIED, nie doppelt gebucht', async () => {
    const ledger = await CapitalLedger.inMemory();
    expect((await ledger.append(depositDraft('bank-booking-4711', '100'))).status).toBe('APPLIED');
    expect((await ledger.append(depositDraft('bank-booking-4711', '100'))).status).toBe('ALREADY_APPLIED');
    expect(ledger.size).toBe(1);
    expect(ledger.balance(bank).amount).toBe(chf(100));
  });

  it('gleiche ID mit anderem Inhalt ist ein Konflikt, kein Überschreiben', async () => {
    const ledger = await CapitalLedger.inMemory();
    await ledger.append(depositDraft('bank-booking-4711', '100'));
    await expect(ledger.append(depositDraft('bank-booking-4711', '999'))).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(ledger.balance(bank).amount).toBe(chf(100));
  });

  it('macht Buchungen unveränderbar', async () => {
    const ledger = await CapitalLedger.inMemory();
    const { entry } = await ledger.append(depositDraft('d1', '100'));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.postings)).toBe(true);
    expect(() => {
      (entry as { description: string }).description = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      (entry.postings as unknown as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it('prüft Mengen nur auf Positions- und Lagerkonten', async () => {
    const ledger = await CapitalLedger.inMemory();
    await ledger.append(depositDraft('d1', '100'));
    const noQuantity: JournalEntryDraft = {
      id: 'buy',
      occurredAt: T0,
      type: 'trade_buy',
      description: 'Buy without quantity',
      postings: [
        { account: accounts.position('ibkr', 'AAPL'), amount: chf(10) },
        { account: bank, amount: negChf(chf(10)) },
      ],
    };
    await expect(ledger.append(noQuantity)).rejects.toMatchObject({ code: 'invalid_entry' });

    const quantityOnCash: JournalEntryDraft = {
      ...noQuantity,
      id: 'buy2',
      postings: [
        { account: accounts.position('ibkr', 'AAPL'), amount: chf(10), quantity: Decimal.from(1) },
        { account: bank, amount: negChf(chf(10)), quantity: Decimal.from(1) },
      ],
    };
    await expect(ledger.append(quantityOnCash)).rejects.toMatchObject({ code: 'invalid_entry' });
  });

  it('lehnt ungültige Konten ab', async () => {
    const ledger = await CapitalLedger.inMemory();
    const draft: JournalEntryDraft = {
      ...depositDraft('x', '1'),
      postings: [
        { account: 'asset:cash:bank:ubs:extra', amount: chf(1) },
        { account: accounts.contributions, amount: negChf(chf(1)) },
      ],
    };
    await expect(ledger.append(draft)).rejects.toBeInstanceOf(LedgerError);
  });

  it('CHF-only: andere Währung → expliziter Fehler, keine stille Umrechnung', async () => {
    const ledger = await CapitalLedger.inMemory();
    const usd: JournalEntryDraft = {
      ...depositDraft('usd-1', '1'),
      postings: [
        { account: bank, amount: rappen(10_000n), currency: 'USD' },
        { account: accounts.contributions, amount: rappen(-10_000n), currency: 'USD' },
      ],
    };
    await expect(ledger.append(usd)).rejects.toMatchObject({ code: 'unsupported_currency' });
    expect(ledger.size).toBe(0);
    // Explicit CHF is the same as the default and normalizes to the same canonical entry.
    const explicit = { ...depositDraft('chf-1', '1'), postings: depositDraft('chf-1', '1').postings.map((p) => ({ ...p, currency: 'CHF' })) };
    expect((await ledger.append(explicit)).entry.postings[0]).not.toHaveProperty('currency');
  });

  it('erkennt Manipulation der gespeicherten Historie und verweigert das Öffnen (fail closed)', async () => {
    const store = new InMemoryLedgerStore();
    const ledger = await CapitalLedger.open(store);
    await ledger.append(depositDraft('d1', '100'));
    await ledger.append(depositDraft('d2', '50'));

    store.tamperForTest(1, (e) => ({
      ...e,
      postings: [
        { account: bank, amount: chf(1000) },
        { account: accounts.contributions, amount: negChf(chf(1000)) },
      ],
    }));
    const opened = CapitalLedger.open(store);
    await expect(opened).rejects.toBeInstanceOf(FinancialIntegrityError);
    await expect(opened).rejects.toMatchObject({ code: 'FINANCIAL_INTEGRITY_ERROR' });
  });

  it('erkennt eine vollständig neu geschriebene Historie über einen Checkpoint', async () => {
    const checkpoints = new InMemoryLedgerCheckpointStore();
    const original = new InMemoryLedgerStore();
    const ledger = await CapitalLedger.open(original);
    await ledger.append(depositDraft('d1', '100'));
    await checkpoints.saveCheckpoint(ledger.checkpoint());

    // Attacker rebuilds a consistent chain with different content (hashes all recomputed).
    const rewritten = new InMemoryLedgerStore();
    await (await CapitalLedger.open(rewritten)).append(depositDraft('d1', '900'));
    expect((await CapitalLedger.open(rewritten)).verifyIntegrity()).toEqual({ ok: true }); // chain alone looks fine
    await expect(CapitalLedger.open(rewritten, { checkpoints })).rejects.toMatchObject({ code: 'FINANCIAL_INTEGRITY_ERROR' });

    // Truncation is detected too.
    await expect(CapitalLedger.open(new InMemoryLedgerStore(), { checkpoints })).rejects.toThrow(/LEDGER_BEHIND_CHECKPOINT/);
  });

  it('korrigiert nur per Storno, und jede Buchung nur einmal', async () => {
    const ledger = await CapitalLedger.inMemory();
    await ledger.append(depositDraft('d1', '100'));
    const reversal: JournalEntryDraft = {
      id: 'r1',
      occurredAt: T0,
      type: 'reversal',
      description: 'Wrong amount',
      refs: { reversesEntryId: 'd1' },
      postings: [
        { account: bank, amount: negChf(chf(100)) },
        { account: accounts.contributions, amount: chf(100) },
      ],
    };
    await ledger.append(reversal);
    expect(ledger.balance(bank).amount).toBe(0n);
    expect(ledger.size).toBe(2);
    await expect(ledger.append({ ...reversal, id: 'r2' })).rejects.toMatchObject({ code: 'already_reversed' });
  });

  it('rekonstruiert Salden zu jedem Zeitpunkt', async () => {
    const ledger = await CapitalLedger.inMemory();
    await ledger.append(depositDraft('d1', '100', '2026-10-01T08:00:00Z'));
    await ledger.append(depositDraft('d2', '50', '2026-10-03T08:00:00Z'));
    expect(ledger.balances({ asOf: '2026-10-02T00:00:00Z' }).get(bank)?.amount).toBe(chf(100));
    expect(ledger.balances().get(bank)?.amount).toBe(chf(150));
  });
});
