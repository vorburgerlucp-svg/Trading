// The shared SEC HTTP transport for one text document (docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §12, §25; docs/SEC_EDGAR_FUNDAMENTALS_V1.md §4–§5).
// The connector and the attestor both read SEC documents through this one function, so the host, status, size and redirect rules cannot drift apart.
// The caller names the hosts it allows and the error type a refusal becomes. Nothing here follows a redirect, sends a credential, or reads a body that is
// over its bound.

import type { FetchLike, HttpResponseLike } from '../market-data/providers/resilience.js';
import { restFailureOf } from './rest-transport.js';

export interface SecTextRequest {
  readonly fetch: FetchLike;
  readonly clock: () => Date;
  readonly provider: string;
  readonly accept: string;
  /** The declared contact. It is the only identity sent to SEC. */
  readonly userAgent: string;
  readonly url: string;
  readonly signal: AbortSignal;
  /** The hosts this request may be answered from. Any other host is refused. */
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  /** Turns a refusal into the caller's error. It never returns. */
  readonly refuse: (kind: 'host' | 'size', message: string) => never;
}

/** True when a final URL is HTTPS and on one of the allowed hosts. A URL that does not parse is not allowed. */
export function fromAllowedHost(url: string, allowedHosts: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && allowedHosts.includes(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Returns the exact text of one SEC response. The final URL is checked against the allowed hosts before the status is read. Provider status errors keep
 * their meaning (restFailureOf), and no body is included in an error. Content-Length is checked before the body is read, and the body is checked again after it.
 */
export async function secTextOf(request: SecTextRequest): Promise<string> {
  const response: HttpResponseLike = await request.fetch(request.url, {
    method: 'GET',
    headers: { Accept: request.accept, 'User-Agent': request.userAgent },
    signal: request.signal,
  });
  if (response.url !== undefined && response.url !== '' && !fromAllowedHost(response.url, request.allowedHosts)) {
    request.refuse('host', 'the response came from a host that is not allowed; it is refused and nothing is followed');
  }
  const failure = restFailureOf(response, request.provider, request.clock().getTime(), 'access_denied');
  if (failure) throw failure;
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > request.maxBytes)) {
    request.refuse('size', 'the response is larger than its bound, or its Content-Length is malformed');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > request.maxBytes) request.refuse('size', 'the body is larger than its bound');
  return text;
}
