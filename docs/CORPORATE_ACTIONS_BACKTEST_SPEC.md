# NEXUS O2 — Corporate Actions on Open Positions

Prepared for implementation after the next model-usage reset.

> **Section 0 (terminology update, 2026-10-09).** This spec predates the knowledge and provenance model. Where it says `availableAt` for a corporate action, read the knowledge time `knowledge.knowledgeAt` (proven, or none) and the capture time `retrievedAt`. The authoritative distinction is: `exDate` is the economic effective date; `knowledge.knowledgeAt` is when NEXUS knew the record; `retrievedAt` is the capture; the replay purpose is `economic` or `information`. Reason codes carry the `CORPORATE_ACTION_` prefix where applicable (for example `CORPORATE_ACTION_DOUBLE_ADJUSTMENT_RISK`, not `DOUBLE_ADJUSTMENT_RISK`). The effective instant is the regular session open of the ex-date in the instrument's calendar, never a UTC string slice. Where this spec and `docs/BACKTEST_CORPORATE_ACTIONS_O2.md` differ, the O2 document is the implementation decision and it is the one that was built. Implementation status and the decisions taken: `docs/BACKTEST_CORPORATE_ACTIONS_O2.md`.

Base for design review:
`feature/backtest-warmup-enforcement`
commit `50f5800464ded59d3dbb02eca5410d5626d4881c`

## Objective

Backtest Engine V2 currently refuses:

`corporateActions: modeled`

That is correct.

O2 may remove that refusal only after splits, reverse splits, cash dividends and symbol changes are applied to open positions in a point-in-time-safe, auditable and economically coherent way.

This is financial accounting logic. Fail closed on ambiguity.

---

## Existing capabilities

Market Data already provides:

- `CorporateAction`
- types:
  - split
  - reverse_split
  - cash_dividend
  - symbol_change
- immutable instrumentId
- exDate
- availableAt
- retrievedAt
- exact Decimal ratios / cash amounts
- point-in-time split-adjusted derived bars
- RAW bars remain canonical

Backtest Engine currently:

- is single-instrument
- uses exact Decimal
- only accepts one uniform series
- enforces next-bar fills
- enforces warm-up
- models cash / open position / stops / take-profit
- rejects claiming corporate actions are modeled

---

# 1. Critical structural issue discovered before implementation

Current `closePosition()` finds the entry fill by matching:

- entryTime
- quantity

A split changes the open-position quantity.

Example:

```text
Entry:
10 shares @ 100

4-for-1 split:
40 shares @ 25
```

The original entry fill still says 10 shares.

A later exit fill says 40 shares.

Therefore matching the entry fill using current position quantity becomes invalid.

## Required refactor

`BacktestPosition` should carry an explicit immutable reference:

```ts
entryFillId: string
```

or an equivalent stable trade/lot reference.

Closing a position must resolve its originating fill by ID, never by mutable economic attributes such as quantity.

Regression test required before implementing split logic.

---

# 2. Corporate action event model

Price-market events and corporate actions are different things.

A corporate action has at least two time concepts:

1. economic effective date/time
2. information availability

For V1 the existing model provides:

- `exDate`
- `availableAt`

Do not collapse these into one timestamp.

## Point-in-time invariant

NEXUS may not use a CorporateAction record before:

```text
availableAt <= current event time
```

But it also must not retroactively rewrite an already-simulated position after discovering an action late.

If an economically effective action was not provably available in time to model correctly, fail closed / invalidate the affected backtest rather than silently repairing history.

Recommended reason:

```text
CORPORATE_ACTION_TIMING_UNPROVEN
```

No retroactive P&L repair.

---

# 3. Event ordering

For an action effective at the opening of an ex-date session:

```text
known corporate action becomes economically effective
→ adjust position / attached order levels
→ process ex-date market open / eligible fills
→ protective order processing
→ close mark-to-market
→ strategy evaluation
```

A split effective at the ex-date open must be applied before evaluating that day's raw opening price against pre-split stops/targets.

This ordering must be versioned.

Suggested:

`corporate-action-engine:v1`

---

# 4. Raw vs adjusted bars

If the backtest explicitly models corporate actions on positions:

**require RAW price bars.**

Do not apply position split adjustments while simultaneously consuming split-adjusted bars.

That would double-adjust the economics.

Fail closed on:

```text
corporateActions = modeled
AND
bar.adjustment != raw
```

Reason:

`DOUBLE_ADJUSTMENT_RISK`

---

# 5. Split

Example:

```text
1 → 4 split
position quantity: 10 → 40
entry basis/share: 100 → 25
stop: 80 → 20
takeProfit: 120 → 30
```

Total economic value remains unchanged.

## Formula

For ratio:

```text
ratioFrom → ratioTo

quantity factor = ratioTo / ratioFrom
price factor    = ratioFrom / ratioTo
```

Apply exact Decimal arithmetic.

Adjust:

- position.quantity
- position.entryPrice
- stopLoss
- takeProfit
- relevant pending-order price levels
- any per-share basis fields

Do NOT:

- generate a trade
- generate commission
- generate realized P&L
- change total basis because of the split itself

Entry commission remains the original amount.

## Required invariant

Immediately before vs immediately after split application:

```text
quantity × referencePrice
```

is value-neutral up to explicitly documented Decimal precision.

---

# 6. Reverse split

Same accounting using inverse ratio.

Example:

```text
10 → 1 reverse split

100 shares @ 5
→
10 shares @ 50
```

Stops / TP / basis adjust in the same direction as price.

## Fractional shares

This is a real-world complexity.

A reverse split can create fractional entitlements.

Current Backtest Engine has no broker-specific cash-in-lieu policy.

V1 options:

A. preserve exact Decimal fractional quantity and mark execution realism limitation;
or

B. require an explicit fractional-share policy.

Professional preference:

Do not silently round.

At minimum store:

```text
fractionalTreatment = exact_fractional_simulation
```

and quality reason:

```text
FRACTIONAL_CASH_IN_LIEU_NOT_MODELED
```

if the instrument/broker would require cash settlement and metadata is available.

Do not invent a cash-in-lieu price.

---

# 7. Pending orders across a split

Critical.

Suppose a long-entry decision was made before the split and carries:

```text
stopLoss = 80
takeProfit = 120
```

The actual fill occurs after a 4:1 split.

Those attached levels must become:

```text
20
30
```

before the fill.

Otherwise the backtest can instantly trigger impossible protective exits.

Existing `PendingOrder` contains:

- side
- decisionBar
- stopLoss
- takeProfit

So split handling must also adjust these attached price levels.

Market-order quantity is calculated at the later opening price and therefore does not need a precomputed quantity adjustment in the current V2 design.

---

# 8. Cash dividends

Current CorporateAction provides:

- cashAmount
- currency
- exDate

It does NOT currently provide a payment date.

This matters.

A shareholder becomes entitled around the ex-date/record-date mechanics, but spendable cash is normally paid later.

Crediting spendable cash on ex-date can create false buying power.

## Highest-quality design

Separate:

```text
Dividend entitlement
from
Dividend cash settlement
```

Proposed domain concepts:

```ts
interface DividendReceivable {
  actionKey: string;
  instrumentId: string;
  entitledQuantity: Decimal;
  amountPerShare: Decimal;
  currency: string;
  totalAmount: Decimal;
  exDate: string;
  paymentDate?: string;
  settledAt?: string;
}
```

Extend CorporateAction in a future additive-compatible way with optional:

```text
paymentDate
```

or an explicit payable/settlement timestamp.

## Until payment timing is known

Do NOT make the dividend spendable cash.

Possible treatment:

- receivable contributes to equity if economically justified
- cash remains unchanged
- quality records that settlement timing is unavailable

If no defensible policy can be proven from existing data, the run cannot claim complete dividend modeling.

---

# 9. Dividend entitlement

Entitlement must depend on the position held through the required economic boundary.

Do not simply inspect whether a position exists at arbitrary `availableAt`.

The exact V1 rule must be documented and tested around the ex-date boundary.

No future action record may create a retroactive entitlement.

---

# 10. Dividend currency

Backtest is effectively single-currency today.

If:

```text
corporateAction.currency != portfolio currency
```

and there is no point-in-time FX conversion:

fail closed.

Do not assume 1:1 FX.

Reason:

`CORPORATE_ACTION_FX_NOT_MODELED`

---

# 11. Symbol change

Instrument identity is permanent:

```text
instrumentId does not change
```

Therefore a symbol change should:

- NOT close the position
- NOT reopen a position
- NOT create P&L
- NOT change quantity
- NOT change cost basis

It is an audit / mapping event only.

The backtest should continue against the same instrumentId.

Regression required.

---

# 12. Same-date multiple actions

Do not sort economically meaningful actions merely by `actionKey`.

If multiple actions on the same effective date interact and the provider does not provide ordering semantics:

fail closed or mark the run unsupported.

Example:

- split
- dividend

on the same effective date.

Do not assume whether dividend cashAmount is pre-split or post-split.

Reason:

`CORPORATE_ACTION_ORDER_AMBIGUOUS`

---

# 13. Corporate-action input identity

Corporate actions must be part of the Backtest input fingerprint.

At minimum fingerprint:

- actionKey
- instrumentId
- type
- exDate
- ratioFrom / ratioTo
- cashAmount
- currency
- symbol fields
- announcedAt
- availableAt
- retrievedAt
- any future paymentDate
- source / content identity if available

Changing action history must change:

- inputFingerprint
- backtestRunId

No silent reuse.

---

# 14. Audit result

BacktestRunResult should include a corporate-action summary.

Proposed:

```ts
interface BacktestCorporateActionResult {
  algorithmVersion: string;

  modeled: boolean;

  applied: AppliedCorporateAction[];
  pending: CorporateActionRef[];
  rejected: CorporateActionIssue[];

  dividendsReceivable: ...;
  dividendsSettled: ...;

  valueNeutralSplitChecks: ...;
}
```

Every applied action should record:

- actionKey
- type
- effective date/time
- appliedAt
- availability evidence
- before state fingerprint
- after state fingerprint
- transformation summary

Do not rely only on prose.

---

# 15. Backtest quality

Only allow:

```text
corporateActions = modeled
```

when the engine actually proves the relevant actions were modeled.

Ultimately this fact should be derived from the run, not asserted by the caller.

During O2, consider replacing or narrowing the caller-provided flag.

A run with known unsupported action must not receive A-quality evidence.

Potential reasons:

- CORPORATE_ACTION_TIMING_UNPROVEN
- CORPORATE_ACTION_ORDER_AMBIGUOUS
- DIVIDEND_PAYMENT_DATE_UNKNOWN
- CORPORATE_ACTION_FX_NOT_MODELED
- FRACTIONAL_CASH_IN_LIEU_NOT_MODELED

Do not collapse materially different limitations into one generic warning.

---

# 16. Split P&L invariant

Example:

```text
Buy 10 @ 100
commission = 5
4-for-1 split
40 @ economic basis 25
Sell 40 @ 30
commission = 5
```

Gross economic gain:

```text
40 × 30 - 10 × 100 = 200
```

Net:

```text
200 - 10 total commissions = 190
```

The split itself contributes zero P&L.

Tests must prove this.

---

# 17. Stop-gap interaction after split

Example:

```text
Pre-split stop = 80
4-for-1 split
Adjusted stop = 20

Ex-date open = 19
```

Correct:

stop gap fill at 19.

Incorrect:

stop compared against 80.

Required regression.

---

# 18. Dividend and total-return claims

Do not label ordinary raw-price backtest return as total return unless dividends are fully modeled.

Do not label split-adjusted price series as total-return-adjusted.

Existing distinction:

- raw
- split_adjusted
- total_return_adjusted

must remain strict.

---

# 19. Corporate action availability and late discovery

Adversarial case:

```text
exDate = Monday
action.availableAt = Wednesday
```

A Monday backtest event must not use information first available Wednesday.

But Wednesday must also not silently rewrite Monday's simulated economics.

Professional default:

affected historical interval is not point-in-time provable.

Return a quality failure / invalidity rather than retroactive correction.

This protects against hidden hindsight.

---

# 20. Required implementation order

After reset:

1. Refactor `BacktestPosition` to stable `entryFillId`.
2. Regression for split-safe entry/exit linkage.
3. Define corporate-action event queue / effective-time policy.
4. Require raw bars when action modeling is enabled.
5. Implement split.
6. Implement reverse split.
7. Adjust pending protective levels.
8. Add audit/result structures.
9. Add action history to fingerprint.
10. Add symbol-change no-op/audit semantics.
11. Design dividend receivable.
12. Add payment-date support before making dividend cash spendable.
13. Add quality derivation.
14. PostgreSQL roundtrip/integrity.
15. Full adversarial suite.

---

# 21. Required tests

## Structural
- position stores entryFillId
- split does not break trade linkage

## Split
- 2-for-1
- 4-for-1
- reverse 1-for-10
- value neutral
- basis neutral
- no fee
- no realized P&L at action

## Stops/targets
- stop adjusted
- TP adjusted
- pending entry attached stop/TP adjusted
- gap after split uses adjusted stop

## Timing
- action known before ex-date
- action available exactly at effective boundary
- action known after effective boundary -> fail closed
- future action not visible

## Fingerprint
- same bars, different split history -> different run ID

## Raw vs adjusted
- modeled action + split_adjusted bars -> reject

## Symbol change
- same instrumentId
- no economic change

## Dividend
- entitlement
- no spendable cash before payment date
- payment settlement
- no FX invention
- no total-return claim when incomplete

## Same-date ambiguity
- interacting actions with insufficient ordering -> fail closed

## P&L
- entry before split, exit after split gives correct net P&L

## Persistence
- action audit roundtrip
- tampered action summary detected

## No-look-ahead
Change all action records unavailable by T.
State/decisions through T remain identical.

---

# 22. Out of scope for O2

Do NOT implement yet:

- mergers
- spinoffs
- tender offers
- rights issues
- options adjustments
- tax withholding
- broker-specific cash-in-lieu execution
- multi-instrument corporate actions
- AI interpretation
- live broker reconciliation

Architect for later extension, do not fake support.

---

# 23. Safety

Remain unchanged:

```text
Live Trading = LOCKED
Physical Purchase = LOCKED
AI providers = NOT CONNECTED
```

Corporate actions are deterministic accounting events.

AI must not decide split ratios, dividend amounts or effective dates.

---

# Definition of Done

O2 is complete only when:

1. splits/reverse splits preserve economic value and cost basis,
2. attached levels are transformed consistently,
3. entry/exit lineage survives quantity changes,
4. dividends cannot create early cash,
5. late action data cannot retroactively improve history,
6. raw/adjusted data cannot double count actions,
7. every action is fingerprinted and audited,
8. unsupported ambiguity fails closed,
9. full PostgreSQL-backed check passes,
10. corporate-action modeling can finally be derived as true rather than asserted.
