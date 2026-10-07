import { describe, expect, it } from 'vitest';
import { accounts } from '../src/capital/accounts.js';
import { proposeAllocation, type AllocationPolicy } from '../src/capital/capital-allocator.js';
import { CapitalRuleError } from '../src/capital/capital-engine.js';
import { proposeReallocations } from '../src/capital/capital-reallocation.js';
import type { InstrumentInfo, MarketDataSnapshot } from '../src/capital/capital-types.js';
import { InventoryService } from '../src/inventory/inventory-service.js';
import { Decimal } from '../src/money/decimal.js';
import { chf } from '../src/money/money.js';
import { createOpportunity } from '../src/opportunities/opportunity-engine.js';
import { assessReallocationProposal } from '../src/risk-engine.js';
import { chewingGum, fmt, identityHolds, newEngine, newInventory, policy, sequentialIds, T0 } from './helpers.js';

const bank = accounts.bank('ubs');
const ibkr = accounts.brokerCash('ibkr');

const AAPL: InstrumentInfo = { instrumentId: 'AAPL', symbol: 'AAPL', assetClass: 'stock', currency: 'USD', settlementDays: 1 };

describe('Beispiel aus der Spezifikation: 100 CHF Start, 20 Reserve, 10 Ware, 30 Broker', () => {
  it('berechnet Gesamtvermögen, verfügbares, gebundenes und investiertes Kapital exakt', async () => {
    const { engine, inventory } = await newInventory(policy({ safetyReserve: { minimumChf: chf(20), percentOfNetWorthBp: 0 } }));
    inventory.registerProduct(chewingGum({ productId: 'ware', sourcing: { unitCostChf: chf(10), maxUnitsAvailable: 10 } }));

    await engine.deposit({ to: bank, amountChf: chf(100) });
    await inventory.recordPurchase({ productId: 'ware', quantity: 1, purchaseCostChf: chf(10), paidFrom: bank });
    await engine.transfer({ from: bank, to: ibkr, amountChf: chf(30) });
    await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'AAPL', quantity: '0.12', grossAmountChf: chf(30) });

    const s = engine.capitalState({ instruments: [AAPL] });
    expect(fmt(s.totalNetWorthChf)).toBe('100.00');
    expect(fmt(s.cash.totalChf)).toBe('60.00');
    expect(fmt(s.safetyReserveChf)).toBe('20.00');
    expect(fmt(s.availableCapitalChf)).toBe('40.00');
    expect(fmt(s.investedCapitalChf)).toBe('40.00');
    expect(fmt(s.financialAssetsChf)).toBe('30.00');
    expect(fmt(s.physicalInventoryCostChf)).toBe('10.00');
    expect(fmt(s.boundCapitalChf)).toBe('40.00');
    expect(s.dataStatus.financialMarketData).toBe('not_connected');
    expect(identityHolds(s)).toBe(true);
  });
});

describe('1. Einzahlung', () => {
  it('erhöht Cash, Vermögen und Einlagen; P&L bleibt 0', async () => {
    const { engine, ledger } = await newEngine();
    const entry = await engine.deposit({ to: bank, amountChf: chf(500), id: 'bank-2026-10-01-001' });

    const s = engine.capitalState();
    expect(entry.type).toBe('deposit');
    expect(fmt(s.totalNetWorthChf)).toBe('500.00');
    expect(fmt(s.cash.bankChf)).toBe('500.00');
    expect(fmt(s.availableCapitalChf)).toBe('500.00');
    expect(fmt(s.netContributionsChf)).toBe('500.00');
    expect(fmt(s.pnl.totalChf)).toBe('0.00');
    expect(s.pnl.returnSinceStartBp).toBe(0);
    expect(s.dataStatus.financialMarketData).toBe('not_required');
    expect(ledger.verifyIntegrity()).toEqual({ ok: true });
  });

  it('lehnt ungültige Einzahlungen ab', async () => {
    const { engine, ledger } = await newEngine();
    await expect(engine.deposit({ to: bank, amountChf: chf(0) })).rejects.toThrow(CapitalRuleError);
    await expect(engine.deposit({ to: accounts.position('ibkr', 'AAPL'), amountChf: chf(10) })).rejects.toThrow(CapitalRuleError);
    await expect(engine.deposit({ to: bank, amountChf: 100 as never })).rejects.toThrow(CapitalRuleError);
    expect(ledger.size).toBe(0);
  });
});

describe('2. Brokerkauf', () => {
  it('bucht Position zu Kosten, Gebühr als Aufwand und zeigt DATA NOT CONNECTED ohne Kurs', async () => {
    const { engine } = await newEngine();
    await engine.deposit({ to: bank, amountChf: chf(500) });
    await engine.transfer({ from: bank, to: ibkr, amountChf: chf(200) });
    await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'AAPL', quantity: 2, grossAmountChf: chf(100), feeChf: chf(1), tradeId: 't1' });

    const { capital: s, positions } = engine.snapshot({ instruments: [AAPL] });
    const [aapl] = positions;
    expect(fmt(s.cash.bankChf)).toBe('300.00');
    expect(fmt(s.cash.brokerCashChf)).toBe('99.00');
    expect(aapl?.quantity.toString()).toBe('2');
    expect(fmt(aapl?.costBasisChf ?? null)).toBe('100.00');
    expect(aapl?.averageCostChf?.toString()).toBe('50');
    expect(fmt(aapl?.feesChf ?? null)).toBe('1.00');
    expect(aapl?.priceStatus).toBe('not_connected');
    expect(aapl?.marketValueChf).toBeNull();
    expect(fmt(s.financialAssetsChf)).toBe('100.00');
    expect(fmt(s.totalNetWorthChf)).toBe('499.00');
    expect(s.pnl.unrealizedChf).toBeNull();
    expect(s.dataStatus.financialMarketData).toBe('not_connected');
    expect(s.dataStatus.unpricedPositions).toEqual(['ibkr:AAPL']);
    expect(identityHolds(s)).toBe(true);
  });

  it('bewertet nur mit frischem Kurs und FX-Kurs', async () => {
    const { engine } = await newEngine();
    await engine.deposit({ to: ibkr, amountChf: chf(200) });
    await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'AAPL', quantity: 2, grossAmountChf: chf(100) });
    const market: MarketDataSnapshot = {
      quotes: [{ instrumentId: 'AAPL', price: Decimal.from('55.10'), currency: 'USD', asOf: T0, source: 'test-fixture' }],
      fxRates: [{ currency: 'USD', rate: Decimal.from('0.8950'), asOf: T0, source: 'test-fixture' }],
    };

    const live = engine.snapshot({ market, instruments: [AAPL] });
    expect(live.positions[0]?.priceStatus).toBe('live');
    expect(fmt(live.positions[0]?.marketValueChf ?? null)).toBe('98.63'); // 2 x 55.10 x 0.8950 = 98.629
    expect(fmt(live.capital.pnl.unrealizedChf)).toBe('-1.37');
    expect(fmt(live.capital.totalNetWorthChf)).toBe('198.63');
    expect(live.capital.dataStatus.financialMarketData).toBe('complete');

    const noFx = engine.snapshot({ market: { quotes: market.quotes }, instruments: [AAPL] });
    expect(noFx.positions[0]?.marketValueChf).toBeNull();

    const stale = engine.snapshot({ market, instruments: [AAPL], asOf: '2026-10-01T09:00:00.000Z' });
    expect(stale.positions[0]?.priceStatus).toBe('stale');
    expect(fmt(stale.capital.financialAssetsChf)).toBe('100.00');
    expect(stale.capital.dataStatus.stalePositions).toEqual(['ibkr:AAPL']);
  });

  it('verhindert Käufe ohne Deckung', async () => {
    const { engine, ledger } = await newEngine();
    await engine.deposit({ to: ibkr, amountChf: chf(50) });
    await expect(engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'AAPL', quantity: 1, grossAmountChf: chf(50), feeChf: chf(1) })).rejects.toMatchObject({
      code: 'guard_rejected',
    });
    expect(ledger.size).toBe(1);
  });
});

describe('3. Brokerverkauf', () => {
  it('realisiert Gewinn mit Durchschnittskosten und hinterlässt keine Rundungsreste', async () => {
    const { engine } = await newEngine();
    await engine.deposit({ to: ibkr, amountChf: chf(200) });
    await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 3, grossAmountChf: chf(100) });

    await engine.recordTradeSell({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 1, grossProceedsChf: chf(40), feeChf: chf(1) });
    let acme = engine.snapshot().positions[0];
    expect(fmt(acme?.costBasisChf ?? null)).toBe('66.67'); // 100 - 33.33
    expect(fmt(acme?.realizedPnlChf ?? null)).toBe('6.67');

    await engine.recordTradeSell({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 2, grossProceedsChf: chf(70) });
    const snapshot = engine.snapshot();
    acme = snapshot.positions[0];
    expect(acme?.isOpen).toBe(false);
    expect(acme?.costBasisChf).toBe(0n);
    expect(fmt(acme?.realizedPnlChf ?? null)).toBe('10.00');
    expect(fmt(acme?.feesChf ?? null)).toBe('1.00');
    expect(fmt(snapshot.capital.cash.brokerCashChf)).toBe('209.00');
    expect(fmt(snapshot.capital.pnl.realizedChf)).toBe('9.00');
    expect(fmt(snapshot.capital.pnl.totalChf)).toBe('9.00');
    expect(snapshot.capital.pnl.returnSinceStartBp).toBe(450);
  });

  it('verhindert Verkauf von mehr als gehalten (auch bei parallelen Aufrufen)', async () => {
    const { engine } = await newEngine();
    await engine.deposit({ to: ibkr, amountChf: chf(100) });
    await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 1, grossAmountChf: chf(100) });

    const results = await Promise.allSettled([
      engine.recordTradeSell({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 1, grossProceedsChf: chf(101) }),
      engine.recordTradeSell({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 1, grossProceedsChf: chf(101) }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(fmt(engine.capitalState().cash.brokerCashChf)).toBe('101.00');
  });
});

describe('4. Warenkauf', () => {
  it('aktiviert Einstandskosten inkl. Lieferkosten und Zoll; Vermögen bleibt gleich', async () => {
    const { engine, inventory } = await newInventory();
    await engine.deposit({ to: bank, amountChf: chf(500) });
    await inventory.recordPurchase({
      productId: 'kaugummi',
      quantity: 10,
      purchaseCostChf: chf(150),
      landedCosts: { shippingChf: chf(15), customsChf: chf(5) },
      paidFrom: bank,
    });

    const stock = inventory.stock('kaugummi');
    expect(stock.onHand.toString()).toBe('10');
    expect(fmt(stock.costBasisChf)).toBe('170.00');
    expect(stock.averageUnitCostChf?.toString()).toBe('17');
    const s = engine.capitalState();
    expect(fmt(s.cash.bankChf)).toBe('330.00');
    expect(fmt(s.physicalInventoryCostChf)).toBe('170.00');
    expect(s.physicalInventoryMarketValueChf).toBeNull();
    expect(s.dataStatus.inventoryMarketData).toBe('not_connected');
    expect(fmt(s.totalNetWorthChf)).toBe('500.00');
  });

  it('lehnt unbekannte Produkte und ungedeckte Käufe ab', async () => {
    const { engine, inventory } = await newInventory();
    await engine.deposit({ to: bank, amountChf: chf(50) });
    await expect(inventory.recordPurchase({ productId: 'unbekannt', quantity: 1, purchaseCostChf: chf(10), paidFrom: bank })).rejects.toThrow();
    await expect(inventory.recordPurchase({ productId: 'kaugummi', quantity: 5, purchaseCostChf: chf(100), paidFrom: bank })).rejects.toMatchObject({
      code: 'guard_rejected',
    });
  });
});

describe('5. Warenverkauf', () => {
  it('500-CHF-Challenge: Kauf 20, Verkauf 35, Gebühren 5 → Vermögen 510', async () => {
    const { engine, inventory, ledger } = await newInventory();
    await engine.deposit({ to: bank, amountChf: chf(500) });
    await inventory.recordPurchase({ productId: 'kaugummi', quantity: 1, purchaseCostChf: chf(20), paidFrom: bank });
    const sale = await inventory.recordSale({
      productId: 'kaugummi',
      quantity: 1,
      grossRevenueChf: chf(35),
      channel: 'ricardo',
      costs: { marketplaceFeeChf: chf('3.50'), paymentFeeChf: chf('1.50') },
      settlement: { kind: 'cash', account: bank },
    });

    const s = engine.capitalState();
    expect(fmt(s.totalNetWorthChf)).toBe('510.00');
    expect(fmt(s.pnl.realizedChf)).toBe('10.00');
    expect(fmt(s.pnl.totalChf)).toBe('10.00');
    expect(s.pnl.returnSinceStartBp).toBe(200);
    expect(fmt(ledger.balance(accounts.salesRevenue('kaugummi')).amount)).toBe('-35.00');
    expect(fmt(ledger.balance(accounts.cogs('kaugummi')).amount)).toBe('20.00');
    expect(sale.postings.reduce((sum, p) => sum + p.amount, 0n)).toBe(0n);
    const stock = inventory.stock('kaugummi');
    expect(stock.onHand.toString()).toBe('0');
    expect(stock.soldTotal.toString()).toBe('1');
  });

  it('Marketplace-Auszahlung: Forderung zählt erst nach Zahlungseingang als verfügbar', async () => {
    const { engine, inventory } = await newInventory();
    await engine.deposit({ to: bank, amountChf: chf(100) });
    await inventory.recordPurchase({ productId: 'kaugummi', quantity: 2, purchaseCostChf: chf(40), paidFrom: bank });
    await inventory.recordSale({
      productId: 'kaugummi',
      quantity: 1,
      grossRevenueChf: chf(35),
      channel: 'ricardo',
      costs: { marketplaceFeeChf: chf(5) },
      settlement: { kind: 'receivable', counterpartyId: 'ricardo' },
    });

    let s = engine.capitalState();
    expect(fmt(s.receivablesChf)).toBe('30.00');
    expect(fmt(s.availableCapitalChf)).toBe('60.00');
    expect(fmt(s.totalNetWorthChf)).toBe('110.00');
    expect(identityHolds(s)).toBe(true);

    await engine.settleReceivable({ receivable: accounts.receivable('ricardo'), to: bank, amountChf: chf(30) });
    s = engine.capitalState();
    expect(s.receivablesChf).toBe(0n);
    expect(fmt(s.availableCapitalChf)).toBe('90.00');
    expect(fmt(s.totalNetWorthChf)).toBe('110.00');
  });

  it('verkauft nie mehr als am Lager', async () => {
    const { engine, inventory } = await newInventory();
    await engine.deposit({ to: bank, amountChf: chf(100) });
    await inventory.recordPurchase({ productId: 'kaugummi', quantity: 1, purchaseCostChf: chf(20), paidFrom: bank });
    await expect(
      inventory.recordSale({ productId: 'kaugummi', quantity: 2, grossRevenueChf: chf(70), channel: 'ricardo', settlement: { kind: 'cash', account: bank } }),
    ).rejects.toMatchObject({ code: 'guard_rejected' });
  });
});

describe('6. Gebühren', () => {
  it('bucht bezahlte und geschuldete Gebühren; Schulden reduzieren das verfügbare Kapital', async () => {
    const { engine } = await newEngine();
    await engine.deposit({ to: bank, amountChf: chf(100) });
    await engine.recordExpense({ category: 'fee', feeKind: 'bank', amountChf: chf('2.50'), paidFrom: bank });
    await engine.recordExpense({ category: 'fee', feeKind: 'custody', amountChf: chf(1), owedTo: accounts.payable('ibkr') });

    let s = engine.capitalState();
    expect(fmt(s.totalNetWorthChf)).toBe('96.50');
    expect(fmt(s.liabilitiesChf)).toBe('1.00');
    expect(fmt(s.cash.bankChf)).toBe('97.50');
    expect(fmt(s.availableCapitalChf)).toBe('96.50');
    expect(fmt(s.pnl.realizedChf)).toBe('-3.50');

    await engine.payLiability({ liability: accounts.payable('ibkr'), from: bank, amountChf: chf(1) });
    s = engine.capitalState();
    expect(s.liabilitiesChf).toBe(0n);
    expect(fmt(s.availableCapitalChf)).toBe('96.50'); // paying a known liability does not change availability
    await expect(engine.payLiability({ liability: accounts.payable('ibkr'), from: bank, amountChf: chf(1) })).rejects.toMatchObject({
      code: 'guard_rejected',
    });
  });

  it('ordnet Handelsgebühren der Position zu', async () => {
    const { engine } = await newEngine();
    await engine.deposit({ to: ibkr, amountChf: chf(100) });
    await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 1, grossAmountChf: chf(50), feeChf: chf('0.85') });
    await engine.recordTradeSell({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 1, grossProceedsChf: chf(50), feeChf: chf('0.85') });
    const [acme] = engine.snapshot().positions;
    expect(fmt(acme?.feesChf ?? null)).toBe('1.70');
    expect(fmt(acme?.realizedPnlChf ?? null)).toBe('0.00');
    expect(fmt(engine.capitalState().totalNetWorthChf)).toBe('98.30');
  });
});

describe('7. Reserviertes Kapital', () => {
  it('Reservationen senken das verfügbare, aber nicht das Gesamtvermögen', async () => {
    const { engine } = await newEngine();
    await engine.deposit({ to: bank, amountChf: chf(500) });
    await engine.transfer({ from: bank, to: ibkr, amountChf: chf(200) });
    await engine.reserveCash({ reservationId: 'res-1', from: bank, amountChf: chf(100), purpose: 'earmark' });
    await engine.reserveCash({ reservationId: 'ord-1', from: ibkr, amountChf: chf(50), purpose: 'open_order' });
    await engine.reserveCash({ reservationId: 'po-1', from: bank, amountChf: chf(80), purpose: 'purchase_commitment' });

    const s = engine.capitalState();
    expect(fmt(s.totalNetWorthChf)).toBe('500.00');
    expect(fmt(s.cash.bankChf)).toBe('300.00');
    expect(fmt(s.cash.unreservedChf)).toBe('270.00');
    expect(fmt(s.reservedCapitalChf)).toBe('100.00');
    expect(fmt(s.committedCapitalChf)).toBe('130.00');
    expect(fmt(s.availableCapitalChf)).toBe('270.00');
    expect(fmt(s.boundCapitalChf)).toBe('230.00');
    expect(identityHolds(s)).toBe(true);
  });

  it('Order aus Reservation bezahlen, Rest freigeben; keine Doppel- oder Überreservation', async () => {
    const { engine } = await newEngine();
    await engine.deposit({ to: ibkr, amountChf: chf(100) });
    await engine.reserveCash({ reservationId: 'ord-1', from: ibkr, amountChf: chf(50), purpose: 'open_order' });
    await expect(engine.reserveCash({ reservationId: 'ord-1', from: ibkr, amountChf: chf(1), purpose: 'open_order' })).rejects.toThrow(/already in use/);
    await expect(engine.reserveCash({ reservationId: 'ord-2', from: ibkr, amountChf: chf(51), purpose: 'open_order' })).rejects.toMatchObject({
      code: 'guard_rejected',
    });

    const reservation = accounts.reservation(ibkr, 'open_order', 'ord-1');
    await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 1, grossAmountChf: chf(45), feeChf: chf(1), payFrom: reservation });
    expect(fmt(engine.capitalState().committedCapitalChf)).toBe('4.00');

    await engine.releaseReservation({ reservationId: 'ord-1' });
    const s = engine.capitalState();
    expect(s.committedCapitalChf).toBe(0n);
    expect(fmt(s.availableCapitalChf)).toBe('54.00');
    await expect(engine.releaseReservation({ reservationId: 'ord-1' })).rejects.toThrow(/nothing left/);
  });
});

describe('8. Sicherheitsreserve', () => {
  it('nimmt das Maximum aus Mindestbetrag und Prozentsatz, aufgerundet', async () => {
    const { engine } = await newEngine(policy({ safetyReserve: { minimumChf: chf(50), percentOfNetWorthBp: 1000 } }));
    await engine.deposit({ to: bank, amountChf: chf(300) });
    expect(fmt(engine.capitalState().safetyReserveChf)).toBe('50.00');
    expect(fmt(engine.capitalState().availableCapitalChf)).toBe('250.00');

    await engine.deposit({ to: bank, amountChf: chf('700.05') });
    const s = engine.capitalState();
    expect(fmt(s.safetyReserveChf)).toBe('100.01'); // 10 % of 1000.05 = 100.005 → rounded up
    expect(fmt(s.availableCapitalChf)).toBe('900.04');
  });

  it('meldet eine Unterdeckung statt negativem verfügbarem Kapital', async () => {
    const { engine } = await newEngine(policy({ safetyReserve: { minimumChf: chf(50), percentOfNetWorthBp: 0 } }));
    await engine.deposit({ to: ibkr, amountChf: chf(100) });
    await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 1, grossAmountChf: chf(60) });
    const s = engine.capitalState();
    expect(s.availableCapitalChf).toBe(0n);
    expect(fmt(s.capitalShortfallChf)).toBe('10.00');
    expect(identityHolds(s)).toBe(true);
  });
});

describe('9. Verfügbares Kapital', () => {
  it('Wasserfall: Cash − Reservationen − Zusagen − Verbindlichkeiten − Reserve; Forderungen zählen nicht', async () => {
    const { engine, inventory } = await newInventory(policy({ safetyReserve: { minimumChf: chf(100), percentOfNetWorthBp: 0 } }));
    inventory.registerProduct(chewingGum({ productId: 'akku', sourcing: { unitCostChf: chf(10), maxUnitsAvailable: 100 } }));

    await engine.deposit({ to: bank, amountChf: chf(1000) });
    await engine.transfer({ from: bank, to: ibkr, amountChf: chf(300) });
    await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'MSFT', quantity: '0.5', grossAmountChf: chf(200), feeChf: chf(2) });
    await inventory.recordPurchase({ productId: 'akku', quantity: 10, purchaseCostChf: chf(100), owedTo: accounts.payable('supplier') });
    await engine.reserveCash({ reservationId: 'saving-goal', from: bank, amountChf: chf(50), purpose: 'earmark' });
    await engine.reserveCash({ reservationId: 'po-77', from: bank, amountChf: chf(70), purpose: 'purchase_commitment' });
    await inventory.recordSale({
      productId: 'akku',
      quantity: 4,
      grossRevenueChf: chf(80),
      channel: 'ricardo',
      costs: { marketplaceFeeChf: chf(8) },
      settlement: { kind: 'receivable', counterpartyId: 'ricardo' },
    });

    let s = engine.capitalState();
    expect(fmt(s.cash.totalChf)).toBe('798.00');
    expect(fmt(s.cash.unreservedChf)).toBe('678.00');
    expect(fmt(s.liabilitiesChf)).toBe('100.00');
    expect(fmt(s.receivablesChf)).toBe('72.00');
    expect(fmt(s.physicalInventoryCostChf)).toBe('60.00');
    expect(fmt(s.availableCapitalChf)).toBe('478.00'); // 678 - 100 liabilities - 100 reserve
    expect(fmt(s.totalNetWorthChf)).toBe('1030.00');
    expect(fmt(s.investedCapitalChf)).toBe('260.00');
    expect(fmt(s.boundCapitalChf)).toBe('380.00');
    expect(fmt(s.pnl.realizedChf)).toBe('30.00');
    expect(identityHolds(s)).toBe(true);

    await engine.settleReceivable({ receivable: accounts.receivable('ricardo'), to: bank, amountChf: chf(72) });
    await engine.payLiability({ liability: accounts.payable('supplier'), from: bank, amountChf: chf(100) });
    s = engine.capitalState();
    expect(fmt(s.availableCapitalChf)).toBe('550.00');
    expect(fmt(s.totalNetWorthChf)).toBe('1030.00');
    expect(identityHolds(s)).toBe(true);
  });

  it('rekonstruiert jeden historischen Stand aus dem Ledger', async () => {
    const { engine } = await newEngine();
    await engine.deposit({ to: bank, amountChf: chf(500), occurredAt: '2026-09-01T08:00:00Z' });
    await engine.recordExpense({ category: 'fee', feeKind: 'bank', amountChf: chf(5), paidFrom: bank, occurredAt: '2026-09-15T08:00:00Z' });
    expect(fmt(engine.capitalState({ asOf: '2026-09-10T00:00:00Z' }).totalNetWorthChf)).toBe('500.00');
    expect(fmt(engine.capitalState().totalNetWorthChf)).toBe('495.00');
  });
});

describe('10. Kapitalumschichtung', () => {
  it('schlägt Umschichtung vor (Mensch muss freigeben) und bucht sie nach Freigabe konsistent', async () => {
    const { engine } = await newEngine(policy({ safetyReserve: { minimumChf: chf(20), percentOfNetWorthBp: 0 } }));
    const inventory = new InventoryService(engine);
    inventory.registerProduct(chewingGum({ productId: 'akku', sourcing: { unitCostChf: chf(10), maxUnitsAvailable: 10 } }));
    const acmeInfo: InstrumentInfo = { instrumentId: 'ACME', symbol: 'ACME', assetClass: 'stock', currency: 'CHF', settlementDays: 2 };
    const market: MarketDataSnapshot = { quotes: [{ instrumentId: 'ACME', price: Decimal.from(10), currency: 'CHF', asOf: T0, source: 'test-fixture' }] };

    await engine.deposit({ to: ibkr, amountChf: chf(120) });
    await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 10, grossAmountChf: chf(100) });
    const before = engine.snapshot({ market, instruments: [acmeInfo] });
    expect(before.capital.availableCapitalChf).toBe(0n);

    const product = createOpportunity({
      id: 'opp-akku',
      type: 'physical_product',
      name: 'Akku-Handel',
      requiredCapitalChf: chf(100),
      sizing: { kind: 'scalable', minTicketChf: chf(10), maxCapitalChf: chf(100), lotSizeChf: chf(10) },
      expectedNetProfitChf: chf(25),
      downsideChf: chf(30),
      expectedHoldingDays: 14,
      liquidityScore: 0.4,
      confidenceScore: 0.8,
      riskScore: 0.45,
      effortScore: 0.3,
      regulatoryRiskScore: 0.05,
      thesis: ['25 % erwartete Rendite in 14 Tagen'],
      risks: ['Verkaufsgeschwindigkeit'],
      exitPlan: 'Abverkauf über Ricardo, Rest zum Restwert',
      estimates: { source: 'manual', dataStatus: 'connected', asOf: T0, calibrated: false },
    });
    const allocationPolicy: AllocationPolicy = {
      maxDeploymentBpOfAvailable: 10_000,
      maxPerOpportunityChf: chf(1000),
      maxPerOpportunityBpOfNetWorth: 10_000,
      maxBucketExposureBpOfNetWorth: { equities: 10_000, physical_trade: 10_000 },
      maxNewDownsideBpOfNetWorth: 10_000,
      minOpportunityScore: 0,
      minConfidenceScore: 0,
      maxRiskScore: 1,
      humanApproval: { thresholdChf: chf(1000), thresholdBpOfNetWorth: 10_000 },
    };
    const allocation = proposeAllocation({ id: 'alloc-1', at: T0, snapshot: before, opportunities: [product], policy: allocationPolicy });
    expect(allocation.allocations).toHaveLength(0); // no free cash: only a reallocation can fund it

    const { proposals } = proposeReallocations({
      at: T0,
      newId: sequentialIds('realloc'),
      snapshot: before,
      opportunities: [product],
      allocation,
      forecasts: [
        { brokerId: 'ibkr', instrumentId: 'ACME', expectedReturnBp: 300, horizonDays: 30, riskScore: 0.3, source: 'quant', dataStatus: 'connected', asOf: T0 },
      ],
      exitCosts: { commissionChf: chf(0), spreadBp: 0, taxOnGainBp: 0 },
      policy: {
        maxReductionBpOfPosition: 3000,
        maxReallocationBpOfNetWorth: 5000,
        minNetAdvantageChf: chf(1),
        minNetAdvantageBpOfAmount: 300,
        minOpportunityConfidence: 0.6,
        minOpportunityScore: 0,
        maxAdditionalRiskScore: 0.3,
        assumedSettlementDaysIfUnknown: 2,
      },
    });

    expect(proposals).toHaveLength(1);
    const [proposal] = proposals;
    if (!proposal) throw new Error('expected a proposal');
    expect(fmt(proposal.from.reduceByChf)).toBe('30.00');
    expect(fmt(proposal.to.amountChf)).toBe('30.00');
    expect(proposal.from.estimatedQuantity.toString()).toBe('3');
    expect(fmt(proposal.economics.keepExpectedChf)).toBe('0.48'); // 30 x 3 % x 16/30 days
    expect(fmt(proposal.economics.switchExpectedChf)).toBe('4.20'); // risk-adjusted (0.8 x 25 - 0.2 x 30) x 30/100
    expect(proposal.requiresHumanApproval).toBe(true);
    const gate = assessReallocationProposal(proposal, before);
    expect(gate).toEqual({ passed: true, requiresHumanApproval: true, reasons: [] });

    // After explicit human approval (out of scope here), the executed moves are recorded:
    await engine.recordTradeSell({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 3, grossProceedsChf: chf(30) });
    await inventory.recordPurchase({ productId: 'akku', quantity: 3, purchaseCostChf: chf(30), paidFrom: ibkr, opportunityId: 'opp-akku' });

    const after = engine.snapshot({ market, instruments: [acmeInfo] });
    expect(fmt(after.capital.totalNetWorthChf)).toBe('120.00');
    expect(fmt(after.capital.financialAssetsChf)).toBe('70.00');
    expect(fmt(after.capital.physicalInventoryCostChf)).toBe('30.00');
    expect(fmt(after.capital.availableCapitalChf)).toBe('0.00');
    expect(identityHolds(after.capital)).toBe(true);
  });
});

describe('Korrekturen', () => {
  it('storniert einen Trade vollständig, ohne die Historie zu verändern', async () => {
    const { engine, ledger } = await newEngine();
    await engine.deposit({ to: ibkr, amountChf: chf(100) });
    const buy = await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 1, grossAmountChf: chf(50), feeChf: chf(1) });
    await engine.reverse({ entryId: buy.id, reason: 'duplicate fill from broker sync' });

    const s = engine.snapshot();
    expect(fmt(s.capital.cash.brokerCashChf)).toBe('100.00');
    expect(s.positions[0]?.isOpen).toBe(false);
    expect(ledger.size).toBe(3);
    expect(ledger.get(buy.id)).toBe(buy);
    await expect(engine.reverse({ entryId: buy.id, reason: 'again' })).rejects.toMatchObject({ code: 'already_reversed' });
  });

  it('kann keine Einzahlung stornieren, deren Geld schon ausgegeben ist', async () => {
    const { engine } = await newEngine();
    const deposit = await engine.deposit({ to: ibkr, amountChf: chf(100) });
    await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 1, grossAmountChf: chf(80) });
    await expect(engine.reverse({ entryId: deposit.id, reason: 'test' })).rejects.toMatchObject({ code: 'guard_rejected' });
  });
});
