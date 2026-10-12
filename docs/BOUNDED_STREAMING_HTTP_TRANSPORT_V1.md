# Bounded Streaming HTTP Transport V1

Status: design, written before implementation. Base: `fa6e27e` (`feature/historical-financial-source-attestation-v1`). Branch:
`feature/bounded-streaming-http-transport-v1`. Not merged, not pushed.

This branch removes an unbounded memory path from the financial REST success bodies. It changes transport only. It does not change any data model, identity,
policy, mapping or authority.

## 1. Threat model

Before this change, `secTextOf`, the Massive connector and the generic REST connector called `response.text()` on a successful response, and checked the
size afterwards. The platform reads the whole body into memory before NEXUS sees it. A response with no `Content-Length`, a dishonest one, or a compressed
body that expands could therefore allocate far more than the intended bound before the bound is enforced.

Threats this branch addresses:

- A provider or an intermediary sends a body larger than the intended bound, with no `Content-Length` or with a lying one.
- A compressed response expands far beyond its wire size.
- A slow or never-ending body holds memory and a connection.

Threats this branch does **not** address: a provider that is hostile but within the bound, a provider that returns valid but wrong data, and any
denial of service that comes from the number of requests rather than their size. Those are covered by pacing, the circuit breaker and the existing
checks, and they are unchanged.

## 2. Runtime gate

- The package requires Node `>=22`. The development runtime is Node `v24.19.0`.
- The native `Response.body` is a WHATWG `ReadableStream` of `Uint8Array` chunks, and `getReader()`, `read()`, `cancel()` and `releaseLock()` are present.
  This was checked directly in the runtime before this design was written.
- Result: **PASS**. The streaming model is supported natively, so no fake bounded reader wraps `response.text()`.
- The secure path never falls back to `response.text()`. When the body is missing it fails closed (§23).

## 3. Provider-neutral body contract

`HttpResponseLike` gains an optional `body`. Its structural shape is:

    interface HttpBodyReaderLike { read(): Promise<{ done: boolean; value?: unknown }>; cancel(reason?: unknown): Promise<void>; releaseLock(): void }
    interface HttpBodyLike { getReader(): HttpBodyReaderLike }

The native `Response.body` satisfies it structurally, and a test proves this with a real `Response` built from local bytes.

`text()` stays on `HttpResponseLike` only because `src/market-data/providers/twelve-data.ts` still uses it, and Twelve Data is out of scope for V1. Migrated financial
success paths never call `text()`, `json()` or `arrayBuffer()`. Test fixtures make `text()` throw on the financial paths, so any fallback is detected.

## 4. The reader

`src/market-data/providers/bounded-http-body.ts` exports `readBoundedUtf8(response, maxBytes)` and a small error vocabulary. It lives beside the shared HTTP types
in `resilience.ts`, because the types are shared between the market-data providers and the financial transports. Placing it there does not migrate any
market-data provider.

Error codes (internal, mapped at each connector boundary, §22):

- `BODY_TOO_LARGE`: the streamed bytes exceed the bound.
- `BODY_STREAM_UNAVAILABLE`: the response has no readable body stream on a success path.
- `BODY_INVALID_UTF8`: the bytes are not valid UTF-8.
- `BODY_STREAM_INVALID`: a malformed `Content-Length`, a chunk that is not a `Uint8Array`, or a stream read failure that is not an abort.

## 5. Body-size semantics

- The bound counts **bytes**. Each chunk's `byteLength` is added to a running total.
- A body of exactly `maxBytes` bytes is accepted. A body of `maxBytes + 1` bytes is refused. This is the off-by-one policy, and tests pin it.
- The total is checked as each chunk arrives. The chunk that crosses the limit is not decoded, and nothing after it is read.
- The text returned is the concatenation of the accepted chunks, decoded once, so memory is bounded by `maxBytes` plus one chunk and a small overhead. Chunks
  are collected and joined once. The reader never does `text += chunk`, which would copy quadratically.

## 6. Content-Length

`Content-Length` is an early rejection hint only. It is never the final bound.

- If present, it must be a canonical decimal: `0`, or a digit string that does not start with `0`. Anything else, including signs, fractions, spaces and
  values beyond the safe-integer range, is refused as `BODY_STREAM_INVALID`.
- If it is greater than `maxBytes`, the body is refused before any read. No body byte is consumed.
- If it is absent, the stream count alone bounds the body.
- If it is smaller than the actual body, the stream count catches the overflow.
- If it equals `maxBytes` and the decoded body is exactly `maxBytes`, the body is accepted.

## 7. Compression

Node's `fetch` decodes content encodings (for example gzip or br) before the body stream is exposed. The stream yields the decoded bytes. The bytes NEXUS
consumes from that stream are the bytes it counts.

Consequences:

- The count is authoritative even when `Content-Length` describes the compressed wire size and is smaller than the decoded body.
- A compression bomb is stopped at `maxBytes` of decoded output. Its expansion is never fully materialized.
- The bound is not weakened because `Content-Length` is smaller.
- NEXUS adds no custom decompression.

## 8. UTF-8

The financial endpoints are textual UTF-8 responses. The reader decodes incrementally with a `TextDecoder` in fatal mode, using `stream: true` for each chunk and a
final flush.

- Multibyte characters split across chunks decode correctly. The decoder carries the incomplete sequence to the next chunk.
- Malformed UTF-8 fails closed as `BODY_INVALID_UTF8`. It is never replaced with U+FFFD.
- This is a deliberate difference from the platform `response.text()`, which replaces malformed bytes with U+FFFD. The difference matters only for bytes that
  are not valid UTF-8. For valid UTF-8, the result is identical.
- Byte length is not character length. The bound applies to bytes, and tests cover a body whose byte length and string length differ.

**BOM.** A leading UTF-8 byte order mark is removed, as the platform `response.text()` removes it. The reader uses the decoder's default BOM handling
(`ignoreBOM: false`). A test compares the reader's output with native `Response.text()` for a BOM-prefixed body, so the match is proven, not assumed.

## 9. Stream failure

If `read()` rejects, no partial content is returned.

- An abort error (`AbortError`, `TimeoutError`) is rethrown unchanged, so `ResilientCaller` classifies it as a timeout and retries it as before.
- Any other read failure is classified as `BODY_STREAM_INVALID`. It is not retried. Before this change, a read failure of the same kind was also not retried.
- Partial JSON is never parsed, and partial data is never hashed.
- A best-effort cancel and lock release run on failure, and a failure of either never replaces the primary error.

## 10. Timeout interaction

The existing `ResilientCaller` timeout wraps each whole attempt, and the body read happens inside the attempt. The same `AbortSignal` passed to `fetch` aborts
the body stream. No second, independent body timeout is created.

The proof is a test that uses a body that never completes. The existing timeout rejects the call with `timeout`, and it is retried within the attempt budget.

## 11. Cancellation

On overflow the reader calls `cancel()` on the stream before it throws `BODY_TOO_LARGE`. If `cancel()` itself fails, the failure is ignored, and the original
`BODY_TOO_LARGE` error is what the caller sees. The lock is released after cancellation, where the stream allows it.

## 12. Status before body

HTTP status is evaluated before any body is read, as before. For 401, 403, 404, 429, 5xx and every other non-2xx status, the body is not read to construct the
error. Error messages stay body-free. A test returns a 500 whose body reader throws if touched, and proves the status error is returned and the body untouched.

## 13. Error mapping

| Condition | Internal code | SEC JSON | SEC archive | Massive | Generic REST |
|---|---|---|---|---|---|
| Overflow, or `Content-Length` over the bound | `BODY_TOO_LARGE` | `SCHEMA_INVALID` | `SOURCE_ARTIFACT_MISMATCH` | `SCHEMA_INVALID` | `SCHEMA_INVALID` |
| No readable body on a success | `BODY_STREAM_UNAVAILABLE` | `SCHEMA_INVALID` | `SOURCE_ARTIFACT_MISMATCH` | `SCHEMA_INVALID` | `SCHEMA_INVALID` |
| Invalid UTF-8 | `BODY_INVALID_UTF8` | `SCHEMA_INVALID` | `SOURCE_ARTIFACT_MISMATCH` | `SCHEMA_INVALID` | `SCHEMA_INVALID` |
| Malformed `Content-Length`, bad chunk, non-abort read failure | `BODY_STREAM_INVALID` | `SCHEMA_INVALID` | `SOURCE_ARTIFACT_MISMATCH` | `SCHEMA_INVALID` | `SCHEMA_INVALID` |
| Abort or timeout during read | (rethrown) | timeout | timeout | timeout | timeout |

Provider status errors (`restFailureOf`) are unchanged. SEC host and redirect refusals are unchanged.

## 14. Connector bounds

| Consumer | Bound | Value |
|---|---|---|
| SEC submissions and CompanyFacts | `SEC_MAX_RESPONSE_BYTES` | 32 MiB, unchanged |
| SEC archive header | `SEC_ARCHIVE_MAX_BYTES` | 2 MiB, unchanged |
| Massive news | `MASSIVE_MAX_RESPONSE_BYTES` | 4 MiB, new |
| Generic REST | `maxResponseBytes` (required option) | caller-supplied |

The Massive documentation (`docs/MASSIVE_NEWS_CONNECTOR_V1.md`) states no response size. The 4 MiB bound is therefore a deliberate V1 choice, not a value taken from
the provider. Nothing in the repository conflicts with it: the largest Massive fixture is about 4 KB of source, and the field limits in the article schema
bound each article's text. One field, `insights`, is an array with no documented length. A live response above 4 MiB fails closed as `SCHEMA_INVALID`, and
the bound would then need a new decision. It is not raised silently.

The generic REST connector has no default bound. An unset or invalid bound fails at construction, so a future connector cannot opt into an unbounded body by
accident.

Repository-wide hard ceiling: `BODY_BOUND_CEILING = 64 MiB`. Any configured bound above the ceiling is refused at construction. The SEC 32 MiB bound is below it.

## 15. Bound validation

A configured bound must be an integer, greater than zero, a safe integer, and at most `BODY_BOUND_CEILING`. `0`, negative values, `NaN`, `Infinity`, fractions
and non-numbers are refused at construction, before any request is made.

## 16. Identity and hash preservation

For identical valid response bytes, the migrated transport returns the same text, after the same BOM removal. Everything downstream is therefore unchanged:

- submissions and CompanyFacts parsing, and the selected fundamentals;
- `rawPayloadHash` (SEC: the SHA-256 of the exact text; Massive and generic REST: the hash of the parsed JSON);
- `contentHash` and `evidenceId` of `FinancialEvidence`;
- the source-attestation artifact hash (the SHA-256 of the exact archive text), `selectedFactsHash` and `attestationId`.

Regression tests pin the baseline values captured from the pre-migration code, and they compare chunked and whole deliveries of the same bytes. Chunk boundaries
do not change any returned text or hash.

## 17. SEC integration

`secTextOf` reads through the bounded reader. Its refusal callback receives a `body` kind instead of `size`. Every SEC check other than the body read is unchanged:
allowed hosts, HTTPS, redirect refusal, status mapping, `Accept`, `User-Agent` and the absence of `Authorization`.

The stale comment that said the body is read whole before the post-read check is removed. The SEC design documents that described this limitation are updated.

## 18. Massive integration

`MassiveNewsRestConnector` reads its success body through the bounded reader, with a 4 MiB bound checked at construction. The endpoint, the 50-article maximum, the
`next_url` policy, entitlement handling, the `Authorization` rule, the article schema, timestamp parsing, text quarantine and article hashing are unchanged.

## 19. Generic REST integration

`RestFinancialConnector` requires a `maxResponseBytes` option, validated at construction. Its success body is read through the bounded reader. Its status mapping and
its secret handling are unchanged.

## 20. Test helper

`test/financial/http-body-fixtures.ts` builds bounded streaming bodies from strings or byte arrays, with specified chunk boundaries. It can also produce a malformed
byte sequence, a body that never completes, an oversized stream, and a body that counts its reads. Scripted fixtures give each response a body and a `text()` that
throws, so any fallback to `text()` fails the test.

## 21. Native compatibility

A test builds a native `Response` from local bytes and reads it through the reader. This is the Node `>=22` compatibility proof. It makes no network call.

## 22. No double consumption

A body is consumed once. Tests detect an accidental second read: the reader counts its reads, and a native `Response` refuses a second read.

## 23. Missing body on success

A 2xx response whose body is absent or has no reader fails closed as `BODY_STREAM_UNAVAILABLE`. It is never read as an empty body, and `text()` is never called.

## 24. Exclusions

- The Twelve Data migration is out of scope for V1.
- No market-data provider beyond the shared types is migrated.
- No streaming JSON parser is introduced. The payload is still parsed whole after it is bounded, as before.
- No custom gzip or other decompression.
- No change to the 32 MiB, 2 MiB or 4 MiB values, or to the 64 MiB ceiling.
- No change to the database, the migrations, `FinancialEvidence`, `FinancialSourceAttestation`, `financialKnowledgeAt`, `readAvailable`, the replay reader, the
  historical policy, the SEC mappings, fundamental selection, the Massive schema, O1, risk, capital, broker or execution code.

## 25. Static scope inventory

The financial source tree was searched for external success-body uses of `response.text()`, `response.json()` and `response.arrayBuffer()`. The results are
recorded in the final report. Any intentional path that remains unbounded would be reported as a blocker or a documented exclusion, not left silently.
