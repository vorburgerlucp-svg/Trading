// Shared fixtures for streaming HTTP bodies (docs/BOUNDED_STREAMING_HTTP_TRANSPORT_V1.md §20). They emit real Uint8Array chunks through the same reader contract
// the native Response uses. Each body counts its reads, cancels and lock releases, so tests can prove how much was consumed. A response built here has no
// text() member (docs/TWELVE_DATA_STREAMING_HARDENING_V1.md §10): its body can only be read through the stream.

import type { HttpBodyLike, HttpBodyReaderLike, HttpResponseLike } from '../../src/market-data/providers/resilience.js';

export interface BodyProbe {
  getReaders: number;
  reads: number;
  cancels: number;
  releases: number;
}

export function newProbe(): BodyProbe {
  return { getReaders: 0, reads: 0, cancels: 0, releases: 0 };
}

const encoder = new TextEncoder();

/** A body that yields the given chunks in order, then ends. A string is one UTF-8 chunk. */
export function bodyOf(source: string | readonly Uint8Array[], probe: BodyProbe = newProbe()): HttpBodyLike {
  const chunks = typeof source === 'string' ? [encoder.encode(source)] : [...source];
  let next = 0;
  return {
    getReader(): HttpBodyReaderLike {
      probe.getReaders++;
      return {
        read: async () => {
          probe.reads++;
          if (next >= chunks.length) return { done: true };
          return { done: false, value: chunks[next++] };
        },
        cancel: async () => {
          probe.cancels++;
        },
        releaseLock: () => {
          probe.releases++;
        },
      };
    },
  };
}

/** Splits a byte array at the given offsets. Offsets must be strictly increasing and inside the array. */
export function splitBytes(bytes: Uint8Array, offsets: readonly number[]): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let start = 0;
  for (const offset of offsets) {
    parts.push(bytes.slice(start, offset));
    start = offset;
  }
  parts.push(bytes.slice(start));
  return parts;
}

/** A text split into chunks of the given byte size. The last chunk may be shorter. */
export function chunksOf(text: string, size: number): Uint8Array[] {
  const bytes = encoder.encode(text);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) parts.push(bytes.slice(i, i + size));
  return parts.length === 0 ? [new Uint8Array(0)] : parts;
}

/** A body whose reads never complete. Only an external timeout can end it. */
export function neverEndingBody(probe: BodyProbe = newProbe()): HttpBodyLike {
  return {
    getReader(): HttpBodyReaderLike {
      probe.getReaders++;
      return {
        read: () => {
          probe.reads++;
          return new Promise(() => undefined);
        },
        cancel: async () => {
          probe.cancels++;
        },
        releaseLock: () => {
          probe.releases++;
        },
      };
    },
  };
}

/** A body that yields some chunks, then fails the next read with the given error. */
export function failingBody(error: unknown, before: readonly Uint8Array[] = [], probe: BodyProbe = newProbe()): HttpBodyLike {
  let next = 0;
  return {
    getReader(): HttpBodyReaderLike {
      probe.getReaders++;
      return {
        read: async () => {
          probe.reads++;
          if (next < before.length) return { done: false, value: before[next++] };
          throw error;
        },
        cancel: async () => {
          probe.cancels++;
        },
        releaseLock: () => {
          probe.releases++;
        },
      };
    },
  };
}

export interface ResponseOptions {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: HttpBodyLike | null | undefined;
  readonly url?: string;
}

/** A response with a streaming body and no text() member: its body can only be read through the stream. */
export function responseWith(options: ResponseOptions): HttpResponseLike {
  const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: options.status ?? 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: options.body,
    url: options.url,
  };
}

/** A success response carrying the given text as a streaming body. */
export function textResponse(text: string, headers: Record<string, string> = {}, probe?: BodyProbe): HttpResponseLike {
  return responseWith({ status: 200, headers, body: bodyOf(text, probe) });
}
