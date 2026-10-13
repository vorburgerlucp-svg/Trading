# SEC EDGAR Fundamentals V1

Status: design, written before implementation. Base: `daa84a9` (`feature/massive-news-schema-hardening`). Branch: `feature/sec-edgar-fundamentals-v1`.
Not merged. This branch does not depend on the blocked Massive fundamentals branch (`31183fc`).

The first production-shaped fundamentals source for NEXUS, from SEC EDGAR's official public data APIs. Provider `sec-edgar`, transport `rest`,
capability `fundamentals`, mode `RESEARCH`. No API key. Read-only. No scraping, no third-party SEC APIs, no ratios, valuation, signals or trading.

Endpoints, both on the allowed host `data.sec.gov`:

- `https://data.sec.gov/submissions/CIK##########.json`
- `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`

## 1. Identity model

- A NEXUS request names an `instrumentId`. The SEC identity is resolved only through `InstrumentRegistry.mappingAt(instrumentId, 'sec-edgar', asOf)`.
- The provider-native identifier is the SEC CIK, carried in the existing `providerSymbol` field. It is a string of exactly ten decimal digits with
  leading zeros, for example `0000320193` for Apple. It is never converted through a JavaScript number.
- A missing mapping fails with `INSTRUMENT_MAPPING_MISSING` before any HTTP call.
- Both responses must correspond to the mapped CIK. The companyfacts `cik` is a JSON number token, so it is compared after zero-padding its lexeme to ten
  digits, never through a number. The submissions `cik` is a string. A mismatch fails closed.
- SEC ticker text never replaces the NEXUS identity.

## 2. Fair access and User-Agent

- SEC requires automated clients to declare a User-Agent and limits automated traffic to 10 requests per second. NEXUS is more conservative: a
  process-level pacer enforces a minimum of **125 ms between requests (at most 8 per second)**, through `ResilientCaller`'s `minIntervalMs`.
- The limit applies across all traffic from the same IP address. NEXUS cannot prove what another process on the same IP is doing, and it does not claim to.
- The User-Agent comes from the runtime environment variable `SEC_USER_AGENT`. It is not committed. The documented form is
  `NEXUS <contact identifier>`, and no example contact is hard-coded in the repository.
- A live call with no valid User-Agent is `not_connected`. A User-Agent is valid only when it is printable, at most 200 characters, and contains a
  contact of the form `local@domain`. Nothing is fabricated.
- CI fixtures inject a fake, obviously test User-Agent. A fixture User-Agent is never used for live traffic.
- The User-Agent is not part of any hash or evidence.

## 3. Authentication

No API key. No `Authorization` header. No credential reference and no secret store. The connector sends only the User-Agent and standard `Accept`
headers.

## 4. Transport security

- Allowed host: `data.sec.gov` only. No caller-supplied URL. The two URLs are built from the validated CIK.
- SEC responses never contribute a URL to a later call.
- Redirects: the production fetch adapter must not follow a redirect to another host. When a response carries its final URL, the connector verifies that it is
  still `data.sec.gov` and refuses otherwise.
- Response size: a documented bound of **32 MiB** per response. The body is read as a bounded stream (`docs/BOUNDED_STREAMING_HTTP_TRANSPORT_V1.md`). It
  counts the bytes it consumes and cancels the stream at the bound. `Content-Length` is only an early rejection hint, and the count is authoritative. The
  earlier whole-body limitation is retired by that branch.

## 5. HTTP semantics

| Condition | Result | Retried |
|---|---|---|
| 401 | `auth_failed` (not expected from SEC, mapped for safety) | no |
| 403 | `access_denied`. SEC uses 403 for undeclared or blocked clients and fair-access blocks. It is not a paid-plan entitlement and is never `not_entitled`. | no |
| 404 | `not_found` (for example an unknown CIK) | no |
| 429 | `rate_limited`, with `Retry-After` honoured | yes, bounded |
| 5xx | `provider_unavailable` | yes, bounded |
| malformed JSON | `SCHEMA_INVALID` | no |
| schema failure | `SCHEMA_INVALID` | no |

Retries go through the shared `ResilientCaller`, with bounded attempts. Provider bodies are never logged or embedded in an error.

## 6. Exact number handling (hard gate: `SEC_EXACT_NUMBER_BLOCKER`)

The companyfacts `val` is a JSON number. A binary float cannot carry it exactly, so the response is parsed by a narrowly scoped lexical JSON parser
(`sec-exact-number:v1`) instead of `JSON.parse`.

- The parser follows the JSON grammar. A number keeps its exact source lexeme. Strings, arrays and objects are parsed normally.
- Object keys must be unique within an object. A duplicate key is a parse error, so no value is chosen by position.
- Nesting depth is bounded at 64, so the parser cannot exhaust the stack.
- An exponent with an absolute value above 1000 is refused, so the canonical string stays bounded.
- Whitespace is limited to space, tab, LF and CR. Control characters inside strings are refused.
- A parse error names only the rule that failed. It never echoes the offending token or any part of the response.
- The parser returns numbers as `SecNumber` objects that keep the `lexeme` and the canonical `value`. A JSON string is never read as a number.
- A number is normalised to a canonical decimal string, exactly, by moving the decimal point on digits. No binary arithmetic is used.
  - `0` and `-0` both normalise to `"0"`. Negative zero is not preserved (a documented decision).
  - Leading zeros are removed. Trailing fraction zeros are removed. A whole number has no decimal point.
  - An exponent is applied exactly: `1e9` becomes `1000000000`, `-2.5e-4` becomes `-0.00025`.
- Mandatory examples: `0`, `-0`, `1`, `1.23`, `-1.23`, `94930000000`, `9007199254740993` (beyond `Number.MAX_SAFE_INTEGER`, preserved), `0.000001`, `1e9`, `-2.5e-4`.

The gate is solved by this parser. If it could not be solved safely, the branch would stop with `SEC_EXACT_NUMBER_BLOCKER`.

## 7. Raw provenance

- The SHA-256 of each exact response text is taken before parsing: `submissionsPayloadHash` and `companyFactsPayloadHash`.
- `rawPayloadHash` in FinancialEvidence is the composite canonical hash of
  `{ provider: "sec-edgar", cik, submissionsPayloadHash, companyFactsPayloadHash, accession, selectedFacts, policyVersions }`.
  - `selectedFacts` lists each selected fact by taxonomy, concept, unit, accession, start (duration facts only), end and the exact `val` lexeme.
  - `policyVersions` names `sec-edgar-rest:v1`, `sec-usgaap-fundamentals-map:v1`, `sec-fact-selection:v1` and `sec-exact-number:v1`.
- The User-Agent and process timestamps are excluded from the hash.
- The evidence is composite and is documented as produced from two HTTP responses (submissions and companyfacts). It is never presented as one response.

## 8. Accession and filing selection

Filings come from the submissions `filings.recent` columns. The columns are validated structurally. Each column that is present must be a list of the
same length, and every row must carry a string in each column, blank values included. Every row's `accessionNumber` must be a valid accession number,
and no accession may appear twice. The `acceptanceDateTime` column is optional.

Only exact `10-Q` and `10-K` rows are materialized as `SecFiling` rows, which are the fundamentals sources. Every other form is structurally present
and ignored as a fundamentals source. That includes `10-Q/A`, `10-K/A`, `10-KT`, `10-K405`, `8-K`, prospectus forms, registration statements and proxy
statements. Amendments are not supported in V1 (§11). An unrelated filing may lawfully have an empty `reportDate` or `acceptanceDateTime`, and its
metadata is not validated beyond its structure, so it cannot invalidate the submissions document.

For a materialized `10-Q` or `10-K` row:

- `accessionNumber` must be a valid accession number.
- `filingDate` must be a valid `YYYY-MM-DD` calendar date.
- `reportDate` must be a valid, non-empty `YYYY-MM-DD` calendar date. An empty or malformed value fails closed. It is never inferred from `filingDate`.
- A non-empty `acceptanceDateTime` must match the supported timestamp syntax: `YYYY-MM-DDTHH:MM:SS`, optional fractional seconds of one to nine digits,
  and a `Z` suffix. A blank `acceptanceDateTime` is allowed, because V1 does not use it as `providerPublishedAt` (§13).

CompanyFacts may contain mapped US-GAAP concepts reported in unrelated filing forms. The live AAPL CompanyFacts carries 8-K records of mapped concepts,
and those records have `fy` and `fp` set to null. Only exact `10-Q` and `10-K` entries are materialized as V1 fundamentals-source facts.

Each entry of a mapped concept and unit is processed in a fixed order:

1. The entry must be an object.
2. Its `form` must be bounded printable text of at most 20 characters. A missing, non-string, empty, control-character-bearing or over-long `form`
   fails closed with `SCHEMA_INVALID`, because the entry cannot be classified safely.
3. If `form` is not exactly `10-Q` or `10-K`, the entry is ignored. Its other fields are not read, so its null `fy` or `fp` cannot block the document. No
   fiscal year or period is inferred from it, and the end date is never used to derive one. This covers `8-K`, `10-Q/A`, `10-K/A`, `10-KT`, `10-K405` and
   every other form. Amendments remain excluded (§11).
4. Only then is the strict source-fact validator applied. A `10-Q` or `10-K` entry requires a valid `end`, an exact `val` as a JSON number, a valid
   `accn`, an exact four-digit `fy` as a JSON integer, a non-empty `fp`, the exact form, a valid `filed` date, and a `start` where a duration requires one.

Structure stays strict for every mapped concept, whatever its forms: the root, the CIK, the facts object, the `us-gaap` object, the mapped concept object,
its units object, and each unit list. Unrelated concepts are not read at all.

Companyfacts facts are selected only when each selected fact has a coherent `accn`, `form`, `fy`, `fp`, `filed`, `end` and `unit`. Facts whose
accession is not a filing of the mapped CIK, or whose form, fiscal year, fiscal period or report date is wrong, are not selected.

Materialized CompanyFacts records keep the exact source text of each value, so the raw provenance hash binds the full CompanyFacts response. Adding an
ignored 8-K record to the response does not change the canonical fundamentals data or the evidence identity. It does change `rawPayloadHash`, because the
exact response text changed.

Every selected primary fact must share one accession. Facts from incompatible accessions fail closed with `PROVIDER_DATA_INCOHERENT`. Filings are never
combined silently.

Submissions metadata is used to validate the accession and its report date. `filed` in companyfacts is cross-checked against the submissions `filingDate`.
The submissions `filingDate` is preferred where both exist.

## 9. Period selection

| Request | Source filing | `fp` | Duration or instant |
|---|---|---|---|
| `YYYY-Q1` | 10-Q | `Q1` | quarter duration |
| `YYYY-Q2` | 10-Q | `Q2` | quarter duration |
| `YYYY-Q3` | 10-Q | `Q3` | quarter duration |
| `YYYY-Q4` | — | — | **refused** (`REQUEST_INVALID`) |
| `YYYY-FY` | 10-K | `FY` | annual duration |

- Q4 is not a separately filed 10-Q. Deriving it from FY minus 9M is a future separate policy and is not implemented here.
- The fiscal year is the request's `YYYY`, matched against the fact's `fy`.
- Balance-sheet facts are instants. They are selected when `end` equals the filing's report date. No `start` is required, and a later balance fact is never
  selected merely because its filing is newer.

## 10. Duration rules (YTD versus quarter)

- A quarter duration is between **80 and 100 days** inclusive (a 13-week quarter is about 91 days). An annual duration is between **350 and 380 days**
  inclusive. Duration = `end − start` in whole days, computed on the date values.
- Six-month and nine-month year-to-date facts (about 181 and 273 days) fall outside the quarter window and are never used as Q2 or Q3.
- The shortest arbitrary duration is never taken. A fact must fall inside the window and share the selected accession and report date.

## 11. Amendments

V1 does not implement `10-Q/A` or `10-K/A`. Facts from amendment forms are excluded by the exact form match (`10-Q`, `10-K`), so an amendment can neither add nor
overwrite a value. This is a stated limitation: if an amendment restates a period, NEXUS continues to use the original filing. When more than one
original filing matches the same period, the selection fails closed with `PROVIDER_DATA_INCOHERENT`, even when the values are identical, because the
evidence must name exactly one accession.

## 12. As-of and look-ahead

- A filing is usable for a request only when its `filingDate` is **strictly before** the date of `request.asOf` (UTC). A filing on the same day is excluded,
  because the exact acceptance time is not used in V1 (see §13), and the rule is conservative.
- A filing whose `filingDate` is after the as-of date is never selected, even when it is the only record for the period.
- If no lawful candidate remains, the result is `PROVIDER_DATA_ABSENT`. It is never filled with a later value.

## 13. Provider time and NEXUS knowledge

- `providerPublishedAt` is **null** in V1. The submissions `acceptanceDateTime` is not converted, because its timezone semantics are not confirmed against
  official SEC behaviour, and no timezone is invented. A future branch may use it once the semantics are verified.
- `effectiveAt` is **null**. The period end is a date, not an instant, and no `00:00:00Z` is invented for it.
- `retrievedAt` is the connector clock at the response.
- SEC filing time is source provenance. It is not NEXUS historical knowledge. SEC does not provide an exact timestamp showing when content first became
  public on sec.gov. The database knowledge seal alone is NEXUS's exact knowledge proof.
- A historical filing fetched and sealed today is **not** decision-time available before NEXUS sealed it, even though SEC says it was filed earlier.
  `readAvailable` is not weakened, and `providerPublishedAt` never substitutes for `sealedAt`.

## 14. Concept mapping (`sec-usgaap-fundamentals-map:v1`)

Only US-GAAP concepts are used. Other taxonomies, including `ifrs-full`, are not mapped in V1. A company with no usable `us-gaap` facts fails with
`PROVIDER_DATA_ABSENT`.

| NEXUS field | Source | Rule |
|---|---|---|
| `revenue` | `RevenueFromContractWithCustomerExcludingAssessedTax`, then `Revenues`, then `SalesRevenueNet` | the first concept in this order with a selected fact; deterministic priority, not a combination |
| `grossProfit` | `GrossProfit` | duration |
| `operatingIncome` | `OperatingIncomeLoss` | duration |
| `ebit` | none | **null** (EBITDA is a different concept and is never mapped to EBIT) |
| `netIncome` | `NetIncomeLoss` | duration |
| `eps` | `EarningsPerShareDiluted`, unit `USD/shares` only | duration. V1 `eps` means **diluted** EPS. Basic EPS is never a fallback. |
| `cash` | `CashAndCashEquivalentsAtCarryingValue` | instant |
| `equity` | `StockholdersEquity` | instant. `StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest` is not substituted. |
| `debt` | none | **null**. No total-debt formula exists in V1. |
| `operatingCashFlow` | `NetCashProvidedByUsedInOperatingActivities` | FY: annual duration. Q1–Q3: only from a directly filed quarter-duration fact (§15). A year-to-date value is never used. |
| `capex` | none | **null**. The sign convention is not documented, so it is not mapped. |
| `freeCashFlow` | none | **null**. Not derived. |

No fuzzy matching of XBRL tags. Each mapping is an exact concept name.

## 15. Quarterly cash flow

SEC 10-Q cash-flow facts are cumulative year-to-date. For Q1–Q3, `operatingCashFlow` is **null** unless a directly filed quarter-duration fact for the exact
requested quarter exists under §10. No prior filings are subtracted in V1.

## 16. Currency and units

- Monetary concepts use only the unit that matches `request.currency`, which is `USD` for the V1 mapping. `EarningsPerShareDiluted` uses only `USD/shares`.
- No FX. No inference from the ticker's trading currency. No relabelling of another currency as the requested currency.
- If the requested currency has no matching unit, the monetary fields are null, and the minimum-record rule (§18) then fails.

## 17. Null versus zero

- A missing concept is `null`.
- A filed zero is the string `"0"`.
- Missing is never converted to `"0"`, and a zero is never converted to `null`.
- **Semantic limitation:** a provider `0` can also appear for an unreported concept. The value is preserved as provided and is not labelled as a confirmed filed
  zero. No inference is made.

## 18. Minimum useful record

A record is produced only when at least one income-statement value and at least one balance-sheet value are present. Otherwise the result is
`PROVIDER_DATA_ABSENT`. A record of only null financial fields is never returned as a successful fundamentals record.

## 19. Duplicates and order

- Duplicate facts that share the complete selection key (concept, unit, accession, start, end): identical values are deduplicated deterministically. Differing
  values fail closed with `PROVIDER_DATA_INCOHERENT`.
- Identical duplicates keep one representative: the one with the smallest `lexeme` text, so the output never depends on order.
- A field and unit may have exactly one candidate after deduplication. Two candidates with different starts, both inside the window, fail closed with
  `PROVIDER_DATA_INCOHERENT`.
- Selection never depends on array order. It is invariant under any permutation of the concept entries, the unit entries and the submissions rows.
  The raw provenance hash is the one exception: it hashes the exact response text, so a reordered response has a different raw hash. The evidence
  identity (`evidenceId`) is unchanged, because it does not include the raw hash.

## 20. Strict schema

- Root structure, CIK, the facts object, the `us-gaap` taxonomy, the requested concepts, the units object and every selected entry are validated strictly.
- Unrelated SEC concepts and unrelated fields are ignored. One unrelated concept never breaks ingestion.
- Within a mapped concept, an entry of an unrelated form (anything other than `10-Q` or `10-K`) is ignored once its `form` is classified (§8). Its other
  fields are not validated, so its null `fy` or `fp` cannot block the document.
- The identity fields (`accn`, `form`, `fy`, `fp`, `filed`, `end`, `unit`) are mandatory on every `10-Q` and `10-K` entry of a mapped concept. A null or
  malformed value there fails closed. Optional line items may be absent.

## 21. Gateway integration

The connector produces one provider payload. `FinancialDataGateway` validates it, `FinancialEvidence` v2 builds the identity, `FinancialEvidenceService`
persists it, and `PostgresFinancialEvidenceStore` seals it. No parallel evidence system is created. No canonical validator is weakened. Provider
provenance stays outside canonical financial values.

## 22. Persistence and point-in-time

Fixture integration proves the full path without network access: SEC connector → gateway → evidence v2 → service → PostgreSQL → COMMIT_SEAL → `getSealed` →
`verifyFinancialEvidence`.

Mandatory regression: a 2024 filing fetched and persisted in 2026 is not returned by `readAvailable` at an asOf in 2025, because NEXUS sealed it in 2026.
It is returned at an asOf at or after its seal.

## 23. Amendments in the knowledge model

Different accessions create different provenance and different evidence. The PostgreSQL evidence store stays append-only. Older evidence is never overwritten.

## 24. Unsupported cases (fail closed, documented)

- `IFRS` (`ifrs-full`): not mapped in V1.
- No `us-gaap` facts: `PROVIDER_DATA_ABSENT`.
- `Q4`: `REQUEST_INVALID`.
- `10-Q/A` and `10-K/A`: excluded (§11).
- A currency with no matching unit: monetary fields null (§16).
- A filing on the same day as `asOf`: excluded (§12).
- Ratios, TTM, valuation, market data: not implemented.

## 25. O1

`strongO1Eligible` stays `false`. SEC is authoritative primary filing data, but NEXUS has no source-specific strong-O1 proof policy for financial evidence, and
this branch does not change O1 governance.

## 26. Versions

`sec-edgar-rest:v1` (the adapter), `sec-usgaap-fundamentals-map:v1` (the concept map), `sec-fact-selection:v1` (selection and duration rules),
`sec-exact-number:v1` (the lexical number policy). Each one enters the composite raw provenance hash.

## 27a. Selection algorithm (`sec-fact-selection:v1`)

Pure function over validated inputs. It makes no call.

1. Parse the period. `Q4` throws `REQUEST_INVALID`. The connector checks this before any HTTP call.
2. Form: `10-K` for FY, `10-Q` for Q1–Q3. Duration window: 350–380 days for FY, 80–100 days for a quarter.
3. Usable filings: submissions rows with the required form and `filingDate` strictly before the UTC date of `asOf`.
4. A fact is a candidate when all of these hold: the concept is mapped, the unit is the requested unit, its accession is a usable filing, its `form`
   and `fy` and `fp` match the request, its `end` equals the filing `reportDate`, and its duration (balance facts have none) is in the window. If its
   `filed` differs from the submissions `filingDate`, the result is `PROVIDER_DATA_INCOHERENT`.
5. Deduplicate (§19). Every candidate must share one accession, or the result is `PROVIDER_DATA_INCOHERENT`.
6. For each field, take the first concept in its priority order that has a candidate. More than one candidate for that concept fails closed.
7. Minimum record (§18): at least one income value and at least one balance value. Otherwise `PROVIDER_DATA_ABSENT`.
8. Output: the candidate, the one accession, and the selected facts sorted by concept, unit, start and end.

Validation of the documents happens first, in `submissionsOf` and `companyFactsOf`. Mapped concepts are validated strictly in every unit. Unmapped
concepts are not read.

## 27b. Modules and identifiers

- `src/financial/sec-edgar-json.ts`: the lexical parser (`sec-exact-number:v1`) and `SecNumber`.
- `src/financial/sec-fact-selection.ts`: validation and selection (`sec-fact-selection:v1`, `sec-usgaap-fundamentals-map:v1`).
- `src/financial/sec-edgar-fundamentals.ts`: the connector, the User-Agent reader, the pacer factory and the production fetch adapter (`sec-edgar-rest:v1`).
- Connector id `sec-edgar-fundamentals-rest`. Provider `sec-edgar`. Transport `rest`. Capability `fundamentals`. License `research_only`, `internal_only`.
- New error codes: `PROVIDER_DATA_ABSENT`, `PROVIDER_DATA_INCOHERENT`, and the provider error code `access_denied`.
- `HttpResponseLike` gains an optional `url`. A response that carries one is checked against `data.sec.gov`.

## 27. Limitations

- Nothing is verified against the live SEC API in this branch. Live use requires a real `SEC_USER_AGENT`, which is not configured here.
- The response-size check is enforced on the streamed bytes (§4). The earlier whole-body limitation is retired by `docs/BOUNDED_STREAMING_HTTP_TRANSPORT_V1.md`.
- The pacer enforces the rate only within one process.
- `providerPublishedAt` and `effectiveAt` are null, so provider time gives no instant.
- Amendments are not reflected.
- Quarterly operating cash flow, capex, debt, EBIT and free cash flow are null by policy.
- Historical decision-time availability before NEXUS's own seal is not provided. A future branch on source-vintage attestation would address it.
- A device on the same IP that exceeds SEC's limit is not visible to NEXUS.
