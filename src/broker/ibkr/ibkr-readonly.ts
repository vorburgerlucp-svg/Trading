// The complete, fixed set of IBKR operations this build may call. Each one is a read or the session keepalive (tickle).
// Order routes do not appear here, and there is no generic request function: a path outside this table cannot be built.
// Paths follow the official Client Portal Web API endpoint reference (interactivebrokers.github.io/cpwebapi/endpoints).
// minIntervalMs follows the official pacing table; the open-orders operation uses the stricter 5 s of /iserver/orders because
// the reference path (/iserver/account/orders) is not listed in that table.

export const IBKR_PORTFOLIO_PAGE_SIZE = 100;
export const IBKR_MAX_POSITION_PAGES = 5;

export const IBKR_READ_OPERATIONS = Object.freeze({
  'session.tickle': { method: 'POST', path: '/tickle', minIntervalMs: 0 },
  'accounts.list': { method: 'GET', path: '/portfolio/accounts', minIntervalMs: 5_000 },
  'account.meta': { method: 'GET', path: '/portfolio/{accountId}/meta', minIntervalMs: 0 },
  'account.ledger': { method: 'GET', path: '/portfolio/{accountId}/ledger', minIntervalMs: 0 },
  'positions.page': { method: 'GET', path: '/portfolio/{accountId}/positions/{pageId}', minIntervalMs: 0 },
  'orders.open': { method: 'GET', path: '/iserver/account/orders', minIntervalMs: 5_000 },
} as const);

export type IbkrReadOperation = keyof typeof IBKR_READ_OPERATIONS;

export interface IbkrOperationParams {
  accountId?: string;
  pageId?: number;
}

const ACCOUNT_ID = /^[A-Za-z0-9]{1,32}$/;

export function buildIbkrPath(operation: IbkrReadOperation, params: IbkrOperationParams = {}): string {
  const spec = IBKR_READ_OPERATIONS[operation];
  let path: string = spec.path;
  if (path.includes('{accountId}')) {
    if (params.accountId === undefined || !ACCOUNT_ID.test(params.accountId)) throw new Error('invalid IBKR account parameter');
    path = path.replace('{accountId}', params.accountId);
  }
  if (path.includes('{pageId}')) {
    const page = params.pageId;
    if (page === undefined || !Number.isSafeInteger(page) || page < 0 || page >= IBKR_MAX_POSITION_PAGES) throw new Error('invalid IBKR page parameter');
    path = path.replace('{pageId}', String(page));
  }
  return path;
}
