# O15: Portfolio Safety Envelope & Kill Switch V1

Status: design first. Base: `69d4ed7` (O14 Trading Tutor & Pattern Quiz V1 merged and green).

## 1. Goal

O15 is the first Phase-4 prerequisite.

It adds a deterministic, fail-closed safety envelope around the existing capital and portfolio state:

- daily loss limits;
- intraday drawdown limits;
- gross portfolio exposure limits;
- single-position exposure limits;
- maximum open-position count;
- data-quality holds;
- a latching kill switch.

O15 **does not enable live trading**.

Its authority is one-way:

> O15 may reduce or revoke permission to add risk. It can never unlock a broker, enable live trading, or override an existing safety lock.

## 2. Existing foundations reused

O15 must reuse rather than duplicate:

- `CapitalState`
- `PortfolioSnapshot`
- exact CHF/Rappen arithmetic
- existing portfolio position views
- existing market-data coverage flags
- existing Risk Gate / capital risk gate semantics
- canonical hashing via `hashOf`

The broker adapters remain locked.

## 3. Version identities

Safety engine:

`portfolio-safety-envelope:v1`

Policy:

`portfolio-safety-policy:v1`

Daily accounting summary:

`risk-day-summary:v1`

Kill-switch state:

`portfolio-kill-switch:v1`

## 4. Pure-core requirement

Primary API:

```ts
evaluatePortfolioSafetyEnvelope({
  portfolio,
  day,
  previousKillSwitch,
  policy
}) -> PortfolioSafetyDecision
```

The function is pure:

- no ledger writes;
- no broker calls;
- no audit writes;
- no network;
- no wall clock;
- no random ids.

All time is explicit input.

## 5. Risk-day summary

O15 consumes an explicit, point-in-time daily summary produced from authoritative ledger/accounting inputs:

```ts
interface RiskDaySummary {
  version: 'risk-day-summary:v1';
  dayId: string;                  // YYYY-MM-DD policy/trading day
  dayStartedAt: string;           // canonical UTC
  asOf: string;                   // canonical UTC
  startNetWorthChf: Rappen;
  peakAdjustedNetWorthChf: Rappen;
  netExternalFlowsTodayChf: Rappen;
  realizedTradingPnlTodayChf: Rappen;
  sourceLedgerHeadHash: string;
  sourceFingerprint: string;
}
```

`netExternalFlowsTodayChf` means deposits minus withdrawals since the day start.

The source summary is not invented by O15.

## 6. Flow-adjusted daily P&L

External deposits and withdrawals must not look like trading profit/loss.

Define:

```
adjustedCurrentNetWorth
  = portfolio.capital.totalNetWorthChf
    - day.netExternalFlowsTodayChf

adjustedDailyPnl
  = adjustedCurrentNetWorth
    - day.startNetWorthChf

adjustedDailyLoss
  = max(0, -adjustedDailyPnl)
```

The daily-loss basis is therefore flow-adjusted.

## 7. Intraday drawdown

The daily summary supplies the highest flow-adjusted net worth seen so far:

```
intradayDrawdownChf
  = max(0, day.peakAdjustedNetWorthChf - adjustedCurrentNetWorth)
```

Drawdown basis points are relative to `peakAdjustedNetWorthChf`.

The peak must never be below both:

- `day.startNetWorthChf`; and
- current `adjustedCurrentNetWorth`.

Otherwise the summary is inconsistent and O15 fails closed.

## 8. Financial portfolio exposure

V1 portfolio limits apply to financial positions only.

For every open position:

- a fresh market value is required;
- stale or missing prices create a data hold;
- no cost-basis fallback may be used for exposure limits.

When pricing is complete:

```
grossExposureChf = sum(open position marketValueChf)

grossExposureBp
  = grossExposureChf / current total net worth

positionExposureBp
  = position marketValueChf / current total net worth
```

If total net worth is zero or negative, the safety envelope is tripped.

## 9. Policy

V1 policy:

```ts
interface PortfolioSafetyPolicy {
  version: 'portfolio-safety-policy:v1';

  maxAdjustedDailyLossChf: Rappen;
  maxAdjustedDailyLossBp: number;

  maxRealizedTradingLossChf: Rappen;

  maxIntradayDrawdownChf: Rappen;
  maxIntradayDrawdownBp: number;

  maxGrossExposureBp: number;
  maxSinglePositionExposureBp: number;
  maxOpenPositions: number;

  requireCompleteFinancialPricing: true;
}
```

All CHF limits are non-negative bigint Rappen.

All basis-point limits are positive safe integers.

No floating-point money is allowed.

## 10. Limit semantics

### Hard trip limits

The kill switch trips when:

- adjusted daily loss is **greater than or equal to** either daily-loss limit;
- realized trading loss is **greater than or equal to** its limit;
- intraday drawdown is **greater than or equal to** either drawdown limit;
- gross exposure is **greater than** the gross-exposure cap;
- any single position is **greater than** the position cap;
- open-position count is **greater than** the maximum;
- capital shortfall is positive;
- total net worth is zero or negative.

Loss/drawdown limits trigger at the limit because no additional downside budget remains.

### Capacity blocks without a kill-switch trip

New risk is blocked, but the kill switch does not newly trip, when:

- gross exposure equals the cap;
- a position equals the single-position cap;
- open-position count equals the cap.

This distinguishes “at capacity” from “already beyond the safety limit”.

## 11. Data hold

Incomplete risk measurement must not be mistaken for a healthy portfolio.

A `DATA_HOLD` blocks new risk when:

- there is at least one open position and financial market-data coverage is not `complete`;
- an open position has `marketValueChf === null`;
- an open position has price status `stale` or `not_connected`;
- `capital.dataStatus.unpricedPositions` or `stalePositions` is non-empty.

A data hold by itself does not newly latch the kill switch.

If the kill switch was already tripped, data recovery does not reset it.

## 12. Safety decision states

```
NORMAL
DATA_HOLD
CAPACITY_BLOCK
TRIPPED
```

Priority:

```
TRIPPED > DATA_HOLD > CAPACITY_BLOCK > NORMAL
```

Output includes all reasons even when a higher-priority state wins.

## 13. New-risk vs risk-reduction semantics

Decision output includes:

- `canIncreaseRisk`
- `canReduceRisk`
- `liveOrderAllowed: false`
- `physicalPurchaseAllowed: false`

V1 invariant:

- `canIncreaseRisk === true` only in `NORMAL`;
- `canReduceRisk === true` in every valid state.

This expresses the future safety intent that a kill switch blocks risk-increasing activity without trapping the portfolio in risk.

It does not itself execute a reduction.

## 14. Latching kill switch

Input:

```ts
interface KillSwitchState {
  version: 'portfolio-kill-switch:v1';
  status: 'ARMED' | 'TRIPPED';
  tripId: string | null;
  trippedAt: string | null;
  reasons: readonly string[];
  triggeringDecisionFingerprint: string | null;
}
```

Rules:

- `ARMED` + hard breach -> `TRIPPED`;
- `TRIPPED` stays `TRIPPED`, even if current metrics recover;
- O15 has no automatic reset;
- O15 V1 exposes no “clear” or “arm” mutation API;
- a human-approved reset workflow is a later, separately audited milestone.

A previously tripped switch is therefore monotonic inside O15.

## 15. Deterministic trip identity

A new trip id is derived deterministically from:

- safety-engine version;
- decision `asOf`;
- portfolio fingerprint;
- risk-day summary fingerprint;
- policy fingerprint;
- sorted hard-breach reasons.

No randomness and no wall clock.

## 16. Portfolio input consistency

O15 validates at least:

- `portfolio.capital.timestamp === day.asOf`;
- canonical UTC timestamps;
- `day.dayStartedAt <= day.asOf`;
- `day.startNetWorthChf > 0`;
- `day.peakAdjustedNetWorthChf > 0`;
- day peak consistency;
- all Rappen values are bigint;
- all open-position market values are non-negative when present;
- duplicate `brokerId + instrumentId` position identities are refused;
- data-status lists contain no duplicates.

## 17. Daily-summary identity

`sourceLedgerHeadHash` and `sourceFingerprint` are validated as lowercase 64-character hashes.

O15 binds them into the safety decision identity.

V1 verifies structural consistency, not cryptographic provenance of the ledger summary.

An append-only/sealed producer remains the authoritative source.

## 18. Metrics

Decision reports at least:

- adjustedCurrentNetWorthChf;
- adjustedDailyPnlChf;
- adjustedDailyLossChf;
- adjustedDailyLossBp;
- realizedTradingPnlTodayChf;
- realizedTradingLossChf;
- intradayDrawdownChf;
- intradayDrawdownBp;
- grossExposureChf or null under data hold;
- grossExposureBp or null;
- maximumPositionExposureBp or null;
- openPositionCount.

No hidden approximations.

## 19. Exact arithmetic

Money uses bigint Rappen.

Ratio calculations use the repository’s deterministic basis-point arithmetic.

No JS floating-point CHF calculations.

No NaN/Infinity metric is allowed.

## 20. Decision identity

Output:

```ts
interface PortfolioSafetyDecision {
  decisionId: string;
  engineVersion: 'portfolio-safety-envelope:v1';
  inputFingerprint: string;
  asOf: string;
  state: 'NORMAL' | 'DATA_HOLD' | 'CAPACITY_BLOCK' | 'TRIPPED';
  ...
}
```

Identity binds:

- portfolio source state;
- risk-day summary;
- previous kill-switch state;
- policy;
- derived metrics;
- breach/capacity/data-hold reasons.

Input order of set-like reason/status lists must not change identity.

Position identity order must be canonicalized.

## 21. Verification

Expose:

```ts
verifyPortfolioSafetyDecision(request, decision)
```

The verifier recomputes the decision from the source request.

It does not trust stored metrics, state, reason lists, fingerprints or trip id.

## 22. Alert/audit hand-off

O15 may return deterministic alert descriptors such as:

- `DAILY_LOSS_LIMIT`
- `REALIZED_LOSS_LIMIT`
- `INTRADAY_DRAWDOWN_LIMIT`
- `GROSS_EXPOSURE_LIMIT`
- `POSITION_EXPOSURE_LIMIT`
- `OPEN_POSITION_LIMIT`
- `CAPITAL_SHORTFALL`
- `PRICING_DATA_HOLD`
- `KILL_SWITCH_LATCHED`

It does not send alerts or write audit events.

O16 may connect these descriptors to append-only audit/alert delivery.

## 23. RED test matrix

Before implementation, tests should prove at least:

1. same inputs -> same safety decision
2. valid zero-loss portfolio -> NORMAL
3. deposit does not look like profit
4. withdrawal does not look like trading loss
5. adjusted daily loss exactly at CHF limit -> TRIPPED
6. one Rappen below loss limit -> not loss-tripped
7. adjusted daily loss exactly at bp limit -> TRIPPED
8. realized trading loss exactly at limit -> TRIPPED
9. drawdown exactly at CHF limit -> TRIPPED
10. drawdown exactly at bp limit -> TRIPPED
11. gross exposure below cap -> allowed
12. gross exposure exactly at cap -> CAPACITY_BLOCK
13. gross exposure above cap -> TRIPPED
14. single position exactly at cap -> CAPACITY_BLOCK
15. single position above cap -> TRIPPED
16. position count exactly at cap -> CAPACITY_BLOCK
17. position count above cap -> TRIPPED
18. incomplete financial pricing -> DATA_HOLD
19. stale position -> DATA_HOLD
20. unpriced position -> DATA_HOLD
21. data hold alone does not newly trip kill switch
22. capital shortfall -> TRIPPED
23. zero/negative net worth -> TRIPPED
24. previously TRIPPED remains TRIPPED after recovery
25. previously TRIPPED retains original trip identity
26. no automatic reset API exists
27. risk reduction remains permitted under TRIPPED
28. liveOrderAllowed always false
29. physicalPurchaseAllowed always false
30. inconsistent day peak fails closed
31. timestamp mismatch fails closed
32. malformed hashes fail closed
33. duplicate position identity fails closed
34. invalid bigint/runtime money payload fails closed
35. invalid bp policy fails closed
36. input position order does not change identity
37. set-like data-status list order does not change identity
38. tampered metrics fail verification
39. tampered state/reasons fail verification
40. tampered trip id fails verification
41. data recovery after DATA_HOLD can return NORMAL when no other block remains
42. O14–O9 and existing capital/risk/broker tests remain green

## 24. Four-eyes review targets

Independent review should attack:

- external-flow sign convention;
- deposit/withdrawal manipulation of daily loss;
- day-peak manipulation;
- exact limit boundaries;
- missing-price fail-open paths;
- exposure denominator edge cases;
- stale quote handling;
- kill-switch auto-reset paths;
- reason-order nondeterminism;
- reissued trip ids;
- integer overflow / unsafe-number basis-point inputs;
- accidental broker or ledger side effects.

## 25. Scope restrictions

O15 does not:

- configure a real broker;
- place or preview an order;
- enable `allowLiveTrading`;
- change `LockedBroker.place`;
- remove build locks;
- reset a tripped switch;
- modify allocation policy;
- mutate the capital ledger;
- send alerts.

## 26. Safety

Live Trading remains LOCKED.

Broker Orders remain LOCKED.

Physical Purchase remains LOCKED.

O15 only adds a stricter, independently verifiable permission-reduction layer.
