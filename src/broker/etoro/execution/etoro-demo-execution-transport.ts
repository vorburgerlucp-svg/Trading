// HTTPS transport for the eToro DEMO execution operations (O21). It is separate from the O20 read-only transport, and it accepts
// only an operation from ETORO_DEMO_EXECUTION_OPERATIONS with a URL built by demoOperationUrl: never a method, a path or a host.
// The keys travel only as request headers; they are never logged, stored or part of an error. Every request carries the
// x-request-id given by the caller, which is a fresh UUID per broker request.
//
// The transport reports what happened on the wire and nothing more. It does not retry and does not interpret a status: a request
// that may have reached the broker without an answer is reported as no_response, and the adapter decides what that means.

import { isValidEtoroKey } from '../etoro-credentials.js';
import type { EtoroCredentials } from '../etoro-transport.js';
import { ETORO_DEMO_EXECUTION_OPERATIONS, ETORO_EXECUTION_HOST, isUuid, type DemoExecutionOperation } from './etoro-demo-execution-endpoints.js';
import { DemoExecutionError } from './etoro-demo-execution-errors.js';

export const ETORO_EXECUTION_TIMEOUT_MS = 10_000;
export const ETORO_EXECUTION_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RETRY_AFTER_SECONDS = 3600;

export interface DemoWireRequest {
  readonly operation: DemoExecutionOperation;
  /** Built by demoOperationUrl only. */
  readonly url: string;
  /** A fresh UUID per broker request. */
  readonly requestId: string;
  /** The typed request body of open and close; absent for every other operation. */
  readonly body?: Readonly<Record<string, unknown>>;
}

export type DemoWireResult =
  /** The broker answered. body is the parsed JSON of a 2xx answer, null otherwise: an error body is discarded unread. */
  | { readonly kind: 'response'; readonly status: number; readonly body: unknown; readonly retryAfterSeconds: number | null }
  /** No complete answer: a timeout, an abort, a network failure, or an unreadable 2xx body. The request may have reached the broker. */
  | { readonly kind: 'no_response'; readonly reason: 'timeout' | 'network' | 'unreadable' };

export interface DemoExecutionTransport {
  send(request: DemoWireRequest): Promise<DemoWireResult>;
}

export type DemoExecutionFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpsDemoExecutionTransportOptions {
  credentials: EtoroCredentials;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Tests inject a fake here. The default is the global fetch with certificate verification on. */
  fetch?: DemoExecutionFetch;
}

function retryAfterOf(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (raw === null || !/^\d{1,5}$/.test(raw.trim())) return null;
  return Math.min(Number(raw.trim()), MAX_RETRY_AFTER_SECONDS);
}

async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) return null;
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

/** The URL must be on the fixed host and its path must be one of the allowlisted demo templates. */
function urlMatchesOperation(operation: DemoExecutionOperation, url: string): boolean {
  if (!url.startsWith(ETORO_EXECUTION_HOST + '/')) return false;
  const spec = ETORO_DEMO_EXECUTION_OPERATIONS[operation];
  const path = url.slice(ETORO_EXECUTION_HOST.length);
  const pattern = new RegExp(
    '^' + spec.template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[A-Za-z]+\}/g, '[1-9][0-9]{0,15}') + (operation === 'demo.order.lookup' ? '\\?(orderId=[1-9][0-9]{0,15}|referenceId=[0-9a-f-]{36})' : '') + '$',
  );
  return pattern.test(path) && path.includes('/demo/');
}

export class HttpsDemoExecutionTransport implements DemoExecutionTransport {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchFn: DemoExecutionFetch;

  constructor(private readonly options: HttpsDemoExecutionTransportOptions) {
    if (!isValidEtoroKey(options.credentials.apiKey) || !isValidEtoroKey(options.credentials.userKey)) {
      throw new DemoExecutionError('BROKER_AUTH_REQUIRED', 'the configured keys are missing or malformed');
    }
    this.timeoutMs = options.timeoutMs ?? ETORO_EXECUTION_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? ETORO_EXECUTION_MAX_RESPONSE_BYTES;
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async send(request: DemoWireRequest): Promise<DemoWireResult> {
    const spec = ETORO_DEMO_EXECUTION_OPERATIONS[request.operation];
    if (!spec || !urlMatchesOperation(request.operation, request.url)) throw new DemoExecutionError('INTENT_INVALID', 'operation or URL is not allowed');
    if (!isUuid(request.requestId)) throw new DemoExecutionError('INTENT_INVALID', 'requestId must be a UUID');
    const hasBody = request.operation === 'demo.order.open' || request.operation === 'demo.position.close';
    if (hasBody !== (request.body !== undefined)) throw new DemoExecutionError('INTENT_INVALID', 'request body does not match the operation');
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-api-key': this.options.credentials.apiKey,
      'x-user-key': this.options.credentials.userKey,
      'x-request-id': request.requestId,
    };
    if (hasBody) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchFn(request.url, {
        method: spec.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      return { kind: 'no_response', reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
    }
    const retryAfterSeconds = retryAfterOf(response);
    if (response.status < 200 || response.status > 299) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'response', status: response.status, body: null, retryAfterSeconds };
    }
    let text: string | null;
    try {
      text = await readBounded(response, this.maxResponseBytes);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      return { kind: 'no_response', reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
    }
    if (text === null) return { kind: 'no_response', reason: 'unreadable' };
    try {
      return { kind: 'response', status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown), retryAfterSeconds };
    } catch {
      return { kind: 'no_response', reason: 'unreadable' };
    }
  }
}
