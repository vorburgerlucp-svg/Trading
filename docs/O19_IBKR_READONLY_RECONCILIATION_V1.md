# O19 — IBKR Read-only Broker Sync & Portfolio Reconciliation V1

Status: read-only. NEXUS can read the Interactive Brokers account through the local Client Portal Gateway, validate the answer, store it append-only, and reconcile it against the Capital Ledger. It reports differences and corrects nothing. No broker order can be sent by this build. Live trading stays locked, and the build locks are unchanged (`liveTrading`, `brokerOrders`, `physicalPurchase` = true).

Pipeline:

IBKR → read-only adapter → schema and security validation → instrument identity (conid → NEXUS instrument) → broker snapshot → append-only snapshot and audit → reconciliation against the Capital Ledger → runtime API.

## 1. The official IBKR API and why it fits

- **API:** the Interactive Brokers *Client Portal Web API*, reached through the *Client Portal Gateway* (CPGW). The gateway is a local Java client that runs on the user's machine and serves the API at `https://localhost:5000/v1/api`.
- **Why it fits:** IBKR's authentication page lists three options. The gateway is "the standard method of authenticating for the Web API" and is the one for *Individual Accounts*. OAuth 1.0a and OAuth 2.0 are for advisor, broker, institutional and third-party developer accounts. A personal account can therefore use only the gateway.
- **Source:** [Authentication introduction](https://www.interactivebrokers.com/docs/web-api/authentication/introduction), [Client Portal Gateway installation](https://www.interactivebrokers.com/docs/web-api/authentication/cpgw/installation-authentication), [Limitations of the CPGW](https://www.interactivebrokers.com/docs/web-api/authentication/cpgw/limitations-of-the-client-portal-gateway), endpoint reference at [interactivebrokers.github.io/cpwebapi/endpoints](https://interactivebrokers.github.io/cpwebapi/endpoints).

## 2. Authentication and session

- The user starts the gateway locally (`bin\run.bat root\conf.yaml`) and logs in at `https://localhost:5000` in a browser on the same machine. NEXUS holds **no** IBKR credential.
- IBKR's rules, as stated in the official docs:
  - The login must happen in a browser on the same machine as the gateway, and API calls must come from that machine.
  - Paths beginning with `/gw/api`, `/oauth` or `/oauth2` are not supported through the gateway. NEXUS uses none of them.
  - Two tiers: a *read-only session* is required for every call, and it allows the non-`/iserver` endpoints (portfolio, accounts). The *brokerage session* is required for `/iserver` endpoints (open orders). A single username can hold only one brokerage session.
  - The session expires after several minutes without requests. IBKR asks for a `POST /tickle` about every 60 seconds to keep it alive.
- NEXUS's sync starts with one `POST /tickle`. It reads the session (`ssoExpires` > 0) and the brokerage state (`authenticated`, `connected`, `competing`). A missing session is `BROKER_AUTH_REQUIRED`. A competing brokerage session is `BROKER_SESSION_COMPETING`, and this build never takes it over.
- **Brokerage start (only when the brokerage is not ready).** Once per sync, and only with a valid read-only session and no competing session: `POST /iserver/auth/ssodh/init` with the fixed body `{"publish":true,"compete":false}`, then at least 2 seconds of settle time, then `GET /iserver/accounts` (must be non-empty), then one more tickle. The brokerage must then be `authenticated = true`, `connected = true`, `competing = false`. Otherwise the sync stops with `BROKER_BROKERAGE_INIT_FAILED`. An initialization is never repeated within one sync, and `compete` is never `true`.
- A gateway server error during the initialization is `BROKER_NOT_CONNECTED` (the gateway answered with an error), and a refused initialization (for example 409) is `BROKER_BROKERAGE_INIT_FAILED`.
- The gateway requires a `User-Agent` header on every request (official request documentation). NEXUS sends the fixed value `NEXUS-O19/1.0`, which names no user, account or machine. Without it the gateway answers `403` with a non-JSON body.
- A `POST` without a fixed body states `Content-Length: 0`. Without it the gateway waits for a body and the request times out. The brokerage start sends its fixed body with its true length.
- There is no background keepalive timer in this build, so a sync after a long pause may need a fresh tickle or a browser login.
- The official cURL sample for open orders shows an `Authorization: Bearer` header. That header belongs to the OAuth path. The gateway path sends none, and NEXUS sends none.

## 3. Read-only boundary

Every call NEXUS can make is listed in one frozen table (`IBKR_ALLOWED_OPERATIONS` in `src/broker/ibkr/ibkr-readonly.ts`). There is no generic request function, no way to build another path, and no way for a caller to supply a body. The table is checked by a test (`test/broker/ibkr/o19-boundary.test.ts`), which also scans the source for execution functions.

Exactly two operations are `POST`, and only the second one has a fixed body. Everything else is `GET`.

| Operation | Method and path | Pacing (official) | Purpose |
|---|---|---|---|
| `session.tickle` | `POST /tickle` | 1 req/s | Keep the session alive; read session and brokerage state. No account data. |
| `brokerage.init` | `POST /iserver/auth/ssodh/init` with the fixed body `{"publish":true,"compete":false}` | none listed | Start the brokerage session when it is not ready. `compete` is always `false`. Once per sync. This is a session control, not an order. |
| `brokerage.accounts` | `GET /iserver/accounts` | none listed | Accounts the started brokerage session reports. Must be non-empty. |
| `accounts.list` | `GET /portfolio/accounts` | 1 req/5 s | Accounts this session can read. |
| `account.meta` | `GET /portfolio/{accountId}/meta` | global 10 req/s | Account currency and clearing status (`O` = open). |
| `account.ledger` | `GET /portfolio/{accountId}/ledger` | global | Cash per currency (`cashbalance`). |
| `positions.page` | `GET /portfolio/{accountId}/positions/{pageId}` | global | Positions, 100 per page, at most 5 pages. |
| `orders.open` | `GET /iserver/account/orders?accountId={accountId}` | 1 req/5 s (conservative) | Open and recently filled or cancelled orders for the explicitly selected account, read only. |

Not in the table, on purpose: every `POST /iserver/...` order route, modify, cancel, reply, what-if, transfer, cash, exercise, FX, rebalance, and every `/gw` and `/oauth` path.

**IBKR limits that apply** (official [pacing page](https://www.interactivebrokers.com/docs/web-api/trading/usage-and-availability/pacing-limitations)): a global 10 requests per second per authenticated username; a 429 response when exceeded; a violator IP can be put in a penalty box for 10 minutes. NEXUS does not retry a limited request: the window is consumed before the call, and the next call inside the window is refused with `BROKER_RATE_LIMITED`.

## 4. Documentation discrepancies found (verified against the official pages)

- IBKR documents both the older paginated `/portfolio/{accountId}/positions/{pageId}` endpoint and the newer uncached `/portfolio2/{accountId}/positions` endpoint. O19 keeps the paginated endpoint because its response shape is covered by the current validator; a real gateway run should determine whether a later milestone switches to the uncached path.
- The pacing table lists `/iserver/orders` (1 req/5 s). The endpoint reference lists `/iserver/account/orders`. NEXUS uses the reference path with the stricter 5 s.
- The `ibkrcampus.com` Markdown mirror of the docs was not reachable (Cloudflare error 1000) and was not used. The HTML pages were read directly.
- Sample payloads disagree on types: `conid` and `totalSize` appear as both numbers and strings. The parser accepts both forms and rejects anything else.

## 5. Configuration

| Variable | Default | Rule |
|---|---|---|
| `IBKR_ENABLED` | `0` | `1` or `0` only. Off means nothing is read and the broker reports `not_connected`. |
| `IBKR_BASE_URL` | `https://localhost:5000/v1/api` | Must be HTTPS, a loopback host (`localhost`, `127.0.0.1`, `[::1]`), the path `/v1/api`, with no credentials, query or fragment. Anything else fails the start. |
| `IBKR_ACCOUNT_ID` | none | 1 to 32 letters or digits. Matched exactly against the readable accounts. |
| `IBKR_CA_CERT_PATH` | none | A PEM file with the gateway's own certificate. It adds trust for that certificate. Verification stays on. An unreadable file fails the start (`IBKR_CA_UNREADABLE`). |

`TRADING_MODE=live` and `ALLOW_LIVE_TRADING=true` still refuse the start. No IBKR variable can change a build lock. `NEXUS` starts and runs without IBKR.

**Certificates.** The gateway uses a self-signed certificate. The code never sets `rejectUnauthorized: false`. Either the certificate is in the system trust store, or it is given as `IBKR_CA_CERT_PATH`.

## 6. Adapter and validation

- `IbkrBrokerSyncAdapter` (`src/broker/ibkr/ibkr-sync-adapter.ts`) implements the existing `BrokerSyncAdapter`. It does **not** use `BrokerAdapter` (the order port), and it has no order method (a test checks the prototype).
- Account selection: with `IBKR_ACCOUNT_ID`, exact match, else `BROKER_ACCOUNT_NOT_FOUND`. Without it: exactly one readable account is used. Several accounts → `BROKER_ACCOUNT_AMBIGUOUS`. Zero → `BROKER_ACCOUNT_NOT_FOUND`. NEXUS never picks one of several.
- Every response is validated field by field (`src/broker/ibkr/ibkr-validation.ts`): type, size, shape, the account it belongs to. A position or order of another account is refused. A number that is not finite, or that IBKR would write in exponent notation, is refused. Unknown extra fields are ignored. Error details name a field, never a value.
- Transport (`src/broker/ibkr/ibkr-transport.ts`): loopback HTTPS only; 10 s timeout; body limit 1 MiB, enforced while streaming; JSON only; no redirect followed; no cookie or token stored or sent; a fixed `User-Agent` and the true `Content-Length` on every request; a 401/403 is `BROKER_AUTH_REQUIRED`, a 429 is `BROKER_RATE_LIMITED`. A TLS failure is `BROKER_NOT_CONNECTED` with a fixed reason, never the driver text.
- One sync at a time: a second call while one runs shares its result.

## 7. Instrument identity (conid, not ticker)

- A broker position is identified by IBKR's **contract id (conid)**. The ticker is never the identity: the same ticker on another exchange is another conid, and is not linked to the first instrument (test [11]).
- The NEXUS instrument is found through the existing `InstrumentRegistry`, with provider `ibkr` and `providerSymbol` = conid. A conid with no mapping stays **visible and unmapped** (`instrumentId: null`) and is reported as `unmapped_broker_instrument`. Nothing is invented.
- `POST /api/broker/ibkr/mappings` links a conid explicitly: `{conid, instrumentId, validFrom}`. The link is made only when the latest broker evidence for that conid agrees with the instrument on **symbol, currency and listing exchange**, when the conid is not already linked elsewhere, and when `validFrom` is not in the future. Otherwise it is refused with `BROKER_INSTRUMENT_UNMAPPED`.

## 8. Snapshot model and persistence

`BrokerSnapshot` is the existing type, extended only where IBKR requires it (`src/broker/broker-sync.ts`):

- the account (in memory only; persisted and shown as a masked reference such as `U****567`),
- `access: 'read_only'`, `observedAt`, `retrievedAt`, `accountStatus` (IBKR clearing status),
- `cash` (per currency, in minor units; a value that does not fit the currency is refused, never rounded),
- `positions` (quantity, average cost, market value, unrealized and realized P&L as full-precision amounts, `brokerInstrumentId` (conid), `listingExchange`, `instrumentId` or null),
- `openOrders` — **`null` means unknown** (not read). `[]` means read and none open. The two are never confused. This build starts the brokerage before it reads, so a sync produces a list, never `null`.

Persistence uses the existing `AppendOnlyLog` on PostgreSQL (`append_only_logs` / `append_only_records`; no schema change). Three logs:

| Log | Record id | Content |
|---|---|---|
| `broker-snapshots` | `bsnap_` + fingerprint | The normalized, time-free content plus a pseudonymous `accountKey`. The snapshot fingerprint binds `accountKey + normalized content`, so two different accounts that happen to share the same masked display reference cannot collapse into one snapshot. Positions and orders are sorted, so response order never changes it. |
| `broker-sync-events` | `bsync_` + hash | One observation (`observedAt`, `retrievedAt`, the snapshot id), or a failed attempt with its error code. |
| `broker-reconciliations` | `brec_` + hash(snapshot, ledger fingerprint) | The comparison result. |

**Idempotency.** An identical state observed again has the same fingerprint: no second snapshot, one more observation, no contradiction (test [18], and the PostgreSQL test). A changed state is a new snapshot, and the old one stays. No record is updated or deleted; `verifyIntegrity()` holds (test [19]).

## 9. Reconciliation

`reconcileBrokerSnapshot()` (existing, extended) compares the snapshot with the Capital Ledger:

| Issue | Meaning |
|---|---|
| `quantity_mismatch` | Same instrument on both sides, different quantity. Both values shown. |
| `missing_in_ledger` | Held at the broker, not in the ledger. |
| `missing_at_broker` | In the ledger, not at the broker. |
| `cash_mismatch` | CHF cash differs (the ledger side includes reservations for open orders). |
| `unsupported_currency` | Non-CHF cash. Not converted: there are no FX rates in this build. |
| `unmapped_broker_instrument` | A position or open order with no NEXUS instrument. Never matched to a ledger position by guess. |
| `open_orders_unknown` | Open orders were not read. Reported, never shown as "no orders". |

- A reconciliation **reports** and **never corrects**. It writes no ledger entry and sends no broker action.
- **Freshness.** A snapshot is `fresh` when `observedAt` is at most 5 minutes old (`IBKR_SNAPSHOT_MAX_AGE_MS`). Otherwise it is `stale`. A stale reconciliation is still shown, with `stale: true`. `GET /api/broker/ibkr/reconciliation?requireFresh=1` refuses it with `BROKER_SNAPSHOT_STALE`.

## 10. Runtime endpoints

| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/broker/ibkr/status` | Configured, connection (`connected` / `not_connected` / `error`, last known), `access: read_only`, last successful sync, last error code, masked account. No request to IBKR. |
| POST | `/api/broker/ibkr/sync` | Reads IBKR once, validates, stores the snapshot and the observation, reconciles. Read only. |
| GET | `/api/broker/ibkr/snapshot` | The latest stored snapshot with its freshness, or `null`. |
| GET | `/api/broker/ibkr/reconciliation` | The latest reconciliation with `stale`. `?requireFresh=1` refuses stale. |
| POST | `/api/broker/ibkr/mappings` | The explicit conid → instrument link (section 7). |

`GET /health` now carries `broker.ibkr` (`configured`, `connection`, `access`) and never the account.

**Routes that do not exist** (tested, 404 for every method): `/api/broker/place`, `/api/broker/ibkr/order`, `/api/broker/ibkr/orders`, `/api/broker/ibkr/place`, `/reset`, `/unlock`, `/arm`, `/enable-live`, `/api/safety/reset`, `/api/broker/ibkr/reset`.

**Error codes** (fixed messages, no stack, no secret):

| Code | HTTP | Meaning |
|---|---|---|
| `BROKER_NOT_CONNECTED` | 503 | IBKR disabled, gateway not reachable, or certificate not trusted. |
| `BROKER_AUTH_REQUIRED` | 503 | The session is not authenticated: log in to the gateway in the browser. |
| `BROKER_ACCOUNT_NOT_FOUND` | 409 | The configured account is not readable in this session. |
| `BROKER_ACCOUNT_AMBIGUOUS` | 409 | Several accounts readable and none configured. Fail closed. |
| `BROKER_RESPONSE_INVALID` | 502 | The response does not match the read-only schema, or is too large, or not JSON. |
| `BROKER_TIMEOUT` | 504 | The gateway did not answer in time. |
| `BROKER_RATE_LIMITED` | 429 | The request rate limit applies. No retry. |
| `BROKER_INSTRUMENT_UNMAPPED` | 409 | The contract cannot be linked without guessing. |
| `BROKER_SNAPSHOT_STALE` | 409 | `requireFresh=1` and the snapshot is older than the limit. |
| `BROKER_RECONCILIATION_FAILURE` | 500 | The comparison could not be computed. |
| `BROKER_SESSION_COMPETING` | 409 | Another brokerage session is active. It is not taken over. |
| `BROKER_BROKERAGE_INIT_FAILED` | 503 | The brokerage session could not be started and verified as authenticated and connected. |

Existing `DATABASE_ERROR` is returned when a store fails.

## 11. Security

- Credentials: none in NEXUS. The gateway holds the login. The session token is a marker in tests and is never returned, logged or stored (tests [7], [8], [9]).
- Account ids: the clear account id is masked in responses and is never persisted. Stored snapshots carry only a deterministic pseudonymous account key derived from `broker + accountId`, so audit identity stays account-specific without writing the raw id. The full id lives in memory for the lifetime of the process because the gateway requires it.
- Secrets never appear in errors: transport and validation messages are fixed text or name a field.
- The database URL, the configuration values and the gateway certificate path are not printed.
- The API has no authentication. The runtime still refuses any non-loopback `HOST` (O18). Broker data is read only through the loopback gateway.

## 12. Tests

| Project | File | What it proves |
|---|---|---|
| unit | `test/broker/ibkr/o19-boundary.test.ts` | Allowlist, paths, no execution member or function in the source [21][22]. |
| unit | `test/broker/ibkr/o19-transport.test.ts` | Request shape, verification on, bounded body [4][5], timeout [6], session error [7], secrets in errors [8]. |
| unit | `test/broker/ibkr/o19-validation.test.ts` | Schema of every response, account mismatch, exponent numbers, conid forms. |
| unit | `test/broker/ibkr/o19-adapter.test.ts` | Account selection [2][3], session errors, pagination and its cap, pacing, single flight, identity by conid [10][11]. |
| unit | `test/broker/ibkr/o19-service.test.ts` | Persistence, idempotency [18][19], reconciliation [12]–[17], ledger and order silence [20][21], no secret in logs or records [9], mapping. |
| unit | `test/broker/o19-reconciliation.test.ts` | The comparison rules as pure functions. |
| unit | `test/runtime/o19-config.test.ts` | Configuration rules, loopback HTTPS, no secret in summaries, no unlock [26][27]. |
| unit | `test/runtime/o19-broker-routes.test.ts` | Missing routes [23]–[25], freshness, mapping, not configured, auth error, kill switch unchanged [28]. |
| pg | `test/pg/o19-ibkr.pg.test.ts` | Start, sync, map, sync, restart, read back from PostgreSQL; ledger and kill-switch rows unchanged; CA path failure. |
| live | `test/live/ibkr-readonly.live.test.ts` | Real gateway smoke, opt-in only. |

The full check (`npm run check`) runs the unit and PostgreSQL projects. It never needs IBKR.

## 13. Live smoke test (opt-in, not part of `npm run check`)

Requirements: the Client Portal Gateway running on this machine, logged in through the browser with an individual account, and this environment:

```bash
IBKR_LIVE_TEST=1
```

```bash
IBKR_ACCOUNT_ID=<your account id>
```

Then run the live project:

```bash
npm run test:live
```

Without the opt-in the test is reported as `IBKR LIVE TEST NOT RUN` with the reason. It submits no order: the adapter has no order operation, and the test asserts that the gateway saw only allowlisted reads.

## 14. Why there is no ledger mutation

Broker state is an observation. It is not automatically trusted as a ledger transaction. A broker fill or a broker cash balance can differ from the ledger for reasons that a human must review (reservations, corporate actions, settlement timing, fees, currency). Automatic booking would turn a read into a financial record without review. Therefore O19 only **reads, stores and reports**. Booking fills and cash from IBKR is a separate milestone with its own review. `CapitalLedger` is opened read-only for the reconciliation, and the sync calls none of `recordTradeBuy`, `recordTradeSell`, `deposit`, `withdraw` or `transfer` (test [20]).

Note: the runtime opens the ledger store for reconciliation. On a database where the ledger row does not exist yet, `PostgresLedgerStore.open` creates it (`ON CONFLICT DO NOTHING`). That is the only write, and it writes no entry.

## 15. Known limits

- **Not verified against a real gateway in this milestone.** The CI tests use the fixture. The live smoke test was not run in this environment (see the report).
- **Realized P&L** is documented by IBKR as "profit made today through trades", not a lifetime figure. It is stored as given and not used for reconciliation.
- **Average cost and P&L** are the gateway's values in the position currency; they are not converted.
- **Open orders** are read only after a started brokerage session. If the brokerage cannot be started, the sync stops (no portfolio read, no `openOrders = []`). The model keeps `null` for an unknown state, but this build does not produce it.
- **Keepalive.** No background tickle. A sync after a long pause may fail with `BROKER_AUTH_REQUIRED`.
- **Single brokerage session per username.** An open TWS or other platform session can make this session "competing": the brokerage state is then reported as not authenticated.
- **Multi-currency.** Only CHF cash is reconciled. Other currencies are reported as unsupported.
- **No fill import.** Fills are not read as trades in this milestone.
- **Concurrent mapping requests are serialized by the append-only store.** The registry precondition runs inside the store's exclusive critical section after newer records are applied; a conflicting second mapping is therefore rejected rather than silently duplicated.

## 16. Decisions to review

- Mapping is an explicit API call with identity checks, not automatic. A human chooses the instrument; the code only checks that the evidence agrees.
- The fingerprint excludes times on purpose: the same state at two times is one snapshot, two observations.
- Freshness limit: 5 minutes. A policy value, reviewed in code.
- `openOrders: null` is "unknown". No consumer may treat it as empty.
