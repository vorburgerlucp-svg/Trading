// TEST FIXTURES ONLY for GET /api/v1/trading/info/demo/pnl (O21A.1). Two separate evidence classes, both NOT LIVE_OBSERVED.
// No real account, key or session is in this file, and nothing here was copied from a live response.
//
// A. REFERENCE_SCHEMA fixtures (DOCUMENTED / REFERENCE_SCHEMA, NOT LIVE_OBSERVED): property names and nesting exactly as the
//    schema section of the official reference defines them (checked 2026-10-17). The position's base fields are the same position
//    schema as /demo/portfolio and reuse its documented example (o21a-documented-fixture.ts); the nested unrealizedPnL, the orders and
//    the cash-related values are taken from the /demo/pnl reference example, with one deliberate change: the example's top-level position and ordersForOpen entry are copy-trading entries
//    (mirrorId 1, parentPositionId 8001); NEXUS refuses copy trading, so the schema fixture uses mirrorID / mirrorId 0 and
//    parentPositionID 0, which the reference documents as "0 otherwise".
//
// B. REFERENCE_EXAMPLE fixture (REFERENCE_EXAMPLE, NOT NORMATIVE, NOT LIVE_OBSERVED): the reference's own example position, with its
//    camelCase ids and flat PnL keys. It exists only to test the schema/example contradiction: the parser must refuse it.

import { documentedPosition } from './o21a-documented-fixture.js';

export const PNL_SCHEMA_FIXTURE_PROVENANCE = 'reference_schema_not_live_observed' as const;
export const PNL_EXAMPLE_FIXTURE_PROVENANCE = 'reference_example_not_normative_not_live_observed' as const;

/** A. A position in REFERENCE_SCHEMA shape: the portfolio position fields plus externalOperation and the nested unrealizedPnL. */
export function schemaPnlPosition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return documentedPosition({
    externalOperation: null,
    unrealizedPnL: {
      pnL: 100.25,
      pnlAssetCurrency: 100.25,
      exposureInAccountCurrency: 1050,
      exposureInAssetCurrency: 1050,
      marginInAccountCurrency: 1000,
      marginInAssetCurrency: 1000,
      marginCurrencyId: 1,
      assetCurrencyId: 1,
      closeRate: 1.25,
      closeConversionRate: 1.1,
      timestamp: '2024-01-01T12:00:00Z',
    },
    ...overrides,
  });
}

/** A. An order of clientPortfolio.orders in REFERENCE_SCHEMA shape (orderId / instrumentId spelling, as the pnl schema has it). */
export function schemaPnlOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: 5001,
    cid: 123,
    openDateTime: '2024-01-01T09:00:00Z',
    instrumentId: 101,
    isBuy: true,
    takeProfitRate: 1.5,
    stopLossRate: 1.2,
    rate: 1.3,
    amount: 1000,
    leverage: 2,
    units: 10.5,
    isTslEnabled: false,
    executionType: 1,
    isDiscounted: false,
    isNoTakeProfit: false,
    isNoStopLoss: false,
    ...overrides,
  };
}

/** A. An entry of clientPortfolio.ordersForOpen in REFERENCE_SCHEMA shape (mirrorId 0: not copy trading). */
export function schemaPnlOrderForOpen(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: 1001,
    orderType: 1,
    statusId: 1,
    cid: 123,
    openDateTime: '2024-01-01T09:00:00Z',
    lastUpdate: '2024-01-02T10:00:00Z',
    instrumentId: 101,
    amount: 1000,
    amountInUnits: 10.5,
    isBuy: true,
    leverage: 2,
    stopLossRate: 1.2345,
    takeProfitRate: 1.3456,
    isTslEnabled: false,
    isDiscounted: true,
    mirrorId: 0,
    frozenAmount: 0,
    totalExternalCosts: 5,
    isNoTakeProfit: false,
    isNoStopLoss: false,
    lotCount: 1,
    openPositionActionType: 1,
    externalOperation: null,
    ...overrides,
  };
}

/** A. An entry of clientPortfolio.ordersForClose in REFERENCE_SCHEMA shape. Not read by the parser: a non-empty one is refused. */
export function schemaPnlOrderForClose(): Record<string, unknown> {
  return { orderId: 2001, orderType: 2, statusId: 1, cid: 123, openDateTime: '2024-01-01T09:00:00Z', lastUpdate: '2024-01-02T10:00:00Z', instrumentId: 101, unitsToDeduct: 5, lotsToDeduct: 0.5, positionId: 3001 };
}

/** A. An entry of clientPortfolio.ordersForCloseMultiple in REFERENCE_SCHEMA shape. Not read by the parser: a non-empty one is refused. */
export function schemaPnlOrderForCloseMultiple(): Record<string, unknown> {
  return { orderId: 3001, orderType: 3, statusId: 1, cid: 123, openDateTime: '2024-01-01T09:00:00Z', lastUpdate: '2024-01-02T10:00:00Z', instrumentId: 101, unitsToDeduct: 10, lotsToDeduct: 1, pendingClosePositionIds: [3001, 3002] };
}

/** A. A REFERENCE_SCHEMA pnl response. Every container empty unless given; credit / bonusCredit / unrealizedPnL as in the reference example. */
export function schemaPnl(content: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientPortfolio: {
      credit: 10000.5,
      unrealizedPnL: 251,
      bonusCredit: 500,
      accountCurrencyId: 1,
      positions: [],
      mirrors: [],
      orders: [],
      ordersForOpen: [],
      ordersForClose: [],
      ordersForCloseMultiple: [],
      ...content,
    },
  };
}

/** B. REFERENCE_EXAMPLE, NOT NORMATIVE: the reference example's top-level position, verbatim. */
export function referenceExamplePnlPosition(): Record<string, unknown> {
  return {
    positionId: 9001,
    cid: 123,
    openDateTime: '2024-01-01T09:00:00Z',
    openRate: 1.2345,
    instrumentId: 101,
    isBuy: true,
    takeProfitRate: 1.5,
    stopLossRate: 1.2,
    mirrorId: 1,
    parentPositionId: 8001,
    amount: 1000,
    leverage: 2,
    orderId: 5001,
    orderType: 1,
    units: 10.5,
    totalFees: 2.5,
    initialAmountInDollars: 1000,
    isTslEnabled: false,
    stopLossVersion: 1,
    isSettled: true,
    redeemStatusId: 0,
    initialUnits: 10.5,
    isPartiallyAltered: false,
    unitsBaseValueDollars: 1000,
    isDiscounted: false,
    openPositionActionType: 1,
    settlementTypeId: 1,
    isDetached: false,
    openConversionRate: 1,
    pnlVersion: 1,
    totalExternalFees: 0,
    totalExternalTaxes: 0,
    isNoTakeProfit: false,
    isNoStopLoss: false,
    lotCount: 1,
    externalOperation: null,
    pnL: 100.25,
    closeRate: 1.25,
    closeConversionRate: 1.1,
    timestamp: '2024-01-01T12:00:00Z',
  };
}
