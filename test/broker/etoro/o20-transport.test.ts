// The eToro HTTPS transport: the request shape (GET only, the three auth headers, a fresh x-request-id per request), the fixed
// error mapping, the bounds on the response, and the rule that no key ever leaves through a result or an error.
import { describe, expect, it } from 'vitest';
import { BrokerError } from '../../../src/broker/broker-errors.js';
import { ETORO_BASE_URL } from '../../../src/broker/etoro/etoro-readonly.js';
import { HttpsEtoroTransport, type EtoroFetch } from '../../../src/broker/etoro/etoro-transport.js';
import { KEY_MARKER, USER_MARKER, emptyDemoPortfolio } from './o20-fixture.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREDENTIALS = { apiKey: KEY_MARKER, userKey: USER_MARKER };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function recordingFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: EtoroFetch = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { fetch, calls };
}

async function errorOf(promise: Promise<unknown>): Promise<BrokerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrokerError) return error;
    throw error;
  }
  throw new Error('expected a BrokerError');
}

describe('O20 eToro transport: the request shape', () => {
  it('sends one GET to the demo portfolio path, with the three auth headers and no body', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(emptyDemoPortfolio()));
    await new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch }).call('portfolio.demo');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(ETORO_BASE_URL + '/trading/info/demo/portfolio');
    expect(call?.init.method).toBe('GET');
    expect(call?.init.body).toBeUndefined();
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY_MARKER);
    expect(headers['x-user-key']).toBe(USER_MARKER);
    expect(headers['accept']).toBe('application/json');
    expect(headers['x-request-id']).toMatch(UUID);
  });

  it('never follows a redirect, and always has a timeout signal', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(emptyDemoPortfolio()));
    await new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch }).call('portfolio.demo');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('x-request-id is unique per request: two calls carry two different ids', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(emptyDemoPortfolio()));
    const transport = new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch });
    await transport.call('portfolio.demo');
    await transport.call('portfolio.demo');
    const ids = calls.map((c) => (c.init.headers as Record<string, string>)['x-request-id']);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('the request id generator is used once per request', async () => {
    let next = 0;
    const { fetch, calls } = recordingFetch(() => jsonResponse(emptyDemoPortfolio()));
    const transport = new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch, requestId: () => 'fixed-' + ++next });
    await transport.call('portfolio.demo');
    expect((calls[0]?.init.headers as Record<string, string>)['x-request-id']).toBe('fixed-1');
  });

  it('an operation outside the allowlist is refused before any request is sent', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(emptyDemoPortfolio()));
    const error = await errorOf(new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch }).call('order.place' as unknown as 'portfolio.demo'));
    expect(error.code).toBe('BROKER_RESPONSE_INVALID');
    expect(calls).toHaveLength(0);
  });
});

describe('O20 eToro transport: the keys never leave', () => {
  it('a malformed key is refused at construction, and the error names no key', () => {
    expect(() => new HttpsEtoroTransport({ credentials: { apiKey: '', userKey: USER_MARKER } })).toThrow(BrokerError);
    try {
      new HttpsEtoroTransport({ credentials: { apiKey: 'has a space ' + KEY_MARKER, userKey: USER_MARKER } });
    } catch (error) {
      expect(String(error)).not.toContain(KEY_MARKER);
      expect(String(error)).not.toContain(USER_MARKER);
    }
  });

  it('a network failure whose text contains a key yields a fixed code, and the key is not in the error', async () => {
    const { fetch } = recordingFetch(() => {
      throw new Error('socket hang up for ' + KEY_MARKER + ' ' + USER_MARKER);
    });
    const error = await errorOf(new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch }).call('portfolio.demo'));
    expect(error.code).toBe('BROKER_NOT_CONNECTED');
    expect(error.message).not.toContain(KEY_MARKER);
    expect(error.message).not.toContain(USER_MARKER);
    expect(JSON.stringify(error)).not.toContain(KEY_MARKER);
  });

  it('an error body is discarded unread: the result carries no body and no key', async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ message: 'denied for ' + KEY_MARKER }, 401));
    const result = await new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch }).call('portfolio.demo');
    expect(result).toEqual({ status: 401, body: null });
    expect(JSON.stringify(result)).not.toContain(KEY_MARKER);
  });
});

describe('O20 eToro transport: the fixed error mapping of the transport itself', () => {
  it('a timeout is BROKER_TIMEOUT', async () => {
    const { fetch } = recordingFetch(() => {
      throw new DOMException('the operation timed out', 'TimeoutError');
    });
    expect((await errorOf(new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch }).call('portfolio.demo'))).code).toBe('BROKER_TIMEOUT');
  });

  it('an abort is BROKER_TIMEOUT as well', async () => {
    const { fetch } = recordingFetch(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    expect((await errorOf(new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch }).call('portfolio.demo'))).code).toBe('BROKER_TIMEOUT');
  });

  it('a 200 response with a JSON body is parsed', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(emptyDemoPortfolio()));
    const result = await new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch }).call('portfolio.demo');
    expect(result.status).toBe(200);
    expect(result.body).toEqual(emptyDemoPortfolio());
  });

  it('a 200 response that is not JSON is BROKER_RESPONSE_INVALID, and the text is not in the error', async () => {
    const { fetch } = recordingFetch(() => new Response('<html>' + KEY_MARKER + '</html>', { status: 200 }));
    const error = await errorOf(new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch }).call('portfolio.demo'));
    expect(error.code).toBe('BROKER_RESPONSE_INVALID');
    expect(error.message).not.toContain(KEY_MARKER);
  });

  it('a 200 response that is not UTF-8 is BROKER_RESPONSE_INVALID', async () => {
    const { fetch } = recordingFetch(() => new Response(new Uint8Array([0xff, 0xfe, 0xfd]), { status: 200 }));
    expect((await errorOf(new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch }).call('portfolio.demo'))).code).toBe('BROKER_RESPONSE_INVALID');
  });
});

describe('O20 eToro transport: the response is bounded', () => {
  it('a declared content length above the bound is refused before the body is read', async () => {
    const { fetch } = recordingFetch(() => new Response('{}', { status: 200, headers: { 'content-length': '5000' } }));
    const error = await errorOf(new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch, maxResponseBytes: 100 }).call('portfolio.demo'));
    expect(error.code).toBe('BROKER_RESPONSE_INVALID');
    expect(error.message).toContain('larger than the bound');
  });

  it('a streamed body above the bound is refused, even without a declared length', async () => {
    const big = new Uint8Array(200).fill(0x20);
    const { fetch } = recordingFetch(() => new Response(big, { status: 200 }));
    expect((await errorOf(new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch, maxResponseBytes: 100 }).call('portfolio.demo'))).code).toBe('BROKER_RESPONSE_INVALID');
  });

  it('a body within the bound is accepted', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(emptyDemoPortfolio()));
    const result = await new HttpsEtoroTransport({ credentials: CREDENTIALS, fetch, maxResponseBytes: 100_000 }).call('portfolio.demo');
    expect(result.status).toBe(200);
  });
});
