// The complete, fixed set of eToro DEMO execution operations (O21). Verified against the official eToro API reference, section
// "Trading - Demo" (api-portal.etoro.com/api-reference/trading--demo, read on 2026-10-16). Nothing here is guessed:
//
//   demo.order.open       POST   /api/v2/trading/execution/demo/orders                                  "Create an order"
//   demo.order.cancel     DELETE /api/v2/trading/execution/demo/orders/{orderId}                        "Cancels an order before it is executed"
//   demo.position.close   POST   /api/v1/trading/execution/demo/market-close-orders/positions/{positionId}  "Close demo position by units"
//   demo.order.lookup     GET    /api/v2/trading/info/demo/orders:lookup?orderId=|referenceId=          "Get order information and position details"
//   demo.closeOrder.info  GET    /api/v1/trading/info/demo/close-orders/{orderId}                       "Get close order information ..."
//
// Every path is built here, from one fixed host and fixed literal segments that all contain "/demo/", with an identifier that is
// validated before it is placed in the path. There is no caller-supplied method, path, query or host, no generic request function,
// and no real-account path: this module cannot construct one.

export const ETORO_EXECUTION_HOST = 'https://public-api.etoro.com' as const;

/** The verified demo execution root; the open and cancel paths are below it. */
export const ETORO_DEMO_EXECUTION_ROOT = ETORO_EXECUTION_HOST + '/api/v2/trading/execution/demo';

export type DemoExecutionOperation = 'demo.order.open' | 'demo.order.cancel' | 'demo.position.close' | 'demo.order.lookup' | 'demo.closeOrder.info';

export interface DemoOperationSpec {
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** A write changes broker state: it is never retried, and a lost answer makes it ambiguous. */
  readonly write: boolean;
  /** The path template, for documentation and the boundary test. */
  readonly template: string;
}

export const ETORO_DEMO_EXECUTION_OPERATIONS: Readonly<Record<DemoExecutionOperation, DemoOperationSpec>> = Object.freeze({
  'demo.order.open': Object.freeze({ method: 'POST', write: true, template: '/api/v2/trading/execution/demo/orders' }),
  'demo.order.cancel': Object.freeze({ method: 'DELETE', write: true, template: '/api/v2/trading/execution/demo/orders/{orderId}' }),
  'demo.position.close': Object.freeze({ method: 'POST', write: true, template: '/api/v1/trading/execution/demo/market-close-orders/positions/{positionId}' }),
  'demo.order.lookup': Object.freeze({ method: 'GET', write: false, template: '/api/v2/trading/info/demo/orders:lookup' }),
  'demo.closeOrder.info': Object.freeze({ method: 'GET', write: false, template: '/api/v1/trading/info/demo/close-orders/{orderId}' }),
});

/** eToro order and position ids are int64 in the reference. NEXUS accepts positive safe integers only, so they round-trip exactly. */
export function isBrokerId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value.toLowerCase());
}

function requireBrokerId(value: number, name: string): string {
  if (!isBrokerId(value)) throw new RangeError(name + ' must be a positive safe integer');
  return String(value);
}

export type DemoLookupQuery = { readonly orderId: number } | { readonly referenceId: string };

/** The full URL of one operation. Only validated identifiers are placed in it. */
export function demoOperationUrl(operation: 'demo.order.open'): string;
export function demoOperationUrl(operation: 'demo.order.cancel', ids: { orderId: number }): string;
export function demoOperationUrl(operation: 'demo.position.close', ids: { positionId: number }): string;
export function demoOperationUrl(operation: 'demo.order.lookup', ids: DemoLookupQuery): string;
export function demoOperationUrl(operation: 'demo.closeOrder.info', ids: { orderId: number }): string;
export function demoOperationUrl(operation: DemoExecutionOperation, ids?: Record<string, unknown>): string {
  switch (operation) {
    case 'demo.order.open':
      return ETORO_DEMO_EXECUTION_ROOT + '/orders';
    case 'demo.order.cancel':
      return ETORO_DEMO_EXECUTION_ROOT + '/orders/' + requireBrokerId(ids?.orderId as number, 'orderId');
    case 'demo.position.close':
      return ETORO_EXECUTION_HOST + '/api/v1/trading/execution/demo/market-close-orders/positions/' + requireBrokerId(ids?.positionId as number, 'positionId');
    case 'demo.order.lookup': {
      const base = ETORO_EXECUTION_HOST + '/api/v2/trading/info/demo/orders:lookup';
      const hasOrder = ids !== undefined && 'orderId' in ids;
      const hasReference = ids !== undefined && 'referenceId' in ids;
      if (ids === undefined || hasOrder === hasReference) throw new RangeError('exactly one of orderId or referenceId is required');
      if (hasOrder) return base + '?orderId=' + requireBrokerId(ids.orderId as number, 'orderId');
      if (!isUuid(ids.referenceId)) throw new RangeError('referenceId must be a UUID');
      return base + '?referenceId=' + String(ids.referenceId).toLowerCase();
    }
    case 'demo.closeOrder.info':
      return ETORO_EXECUTION_HOST + '/api/v1/trading/info/demo/close-orders/' + requireBrokerId(ids?.orderId as number, 'orderId');
  }
}
