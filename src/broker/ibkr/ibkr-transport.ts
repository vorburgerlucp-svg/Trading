// HTTPS transport to the local Client Portal Gateway. Only the operations of IBKR_ALLOWED_OPERATIONS can be sent.
// No cookies or tokens are stored or sent by this code: the gateway holds the login. Certificate verification stays on: the
// gateway uses a self-signed certificate, so it is trusted only through an explicitly configured certificate (IBKR_CA_CERT_PATH),
// never by switching verification off. Response bodies are untrusted: size-bounded, time-bounded, parsed as JSON only.

import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { IbkrError } from './ibkr-errors.js';
import { IBKR_MAX_RESPONSE_BYTES_DEFAULT, IBKR_REQUEST_TIMEOUT_MS } from './ibkr-limits.js';
import { buildIbkrPath, IBKR_ALLOWED_OPERATIONS, IBKR_BROKERAGE_INIT_BODY, type IbkrOperation, type IbkrOperationParams } from './ibkr-readonly.js';

/** A fixed, non-sensitive product identifier. It names no user, account or machine. */
export const IBKR_USER_AGENT = 'NEXUS-O19/1.0' as const;

export interface IbkrResponse {
  readonly status: number;
  /** Parsed JSON, or null for an empty body. Untrusted until the validation layer has checked it. */
  readonly body: unknown;
}

export interface IbkrTransport {
  /** Only operations of IBKR_ALLOWED_OPERATIONS. The body comes from the operation's fixed definition, never from the caller. */
  call(operation: IbkrOperation, params?: IbkrOperationParams): Promise<IbkrResponse>;
}

/** Reads a response stream, refusing as soon as it exceeds the byte limit. */
export async function readBoundedText(stream: AsyncIterable<Uint8Array>, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new IbkrError('BROKER_RESPONSE_INVALID', 'response exceeds the size limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function toIbkrError(error: unknown): IbkrError {
  if (error instanceof IbkrError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return new IbkrError('BROKER_TIMEOUT');
  // Driver messages can carry host or certificate details: only a fixed, generic reason leaves this function.
  if (typeof code === 'string' && (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || /CERT|SIGNED|CHAIN|VERIFY/.test(code))) {
    return new IbkrError('BROKER_NOT_CONNECTED', 'TLS verification failed');
  }
  return new IbkrError('BROKER_NOT_CONNECTED', 'gateway request failed');
}

export type IbkrRequestFunction = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

export interface HttpsIbkrTransportOptions {
  /** A validated loopback base URL (see parseLoopbackBaseUrl). */
  baseUrl: URL;
  /** PEM text of the gateway's certificate, when it is not in the system trust store. Verification stays on either way. */
  caCertPem?: string | null;
  timeoutMs?: number;
  maxBodyBytes?: number;
  /** Replaces the network call. Used by tests only. */
  requestFunction?: IbkrRequestFunction;
}

export class HttpsIbkrTransport implements IbkrTransport {
  private readonly basePath: string;
  private readonly origin: string;
  private readonly ca: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly requestFunction: IbkrRequestFunction;

  constructor(options: HttpsIbkrTransportOptions) {
    this.origin = options.baseUrl.origin;
    this.basePath = options.baseUrl.pathname.replace(/\/+$/, '');
    this.ca = options.caCertPem ?? undefined;
    this.timeoutMs = options.timeoutMs ?? IBKR_REQUEST_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? IBKR_MAX_RESPONSE_BYTES_DEFAULT;
    this.requestFunction = options.requestFunction ?? httpsRequest;
  }

  call(operation: IbkrOperation, params: IbkrOperationParams = {}): Promise<IbkrResponse> {
    const spec = IBKR_ALLOWED_OPERATIONS[operation];
    // The body is fixed per operation: only brokerage.init has one, with compete=false. Nothing else can be sent.
    const body = spec.body === 'brokerage-init' ? JSON.stringify(IBKR_BROKERAGE_INIT_BODY) : undefined;
    const url = new URL(this.basePath + buildIbkrPath(operation, params), this.origin);
    return new Promise<IbkrResponse>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      // The gateway's request documentation asks for a User-Agent on every request. A POST without a body states its empty length:
      // otherwise the gateway waits for a body and the request times out.
      const headers: Record<string, string> = { accept: 'application/json', 'user-agent': IBKR_USER_AGENT };
      if (spec.method === 'POST') {
        headers['content-length'] = String(body === undefined ? 0 : Buffer.byteLength(body));
        if (body !== undefined) headers['content-type'] = 'application/json';
      }
      const request = this.requestFunction(
        url,
        { method: spec.method, headers, ca: this.ca, rejectUnauthorized: true },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status === 401 || status === 403) {
            response.resume();
            return settle(() => reject(new IbkrError('BROKER_AUTH_REQUIRED')));
          }
          if (status === 429) {
            response.resume();
            return settle(() => reject(new IbkrError('BROKER_RATE_LIMITED')));
          }
          if (status >= 300 && status < 400) {
            response.resume();
            return settle(() => reject(new IbkrError('BROKER_RESPONSE_INVALID', 'redirect is not followed')));
          }
          readBoundedText(response, this.maxBodyBytes).then(
            (text) => {
              let body: unknown = null;
              if (text.length > 0) {
                try {
                  body = JSON.parse(text) as unknown;
                } catch {
                  return settle(() => reject(new IbkrError('BROKER_RESPONSE_INVALID', 'body is not JSON')));
                }
              }
              settle(() => resolve({ status, body }));
            },
            (error: unknown) => settle(() => reject(toIbkrError(error))),
          );
        },
      );
      request.setTimeout(this.timeoutMs, () => request.destroy(new IbkrError('BROKER_TIMEOUT')));
      request.on('error', (error: unknown) => settle(() => reject(toIbkrError(error))));
      request.end(body);
    });
  }
}
