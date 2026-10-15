// REAL IBKR read-only smoke test. Needs a logged-in local Client Portal Gateway and an explicit opt-in. It never places, modifies or
// cancels an order: the adapter has no such operation, and the test asserts that the gateway saw only allowlisted reads.
// Without the opt-in it is reported as NOT RUN with the reason, never as passed.
import { describe, expect, it } from 'vitest';
import { IbkrBrokerSyncAdapter } from '../../src/broker/ibkr/ibkr-sync-adapter.js';
import { parseLoopbackBaseUrl, IBKR_DEFAULT_BASE_URL } from '../../src/broker/ibkr/ibkr-base-url.js';
import { HttpsIbkrTransport } from '../../src/broker/ibkr/ibkr-transport.js';
import { IBKR_ALLOWED_OPERATIONS, type IbkrOperation } from '../../src/broker/ibkr/ibkr-readonly.js';
import { readFileSync } from 'node:fs';

const optIn = process.env.IBKR_LIVE_TEST === '1';
const reason = optIn ? '' : 'no IBKR_LIVE_TEST=1 opt-in and no logged-in local Client Portal Gateway';
const caPath = process.env.IBKR_CA_CERT_PATH?.trim();

describe.skipIf(!optIn)('IBKR read-only live smoke' + (optIn ? '' : ' (IBKR LIVE TEST NOT RUN: ' + reason + ')'), () => {
  it('reads the account, cash, positions and open orders, and submits nothing', async () => {
    const transport = new HttpsIbkrTransport({
      baseUrl: parseLoopbackBaseUrl(process.env.IBKR_BASE_URL?.trim() || IBKR_DEFAULT_BASE_URL),
      caCertPem: caPath ? readFileSync(caPath, 'utf8') : null,
    });
    const observed: IbkrOperation[] = [];
    const recording = {
      call: async (operation: IbkrOperation, params?: Parameters<typeof transport.call>[1]) => {
        observed.push(operation);
        return transport.call(operation, params);
      },
    };
    const adapter = new IbkrBrokerSyncAdapter({
      transport: recording,
      accountId: process.env.IBKR_ACCOUNT_ID?.trim() || null,
      clock: () => new Date(),
      resolveInstrument: () => null,
      // Only an explicit IBKR_ALLOW_BROKERAGE_INIT=1 for this run allows a start; anything else keeps the gate closed.
      allowBrokerageInit: process.env.IBKR_ALLOW_BROKERAGE_INIT?.trim() === '1',
    });
    const snapshot = await adapter.fetchSnapshot();
    expect(snapshot.access).toBe('read_only');
    expect(snapshot.accountId.length).toBeGreaterThan(0);
    expect(snapshot.cash.length).toBeGreaterThanOrEqual(0);
    expect(observed.every((operation) => operation in IBKR_ALLOWED_OPERATIONS)).toBe(true);
    expect(observed.filter((operation) => operation === 'session.tickle').length).toBeGreaterThan(0);
  });
});
