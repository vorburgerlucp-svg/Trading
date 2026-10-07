// Test fixtures. All market data below exists only inside tests to exercise valuation logic;
// production code never ships or invents prices.

import { CapitalEngine } from '../src/capital/capital-engine.js';
import { CapitalLedger } from '../src/capital/capital-ledger.js';
import type { CapitalPolicy, CapitalState } from '../src/capital/capital-types.js';
import { InventoryService } from '../src/inventory/inventory-service.js';
import type { ProductDefinition } from '../src/inventory/inventory-types.js';
import { chf, formatChf, type Rappen } from '../src/money/money.js';

export const T0 = '2026-10-01T08:00:00.000Z';

export function fixedClock(iso = T0): { now: () => Date; set: (iso: string) => void } {
  let current = new Date(iso);
  return { now: () => current, set: (next) => (current = new Date(next)) };
}

export function sequentialIds(prefix = 'e'): () => string {
  let n = 0;
  return () => prefix + String(++n).padStart(4, '0');
}

export function policy(overrides: Partial<CapitalPolicy> = {}): CapitalPolicy {
  return {
    safetyReserve: { minimumChf: chf(0), percentOfNetWorthBp: 0 },
    maxQuoteAgeMs: 15 * 60_000,
    maxInventoryQuoteAgeMs: 7 * 24 * 3_600_000,
    ...overrides,
  };
}

export async function newEngine(capitalPolicy: CapitalPolicy = policy(), clockIso = T0) {
  const clock = fixedClock(clockIso);
  const ledger = await CapitalLedger.inMemory({ clock: clock.now });
  const engine = new CapitalEngine(ledger, { policy: capitalPolicy, clock: clock.now, newId: sequentialIds() });
  return { engine, ledger, clock };
}

/** Resale product from the spec: buy 20, sell 35, 5 CHF selling costs → 10 CHF net, 50 % ROI, 7 days. */
export function chewingGum(overrides: Partial<ProductDefinition> = {}): ProductDefinition {
  return {
    productId: 'kaugummi',
    name: 'Kaugummi Sammlerbox',
    category: 'collectibles',
    opportunityType: 'reselling',
    salesChannels: ['ricardo'],
    sourcing: { unitCostChf: chf(20), maxUnitsAvailable: 5 },
    pricing: { expectedSalePriceChf: chf(35), source: 'manual', dataStatus: 'connected', asOf: T0 },
    sellingCosts: {
      marketplaceFeeBp: 1000,
      paymentFeeBp: 0,
      paymentFixedChf: chf('1.50'),
      shippingPerUnitChf: chf(0),
      packagingPerUnitChf: chf(0),
      advertisingPerUnitChf: chf(0),
      returnReserveBp: 0,
      vatRateBp: 0,
    },
    demand: { expectedDaysToSell: 7, maxUnitsSellable: 1, sellThroughScore: 0.8, salvageValuePerUnitChf: chf(10) },
    risk: { riskScore: 0.3, effortScore: 0.4, liquidityScore: 0.4, regulatoryRiskScore: 0.05, regulatoryBlocked: false },
    ...overrides,
  };
}

export async function newInventory(capitalPolicy: CapitalPolicy = policy()) {
  const ctx = await newEngine(capitalPolicy);
  const inventory = new InventoryService(ctx.engine);
  inventory.registerProduct(chewingGum());
  return { ...ctx, inventory };
}

/** Readable money assertions: "60.00" instead of 6000n. */
export function fmt(amount: Rappen | null): string | null {
  return amount === null ? null : formatChf(amount);
}

/** Accounting identity every state must satisfy (see docs/CAPITAL_ENGINE.md). */
export function identityHolds(s: CapitalState): boolean {
  const lhs = s.totalNetWorthChf + s.capitalShortfallChf;
  const rhs = s.availableCapitalChf + s.safetyReserveChf + s.reservedCapitalChf + s.committedCapitalChf + s.investedCapitalChf + s.receivablesChf;
  return lhs === rhs;
}
