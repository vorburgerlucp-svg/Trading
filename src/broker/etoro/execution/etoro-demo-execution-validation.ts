// Schema validation of the eToro demo execution responses (O21), following the official "Trading - Demo" reference. Every response
// is untrusted input: fail closed, no coercion, unknown fields ignored. Only the fields NEXUS needs are kept, each one validated.
// Free text from the broker (an error message, a status name beyond a fixed pattern) is never kept, and neither is an account id.

import { DemoExecutionError } from './etoro-demo-execution-errors.js';
import { isBrokerId, isUuid } from './etoro-demo-execution-endpoints.js';

function invalid(detail: string): DemoExecutionError {
  return new DemoExecutionError('BROKER_RESPONSE_INVALID', detail);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(path + ' is not an object');
  return value as Record<string, unknown>;
}

function idAt(value: unknown, path: string): number {
  if (!isBrokerId(value)) throw invalid(path + ' is not a positive integer id');
  return value;
}

function intAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalid(path + ' is not an integer');
  return value;
}

function optionalUuid(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (!isUuid(value)) throw invalid(path + ' is not a UUID');
  return (value as string).toLowerCase();
}

function idList(value: unknown, path: string, max = 100): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw invalid(path + ' is not a bounded array');
  return value.map((entry, i) => idAt(entry, path + '[' + i + ']'));
}

/** The order status ids of the reference ("Get order information and position details"). */
export const ETORO_ORDER_STATUS = Object.freeze({
  1: 'Received',
  2: 'Placed',
  3: 'Filled',
  4: 'Rejected',
  5: 'PartiallyFilled',
  6: 'PendingCancel',
  7: 'Canceled',
  8: 'Expired',
  9: 'CanceledPartiallyFilled',
  10: 'RejectedPartiallyFilled',
  11: 'WaitingForMarket',
  12: 'PendingTriggeredRate',
} as const);

export type BrokerOrderOutcome = 'pending' | 'filled' | 'partially_filled' | 'partially_filled_final' | 'rejected' | 'cancelled';

/**
 * Maps a status id to its outcome. Pending covers Received, Placed, PendingCancel, WaitingForMarket and PendingTriggeredRate.
 * CanceledPartiallyFilled and RejectedPartiallyFilled are final, and a position exists. An unknown id is refused, never guessed.
 */
export function brokerOrderOutcome(statusId: number): BrokerOrderOutcome {
  switch (statusId) {
    case 1:
    case 2:
    case 6:
    case 11:
    case 12:
      return 'pending';
    case 3:
      return 'filled';
    case 5:
      return 'partially_filled';
    case 9:
    case 10:
      return 'partially_filled_final';
    case 4:
      return 'rejected';
    case 7:
    case 8:
      return 'cancelled';
    default:
      throw invalid('status id ' + String(statusId) + ' is not a documented order status');
  }
}

/** Statuses at which a pending order can still be cancelled: waiting for the market, or for the trigger rate (MIT). */
export const CANCELLABLE_STATUS_IDS: ReadonlySet<number> = new Set([1, 2, 11, 12]);

export interface OpenOrderAccepted {
  readonly brokerOrderId: number;
  /** Echoes the x-request-id of the submission (reference: "the only handle you have if this response is lost"). */
  readonly referenceId: string;
  readonly token: string | null;
}

/** 200 of POST .../demo/orders. The referenceId must echo the request id: otherwise the answer is not for this request. */
export function parseOpenOrderAccepted(body: unknown, requestId: string): OpenOrderAccepted {
  const root = objectAt(body, 'order response');
  const brokerOrderId = idAt(root.orderId, 'orderId');
  const referenceId = optionalUuid(root.referenceId, 'referenceId');
  if (referenceId === null) throw invalid('referenceId is missing');
  if (referenceId !== requestId.toLowerCase()) throw invalid('referenceId does not echo the request id');
  return { brokerOrderId, referenceId, token: optionalUuid(root.token, 'token') };
}

/** 200 of DELETE .../demo/orders/{orderId}: accepted for processing only. The token is optional. */
export function parseCancelAccepted(body: unknown): { readonly token: string | null } {
  if (body === null) return { token: null };
  const root = objectAt(body, 'cancel response');
  return { token: optionalUuid(root.token, 'token') };
}

export interface CloseSubmitted {
  readonly closeOrderId: number;
  readonly positionId: number;
  readonly instrumentId: number;
  readonly statusId: number;
  readonly token: string | null;
}

/** 200 of POST .../demo/market-close-orders/positions/{positionId}: the close order was submitted, not executed. */
export function parseCloseSubmitted(body: unknown, expected: { positionId: number; instrumentId: number }): CloseSubmitted {
  const root = objectAt(body, 'close response');
  const order = objectAt(root.orderForClose, 'orderForClose');
  const positionId = idAt(order.positionID, 'orderForClose.positionID');
  const instrumentId = idAt(order.instrumentID, 'orderForClose.instrumentID');
  if (positionId !== expected.positionId) throw invalid('orderForClose.positionID does not match the request');
  if (instrumentId !== expected.instrumentId) throw invalid('orderForClose.instrumentID does not match the request');
  const statusId = intAt(order.statusID, 'orderForClose.statusID');
  brokerOrderOutcome(statusId);
  return { closeOrderId: idAt(order.orderID, 'orderForClose.orderID'), positionId, instrumentId, statusId, token: optionalUuid(root.token, 'token') };
}

export interface BrokerOrderStatus {
  readonly brokerOrderId: number;
  readonly statusId: number;
  readonly outcome: BrokerOrderOutcome;
  /** The broker's numeric error code, when the order failed. Its free-text message is never kept. */
  readonly errorCode: number | null;
  readonly instrumentId: number;
  /** Positions the order opened (open) or closes (close). */
  readonly positionIds: readonly number[];
}

/** 200 of GET .../demo/orders:lookup. */
export function parseOrderLookup(body: unknown): BrokerOrderStatus {
  const root = objectAt(body, 'lookup response');
  const status = objectAt(root.status, 'status');
  const statusId = intAt(status.id, 'status.id');
  const asset = objectAt(root.asset, 'asset');
  const executions = root.positionExecutions;
  if (executions !== undefined && executions !== null && (!Array.isArray(executions) || executions.length > 100)) throw invalid('positionExecutions is not a bounded array');
  const positionIds = (Array.isArray(executions) ? executions : []).map((entry, i) => idAt(objectAt(entry, 'positionExecutions[' + i + ']').positionId, 'positionExecutions[' + i + '].positionId'));
  const errorCode = status.errorCode === undefined || status.errorCode === null ? null : intAt(status.errorCode, 'status.errorCode');
  return {
    brokerOrderId: idAt(root.orderId, 'orderId'),
    statusId,
    outcome: brokerOrderOutcome(statusId),
    errorCode: errorCode === 0 ? null : errorCode,
    instrumentId: idAt(asset.instrumentId, 'asset.instrumentId'),
    positionIds: [...new Set([...positionIds, ...idList(root.positionsToClose, 'positionsToClose')])],
  };
}

/** 200 of GET .../demo/close-orders/{orderId}. */
export function parseCloseOrderInfo(body: unknown): BrokerOrderStatus {
  const root = objectAt(body, 'close order response');
  const statusId = intAt(root.statusID, 'statusID');
  const positions = root.positions;
  if (positions !== undefined && positions !== null && (!Array.isArray(positions) || positions.length > 100)) throw invalid('positions is not a bounded array');
  const positionIds = (Array.isArray(positions) ? positions : []).map((entry, i) => idAt(objectAt(entry, 'positions[' + i + ']').positionID, 'positions[' + i + '].positionID'));
  const errorCode = root.errorCode === undefined || root.errorCode === null ? null : intAt(root.errorCode, 'errorCode');
  return {
    brokerOrderId: idAt(root.orderID, 'orderID'),
    statusId,
    outcome: brokerOrderOutcome(statusId),
    errorCode: errorCode === 0 ? null : errorCode,
    instrumentId: idAt(root.instrumentID, 'instrumentID'),
    positionIds,
  };
}
