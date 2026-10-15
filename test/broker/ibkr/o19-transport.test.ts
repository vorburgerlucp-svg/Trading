// The IBKR transport against an injected network function: no socket, no TLS stack, no real gateway. Covers the
// adversarial cases for responses: oversized body [5], malformed JSON [4], timeout [6], session errors [7], secrets in errors [8].
import { readFileSync } from 'node:fs';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseLoopbackBaseUrl } from '../../../src/broker/ibkr/ibkr-base-url.js';
import { IbkrError } from '../../../src/broker/ibkr/ibkr-errors.js';
import { HttpsIbkrTransport, readBoundedText } from '../../../src/broker/ibkr/ibkr-transport.js';

const MARKER = 'SECRET-MARKER-NEVER-IN-ERRORS';

class FakeRequest extends EventEmitter {
  timeoutCallback: (() => void) | null = null;
  ended = false;
  destroyedWith: Error | null = null;
  setTimeout(_ms: number, callback: () => void): this {
    this.timeoutCallback = callback;
    return this;
  }
  body: string | null = null;
  end(data?: string): void {
    this.ended = true;
    this.body = data ?? null;
  }
  destroy(error?: Error): this {
    this.destroyedWith = error ?? null;
    if (error) queueMicrotask(() => this.emit('error', error));
    return this;
  }
}

interface Seen {
  url: string;
  method: string | undefined;
  headers: Record<string, string> | undefined;
  ca: unknown;
  rejectUnauthorized: unknown;
}

type Behaviour = { kind: 'respond'; status: number; body: string } | { kind: 'hang' } | { kind: 'error'; error: Error & { code?: string } };

function fakeNetwork(behaviour: Behaviour) {
  const seen: Seen[] = [];
  const requests: FakeRequest[] = [];
  const requestFunction = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
    const headers = options.headers as Record<string, string> | undefined;
    seen.push({ url: url.toString(), method: options.method, headers, ca: options.ca, rejectUnauthorized: options.rejectUnauthorized });
    const request = new FakeRequest();
    requests.push(request);
    queueMicrotask(() => {
      if (behaviour.kind === 'hang') return;
      if (behaviour.kind === 'error') return void request.emit('error', behaviour.error);
      const response = Readable.from(behaviour.body.length > 0 ? [Buffer.from(behaviour.body)] : []);
      Object.assign(response, { statusCode: behaviour.status, headers: { 'set-cookie': ['x-sess=' + MARKER] } });
      callback(response as unknown as IncomingMessage);
    });
    return request as unknown as ClientRequest;
  };
  return { seen, requests, requestFunction };
}

function transportWith(behaviour: Behaviour, extra: { caCertPem?: string; maxBodyBytes?: number; timeoutMs?: number } = {}) {
  const network = fakeNetwork(behaviour);
  const transport = new HttpsIbkrTransport({
    baseUrl: parseLoopbackBaseUrl('https://localhost:5000/v1/api'),
    requestFunction: network.requestFunction,
    ...extra,
  });
  return { transport, ...network };
}

async function codeOf(promise: Promise<unknown>): Promise<IbkrError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IbkrError) return error;
    throw error;
  }
  throw new Error('expected an IbkrError');
}

describe('O19 IBKR transport: request shape', () => {
  it('sends only the allowlisted method and path, over loopback HTTPS, with certificate verification on and no session headers', async () => {
    const { transport, seen } = transportWith({ kind: 'respond', status: 200, body: '{"session":"x"}' }, { caCertPem: '-----PEM-----' });
    await transport.call('session.tickle');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://localhost:5000/v1/api/tickle');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.rejectUnauthorized).toBe(true);
    expect(seen[0]?.ca).toBe('-----PEM-----');
    // The gateway's request documentation asks for a User-Agent on every request; a POST without a body states its empty length.
    expect(Object.keys(seen[0]?.headers ?? {}).sort()).toEqual(['accept', 'content-length', 'user-agent']);
    expect(seen[0]?.headers?.['user-agent']).toBe('NEXUS-O19/1.0');
    expect(seen[0]?.headers?.['content-length']).toBe('0');
  });

  it('a GET carries the User-Agent but no content length', async () => {
    const { transport, seen } = transportWith({ kind: 'respond', status: 200, body: '[]' });
    await transport.call('accounts.list');
    expect(seen[0]?.headers?.['user-agent']).toBe('NEXUS-O19/1.0');
    expect(seen[0]?.headers?.['content-length']).toBeUndefined();
  });

  it('never disables certificate verification, even when no CA is configured', async () => {
    const { transport, seen } = transportWith({ kind: 'respond', status: 200, body: '{}' });
    await transport.call('session.tickle');
    expect(seen[0]?.rejectUnauthorized).toBe(true);
    expect(seen[0]?.ca).toBeUndefined();
  });

  it('builds the account path from the validated account id only', async () => {
    const { transport, seen } = transportWith({ kind: 'respond', status: 200, body: '[]' });
    await transport.call('accounts.list');
    await transport.call('positions.page', { accountId: 'U1234567', pageId: 0 });
    expect(seen.map((s) => s.url)).toEqual(['https://localhost:5000/v1/api/portfolio/accounts', 'https://localhost:5000/v1/api/portfolio/U1234567/positions/0']);
  });
});

describe('O19 IBKR transport: hostile responses fail closed', () => {
  it('[4] malformed JSON is rejected, and the error does not echo the body', async () => {
    const { transport } = transportWith({ kind: 'respond', status: 200, body: '{"session": ' + MARKER });
    const error = await codeOf(transport.call('session.tickle'));
    expect(error.code).toBe('BROKER_RESPONSE_INVALID');
    expect(error.message).not.toContain(MARKER);
  });

  it('[5] an oversized body is refused while it streams, before it is parsed', async () => {
    const { transport } = transportWith({ kind: 'respond', status: 200, body: JSON.stringify({ padding: 'x'.repeat(200) }) }, { maxBodyBytes: 64 });
    const error = await codeOf(transport.call('accounts.list'));
    expect(error.code).toBe('BROKER_RESPONSE_INVALID');
    expect(error.message).toContain('size limit');
  });

  it('[6] a gateway that never answers times out with a clean broker error', async () => {
    const network = fakeNetwork({ kind: 'hang' });
    const transport = new HttpsIbkrTransport({ baseUrl: parseLoopbackBaseUrl('https://localhost:5000/v1/api'), requestFunction: network.requestFunction, timeoutMs: 10 });
    const pending = codeOf(transport.call('session.tickle'));
    await new Promise((resolve) => setImmediate(resolve));
    network.requests[0]?.timeoutCallback?.();
    const error = await pending;
    expect(error.code).toBe('BROKER_TIMEOUT');
  });

  it('[7] an expired or missing session is reported as authentication required, not as a generic failure', async () => {
    const { transport } = transportWith({ kind: 'respond', status: 401, body: '{"error":"' + MARKER + '"}' });
    const error = await codeOf(transport.call('orders.open', { accountId: 'U1234567' }));
    expect(error.code).toBe('BROKER_AUTH_REQUIRED');
    expect(error.message).not.toContain(MARKER);
  });

  it('a rate limit is reported as such, and the response is not retried by the transport', async () => {
    const { transport, requests } = transportWith({ kind: 'respond', status: 429, body: '' });
    const error = await codeOf(transport.call('accounts.list'));
    expect(error.code).toBe('BROKER_RATE_LIMITED');
    expect(requests).toHaveLength(1);
  });

  it('a redirect is not followed', async () => {
    const { transport, requests } = transportWith({ kind: 'respond', status: 302, body: '' });
    const error = await codeOf(transport.call('accounts.list'));
    expect(error.code).toBe('BROKER_RESPONSE_INVALID');
    expect(requests).toHaveLength(1);
  });

  it('[8] a certificate failure is reported generically: no host name, no certificate text, no account', async () => {
    const tlsError = Object.assign(new Error('self signed certificate in chain for localhost ' + MARKER), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    const { transport } = transportWith({ kind: 'error', error: tlsError });
    const error = await codeOf(transport.call('session.tickle'));
    expect(error.code).toBe('BROKER_NOT_CONNECTED');
    expect(error.message).toContain('TLS verification failed');
    expect(error.message).not.toContain(MARKER);
    expect(error.message).not.toContain('localhost');
  });

  it('a refused connection is reported as not connected, with no driver text', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5000 ' + MARKER), { code: 'ECONNREFUSED' });
    const { transport } = transportWith({ kind: 'error', error: refused });
    const error = await codeOf(transport.call('session.tickle'));
    expect(error.code).toBe('BROKER_NOT_CONNECTED');
    expect(error.message).not.toContain(MARKER);
  });

  it('an empty body is null, not an invented object', async () => {
    const { transport } = transportWith({ kind: 'respond', status: 200, body: '' });
    const response = await transport.call('session.tickle');
    expect(response.body).toBeNull();
  });
});

describe('O19 IBKR transport: bodies are fixed per operation, never supplied by a caller', () => {
  it('brokerage.init sends exactly the fixed body with compete=false, with its true content length', async () => {
    const { transport, seen, requests } = transportWith({ kind: 'respond', status: 200, body: '{}' });
    await transport.call('brokerage.init');
    const expected = '{"publish":true,"compete":false}';
    expect(seen[0]?.url).toBe('https://localhost:5000/v1/api/iserver/auth/ssodh/init');
    expect(requests[0]?.body).toBe(expected);
    expect(seen[0]?.headers?.['content-type']).toBe('application/json');
    expect(seen[0]?.headers?.['content-length']).toBe(String(Buffer.byteLength(expected)));
  });

  it('a POST without a fixed body sends no body and states a zero length', async () => {
    const { transport, seen, requests } = transportWith({ kind: 'respond', status: 200, body: '{}' });
    await transport.call('session.tickle');
    expect(requests[0]?.body).toBeNull();
    expect(seen[0]?.headers?.['content-length']).toBe('0');
    expect(seen[0]?.headers?.['content-type']).toBeUndefined();
  });

  it('brokerage.status is a POST to the status path with no body and a zero content length, never the init path', async () => {
    const { transport, seen, requests } = transportWith({ kind: 'respond', status: 200, body: '{"authenticated":false,"connected":false,"competing":false,"established":false}' });
    await transport.call('brokerage.status');
    expect(seen[0]?.url).toBe('https://localhost:5000/v1/api/iserver/auth/status');
    expect(seen[0]?.method).toBe('POST');
    expect(requests[0]?.body).toBeNull();
    expect(seen[0]?.headers?.['content-length']).toBe('0');
    expect(seen[0]?.headers?.['content-type']).toBeUndefined();
  });

  it('a GET sends no body', async () => {
    const { transport, requests } = transportWith({ kind: 'respond', status: 200, body: '[]' });
    await transport.call('accounts.list');
    expect(requests[0]?.body).toBeNull();
  });

  it('the transport call takes no body from the caller: no parameter of the call can carry one', () => {
    const source = readFileSync(new URL('../../../src/broker/ibkr/ibkr-transport.ts', import.meta.url), 'utf8');
    expect(source).toContain('call(operation: IbkrOperation, params: IbkrOperationParams = {}): Promise<IbkrResponse>');
    expect(source).not.toMatch(/call\([^)]*body\s*:/);
  });
});

describe('O19 IBKR bounded body reader', () => {
  it('accepts a body within the limit and refuses one past it, without reading further', async () => {
    expect(await readBoundedText(Readable.from([Buffer.from('abc'), Buffer.from('def')]), 6)).toBe('abcdef');
    await expect(readBoundedText(Readable.from([Buffer.from('abcdefg')]), 6)).rejects.toMatchObject({ code: 'BROKER_RESPONSE_INVALID' });
  });
});
