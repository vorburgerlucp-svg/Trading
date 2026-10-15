// TEST FIXTURE ONLY. FixtureIbkrReadOnlyAdapter is a fake Client Portal Gateway: it answers the read-only operations with
// synthetic data in the shape of the official reference, records every call, and can be told to fail an operation. It is the
// only IBKR stand-in used by the CI tests. No real account, no real session, no real credential exists in this file.

import type { IbkrOperation, IbkrOperationParams } from '../../../src/broker/ibkr/ibkr-readonly.js';
import type { IbkrResponse, IbkrTransport } from '../../../src/broker/ibkr/ibkr-transport.js';

/** Synthetic values. The session token is a marker: no test may ever find it in an error, a log or a response. */
export const FIXTURE_ACCOUNT = 'U1234567';
export const FIXTURE_OTHER_ACCOUNT = 'U7654321';
export const FIXTURE_SESSION_TOKEN = 'SESSION-TOKEN-MARKER-DO-NOT-LEAK';
export const FIXTURE_CONID_AAPL = '265598';
export const FIXTURE_CONID_SPY = '756733';

export function fixtureTickle(overrides: Record<string, unknown> = {}): unknown {
  return {
    session: FIXTURE_SESSION_TOKEN,
    ssoExpires: 460311,
    collission: false,
    userId: 123456789,
    iserver: { authStatus: { authenticated: true, competing: false, connected: true, message: '' } },
    ...overrides,
  };
}

export function fixturePosition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    acctId: FIXTURE_ACCOUNT,
    conid: Number(FIXTURE_CONID_AAPL),
    contractDesc: 'AAPL',
    position: 2,
    mktPrice: 170.1234,
    mktValue: 340.25,
    currency: 'USD',
    avgCost: 150.5,
    avgPrice: 150.5,
    realizedPnl: 0,
    unrealizedPnl: 39.25,
    listingExchange: 'NASDAQ',
    assetClass: 'STK',
    ...overrides,
  };
}

export function fixtureOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    acct: FIXTURE_ACCOUNT,
    orderId: 1370093238,
    conid: FIXTURE_CONID_AAPL,
    side: 'BUY',
    totalSize: '1',
    status: 'Submitted',
    ...overrides,
  };
}

export function fixtureLedger(cashUsd = '1000.5'): unknown {
  return {
    USD: { cashbalance: Number(cashUsd), currency: 'USD', settledcash: Number(cashUsd), netliquidationvalue: 1340.75 },
    BASE: { cashbalance: Number(cashUsd), currency: 'BASE' },
  };
}

export interface FixtureData {
  tickle: unknown;
  accounts: unknown;
  meta: unknown;
  ledger: unknown;
  positionPages: unknown[][];
  orders: unknown;
}

export function defaultFixtureData(): FixtureData {
  return {
    tickle: fixtureTickle(),
    accounts: [{ id: FIXTURE_ACCOUNT, accountId: FIXTURE_ACCOUNT, currency: 'USD', type: 'INDIVIDUAL', clearingStatus: 'O' }],
    meta: { id: FIXTURE_ACCOUNT, accountId: FIXTURE_ACCOUNT, currency: 'USD', clearingStatus: 'O' },
    ledger: fixtureLedger(),
    positionPages: [[fixturePosition()]],
    orders: { orders: [fixtureOrder()], snapshot: true },
  };
}

export type BrokerageInitOutcome = 'ok' | 'refused' | 'server-error';

export class FixtureIbkrReadOnlyAdapter implements IbkrTransport {
  /** Every call the adapter made, in order. Tests assert on this to prove the read-only boundary. */
  readonly calls: Array<{ operation: IbkrOperation; params: IbkrOperationParams | undefined }> = [];
  private readonly failures = new Map<IbkrOperation, IbkrResponse | Error>();
  /** Whether the brokerage start succeeded in this fixture. Before a start, the tickle answers with the configured data. */
  brokerageStarted = false;
  /** How the brokerage initialization answers. */
  initOutcome: BrokerageInitOutcome = 'ok';
  /** Another client holds the brokerage session: the tickle then reports competing. */
  competingAfterInit = false;
  /** Whether the brokerage reports itself connected after a start. */
  connectedAfterInit = true;
  /** Accounts the brokerage session reports after a start. */
  brokerageAccounts: unknown = { accounts: [FIXTURE_ACCOUNT], selectedAccount: FIXTURE_ACCOUNT };

  constructor(public data: FixtureData = defaultFixtureData()) {}

  /** Makes one operation answer with this response, or throw this error, on every later call. */
  fail(operation: IbkrOperation, outcome: IbkrResponse | Error): void {
    this.failures.set(operation, outcome);
  }

  clearFailures(): void {
    this.failures.clear();
  }

  async call(operation: IbkrOperation, params?: IbkrOperationParams): Promise<IbkrResponse> {
    this.calls.push({ operation, params });
    const outcome = this.failures.get(operation);
    if (outcome instanceof Error) throw outcome;
    if (outcome !== undefined) return outcome;
    switch (operation) {
      case 'session.tickle':
        if (!this.brokerageStarted) return { status: 200, body: this.data.tickle };
        return {
          status: 200,
          body: fixtureTickle({ iserver: { authStatus: { authenticated: !this.competingAfterInit, connected: this.connectedAfterInit, competing: this.competingAfterInit } } }),
        };
      case 'brokerage.init':
        if (this.initOutcome === 'ok') {
          this.brokerageStarted = true;
          return { status: 200, body: {} };
        }
        return { status: this.initOutcome === 'refused' ? 409 : 500, body: null };
      case 'brokerage.accounts':
        return { status: 200, body: this.brokerageAccounts };
      case 'accounts.list':
        return { status: 200, body: this.data.accounts };
      case 'account.meta':
        return { status: 200, body: this.data.meta };
      case 'account.ledger':
        return { status: 200, body: this.data.ledger };
      case 'positions.page':
        return { status: 200, body: this.data.positionPages[params?.pageId ?? 0] ?? [] };
      case 'orders.open':
        return { status: 200, body: this.data.orders };
    }
  }

  /** Operations that were called, without duplicates, in first-call order. */
  operationsCalled(): IbkrOperation[] {
    return [...new Set(this.calls.map((c) => c.operation))];
  }
}
