// HTTPS transport to the eToro public API, demo and read-only only. The keys travel only as request headers. They are never
// logged, never stored, and never part of an error: every failure is a fixed BrokerError code. Each request gets a fresh
// x-request-id. A response is bounded in size and must be UTF-8 JSON; an error response's body is discarded unread.

import { randomUUID } from 'node:crypto';
import { BrokerError } from '../broker-errors.js';
import { ETORO_ALLOWED_OPERATIONS, ETORO_BASE_URL, type EtoroOperation } from './etoro-readonly.js';

export const ETORO_DEFAULT_TIMEOUT_MS = 10_000;
export const ETORO_MAX_RESPONSE_BYTES = 1024 * 1024;
const KEY_FORMAT = /^[\x21-\x7e]{1,256}$/;

export interface EtoroCredentials {
  readonly apiKey: string;
  readonly userKey: string;
}

export interface EtoroResponse {
  readonly status: number;
  /** The parsed JSON body of a 200 response. Null for every other status: error bodies are never parsed or kept. */
  readonly body: unknown;
}

export interface EtoroTransport {
  call(operation: EtoroOperation): Promise<EtoroResponse>;
}

export type EtoroFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpsEtoroTransportOptions {
  credentials: EtoroCredentials;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Tests inject a fake here. The default is the global fetch with certificate verification on. */
  fetch?: EtoroFetch;
  /** Tests inject a fixed id generator here. The default is a random UUID per request. */
  requestId?: () => string;
}

function transportFailure(error: unknown): BrokerError {
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError' ? new BrokerError('BROKER_TIMEOUT') : new BrokerError('BROKER_NOT_CONNECTED');
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) throw new BrokerError('BROKER_RESPONSE_INVALID', 'response is larger than the bound');
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
      throw new BrokerError('BROKER_RESPONSE_INVALID', 'response is larger than the bound');
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new BrokerError('BROKER_RESPONSE_INVALID', 'response is not UTF-8');
  }
}

export class HttpsEtoroTransport implements EtoroTransport {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchFn: EtoroFetch;
  private readonly nextRequestId: () => string;

  constructor(private readonly options: HttpsEtoroTransportOptions) {
    if (!KEY_FORMAT.test(options.credentials.apiKey) || !KEY_FORMAT.test(options.credentials.userKey)) {
      throw new BrokerError('BROKER_AUTH_REQUIRED', 'the configured keys are missing or malformed');
    }
    this.timeoutMs = options.timeoutMs ?? ETORO_DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? ETORO_MAX_RESPONSE_BYTES;
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.nextRequestId = options.requestId ?? randomUUID;
  }

  async call(operation: EtoroOperation): Promise<EtoroResponse> {
    const spec = ETORO_ALLOWED_OPERATIONS[operation];
    if (!spec || spec.method !== 'GET') throw new BrokerError('BROKER_RESPONSE_INVALID', 'operation is not allowed');
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-api-key': this.options.credentials.apiKey,
      'x-user-key': this.options.credentials.userKey,
      'x-request-id': this.nextRequestId(),
    };
    let response: Response;
    try {
      response = await this.fetchFn(ETORO_BASE_URL + spec.path, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw transportFailure(error);
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, body: null };
    }
    let text: string;
    try {
      text = await readBounded(response, this.maxResponseBytes);
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw transportFailure(error);
    }
    try {
      return { status: 200, body: JSON.parse(text) as unknown };
    } catch {
      throw new BrokerError('BROKER_RESPONSE_INVALID', 'response is not JSON');
    }
  }
}
