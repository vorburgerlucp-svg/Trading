# Twelve Data Streaming Hardening V1

Status: design, written before the tests and the code. Base: `77f9629`, the closed Bounded Streaming HTTP Transport V1.
Scope: transport only. Twelve Data market-data semantics, persistence, knowledge and hashing do not change.

## 1. The old whole-body problem

`TwelveDataMarketDataProvider.request()` (`src/market-data/providers/twelve-data.ts`) did this:

1. `const text = await res.text()` materialised the complete response body in memory, whatever its size.
2. Only then `if (text.length > 30_000_000)` refused it.
3. `defaultFetch()` exposed `text: () => res.text()`, so the whole-body path was the only path.

Two consequences. The size limit protected nothing, because the memory was already spent. And `text.length` counts UTF-16 code units, not bytes, so the limit did not measure what memory actually holds.

## 2. The new byte bound

- `TWELVE_DATA_MAX_RESPONSE_BYTES = 30_000_000` bytes. It deliberately derives from the old `text.length > 30_000_000` guard, but the unit is now bytes. Bytes are the correct unit for memory protection.
- The bound is stricter than the old guard for multibyte text: a body with fewer than 30 million characters but more than 30 million bytes is now refused. For ASCII bodies the two limits are identical. Twelve Data's numeric and symbol payloads are ASCII in practice.
- 30,000,000 bytes is below `BODY_BOUND_CEILING` (64 MiB, `bounded-http-body.ts`). The value is not increased.
- The option `maxResponseBytes?: number` is optional, defaults to `TWELVE_DATA_MAX_RESPONSE_BYTES`, and is validated by `assertBodyBound()` in the constructor. Invalid values (0, negative, fraction, NaN, Infinity, above the ceiling) throw `MarketDataError('not_configured')` before any request is made. There is no unbounded default.

## 3. Reuse of the existing primitive

Every Twelve Data body is read through `readBoundedUtf8()` from `src/market-data/providers/bounded-http-body.ts`. No new reader, UTF-8 decoder, Content-Length logic, overflow cancellation or bound validation is written here. The only change to the primitive is that a stream read failure carries the original error as `cause` (section 6), so the provider can keep the old classification of that failure.

`defaultFetch()` returns the native `Response` directly. The native Node 22+ body already satisfies `HttpBodyLike`, so the wrapper that exposed `text()` is removed.

## 4. Why error bodies still need bounded reading

Twelve Data reports many errors inside a JSON body, often with HTTP 200 (`{ "code": 401, "status": "error", ... }`). The provider classifies these from the body, so the body must be read before the status is mapped. Error bodies with 4xx and 5xx statuses can carry the same JSON. This is why there is no generic "status first, never read the error body" rule here, and why every body is bounded: the bound applies before the status is looked at.

## 5. API-key isolation

- The key stays in the private field `#apiKey`. It is sent only in the `Authorization: apikey …` header. It never goes into the URL, a query, a body or an error.
- Provider messages pass through `scrub()` before they become errors.
- The transport reassembles the complete body text before anything is parsed or scrubbed. A key split across chunks therefore still matches, and is replaced with `[REDACTED]`.
- Transport failure messages are fixed strings. They never include body text, chunk contents or the key.

## 6. Error mapping

`readBoundedUtf8()` errors are mapped in `bodyOf()`. The rules are chosen so that the existing HTTP status semantics survive.

| Condition | Success status (200) | Other statuses |
|---|---|---|
| Body larger than the bound, or declared larger (`BODY_TOO_LARGE`) | `schema_invalid`, non-retryable | `schema_invalid`, non-retryable (section 4 and brief rule 13) |
| No readable body (`BODY_STREAM_UNAVAILABLE`) | `schema_invalid`, non-retryable; `text()` is never called | no body: the status decides (`provider_unavailable`, `rate_limited`, …) |
| Malformed UTF-8 (`BODY_INVALID_UTF8`) | `schema_invalid`, non-retryable | no body: the status decides |
| Framing violation: malformed or out-of-range Content-Length, a chunk that is not bytes (`BODY_STREAM_INVALID` without cause) | `schema_invalid`, non-retryable | no body: the status decides |
| Stream read failure (`BODY_STREAM_INVALID` with `cause`) | the original error is rethrown, so it is classified exactly as before (a network termination stays `provider_unavailable`, retryable) | same |
| Abort or timeout (`AbortError`, `TimeoutError`) | rethrown unchanged; `ResilientCaller` classifies it as `timeout` | same |

Deliberate decisions (flagged for review):

- **D1. An empty error response keeps its status classification.** Native `fetch` gives `body === null` for an empty body. Under a literal "missing body is `schema_invalid`" rule, an empty 503 would stop being retried, which contradicts brief rule 19 (5xx stays `provider_unavailable`). So a missing body on a non-200 status is treated as "no body", and the status decides. On 200 it fails closed.
- **D2. An unusable error body keeps its status classification.** Malformed UTF-8 or a framing violation in a non-200 body is treated as "no body". The status decides, so a 503 stays retryable. Only overflow (rule 13) makes an error response `schema_invalid`, because the brief requires that explicitly. Success bodies follow rule 9 and rule 15 without exception.
- **D3. A read failure from the transport is not reclassified.** Reclassifying every stream error as `schema_invalid` would turn a mid-body network termination into a non-retryable error, which breaks rule 19. Rethrowing the original error keeps the classification it had before this change.

## 7. JSON parsing semantics

The sequence is unchanged in meaning:

1. bounded-read the body as UTF-8 text;
2. `JSON.parse` it, with a parse failure leaving the body undefined;
3. `errorBody(body)`;
4. if the status is not 200 or an error body is present, map it to a `MarketDataError` (status mapping unchanged);
5. a 200 with an unparseable body is `schema_invalid`;
6. otherwise return the parsed body.

The decoder strips a leading byte-order mark, as the platform `text()` does. The schema parsers (`twelve-data-schema.ts`) are not changed.

## 8. Retry and timeout semantics

`ResilientCaller.call()` wraps the whole attempt, including body streaming, in a timeout race. A body that never completes therefore ends as `timeout` and follows the existing retry policy: retryable, bounded attempts, circuit breaker unchanged. A body that fails with an abort is rethrown and classified as `timeout`. Malformed bodies, framing violations and oversize bodies are non-retryable. Retry-After, the rate-limit fallback, pacing and the circuit breaker are not changed.

## 9. Exclusions

- No change to base URL, query parameters, minimal demo requests, venue or MIC parameters, adjustment, timezone, pagination windows, `outputsize`, the symbol-search, quote, splits or dividends endpoints.
- No change to `retrievedAt`, `observedAt`, `availableAt`, `isFinal`, `BarRevisionKnowledge`, `knowledgeSource`, vintage, vintage policy, capture or settlement windows, or to persistence hashing.
- No Twelve-Data-specific Content-Length logic. The shared reader owns it.
- No chunk coalescing and no streaming JSON parser. Both belong to a later Transport V2.
- No migration. Migrations 001–013 stay byte-identical. There is no 014.
- Live Trading, Broker Orders and Physical Purchase stay LOCKED. O1 stays false. No real AI provider is used.

## 10. Shared response type

After this branch no production code calls `text()` on an external HTTP response. `HttpResponseLike.text()` is therefore removed, so an accidental whole-body fallback becomes a compile-time error. A `@ts-expect-error` test in the suite proves that the shape rejects a `text` member.

## 11. Proof obligations

- The RED tests fail on the current code for the reasons above, and are committed before the production change.
- Output identity: for identical JSON, one chunk and fragmented chunks give deep-equal normalised output for bars, quote, symbol search, splits and dividends.
- Persistence: a backfill through the service stores records whose content hashes and read-back output are identical for one chunk and fragmented chunks.
- The mutation campaign (15 mutations, brief section 34) runs against the implementation. Each source file is restored byte-for-byte from a backup, and the tree is clean afterwards.

## 12. Remaining limitations

- The bound limits bytes, not decoded string overhead. This was the MEDIUM recorded for Transport V2. Transport V2 (`docs/BOUNDED_STREAMING_TRANSPORT_V2.md`) resolves it: provider chunks are coalesced into 64 KiB blocks, the chunk count and the empty-chunk run are capped, and the retained parts are bounded by the payload size.
- A 30 MB body still becomes one JavaScript string, and the parser runs on that string. Memory is bounded, but parsing is not streamed.
- The live public-demo smoke depends on Twelve Data's availability and rate limits at test time. A real provider failure is reported as such, not hidden.
