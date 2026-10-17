// TEST FIXTURE ONLY. DOCUMENTED FIXTURE — NOT LIVE-OBSERVED.
//
// Every element below is the example of the official eToro API reference for GET /api/v1/trading/info/demo/portfolio (checked
// 2026-10-17), field for field: TradingDemoApi_Position for positions, the "List of pending orders" element for orders. It is not a
// real payload, no real account, key or session is in this file, and nothing here was copied from a live response. When a live
// non-empty demo portfolio is observed (etoro-observe-cli), its sanitized schema report is compared against this structure.
//
// The documented mirrors example is not used: copy trading is out of scope and a non-empty mirrors container is refused.

import { emptyDemoPortfolio } from './o20-fixture.js';

export const FIXTURE_PROVENANCE = 'documented_fixture_not_live_observed' as const;

/** The reference example position (TradingDemoApi_Position). */
export function documentedPosition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    positionID: 2150896073,
    CID: 7765437,
    openDateTime: '2024-08-01T07:44:26.103Z',
    openRate: 2020.7784,
    instrumentID: 1002,
    isBuy: true,
    takeProfitRate: 0,
    stopLossRate: 0.0001,
    mirrorID: 0,
    parentPositionID: 0,
    amount: 100,
    leverage: 1,
    orderID: 12402059,
    orderType: 17,
    units: 0.049485,
    totalFees: 0,
    initialAmountInDollars: 100,
    isTslEnabled: false,
    stopLossVersion: 3,
    isSettled: true,
    redeemStatusID: 0,
    initialUnits: 0.049485,
    isPartiallyAltered: false,
    unitsBaseValueDollars: 100,
    isDiscounted: true,
    openPositionActionType: 0,
    settlementTypeID: 1,
    isDetached: false,
    openConversionRate: 1,
    pnlVersion: 1,
    totalExternalFees: 0,
    totalExternalTaxes: 0,
    isNoTakeProfit: true,
    isNoStopLoss: true,
    lotCount: 0.049485,
    ...overrides,
  };
}

/** The reference example pending order (clientPortfolio.orders). */
export function documentedOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderID: 5669649,
    CID: 7765437,
    openDateTime: '2024-06-06T08:07:25.083Z',
    instrumentID: 100043,
    isBuy: true,
    takeProfitRate: 0,
    stopLossRate: 0.00001,
    rate: 0.1453,
    amount: 100,
    leverage: 1,
    units: 688.231246,
    isTslEnabled: false,
    executionType: 0,
    isDiscounted: false,
    ...overrides,
  };
}

/** A documented non-empty demo portfolio: the reference credit and bonusCredit, the given positions and orders, every other container empty. */
export function documentedPortfolio(content: { positions?: unknown[]; orders?: unknown[]; extra?: Record<string, unknown> } = {}): Record<string, unknown> {
  return emptyDemoPortfolio({
    credit: 280.35,
    bonusCredit: 0,
    positions: content.positions ?? [documentedPosition()],
    orders: content.orders ?? [documentedOrder()],
    ...(content.extra ?? {}),
  });
}
