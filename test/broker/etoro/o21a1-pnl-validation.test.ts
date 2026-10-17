// O21A.1: the /demo/pnl parser follows the REFERENCE_SCHEMA only. No alias for the example's casing, no flat PnL, fail closed with
// BROKER_RESPONSE_INVALID, cash fields checked and never returned, no value in an error.
import { describe, expect, it } from 'vitest';
import { BrokerError } from '../../../src/broker/broker-errors.js';
import { parseDemoPnl } from '../../../src/broker/etoro/etoro-pnl-validation.js';
import {
  PNL_EXAMPLE_FIXTURE_PROVENANCE,
  PNL_SCHEMA_FIXTURE_PROVENANCE,
  referenceExamplePnlPosition,
  schemaPnl,
  schemaPnlOrder,
  schemaPnlOrderForClose,
  schemaPnlOrderForCloseMultiple,
  schemaPnlOrderForOpen,
  schemaPnlPosition,
} from './o21a1-pnl-fixture.js';

function refusal(body: unknown): BrokerError {
  try {
    parseDemoPnl(body);
  } catch (error) {
    if (error instanceof BrokerError) return error;
    throw error;
  }
  throw new Error('expected the response to be refused');
}

const withPosition = (overrides: Record<string, unknown>) => schemaPnl({ positions: [schemaPnlPosition(overrides)] });
const withOrder = (overrides: Record<string, unknown>) => schemaPnl({ orders: [schemaPnlOrder(overrides)] });
const withForOpen = (overrides: Record<string, unknown>) => schemaPnl({ ordersForOpen: [schemaPnlOrderForOpen(overrides)] });

describe('O21A.1 pnl fixtures state their evidence class', () => {
  it('schema fixture and example fixture are separate, neither is live-observed', () => {
    expect(PNL_SCHEMA_FIXTURE_PROVENANCE).toBe('reference_schema_not_live_observed');
    expect(PNL_EXAMPLE_FIXTURE_PROVENANCE).toBe('reference_example_not_normative_not_live_observed');
  });
});

describe('O21A.1 pnl parser: REFERENCE_SCHEMA entries are read', () => {
  it('an empty account is valid', () => {
    expect(parseDemoPnl(schemaPnl())).toEqual({ positionCount: 0, orderCount: 0, orderForOpenCount: 0, positions: [], orders: [], ordersForOpen: [] });
  });

  it('stockOrders / entryOrders / exitOrders may be absent or empty arrays', () => {
    expect(parseDemoPnl(schemaPnl({ stockOrders: [], entryOrders: [], exitOrders: [] })).positionCount).toBe(0);
  });

  it('a schema position: the position fields and the nested unrealizedPnL (pnL, closeRate, timestamp)', () => {
    const p = parseDemoPnl(withPosition({})).positions[0];
    expect(p).toMatchObject({ positionId: 2150896073, etoroInstrumentId: 1002, direction: 'buy', units: '0.049485', leverage: '1', openedAt: '2024-08-01T07:44:26.103Z' });
    expect(p?.unrealizedPnl).toEqual({ pnlAccountCurrency: '100.25', closeRate: '1.25', timestamp: '2024-01-01T12:00:00.000Z' });
  });

  it('unrealizedPnL is nullable in the schema: null or absent gives null, no PnL is invented', () => {
    expect(parseDemoPnl(withPosition({ unrealizedPnL: null })).positions[0]?.unrealizedPnl).toBeNull();
    expect(parseDemoPnl(withPosition({ unrealizedPnL: undefined })).positions[0]?.unrealizedPnl).toBeNull();
  });

  it('a negative PnL is valid', () => {
    expect(parseDemoPnl(withPosition({ unrealizedPnL: { pnL: -12.5 } })).positions[0]?.unrealizedPnl?.pnlAccountCurrency).toBe('-12.5');
  });

  it('a schema order of clientPortfolio.orders', () => {
    expect(parseDemoPnl(withOrder({})).orders[0]).toEqual({
      orderId: 5001,
      etoroInstrumentId: 101,
      direction: 'buy',
      amountUsd: '1000',
      units: '10.5',
      rate: '1.3',
      leverage: '2',
      createdAt: '2024-01-01T09:00:00.000Z',
      stopLossRate: '1.2',
      takeProfitRate: '1.5',
      stopLossDisabled: false,
      takeProfitDisabled: false,
      trailingStopLoss: false,
    });
  });

  it('a schema ordersForOpen entry; orderType and statusId are kept as raw codes', () => {
    expect(parseDemoPnl(withForOpen({})).ordersForOpen[0]).toEqual({
      orderId: 1001,
      orderType: 1,
      statusId: 1,
      etoroInstrumentId: 101,
      direction: 'buy',
      amountUsd: '1000',
      amountInUnits: '10.5',
      leverage: '2',
      createdAt: '2024-01-01T09:00:00.000Z',
    });
  });

  it('several entries per container are sorted by id; duplicates are refused', () => {
    const parsed = parseDemoPnl(schemaPnl({ positions: [schemaPnlPosition({ positionID: 9 }), schemaPnlPosition({ positionID: 3 })], orders: [schemaPnlOrder({ orderId: 7 }), schemaPnlOrder({ orderId: 2 })] }));
    expect(parsed.positions.map((p) => p.positionId)).toEqual([3, 9]);
    expect(parsed.orders.map((o) => o.orderId)).toEqual([2, 7]);
    expect(refusal(schemaPnl({ ordersForOpen: [schemaPnlOrderForOpen(), schemaPnlOrderForOpen()] })).message).toContain('duplicate');
  });
});

describe('O21A.1 pnl parser: containers that are not read fail closed', () => {
  it('a non-empty ordersForClose or ordersForCloseMultiple is refused, even in schema shape (closing flows are not read)', () => {
    expect(refusal(schemaPnl({ ordersForClose: [schemaPnlOrderForClose()] })).message).toContain('clientPortfolio.ordersForClose is not empty');
    expect(refusal(schemaPnl({ ordersForCloseMultiple: [schemaPnlOrderForCloseMultiple()] })).message).toContain('clientPortfolio.ordersForCloseMultiple is not empty');
  });

  it('a non-empty mirrors, stockOrders, entryOrders or exitOrders is refused', () => {
    for (const container of ['mirrors', 'stockOrders', 'entryOrders', 'exitOrders']) {
      expect(refusal(schemaPnl({ [container]: [{}] })).message).toContain('clientPortfolio.' + container + ' is not empty');
    }
  });

  it('copy trading is refused: a position with mirrorID, an ordersForOpen entry with mirrorId other than 0', () => {
    expect(refusal(withPosition({ mirrorID: 1 })).message).toContain('mirrorID');
    expect(refusal(withForOpen({ mirrorId: 1 })).message).toContain('mirrorId');
  });

  for (const container of ['positions', 'mirrors', 'orders', 'ordersForOpen', 'ordersForClose', 'ordersForCloseMultiple']) {
    it(`a missing or non-array ${container} is refused`, () => {
      const body = schemaPnl();
      delete (body.clientPortfolio as Record<string, unknown>)[container];
      expect(refusal(body).message).toContain('clientPortfolio.' + container);
      expect(refusal(schemaPnl({ [container]: {} })).code).toBe('BROKER_RESPONSE_INVALID');
    });
  }
});

describe('O21A.1 pnl parser: REFERENCE_EXAMPLE shapes are not accepted under an alias', () => {
  it('the verbatim reference example position (camelCase, flat PnL) is refused at positionID', () => {
    const error = refusal(schemaPnl({ positions: [referenceExamplePnlPosition()] }));
    expect(error.code).toBe('BROKER_RESPONSE_INVALID');
    expect(error.message).toContain('positions[0].positionID');
  });

  it('positionId instead of positionID, instrumentId instead of instrumentID: refused', () => {
    const p = schemaPnlPosition({ positionId: 2150896073, instrumentId: 1002 });
    delete p.positionID;
    expect(refusal(schemaPnl({ positions: [p] })).message).toContain('positionID');
    const q = schemaPnlPosition({ instrumentId: 1002 });
    delete q.instrumentID;
    expect(refusal(schemaPnl({ positions: [q] })).message).toContain('instrumentID');
  });

  it('orderID instead of the schema orderId in orders: refused', () => {
    const o = schemaPnlOrder({ orderID: 5001 });
    delete o.orderId;
    expect(refusal(schemaPnl({ orders: [o] })).message).toContain('orders[0].orderId');
  });

  it('flat pnL / closeRate on the position are not read: without the nested unrealizedPnL the PnL is null', () => {
    const parsed = parseDemoPnl(withPosition({ unrealizedPnL: undefined, pnL: 100.25, closeRate: 1.25, timestamp: '2024-01-01T12:00:00Z' }));
    expect(parsed.positions[0]?.unrealizedPnl).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain('100.25');
  });
});

describe('O21A.1 pnl parser: malformed values are BROKER_RESPONSE_INVALID', () => {
  const cases: Array<[string, unknown, string]> = [
    ['position id as string', withPosition({ positionID: '1' }), 'positionID'],
    ['position id 0', withPosition({ positionID: 0 }), 'positionID'],
    ['position id unsafe integer', withPosition({ positionID: 2 ** 53 + 2 }), 'positionID'],
    ['instrument id fractional', withPosition({ instrumentID: 1.5 }), 'instrumentID'],
    ['position leverage not an integer (schema: integer)', withPosition({ leverage: 1.5 }), 'leverage'],
    ['position units as string', withPosition({ units: '1' }), 'units'],
    ['unrealizedPnL not an object', withPosition({ unrealizedPnL: 5 }), 'unrealizedPnL'],
    ['unrealizedPnL.pnL as string', withPosition({ unrealizedPnL: { pnL: '100' } }), 'unrealizedPnL.pnL'],
    ['unrealizedPnL.timestamp without zone', withPosition({ unrealizedPnL: { timestamp: '2024-01-01T12:00:00' } }), 'unrealizedPnL.timestamp'],
    ['order id negative', withOrder({ orderId: -1 }), 'orderId'],
    ['order instrument id unsafe', withOrder({ instrumentId: 2 ** 60 }), 'instrumentId'],
    ['order leverage fractional', withOrder({ leverage: 2.5 }), 'leverage'],
    ['order amount as string', withOrder({ amount: '1000' }), 'amount'],
    ['ordersForOpen statusId negative', withForOpen({ statusId: -1 }), 'statusId'],
    ['ordersForOpen orderType missing', withForOpen({ orderType: undefined }), 'orderType'],
    ['ordersForOpen amountInUnits as boolean', withForOpen({ amountInUnits: true }), 'amountInUnits'],
    ['credit missing', schemaPnl({ credit: undefined }), 'credit'],
    ['credit as string', schemaPnl({ credit: '10' }), 'credit'],
    ['unrealizedPnL total as string', schemaPnl({ unrealizedPnL: 'n/a' }), 'clientPortfolio.unrealizedPnL'],
    ['accountCurrencyId fractional', schemaPnl({ accountCurrencyId: 1.5 }), 'accountCurrencyId'],
  ];
  for (const [name, body, path] of cases) {
    it(name, () => {
      const error = refusal(body);
      expect(error.code).toBe('BROKER_RESPONSE_INVALID');
      expect(error.message).toContain(path);
    });
  }

  it('NaN and Infinity are refused (an overflowing JSON literal parses to Infinity)', () => {
    for (const v of [Number.NaN, Infinity, -Infinity]) {
      expect(refusal(withPosition({ openRate: v })).message).toContain('openRate');
      expect(refusal(withPosition({ unrealizedPnL: { pnL: v } })).message).toContain('pnL');
      expect(refusal(withForOpen({ amount: v })).message).toContain('amount');
    }
    expect(refusal(JSON.parse(JSON.stringify(schemaPnl()).replace('"credit":10000.5', '"credit":1e400'))).message).toContain('credit');
  });

  for (const field of ['positionID', 'instrumentID', 'isBuy', 'units', 'openRate', 'leverage', 'amount', 'openDateTime']) {
    it(`a position without ${field} is refused`, () => {
      const p = schemaPnlPosition();
      delete p[field];
      expect(refusal(schemaPnl({ positions: [p] })).message).toContain(field);
    });
  }

  for (const field of ['orderId', 'instrumentId', 'isBuy', 'amount', 'units', 'leverage', 'openDateTime']) {
    it(`an order without ${field} is refused`, () => {
      const o = schemaPnlOrder();
      delete o[field];
      expect(refusal(schemaPnl({ orders: [o] })).message).toContain(field);
    });
  }
});

describe('O21A.1 pnl parser: unknown fields, cash, and errors', () => {
  it('unknown fields are ignored and never kept', () => {
    const parsed = parseDemoPnl(schemaPnl({ positions: [schemaPnlPosition({ futureField: 'VALUE-XYZ' })], orders: [schemaPnlOrder({ brandNew: 'VALUE-ABC' })], newContainer: [{ a: 1 }] }));
    expect(JSON.stringify(parsed)).not.toMatch(/VALUE-XYZ|VALUE-ABC|futureField|brandNew|newContainer/);
  });

  it('cash fields are checked but never returned: no credit, bonusCredit, unrealizedPnL total or CID in the result', () => {
    const text = JSON.stringify(parseDemoPnl(withPosition({})));
    expect(text).not.toMatch(/10000\.5|"credit"|bonusCredit|"251"|accountCurrency|7765437|"cid"|CID/);
  });

  it('a refusal names the field path only, never a value', () => {
    const error = refusal(withPosition({ positionID: 'SECRET-POSITION-VALUE' }));
    expect(error.message).not.toContain('SECRET-POSITION-VALUE');
  });
});
