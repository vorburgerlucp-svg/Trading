# O20 — eToro Demo Read-only Broker Adapter V1

Status: demo only, read-only. No real-trading support, no write operation, no demo order, no order, modify or cancel method. Live trading and the build locks are unchanged.

Branch: `feature/o20-etoro-demo-readonly-v1`, based on `origin/main` (ef6d9c3). The automated verification is fixtures, unit tests and PostgreSQL tests; no test calls eToro. A manual live demo read-only smoke test succeeded on 2026-10-16 (section 16).

## 1. Purpose

NEXUS gets a second broker adapter, for eToro, limited to the demo environment and to reading. It reads the demo portfolio, validates it fail closed, reconciles it against the NEXUS ledger, and stores the result append-only. It never books, corrects, maps an instrument, or sends a request that changes anything.

## 2. Non-goals

- No real-account environment, and no route or operation that reaches one.
- No order, modification, cancellation, transfer, close or deposit, in any form.
- No automatic instrument mapping. eToro's `instrumentId` is the broker identity; a mapping is human-governed and is not in this build.
- No automatic ledger mutation and no automatic correction.
- No retry loop, and no background poller.

## 3. Authentication

Three headers on every request, and nothing else:

| Header | Value |
|---|---|
| `x-api-key` | `ETORO_API_KEY` |
| `x-user-key` | `ETORO_USER_KEY` |
| `x-request-id` | a fresh random UUID per request |

The keys come only from the environment, through `src/runtime/config.ts`, and they are read only when `ETORO_ENABLED=1`. They are never logged, never returned by any route, never placed in an error message, never persisted, and never written into a snapshot or audit record. A malformed key is refused at start (`CONFIG_INVALID`); the message names the variable, not the value.

One key rule applies in the configuration and in the transport (`src/broker/etoro/etoro-credentials.ts`): printable ASCII with no space and no control character, 1 to `ETORO_KEY_MAX_LENGTH` (1024) characters. Real user keys are longer than 256 characters. The configuration trims leading and trailing copy/paste whitespace; the transport never changes a key and refuses one that does not match.

Tests prove this on the real transport with marker keys: the keys reach the request headers, and they appear in no stored record, no status, no view and no error (`test/broker/etoro/o20-service.test.ts`, `o20-transport.test.ts`).

## 4. Environment

| Variable | Default | Meaning |
|---|---|---|
| `ETORO_ENABLED` | `0` | `1` or `0` only. Off: nothing is sent, and the broker reports `not_connected`. |
| `ETORO_TRADING_MODE` | unset | `demo` or unset. `real` makes the start fail (`LIVE_TRADING_REFUSED`), even when eToro is off. Any other value is `CONFIG_INVALID`. |
| `ETORO_API_KEY` | unset | Required when `ETORO_ENABLED=1`. |
| `ETORO_USER_KEY` | unset | Required when `ETORO_ENABLED=1`. |

`ETORO_TRADING_MODE=demo` selects the broker environment only. It does not enable NEXUS live trading: `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false` and the build locks `liveTrading`, `brokerOrders`, `physicalPurchase` are unchanged, and a test asserts it.

## 5. Endpoints

Base URL: `https://public-api.etoro.com/api/v1`. The transport uses the global `fetch` with certificate verification on, a redirect is an error, and every request has a timeout of 10 seconds.

The complete allowlist (`src/broker/etoro/etoro-readonly.ts`):

| Operation | Method | Path | Used for |
|---|---|---|---|
| `portfolio.demo` | GET | `/trading/info/demo/portfolio` | The demo portfolio: positions, orders, cash. |

No instrument endpoint is in the allowlist, because no mapping is automatic and none is needed to read the portfolio. The transport accepts only an operation name, never a method, a path or a body. The boundary test asserts that every allowed operation is a GET and that no path names an order, a modification, a cancellation, a transfer or a real environment.

Count: 1 eToro operation, 1 GET, 0 POST, 0 PUT, 0 PATCH, 0 DELETE.

## 6. Observed payload structure

The live demo response observed so far has this shape: `clientPortfolio` with the containers `positions`, `mirrors`, `credit`, `orders`, `stockOrders`, `entryOrders`, `exitOrders`, `ordersForOpen`, `ordersForClose`, `ordersForCloseMultiple` and `bonusCredit`. In the observed response every relevant array was empty.

- The parser reads `clientPortfolio.<container>`, and only there. A top-level `positions` field is never used. A test asserts it.
- An empty demo portfolio is a valid state, and it produces a valid snapshot.
- Unknown fields are ignored, as long as the required containers are correct.

## 7. Validation rules

Every response is untrusted input. Fail closed, no coercion.

| Condition | Result |
|---|---|
| Response is not a JSON object, or `clientPortfolio` is missing or not an object | `BROKER_RESPONSE_INVALID` |
| `clientPortfolio.credit` is missing or `null` | `BROKER_RESPONSE_INVALID` (presence is checked; the value is not read) |
| Any of the nine containers is missing or not an array | `BROKER_RESPONSE_INVALID` |
| Any container has more than 500 entries | `BROKER_RESPONSE_INVALID`, never truncated |
| Any container is non-empty | `BROKER_RESPONSE_INVALID`: its structure is not verified against a live payload, so no entry is mapped |
| Empty containers, unknown fields | valid |

The response size is bounded to 1 MiB, declared or streamed. A body that is not valid UTF-8, or not JSON, is `BROKER_RESPONSE_INVALID`.

Strings, identifiers and decimal values are not parsed in O20, because no non-empty entry is accepted. The bounds that apply are the entry count and the response size. When a later build parses entries, it must add field bounds before it reads them.

## 8. HTTP behavior

| Outcome | Error |
|---|---|
| 200 with a valid body | snapshot |
| 401 or 403 | `BROKER_AUTH_REQUIRED` |
| 429 | `BROKER_RATE_LIMITED` |
| 5xx | `BROKER_NOT_CONNECTED` |
| Other status (for example 404) | `BROKER_RESPONSE_INVALID` |
| Timeout or abort | `BROKER_TIMEOUT` |
| Network failure | `BROKER_NOT_CONNECTED` |
| Malformed JSON, not UTF-8, too large | `BROKER_RESPONSE_INVALID` |

There is no retry. A rate-limited request is not repeated. A failed sync records a failed attempt and stores no snapshot. The error body of a non-200 response is discarded unread, so it cannot leak into a log or an error.

## 9. The snapshot and its coverage

The adapter returns a `BrokerSnapshot` with `broker = "etoro"`, `access = "read_only"`, `observedAt`, `retrievedAt`, and a `coverage` statement:

| Field | Coverage | Why |
|---|---|---|
| `positions` | `verified_empty` | The demo container is empty in the live payload. Non-empty is refused. |
| `openOrders` | `verified_empty` | Every order container is empty in the live payload. Non-empty is refused. |
| `cash` | `not_read` | `clientPortfolio.credit` exists and was a JSON number in the live demo response, but its currency and meaning are not verified. No amount is derived from it, so `cash` is `[]`. |
| `accountId` | `null` | No stable account identifier is observed in the portfolio. None is invented, and no key-derived hash is used. |

Because `cash` is not read, the reconciliation does not compare cash, and its output states the coverage. A `matched: true` result does not mean cash was checked.

## 10. Authority for positions, orders and cash

These are decided per field, and nothing is merged:

- **Positions:** `clientPortfolio.positions`. It is the only position container. Its entries are refused until their fields are observed.
- **Open orders:** no authority is chosen in O20. Seven order containers exist (`orders`, `stockOrders`, `entryOrders`, `exitOrders`, `ordersForOpen`, `ordersForClose`, `ordersForCloseMultiple`). None is merged with another. A later step names one of them as the authority, after a live payload with an order has been observed and its semantics verified.
- **Cash:** no authority is chosen. `clientPortfolio.credit` exists. Its fields are not known, so it is not read.

Where a field is not known, the value is `null` or the coverage says `not_read`. It is not guessed.

## 11. Persistence

Three append-only logs, hash-chained, written in one order (`src/broker/etoro/etoro-broker-service.ts`):

1. The reconciliation is computed first. If it fails, nothing is written and a failed sync record is appended.
2. The snapshot (`etoro-snapshots`), with no timestamps, so identical content keeps one snapshot id.
3. The reconciliation (`etoro-reconciliations`).
4. The sync record (`etoro-sync-events`): `success` with the ids and times, or `failed` with the error code.

No key, no request id, and no raw response is written to any log.

## 12. Reconciliation and the ledger

The reconciliation compares the stored snapshot with the NEXUS ledger, using the existing `reconcileBrokerSnapshot`. It reports `quantity_mismatch`, `missing_in_ledger`, `missing_at_broker`, and `unsupported_currency`. A ledger position of this broker that the demo portfolio does not hold is `missing_at_broker`.

The ledger is opened through `PostgresLedgerStore.openReadOnly(pool, "main")`. That function runs one `SELECT` and never creates the ledger row: a missing ledger is refused with `store_unavailable`, so the runtime does not start with eToro enabled on a database without the ledger. The service sees the ledger through `balances()` only. A test confirms that the ledger holds the same number of entries after two syncs. A PostgreSQL test confirms that opening an existing ledger leaves its ledger row count unchanged, and that a missing ledger is refused without a row being created.

Ledger mutation: 0. No entry is booked, and no correction is made.

## 13. Runtime routes

| Method | Path | Result |
|---|---|---|
| GET | `/api/broker/etoro/status` | The last known state. No request to eToro. Without eToro, `configured: false`. |
| POST | `/api/broker/etoro/sync` | One sync: one GET, a reconciliation, three stored records. Without eToro: 503 `BROKER_NOT_CONNECTED`. |
| GET | `/api/broker/etoro/snapshot` | The latest stored snapshot, or `null`. |
| GET | `/api/broker/etoro/reconciliation?requireFresh=0\|1` | The latest reconciliation. `requireFresh=1` refuses a stale one with 409 `BROKER_SNAPSHOT_STALE`. Any other value is 400. |

There is no order route. `POST /api/broker/etoro/order` and `POST /api/broker/etoro/place` answer 404, for every method and for the paths `orders`, `cancel`, `modify` and `close`, which are also 404. A wrong method on a read route is 405. A test asserts all of this over real HTTP.

Freshness: a snapshot older than 5 minutes is stale (`ETORO_SNAPSHOT_MAX_AGE_MS`).

Broker error codes map to the API with their stable code and a fixed message; the broker's own text is never copied into a response.

## 14. Safety

- `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`, and the three build locks are unchanged. The eToro configuration cannot change them.
- The eToro adapter has no order method. The service has no method that could place, modify, cancel or transfer. A source scan of `src/broker/etoro/` declares no execution function and no generic request function.
- `BrokerSyncAdapter` in `src/broker/broker-sync.ts` has no order method. The existing `ETORO_SYNC` placeholder stays `not_connected`: the eToro adapter is wired through the runtime, not through that constant.

## 15. Known open points

- The live demo read is done (section 16), but the portfolio was empty. A live response with a non-empty portfolio is needed before any position, cash or order field is parsed.
- The open-orders authority (section 10) is not chosen.
- `clientPortfolio.credit` was a JSON number in the live demo response. Its currency and meaning are not verified, so it is not read.
- No stable account identifier is observed. The snapshot states `accountIdentity: not_observed`.
- The `BrokerSnapshot.accountId` type is now nullable, for eToro. The IBKR work on the O19 branch uses its own types and is not changed by this build.
- The instrument endpoints are not in the allowlist. If a mapping is later needed, they are added as separate GET operations, each with its own test.

## 16. Live demo smoke (2026-10-16)

A manual smoke test against the eToro demo environment, on commit `427c28e`, with a temporary loopback PostgreSQL and an empty `main` ledger. It is not part of `npm run check`.

| Check | Result |
|---|---|
| External request | `GET /api/v1/trading/info/demo/portfolio` only, HTTP 200 (direct adapter and runtime sync) |
| Payload | `clientPortfolio` recognized; it matches the parser |
| `positions` | 0 |
| Order arrays (`orders`, `stockOrders`, `entryOrders`, `exitOrders`, `ordersForOpen`, `ordersForClose`, `ordersForCloseMultiple`) | 0 each |
| Snapshot | stored, `fresh` |
| Reconciliation | stored, `matched: true`, 0 issues |
| Ledger, kill switch, instrument mappings | unchanged before and after the sync |
| Broker orders | 0 |
| Secret leaks | none found in console, runtime logs, snapshot, sync and reconciliation records, database rows or HTTP responses |
| Runtime routes | `/health`, `status`, `sync`, `snapshot`, `reconciliation`: 200 |
| Execution and order routes | `order`, `place`, `orders`, `cancel`, `modify`, `close`: 404 |

No demo write and no real trading took place.
