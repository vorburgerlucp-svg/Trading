// Schema validation of the eToro demo portfolio: fail closed, empty containers are valid, a missing or mistyped container is refused,
// an oversized container is refused, a non-empty container is refused unless O21A reads its documented schema, and data outside
// clientPortfolio is never used.
import { describe, expect, it } from 'vitest';
import { BrokerError } from '../../../src/broker/broker-errors.js';
import { ETORO_MAX_ENTRIES, parseDemoPortfolio } from '../../../src/broker/etoro/etoro-validation.js';
import { emptyDemoPortfolio } from './o20-fixture.js';

function invalidOf(fn: () => unknown): BrokerError {
  try {
    fn();
  } catch (error) {
    if (error instanceof BrokerError) return error;
    throw error;
  }
  throw new Error('expected the response to be refused');
}

const CONTAINERS = ['positions', 'mirrors', 'orders', 'stockOrders', 'entryOrders', 'exitOrders', 'ordersForOpen', 'ordersForClose', 'ordersForCloseMultiple'];

describe('O20 eToro validation: the empty demo portfolio', () => {
  it('an empty demo portfolio is a valid state: zero positions and zero orders', () => {
    expect(parseDemoPortfolio(emptyDemoPortfolio())).toMatchObject({ positionCount: 0, orderCount: 0 });
  });

  it('empty containers are valid, whatever the cash value is', () => {
    expect(parseDemoPortfolio(emptyDemoPortfolio({ credit: 0 }))).toMatchObject({ positionCount: 0, orderCount: 0 });
    expect(parseDemoPortfolio(emptyDemoPortfolio({ credit: '12.50' }))).toMatchObject({ positionCount: 0, orderCount: 0 });
  });

  it('unknown fields inside clientPortfolio are ignored when the required containers are correct', () => {
    expect(parseDemoPortfolio(emptyDemoPortfolio({ someNewField: { anything: true }, bonusCredit: 'unknown-type' }))).toMatchObject({ positionCount: 0, orderCount: 0 });
  });
});

describe('O20 eToro validation: the observed location is used, nothing else', () => {
  it('data at the top level is never used: a non-empty top-level positions field does not make the portfolio non-empty', () => {
    expect(parseDemoPortfolio({ ...emptyDemoPortfolio(), positions: [{ instrumentId: 1 }] })).toMatchObject({ positionCount: 0, orderCount: 0 });
    expect(parseDemoPortfolio({ ...emptyDemoPortfolio(), data: { positions: [{ instrumentId: 1 }] } })).toMatchObject({ positionCount: 0, orderCount: 0 });
  });

  it('a missing clientPortfolio is BROKER_RESPONSE_INVALID, and a top-level positions field does not replace it', () => {
    expect(invalidOf(() => parseDemoPortfolio({ positions: [] })).code).toBe('BROKER_RESPONSE_INVALID');
    expect(invalidOf(() => parseDemoPortfolio({})).message).toContain('clientPortfolio');
  });

  it('a clientPortfolio that is not an object is refused', () => {
    expect(invalidOf(() => parseDemoPortfolio({ clientPortfolio: [] })).code).toBe('BROKER_RESPONSE_INVALID');
    expect(invalidOf(() => parseDemoPortfolio({ clientPortfolio: 'portfolio' })).code).toBe('BROKER_RESPONSE_INVALID');
  });

  it('a top-level array or a null body is refused', () => {
    expect(invalidOf(() => parseDemoPortfolio([])).code).toBe('BROKER_RESPONSE_INVALID');
    expect(invalidOf(() => parseDemoPortfolio(null)).code).toBe('BROKER_RESPONSE_INVALID');
  });
});

describe('O20 eToro validation: required containers', () => {
  it('a missing credit is refused: the cash container must be present, even though its value is not read', () => {
    const body = emptyDemoPortfolio();
    delete (body.clientPortfolio as Record<string, unknown>).credit;
    expect(invalidOf(() => parseDemoPortfolio(body)).message).toContain('clientPortfolio.credit');
    expect(invalidOf(() => parseDemoPortfolio(emptyDemoPortfolio({ credit: null }))).code).toBe('BROKER_RESPONSE_INVALID');
  });

  for (const container of CONTAINERS) {
    it(`a missing ${container} is BROKER_RESPONSE_INVALID`, () => {
      const body = emptyDemoPortfolio();
      delete (body.clientPortfolio as Record<string, unknown>)[container];
      const error = invalidOf(() => parseDemoPortfolio(body));
      expect(error.code).toBe('BROKER_RESPONSE_INVALID');
      expect(error.message).toContain('clientPortfolio.' + container);
    });

    it(`a ${container} that is not an array is BROKER_RESPONSE_INVALID`, () => {
      expect(invalidOf(() => parseDemoPortfolio(emptyDemoPortfolio({ [container]: {} }))).code).toBe('BROKER_RESPONSE_INVALID');
      expect(invalidOf(() => parseDemoPortfolio(emptyDemoPortfolio({ [container]: 'none' }))).code).toBe('BROKER_RESPONSE_INVALID');
      expect(invalidOf(() => parseDemoPortfolio(emptyDemoPortfolio({ [container]: null }))).code).toBe('BROKER_RESPONSE_INVALID');
    });
  }
});

describe('O20 eToro validation: bounds and refusals', () => {
  it('an array above the entry bound is refused, and it is never truncated', () => {
    const big = Array.from({ length: ETORO_MAX_ENTRIES + 1 }, () => ({}));
    const error = invalidOf(() => parseDemoPortfolio(emptyDemoPortfolio({ positions: big })));
    expect(error.code).toBe('BROKER_RESPONSE_INVALID');
    expect(error.message).toContain('too many entries');
  });

  // O21A: positions and orders are read with the documented element schema; an entry that does not match it is refused, not guessed.
  for (const container of ['positions', 'orders']) {
    it(`a non-empty ${container} entry that does not match the documented schema is refused (O21A)`, () => {
      const error = invalidOf(() => parseDemoPortfolio(emptyDemoPortfolio({ [container]: [{ instrumentId: 1, units: 2 }] })));
      expect(error.code).toBe('BROKER_RESPONSE_INVALID');
      expect(error.message).toContain('clientPortfolio.' + container + '[0]');
    });
  }

  for (const container of CONTAINERS.filter((c) => c !== 'positions' && c !== 'orders')) {
    it(`a non-empty ${container} is refused too`, () => {
      expect(invalidOf(() => parseDemoPortfolio(emptyDemoPortfolio({ [container]: [{ id: 1 }] }))).message).toContain('clientPortfolio.' + container + ' is not empty');
    });
  }

  it('a refusal names the field only, never a value from the response', () => {
    const error = invalidOf(() => parseDemoPortfolio(emptyDemoPortfolio({ positions: [{ secret: 'VALUE-THAT-MUST-NOT-LEAK' }] })));
    expect(error.message).not.toContain('VALUE-THAT-MUST-NOT-LEAK');
  });
});
