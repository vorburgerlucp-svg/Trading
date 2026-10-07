// Physical inventory: product master data, unit economics, and ledger bookings for purchases,
// sales and unit reservations. Stock levels are derived from the capital ledger, never stored twice.
// No purchase order is ever sent to a supplier from here: bookings record what already happened.

import { accounts } from '../capital/accounts.js';
import {
  CapitalRuleError,
  releasedCost,
  requireKind,
  requireNonNegative,
  requirePositive,
  requirePositiveQuantity,
  type CapitalEngine,
  type CommandMeta,
} from '../capital/capital-engine.js';
import type { AccountKey, JournalEntry } from '../capital/capital-types.js';
import { Decimal, divRound, type DecimalInput } from '../money/decimal.js';
import {
  addChf,
  applyBp,
  BASIS_POINTS,
  chfToDecimal,
  formatChf,
  negChf,
  ratioBp,
  rappen,
  subChf,
  ZERO_CHF,
  type Rappen,
} from '../money/money.js';
import type { OpportunityInput } from '../opportunities/opportunity-types.js';
import type { ProductDefinition, SaleCosts, SaleSettlement, SellingCostModel, StockLevel, UnitEconomics } from './inventory-types.js';

export class InventoryError extends Error {
  override readonly name = 'InventoryError';
}

/**
 * Unit economics for one unit. Conservative: percentage costs are rounded up.
 * VAT is extracted from the gross price: price * rate / (1 + rate).
 */
export function calculateUnitEconomics(input: {
  unitCostChf: Rappen;
  salePriceChf: Rappen;
  costs: SellingCostModel;
  expectedDaysToSell: number;
}): UnitEconomics {
  const { unitCostChf, salePriceChf, costs } = input;
  if (unitCostChf <= 0n) throw new InventoryError('unit cost must be positive');
  if (salePriceChf <= 0n) throw new InventoryError('sale price must be positive');

  const vatChf = rappen(divRound(salePriceChf * BigInt(costs.vatRateBp), BASIS_POINTS + BigInt(costs.vatRateBp), 'half_even'));
  const netRevenueChf = subChf(salePriceChf, vatChf);
  const marketplaceFeeChf = applyBp(salePriceChf, costs.marketplaceFeeBp, 'ceil');
  const paymentFeeChf = addChf(applyBp(salePriceChf, costs.paymentFeeBp, 'ceil'), costs.paymentFixedChf);
  const returnReserveChf = applyBp(salePriceChf, costs.returnReserveBp, 'ceil');
  const sellingCostsChf = addChf(
    marketplaceFeeChf,
    paymentFeeChf,
    costs.shippingPerUnitChf,
    costs.packagingPerUnitChf,
    costs.advertisingPerUnitChf,
    returnReserveChf,
  );
  const netProfitChf = subChf(subChf(netRevenueChf, sellingCostsChf), unitCostChf);

  return {
    unitCostChf,
    salePriceChf,
    vatChf,
    netRevenueChf,
    marketplaceFeeChf,
    paymentFeeChf,
    shippingChf: costs.shippingPerUnitChf,
    packagingChf: costs.packagingPerUnitChf,
    advertisingChf: costs.advertisingPerUnitChf,
    returnReserveChf,
    sellingCostsChf,
    netProfitChf,
    roiBp: ratioBp(netProfitChf, unitCostChf),
    marginBp: ratioBp(netProfitChf, salePriceChf),
    capitalBindingDays: input.expectedDaysToSell,
  };
}

export class InventoryService {
  private readonly products = new Map<string, ProductDefinition>();

  constructor(private readonly engine: CapitalEngine) {}

  registerProduct(product: ProductDefinition): void {
    const errors = validateProduct(product);
    if (errors.length > 0) throw new InventoryError('invalid product "' + product.productId + '": ' + errors.join('; '));
    this.products.set(product.productId, Object.freeze(structuredClone(product)));
  }

  getProduct(productId: string): ProductDefinition {
    const product = this.products.get(productId);
    if (!product) throw new InventoryError('unknown product "' + productId + '"');
    return product;
  }

  unitEconomics(productId: string): UnitEconomics {
    const product = this.getProduct(productId);
    return calculateUnitEconomics({
      unitCostChf: product.sourcing.unitCostChf,
      salePriceChf: product.pricing.expectedSalePriceChf,
      costs: product.sellingCosts,
      expectedDaysToSell: product.demand.expectedDaysToSell,
    });
  }

  /** Records a purchase that already happened. Landed costs (inbound shipping, customs) are capitalized into stock. */
  async recordPurchase(
    input: CommandMeta & {
      productId: string;
      quantity: DecimalInput;
      purchaseCostChf: Rappen;
      landedCosts?: { shippingChf?: Rappen; customsChf?: Rappen; otherChf?: Rappen };
      paidFrom?: AccountKey;
      /** Supplier invoice to be paid later (payable). */
      owedTo?: AccountKey;
      opportunityId?: string;
    },
  ): Promise<JournalEntry> {
    this.getProduct(input.productId);
    const quantity = requirePositiveQuantity(input.quantity);
    requirePositive(input.purchaseCostChf, 'purchase cost');
    const landed = [input.landedCosts?.shippingChf, input.landedCosts?.customsChf, input.landedCosts?.otherChf].map((c) => c ?? ZERO_CHF);
    landed.forEach((c) => requireNonNegative(c, 'landed cost'));
    const total = addChf(input.purchaseCostChf, ...landed);
    if ((input.paidFrom === undefined) === (input.owedTo === undefined)) {
      throw new CapitalRuleError('purchase needs exactly one of paidFrom or owedTo');
    }
    if (input.paidFrom !== undefined) requireKind(input.paidFrom, ['cash', 'cash_reservation'], 'purchase payment source');
    if (input.owedTo !== undefined) requireKind(input.owedTo, ['payable'], 'purchase liability');

    return this.engine.post(
      this.engine.draft(
        'inventory_buy',
        input,
        'Buy ' + quantity.toString() + ' x ' + input.productId,
        [
          { account: accounts.inventory(input.productId), amount: total, quantity },
          { account: input.paidFrom ?? input.owedTo ?? '', amount: negChf(total) },
        ],
        { inventoryId: input.productId, opportunityId: input.opportunityId },
      ),
    );
  }

  /**
   * Records a sale that already happened. The listed costs are netted from the payout (as marketplaces do);
   * costs paid separately are booked with CapitalEngine.recordExpense. Cost of goods sold uses average cost.
   */
  async recordSale(
    input: CommandMeta & {
      productId: string;
      quantity: DecimalInput;
      grossRevenueChf: Rappen;
      channel: string;
      costs?: SaleCosts;
      settlement: SaleSettlement;
      fromReserved?: boolean;
      opportunityId?: string;
    },
  ): Promise<JournalEntry> {
    this.getProduct(input.productId);
    const productId = input.productId;
    const quantity = requirePositiveQuantity(input.quantity);
    requirePositive(input.grossRevenueChf, 'gross revenue');
    const costs = input.costs ?? {};
    const marketplaceFee = costs.marketplaceFeeChf ?? ZERO_CHF;
    const paymentFee = costs.paymentFeeChf ?? ZERO_CHF;
    const shipping = costs.shippingChf ?? ZERO_CHF;
    const advertising = costs.advertisingChf ?? ZERO_CHF;
    const vat = costs.vatChf ?? ZERO_CHF;
    [marketplaceFee, paymentFee, shipping, advertising, vat].forEach((c) => requireNonNegative(c, 'sale cost'));
    const payout = subChf(input.grossRevenueChf, addChf(marketplaceFee, paymentFee, shipping, advertising));
    if (payout < 0n) throw new CapitalRuleError('sale costs exceed gross revenue; book the excess separately with recordExpense');
    if (vat > input.grossRevenueChf) throw new CapitalRuleError('VAT exceeds gross revenue');

    let settlementAccount: AccountKey;
    if (input.settlement.kind === 'cash') {
      requireKind(input.settlement.account, ['cash'], 'sale settlement');
      settlementAccount = input.settlement.account;
    } else {
      settlementAccount = accounts.receivable(input.settlement.counterpartyId);
    }
    const stockAccount = input.fromReserved ? accounts.inventoryReserved(productId) : accounts.inventory(productId);

    return this.engine.post((current) => {
      const holding = current.balance(stockAccount);
      if (holding.quantity.lt(quantity)) {
        throw new CapitalRuleError('cannot sell ' + quantity.toString() + ' x ' + productId + ', ' + holding.quantity.toString() + ' in ' + stockAccount);
      }
      const cogs = releasedCost(holding, quantity);
      return this.engine.draft(
        'inventory_sale',
        input,
        'Sell ' + quantity.toString() + ' x ' + productId + ' via ' + input.channel,
        [
          { account: settlementAccount, amount: payout },
          { account: accounts.fee('marketplace', productId), amount: marketplaceFee },
          { account: accounts.fee('payment', productId), amount: paymentFee },
          { account: accounts.expense('shipping', productId), amount: shipping },
          { account: accounts.expense('advertising', productId), amount: advertising },
          { account: accounts.salesRevenue(productId), amount: negChf(subChf(input.grossRevenueChf, vat)) },
          { account: accounts.taxPayable('vat'), amount: negChf(vat) },
          { account: accounts.cogs(productId), amount: cogs },
          { account: stockAccount, amount: negChf(cogs), quantity: quantity.negated() },
        ],
        { inventoryId: productId, opportunityId: input.opportunityId },
      );
    });
  }

  /** Reserves units for a pending order: moves them (with their average cost) to the reserved stock account. */
  async reserveUnits(input: CommandMeta & { productId: string; quantity: DecimalInput }): Promise<JournalEntry> {
    return this.moveUnits(input, accounts.inventory(input.productId), accounts.inventoryReserved(input.productId), 'reserve');
  }

  async releaseUnits(input: CommandMeta & { productId: string; quantity: DecimalInput }): Promise<JournalEntry> {
    return this.moveUnits(input, accounts.inventoryReserved(input.productId), accounts.inventory(input.productId), 'release_reserve');
  }

  stock(productId: string): StockLevel {
    this.getProduct(productId);
    const ledger = this.engine.ledger;
    const free = ledger.balance(accounts.inventory(productId));
    const reserved = ledger.balance(accounts.inventoryReserved(productId));
    const stockAccounts = new Set([accounts.inventory(productId), accounts.inventoryReserved(productId)]);

    let soldTotal = Decimal.ZERO;
    for (const entry of ledger.all()) {
      const isSale = entry.type === 'inventory_sale';
      const isSaleReversal = entry.type === 'reversal' && ledger.get(entry.refs.reversesEntryId ?? '')?.type === 'inventory_sale';
      if (!isSale && !isSaleReversal) continue;
      for (const posting of entry.postings) {
        if (stockAccounts.has(posting.account) && posting.quantity) soldTotal = soldTotal.minus(posting.quantity);
      }
    }

    const onHand = free.quantity.plus(reserved.quantity);
    const costBasisChf = rappen(free.amount + reserved.amount);
    return {
      productId,
      onHand,
      reserved: reserved.quantity,
      free: free.quantity,
      soldTotal,
      costBasisChf,
      averageUnitCostChf: onHand.isZero() ? null : chfToDecimal(costBasisChf).dividedBy(onHand, 8, 'half_even'),
    };
  }

  /**
   * Turns a product into an opportunity so it can be compared with trades in the allocator.
   * Capacity = min(units the supplier can deliver, units the channels can absorb).
   * Downside = units x (unit cost - salvage value): the loss if nothing sells.
   */
  toOpportunityInput(productId: string, options: { id?: string; units?: number } = {}): OpportunityInput {
    const product = this.getProduct(productId);
    const economics = this.unitEconomics(productId);
    const capacityUnits = Math.min(product.sourcing.maxUnitsAvailable, product.demand.maxUnitsSellable);
    if (capacityUnits < 1) throw new InventoryError('product "' + productId + '" has no capacity (supply or demand is zero)');
    const units = options.units ?? capacityUnits;
    if (!Number.isInteger(units) || units < 1 || units > capacityUnits) {
      throw new InventoryError('units must be an integer between 1 and ' + capacityUnits);
    }
    const unitCost = product.sourcing.unitCostChf;
    const times = (amount: Rappen, n: number) => rappen(amount * BigInt(n));
    const lossPerUnit = subChf(unitCost, product.demand.salvageValuePerUnitChf);

    return {
      id: options.id ?? 'product:' + productId,
      type: product.opportunityType,
      name: product.name,
      requiredCapitalChf: times(unitCost, units),
      sizing: { kind: 'scalable', minTicketChf: unitCost, maxCapitalChf: times(unitCost, capacityUnits), lotSizeChf: unitCost },
      expectedNetProfitChf: times(economics.netProfitChf, units),
      downsideChf: times(lossPerUnit < 0n ? ZERO_CHF : lossPerUnit, units),
      expectedHoldingDays: product.demand.expectedDaysToSell,
      liquidityScore: product.risk.liquidityScore,
      confidenceScore: product.demand.sellThroughScore,
      riskScore: product.risk.riskScore,
      effortScore: product.risk.effortScore,
      regulatoryRiskScore: product.risk.regulatoryRiskScore,
      regulatoryBlocked: product.risk.regulatoryBlocked,
      thesis: [
        'Buy at ' + formatChf(unitCost) + ' CHF, sell at ' + formatChf(economics.salePriceChf) + ' CHF, net ' + formatChf(economics.netProfitChf) +
          ' CHF per unit after all selling costs (ROI ' + (economics.roiBp / 100).toFixed(2) + ' %)',
        'Demand: up to ' + product.demand.maxUnitsSellable + ' units in ' + product.demand.expectedDaysToSell + ' days via ' + product.salesChannels.join(', '),
      ],
      risks: [
        'Sell-through below expectation (score ' + product.demand.sellThroughScore + ', uncalibrated)',
        'Returns, damage and price erosion on ' + product.salesChannels.join(', '),
      ],
      exitPlan:
        'Sell via ' + product.salesChannels.join(', ') + '; clear unsold units at ' + formatChf(product.demand.salvageValuePerUnitChf) +
        ' CHF after ' + product.demand.expectedDaysToSell * 2 + ' days',
      estimates: { source: product.pricing.source, dataStatus: product.pricing.dataStatus, asOf: product.pricing.asOf, calibrated: false },
      links: { productId },
    };
  }

  private moveUnits(
    input: CommandMeta & { productId: string; quantity: DecimalInput },
    from: AccountKey,
    to: AccountKey,
    type: 'reserve' | 'release_reserve',
  ): Promise<JournalEntry> {
    this.getProduct(input.productId);
    const quantity = requirePositiveQuantity(input.quantity);
    return this.engine.post((current) => {
      const holding = current.balance(from);
      if (holding.quantity.lt(quantity)) {
        throw new CapitalRuleError('only ' + holding.quantity.toString() + ' units of ' + input.productId + ' in ' + from);
      }
      const cost = releasedCost(holding, quantity);
      return this.engine.draft(
        type,
        input,
        (type === 'reserve' ? 'Reserve ' : 'Release ') + quantity.toString() + ' x ' + input.productId,
        [
          { account: to, amount: cost, quantity },
          { account: from, amount: negChf(cost), quantity: quantity.negated() },
        ],
        { inventoryId: input.productId },
      );
    });
  }
}

function validateProduct(p: ProductDefinition): string[] {
  const errors: string[] = [];
  const unit = (value: number, label: string) => {
    if (!Number.isFinite(value) || value < 0 || value > 1) errors.push(label + ' must be within 0..1');
  };
  const bp = (value: number, label: string) => {
    if (!Number.isInteger(value) || value < 0 || value > 10_000) errors.push(label + ' must be an integer 0..10000 bp');
  };
  const count = (value: number, label: string) => {
    if (!Number.isInteger(value) || value < 0) errors.push(label + ' must be a non-negative integer');
  };
  try {
    accounts.inventory(p.productId);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (p.name.trim() === '') errors.push('name is required');
  if (p.salesChannels.length === 0) errors.push('at least one sales channel is required');
  if (p.sourcing.unitCostChf <= 0n) errors.push('unit cost must be positive');
  if (p.pricing.expectedSalePriceChf <= 0n) errors.push('expected sale price must be positive');
  if (Number.isNaN(Date.parse(p.pricing.asOf))) errors.push('pricing.asOf is not a valid timestamp');
  count(p.sourcing.maxUnitsAvailable, 'maxUnitsAvailable');
  count(p.demand.maxUnitsSellable, 'maxUnitsSellable');
  if (!(p.demand.expectedDaysToSell > 0)) errors.push('expectedDaysToSell must be positive');
  if (p.demand.salvageValuePerUnitChf < 0n) errors.push('salvage value must not be negative');
  unit(p.demand.sellThroughScore, 'sellThroughScore');
  unit(p.risk.riskScore, 'riskScore');
  unit(p.risk.effortScore, 'effortScore');
  unit(p.risk.liquidityScore, 'liquidityScore');
  unit(p.risk.regulatoryRiskScore, 'regulatoryRiskScore');
  const c = p.sellingCosts;
  bp(c.marketplaceFeeBp, 'marketplaceFeeBp');
  bp(c.paymentFeeBp, 'paymentFeeBp');
  bp(c.returnReserveBp, 'returnReserveBp');
  bp(c.vatRateBp, 'vatRateBp');
  for (const [label, amount] of [
    ['paymentFixedChf', c.paymentFixedChf],
    ['shippingPerUnitChf', c.shippingPerUnitChf],
    ['packagingPerUnitChf', c.packagingPerUnitChf],
    ['advertisingPerUnitChf', c.advertisingPerUnitChf],
  ] as const) {
    if (amount < 0n) errors.push(label + ' must not be negative');
  }
  return errors;
}
