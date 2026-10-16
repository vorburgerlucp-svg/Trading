// TEST FIXTURE ONLY. Synthetic values in the observed shape of the eToro demo portfolio: clientPortfolio.<container>. No real key,
// account or session exists in this file. The key markers are fake strings, used to prove that no key ever leaves the transport.
import type { EtoroOperation } from '../../../src/broker/etoro/etoro-readonly.js';
import type { EtoroResponse, EtoroTransport } from '../../../src/broker/etoro/etoro-transport.js';

export const KEY_MARKER = 'ETORO-API-KEY-MARKER-0001';
export const USER_MARKER = 'ETORO-USER-KEY-MARKER-0002';

/** An empty demo portfolio in the observed shape. Every container is empty; credit exists with a value nobody parses in O20. */
export function emptyDemoPortfolio(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientPortfolio: {
      positions: [],
      mirrors: [],
      credit: 100000,
      orders: [],
      stockOrders: [],
      entryOrders: [],
      exitOrders: [],
      ordersForOpen: [],
      ordersForClose: [],
      ordersForCloseMultiple: [],
      bonusCredit: 0,
      ...overrides,
    },
  };
}

/** A transport that records every operation and answers with a fixed response, or throws a fixed error. */
export class FixtureEtoroTransport implements EtoroTransport {
  readonly calls: EtoroOperation[] = [];
  response: EtoroResponse = { status: 200, body: emptyDemoPortfolio() };
  error: Error | null = null;

  async call(operation: EtoroOperation): Promise<EtoroResponse> {
    this.calls.push(operation);
    if (this.error) throw this.error;
    return this.response;
  }
}

export function fixedClock(iso: string) {
  let current = Date.parse(iso);
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}
