// O22 parser fix: orders:lookup. The first live answer (20.10.2026) stated asset.settlementType "REAL" where the reference documents
// "real", and the case-sensitive check refused the whole answer. These tests run offline against the parser and the runtime error
// mapping only: no transport, no broker request, no lock mock (the build locks are the real ones and stay closed).
import { describe, expect, it } from 'vitest';
import { BUILD_LOCKS } from '../../../src/nexus/safety.js';
import { DemoExecutionError } from '../../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import { ETORO_SETTLEMENT_TYPES, invalidFieldReason, parseOrderLookup } from '../../../src/broker/etoro/execution/etoro-demo-execution-validation.js';
import { errorBody, toRuntimeApiError } from '../../../src/runtime/errors.js';
import { LIVE_LIKE_ORDER_ID, LIVE_LIKE_POSITION_ID, liveLikeLookup } from './o22-order-lookup-fixture.js';

const INSTRUMENT = 100001;

function refusalOf(body: unknown): DemoExecutionError {
  try {
    parseOrderLookup(body);
  } catch (error) {
    if (error instanceof DemoExecutionError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

function withAsset(field: string, value: unknown): Record<string, unknown> {
  const body = liveLikeLookup(INSTRUMENT);
  const asset = body.asset as Record<string, unknown>;
  if (value === undefined) delete asset[field];
  else asset[field] = value;
  return body;
}

describe('O22 orders:lookup: the confirmed live structure', () => {
  it('the live-like answer (settlementType "REAL") is accepted: Filled, one position, settlement type in its documented spelling', () => {
    const status = parseOrderLookup(liveLikeLookup(INSTRUMENT));
    expect(status).toEqual({
      brokerOrderId: LIVE_LIKE_ORDER_ID,
      statusId: 3,
      outcome: 'filled',
      errorCode: null,
      instrumentId: INSTRUMENT,
      positionIds: [LIVE_LIKE_POSITION_ID],
      action: 'open',
      transaction: 'buy',
      settlementType: 'real',
    });
  });

  it('every documented settlement type is accepted in any letter case and returned in its documented spelling', () => {
    for (const documented of ETORO_SETTLEMENT_TYPES) {
      for (const stated of [documented, documented.toUpperCase(), documented.toLowerCase()]) {
        expect(parseOrderLookup(withAsset('settlementType', stated)).settlementType).toBe(documented);
      }
    }
    expect(parseOrderLookup(withAsset('settlementType', 'Real')).settlementType).toBe('real');
    expect(parseOrderLookup(withAsset('settlementType', 'REALFUTURES')).settlementType).toBe('realFutures');
  });

  it('a missing or null settlement type stays "not stated" (null), as before', () => {
    expect(parseOrderLookup(withAsset('settlementType', undefined)).settlementType).toBeNull();
    expect(parseOrderLookup(withAsset('settlementType', null)).settlementType).toBeNull();
  });

  it('anything but an exact case-insensitive documented value is still refused: no trimming, no prefix, no guess', () => {
    for (const value of [' real', 'real ', 'REAL\u0000', 'reall', 'rea', 'REAL_ASSET', 'stock', 'crypto', '', 'ｒｅａｌ', 1, 0, true, {}, ['real']]) {
      const e = refusalOf(withAsset('settlementType', value));
      expect(e.code, String(value)).toBe('BROKER_RESPONSE_INVALID');
      expect(e.reasons).toEqual(['INVALID_ASSET_SETTLEMENTTYPE']);
    }
  });

  it('the other enums stay strict (exact spelling): an upper-case action or transaction is refused', () => {
    const action = liveLikeLookup(INSTRUMENT);
    action.action = 'OPEN';
    expect(refusalOf(action).reasons).toEqual(['INVALID_ACTION']);
    const transaction = liveLikeLookup(INSTRUMENT);
    transaction.transaction = 'BUY';
    expect(refusalOf(transaction).reasons).toEqual(['INVALID_TRANSACTION']);
  });
});

describe('O22 orders:lookup: statuses', () => {
  it('pending and partial fill statuses keep their documented outcomes', () => {
    for (const id of [1, 2, 6, 11, 12]) expect(parseOrderLookup(liveLikeLookup(INSTRUMENT, { statusId: id, positionIds: [] })).outcome).toBe('pending');
    expect(parseOrderLookup(liveLikeLookup(INSTRUMENT, { statusId: 5 })).outcome).toBe('partially_filled');
    expect(parseOrderLookup(liveLikeLookup(INSTRUMENT, { statusId: 9 })).outcome).toBe('partially_filled_final');
    expect(parseOrderLookup(liveLikeLookup(INSTRUMENT, { statusId: 10 })).outcome).toBe('partially_filled_final');
  });

  it('an unknown status id is still refused', () => {
    for (const id of [0, 13, 99, -3]) expect(refusalOf(liveLikeLookup(INSTRUMENT, { statusId: id })).reasons).toEqual(['INVALID_STATUS_ID']);
    const notInt = liveLikeLookup(INSTRUMENT);
    (notInt.status as Record<string, unknown>).id = '3';
    expect(refusalOf(notInt).reasons).toEqual(['INVALID_STATUS_ID']);
  });
});

describe('O22 orders:lookup: missing, null and invalid fields', () => {
  const cases: [string, (b: Record<string, unknown>) => void, string][] = [
    ['orderId missing', (b) => delete b.orderId, 'INVALID_ORDERID'],
    ['orderId null', (b) => (b.orderId = null), 'INVALID_ORDERID'],
    ['orderId as text', (b) => (b.orderId = String(LIVE_LIKE_ORDER_ID)), 'INVALID_ORDERID'],
    ['status missing', (b) => delete b.status, 'INVALID_STATUS'],
    ['status null', (b) => (b.status = null), 'INVALID_STATUS'],
    ['status.id missing', (b) => delete (b.status as Record<string, unknown>).id, 'INVALID_STATUS_ID'],
    ['asset missing', (b) => delete b.asset, 'INVALID_ASSET'],
    ['asset null', (b) => (b.asset = null), 'INVALID_ASSET'],
    ['asset.instrumentId missing', (b) => delete (b.asset as Record<string, unknown>).instrumentId, 'INVALID_ASSET_INSTRUMENTID'],
    ['asset.instrumentId zero', (b) => ((b.asset as Record<string, unknown>).instrumentId = 0), 'INVALID_ASSET_INSTRUMENTID'],
    ['positionExecutions not an array', (b) => (b.positionExecutions = {}), 'INVALID_POSITIONEXECUTIONS'],
    ['positionExecutions entry null', (b) => (b.positionExecutions = [null]), 'INVALID_POSITIONEXECUTIONS'],
  ];
  for (const [name, change, reason] of cases) {
    it(name + ' is refused with ' + reason, () => {
      const body = liveLikeLookup(INSTRUMENT);
      change(body);
      const e = refusalOf(body);
      expect(e.code).toBe('BROKER_RESPONSE_INVALID');
      expect(e.reasons).toEqual([reason]);
    });
  }

  it('an invalid position id is refused (zero, negative, fraction, text, unsafe, missing)', () => {
    for (const bad of [0, -1, 1.5, String(LIVE_LIKE_POSITION_ID), Number.MAX_SAFE_INTEGER + 2, null, undefined]) {
      const body = liveLikeLookup(INSTRUMENT);
      const execution = (body.positionExecutions as Record<string, unknown>[])[0]!;
      if (bad === undefined) delete execution.positionId;
      else execution.positionId = bad;
      expect(refusalOf(body).reasons, String(bad)).toEqual(['INVALID_POSITIONEXECUTIONS_POSITIONID']);
    }
  });

  it('a refusal names the field, never a value of the answer', () => {
    const body = liveLikeLookup(INSTRUMENT);
    (body.positionExecutions as Record<string, unknown>[])[0]!.positionId = -LIVE_LIKE_POSITION_ID;
    const e = refusalOf(body);
    const text = e.message + ' ' + e.reasons.join(' ');
    for (const value of [String(LIVE_LIKE_POSITION_ID), String(LIVE_LIKE_ORDER_ID), '111111', '222222']) expect(text).not.toContain(value);
  });

  it('the reason code is derived from the field path only', () => {
    expect(invalidFieldReason('asset.settlementType')).toBe('INVALID_ASSET_SETTLEMENTTYPE');
    expect(invalidFieldReason('positionExecutions[0].positionId')).toBe('INVALID_POSITIONEXECUTIONS_POSITIONID');
    expect(invalidFieldReason('positionsToClose[12]')).toBe('INVALID_POSITIONSTOCLOSE');
    expect(invalidFieldReason('lookup response')).toBe('INVALID_LOOKUP_RESPONSE');
  });
});

describe('O22 runtime: the reason of a refused broker answer is passed on, nothing else', () => {
  it('BROKER_RESPONSE_INVALID carries its fixed reason code to the API body; the detail is never copied', () => {
    const e = refusalOf(withAsset('settlementType', 'REAL_ASSET'));
    const body = errorBody(toRuntimeApiError(e));
    expect(body.error.code).toBe('BROKER_RESPONSE_INVALID');
    expect(body.error.reasons).toEqual(['INVALID_ASSET_SETTLEMENTTYPE']);
    expect(JSON.stringify(body)).not.toContain('settlementType is not');
  });

  it('a reason that is not a fixed code is dropped, and other codes still pass no reason', () => {
    const odd = new DemoExecutionError('BROKER_RESPONSE_INVALID', 'x', ['value 12345', 'ORDER_ID_MISMATCH']);
    expect(toRuntimeApiError(odd).reasons).toEqual(['ORDER_ID_MISMATCH']);
    expect(toRuntimeApiError(new DemoExecutionError('INTENT_STATE_INVALID', 'x', ['SOME_REASON'])).reasons).toEqual([]);
  });
});

describe('O22 parser fix: the build locks', () => {
  it('all four build locks stay closed in this build', () => {
    expect(BUILD_LOCKS).toEqual({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: true });
    expect(Object.isFrozen(BUILD_LOCKS)).toBe(true);
  });
});
