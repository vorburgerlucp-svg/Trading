import { describe, expect, it } from 'vitest';
import { accounts } from '../src/capital/accounts.js';
import { calculateUnitEconomics, InventoryError } from '../src/inventory/inventory-service.js';
import { chf } from '../src/money/money.js';
import { createOpportunity } from '../src/opportunities/opportunity-engine.js';
import { chewingGum, fmt, newInventory } from './helpers.js';

const bank = accounts.bank('ubs');

describe('Unit Economics', () => {
  it('Kaugummi: Einkauf 20, Erlös 35, Kosten 5 → Netto 10, ROI 50 %, 7 Tage Kapitalbindung', () => {
    const product = chewingGum();
    const e = calculateUnitEconomics({
      unitCostChf: product.sourcing.unitCostChf,
      salePriceChf: product.pricing.expectedSalePriceChf,
      costs: product.sellingCosts,
      expectedDaysToSell: product.demand.expectedDaysToSell,
    });
    expect(fmt(e.sellingCostsChf)).toBe('5.00');
    expect(fmt(e.netProfitChf)).toBe('10.00');
    expect(e.roiBp).toBe(5000);
    expect(e.marginBp).toBe(2857);
    expect(e.capitalBindingDays).toBe(7);
  });

  it('zieht enthaltene MWST ab und rundet Kosten konservativ auf', () => {
    const e = calculateUnitEconomics({
      unitCostChf: chf(50),
      salePriceChf: chf('108.10'),
      costs: { ...chewingGum().sellingCosts, vatRateBp: 810, marketplaceFeeBp: 999, paymentFixedChf: chf(0), returnReserveBp: 250 },
      expectedDaysToSell: 10,
    });
    expect(fmt(e.vatChf)).toBe('8.10');
    expect(fmt(e.netRevenueChf)).toBe('100.00');
    expect(fmt(e.marketplaceFeeChf)).toBe('10.80'); // 108.10 x 9.99 % = 10.79919 → up
    expect(fmt(e.returnReserveChf)).toBe('2.71'); // 2.7025 → up
    expect(fmt(e.netProfitChf)).toBe('36.49');
  });
});

describe('InventoryService', () => {
  it('bucht MWST beim Verkauf als Verbindlichkeit', async () => {
    const { engine, inventory, ledger } = await newInventory();
    await engine.deposit({ to: bank, amountChf: chf(100) });
    await inventory.recordPurchase({ productId: 'kaugummi', quantity: 1, purchaseCostChf: chf(50), paidFrom: bank });
    await inventory.recordSale({
      productId: 'kaugummi',
      quantity: 1,
      grossRevenueChf: chf('108.10'),
      channel: 'shop',
      costs: { vatChf: chf('8.10') },
      settlement: { kind: 'cash', account: bank },
    });
    const s = engine.capitalState();
    expect(fmt(s.liabilitiesChf)).toBe('8.10');
    expect(fmt(ledger.balance(accounts.salesRevenue('kaugummi')).amount)).toBe('-100.00');
    expect(fmt(s.totalNetWorthChf)).toBe('150.00');
    expect(fmt(s.availableCapitalChf)).toBe('150.00'); // 158.10 cash - 8.10 VAT owed
  });

  it('reserviert Einheiten für offene Bestellungen und verkauft aus der Reservation', async () => {
    const { engine, inventory } = await newInventory();
    await engine.deposit({ to: bank, amountChf: chf(100) });
    await inventory.recordPurchase({ productId: 'kaugummi', quantity: 3, purchaseCostChf: chf(60), paidFrom: bank });
    await inventory.reserveUnits({ productId: 'kaugummi', quantity: 1 });

    let stock = inventory.stock('kaugummi');
    expect(stock.onHand.toString()).toBe('3');
    expect(stock.reserved.toString()).toBe('1');
    expect(stock.free.toString()).toBe('2');
    expect(fmt(stock.costBasisChf)).toBe('60.00');
    await expect(inventory.reserveUnits({ productId: 'kaugummi', quantity: 3 })).rejects.toThrow(/only 2 units/);

    await inventory.recordSale({
      productId: 'kaugummi',
      quantity: 1,
      grossRevenueChf: chf(35),
      channel: 'ricardo',
      settlement: { kind: 'cash', account: bank },
      fromReserved: true,
    });
    stock = inventory.stock('kaugummi');
    expect(stock.reserved.toString()).toBe('0');
    expect(stock.onHand.toString()).toBe('2');
    expect(stock.soldTotal.toString()).toBe('1');
    expect(fmt(stock.costBasisChf)).toBe('40.00');
  });

  it('zählt stornierte Verkäufe nicht als verkauft', async () => {
    const { engine, inventory } = await newInventory();
    await engine.deposit({ to: bank, amountChf: chf(100) });
    await inventory.recordPurchase({ productId: 'kaugummi', quantity: 2, purchaseCostChf: chf(40), paidFrom: bank });
    const sale = await inventory.recordSale({ productId: 'kaugummi', quantity: 1, grossRevenueChf: chf(35), channel: 'ricardo', settlement: { kind: 'cash', account: bank } });
    await engine.reverse({ entryId: sale.id, reason: 'buyer cancelled' });
    const stock = inventory.stock('kaugummi');
    expect(stock.soldTotal.toString()).toBe('0');
    expect(stock.onHand.toString()).toBe('2');
  });

  it('wandelt ein Produkt in eine vergleichbare Opportunity um', async () => {
    const { inventory } = await newInventory();
    const opportunity = createOpportunity(inventory.toOpportunityInput('kaugummi'));
    expect(opportunity.type).toBe('reselling');
    expect(opportunity.bucket).toBe('physical_trade');
    expect(fmt(opportunity.requiredCapitalChf)).toBe('20.00'); // capacity: 1 unit sellable
    expect(fmt(opportunity.expectedNetProfitChf)).toBe('10.00');
    expect(fmt(opportunity.downsideChf)).toBe('10.00'); // 20 cost - 10 salvage
    expect(opportunity.scores.expectedReturnBp).toBe(5000);
    expect(opportunity.eligibility.eligible).toBe(true);
    expect(opportunity.sizing).toEqual({ kind: 'scalable', minTicketChf: chf(20), maxCapitalChf: chf(20), lotSizeChf: chf(20) });
  });

  it('markiert Produkte ohne verbundene Preisdaten oder mit regulatorischer Sperre als nicht finanzierbar', async () => {
    const { inventory } = await newInventory();
    inventory.registerProduct(chewingGum({ productId: 'ohne-daten', pricing: { ...chewingGum().pricing, dataStatus: 'not_connected' } }));
    inventory.registerProduct(chewingGum({ productId: 'gesperrt', risk: { ...chewingGum().risk, regulatoryBlocked: true } }));
    expect(createOpportunity(inventory.toOpportunityInput('ohne-daten')).eligibility.reasons[0]).toMatch(/^DATA NOT CONNECTED/);
    expect(createOpportunity(inventory.toOpportunityInput('gesperrt')).eligibility.reasons).toContain('regulatory block');
  });

  it('validiert Produktstammdaten', async () => {
    const { inventory } = await newInventory();
    expect(() => inventory.registerProduct(chewingGum({ productId: 'bad:id' }))).toThrow(InventoryError);
    expect(() => inventory.registerProduct(chewingGum({ productId: 'x', salesChannels: [] }))).toThrow(/sales channel/);
    expect(() =>
      inventory.registerProduct(chewingGum({ productId: 'y', sellingCosts: { ...chewingGum().sellingCosts, marketplaceFeeBp: 12.5 } })),
    ).toThrow(/marketplaceFeeBp/);
  });
});
