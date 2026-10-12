# Bounded Streaming Transport V2: chunk coalescing and stream hardening

Status: design, written before the RED tests and the implementation. Base: `07646e8`, Twelve Data Streaming Hardening V1 (closed).
Scope: the internals of `readBoundedUtf8()` in `src/market-data/providers/bounded-http-body.ts`. The public function, its signature, every caller, every
status, identity and error mapping stay as they are. No financial, market-data, persistence or migration change.

## 1. What the V1 reader did with fragmentation

V1 pushed one decoded string per provider chunk (`parts.push(decoder.decode(chunk, { stream: true }))`). It bounded the payload bytes, but not the number of parts,
the number of reads or the number of zero-length chunks. Three consequences follow from the code, not from a measurement:

- **Metadata scales with chunk count.** A body of N provider chunks retained up to N string entries, each with its own object header, however small the payload.
- **Zero-length chunks make no progress and add no byte cost.** V1 read them forever. A provider that returns empty chunks without end keeps the read loop on
  promise continuations alone. Those never yield to the macrotask queue, so no timer can run, and the process cannot time out or recover. This is a hang, which
  is worse than the metadata MEDIUM recorded for V1.
- **Read events are unbounded.** Each read is an `await`. A body of millions of one-byte chunks costs millions of promise steps even though it is under the byte bound.

## 2. Payload byte bound (unchanged, authoritative)

- Actual bytes `<= maxBytes`: accepted.
- Actual bytes `> maxBytes`: `BODY_TOO_LARGE`.
- The check is `total + chunk.byteLength > maxBytes`, made **before** the chunk is copied or decoded. An oversize chunk is never copied, never decoded and never
  read again. The reader is cancelled.
- Content-Length stays an early rejection hint only (section 10).

## 3. Input chunk count

- A "data chunk" is a read whose result has `done === false`. The final `{ done: true }` read is **not** counted (pinned by tests).
- Every data chunk counts, including zero-length chunks. A zero-length chunk is a read event.
- `BODY_CHUNK_COUNT_CEILING = 65_536`. The 65,536th data chunk is accepted; the 65,537th is refused.
- A refusal is `BODY_TOO_FRAGMENTED`, a resource-safety budget (section 12). It carries no `cause`.
  body failure.

The ceiling is a transport-safety policy, not a statement about any provider. Normal native fetch delivers a body in chunks of a few kilobytes to tens of
kilobytes: a 30 MB body in 16 KiB chunks is about 1,900 chunks, so 65,536 leaves more than thirty times the normal count. The ceiling only stops a response from
spending unbounded reads.

## 4. Zero-length chunks

- A zero-length chunk counts as a chunk (section 3), increments the **empty streak** and never enters the decoder, the staging buffer or the output.
- `BODY_EMPTY_CHUNK_STREAK_CEILING = 1024`. The 1024th consecutive zero-length chunk is accepted; the 1025th is refused as `BODY_NO_PROGRESS`, a resource-safety budget (section 12).
- Any non-empty chunk resets the streak to zero. So 1024 empty chunks followed by data succeed, and so do 1000 empty, data, 1000 empty, data.
- An endless empty stream is therefore refused after 1025 reads, by the explicit guard, without a timer, an external timeout or any reliance on the event loop.

## 5. Coalescing

- A fixed staging buffer of `BODY_COALESCE_BYTES = 65_536` bytes is allocated once per call. Its size does not depend on `maxBytes` or on the body.
- A non-empty chunk is copied into the staging buffer. When the buffer is full, it is decoded as one block with `stream: true` and the buffer is reused.
- **Fast path.** When the staging buffer is empty and the remaining part of the incoming chunk is at least 64 KiB, that remainder is decoded directly, as a
  view (`subarray`), with no copy. The decoded part is therefore at least 64 KiB of input.
- **Invariant.** Every retained decoded part, except the last one, covers at least 64 KiB of input. A full staging flush covers exactly 64 KiB, and a direct
  decode covers at least 64 KiB. Only the final flush may be shorter. So for a body of `n <= maxBytes` bytes, the number of retained parts is at most
  `floor(n / 65_536) + 1`, which is `ceil(maxBytes / 65_536) + 1` at most. The provider's chunk count does not enter the bound.
- Parts are joined once at the end (`parts.join('')`). The accumulated text is never concatenated per chunk, so no quadratic copying happens.
- Empty output is `""`: a valid readable stream that ends at once. Distinguishing it from a missing body is unchanged (section 12).

## 6. UTF-8 decoder state

- A single `TextDecoder('utf-8', { fatal: true })` for the whole body, fed the blocks in arrival order with `stream: true`.
- Its only state is the pending sequence of at most three bytes. A multibyte character that straddles a provider chunk, a staging boundary or a direct-decode
  boundary is completed by the next decode, as it is in V1.
- The final `decoder.decode()` flushes the state. A sequence left incomplete at the end of the stream is `BODY_INVALID_UTF8`. A tail flush that returns text is
  appended as a part; a tail flush that returns nothing adds no part.
- Malformed bytes throw from the fatal decoder and map to `BODY_INVALID_UTF8`. No replacement character is ever produced.
- The decoder strips a leading byte-order mark once, at the start of the stream, as in V1 (`ignoreBOM: false`). A BOM split across chunks is handled the same way.

## 7. Memory model

What is bounded:

- **Payload text.** A decoded UTF-8 body has at most as many UTF-16 code units as it has bytes (every UTF-8 sequence decodes to one or two units, and four-byte
  sequences produce two). So the decoded text is at most `maxBytes` code units.
- **Staging buffer.** A fixed 64 KiB.
- **Retained parts.** At most `ceil(maxBytes / 65_536) + 1` strings, plus the array that holds them.
- **Decoder state.** At most three pending bytes.
- **Input.** Chunks are copied or decoded and not retained, so at most one provider chunk is referenced at a time, and that chunk belongs to the provider.

What is not bounded, stated exactly:

- **String storage per code unit.** V8 stores Latin-1 text at one byte per unit and other text at two bytes per unit. So the decoded payload occupies at most
  `2 * maxBytes` bytes of string storage in the worst case, and `maxBytes` for ASCII.
- **Transient peak during the final join.** `parts.join('')` builds the complete string while the parts still exist. The peak is therefore about twice the
  decoded text. V1 had the same peak. V2 does not remove it, and does not claim to.
- **Process RSS.** Not bounded by this code. It depends on the runtime, the garbage collector and the other work in the process.

## 8. CPU and fragmentation threat

- The reads are capped at 65,537, the empty streak at 1025, and the total bytes at `maxBytes`. The number of promise steps in one body is therefore finite and
  small, whatever the provider does.
- Per byte the work is a memory copy into the staging buffer, or a single decode of a view. Nothing is decoded per provider chunk.
- The microtask-only path (a provider that resolves every read at once) is bounded by the same counts. The event loop gets back to its timers after at most
  65,537 reads, so the external timeout can fire.

## 9. Cancellation

- Every refusal inside the read loop (`BODY_TOO_LARGE`, the chunk ceiling, the empty streak, `BODY_INVALID_UTF8`, `BODY_STREAM_INVALID`) cancels the reader, and
  the cancel is attempted once. A cancel that throws is swallowed, so it never replaces the primary error.
- The lock is released in every case, in `finally`.
- An abort during a read cancels the reader and is rethrown unchanged (section 11).
- No partial text is ever returned.

## 10. Content-Length (unchanged)

- Canonical decimal only, safe integer only; a malformed value is `BODY_STREAM_INVALID` before any read.
- A declared length above the bound is refused before any read (`BODY_TOO_LARGE`).
- A declared length within the bound does not stop the stream count, so an understated header cannot bypass the bound.
- A missing header is supported.
- Content-Length is never read as a chunk count.

## 11. Timeout and abort

- `reader.read()` is the only await point. Timeouts stay external: `ResilientCaller.withTimeout` races the whole attempt. No second timer is introduced.
- An `AbortError` or `TimeoutError` from a read is rethrown unchanged, so `ResilientCaller` classifies it as `timeout`. It is never converted to
  `BODY_STREAM_INVALID`.
- A non-abort read failure is `BODY_STREAM_INVALID` with the original error as `cause` (V1 behaviour). Twelve Data's network classification depends on that
  cause and is not changed.

## 12. Error mapping (unchanged)

| Caller | Success body refusal | Notes |
|---|---|---|
| SEC document | `refuse('body')`, the current SEC mapping | Unchanged |
| SEC archive header | `SOURCE_ARTIFACT_MISMATCH` | Unchanged |
| Massive News | `SCHEMA_INVALID` | Unchanged |
| Generic REST | `SCHEMA_INVALID` | Unchanged |
| Twelve Data, 200 | `schema_invalid`, non-retryable | Unchanged |
| Twelve Data, any status, safety budget (`BODY_TOO_LARGE`, `BODY_TOO_FRAGMENTED`, `BODY_NO_PROGRESS`) | `schema_invalid`, non-retryable, exactly one request | Never deferred to the status and never retried. A repeat of the request would reproduce the same cost. |
| Twelve Data, other status, ordinary unusable body (missing body, malformed UTF-8, framing) | the status decides | Decision D2, Twelve Data V1, unchanged |
| Twelve Data, 200, ordinary unusable body | `schema_invalid`, non-retryable | Unchanged |

For the other connectors (SEC, SEC archive, Massive, generic REST), every `BodyTransportError` keeps its existing mapping, whatever its code. The new codes
therefore reach the same caller mapping as before, and no connector branches on them.

The safety-budget codes are distinct from `BODY_STREAM_INVALID` so that a caller can tell a resource refusal from a framing or content problem. Callers that
classify failures must treat the three budget codes as non-retryable for every status.

A missing body (`BODY_STREAM_UNAVAILABLE`) is still distinct from an empty body (`""`).

## 13. Identity preservation

For identical valid bytes, the returned text is the same whatever the chunking: one chunk, 16 KiB chunks, one-byte chunks, irregular chunks, chunks crossing UTF-8
sequences, chunks crossing staging boundaries, and zero-length chunks interleaved below the streak limit. Every downstream value follows from the text, so each is
identical too: SEC `rawPayloadHash`, `FinancialEvidence.evidenceId`, the source attestation artifact hash and `attestationId`, the Massive `rawPayloadHash` and
evidence identity, Twelve Data bars, quote, symbol search, splits and dividends, and the market persistence hashes. The identity tests pin the values captured
before the migration.

## 14. Constants and their justification

| Constant | Value | Why |
|---|---|---|
| `BODY_COALESCE_BYTES` | 65,536 | Large enough that parts are few, small enough that the staging buffer is negligible. Its size is independent of `maxBytes`. |
| `BODY_CHUNK_COUNT_CEILING` | 65,536 | A transport-safety limit on read events, far above normal delivery (section 3). |
| `BODY_EMPTY_CHUNK_STREAK_CEILING` | 1,024 | A no-progress limit: long enough for any legitimate keep-alive or framing pattern, short enough that an endless empty stream ends at once. |

## 15. Test seams

- `Utf8Coalescer` is exported from the module so the coalescing invariant can be tested directly, with 100,000 and one million one-byte chunks, without violating
  the production chunk ceiling. It is a pure, synchronous helper: `feed` bytes, then `finish` to text. `readBoundedUtf8` is the only body reader and uses it.
- `partCount` is a read-only count of retained parts, exposed only for these tests.
- No production constant is weakened or made configurable for the tests.

## 16. Exclusions

- No new body reader. No change to `readBoundedUtf8`'s signature or to its callers.
- No streaming JSON parser. The payload is still parsed whole after it is bounded.
- No decompression. No change to Content-Length handling.
- No change to Twelve Data's error policy, SEC or Massive semantics, `FinancialEvidence`, `FinancialSourceAttestation`, `MarketBar`, knowledge or vintage, the
  scanner, backtest, patterns, risk, capital, broker, execution, AI or O1.
- No database migration. Migrations 001–013 stay byte-identical; there is no 014.

## 17. Remaining limitations

- Peak memory during the final join is about twice the decoded text (section 7). The bound is on the payload, not on the process.
- A body near the byte bound is still parsed as one string, so the parser's own working set is not bounded by this change.
- A legitimate body delivered in very small chunks can exceed the chunk ceiling and be refused. That is intended: the ceiling is a policy, and no normal provider
  approaches it.

## 18. Verification record

- **Final corrections.** The three resource-safety budgets have distinct codes. Their status mapping is in section 12. The SEC source attestation is tested for
  chunk identity (`test/financial/sec-attestation-chunk-identity.test.ts`). `Utf8Coalescer` is marked `@internal` and is not exported by any barrel. A grep
  confirms that no barrel exists in `src` that re-exports the reader, and that `partCount` is read only by the tests.
- **PostgreSQL flake, recorded and not changed.** The first full `npm run check` of this branch failed one test in `test/pg/adversarial.pg.test.ts` with a
  60-second timeout. That run took 667 seconds, against about 420 seconds for earlier runs of the same code, so the machine was under load. The file passed
  on its own (9 of 9, 44 seconds). A clean full rerun passed (1716 of 1716). The test's timeout is unchanged. No transport code depends on that test.
