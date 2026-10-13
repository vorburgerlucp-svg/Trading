import type { DataStatus } from '../capital/capital-types.js';
import type { Decimal } from '../money/decimal.js';
import type { Rappen } from '../money/money.js';
import type { EstimateSource, OpportunityType } from '../opportunities/opportunity-types.js';

/** Per-sale cost assumptions for a product (estimates; actual costs are booked per sale). */
export interface SellingCostModel {
  /** Marketplace commission on the gross sale price, basis points. */
  marketplaceFeeBp: number;
  paymentFeeBp: number;
  paymentFixedChf: Rappen;
  shippingPerUnitChf: Rappen;
  packagingPerUnitChf: Rappen;
  advertisingPerUnitChf: Rappen;
  /** Provision for returns/refunds, basis points of the gross sale price. */
  returnReserveBp: number;
  /** VAT included in the sale price (0 while not VAT-registered). 810 = 8.1 %. */
  vatRateBp: number;
}

/** Product master data. Prices here are ESTIMATES with provenance; they never enter net worth. */
export interface ProductDefinition {
  productId: string;
  name: string;
  category: string;
  opportunityType: Extract<OpportunityType, 'physical_product' | 'reselling' | 'wholesale' | 'arbitrage' | 'dropshipping'>;
  salesChannels: string[];

  sourcing: {
    /** Landed cost per unit for new purchases (price + inbound shipping + customs). */
    unitCostChf: Rappen;
    supplier?: string;
    /** Units the supplier can deliver now. */
    maxUnitsAvailable: number;
  };

  pricing: {
    expectedSalePriceChf: Rappen;
    source: EstimateSource;
    dataStatus: DataStatus;
    asOf: string;
  };

  sellingCosts: SellingCostModel;

  demand: {
    expectedDaysToSell: number;
    /** Units the channels can absorb within expectedDaysToSell. */
    maxUnitsSellable: number;
    /** 0..1 uncalibrated sell-through score ("Verkaufswahrscheinlichkeit"). */
    sellThroughScore: number;
    /** Recoverable value per unit if it does not sell (clearance price). */
    salvageValuePerUnitChf: Rappen;
  };

  /** 0..1 scores used when the product is turned into an opportunity. */
  risk: {
    riskScore: number;
    effortScore: number;
    liquidityScore: number;
    regulatoryRiskScore: number;
    /** e.g. product safety, CE marking, food rules, liability insurance not cleared. */
    regulatoryBlocked: boolean;
  };
}

/** Deterministic unit economics for one unit sold at the expected price. */
export interface UnitEconomics {
  unitCostChf: Rappen;
  salePriceChf: Rappen;
  vatChf: Rappen;
  netRevenueChf: Rappen;
  marketplaceFeeChf: Rappen;
  paymentFeeChf: Rappen;
  shippingChf: Rappen;
  packagingChf: Rappen;
  advertisingChf: Rappen;
  returnReserveChf: Rappen;
  sellingCostsChf: Rappen;
  netProfitChf: Rappen;
  /** netProfit / unitCost */
  roiBp: number;
  /** netProfit / salePrice */
  marginBp: number;
  capitalBindingDays: number;
}

/** Stock level derived from the ledger. */
export interface StockLevel {
  productId: string;
  onHand: Decimal;
  reserved: Decimal;
  free: Decimal;
  soldTotal: Decimal;
  costBasisChf: Rappen;
  averageUnitCostChf: Decimal | null;
}

export type SaleSettlement = { kind: 'cash'; account: string } | { kind: 'receivable'; counterpartyId: string };

/** Actual costs of a concrete sale, as charged. They are netted from the payout. */
export interface SaleCosts {
  marketplaceFeeChf?: Rappen;
  paymentFeeChf?: Rappen;
  shippingChf?: Rappen;
  advertisingChf?: Rappen;
  /** VAT contained in the gross revenue (becomes a tax liability). */
  vatChf?: Rappen;
}
