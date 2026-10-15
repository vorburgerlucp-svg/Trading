// The read-only boundary, checked on the code itself: the allowlist, the paths, the adapter's members, and the source of the
// IBKR path. A test that fails here means an execution capability has crept in.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IBKR_ALLOWED_OPERATIONS, IBKR_BROKERAGE_INIT_BODY, buildIbkrPath } from '../../../src/broker/ibkr/ibkr-readonly.js';
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
  it('[21] contains exactly the eight operations: six reads, the keepalive and the brokerage start', () => {
    expect(Object.keys(IBKR_ALLOWED_OPERATIONS).sort()).toEqual([
      'account.ledger',
      'account.meta',
      'accounts.list',
      'brokerage.accounts',
      'brokerage.init',
      'orders.open',
      'positions.page',
      'session.tickle',
    ]);
  });

  it('[21] exactly two operations are POST: the keepalive and the brokerage start. No PUT, DELETE or PATCH exists anywhere', () => {
    const methods = Object.entries(IBKR_ALLOWED_OPERATIONS).map(([name, spec]) => [name, spec.method] as const);
    expect(methods.filter(([, method]) => method === 'POST').map(([name]) => name).sort()).toEqual(['brokerage.init', 'session.tickle']);
    expect(methods.every(([, method]) => method === 'GET' || method === 'POST')).toBe(true);
  });

  it('[21] the only fixed body is the brokerage start, and it is compete=false; every other operation has no body', () => {
    const withBody = Object.entries(IBKR_ALLOWED_OPERATIONS).filter(([, spec]) => spec.body !== 'none').map(([name]) => name);
    expect(withBody).toEqual(['brokerage.init']);
    expect(IBKR_BROKERAGE_INIT_BODY).toEqual({ publish: true, compete: false });
  });

  it('[21] the explicitly forbidden routes are absent: no order POST, no order DELETE, no order suppression, no account order path', () => {
    const forbidden = [/\/order\//, /\/order$/, /questions\/suppress/, /\/iserver\/account\/[^/]+\/orders/];
    const methods: string[] = Object.values(IBKR_ALLOWED_OPERATIONS).map((spec) => spec.method);
    for (const [, spec] of Object.entries(IBKR_ALLOWED_OPERATIONS)) {
      for (const pattern of forbidden) expect(spec.path).not.toMatch(pattern);
    }
    expect(methods.some((method) => ['DELETE', 'PUT', 'PATCH'].includes(method))).toBe(false);
  });

  it('[21] the brokerage start is a session control, marked as such: not a read, not an order', () => {
    expect(IBKR_ALLOWED_OPERATIONS['brokerage.init'].kind).toBe('session');
    expect(IBKR_ALLOWED_OPERATIONS['brokerage.accounts'].kind).toBe('read');
  });

  it('[21] no path names an order action, a transfer, an exercise or a trade', () => {
    for (const spec of Object.values(IBKR_ALLOWED_OPERATIONS)) expect(spec.path).not.toMatch(EXECUTION_PATH);
  });

  it('paths are built only from validated parameters', () => {
    expect(buildIbkrPath('positions.page', { accountId: 'U1234567', pageId: 0 })).toBe('/portfolio/U1234567/positions/0');
    expect(() => buildIbkrPath('positions.page', { accountId: 'U1/../x', pageId: 0 })).toThrow('invalid IBKR account parameter');
    expect(buildIbkrPath('orders.open', { accountId: 'U1234567' })).toBe('/iserver/account/orders?accountId=U1234567');
    expect(() => buildIbkrPath('orders.open')).toThrow('invalid IBKR account parameter');
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
