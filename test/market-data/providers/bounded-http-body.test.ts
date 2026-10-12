import { describe, expect, it } from 'vitest';
import { assertBodyBound, BODY_BOUND_CEILING, BodyTransportError, readBoundedUtf8 } from '../../../src/market-data/providers/bounded-http-body.js';
import type { HttpResponseLike } from '../../../src/market-data/providers/resilience.js';
import { bodyOf, chunksOf, failingBody, newProbe, responseWith, splitBytes, textResponse } from '../../financial/http-body-fixtures.js';

// docs/BOUNDED_STREAMING_HTTP_TRANSPORT_V1.md §4–§11. The reader counts bytes of the stream it consumes, never characters. It accepts exactly maxBytes and
// refuses maxBytes + 1. It decodes UTF-8 incrementally and fails closed on malformed bytes. It treats Content-Length as a hint only. No test makes a network call.

function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => (error as { code?: string }).code ?? 'UNEXPECTED',
  );
}

const enc = new TextEncoder();

describe('the byte limit (§5, brief 19)', () => {
  it('a 10-byte body is accepted when the limit is 10', async () => {
    expect(await readBoundedUtf8(textResponse('0123456789'), 10)).toBe('0123456789');
  });

  it('an 11-byte body is refused when the limit is 10', async () => {
    expect(await codeOf(readBoundedUtf8(textResponse('01234567890'), 10))).toBe('BODY_TOO_LARGE');
  });

  it('counts bytes, not characters: a 9-byte multibyte body is exactly at a 9-byte limit and over an 8-byte one', async () => {
    const text = 'ä€😀';
    expect(enc.encode(text).byteLength).toBe(9);
    expect(text.length).not.toBe(9);
    expect(await readBoundedUtf8(textResponse(text), 9)).toBe(text);
    expect(await codeOf(readBoundedUtf8(textResponse(text), 8))).toBe('BODY_TOO_LARGE');
  });

  it('many tiny chunks: 1000 one-byte chunks fit exactly in 1000 and not in 999', async () => {
    const text = 'x'.repeat(1000);
    expect(await readBoundedUtf8(responseWith({ body: bodyOf(chunksOf(text, 1)) }), 1000)).toBe(text);
    expect(await codeOf(readBoundedUtf8(responseWith({ body: bodyOf(chunksOf(text, 1)) }), 999))).toBe('BODY_TOO_LARGE');
  });

  it('one chunk exactly at the limit is accepted, and one chunk one byte over is refused', async () => {
    expect(await readBoundedUtf8(responseWith({ body: bodyOf([enc.encode('abcde')]) }), 5)).toBe('abcde');
    expect(await codeOf(readBoundedUtf8(responseWith({ body: bodyOf([enc.encode('abcdef')]) }), 5))).toBe('BODY_TOO_LARGE');
  });

  it('earlier chunks under the limit, and the final chunk crosses it: refused', async () => {
    const parts = [enc.encode('abcd'), enc.encode('efgh'), enc.encode('ijklm')];
    expect(await codeOf(readBoundedUtf8(responseWith({ body: bodyOf(parts) }), 10))).toBe('BODY_TOO_LARGE');
  });

  it('never reads a chunk after the one that crosses the limit', async () => {
    const probe = newProbe();
    const parts = [enc.encode('abcd'), enc.encode('efgh'), enc.encode('ijklm'), enc.encode('nopqr')];
    expect(await codeOf(readBoundedUtf8(responseWith({ body: bodyOf(parts, probe) }), 10))).toBe('BODY_TOO_LARGE');
    expect(probe.reads).toBe(3);
  });
});

describe('UTF-8 (§8, brief 7)', () => {
  it('ASCII decodes to the same text', async () => {
    expect(await readBoundedUtf8(textResponse('plain ASCII'), 64)).toBe('plain ASCII');
  });

  it('multibyte UTF-8 decodes to the same text as the native Response.text()', async () => {
    const text = 'Grüße € 😀 — ok';
    const native = await new Response(enc.encode(text)).text();
    expect(await readBoundedUtf8(textResponse(text), 256)).toBe(native);
    expect(native).toBe(text);
  });

  it('a multibyte character split across two chunks decodes correctly', async () => {
    const bytes = enc.encode('a€b');
    // '€' is three bytes, E2 82 AC. Split inside it.
    const parts = splitBytes(bytes, [2, 3]);
    expect(await readBoundedUtf8(responseWith({ body: bodyOf(parts) }), 16)).toBe('a€b');
  });

  it('exact boundary with multibyte data: the byte limit is exact, and the characters are intact', async () => {
    const text = '€€€';
    expect(enc.encode(text).byteLength).toBe(9);
    expect(await readBoundedUtf8(responseWith({ body: bodyOf(splitBytes(enc.encode(text), [4])) }), 9)).toBe(text);
    expect(await codeOf(readBoundedUtf8(responseWith({ body: bodyOf(splitBytes(enc.encode(text), [4])) }), 8))).toBe('BODY_TOO_LARGE');
  });

  it('malformed UTF-8 fails closed as BODY_INVALID_UTF8, and is never replaced with U+FFFD', async () => {
    const bad = responseWith({ body: bodyOf([new Uint8Array([0x41, 0xff, 0x42])]) });
    const error = await readBoundedUtf8(bad, 16).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BodyTransportError);
    expect((error as BodyTransportError).code).toBe('BODY_INVALID_UTF8');
  });

  it('a multibyte sequence truncated at the end of the stream fails closed', async () => {
    const truncated = responseWith({ body: bodyOf([new Uint8Array([0x41, 0xe2, 0x82])]) });
    expect(await codeOf(readBoundedUtf8(truncated, 16))).toBe('BODY_INVALID_UTF8');
  });

  it('a leading UTF-8 byte order mark is removed, as the native Response.text() removes it', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x42]);
    const native = await new Response(bytes).text();
    expect(await readBoundedUtf8(responseWith({ body: bodyOf([bytes]) }), 16)).toBe(native);
    expect(native).toBe('AB');
  });
});

describe('Content-Length as a hint (§6, brief 5)', () => {
  it('a declared length above the limit is refused before any read', async () => {
    const probe = newProbe();
    const response = textResponse('12345', { 'content-length': '11' }, probe);
    expect(await codeOf(readBoundedUtf8(response, 10))).toBe('BODY_TOO_LARGE');
    expect(probe.reads).toBe(0);
  });

  it('a declared length that is smaller than the actual body is caught by the stream count', async () => {
    expect(await codeOf(readBoundedUtf8(textResponse('0123456789A', { 'content-length': '5' }), 10))).toBe('BODY_TOO_LARGE');
  });

  it('a declared length equal to the limit is accepted when the decoded body is exactly the limit', async () => {
    expect(await readBoundedUtf8(textResponse('0123456789', { 'content-length': '10' }), 10)).toBe('0123456789');
  });

  it('an absent Content-Length is still bounded by the stream count', async () => {
    expect(await codeOf(readBoundedUtf8(textResponse('0123456789A'), 10))).toBe('BODY_TOO_LARGE');
  });

  it.each([['12x'], ['-1'], ['1.5'], [' 5'], [''], ['05'], ['9007199254740993'], ['1e3']])('a malformed Content-Length %j is refused as BODY_STREAM_INVALID', async (declared) => {
    expect(await codeOf(readBoundedUtf8(textResponse('abc', { 'content-length': declared }), 10))).toBe('BODY_STREAM_INVALID');
  });
});

describe('stream failures and chunk values (§9, brief 20)', () => {
  it('a chunk that is not a Uint8Array fails closed as BODY_STREAM_INVALID', async () => {
    const response = responseWith({ body: { getReader: () => ({ read: async () => ({ done: false, value: 'text chunk' }), cancel: async () => undefined, releaseLock: () => undefined }) } });
    expect(await codeOf(readBoundedUtf8(response, 16))).toBe('BODY_STREAM_INVALID');
  });

  it('a read failure that is not an abort returns no partial text', async () => {
    const response = responseWith({ body: failingBody(new TypeError('terminated'), [enc.encode('partial')]) });
    expect(await codeOf(readBoundedUtf8(response, 64))).toBe('BODY_STREAM_INVALID');
  });

  it('an abort error during a read is rethrown unchanged, so the caller classifies it as a timeout', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const error = await readBoundedUtf8(responseWith({ body: failingBody(abort) }), 64).catch((e: unknown) => e);
    expect(error).toBe(abort);
  });
});

describe('overflow cancellation (§11, brief 21)', () => {
  it('overflow cancels the reader and releases its lock', async () => {
    const probe = newProbe();
    await readBoundedUtf8(responseWith({ body: bodyOf([enc.encode('abcdef')], probe) }), 5).catch(() => undefined);
    expect(probe.cancels).toBe(1);
    expect(probe.releases).toBe(1);
  });

  it('a failing cancel does not replace the BODY_TOO_LARGE error', async () => {
    // Capped at 50 reads, so a missing bound fails the assertion instead of looping forever.
    let reads = 0;
    const body = {
      getReader: () => ({
        read: async () => (reads++ < 50 ? { done: false, value: enc.encode('abcdef') } : { done: true }),
        cancel: async () => {
          throw new Error('cancel failed');
        },
        releaseLock: () => undefined,
      }),
    };
    expect(await codeOf(readBoundedUtf8(responseWith({ body }), 5))).toBe('BODY_TOO_LARGE');
  });

  it('a successful read releases the lock', async () => {
    const probe = newProbe();
    await readBoundedUtf8(responseWith({ body: bodyOf([enc.encode('ok')], probe) }), 8);
    expect(probe.releases).toBe(1);
  });

  it('the body is obtained exactly once: no second reader and no second read of the same body', async () => {
    const probe = newProbe();
    await readBoundedUtf8(responseWith({ body: bodyOf([enc.encode('once')], probe) }), 8);
    expect(probe.getReaders).toBe(1);
  });
});

describe('a missing success body fails closed (§23, brief 22)', () => {
  it('an absent body is BODY_STREAM_UNAVAILABLE, never an empty text', async () => {
    expect(await codeOf(readBoundedUtf8(responseWith({ body: undefined }), 8))).toBe('BODY_STREAM_UNAVAILABLE');
  });

  it('a null body is BODY_STREAM_UNAVAILABLE', async () => {
    expect(await codeOf(readBoundedUtf8(responseWith({ body: null }), 8))).toBe('BODY_STREAM_UNAVAILABLE');
  });

  it('a body without a reader is BODY_STREAM_UNAVAILABLE', async () => {
    expect(await codeOf(readBoundedUtf8(responseWith({ body: {} as never }), 8))).toBe('BODY_STREAM_UNAVAILABLE');
  });

  it('text() is never called to recover a missing body', async () => {
    let called = false;
    const response: HttpResponseLike = { status: 200, headers: { get: () => null }, text: async () => ((called = true), 'fallback') };
    expect(await codeOf(readBoundedUtf8(response, 8))).toBe('BODY_STREAM_UNAVAILABLE');
    expect(called).toBe(false);
  });
});

describe('native Response compatibility (§21, brief 25)', () => {
  it('a native Response built from local bytes is read through the reader with the same text as its own text()', async () => {
    const bytes = enc.encode('native € body');
    const native = await new Response(bytes).text();
    expect(await readBoundedUtf8(new Response(bytes), 64)).toBe(native);
  });

  it('a native Response over the limit is refused', async () => {
    expect(await codeOf(readBoundedUtf8(new Response(enc.encode('0123456789A')), 10))).toBe('BODY_TOO_LARGE');
  });
});

describe('bound validation (§15, brief 18)', () => {
  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], [1.5], [Number.MAX_SAFE_INTEGER + 2], ['10' as unknown as number], [undefined as unknown as number]])(
    'a bound of %p is refused before any request is made',
    (bound) => {
      expect(() => assertBodyBound(bound, 'test')).toThrow();
    },
  );

  it('the repository ceiling is 64 MiB, and a bound at the ceiling is accepted', () => {
    expect(BODY_BOUND_CEILING).toBe(64 * 1024 * 1024);
    expect(assertBodyBound(BODY_BOUND_CEILING, 'test')).toBe(BODY_BOUND_CEILING);
    expect(() => assertBodyBound(BODY_BOUND_CEILING + 1, 'test')).toThrow();
  });

  it('splitBytes keeps every byte in order', () => {
    const bytes = enc.encode('abcdefg');
    expect(splitBytes(bytes, [2, 5]).map((p) => new TextDecoder().decode(p)).join('')).toBe('abcdefg');
  });
});
