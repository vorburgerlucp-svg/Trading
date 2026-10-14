# O18 — NEXUS Runtime & Live Market Data Service V1

Status: paper only. Live trading is locked. Broker orders, physical purchases and the kill-switch reset are not reachable from this build.

Branch: `feature/o18-nexus-runtime-market-data-v1`, based on `origin/main` (b3fe8ff).

## 1. Purpose

`npm run dev` starts a local NEXUS server. It runs the pipeline:

Twelve Data → validation → MarketDataService → PostgreSQL → data quality → quant → safety (read only) → paper only.

Every market response comes from validated NEXUS data. When no provider is configured, every market route answers `DATA_NOT_CONNECTED`. Nothing is substituted.

## 2. Non-goals

- No GitHub Pages work and no dashboard UI.
- No live trading, no broker orders, no physical purchases.
- No route that resets the kill switch, unlocks a build lock, arms the system or enables live trading.
- The paper intent route is reserved (`NOT_IMPLEMENTED`). The paper execution gate of O17 is not in `main` yet.
- The scanner is not exposed by the runtime in this milestone.

## 3. Start

Requirements: Node.js 22 or newer (verified on Node 24), a reachable PostgreSQL, and a `DATABASE_URL` in a local `.env` file. `.env` is never committed. `.env.example` lists the variables.

Install dependencies:

```bash
npm install
```

Apply the migrations. This is the only step that changes the schema, and it runs once per database:

```bash
npm run db:migrate
```

Start the server:

```bash
npm run dev
```

The server listens on `http://127.0.0.1:3000` by default. Stop it with Ctrl+C. `npm start` runs the last build without rebuilding.

## 4. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | none (required) | `postgres://` or `postgresql://` URL. Never logged, never returned. |
| `HOST` | `127.0.0.1` | Listen address. Loopback by default. The API has no authentication, so a non-loopback host exposes it to the network. |
| `PORT` | `3000` | 1 to 65535. |
| `TWELVE_DATA_API_KEY` | unset | Production key. Sent only in the `Authorization` header. Never in a URL. |
| `NEXUS_TWELVE_DATA_DEMO` | `0` | `1` uses Twelve Data's public demo key. Data is labelled `demo` and is never usable for trading. Ignored while a production key is set. |
| `TRADING_MODE` | `paper` | Only `paper` is accepted. `live` makes the start fail. |
| `ALLOW_LIVE_TRADING` | `false` | Only `false` is accepted. `true` makes the start fail. |

Build locks (`liveTrading`, `brokerOrders`, `physicalPurchase`) are constants in `src/nexus/safety.ts`. No environment variable and no configuration key changes them.

## 5. Data flow

1. **Provider.** `TwelveDataMarketDataProvider` requests bars and quotes. The response body is read under a byte bound and its schema is validated. Provider messages are scrubbed of the key before they become errors.
2. **Validation.** `MarketDataService` validates each bar and computes the data-quality verdict. The verdict travels with every read, and a verdict that is not usable is returned as such.
3. **Storage.** Bars are stored in `market_bars` with source, retrieval time and revision knowledge (migrations 004 to 009). Quotes go to `market_quotes`. Instruments and their provider mappings are an append-only log (`instrument_events`).
4. **Read.** `readSeries` reads point in time and returns the quality verdict with the bars.
5. **Quant.** `POST /api/quant/run` backfills a lookback window of 300 bars, runs `QuantService` and stores the run in `quant_runs`. The quant run ID is `qr_` plus the input fingerprint.
6. **Safety.** `GET /api/safety/status` reads the kill-switch log (`portfolio-kill-switch`) read only. No portfolio snapshot is connected, so risk increase is blocked.

## 6. Routes

Routes are a fixed table in `src/runtime/app.ts`. Unknown paths return `NOT_FOUND`. A known path with the wrong method returns `METHOD_NOT_ALLOWED`.

| Method | Path | Notes |
|---|---|---|
| GET | `/health`, `/api/health` | Status, database, market data mode, provider state, trading mode, locks. |
| GET | `/api/instruments/search?q=` | Validated candidates only. Injected text is sanitized. `instrumentId` is `null` when the symbol is not registered. |
| GET | `/api/market/bars?instrumentId=&interval=&from=&to=` | Intervals `1m 5m 15m 1h 4h 1d`. Canonical UTC times, `from` before `to`, at most 366 days. |
| GET | `/api/market/quote?instrumentId=` | Freshness and `usableForTrading`. A quote is usable only when it is fresh (15 minutes) and from production. |
| POST | `/api/quant/run` | JSON body with exactly `instrumentId`, `interval`, `asOf`. Other keys are refused. Body limit 16 KB. |
| GET | `/api/safety/status` | Read only. `canIncreaseRisk` is `false`, `canReduceRisk` is `true`, `liveTradingAllowed` is `false`. |
| GET | `/api/paper/intents` | Reserved. Returns `NOT_IMPLEMENTED`. |

Every response carries `cache-control: no-store` and `x-content-type-options: nosniff`.

## 7. Error codes

| Code | HTTP | When |
|---|---|---|
| `DATA_NOT_CONNECTED` | 503 | No market data provider is configured. |
| `REQUEST_INVALID` | 400 | Parameter or body validation failed. |
| `INSTRUMENT_NOT_FOUND` | 404 | Unknown instrument, or no mapping for the provider. |
| `MARKET_DATA_ERROR` | 502 | The provider could not serve the request. |
| `DATA_QUALITY_ERROR` | 422 | Stored data does not pass the quality checks for this request. |
| `DATABASE_ERROR` | 503 | The database is unavailable, or stored data failed an integrity check. |
| `SAFETY_BLOCK` | 409 | A safety rule blocks the request. |
| `NOT_FOUND` | 404 | No such route. |
| `METHOD_NOT_ALLOWED` | 405 | Route exists, method does not. |
| `PAYLOAD_TOO_LARGE` | 413 | Body over 16 KB. |
| `NOT_IMPLEMENTED` | 501 | Reserved capability (paper intents). |
| `INTERNAL_ERROR` | 500 | Anything unexpected. No message, stack or detail reaches the client. |

Error bodies are fixed strings. No error body contains a secret, a URL or a database detail.

## 8. Startup is fail-closed

`startRuntime` (`src/runtime/bootstrap.ts`) runs these steps in order. A failure at any step stops the start before the server listens.

1. The configuration is loaded. `TRADING_MODE=live` or `ALLOW_LIVE_TRADING=true` is refused (`LIVE_TRADING_REFUSED`). Other non-exact values are refused (`CONFIG_INVALID`).
2. PostgreSQL must answer a `SELECT 1` (`DATABASE_UNAVAILABLE`).
3. The database must carry exactly the repository's migrations (`MIGRATIONS_PENDING` or `MIGRATIONS_MISMATCH`). The runtime never migrates by itself.
4. The stores are opened, the kill-switch log is opened, and the services are composed.
5. The HTTP server listens.

On `SIGINT` or `SIGTERM` the server stops accepting requests, closes open connections and releases the pool.

## 9. Tests

| Project | File | Tests | What it proves |
|---|---|---|---|
| unit | `test/runtime/o18-runtime-config.test.ts` | 10 | Configuration: live refused, exact values, no secret in messages, locks not configurable. |
| unit | `test/runtime/o18-app.test.ts` | 10 | HTTP surface: fixed routes, methods, validation, body limit, error mapping, no secret in responses. |
| unit | `test/runtime/o18-services.test.ts` | 6 | Services: validated search, `DATA_NOT_CONNECTED` without a provider, unknown instrument, safety status. |
| unit | `test/runtime/o18-smoke.test.ts` | 1 | Start, health, search, bars, quant, safety, shutdown over the production composition (in-memory stores). |
| unit | `test/runtime/o18-bootstrap.test.ts` | 4 | Fail-closed start without a database; the start error never contains the connection secret. |
| pg | `test/pg/o18-runtime.pg.test.ts` | 2 | Against PostgreSQL 17.10: an unmigrated database is refused and not migrated; a migrated one serves the API and reads its state back after a restart. |
| live | `test/live/twelve-data.live.test.ts` | 1 passed | Real Twelve Data call with the public demo key (AAPL daily bars and quote, normalized, validated, stored). Runs only with `TWELVE_DATA_API_KEY` or `NEXUS_TWELVE_DATA_DEMO=1`. Its result is labelled demo and is never usable for trading. The three other live files (SEC EDGAR, Massive) are not part of O18 and were skipped: they need `SEC_USER_AGENT` or `MASSIVE_API_KEY`. |

Run the required check:

```bash
npm run check
```

Run the live smoke test with the public demo key:

```bash
npm run test:live
```

## 10. Known limits and open items (for O19)

- The scanner is not exposed by the runtime.
- `/api/paper/intents` is reserved until the O17 paper execution gate is in `main`.
- No portfolio snapshot is connected. Risk increase is blocked until one is.
- No authentication on the local API. Keep `HOST` on loopback.
- The public demo key has provider rate limits and serves split-adjusted prices only. Its data is never usable for trading.
- Quotes are stored only when a quote is requested. There is no background polling.
- The server runs compiled output (`dist/`). There is no TypeScript runner in the start path.
- **Quant on demo data is not valid.** The public demo key serves split-adjusted prices only. The quant service derives split-adjusted series from raw bars (`src/quant/quant-service.ts`, `inputs`), and no raw bars exist in demo mode. A demo quant run therefore stores a run with `missing_bars` (`valid: false`, `usableForTrading: false`). The response still reports `persistence: APPLIED` and `insufficientData: false`. This is a known defect of the demo path. The runtime should refuse quant runs in demo mode, or the production path should be verified first. Not changed in O18.
- **The production quant path is not verified live.** It requests raw prices and reads them directly, but no production key was available to test it.
- **No instrument registration route.** Instruments enter the instrument log only through code or a database write. The AAPL example used a one-off local seed (`ins_aapl`, Twelve Data mapping `AAPL`). A registration route or a reviewed seed command is an O19 item.
