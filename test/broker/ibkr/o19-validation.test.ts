// Schema validation of IBKR responses: untrusted input is checked field by field, and a mismatch is an error, never a guess.
import { describe, expect, it } from 'vitest';
import { IbkrError } from '../../../src/broker/ibkr/ibkr-errors.js';
import { isBrokerageReady, parseAccounts, parseBrokerageAccounts, parseBrokerageStatus, parseLedger, parseMeta, parseOrders, parsePositions, parseTickle } from '../../../src/broker/ibkr/ibkr-validation.js';
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
  it('the tickle answer proves the outer session and nothing else: it never says the brokerage is ready', () => {
    expect(parseTickle(fixtureTickle())).toEqual({ sessionValid: true });
    // Whatever the tickle says about iserver, readiness is not derived from it.
    expect(parseTickle(fixtureTickle({ iserver: { authStatus: { authenticated: false, connected: false, competing: true } } }))).toEqual({ sessionValid: true });
    expect(parseTickle(fixtureTickle({ iserver: undefined }))).toEqual({ sessionValid: true });
  });

  it('fail closed: a missing or mistyped session identifier is BROKER_RESPONSE_INVALID, never a quiet "no session"', () => {
    expect(invalidOf(() => parseTickle(fixtureTickle({ session: undefined }))).code).toBe('BROKER_RESPONSE_INVALID');
    expect(invalidOf(() => parseTickle(fixtureTickle({ session: '' }))).message).toContain('tickle.session');
    expect(invalidOf(() => parseTickle(fixtureTickle({ session: 'x'.repeat(257) }))).code).toBe('BROKER_RESPONSE_INVALID');
    expect(invalidOf(() => parseTickle(fixtureTickle({ session: 12345 }))).code).toBe('BROKER_RESPONSE_INVALID');
  });

  it('fail closed: a missing, mistyped or non-finite expiry is BROKER_RESPONSE_INVALID', () => {
    expect(invalidOf(() => parseTickle(fixtureTickle({ ssoExpires: undefined }))).message).toContain('tickle.ssoExpires');
    expect(invalidOf(() => parseTickle(fixtureTickle({ ssoExpires: '460311' }))).code).toBe('BROKER_RESPONSE_INVALID');
    expect(invalidOf(() => parseTickle(fixtureTickle({ ssoExpires: Number.NaN }))).code).toBe('BROKER_RESPONSE_INVALID');
    expect(invalidOf(() => parseTickle(fixtureTickle({ ssoExpires: Number.POSITIVE_INFINITY }))).code).toBe('BROKER_RESPONSE_INVALID');
  });

  it('an expiry of zero or less is an expired session: BROKER_AUTH_REQUIRED, and the session identifier is not in the error', () => {
    for (const expires of [0, -5]) {
      const error = invalidOf(() => parseTickle(fixtureTickle({ ssoExpires: expires })));
      expect(error.code).toBe('BROKER_AUTH_REQUIRED');
      expect(error.message).not.toContain(FIXTURE_SESSION_TOKEN);
    }
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

describe('O19 IBKR validation: official brokerage status', () => {
  it('reads the four flags as they are', () => {
    expect(parseBrokerageStatus({ authenticated: true, connected: true, competing: false, established: true, message: '' })).toEqual({
      authenticated: true,
      connected: true,
      competing: false,
      established: true,
    });
  });

  it('fail closed: each missing required flag is refused, and the error names the field only', () => {
    const complete = { authenticated: true, connected: true, competing: false, established: true };
    for (const key of Object.keys(complete)) {
      const incomplete: Record<string, unknown> = { ...complete };
      delete incomplete[key];
      const error = invalidOf(() => parseBrokerageStatus(incomplete));
      expect(error.code).toBe('BROKER_RESPONSE_INVALID');
      expect(error.message).toContain('brokerage status.' + key);
    }
  });

  it('fail closed: a mistyped flag is refused, never coerced (strings, numbers, null and missing are not booleans)', () => {
    for (const bad of ['true', 1, 0, null, {}]) {
      expect(invalidOf(() => parseBrokerageStatus({ authenticated: bad, connected: true, competing: false, established: true })).code).toBe('BROKER_RESPONSE_INVALID');
      expect(invalidOf(() => parseBrokerageStatus({ authenticated: true, connected: true, competing: false, established: bad })).code).toBe('BROKER_RESPONSE_INVALID');
    }
  });

  it('a status body that is not an object, or is null, is refused', () => {
    expect(invalidOf(() => parseBrokerageStatus(['authenticated'])).code).toBe('BROKER_RESPONSE_INVALID');
    expect(invalidOf(() => parseBrokerageStatus(null)).code).toBe('BROKER_RESPONSE_INVALID');
  });

  it('a competing session is reported as competing, so the caller can stop; it is not refused as malformed', () => {
    expect(parseBrokerageStatus({ authenticated: true, connected: true, competing: true, established: true }).competing).toBe(true);
  });

  it('message and fail are optional; when present they must be bounded strings, and their content is never returned', () => {
    const base = { authenticated: true, connected: true, competing: false, established: true };
    expect(parseBrokerageStatus({ ...base })).toEqual(base);
    expect(parseBrokerageStatus({ ...base, message: null, fail: undefined })).toEqual(base);
    expect(parseBrokerageStatus({ ...base, message: 'Not authenticated', fail: '' })).toEqual(base);
    expect(invalidOf(() => parseBrokerageStatus({ ...base, message: 'x'.repeat(257) })).message).toContain('brokerage status.message');
    expect(invalidOf(() => parseBrokerageStatus({ ...base, fail: 42 })).message).toContain('brokerage status.fail');
  });

  it('the session token never appears in a refusal', () => {
    const error = invalidOf(() => parseBrokerageStatus({ authenticated: FIXTURE_SESSION_TOKEN, connected: true, competing: false, established: true }));
    expect(error.message).not.toContain(FIXTURE_SESSION_TOKEN);
  });
});

describe('O19 IBKR validation: the single readiness rule', () => {
  const flags = (authenticated: boolean, connected: boolean, competing: boolean, established: boolean) => ({ authenticated, connected, competing, established });

  it('ready only when authenticated, connected and established, and not competing', () => {
    expect(isBrokerageReady(flags(true, true, false, true))).toBe(true);
  });

  it('every other combination is not ready, including each inconsistent state', () => {
    expect(isBrokerageReady(flags(true, false, false, true))).toBe(false);
    expect(isBrokerageReady(flags(true, true, false, false))).toBe(false);
    expect(isBrokerageReady(flags(false, true, false, true))).toBe(false);
    expect(isBrokerageReady(flags(false, false, false, false))).toBe(false);
    expect(isBrokerageReady(flags(true, true, true, true))).toBe(false);
  });
});
