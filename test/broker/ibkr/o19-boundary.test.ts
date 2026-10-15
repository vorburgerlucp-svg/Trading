// The read-only boundary, checked on the code itself: the allowlist, the paths, the adapter's members, and the source of the
// IBKR path. A test that fails here means an execution capability has crept in.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IBKR_READ_OPERATIONS, buildIbkrPath } from '../../../src/broker/ibkr/ibkr-readonly.js';
import { IbkrBrokerSyncAdapter } from '../../../src/broker/ibkr/ibkr-sync-adapter.js';

const IBKR_DIR = fileURLToPath(new URL('../../../src/broker/ibkr/', import.meta.url));
const EXECUTION_WORDS = [
  'place',
  'placeOrder',
  'submitOrder',
  'modify',
  'modifyOrder',
  'replace',
  'replaceOrder',
  'cancel',
  'cancelOrder',
  'exerciseOption',
  'transferFunds',
  'withdraw',
  'deposit',
  'fxTrade',
  'rebalance',
  'request',
];
const EXECUTION_PATH = /place|modify|cancel|replace|exercise|transfer|withdraw|deposit|fxtrade|rebalance|whatif|reply|secdef/i;

describe('O19 read-only boundary: the allowlist', () => {
  it('[21] contains exactly the six read or keepalive operations', () => {
    expect(Object.keys(IBKR_READ_OPERATIONS).sort()).toEqual(['account.ledger', 'account.meta', 'accounts.list', 'orders.open', 'positions.page', 'session.tickle']);
  });

  it('[21] only the session keepalive is a POST; no PUT, DELETE or PATCH exists anywhere', () => {
    const methods = Object.entries(IBKR_READ_OPERATIONS).map(([name, spec]) => [name, spec.method] as const);
    expect(methods.filter(([, method]) => method === 'POST').map(([name]) => name)).toEqual(['session.tickle']);
    expect(methods.every(([, method]) => method === 'GET' || method === 'POST')).toBe(true);
  });

  it('[21] no path names an order action, a transfer, an exercise or a trade', () => {
    for (const spec of Object.values(IBKR_READ_OPERATIONS)) expect(spec.path).not.toMatch(EXECUTION_PATH);
  });

  it('paths are built only from validated parameters', () => {
    expect(buildIbkrPath('positions.page', { accountId: 'U1234567', pageId: 0 })).toBe('/portfolio/U1234567/positions/0');
    expect(() => buildIbkrPath('positions.page', { accountId: 'U1/../x', pageId: 0 })).toThrow('invalid IBKR account parameter');
    expect(buildIbkrPath('orders.open')).toBe('/iserver/account/orders');
    expect(() => buildIbkrPath('positions.page', { accountId: 'U1234567', pageId: 5 })).toThrow('invalid IBKR page parameter');
    expect(() => buildIbkrPath('account.meta', {})).toThrow('invalid IBKR account parameter');
  });
});

describe('O19 read-only boundary: the adapter and its source', () => {
  it('[22] the IBKR sync adapter has no method that could place, modify, cancel or transfer', () => {
    const members = Object.getOwnPropertyNames(IbkrBrokerSyncAdapter.prototype);
    for (const word of EXECUTION_WORDS) expect(members).not.toContain(word);
    expect(members).toEqual(expect.arrayContaining(['connection', 'fetchSnapshot']));
  });

  it('[22] no source file under src/broker/ibkr declares an execution function or a generic request function', () => {
    const files = readdirSync(IBKR_DIR).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(IBKR_DIR + file, 'utf8');
      for (const word of EXECUTION_WORDS) {
        const declaration = new RegExp(String.raw`(function\s+${word}\s*[(<])|(^\s*(?:export\s+)?(?:private\s+|static\s+|async\s+|readonly\s+)*${word}\s*[(<])`, 'm');
        expect(declaration.test(text), file + ' declares ' + word).toBe(false);
      }
    }
  });

  it('the transport module exports no function that accepts an arbitrary method or path', () => {
    const text = readFileSync(IBKR_DIR + 'ibkr-transport.ts', 'utf8');
    expect(text).not.toMatch(/call\(\s*method\s*:/);
    expect(text).not.toMatch(/path\s*:\s*string/);
  });
});
