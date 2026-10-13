import { describe, expect, it } from 'vitest';
import {
  BODY_CHUNK_COUNT_CEILING,
  BODY_COALESCE_BYTES,
  BODY_EMPTY_CHUNK_STREAK_CEILING,
  BodyTransportError,
  Utf8Coalescer,
  readBoundedUtf8,
} from '../../../src/market-data/providers/bounded-http-body.js';
import type { HttpBodyLike, HttpBodyReaderLike, HttpResponseLike } from '../../../src/market-data/providers/resilience.js';
import { bodyOf, failingBody, newProbe, responseWith, splitBytes, type BodyProbe } from '../../financial/http-body-fixtures.js';

// docs/BOUNDED_STREAMING_TRANSPORT_V2.md. Coalescing, the chunk and empty-chunk policies, and identity across chunking. Every endless stream here is capped
// by a read counter: a missing guard fails the assertion instead of hanging the run, so this suite can never block on its own.

const enc = new TextEncoder();
// The behavioural tests use local copies of the policy values, so each one is meaningful even before the constants exist. The constants test below pins the
// production values, and a change to either side fails it.
const B = 64 * 1024;
const CHUNK_CEILING = 65_536;
const STREAK_CEILING = 1_024;

function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => (error as { code?: string }).code ?? 'UNEXPECTED',
  );
}

/** One data chunk per byte: the finest fragmentation a provider can choose. */
function oneByteChunks(bytes: Uint8Array): Uint8Array[] {
  return Array.from(bytes, (byte) => Uint8Array.of(byte));
}

/** A body that yields chunks from produce() without end, and stops after cap reads so a missing guard cannot hang the run. */
function endless(produce: () => Uint8Array, cap: number, probe: BodyProbe = newProbe(), cancelFails = false): HttpResponseLike {
  let reads = 0;
  const body: HttpBodyLike = {
    getReader(): HttpBodyReaderLike {
      probe.getReaders++;
      return {
        read: async () => {
          probe.reads++;
          if (reads++ >= cap) return { done: true };
          return { done: false, value: produce() };
        },
        cancel: async () => {
          probe.cancels++;
          if (cancelFails) throw new Error('cancel failed');
        },
        releaseLock: () => {
          probe.releases++;
        },
      };
    },
  };
  return responseWith({ body });
}

/** The text split at the given byte offsets, read as a body. */
function readSplit(text: string, offsets: readonly number[]): Promise<string> {
  const bytes = enc.encode(text);
  return readBoundedUtf8(responseWith({ body: bodyOf(splitBytes(bytes, offsets)) }), bytes.byteLength + 16);
}

describe('the policy constants (brief sections 3, 4, 5)', () => {
  it('the production constants are 64 KiB, 65,536 chunks and 1,024 empty chunks, and match the values the tests use', () => {
    expect(BODY_COALESCE_BYTES).toBe(B);
    expect(BODY_COALESCE_BYTES).toBe(64 * 1024);
    expect(BODY_CHUNK_COUNT_CEILING).toBe(CHUNK_CEILING);
    expect(BODY_CHUNK_COUNT_CEILING).toBe(65_536);
    expect(BODY_EMPTY_CHUNK_STREAK_CEILING).toBe(STREAK_CEILING);
    expect(BODY_EMPTY_CHUNK_STREAK_CEILING).toBe(1_024);
  });
});

describe('coalescing keeps the retained parts bounded (section 5)', () => {
  it('100,000 one-byte chunks do not retain 100,000 parts, and the text is exact', () => {
    const coalescer = new Utf8Coalescer();
    const expected: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      const letter = String.fromCharCode(0x61 + (i % 26));
      expected.push(letter);
      coalescer.feed(Uint8Array.of(letter.charCodeAt(0)));
    }
    expect(coalescer.partCount).toBeLessThanOrEqual(Math.ceil(100_000 / B) + 1);
    expect(coalescer.finish()).toBe(expected.join(''));
  });

  it('a 1 MiB body fed one byte at a time gives the exact text, with about one part per 64 KiB', () => {
    const size = 1_048_576;
    const pattern = 'abcdefghijklmnopqrstuvwxyz';
    const text = pattern.repeat(Math.ceil(size / pattern.length)).slice(0, size);
    const coalescer = new Utf8Coalescer();
    for (const byte of enc.encode(text)) coalescer.feed(Uint8Array.of(byte));
    expect(coalescer.partCount).toBeLessThanOrEqual(Math.floor(size / B) + 1);
    expect(coalescer.finish()).toBe(text);
  });

  it('empty input never reaches the decoder and adds no part', () => {
    const coalescer = new Utf8Coalescer();
    for (let i = 0; i < 5_000; i++) coalescer.feed(new Uint8Array(0));
    expect(coalescer.partCount).toBe(0);
    expect(coalescer.finish()).toBe('');
  });

  it('a multibyte character fed one byte at a time decodes exactly', () => {
    const coalescer = new Utf8Coalescer();
    for (const byte of enc.encode('é€😀')) coalescer.feed(Uint8Array.of(byte));
    expect(coalescer.finish()).toBe('é€😀');
  });
});

describe('UTF-8 across the coalescing boundaries is identical (brief section 9)', () => {
  const text = 'a'.repeat(B - 1) + '€' + 'a'.repeat(B) + '😀' + 'z';

  it.each([B - 3, B - 2, B - 1, B, B + 1, B + 2, 2 * B - 1, 2 * B, 2 * B + 1])('a split at byte %i, inside or beside a multibyte character, decodes to the same text', async (offset) => {
    expect(await readSplit(text, [offset])).toBe(text);
  });

  it('many splits at every block edge and inside every sequence decode to the same text', async () => {
    const offsets = [1, 2, 3, B - 3, B - 2, B - 1, B, B + 1, B + 2, 2 * B - 1, 2 * B, 2 * B + 1, 2 * B + 2];
    expect(await readSplit(text, offsets)).toBe(text);
  });

  it('a multibyte character at the very end of a partial final block decodes exactly', async () => {
    const tail = 'a'.repeat(B + 5) + '€';
    expect(await readSplit(tail, [B + 6, B + 7])).toBe(tail);
  });

  it('a sequence left incomplete at the end of the stream is BODY_INVALID_UTF8', async () => {
    const bytes = new Uint8Array(B + 2);
    bytes.fill(0x61);
    bytes[B + 1] = 0xe2; // the first byte of a three-byte sequence, and then the stream ends
    expect(await codeOf(readBoundedUtf8(responseWith({ body: bodyOf([bytes]) }), B * 2))).toBe('BODY_INVALID_UTF8');
  });

  it('malformed bytes that cross a staging boundary are refused, never replaced', async () => {
    const bytes = new Uint8Array(B + 1);
    bytes.fill(0x61);
    bytes[B - 1] = 0xe2; // starts a three-byte sequence at the last byte of the first block
    bytes[B] = 0x41; // is not a continuation byte
    expect(await codeOf(readBoundedUtf8(responseWith({ body: bodyOf([bytes]) }), B * 2))).toBe('BODY_INVALID_UTF8');
  });

  it('a byte order mark split across chunks is removed, as the platform text() removes it', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x42]);
    expect(await readBoundedUtf8(responseWith({ body: bodyOf(splitBytes(bytes, [1, 2])) }), 16)).toBe('AB');
  });
});

describe('the input chunk ceiling (brief sections 3, 6, 25)', () => {
  it('exactly 65,536 data chunks are accepted, and the final done read is not counted', async () => {
    const parts = oneByteChunks(new Uint8Array(CHUNK_CEILING).fill(0x78));
    expect(await readBoundedUtf8(responseWith({ body: bodyOf(parts) }), CHUNK_CEILING)).toHaveLength(CHUNK_CEILING);
  });

  it('65,537 data chunks are refused as BODY_TOO_FRAGMENTED, with the reader cancelled and released', async () => {
    const probe = newProbe();
    const parts = oneByteChunks(new Uint8Array(CHUNK_CEILING + 1).fill(0x78));
    const error = await readBoundedUtf8(responseWith({ body: bodyOf(parts, probe) }), CHUNK_CEILING + 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BodyTransportError);
    expect(error).toMatchObject({ code: 'BODY_TOO_FRAGMENTED' });
    expect(probe.reads).toBe(CHUNK_CEILING + 1);
    expect(probe.cancels).toBe(1);
    expect(probe.releases).toBe(1);
  });

  it('100,000 one-byte chunks are refused by the production policy, not retained', async () => {
    const parts = oneByteChunks(new Uint8Array(100_000).fill(0x78));
    expect(await codeOf(readBoundedUtf8(responseWith({ body: bodyOf(parts) }), 100_000))).toBe('BODY_TOO_FRAGMENTED');
  });

  it('a cancel that throws does not replace the chunk-ceiling refusal', async () => {
    const body = endless(() => Uint8Array.of(0x78), CHUNK_CEILING + 5, newProbe(), true);
    expect(await codeOf(readBoundedUtf8(body, CHUNK_CEILING + 5))).toBe('BODY_TOO_FRAGMENTED');
  });
});

describe('the zero-length chunk streak (brief sections 4, 7, 24)', () => {
  const data = (text: string) => enc.encode(text);

  it('1,024 consecutive empty chunks followed by valid data are accepted', async () => {
    const parts = [...Array.from({ length: STREAK_CEILING }, () => new Uint8Array(0)), data('ok')];
    expect(await readBoundedUtf8(responseWith({ body: bodyOf(parts) }), 16)).toBe('ok');
  });

  it('1,025 consecutive empty chunks are refused as BODY_NO_PROGRESS, after exactly 1,025 reads', async () => {
    const probe = newProbe();
    const parts = [...Array.from({ length: STREAK_CEILING + 1 }, () => new Uint8Array(0)), data('ok')];
    expect(await codeOf(readBoundedUtf8(responseWith({ body: bodyOf(parts, probe) }), 16))).toBe('BODY_NO_PROGRESS');
    expect(probe.reads).toBe(STREAK_CEILING + 1);
  });

  it('a non-empty chunk resets the streak: 1,000 empty, data, 1,000 empty, data is accepted', async () => {
    const empties = () => Array.from({ length: 1_000 }, () => new Uint8Array(0));
    const parts = [...empties(), data('a'), ...empties(), data('b')];
    expect(await readBoundedUtf8(responseWith({ body: bodyOf(parts) }), 16)).toBe('ab');
  });

  it('an endless stream of empty chunks is refused at the 1,025th read by the guard, not by a timer', async () => {
    const probe = newProbe();
    expect(await codeOf(readBoundedUtf8(endless(() => new Uint8Array(0), 100_000, probe), 16))).toBe('BODY_NO_PROGRESS');
    expect(probe.reads).toBe(STREAK_CEILING + 1);
    expect(probe.cancels).toBe(1);
    expect(probe.releases).toBe(1);
  });

  it('a cancel that throws does not replace the empty-streak refusal', async () => {
    expect(await codeOf(readBoundedUtf8(endless(() => new Uint8Array(0), 100_000, newProbe(), true), 16))).toBe('BODY_NO_PROGRESS');
  });

  it('a body of only empty chunks is the empty string, which is distinct from a missing body', async () => {
    expect(await readBoundedUtf8(responseWith({ body: bodyOf([new Uint8Array(0)]) }), 16)).toBe('');
    expect(await readBoundedUtf8(responseWith({ body: bodyOf([]) }), 16)).toBe('');
  });
});

describe('an endless one-byte stream is refused, not read forever (brief section 29)', () => {
  it('a stream of one-byte chunks with no end is refused at the 65,537th read', async () => {
    const probe = newProbe();
    expect(await codeOf(readBoundedUtf8(endless(() => Uint8Array.of(0x78), 200_000, probe), 1 << 20))).toBe('BODY_TOO_FRAGMENTED');
    expect(probe.reads).toBe(CHUNK_CEILING + 1);
    expect(probe.cancels).toBe(1);
  });
});

describe('the byte bound remains authoritative (brief sections 2, 8, 12)', () => {
  it('an oversize chunk is refused before it is decoded: malformed bytes in it still give BODY_TOO_LARGE', async () => {
    const probe = newProbe();
    // The overflow chunk fills a whole staging block, so a decode before the refusal would surface as BODY_INVALID_UTF8 instead of BODY_TOO_LARGE.
    const parts = [Uint8Array.of(0x61, 0x61, 0x61), new Uint8Array(B + 8).fill(0xff)];
    expect(await codeOf(readBoundedUtf8(responseWith({ body: bodyOf(parts, probe) }), 10))).toBe('BODY_TOO_LARGE');
    expect(probe.reads).toBe(2);
    expect(probe.cancels).toBe(1);
  });

  it('exactly the bound is accepted across fragments, and one byte more is refused', async () => {
    const text = 'a'.repeat(B + 1);
    expect(await readSplit(text, [B])).toBe(text);
    expect(await codeOf(readBoundedUtf8(responseWith({ body: bodyOf(splitBytes(enc.encode(text), [B])) }), B))).toBe('BODY_TOO_LARGE');
  });
});

describe('cancellation, abort and stream failure (brief sections 11, 13, 14, 15)', () => {
  it('an abort after data is rethrown unchanged, and the reader is cancelled', async () => {
    const probe = newProbe();
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const error = await readBoundedUtf8(responseWith({ body: failingBody(abort, [enc.encode('partial')], probe) }), 64).catch((e: unknown) => e);
    expect(error).toBe(abort);
    expect(probe.cancels).toBe(1);
  });

  it('a non-abort read failure after data keeps the original error as cause', async () => {
    const original = new TypeError('fetch failed');
    const error = await readBoundedUtf8(responseWith({ body: failingBody(original, [enc.encode('partial')]) }), 64).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'BODY_STREAM_INVALID' });
    expect((error as Error).cause).toBe(original);
  });
});

describe('native Response and chunking identity (brief sections 22, 30)', () => {
  it('a native Response of 200 KiB with a byte order mark and mixed multibyte text equals its own text()', async () => {
    const unit = enc.encode('€ü😀a');
    const bytes = new Uint8Array(3 + 200 * 1024 + unit.byteLength);
    bytes.set([0xef, 0xbb, 0xbf], 0);
    for (let at = 3; at + unit.byteLength <= bytes.byteLength; at += unit.byteLength) bytes.set(unit, at);
    const native = await new Response(bytes).text();
    expect(await readBoundedUtf8(new Response(bytes), 1 << 20)).toBe(native);
  });

  it('one chunk, 16 KiB chunks, irregular chunks and one-byte chunks give the same text', async () => {
    const text = 'Grüße € 😀 — ok\n'.repeat(2_000);
    const bytes = enc.encode(text);
    expect(bytes.byteLength).toBeLessThan(CHUNK_CEILING);
    const sizes = [1, 7, 64, 4_096, 3, 65_535, 2, 16_384];
    const irregular: Uint8Array[] = [];
    for (let at = 0, i = 0; at < bytes.byteLength; i++) {
      const size = sizes[i % sizes.length]!;
      irregular.push(bytes.slice(at, at + size));
      at += size;
    }
    const sixteenK = Array.from({ length: Math.ceil(bytes.byteLength / 16_384) }, (_, i) => bytes.slice(i * 16_384, (i + 1) * 16_384));
    for (const parts of [[bytes], sixteenK, irregular, oneByteChunks(bytes)]) {
      expect(await readBoundedUtf8(responseWith({ body: bodyOf(parts) }), bytes.byteLength)).toBe(text);
    }
  });
});
