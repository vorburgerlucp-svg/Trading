// The eToro demo read-only sync adapter (O20). It implements BrokerSyncAdapter only: one GET of the demo portfolio per sync, a
// schema check, and a snapshot. It has no order method and cannot call anything outside ETORO_ALLOWED_OPERATIONS. It never writes
// to the ledger and never maps an instrument: eToro instrumentId is the broker identity, and mappings are human-governed.
//
// Coverage is stated, not implied. An empty demo portfolio is a verified empty state. Cash is not read yet (its structure is not
// observed), and no account identifier is observed, so none is invented.

import type { AdapterConnection } from '../../ai/model-adapter.js';
import type { BrokerSnapshot, BrokerSyncAdapter } from '../broker-sync.js';
import { BrokerError } from '../broker-errors.js';
import type { EtoroTransport } from './etoro-transport.js';
import { parseDemoPortfolio } from './etoro-validation.js';

export interface EtoroCoverage {
  /** Not read: clientPortfolio.credit exists, but its fields are not observed yet. No cash is derived from it. */
  readonly cash: 'not_read';
  /** A verified empty container in the live demo payload. */
  readonly positions: 'verified_empty';
  /** Verified empty order containers in the live demo payload. */
  readonly openOrders: 'verified_empty';
  /** No stable account identifier was observed in the portfolio payload. */
  readonly accountIdentity: 'not_observed';
}

export const ETORO_COVERAGE: EtoroCoverage = Object.freeze({
  cash: 'not_read',
  positions: 'verified_empty',
  openOrders: 'verified_empty',
  accountIdentity: 'not_observed',
});

/** A BrokerSnapshot that states what it covers. Its accountId is null by construction in O20. */
export interface EtoroSnapshot extends BrokerSnapshot {
  readonly broker: 'etoro';
  readonly accountId: null;
  readonly coverage: EtoroCoverage;
}

export interface EtoroSyncAdapterOptions {
  transport: EtoroTransport;
  clock: () => Date;
}

export class EtoroBrokerSyncAdapter implements BrokerSyncAdapter {
  readonly broker = 'etoro' as const;
  readonly access = 'read_only' as const;
  private connected = false;
  private inFlight: Promise<EtoroSnapshot> | null = null;

  constructor(private readonly options: EtoroSyncAdapterOptions) {}

  connection(): AdapterConnection {
    return this.connected ? 'connected' : 'not_connected';
  }

  /** One sync at a time: a second call while one runs shares its result instead of sending another request. */
  fetchSnapshot(): Promise<EtoroSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.collect().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Maps the HTTP status to a fixed code. A failed request is never retried here. */
  private async call(): Promise<unknown> {
    const response = await this.options.transport.call('portfolio.demo');
    if (response.status === 401 || response.status === 403) throw new BrokerError('BROKER_AUTH_REQUIRED');
    if (response.status === 429) throw new BrokerError('BROKER_RATE_LIMITED');
    if (response.status >= 500) throw new BrokerError('BROKER_NOT_CONNECTED', 'broker returned ' + response.status);
    if (response.status !== 200) throw new BrokerError('BROKER_RESPONSE_INVALID', 'unexpected status');
    return response.body;
  }

  private async collect(): Promise<EtoroSnapshot> {
    try {
      const observedAt = this.options.clock().toISOString();
      parseDemoPortfolio(await this.call());
      const retrievedAt = this.options.clock().toISOString();
      this.connected = true;
      return {
        broker: 'etoro',
        accountId: null,
        access: 'read_only',
        observedAt,
        retrievedAt,
        cash: [],
        positions: [],
        openOrders: [],
        coverage: ETORO_COVERAGE,
      };
    } catch (error) {
      this.connected = false;
      throw error;
    }
  }
}
