// Schema validation of IBKR responses: untrusted input is checked field by field, and a mismatch is an error, never a guess.
import { describe, expect, it } from 'vitest';
import { IbkrError } from '../../../src/broker/ibkr/ibkr-errors.js';
import { parseAccounts, parseBrokerageAccounts, parseLedger, parseMeta, parseOrders, parsePositions, parseTickle } from '../../../src/broker/ibkr/ibkr-validation.js';
import { FIXTURE_ACCOUNT, FIXTURE_CONID_AAPL, FIXTURE_OTHER_ACCOUNT, FIXTURE_SESSION_TOKEN, fixtureOrder, fixturePosition, fixtureTickle } from './o19-fixture.js';

function invalidOf(fn: () => unknown): IbkrError {
  try {
    fn();
  } catch (error) {
    if (error instanceof IbkrError) return error;
    throw error;
  }
  throw new Error('expected the response to be refused');
}

describe('O19 IBKR validation: session and accounts', () => {
  it('the tickle answer proves a valid session and a brokerage session only when both are present', () => {
    expect(parseTickle(fixtureTickle())).toEqual({ sessionValid: true, brokerageAuthenticated: true, competing: false });
    expect(parseTickle(fixtureTickle({ iserver: { authStatus: { authenticated: true, connected: false, competing: false } } }))).toMatchObject({ brokerageAuthenticated: false });
    expect(parseTickle(fixtureTickle({ iserver: { authStatus: { authenticated: true, connected: true, competing: true } } }))).toEqual({ sessionValid: true, brokerageAuthenticated: false, competing: true });
    expect(parseTickle(fixtureTickle({ session: undefined }))).toMatchObject({ sessionValid: false });
    expect(parseTickle(fixtureTickle({ ssoExpires: 0 }))).toMatchObject({ sessionValid: false });
    expect(parseTickle(fixtureTickle({ iserver: { authStatus: { authenticated: true, competing: true } } }))).toMatchObject({ brokerageAuthenticated: false });
    expect(parseTickle(fixtureTickle({ iserver: undefined }))).toMatchObject({ brokerageAuthenticated: false });
  });

  it('a tickle body that is not an object is refused', () => {
    expect(invalidOf(() => parseTickle('session'))).toMatchObject({ code: 'BROKER_RESPONSE_INVALID' });
  });

  it('accounts must be an array of well-formed ids, and accountId must agree with id', () => {
    expect(parseAccounts([{ id: FIXTURE_ACCOUNT, accountId: FIXTURE_ACCOUNT }])).toEqual([FIXTURE_ACCOUNT]);
    expect(invalidOf(() => parseAccounts([{ id: 'U1/../x' }])).code).toBe('BROKER_RESPONSE_INVALID');
    expect(invalidOf(() => parseAccounts([{ id: FIXTURE_ACCOUNT, accountId: FIXTURE_OTHER_ACCOUNT }])).message).toContain('accounts[0].accountId');
    expect(invalidOf(() => parseAccounts({ id: FIXTURE_ACCOUNT })).message).toContain('not an array');
  });

  it('the account metadata must describe the requested account', () => {
    expect(parseMeta({ id: FIXTURE_ACCOUNT, accountId: FIXTURE_ACCOUNT, currency: 'USD', clearingStatus: 'O' }, FIXTURE_ACCOUNT)).toEqual({ currency: 'USD', clearingStatus: 'O' });
    expect(invalidOf(() => parseMeta({ id: FIXTURE_OTHER_ACCOUNT, currency: 'USD' }, FIXTURE_ACCOUNT)).message).toContain('meta.id');
  });
});

describe('O19 IBKR validation: brokerage accounts after a start', () => {
  it('a started brokerage session lists at least one account id', () => {
    expect(parseBrokerageAccounts({ accounts: [FIXTURE_ACCOUNT], selectedAccount: FIXTURE_ACCOUNT })).toEqual([FIXTURE_ACCOUNT]);
    expect(parseBrokerageAccounts([FIXTURE_ACCOUNT])).toEqual([FIXTURE_ACCOUNT]);
  });

  it('an empty answer is not a started session', () => {
    expect(invalidOf(() => parseBrokerageAccounts({ accounts: [] })).message).toContain('no brokerage account');
    expect(invalidOf(() => parseBrokerageAccounts([])).code).toBe('BROKER_RESPONSE_INVALID');
  });

  it('an account entry that is not a plain identifier is refused', () => {
    expect(invalidOf(() => parseBrokerageAccounts({ accounts: ['U1/../x'] })).message).toContain('iserver.accounts[0]');
  });
});

describe('O19 IBKR validation: ledger and positions', () => {
  it('ledger cash is read per currency; the BASE duplicate is skipped; a key that is not a currency is refused', () => {
    expect(parseLedger({ USD: { cashbalance: 10.5, currency: 'USD' }, BASE: { cashbalance: 10.5, currency: 'BASE' } })).toEqual([{ currency: 'USD', cashBalance: expect.anything() }]);
    expect(invalidOf(() => parseLedger({ usd: { cashbalance: 1 } })).message).toContain('ledger key');
    expect(invalidOf(() => parseLedger({ USD: { cashbalance: 1, currency: 'EUR' } })).message).toContain('currency');
  });

  it('numbers that are not finite, or that IBKR would write in exponent notation, are refused, never rounded', () => {
    expect(invalidOf(() => parseLedger({ USD: { cashbalance: Number.NaN } })).message).toContain('cashbalance');
    expect(invalidOf(() => parseLedger({ USD: { cashbalance: Number.POSITIVE_INFINITY } })).code).toBe('BROKER_RESPONSE_INVALID');
    expect(invalidOf(() => parseLedger({ USD: { cashbalance: 1e21 } })).code).toBe('BROKER_RESPONSE_INVALID');
    expect(invalidOf(() => parseLedger({ USD: { cashbalance: '12abc' } })).code).toBe('BROKER_RESPONSE_INVALID');
  });

  it('a position of another account is refused, so no foreign holding can enter the snapshot [account mismatch]', () => {
    expect(invalidOf(() => parsePositions([fixturePosition({ acctId: FIXTURE_OTHER_ACCOUNT })], FIXTURE_ACCOUNT)).message).toContain('acctId');
  });

  it('the conid is accepted as a JSON integer or as digits text, and both give the same identity', () => {
    const numeric = parsePositions([fixturePosition({ conid: Number(FIXTURE_CONID_AAPL) })], FIXTURE_ACCOUNT);
    const textual = parsePositions([fixturePosition({ conid: FIXTURE_CONID_AAPL })], FIXTURE_ACCOUNT);
    expect(numeric[0]?.brokerInstrumentId).toBe(FIXTURE_CONID_AAPL);
    expect(textual[0]?.brokerInstrumentId).toBe(FIXTURE_CONID_AAPL);
    expect(invalidOf(() => parsePositions([fixturePosition({ conid: 'AAPL' })], FIXTURE_ACCOUNT)).message).toContain('conid');
  });

  it('an empty symbol or a currency that is not three capitals is refused', () => {
    expect(invalidOf(() => parsePositions([fixturePosition({ contractDesc: '' })], FIXTURE_ACCOUNT)).message).toContain('contractDesc');
    expect(invalidOf(() => parsePositions([fixturePosition({ currency: 'usd' })], FIXTURE_ACCOUNT)).message).toContain('currency');
  });

  it('a page with more than the page size is refused, and unknown extra fields are ignored', () => {
    const page = Array.from({ length: 101 }, () => fixturePosition());
    expect(invalidOf(() => parsePositions(page, FIXTURE_ACCOUNT)).message).toContain('too many entries');
    const withExtra = parsePositions([fixturePosition({ someNewField: { anything: true } })], FIXTURE_ACCOUNT);
    expect(withExtra).toHaveLength(1);
  });

  it('missing optional numbers stay null: nothing is invented', () => {
    const [position] = parsePositions([fixturePosition({ mktValue: undefined, unrealizedPnl: null })], FIXTURE_ACCOUNT);
    expect(position?.marketValue).toBeNull();
    expect(position?.unrealizedPnl).toBeNull();
  });
});

describe('O19 IBKR validation: open orders are read, never acted on', () => {
  it('a valid order is read with its side, quantity and status', () => {
    const [order] = parseOrders({ orders: [fixtureOrder()], snapshot: true }, FIXTURE_ACCOUNT);
    expect(order).toMatchObject({ externalOrderId: '1370093238', brokerInstrumentId: FIXTURE_CONID_AAPL, side: 'buy', status: 'Submitted' });
  });

  it('an order of another account is refused; an unknown side is refused; an odd status text is refused', () => {
    expect(invalidOf(() => parseOrders({ orders: [fixtureOrder({ acct: FIXTURE_OTHER_ACCOUNT })] }, FIXTURE_ACCOUNT)).message).toContain('acct');
    expect(invalidOf(() => parseOrders({ orders: [fixtureOrder({ side: 'SHORT' })] }, FIXTURE_ACCOUNT)).message).toContain('side');
    expect(invalidOf(() => parseOrders({ orders: [fixtureOrder({ status: 'Filled; DROP TABLE' })] }, FIXTURE_ACCOUNT)).message).toContain('status');
  });

  it('the session token never appears in any validation message', () => {
    const error = invalidOf(() => parsePositions([fixturePosition({ conid: FIXTURE_SESSION_TOKEN })], FIXTURE_ACCOUNT));
    expect(error.message).not.toContain(FIXTURE_SESSION_TOKEN);
  });
});
