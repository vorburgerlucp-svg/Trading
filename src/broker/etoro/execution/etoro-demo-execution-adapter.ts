// EToroDemoExecutionAdapter (O21): the only code that can write to eToro, and only to the demo environment. It is separate from the
// O20 read-only adapter and shares no write method with it. Every operation is fixed and typed; there is no generic request.
//
// Writes and reads are strictly separated:
//   - A write (open, close, cancel) is sent once and never retried here. An answer that does not prove the outcome (no answer, a
//     timeout, a 5xx, an unreadable or invalid 2xx) is AMBIGUOUS: the broker may have acted. A conclusive refusal (401/403, 429,
//     other 4xx) is REJECTED: the broker did not act.
//   - A read (order lookup, close order info) changes nothing at the broker and may be retried a bounded number of times.
// Writes are paced locally below the shared broker quota, and a broker Retry-After blocks all writes until it has passed.

import { randomUUID } from 'node:crypto';
import { closePositionBody, openOrderBody, type ExecutionIntent } from './execution-intent.js';
import { demoOperationUrl, type DemoLookupQuery } from './etoro-demo-execution-endpoints.js';
import { DemoExecutionError } from './etoro-demo-execution-errors.js';
import { assertSendable, serializeRequestBody, type DemoExecutionTransport, type DemoWireRequest, type DemoWireResult } from './etoro-demo-execution-transport.js';
import {
  parseCancelAccepted,
  parseCloseOrderInfo,
  parseCloseSubmitted,
  parseOpenOrderAccepted,
  parseOrderLookup,
  type BrokerOrderStatus,
  type CloseSubmitted,
  type OpenOrderAccepted,
} from './etoro-demo-execution-validation.js';

/** The broker quota is 20 writes per 60 s, shared by all execution endpoints. NEXUS uses at most half of it. */
export const DEMO_WRITE_PACING = Object.freeze({ maxWrites: 10, windowMs: 60_000, defaultRetryAfterMs: 60_000 });
export const DEMO_READ_ATTEMPTS = 3;
const MAX_READ_WAIT_MS = 5_000;

export type AmbiguityReason = 'timeout' | 'network' | 'unreadable' | 'server_error' | 'invalid_response' | 'unexpected_status';

export type WriteOutcome<T> =
  | { readonly kind: 'accepted'; readonly httpStatus: number; readonly result: T }
  | { readonly kind: 'rejected'; readonly httpStatus: number; readonly code: 'BROKER_AUTH_REQUIRED' | 'BROKER_RATE_LIMITED' | 'BROKER_REJECTED'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'ambiguous'; readonly httpStatus: number | null; readonly reason: AmbiguityReason };

/** O22 C3: a write that was built and validated before the reservation; submit() sends it once. */
export interface PreparedWrite<T> {
  readonly request: DemoWireRequest;
  readonly parse: (raw: unknown) => T;
}

export type ReadOutcome = { readonly kind: 'found'; readonly status: BrokerOrderStatus } | { readonly kind: 'not_found' };

/** Local write pacing: a sliding window, and a block until a broker Retry-After has passed. In-process state only. */
export class DemoWritePacer {
  private readonly writes: number[] = [];
  private blockedUntilMs = 0;

  constructor(private readonly limits: { maxWrites: number; windowMs: number; defaultRetryAfterMs: number } = DEMO_WRITE_PACING) {}

  available(nowMs: number): boolean {
    this.prune(nowMs);
    return nowMs >= this.blockedUntilMs && this.writes.length < this.limits.maxWrites;
  }

  /** Takes a write slot. Refuses (false) when none is free; the caller then sends nothing. */
  tryAcquire(nowMs: number): boolean {
    if (!this.available(nowMs)) return false;
    this.writes.push(nowMs);
    return true;
  }

  rateLimited(nowMs: number, retryAfterSeconds: number | null): void {
    const waitMs = retryAfterSeconds === null ? this.limits.defaultRetryAfterMs : retryAfterSeconds * 1000;
    this.blockedUntilMs = Math.max(this.blockedUntilMs, nowMs + waitMs);
  }

  private prune(nowMs: number): void {
    while (this.writes.length > 0 && nowMs - this.writes[0]! >= this.limits.windowMs) this.writes.shift();
  }
}

export interface DemoExecutionAdapterOptions {
  transport: DemoExecutionTransport;
  clock: () => Date;
  pacer?: DemoWritePacer;
  /** A fresh UUID per read request. Write request ids come from the caller, who persists them before the write. */
  requestId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export class EToroDemoExecutionAdapter {
  readonly broker = 'etoro' as const;
  readonly environment = 'demo' as const;
  readonly pacer: DemoWritePacer;
  private readonly nextRequestId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: DemoExecutionAdapterOptions) {
    this.pacer = options.pacer ?? new DemoWritePacer();
    this.nextRequestId = options.requestId ?? randomUUID;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * O22 C3/F10: builds and validates the open request without sending anything (body, its exact JSON text, URL, request id, the
   * transport's own checks). A request that could never be sent throws here, before the service reserves the submission; the
   * transport then sends exactly this text.
   */
  prepareOpen(intent: ExecutionIntent, requestId: string): PreparedWrite<OpenOrderAccepted> {
    const body = openOrderBody(intent);
    const request: DemoWireRequest = { operation: 'demo.order.open', url: demoOperationUrl('demo.order.open'), requestId, body, serializedBody: serializeRequestBody(body) };
    assertSendable(request);
    return Object.freeze({ request, parse: (raw: unknown) => parseOpenOrderAccepted(raw, requestId) });
  }

  /** O22 C3: builds and validates the close request of a known position without sending anything. */
  prepareClose(intent: ExecutionIntent, requestId: string): PreparedWrite<CloseSubmitted> {
    const positionId = intent.positionId;
    if (positionId === null) throw new DemoExecutionError('INTENT_INVALID', 'a close needs a positionId');
    const body = closePositionBody(intent);
    const request: DemoWireRequest = { operation: 'demo.position.close', url: demoOperationUrl('demo.position.close', { positionId }), requestId, body, serializedBody: serializeRequestBody(body) };
    assertSendable(request);
    return Object.freeze({ request, parse: (raw: unknown) => parseCloseSubmitted(raw, { positionId, instrumentId: intent.etoroInstrumentId }) });
  }

  /** Sends a prepared write once. */
  submit<T>(prepared: PreparedWrite<T>): Promise<WriteOutcome<T>> {
    return this.write(prepared.request, prepared.parse);
  }

  /** Opens a position: "Create an order" (mkt or mit). Sent once. */
  submitOpen(intent: ExecutionIntent, requestId: string): Promise<WriteOutcome<OpenOrderAccepted>> {
    return this.submit(this.prepareOpen(intent, requestId));
  }

  /** Closes a known position at market, fully or by units: "Close demo position by units". Sent once. */
  submitClose(intent: ExecutionIntent, requestId: string): Promise<WriteOutcome<CloseSubmitted>> {
    return this.submit(this.prepareClose(intent, requestId));
  }

  /** Cancels a pending order before it is executed. Sent once; the outcome is confirmed by a lookup. */
  cancelOrder(brokerOrderId: number, requestId: string): Promise<WriteOutcome<{ readonly token: string | null }>> {
    return this.write({ operation: 'demo.order.cancel', url: demoOperationUrl('demo.order.cancel', { orderId: brokerOrderId }), requestId }, parseCancelAccepted);
  }

  /** Order status by broker order id or by referenceId (the x-request-id of the submission). Read: retried, bounded. */
  lookupOrder(query: DemoLookupQuery): Promise<ReadOutcome> {
    return this.read(() => ({ operation: 'demo.order.lookup' as const, url: demoOperationUrl('demo.order.lookup', query) }), parseOrderLookup);
  }

  /** Close order status. Read: retried, bounded. */
  closeOrderInfo(closeOrderId: number): Promise<ReadOutcome> {
    return this.read(() => ({ operation: 'demo.closeOrder.info' as const, url: demoOperationUrl('demo.closeOrder.info', { orderId: closeOrderId }) }), parseCloseOrderInfo);
  }

  private async write<T>(request: Parameters<DemoExecutionTransport['send']>[0], parse: (body: unknown) => T): Promise<WriteOutcome<T>> {
    let result: DemoWireResult;
    try {
      result = await this.options.transport.send(request);
    } catch (error) {
      // A refusal of the transport itself (bad operation or id) happens before anything is sent.
      if (error instanceof DemoExecutionError) throw error;
      return { kind: 'ambiguous', httpStatus: null, reason: 'network' };
    }
    if (result.kind === 'no_response') return { kind: 'ambiguous', httpStatus: null, reason: result.reason };
    const status = result.status;
    if (status >= 200 && status <= 299) {
      try {
        return { kind: 'accepted', httpStatus: status, result: parse(result.body) };
      } catch {
        // The broker said yes, but the answer cannot be read: it may have acted.
        return { kind: 'ambiguous', httpStatus: status, reason: 'invalid_response' };
      }
    }
    if (status === 401 || status === 403) return { kind: 'rejected', httpStatus: status, code: 'BROKER_AUTH_REQUIRED', retryAfterSeconds: null };
    if (status === 429) {
      this.pacer.rateLimited(this.options.clock().getTime(), result.retryAfterSeconds);
      return { kind: 'rejected', httpStatus: status, code: 'BROKER_RATE_LIMITED', retryAfterSeconds: result.retryAfterSeconds };
    }
    if (status >= 500) return { kind: 'ambiguous', httpStatus: status, reason: 'server_error' };
    if (status >= 400 && status !== 408) return { kind: 'rejected', httpStatus: status, code: 'BROKER_REJECTED', retryAfterSeconds: null };
    return { kind: 'ambiguous', httpStatus: status, reason: 'unexpected_status' };
  }

  private async read(build: () => { operation: 'demo.order.lookup' | 'demo.closeOrder.info'; url: string }, parse: (body: unknown) => BrokerOrderStatus): Promise<ReadOutcome> {
    let lastCode: 'BROKER_NOT_CONNECTED' | 'BROKER_RATE_LIMITED' = 'BROKER_NOT_CONNECTED';
    for (let attempt = 1; attempt <= DEMO_READ_ATTEMPTS; attempt++) {
      const result = await this.options.transport.send({ ...build(), requestId: this.nextRequestId() });
      let waitMs = Math.min(500 * 2 ** (attempt - 1), MAX_READ_WAIT_MS);
      if (result.kind === 'response') {
        if (result.status === 200) return { kind: 'found', status: parse(result.body) };
        if (result.status === 404) return { kind: 'not_found' };
        if (result.status === 401 || result.status === 403) throw new DemoExecutionError('BROKER_AUTH_REQUIRED');
        if (result.status === 429) {
          lastCode = 'BROKER_RATE_LIMITED';
          if (result.retryAfterSeconds !== null) waitMs = result.retryAfterSeconds * 1000;
          if (waitMs > MAX_READ_WAIT_MS) break;
        } else if (result.status < 500) {
          throw new DemoExecutionError('BROKER_RESPONSE_INVALID', 'unexpected status ' + result.status, ['UNEXPECTED_HTTP_STATUS']);
        } else {
          lastCode = 'BROKER_NOT_CONNECTED';
        }
      } else {
        lastCode = 'BROKER_NOT_CONNECTED';
      }
      if (attempt < DEMO_READ_ATTEMPTS) await this.sleep(waitMs);
    }
    throw new DemoExecutionError(lastCode);
  }
}
