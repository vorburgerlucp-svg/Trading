// The complete, fixed set of IBKR operations this build may call: reads, the session keepalive (tickle), and one brokerage
// session start with a fixed body. Order routes do not appear here, and there is no generic request function: a path outside
// this table cannot be built, and no caller can supply a body. Paths follow the official Client Portal Web API endpoint
// reference (interactivebrokers.github.io/cpwebapi/endpoints). minIntervalMs follows the official pacing table; the
// open-orders operation uses the stricter 5 s of /iserver/orders because its reference path is not listed in that table.

export const IBKR_PORTFOLIO_PAGE_SIZE = 100;
export const IBKR_MAX_POSITION_PAGES = 5;

/** The only body this build ever sends. compete stays false: this build never takes over another running session. */
export const IBKR_BROKERAGE_INIT_BODY = Object.freeze({ publish: true, compete: false } as const);

export const IBKR_ALLOWED_OPERATIONS = Object.freeze({
  'session.tickle': { method: 'POST', path: '/tickle', kind: 'session', body: 'none', minIntervalMs: 0 },
  'brokerage.init': { method: 'POST', path: '/iserver/auth/ssodh/init', kind: 'session', body: 'brokerage-init', minIntervalMs: 0 },
  'brokerage.accounts': { method: 'GET', path: '/iserver/accounts', kind: 'read', body: 'none', minIntervalMs: 0 },
  'accounts.list': { method: 'GET', path: '/portfolio/accounts', kind: 'read', body: 'none', minIntervalMs: 5_000 },
  'account.meta': { method: 'GET', path: '/portfolio/{accountId}/meta', kind: 'read', body: 'none', minIntervalMs: 0 },
  'account.ledger': { method: 'GET', path: '/portfolio/{accountId}/ledger', kind: 'read', body: 'none', minIntervalMs: 0 },
  'positions.page': { method: 'GET', path: '/portfolio/{accountId}/positions/{pageId}', kind: 'read', body: 'none', minIntervalMs: 0 },
  'orders.open': { method: 'GET', path: '/iserver/account/orders?accountId={accountId}', kind: 'read', body: 'none', minIntervalMs: 5_000 },
} as const);

export type IbkrOperation = keyof typeof IBKR_ALLOWED_OPERATIONS;

export interface IbkrOperationParams {
  accountId?: string;
  pageId?: number;
}

const ACCOUNT_ID = /^[A-Za-z0-9]{1,32}$/;

export function buildIbkrPath(operation: IbkrOperation, params: IbkrOperationParams = {}): string {
  const spec = IBKR_ALLOWED_OPERATIONS[operation];
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
