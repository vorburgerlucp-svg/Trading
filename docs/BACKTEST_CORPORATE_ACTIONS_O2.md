# O2: corporate actions on open positions (backtest-engine:v5)

Status: implemented on `feature/backtest-corporate-actions-v1`. Not merged.
Versions: `backtest-engine:v5`, `corporate-action-engine:v1`, `corporate-action-policy:v1`.
Design source: `docs/CORPORATE_ACTIONS_BACKTEST_SPEC.md` (terminology corrected in its section 0).

## 0. Phase 0 inventory (before the change)

| Element | Where | Finding that drives the change |
|---|---|---|
| `BacktestPosition` | `src/backtest/backtest-types.ts` | Had no stable identity. `closePosition` found the entry by `entryTime` and `quantity`: a split changes the quantity, so the link breaks. |
| `BacktestFill`, `BacktestTrade` | same | A trade references fills by `fillId`; the store verifies that reference. |
| `PendingOrder` | `backtest-engine.ts` | Carries `stopLoss` and `takeProfit` of an entry not yet filled. Those levels are price-denominated and must follow a split. |
| `runBacktest` loop | `backtest-engine.ts` | Order per event: pending fill, protective exit, mark, warm-up gate, strategy, new order. Corporate actions must be inserted before the first step. |
| `BacktestQuality`, `BacktestQualityContext` | `quality.ts`, `backtest-types.ts` | `corporateActions: 'modeled' | 'not_modeled'` is a caller assertion. The engine refused `modeled`. |
| `BacktestInput` | `backtest-types.ts` | No corporate-action input and no portfolio currency. |
| `TradingCalendar` | `market-data/sessions.ts` | `session(date, 'regular').open` gives the effective instant. `assumed` marks unverified coverage. |
| `CorporateAction` / `StoredCorporateAction` | `market-data/market-data-types.ts` | Knowledge is `knowledge.knowledgeAt` (proven) or none. `storedAvailableAt` is storage, not knowledge. |
| Replay / provenance | `market-data/corporate-actions.ts` | `selectReplayRevision` and `splitAdjustBars` take `purpose: 'information' | 'economic'`. |
| `splitAdjustBars` | same | Price factor `ratioFrom/ratioTo`, quantity factor `ratioTo/ratioFrom`. Requires raw bars. Returns `CORPORATE_ACTION_TIMING_UNPROVEN` when a split that changes the window is not provably known. |
| PostgreSQL `corporate_actions` | migrations 004, 007 | Unchanged. |
| Backtest persistence | `backtest-store.ts`, `postgres-scanner-backtest-store.ts` | The whole run is hashed (`hashOf(run)`) and checked on read. A tampered field fails the hash. |
| Twelve Data dividends | `providers/twelve-data-schema.ts` | `ex_date` and `amount`, plus `meta.currency`. **No payment date.** |

## 1. Terminology (authoritative)

- `exDate`: the economic effective date (a local trading date of the venue).
- `knowledge.knowledgeAt`: when NEXUS (or a provider that proves it) knew the record. Null when unproven.
- `retrievedAt`: NEXUS capture. A retrieval fact, not knowledge.
- `purpose`: `economic` (what happened) or `information` (what was known). Strategy information always uses `information`.
- `effectiveAt`: the regular session open of `exDate` in the instrument's calendar (`calendar.session(exDate, 'regular').open`).

Old assumptions that are not used: `availableAt` as the knowledge time of an action; `DOUBLE_ADJUSTMENT_RISK` without the `CORPORATE_ACTION_` prefix.

## 2. Decisions the spec left open

1. **Entry lineage.** `BacktestPosition.entryFillId` is the only link to the entry. The entry cost used for P&L is the immutable entry fill (`executionPrice × quantity + commission`), so total basis cannot drift.
2. **Event order** (`corporate-action-engine:v1`): an action is applied at the first bar whose open instant is at or after `effectiveAt`. Application comes before the pending fill, the protective exit, the mark, the warm-up gate and the strategy. The open instant of an intraday bar is its start; of a daily bar, the regular session open of its trading date.
3. **Timing is fail closed in both replay modes.** An effective action must be provably known (`knowledgeAt` proven) at the event that applies it, and its effective session must have a bar. Otherwise the engine throws `CORPORATE_ACTION_TIMING_UNPROVEN`. No run is stored. A retroactive repair is never made. This is stricter than the spec's optional research reconstruction, which would let future knowledge alter position state the strategy sees. Reconstruction is not implemented in V1.
4. **Strategy view.** The strategy receives split-normalised history, built with `splitAdjustBars` and `purpose: 'information'`, only when a split is known and effective. Otherwise it receives raw history, which is already correct.
5. **Dividend entitlement convention** (NEXUS V1, versioned): a position held immediately before the effective session open receives the entitlement. A buy filled at that open does not. A sell filled at that open still counts as held before the open, because the convention is about the state before the open. A dividend in a currency other than the portfolio currency, with a position entitled, throws `CORPORATE_ACTION_FX_NOT_MODELED`.
6. **Receivables** are never cash. Equity is `cash + marketValue + receivablesValue`. Sizing uses cash only.
7. **Settlement is not supported.** The provider states no payment date, so every receivable stays unsettled with `DIVIDEND_PAYMENT_DATE_UNKNOWN`. No migration 010 is needed, because no payment date is available to persist.
8. **Same-instant interactions.** A split and a cash dividend at the same effective instant throw `CORPORATE_ACTION_ORDER_AMBIGUOUS`. Two splits compose exactly, and two dividends add, so neither needs an order.
9. **Duplicates.** The same `actionKey` and `revision` with the same content hash is applied once. Two different revisions of one `actionKey` throw `CORPORATE_ACTION_REVISION_CONFLICT`: the caller passes the replay-selected revision.
10. **Fractions.** A split can produce a fractional quantity. It is kept exactly (scale 12, half-even), never rounded, and the run is marked `FRACTIONAL_CASH_IN_LIEU_NOT_MODELED`.
11. **Calendar.** An ex-date with no regular session (weekend, holiday) throws `CORPORATE_ACTION_CALENDAR_UNPROVEN`. A session the calendar only assumes is applied, but the run is marked `CORPORATE_ACTION_CALENDAR_UNPROVEN`. Continuous markets use the same rule: the session open of the date.
12. **Quality is derived.** `modeled` is true only when accounting ran and no limitation was recorded (pending action, unsettled receivable, fractional result, assumed session). A caller claim of `modeled` that the engine did not prove adds `CORPORATE_ACTION_CLAIM_NOT_PROVEN`.
13. **Raw execution.** When accounting runs, every bar must be raw. Split-adjusted bars throw `CORPORATE_ACTION_DOUBLE_ADJUSTMENT_RISK`.
14. **Symbol change** is an audit record with no economic effect. The instrument identity does not change.
15. **Portfolio currency** is a required input, with no default. It enters the fingerprint.

## 3. Out of scope (fail closed, not faked)

Mergers, spinoffs, tender offers, rights, withholding tax, options adjustments, broker cash-in-lieu, multi-instrument actions, dividend payment settlement, and an ex-post reconstruction in historical research.
