// The eToro demo read-only sync adapter (O20). It implements BrokerSyncAdapter only: one GET of the demo portfolio per sync, a
// schema check, and a snapshot. It has no order method and cannot call anything outside ETORO_ALLOWED_OPERATIONS. It never writes
// to the ledger and never maps an instrument: eToro instrumentId is the broker identity, and mappings are human-governed.
//
// Coverage is stated, not implied. An empty demo portfolio is a verified empty state (live observed in O20). Positions and pending
// orders of a non-empty portfolio are read with the documented schema (O21A). Non-empty positions have since been observed live
// (O21B/O21C portfolio, O22 /demo/pnl); pending orders have not. The coverage label of a non-empty portfolio is unchanged in this
// build ('documented_schema'). Cash is not read, and no account identifier is observed, so none is invented.
//
// The generic BrokerSnapshot positions and openOrders stay empty: they need a cost currency and an instrument the payload does not
// state. The eToro entries are carried in the eToro-specific fields instead, with the eToro instrument id as their identity.

import type { AdapterConnection } from '../../ai/model-adapter.js';
import type { BrokerSnapshot, BrokerSyncAdapter } from '../broker-sync.js';
import { BrokerError } from '../broker-errors.js';
import type { EtoroTransport } from './etoro-transport.js';
import { parseDemoPortfolio, type EtoroPendingOrder, type EtoroPosition } from './etoro-validation.js';

export interface EtoroCoverage {
  /** Not read: clientPortfolio.credit exists, but its meaning is not verified against a live account. No cash is derived from it. */
  readonly cash: 'not_read';
  /**
   * verified_empty: the container is empty (the live-observed shape). documented_schema: entries were read with the documented
   * schema, which is not yet observed in a live response.
   */
  readonly positions: 'verified_empty' | 'documented_schema';
  /** For clientPortfolio.orders; every other order container must be empty. */
  readonly openOrders: 'verified_empty' | 'documented_schema';
  /** No stable account identifier was observed in the portfolio payload. */
  readonly accountIdentity: 'not_observed';
}

export const ETORO_COVERAGE: EtoroCoverage = Object.freeze({
  cash: 'not_read',
  positions: 'verified_empty',
  openOrders: 'verified_empty',
  accountIdentity: 'not_observed',
});

function coverageOf(positions: number, orders: number): EtoroCoverage {
  if (positions === 0 && orders === 0) return ETORO_COVERAGE;
  return Object.freeze({
    cash: 'not_read',
    positions: positions === 0 ? 'verified_empty' : 'documented_schema',
    openOrders: orders === 0 ? 'verified_empty' : 'documented_schema',
    accountIdentity: 'not_observed',
  });
}

/** A BrokerSnapshot that states what it covers. Its accountId is null by construction. */
export interface EtoroSnapshot extends BrokerSnapshot {
  readonly broker: 'etoro';
  readonly accountId: null;
  readonly coverage: EtoroCoverage;
  /** The eToro positions and pending orders, validated, sorted by id. */
  readonly etoro: { readonly positions: readonly EtoroPosition[]; readonly orders: readonly EtoroPendingOrder[] };
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
      const portfolio = parseDemoPortfolio(await this.call());
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
        coverage: coverageOf(portfolio.positionCount, portfolio.orderCount),
        etoro: { positions: portfolio.positions, orders: portfolio.orders },
      };
    } catch (error) {
      this.connected = false;
      throw error;
    }
  }
}
