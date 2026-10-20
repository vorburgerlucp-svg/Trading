// O22 TEST DATA ONLY: a synthetic orders:lookup answer with the structure of the first live answer (demo, 20.10.2026). Field
// paths, kinds and the non-identifying enum values ("open", "buy", "mkt", "REAL", "long", "Filled", "usd", "byAmount", ...) are the
// observed ones; every id, amount, rate and time is artificial. No account, order or position id of the real answer is used.

export const LIVE_LIKE_ORDER_ID = 900000001;
export const LIVE_LIKE_POSITION_ID = 800000001;

export interface LiveLikeOptions {
  orderId?: number;
  instrumentId?: number;
  statusId?: number;
  /** Position ids of positionExecutions (default: one). */
  positionIds?: number[];
}

/** A deep copy of the live-like answer; a test changes or removes fields on it to build a variant. */
export function liveLikeLookup(instrumentId: number, options: LiveLikeOptions = {}): Record<string, unknown> {
  const orderId = options.orderId ?? LIVE_LIKE_ORDER_ID;
  return {
    accountId: 111111,
    action: 'open',
    asset: { currency: 'USD', instrumentId: options.instrumentId ?? instrumentId, leverage: 1, settlementType: 'REAL', side: 'long', symbol: 'ETH' },
    etoroOrderTypeId: 17,
    frozenAmount: 100,
    gcid: 222222,
    lastUpdate: '2026-10-20T07:49:22.123',
    openActionType: 'customer',
    openStopLossRate: 0.0001,
    openTakeProfitRate: 0,
    orderCurrency: 'usd',
    orderId,
    portfolioId: 0,
    positionExecutions: (options.positionIds ?? [LIVE_LIKE_POSITION_ID]).map((positionId) => ({
      addedFunds: 0,
      initialExposureAccountCurrency: 99.5,
      initialExposureAssetCurrency: 99.5,
      investedAmountCurrency: 100,
      marginAccountCurrency: 100,
      marginAssetCurrency: 100,
      openingData: {
        avgConversionRate: 1, avgPrice: 1234.5, contracts: 0.081, executionTime: '2026-10-20T07:49:22.100', fees: 1, marketSpread: 0,
        markup: 0, openTime: '2026-10-20T07:49:22.100Z', orderId, priceId: 0, taxes: 0, units: 0.081,
      },
      positionId,
      remainingContracts: 0.081,
      remainingUnits: 0.081,
      state: 'open',
      stopLossRate: 0.0001,
      takeProfitRate: 0,
    })),
    positionsToClose: [],
    requestTime: '2026-10-20T07:49:21.900Z',
    requestType: 'byAmount',
    requestedAmount: 100,
    requestedContracts: 0.081,
    requestedUnits: 0.081,
    status: { errorCode: 0, id: options.statusId ?? 3, name: 'Filled' },
    stopLossType: 'fixed',
    totalCosts: 1,
    transaction: 'buy',
    type: 'mkt',
  };
}
