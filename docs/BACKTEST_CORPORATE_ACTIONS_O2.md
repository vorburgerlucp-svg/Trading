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
3. **Timing is fail closed in both replay modes.** The economic knowledge boundary is the effective instant (see section 4): an action must be provably known at or before `effectiveAt`, and its effective session must have a bar. Otherwise the engine throws `CORPORATE_ACTION_TIMING_UNPROVEN`. No run is stored. A retroactive repair is never made. Reconstruction is not implemented in V1.
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

## 4. Timing hardening (corporate-action-engine:v2, corporate-action-policy:v2, backtest-engine:v6)

Found by red-team review of v1 (commit 3dd0e11). The HIGH was reproduced first: a split known at 16:00 UTC on the ex-date was applied at
the 20:00 UTC daily event, although the pending buy filled at the 13:30 UTC open with the transformed levels. The run completed, and the
audit recorded the application at 20:00. The v1 rule compared knowledge with the event that applied the action, which is later than the
economic transformation.

**Two boundaries, kept separate.**

- *Economic knowledge boundary:* an action that changes state is applied only if its knowledge is proven at or before its effective
  instant (the regular session open of the ex-date). This covers splits, reverse splits, dividend entitlement and symbol changes. Knowledge
  that arrives later, even before the bar that applies it closes, fails the run with `CORPORATE_ACTION_TIMING_UNPROVEN`. The state at the
  open cannot be rebuilt without hindsight.
- *Strategy information boundary:* the strategy's view uses split knowledge proven at its own decision time (`asOf`). A split that is
  effective but not yet known is not in the view, and applyDue refuses it before any decision could use it. Information that a strategy
  legitimately knows later in the day does not reach earlier economics, because the economics are fixed at the open.

**Audit semantics.** `effectiveAt` is the economic effective instant. `appliedAt` is the simulated instant the transformation takes effect,
which is always `effectiveAt`. `processedAt` is the deterministic engine event that processed it (for a daily bar, its completion). The
verifier on read checks that `appliedAt === effectiveAt`, that `processedAt` is not earlier, and that the knowledge was proven by
`effectiveAt`.

**Same-instant splits.** Splits at one instant are applied as one exact composite: the composite ratio is the product of the numerators and
the product of the denominators, and rounding happens once. Sequential rounding made the economics depend on the order: 3-for-2 reverse
then 5-for-4 gave 0.833333333334 shares for one share, while the other order and the exact composite give 0.833333333333. Each action is still
recorded individually, with its own factor and the shared before and after states.

**Source identity.** One backtest takes the records of one source (`CORPORATE_ACTION_SOURCE_CONFLICT` otherwise). An `actionKey` is
stable per source, so within one source the key identifies the record. Two different-source records with identical content are no longer
silently deduplicated. The applied audit, the receivables, the pending list and the rejected list each carry `source`, so a record can be
recovered from `source`, `actionKey`, `revision`, `ingestSeq` and `contentHash`.

**Policy identity.** `CorporateActionLedger` takes its engine and policy versions as an injectable argument, defaulting to the production
constants. A test proves that a different policy version changes the fingerprint rows. The production constants are not weakened.

**Dividend convention (unchanged).** An entitlement is the quantity held immediately before the effective open. A buy filled at the open is
not entitled. A sell filled at the open is still entitled, because the state is read before the open. This models ordinary ex-dividend
behaviour only. Special dividends, due bills and other exceptional terms are not modelled.

**Fill timestamps.** A daily bar's fills are stamped at its bar start (local midnight, 04:00 UTC in October), while the economic instant of
the open is the regular session open. This pre-dates O2 and is unchanged. Use `effectiveAt` and `appliedAt` for economic timing.
