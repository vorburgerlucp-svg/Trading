// The bounded streaming reader for response bodies (docs/BOUNDED_STREAMING_HTTP_TRANSPORT_V1.md, docs/BOUNDED_STREAMING_TRANSPORT_V2.md). It reads the body as a
// stream and counts the bytes it consumes. It refuses as soon as the total exceeds the bound, and it cancels the stream when it does. Provider chunks are
// coalesced into fixed 64 KiB blocks and decoded with a fatal UTF-8 decoder, so the number of retained text parts does not follow the number of chunks, and
// malformed bytes fail closed. The reader caps the number of data chunks and the run of consecutive empty chunks, so no provider can spend unbounded reads.
// It never returns partial text. Content-Length is only an early rejection hint. Errors carry no body text.
//
// The module lives beside the shared HTTP types, because the financial transports and the market-data providers use the same response shape. Every external
// body is read through it: the financial paths, and Twelve Data since docs/TWELVE_DATA_STREAMING_HARDENING_V1.md.

import type { HttpBodyReaderLike, HttpResponseLike } from './resilience.js';

/** The repository-wide hard ceiling for any configured response bound (§15). Every bound must be at most this. */
export const BODY_BOUND_CEILING = 64 * 1024 * 1024;

/**
 * The fixed staging block. Input is coalesced into blocks of this size before it is decoded, so each retained text part (except the last) covers at least
 * this much input. Independent of the byte bound (docs/BOUNDED_STREAMING_TRANSPORT_V2.md §5).
 */
export const BODY_COALESCE_BYTES = 64 * 1024;

/**
 * The most data chunks one body may deliver, zero-length chunks included. The final done read does not count. This is a transport-safety policy, not a
 * provider statement: 65,536 chunks is far above normal delivery (V2 §3).
 */
export const BODY_CHUNK_COUNT_CEILING = 65_536;

/** The most consecutive zero-length chunks before the body is refused as making no progress. A non-empty chunk resets the run (V2 §4). */
export const BODY_EMPTY_CHUNK_STREAK_CEILING = 1_024;

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
 * Decodes a body's bytes, in arrival order, into retained text parts. Bytes are staged in one fixed block. A full block is decoded with stream semantics. A
 * large remainder is decoded directly as a view, with no copy. The decoder carries at most three pending bytes between calls. Exported for the coalescing
 * tests. readBoundedUtf8 is the only body reader, and it uses this class.
 */
export class Utf8Coalescer {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly staging = new Uint8Array(BODY_COALESCE_BYTES);
  private readonly parts: string[] = [];
  private staged = 0;

  /** The number of text parts retained so far. Read-only, for the coalescing tests. */
  get partCount(): number {
    return this.parts.length;
  }

  /** Feeds bytes in arrival order. Zero-length input is a no-op, so it never reaches the decoder and adds no part. */
  feed(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.staged === 0 && bytes.byteLength - offset >= BODY_COALESCE_BYTES) {
        this.decodeBlock(bytes.subarray(offset));
        return;
      }
      const take = Math.min(BODY_COALESCE_BYTES - this.staged, bytes.byteLength - offset);
      this.staging.set(bytes.subarray(offset, offset + take), this.staged);
      this.staged += take;
      offset += take;
      if (this.staged === BODY_COALESCE_BYTES) this.flushStaging();
    }
  }

  /** Decodes what is still staged and flushes the decoder. Returns the complete text, assembled once. */
  finish(): string {
    if (this.staged > 0) this.flushStaging();
    const tail = this.decode(undefined);
    if (tail !== '') this.parts.push(tail);
    return this.parts.join('');
  }

  private flushStaging(): void {
    this.decodeBlock(this.staging.subarray(0, this.staged));
    this.staged = 0;
  }

  private decodeBlock(bytes: Uint8Array): void {
    this.parts.push(this.decode(bytes));
  }

  /** One decoder call. Malformed bytes throw from the fatal decoder and become BODY_INVALID_UTF8; the text is never replaced. */
  private decode(bytes: Uint8Array | undefined): string {
    try {
      return bytes === undefined ? this.decoder.decode() : this.decoder.decode(bytes, { stream: true });
    } catch {
      throw new BodyTransportError('BODY_INVALID_UTF8', 'the body is not valid UTF-8');
    }
  }
}

/**
 * Reads a response body as UTF-8 text, under a byte bound. Exactly maxBytes is accepted, and maxBytes + 1 is refused. The byte count is the authority:
 * Content-Length can only refuse early. Each data chunk is checked in this order: it must be bytes; it counts toward the chunk ceiling; a zero-length chunk
 * extends the empty streak; a non-empty chunk resets it; and only then is the byte bound applied, before the chunk is copied or decoded. A missing body,
 * malformed bytes, a framing violation, a fragmentation refusal or a stream failure throws a BodyTransportError, after the reader is cancelled. An abort is
 * rethrown unchanged, so the caller's timeout classification still applies.
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
  const coalescer = new Utf8Coalescer();
  let total = 0;
  let chunks = 0;
  let emptyStreak = 0;
  let released = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array)) throw new BodyTransportError('BODY_STREAM_INVALID', 'the body stream produced a value that is not bytes');
      chunks++;
      if (chunks > BODY_CHUNK_COUNT_CEILING) throw new BodyTransportError('BODY_STREAM_INVALID', 'the body has more chunks than the transport allows');
      if (chunk.byteLength === 0) {
        emptyStreak++;
        if (emptyStreak > BODY_EMPTY_CHUNK_STREAK_CEILING) throw new BodyTransportError('BODY_STREAM_INVALID', 'the body has too many consecutive empty chunks');
        continue;
      }
      emptyStreak = 0;
      if (total + chunk.byteLength > maxBytes) throw new BodyTransportError('BODY_TOO_LARGE', 'the body is larger than the bound');
      total += chunk.byteLength;
      coalescer.feed(chunk);
    }
    return coalescer.finish();
  } catch (error) {
    // Overflow, fragmentation, malformed bytes and stream failures all cancel the stream, and none of them returns partial content.
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
}
