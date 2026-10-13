# Massive Read-Only News Connector V1

Status: design, written before implementation. Base: `cbecf22` (`feature/financial-evidence-persistence-v1`, pushed). Branch:
`feature/massive-news-connector-v1`. Not merged.

This branch connects the first real external financial provider to NEXUS, for one capability only: `news`, over Massive's REST API. It is a deterministic
adapter controlled entirely by NEXUS. Massive's MCP server is not used here. No prices, bars, fundamentals, sentiment, estimates, WebSocket, broker or
trading code is added.

## 1. Endpoint and parameters

- `GET https://api.massive.com/v2/reference/news`. The host and path are fixed in code. A caller cannot supply a URL, a host, a path or a query field.
- Query parameters, in this order: `ticker` (the mapped provider symbol), `limit` (configuration, 1–50, default 10), `order=desc`, `sort=published_utc`.
- One request per instrument per call. The page is the only page fetched (§6).

## 2. Authentication and secrets

- `Authorization: Bearer <key>`. The key is resolved from the credential reference `massive-api-key` through `SecretProvider`.
- The reference maps to the environment variable `MASSIVE_API_KEY` through an explicit map (`EnvironmentSecretProvider`). No arbitrary environment read exists.
- No key in source, tests or Git. Tests inject a runtime sentinel. The key is never placed in the URL, a query string, a log, an error, FinancialEvidence,
  a hash, or a test.
- No key configured: the connector reports `not_connected`, and the gateway fails with `DATA_NOT_CONNECTED`. No empty evidence, no demo data, no fallback.

## 3. Provider identity

- Provider `massive`, connector `massive-news-rest`, transport `rest`, capability `news`, mode `RESEARCH`.
- License starts `unreviewed` with redistribution `unknown`. API access is not a redistribution right. Promotion to `production_approved` is a manual act
  after Luc reviews the provider's terms. It is never automatic.

## 4. Instrument identity

- A request names the NEXUS `instrumentId`. The adapter resolves the Massive symbol through `InstrumentRegistry.mappingAt(instrumentId, 'massive', asOf)`.
- Missing mapping: `INSTRUMENT_MAPPING_MISSING`, before any call. The adapter sends only the mapped `providerSymbol`.
- Returned article `tickers` never replace the mapping and are not persisted in V1 evidence. A wrong returned ticker cannot change `instrumentId`.

## 5. Response schema (strict)

Root: an object whose keys are only `status`, `request_id`, `count`, `results`, `next_url`. `status` is optional. When present it must be `OK`, so an error status inside an HTTP 200 is refused. `results` is optional. When absent the page is an empty batch. When present it must be an array of at
most `limit` items. Anything else is `SCHEMA_INVALID`.

Article: an object whose keys are only the following. Any other key is `SCHEMA_INVALID`.

| Field | Rule |
|---|---|
| `id` | required, printable string, 1–200 characters; unique within the page |
| `publisher` | required object; `name` required, 1–200 characters; `homepage_url`, `logo_url`, `favicon_url` optional strings, not used |
| `title` | required, string, 1–2000 characters |
| `published_utc` | required, RFC 3339 UTC with `Z` and 0 to 9 fractional digits; normalised to canonical milliseconds (see the precision policy below) |
| `article_url` | required, `https://` URL, at most 2048 characters |
| `author`, `image_url`, `amp_url` | optional strings |
| `description` | optional string, at most 5000 characters |
| `tickers`, `keywords` | optional arrays of strings; validated, not used |
| `insights` | optional array; validated as an array, not used |

Malformed `published_utc`, a missing `publisher.name`, a missing id, a non-HTTPS article URL, or a duplicate id each fail the whole page.

### Timestamp precision (V1)

- Accepted: an RFC 3339 date-time in UTC with a `Z` suffix. Seconds are required. The fraction is optional, with 1 to 9 digits (the nanosecond bound).
- Refused: a local time without `Z`; an offset such as `+02:00`; impossible dates or times (`2026-02-30`, hour 25, minute 60, second 60); a year before 0100;
  an empty fraction (`.Z`); a fraction longer than 9 digits; an empty string; any other format, such as RFC 822 or a date without a time.
- Normalisation: the fraction is truncated to milliseconds, never rounded. The NEXUS instant is the canonical `YYYY-MM-DDTHH:mm:ss.sssZ`.
- Sub-millisecond provider precision is **not retained** in V1. Two timestamps that differ only below one millisecond are the same NEXUS instant.
  Canonical FinancialEvidence time stays millisecond UTC. No claim of exact sub-millisecond preservation is made.

### Empty pages (V1)

- `status` and `results` are both optional, so a page with no `results` is an empty batch: `evidence: []`.
- `complete` depends only on `next_url`. An empty page with a valid Massive `next_url` is `complete: false`, and `next_url` is still never followed.
- A malformed `results` (present but not a list, such as `null` or an object) is refused. It is never read as empty.
- An empty object `{}` on HTTP 200 is accepted as an empty batch, because both `status` and `results` are optional. Any unexpected field is still refused.

## 6. Pagination: one bounded page

V1 fetches exactly one page. `next_url` is never followed. Its presence is validated and reported:

- absent: the page is complete;
- present, and it is an `https://api.massive.com/` URL with no `apiKey` or credential in it: the batch is returned with `complete: false`;
- present but anything else (another host, plain HTTP, a credential in it): `SCHEMA_INVALID`.

A provider response therefore cannot select a URL, a tool or another connector.

## 7. One evidence record per article

The gateway's single-response path is unchanged. A batch path is added: `gateway.fetchBatch(request)` runs the same governance checks as `fetch` (registration,
enabled, capability allowlist, license, mode, connector binding, connection, identity mapping). It then builds one FinancialEvidence v2 per article through the
same envelope, validation and identity checks. Articles are returned in deterministic order: `providerPublishedAt`, then `evidenceId`. No articles are merged.

Per article:

- candidate: `{ articleId: id, publisher: publisher.name, publishedAt: canonical published_utc, url: article_url }` (validated by the news validator);
- text blocks, untrusted: `title` (source `massive:title`), and `description` when present (source `massive:description`);
- `providerPublishedAt` = canonical `published_utc` (provenance only, §10);
- `providerSymbol` = the ticker that was asked for (checked against the mapping);
- `retrievedAt` = the adapter clock at the response.

## 8. Raw provenance policy

- `rawPayloadHash` is an article-specific canonical hash: `hashOf(article)`, the article object exactly as parsed from the page. Each article therefore
  has its own auditable raw hash.
- The HTTP page is one response that holds several articles. The page is not stored and no page-level hash is recorded in V1. This is a stated
  limitation. It is not pretended that each article came from its own response: the connector makes one call, and the article ids are the link back
  to the page.

## 9. Duplicates and changes

- The same article, unchanged, under the same request: the same `evidenceId`, so persistence returns `ALREADY_APPLIED` and keeps the first record and
  seal (see [docs/FINANCIAL_EVIDENCE_PERSISTENCE_V1.md](FINANCIAL_EVIDENCE_PERSISTENCE_V1.md) §7).
- A changed title, description or published time: a new `contentHash` and a new `evidenceId`. The old record is never overwritten.

## 10. Time semantics

`providerPublishedAt` is provider provenance. It is not NEXUS's knowledge time. The database seal alone proves when NEXUS durably held an article, and a
strict point-in-time read uses only that seal (§11).

## 11. Persistence

For the real pipeline: `FinancialEvidenceService.fetchAndPersistMany(request)` runs `gateway.fetchBatch`, then `store.save` and `store.getSealed` for each
article, independently. It returns each sealed record and the batch's `complete` flag. The PostgreSQL store verifies before any write and seals each record
from the database clock. A historic read at an earlier `asOf` does not show an article sealed later.

## 12. Errors

| Condition | Result | Retried |
|---|---|---|
| 401 | `auth_failed` | no |
| 403 | `not_entitled`. Massive's documentation supports HTTP 403 with `NOT_AUTHORIZED` for entitlement or plan restrictions. This mapping follows that documentation as recorded for this branch. The ordinary live smoke test does not trigger a 403, so it does not verify this path. | no |
| 404 | `not_found` | no |
| 400 | `bad_request` | no |
| 429 | `rate_limited`, with `Retry-After` honoured | yes, bounded |
| 5xx | `provider_unavailable` | yes, bounded |
| timeout, network | `timeout` / `provider_unavailable` | yes, bounded |
| malformed JSON, unexpected schema, status present and not `OK` | `SCHEMA_INVALID` | no |

Retries go through the shared `ResilientCaller`, with its bounded policy. No provider body is logged or embedded in an error.

## 13. Security boundary

The connector imports no broker, capital, risk, execution-gate or AI module. It calls one endpoint, and it cannot call another connector. Article text is
data: it passes through `toUntrustedBlock`, and an injected instruction in a title is quarantined with no second call, no broker access and no risk change.

## 14. Versions

`massive-news-rest:v1` names the adapter. Evidence stays `financial-evidence:v2`. The gateway batch path adds no new identity semantics, so the gateway
version is unchanged.

## 15. Live smoke test (optional, local only)

`test/live/massive-news.live.test.ts` runs only when `MASSIVE_API_KEY` is set, and only in the `live` vitest project. It is not part of `npm run check`.
It asserts that the provider is reachable, that the response schema is recognised, and that no secret appears in any output. It does not assert article
content. A missing key means the test is skipped with a stated reason.

## 16. Limitations

- Only the first page is fetched. A complete history needs a later, separately reviewed pagination design.
- Article tickers are not stored. Provider-derived sentiment and insights are not used anywhere.
- The 403-to-`not_entitled` mapping follows Massive's documentation as recorded here. No live call has verified it, and the ordinary smoke test does not trigger a 403.
- No live call was made in this branch. The smoke test has not run.
- The page is not stored, so the page-level payload cannot be re-verified from NEXUS storage.
