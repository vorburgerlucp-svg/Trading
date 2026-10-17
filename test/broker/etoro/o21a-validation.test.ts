// O21A: the non-empty demo portfolio parser, against the DOCUMENTED fixture (not live-observed). Strict per field, fail closed with
// BROKER_RESPONSE_INVALID, the empty portfolio stays valid, only positions and orders are read, and no value leaks into an error.
import { describe, expect, it } from 'vitest';
import { BrokerError } from '../../../src/broker/broker-errors.js';
import { parseDemoPortfolio } from '../../../src/broker/etoro/etoro-validation.js';
import { emptyDemoPortfolio } from './o20-fixture.js';
import { FIXTURE_PROVENANCE, documentedOrder, documentedPortfolio, documentedPosition } from './o21a-documented-fixture.js';

function refusal(body: unknown): BrokerError {
  try {
    parseDemoPortfolio(body);
  } catch (error) {
    if (error instanceof BrokerError) return error;
    throw error;
  }
  throw new Error('expected the response to be refused');
}

function withPosition(overrides: Record<string, unknown>): unknown {
  return documentedPortfolio({ positions: [documentedPosition(overrides)], orders: [] });
}

function withOrder(overrides: Record<string, unknown>): unknown {
  return documentedPortfolio({ positions: [], orders: [documentedOrder(overrides)] });
}

function withoutField(make: () => Record<string, unknown>, field: string, container: 'positions' | 'orders'): unknown {
  const entry = make();
  delete entry[field];
  return documentedPortfolio(container === 'positions' ? { positions: [entry], orders: [] } : { positions: [], orders: [entry] });
}

describe('O21A parser: the fixture is documented, not live-observed', () => {
  it('states its provenance', () => {
    expect(FIXTURE_PROVENANCE).toBe('documented_fixture_not_live_observed');
  });
});

describe('O21A parser: the empty portfolio stays valid (O20 compatibility)', () => {
  it('an empty clientPortfolio is zero positions and zero orders, with empty lists', () => {
    expect(parseDemoPortfolio(emptyDemoPortfolio())).toEqual({ positionCount: 0, orderCount: 0, positions: [], orders: [] });
  });
});

describe('O21A parser: documented positions', () => {
  it('reads one documented position into the fields NEXUS keeps, and nothing else', () => {
    const parsed = parseDemoPortfolio(documentedPortfolio({ orders: [] }));
    expect(parsed.positionCount).toBe(1);
    expect(parsed.positions[0]).toEqual({
      positionId: 2150896073,
      etoroInstrumentId: 1002,
      direction: 'buy',
      units: '0.049485',
      openRate: '2020.7784',
      leverage: '1',
      amountUsd: '100',
      openedAt: '2024-08-01T07:44:26.103Z',
      stopLossRate: '0.0001',
      takeProfitRate: '0',
      stopLossDisabled: true,
      takeProfitDisabled: true,
      trailingStopLoss: false,
      openOrder: { orderId: 12402059, orderType: 17 },
    });
    // Not kept: the customer id, fees, taxes and every field NEXUS does not need.
    const text = JSON.stringify(parsed);
    for (const dropped of ['7765437', 'CID', 'totalFees', 'totalExternalTaxes', 'initialAmountInDollars', 'isDiscounted', 'pnlVersion']) expect(text).not.toContain(dropped);
  });

  it('reads several positions, sorted by position id, with isBuy=false as sell', () => {
    const parsed = parseDemoPortfolio(
      documentedPortfolio({
        positions: [documentedPosition({ positionID: 30, instrumentID: 7, isBuy: false }), documentedPosition({ positionID: 10 }), documentedPosition({ positionID: 20, instrumentID: 1002 })],
        orders: [],
      }),
    );
    expect(parsed.positions.map((p) => [p.positionId, p.etoroInstrumentId, p.direction])).toEqual([
      [10, 1002, 'buy'],
      [20, 1002, 'buy'],
      [30, 7, 'sell'],
    ]);
  });

  it('a duplicate position id is refused', () => {
    const body = documentedPortfolio({ positions: [documentedPosition(), documentedPosition()], orders: [] });
    expect(refusal(body).message).toContain('duplicate');
  });

  it('an orderID without a valid orderType is refused; orderID 0 or absent means no stated order', () => {
    expect(refusal(withPosition({ orderType: undefined })).message).toContain('orderType');
    expect(refusal(withPosition({ orderType: 'market' })).message).toContain('orderType');
    expect(parseDemoPortfolio(withPosition({ orderID: 0, orderType: undefined })).positions[0]?.openOrder).toBeNull();
  });

  it('optional SL/TP rates and flags are null when absent: no meaning is invented', () => {
    const p = parseDemoPortfolio(withPosition({ stopLossRate: undefined, takeProfitRate: null, isNoStopLoss: undefined, isNoTakeProfit: undefined, isTslEnabled: undefined })).positions[0];
    expect(p).toMatchObject({ stopLossRate: null, takeProfitRate: null, stopLossDisabled: null, takeProfitDisabled: null, trailingStopLoss: null });
  });

  it('copy-trading positions (mirrorID or parentPositionID not 0) are refused', () => {
    expect(refusal(withPosition({ mirrorID: 1841334 })).message).toContain('mirrorID');
    expect(refusal(withPosition({ parentPositionID: 99 })).message).toContain('parentPositionID');
  });
});

describe('O21A parser: documented pending orders', () => {
  it('reads one documented order', () => {
    const parsed = parseDemoPortfolio(documentedPortfolio({ positions: [] }));
    expect(parsed.orderCount).toBe(1);
    expect(parsed.orders[0]).toEqual({
      orderId: 5669649,
      etoroInstrumentId: 100043,
      direction: 'buy',
      amountUsd: '100',
      units: '688.231246',
      rate: '0.1453',
      leverage: '1',
      createdAt: '2024-06-06T08:07:25.083Z',
      stopLossRate: '0.00001',
      takeProfitRate: '0',
      trailingStopLoss: false,
    });
  });

  it('reads positions and several orders together, orders sorted by order id', () => {
    const parsed = parseDemoPortfolio(documentedPortfolio({ orders: [documentedOrder({ orderID: 9 }), documentedOrder({ orderID: 3, isBuy: false, units: 0 })] }));
    expect(parsed.positionCount).toBe(1);
    expect(parsed.orders.map((o) => [o.orderId, o.direction, o.units])).toEqual([
      [3, 'sell', '0'],
      [9, 'buy', '688.231246'],
    ]);
  });

  it('a duplicate order id is refused', () => {
    expect(refusal(documentedPortfolio({ positions: [], orders: [documentedOrder(), documentedOrder()] })).message).toContain('duplicate');
  });
});

describe('O21A parser: the other order containers are not read', () => {
  // ordersForOpen/ForClose/ForCloseMultiple have no documented element schema; stockOrders/entryOrders/exitOrders are obsolete;
  // mirrors are copy trading. A non-empty one is refused, whatever its entries look like.
  for (const container of ['mirrors', 'stockOrders', 'entryOrders', 'exitOrders', 'ordersForOpen', 'ordersForClose', 'ordersForCloseMultiple']) {
    it(`a non-empty ${container} is refused, even with a documented-looking entry`, () => {
      const error = refusal(documentedPortfolio({ extra: { [container]: [documentedOrder()] } }));
      expect(error.code).toBe('BROKER_RESPONSE_INVALID');
      expect(error.message).toContain('clientPortfolio.' + container + ' is not empty');
    });
  }
});

describe('O21A parser: malformed entries are BROKER_RESPONSE_INVALID', () => {
  const cases: Array<[string, unknown, string]> = [
    ['position id as string', withPosition({ positionID: '2150896073' }), 'positionID'],
    ['position id 0', withPosition({ positionID: 0 }), 'positionID'],
    ['position id negative', withPosition({ positionID: -5 }), 'positionID'],
    ['position id fractional', withPosition({ positionID: 1.5 }), 'positionID'],
    ['position id above 2^53 (not exact after JSON.parse)', withPosition({ positionID: 2 ** 53 + 2 }), 'positionID'],
    ['instrument id as string', withPosition({ instrumentID: '1002' }), 'instrumentID'],
    ['instrument id null', withPosition({ instrumentID: null }), 'instrumentID'],
    ['instrument id fractional', withPosition({ instrumentID: 1002.5 }), 'instrumentID'],
    ['isBuy as string', withPosition({ isBuy: 'true' }), 'isBuy'],
    ['units as string', withPosition({ units: '0.049485' }), 'units'],
    ['units 0', withPosition({ units: 0 }), 'units'],
    ['openRate negative', withPosition({ openRate: -1 }), 'openRate'],
    ['leverage 0', withPosition({ leverage: 0 }), 'leverage'],
    ['leverage absurd', withPosition({ leverage: 1e6 }), 'leverage'],
    ['amount above bound', withPosition({ amount: 1e13 }), 'amount'],
    ['stopLossRate as string', withPosition({ stopLossRate: '0.1' }), 'stopLossRate'],
    ['isNoStopLoss as number', withPosition({ isNoStopLoss: 1 }), 'isNoStopLoss'],
    ['openDateTime without zone', withPosition({ openDateTime: '2024-08-01T07:44:26.103' }), 'openDateTime'],
    ['openDateTime as number', withPosition({ openDateTime: 1722498266103 }), 'openDateTime'],
    ['openDateTime impossible date', withPosition({ openDateTime: '2024-13-45T07:44:26Z' }), 'openDateTime'],
    ['position not an object', documentedPortfolio({ positions: ['x'], orders: [] }), 'positions[0]'],
    ['order id as string', withOrder({ orderID: '5669649' }), 'orderID'],
    ['order instrument id 0', withOrder({ instrumentID: 0 }), 'instrumentID'],
    ['order units negative', withOrder({ units: -1 }), 'units'],
    ['order amount as string', withOrder({ amount: '100' }), 'amount'],
    ['order rate as boolean', withOrder({ rate: true }), 'rate'],
  ];
  for (const [name, body, path] of cases) {
    it(name, () => {
      const error = refusal(body);
      expect(error.code).toBe('BROKER_RESPONSE_INVALID');
      expect(error.message).toContain(path);
    });
  }

  it('NaN and Infinity are refused (JSON has neither, but an overflowing literal parses to Infinity)', () => {
    expect(JSON.parse('{"v":1e400}').v).toBe(Infinity);
    for (const v of [Number.NaN, Infinity, -Infinity]) {
      expect(refusal(withPosition({ units: v })).message).toContain('units');
      expect(refusal(withOrder({ amount: v })).message).toContain('amount');
    }
    expect(refusal(JSON.parse(JSON.stringify(withPosition({})).replace('"openRate":2020.7784', '"openRate":1e400'))).message).toContain('openRate');
  });

  for (const field of ['positionID', 'instrumentID', 'isBuy', 'units', 'openRate', 'leverage', 'amount', 'openDateTime']) {
    it(`a position without ${field} is refused (NEXUS-required; the reference has no required list)`, () => {
      expect(refusal(withoutField(documentedPosition, field, 'positions')).message).toContain(field);
    });
  }

  for (const field of ['orderID', 'instrumentID', 'isBuy', 'amount', 'units', 'leverage', 'openDateTime']) {
    it(`an order without ${field} is refused`, () => {
      expect(refusal(withoutField(documentedOrder, field, 'orders')).message).toContain(field);
    });
  }
});

describe('O21A parser: unknown and optional fields', () => {
  it('unknown extra fields on a position or order are ignored and never kept', () => {
    const parsed = parseDemoPortfolio(documentedPortfolio({ positions: [documentedPosition({ someFutureField: { nested: 'VALUE-XYZ' } })], orders: [documentedOrder({ brandNew: 'VALUE-ABC' })] }));
    expect(JSON.stringify(parsed)).not.toMatch(/VALUE-XYZ|VALUE-ABC|someFutureField|brandNew/);
  });

  it('documented fields NEXUS does not use may be absent or of another type without effect', () => {
    const parsed = parseDemoPortfolio(withPosition({ totalFees: 'n/a', CID: undefined, lotCount: null, isSettled: 'obsolete' }));
    expect(parsed.positionCount).toBe(1);
  });

  it('a refusal names the field path only, never a value from the response', () => {
    const error = refusal(withPosition({ positionID: 'SECRET-VALUE-0001', CID: 'SECRET-CID' }));
    expect(error.message).not.toMatch(/SECRET-VALUE-0001|SECRET-CID/);
  });

  it('the parsed result has no ticker or symbol: the identity is the eToro instrument id', () => {
    const parsed = parseDemoPortfolio(documentedPortfolio({ positions: [documentedPosition({ symbol: 'AAPL', ticker: 'AAPL' })] }));
    expect(JSON.stringify(parsed)).not.toMatch(/AAPL|symbol|ticker/);
    expect(parsed.positions[0]?.etoroInstrumentId).toBe(1002);
  });

  it('the result is deterministic: the same body in another element order parses to the same value', () => {
    const a = [documentedPosition({ positionID: 1 }), documentedPosition({ positionID: 2, instrumentID: 9 })];
    const o = [documentedOrder({ orderID: 1 }), documentedOrder({ orderID: 2 })];
    expect(parseDemoPortfolio(documentedPortfolio({ positions: a, orders: o }))).toEqual(parseDemoPortfolio(documentedPortfolio({ positions: [...a].reverse(), orders: [...o].reverse() })));
  });
});
