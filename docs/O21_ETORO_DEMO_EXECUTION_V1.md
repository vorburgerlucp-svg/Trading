# O21 — eToro Controlled Demo Execution V1

Status: core and runtime routes implemented and tested; **locked in build**. Controlled demo E2E: **not ready** (sections 1 and 12). `BUILD_LOCKS.etoroDemoExecution = true`: every demo broker write is refused in this build. No autonomous execution, no `AUTONOMOUS_DEMO`, no real trading. No live eToro request was sent while building O21: the verification is fixtures and unit tests.

Branch: `feature/o21-etoro-demo-execution-v1`, based on `origin/main` (63e726e, the O20 merge).

## 1. Known blockers

**O20 cannot yet parse a non-empty live eToro portfolio; controlled demo E2E with an opened position therefore remains blocked until the real non-empty shape is observed and implemented.**

**AMBIGUOUS close reconciliation is not verified.** It is not verified that `orders:lookup?referenceId=` finds close orders. An AMBIGUOUS close is therefore not reconciled at all in O21: no lookup is made, neither a negative nor a positive answer may decide it, and it stays AMBIGUOUS (`RECONCILIATION_PENDING`) until an officially verified close reconciliation exists. While it is AMBIGUOUS, the position cannot be closed again.

The O20 parser refuses every non-empty portfolio container (`BROKER_RESPONSE_INVALID`), because no non-empty live payload has been observed. O21 does not guess that shape. Consequences:

- After a first demo position exists, the O20 sync fails, its status is `error`, and the gate refuses every further **open** (`BROKER_NOT_CONNECTED_OR_STALE`).
- A **close** of a position NEXUS already knows does not depend on the O20 sync (section 7), so a known position stays closable.

## 2. Official endpoints

Verified on 2026-10-16 against the official eToro API reference, section "Trading - Demo" (api-portal.etoro.com/api-reference/trading--demo). The API versions are those of the reference and are not unified.

| Operation | Method | Path | Reference page |
|---|---|---|---|
| `demo.order.open` | POST | `/api/v2/trading/execution/demo/orders` | Create an order |
| `demo.order.cancel` | DELETE | `/api/v2/trading/execution/demo/orders/{orderId}` | Cancels an order before it is executed |
| `demo.position.close` | POST | `/api/v1/trading/execution/demo/market-close-orders/positions/{positionId}` | Close demo position by units |
| `demo.order.lookup` | GET | `/api/v2/trading/info/demo/orders:lookup?orderId=…` or `?referenceId=…` | Get order information and position details |
| `demo.closeOrder.info` | GET | `/api/v1/trading/info/demo/close-orders/{orderId}` | Get close order information and closed position details |

Host: `https://public-api.etoro.com`. Demo execution root: `https://public-api.etoro.com/api/v2/trading/execution/demo`.

Facts from the reference that the code relies on:

- Open body: `action` (`open` only), `transaction` (`buy` and `sellShort` supported), `instrumentId`, `orderType` (`mkt`, `mit`, `limitIOC`), exactly one of `amount`/`units`/`contracts`, `orderCurrency` (USD only), `leverage` (default 1; above 1 requires `stopLossRate`), `triggerRate` (required for `mit`), `stopLossRate`, `takeProfitRate`, `stopLossType` (`fixed`/`trailing`). `settlementType` is optional on v2; O21 does not send it.
- A 200 means "accepted for processing, not executed". `referenceId` "matching the X-Request-Id header", and it is "the only handle you have if this response is lost".
- Close body: `InstrumentID` (required) and `UnitsToDeduct` (null closes all), with exactly this capitalization.
- Cancel: no body; possible while the order waits for the market or the MIT trigger; a 200 is accepted, not done.
- Order status ids: 1 Received, 2 Placed, 3 Filled, 4 Rejected, 5 PartiallyFilled, 6 PendingCancel, 7 Canceled, 8 Expired, 9 CanceledPartiallyFilled, 10 RejectedPartiallyFilled, 11 WaitingForMarket, 12 PendingTriggeredRate.
- Rate limit: 20 writes per 60 s, shared by the execution endpoints; 429 carries `Retry-After`.
- Scopes for the writes: `etoro-public:demo:write` or `etoro-public:trade.demo:write`.

Not used: the v3 paths, `limitIOC`, trailing stop-loss, `contracts`, the "Cancel pending demo close order" endpoint, and the SL/TP modification `PATCH /api/v2/trading/demo/positions/{positionId}` (section 9).

Real-account endpoints in code: **0**. A boundary test scans the source for any trading path without the demo segment.

## 3. Architecture

`src/broker/etoro/execution/`, separate from the O20 read-only adapter:

| File | Role |
|---|---|
| `etoro-demo-execution-endpoints.ts` | The fixed allowlist and the only URL builder, from validated ids. |
| `etoro-demo-execution-transport.ts` | HTTPS transport. Accepts an allowlisted operation with its exact URL; reports the wire outcome; never retries. |
| `etoro-demo-execution-validation.ts` | Fail-closed parsers of every response; only validated non-secret fields are kept. |
| `etoro-demo-execution-adapter.ts` | `EToroDemoExecutionAdapter`: typed operations, write/read separation, write pacing. |
| `execution-intent.ts` | `ExecutionIntent`, its validation, the state machine. |
| `execution-gate.ts` | The deterministic risk gate. |
| `etoro-demo-execution-service.ts` | Orchestration and append-only persistence. |

There is no generic `request(method, path, body)` function.

## 4. ExecutionIntent

No broker request without an intent. Fields: `intentId`, `action` (open/close), `instrumentId` (NEXUS), `etoroInstrumentId`, `side` (buy/sell), `orderType` (mkt/mit), `amount` or `units`, `currency` (USD), `leverage`, `stopLoss`, `takeProfit`, `triggerRate`, `closesIntentId`, `positionId`, `createdAt`, `expiresAt` (at most 15 minutes after creation), `strategyRunId`, `createdBy`.

Decimals are strings on input and must survive the conversion to the broker's JSON number exactly. The `intentId` is a hash of the validated content: the same input is the same intent (idempotent create). A second intent with the same economic content is refused while the first is active (`INTENT_DUPLICATE`).

The creator is not part of the input: `create(input, createdBy)` takes it as a separate argument from trusted code (the runtime passes the authenticated operator), and an input that names `createdBy` is refused.

A close never takes a position id from input. It names the open intent it closes (`closesIntentId`); the service binds the position from broker-confirmed state (section 7).

## 5. State machine

```
CREATED -> RISK_APPROVED | REJECTED | EXPIRED | CANCELLED
RISK_APPROVED -> APPROVED | EXPIRED | CANCELLED
APPROVED -> SUBMITTING | EXPIRED | CANCELLED
SUBMITTING -> SUBMITTED | REJECTED | AMBIGUOUS
SUBMITTED -> ACCEPTED | FILLED | PARTIALLY_FILLED | REJECTED | CANCELLED
ACCEPTED -> FILLED | PARTIALLY_FILLED | REJECTED | CANCELLED
PARTIALLY_FILLED -> FILLED
AMBIGUOUS -> RECONCILED
RECONCILED -> ACCEPTED | FILLED | PARTIALLY_FILLED | REJECTED | CANCELLED
FILLED, REJECTED, CANCELLED, EXPIRED: terminal
```

SUBMITTING is reachable only from APPROVED, and nothing after it leads back to APPROVED or SUBMITTING; the graph has no cycle (tested). Each state is entered at most once per intent: its record id is `intentId:STATE`. SUBMITTED, ACCEPTED, FILLED and PARTIALLY_FILLED need a stored broker confirmation.

## 6. At most one submission, and AMBIGUOUS

- **Reservation step.** Before the write, `SUBMITTING` is appended with the request id. Its precondition runs inside the storage-backed critical section of the intent log (`writeExclusive`: in PostgreSQL a row lock on the log, in memory the store queue), after the records of every other process were applied. There it re-checks that the intent is still APPROVED **and** the book limits, with the same check table as the gate (`bookRefusals`): duplicate, any AMBIGUOUS or SUBMITTING intent, a live intent on the instrument, max open positions, max gross exposure, close target known, close target not already closing. Only then is SUBMITTING appended, and only after that is the broker write sent. No process mutex is a safety boundary.
- So two different approved intents cannot both pass against the same old book, in one process or in several: tested with two services, two sets of log instances on one store, and on PostgreSQL with two connection pools (same instrument, combined exposure above the limit, max open positions, a SUBMITTING or AMBIGUOUS intent of the other process, the same intent twice). A refusal there sends nothing, records a gate refusal, and keeps the intent APPROVED.
- Each broker request has a fresh `x-request-id`; the intent id stays stable and independent of it.
- Write outcomes: a valid 2xx is SUBMITTED. 401/403, 429 and other 4xx (not 408) are REJECTED: the broker did not act. No answer, a timeout, a network failure, a 5xx, a 408, or a 2xx that is not JSON, malformed, or whose `referenceId` does not echo the request id is **AMBIGUOUS**: the broker may have acted.
- An AMBIGUOUS intent is never resent and never marked failed. For an **open**, `refresh` reads `orders:lookup?referenceId=<the original x-request-id>`; no new request id is created for a write. Only positive evidence that belongs to the intent resolves it: the order found by that referenceId, a fully validated response, the same eToro instrument, `action: open`, and `transaction` `buy` for a buy or `sellShort` for a sell. Then the intent is RECONCILED and takes the broker state. Positive evidence that does not match is `BROKER_RESPONSE_INVALID` and resolves nothing.
- **A negative lookup never resolves AMBIGUOUS.** A 404 for the referenceId, after any time and any number of times, is recorded (`not_found`) and decides nothing: the intent stays AMBIGUOUS (`RECONCILIATION_PENDING`), and no write is made.
- An AMBIGUOUS **close** is not reconciled (section 1).
- A SUBMITTING intent without a recorded answer (a crash) becomes AMBIGUOUS after 30 s and is handled the same way.
- While any intent is AMBIGUOUS or SUBMITTING, no new open is approved or reserved, and an economically equal intent is refused as a duplicate.
- Reads (lookup, close order info) make at most 3 attempts (2 retries); writes are never retried.

## 7. Risk gate

Pure and deterministic; it runs at creation and again with fresh input right before the write. A refusal before the write sends nothing and keeps the intent APPROVED.

| Check | Open | Close |
|---|---|---|
| Build lock, execution enabled (at execute) | yes | yes |
| Intent window (not expired) | yes | yes |
| Kill switch ARMED | yes | no (risk-reducing) |
| Portfolio safety envelope: present, fresh, NORMAL, can increase risk, no hard breach or capacity block (drawdown and loss limits) | yes | no (risk-reducing) |
| Instrument known and active; human-governed `etoro` mapping to exactly this eToro id | yes | yes |
| Quote: production data, fresh (60 s), consistent, USD | yes | no |
| Sizing (max 1000 USD), leverage (max 1), gross exposure (max 3000 USD), open positions (max 3) | yes | no |
| Cash / margin | not available (O20 does not read `credit`); the exposure limit applies | no |
| SL/TP on the correct side; MIT trigger within 10 % of the quote | yes | no |
| No live intent on the instrument; no AMBIGUOUS intent | yes | no |
| No duplicate intent | yes | yes |
| Close target known: an open of NEXUS, FILLED or PARTIALLY_FILLED, same instrument and side, exactly one position confirmed by an eToro order status read | — | yes |
| No other close of that position active | — | yes |
| O20 broker sync connected and fresh (at execute) | yes | no (section 1) |
| Write pacing and Retry-After (at execute) | yes | yes |

A model or strategy cannot switch a check off: the gate input is assembled by the service from trusted state, the policy is a code constant, and approval needs a human identity, which the runtime takes from operator authentication only (section 11).

## 8. Persistence

Four append-only, hash-chained logs: `etoro-demo-execution-intents`, `etoro-demo-execution-attempts`, `etoro-demo-broker-confirmations`, `etoro-demo-execution-reconciliations`. Stored: intent id, request id, broker order and position ids, status id, the broker's numeric error code, timestamps, gate verdicts. Not stored: keys, headers, raw responses, the broker's free-text error message, account ids. The execution layer has no access to the ledger and books nothing.

## 9. Supported operations

- Market open (`mkt`), buy and sell (sent as `sellShort`), by amount or units, with optional fixed SL/TP at open.
- MIT open (`mit`, `triggerRate`).
- Close of a known position at market, fully or by units.
- Cancel of a pending open order (status 1, 2, 11 or 12); the cancellation is confirmed by a read. A cancel is never retried automatically. A later manual cancel by the operator is possible only when every earlier cancel of the intent was conclusively refused by the broker (401, 403, 429 or another 4xx): an accepted, AMBIGUOUS or unfinished cancel blocks every further one. The check runs inside the critical section of the attempt log, so two concurrent cancels, in one or two processes, send at most one write.
- SL/TP: only at open, with the documented fields `stopLossRate`, `takeProfitRate`, `stopLossType: fixed`. Modifying SL/TP of an open position is **not implemented**: the reference documents `PATCH /api/v2/trading/demo/positions/{positionId}`, but not the semantics of an omitted versus a null field. Open point.

## 10. Configuration and locks

`ETORO_DEMO_EXECUTION_ENABLED`: missing or empty is off; exactly `0` or `1`; any other value is `CONFIG_INVALID`. `1` needs `ETORO_ENABLED=1` and `ETORO_TRADING_MODE=demo` (explicitly). It changes nothing else: `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`, `BUILD_LOCKS.liveTrading`, `brokerOrders` and `physicalPurchase` stay true.

`BUILD_LOCKS.etoroDemoExecution = true` is a separate lock for demo execution only. With it closed, `execute` and `cancel` are refused (`EXECUTION_LOCKED_IN_BUILD`) before any gate or request. The service reads the constant directly each time: there is no constructor option, configuration, setter, route or environment override for it. Tests that exercise the write path replace the constant with `vi.mock` in their own test module only; an unmocked test proves the lock is closed and that execute and cancel send nothing. `/health` and `/api/health` report it under `buildLocks.etoroDemoExecution`. Opening it is a separate, explicitly approved code change.

`NEXUS_OPERATOR_ID` and `NEXUS_OPERATOR_TOKEN` configure the local operator (section 11): both or neither, no default; the id is `[A-Za-z0-9_.@-]{1,64}`, the token 32 to 512 printable characters without spaces and not equal to a broker key. The token is never logged, persisted, returned or summarized; the summary states only `operatorAuth: configured | not_configured`.

## 11. Runtime routes

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/broker/etoro/demo/intents` | the intent (section 4) without `createdBy` | 201, the intent after the risk gate (RISK_APPROVED or REJECTED with gate reasons); the creator is the authenticated operator |
| GET | `/api/broker/etoro/demo/intents/{intentId}` | none | the intent |
| POST | `/api/broker/etoro/demo/intents/{intentId}/approve` | empty or `{}` | APPROVED by the authenticated operator |
| POST | `/api/broker/etoro/demo/intents/{intentId}/execute` | empty or `{}` | the one write (refused in this build) |
| POST | `/api/broker/etoro/demo/intents/{intentId}/refresh` | empty or `{}` | a broker read; for an AMBIGUOUS open, a lookup by its original x-request-id |
| POST | `/api/broker/etoro/demo/intents/{intentId}/cancel` | empty or `{}` | one cancel of a pending order |

`intentId` must match `eint_` + 40 hex characters (else 400). Query strings are refused. No route takes a broker order id, a position id, a request id, a URL or a broker payload: they are derived from persisted state. Every route goes through `EtoroDemoExecutionService`; no route, runtime service, AI, quant or other module reaches the adapter or the transport (tested by a source scan). There is no generic order or request route, and `/api/broker/etoro/real/*` is 404 for every method.

**Operator authentication.** Loopback is not authentication. Every `POST` intent route (create, approve, execute, refresh, cancel) needs `Authorization: Bearer <NEXUS_OPERATOR_TOKEN>`. The server keeps only a SHA-256 digest of the token and compares digests with `timingSafeEqual`. The operator identity `{ kind: 'human', id: NEXUS_OPERATOR_ID }` comes from the server: it is the creator, the approver, and is recorded on every write attempt.

**Second check at the write boundary.** The service does not rely on the HTTP layer: `execute(intentId, by)` and `cancel(intentId, by)` require `by`, and the service itself checks that it is `{ kind: 'human', id }` with a valid id before anything else. Anything else is `OPERATOR_INVALID` (403): no reservation, no attempt record, no broker request. Every started execute or cancel attempt records exactly that operator in `by`. A body that names `createdBy` or `approvedBy` is refused. Without operator configuration every mutating route is refused (`OPERATOR_AUTH_NOT_CONFIGURED`); the read-only `GET` stays available. A missing or wrong credential is `OPERATOR_AUTH_REQUIRED` and sends nothing.

**Browser boundary.** No CORS headers are sent. A request with an `Origin` header is refused unless the origin is a loopback origin (`localhost`, `127.0.0.1`, `[::1]`), before authentication (`ORIGIN_REFUSED`). A request body must be declared `application/json` (`UNSUPPORTED_MEDIA_TYPE` otherwise), so a form or `text/plain` request cannot create or approve anything. Together with the bearer token, a browser page cannot mutate the control plane.

The routes exist only with `ETORO_DEMO_EXECUTION_ENABLED=1`; otherwise they answer `EXECUTION_DISABLED`. The runtime passes no safety source (none exists), quotes come from the market data store and count as production only from a production source in production mode, and the build lock is never passed, so the service uses `BUILD_LOCKS.etoroDemoExecution`.

| Code | HTTP |
|---|---|
| `EXECUTION_DISABLED`, `EXECUTION_LOCKED_IN_BUILD`, `OPERATOR_AUTH_NOT_CONFIGURED`, `ORIGIN_REFUSED`, `OPERATOR_INVALID` | 403 |
| `OPERATOR_AUTH_REQUIRED` | 401 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 |
| `INTENT_INVALID`, `APPROVAL_INVALID`, `REQUEST_INVALID` | 400 |
| `INTENT_NOT_FOUND` | 404 |
| `INTENT_STATE_INVALID`, `INTENT_DUPLICATE`, `GATE_REFUSED` (with fixed reason codes), `RECONCILIATION_PENDING` | 409 |
| `BROKER_AUTH_REQUIRED`, `BROKER_NOT_CONNECTED` | 503 (O20 convention) |
| `BROKER_RATE_LIMITED` | 429 (O20 convention) |
| `BROKER_RESPONSE_INVALID`, `BROKER_REJECTED`, `EXECUTION_AMBIGUOUS` | 502 |

`CONFIG_INVALID` is a start refusal, not a route answer: the runtime does not start.

## 12. Open points

- O20 non-empty portfolio parsing (section 1).
- Cash and margin are not checked (O20 `credit` not verified).
- **No portfolio safety source for the eToro demo account exists.** The runtime does not invent one: every open is refused (`PORTFOLIO_SAFETY_NOT_CONNECTED`). Tests inject a source; the entry point never does.
- SL/TP modification after open (section 9).
- AMBIGUOUS close reconciliation is not verified, so an AMBIGUOUS close stays AMBIGUOUS (section 1).
- Operator authentication is a single local operator with a shared bearer token; there is no four-eyes approval and no operator management.
- Write pacing is per process.
