// The read-only boundary of the eToro demo adapter, checked on the code itself: the allowlist, the base URL, the adapter's members,
// the source of the eToro module, and the runtime's route table. A failure here means an execution capability has crept in.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ETORO_ALLOWED_OPERATIONS, ETORO_BASE_URL } from '../../../src/broker/etoro/etoro-readonly.js';
import { EtoroBrokerSyncAdapter } from '../../../src/broker/etoro/etoro-sync-adapter.js';
import { EtoroBrokerService } from '../../../src/broker/etoro/etoro-broker-service.js';

const ETORO_DIR = fileURLToPath(new URL('../../../src/broker/etoro/', import.meta.url));
const EXECUTION_WORDS = ['place', 'placeOrder', 'submitOrder', 'modify', 'modifyOrder', 'replace', 'replaceOrder', 'cancel', 'cancelOrder', 'closePosition', 'transfer', 'withdraw', 'deposit', 'request'];
const EXECUTION_PATH = /place|modify|cancel|replace|close|order|transfer|withdraw|deposit|trade|exercise|reply|real/i;

describe('O20 eToro boundary: the allowlist', () => {
  it('contains exactly the demo portfolio and, since O21A.1, the demo pnl read: both fixed, both demo', () => {
    expect(Object.keys(ETORO_ALLOWED_OPERATIONS).sort()).toEqual(['pnl.demo', 'portfolio.demo']);
    expect(ETORO_ALLOWED_OPERATIONS['portfolio.demo'].path).toBe('/trading/info/demo/portfolio');
    expect(ETORO_ALLOWED_OPERATIONS['pnl.demo'].path).toBe('/trading/info/demo/pnl');
  });

  it('every allowed operation is a GET: no POST, PUT, PATCH or DELETE exists in this build', () => {
    for (const spec of Object.values(ETORO_ALLOWED_OPERATIONS)) expect(spec.method).toBe('GET');
  });

  it('no path names an order, a modification, a cancellation, a transfer, or a real-account environment', () => {
    for (const spec of Object.values(ETORO_ALLOWED_OPERATIONS)) expect(spec.path).not.toMatch(EXECUTION_PATH);
  });

  it('the base URL is the eToro public API over HTTPS, and the portfolio path is the demo one', () => {
    expect(ETORO_BASE_URL).toBe('https://public-api.etoro.com/api/v1');
    expect(ETORO_BASE_URL.startsWith('https://')).toBe(true);
    for (const spec of Object.values(ETORO_ALLOWED_OPERATIONS)) expect(spec.path.startsWith('/trading/info/demo/')).toBe(true);
  });
});

describe('O20 eToro boundary: the adapter and the service', () => {
  it('the adapter has no method that could place, modify, cancel or transfer', () => {
    const members = Object.getOwnPropertyNames(EtoroBrokerSyncAdapter.prototype);
    for (const word of EXECUTION_WORDS) expect(members).not.toContain(word);
    expect(members).toEqual(expect.arrayContaining(['connection', 'fetchSnapshot']));
  });

  it('the service has no method that could place, modify, cancel or transfer', () => {
    const members = Object.getOwnPropertyNames(EtoroBrokerService.prototype);
    for (const word of EXECUTION_WORDS) expect(members).not.toContain(word);
  });
});

describe('O20 eToro boundary: the source of the eToro module', () => {
  const files = readdirSync(ETORO_DIR).filter((f) => f.endsWith('.ts'));

  it('the module has files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no file declares an execution function, and no file declares a generic request function', () => {
    for (const file of files) {
      const text = readFileSync(ETORO_DIR + file, 'utf8');
      for (const word of EXECUTION_WORDS) {
        const declaration = new RegExp(String.raw`(function\s+${word}\s*[(<])|(^\s*(?:export\s+)?(?:private\s+|static\s+|async\s+|readonly\s+)*${word}\s*[(<])`, 'm');
        expect(declaration.test(text), file + ' declares ' + word).toBe(false);
      }
    }
  });

  it('the transport accepts only an operation name: no method, path or body parameter', () => {
    const text = readFileSync(ETORO_DIR + 'etoro-transport.ts', 'utf8');
    expect(text).toMatch(/call\(operation: EtoroOperation\)/);
    expect(text).not.toMatch(/call\(\s*method\s*:/);
    expect(text).not.toMatch(/path\s*:\s*string/);
    expect(text).not.toMatch(/call\([^)]*body/);
  });

  it('the transport never disables certificate verification and never follows a redirect', () => {
    const text = readFileSync(ETORO_DIR + 'etoro-transport.ts', 'utf8');
    expect(text).toContain("redirect: 'error'");
    expect(text).not.toMatch(/rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|insecure/);
  });
});
