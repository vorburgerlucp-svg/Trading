// The bounded streaming reader for successful response bodies (docs/BOUNDED_STREAMING_HTTP_TRANSPORT_V1.md). It reads the body as a stream and counts the bytes it
// consumes. It refuses as soon as the total exceeds the bound, and it cancels the stream when it does. It decodes incrementally with a fatal UTF-8 decoder,
// so malformed bytes fail closed. It never returns partial text. Content-Length is only an early rejection hint. Errors carry no body text.
//
// The module lives beside the shared HTTP types, because the financial transports and the market-data providers use the same response shape. Every external
// body is read through it: the financial paths, and Twelve Data since docs/TWELVE_DATA_STREAMING_HARDENING_V1.md.

import type { HttpBodyReaderLike, HttpResponseLike } from './resilience.js';

/** The repository-wide hard ceiling for any configured response bound (§15). Every bound must be at most this. */
export const BODY_BOUND_CEILING = 64 * 1024 * 1024;

export type BodyErrorCode = 'BODY_TOO_LARGE' | 'BODY_STREAM_UNAVAILABLE' | 'BODY_INVALID_UTF8' | 'BODY_STREAM_INVALID' | 'BODY_BOUND_INVALID';

/** A transport failure while reading a body. The message names the rule and never contains body content. */
export class BodyTransportError extends Error {
  override readonly name = 'BodyTransportError';
  constructor(
    readonly code: BodyErrorCode,
    message: string,
    /** The error the stream raised, for a read failure. A caller that classifies transport failures reads it (TWELVE_DATA_STREAMING_HARDENING_V1 §6). */
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/** Content-Length as a canonical decimal: zero, or a digit string that does not start with zero (§6). */
const CANONICAL_DECIMAL = /^(0|[1-9]\d*)$/;

/** A bound must be a positive safe integer no larger than the ceiling (§15). Anything else is refused before any request is made. */
export function assertBodyBound(maxBytes: unknown, what: string): number {
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > BODY_BOUND_CEILING) {
    throw new BodyTransportError('BODY_BOUND_INVALID', what + ': the response bound must be a positive safe integer no larger than ' + BODY_BOUND_CEILING + ' bytes');
  }
  return maxBytes;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

async function cancelQuietly(reader: HttpBodyReaderLike): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The primary error is what the caller must see. A failing cancel never replaces it.
  }
}

/**
 * Reads a successful response body as UTF-8 text, under a byte bound. Exactly maxBytes is accepted, and maxBytes + 1 is refused. The byte count is the
 * authority: Content-Length can only refuse early. A missing body, malformed bytes or a stream failure throws a BodyTransportError. An abort is rethrown
 * unchanged, so the caller's timeout classification still applies.
 */
export async function readBoundedUtf8(response: HttpResponseLike, maxBytes: number): Promise<string> {
  assertBodyBound(maxBytes, 'body read');
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    if (!CANONICAL_DECIMAL.test(declared)) throw new BodyTransportError('BODY_STREAM_INVALID', 'Content-Length is not a canonical decimal');
    const length = Number(declared);
    if (!Number.isSafeInteger(length)) throw new BodyTransportError('BODY_STREAM_INVALID', 'Content-Length is outside the safe integer range');
    if (length > maxBytes) throw new BodyTransportError('BODY_TOO_LARGE', 'the declared body is larger than the bound');
  }
  const body = response.body;
  if (body === null || body === undefined || typeof body.getReader !== 'function') {
    throw new BodyTransportError('BODY_STREAM_UNAVAILABLE', 'the successful response has no readable body');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let total = 0;
  let released = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array)) throw new BodyTransportError('BODY_STREAM_INVALID', 'the body stream produced a value that is not bytes');
      total += chunk.byteLength;
      if (total > maxBytes) throw new BodyTransportError('BODY_TOO_LARGE', 'the body is larger than the bound');
      try {
        parts.push(decoder.decode(chunk, { stream: true }));
      } catch {
        throw new BodyTransportError('BODY_INVALID_UTF8', 'the body is not valid UTF-8');
      }
    }
    try {
      parts.push(decoder.decode());
    } catch {
      throw new BodyTransportError('BODY_INVALID_UTF8', 'the body is not valid UTF-8');
    }
  } catch (error) {
    // Overflow, malformed bytes and stream failures all cancel the stream, and none of them returns partial content.
    await cancelQuietly(reader);
    if (error instanceof BodyTransportError || isAbort(error)) throw error;
    throw new BodyTransportError('BODY_STREAM_INVALID', 'the body stream failed before it completed', error);
  } finally {
    if (!released) {
      released = true;
      try {
        reader.releaseLock();
      } catch {
        // The stream may already be closed. Nothing else holds the lock.
      }
    }
  }
  return parts.join('');
}
