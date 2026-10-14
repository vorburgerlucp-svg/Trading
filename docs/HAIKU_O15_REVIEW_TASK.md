# Haiku independent review task: O15 Portfolio Safety Envelope & Kill Switch V1

Base under review: `feature/o15-portfolio-safety-envelope-v1` at `a639abc`.
Review branch: `feature/o15-haiku-review-hardening-v1`.

PR #14 is the merge candidate. Do not merge it.

## Review scope

Review:

- `src/safety/portfolio-safety-envelope.ts`
- `test/safety/o15-portfolio-safety-envelope.test.ts`
- `docs/O15_PORTFOLIO_SAFETY_ENVELOPE_V1.md`

Read-only dependencies:

- `src/capital/capital-types.ts`
- `src/capital/portfolio.ts`
- `src/money/money.ts`
- `src/risk-engine.ts`
- `src/broker-adapter.ts`

Do not widen O15 into real broker execution, kill-switch reset, alert delivery, ledger mutation or live-trading activation.

## Purpose

Act as an independent second developer/reviewer.

O15 is a safety-only prerequisite for Phase 4. It has one-way authority:

> It may block or trip. It may never enable live trading or clear a previously tripped switch.

Assume the feature implementation may be wrong even though CI is green.

## Core invariants to attack

1. External deposits/withdrawals must not masquerade as trading P&L.
2. Daily loss thresholds trigger exactly at their declared boundary.
3. Intraday drawdown thresholds trigger exactly at their declared boundary.
4. Exposure caps distinguish at-capacity from over-limit.
5. Missing/stale pricing must fail closed as DATA_HOLD.
6. A DATA_HOLD alone must not newly latch the kill switch.
7. A previously TRIPPED switch stays TRIPPED after metrics recover.
8. O15 has no automatic reset/clear path.
9. Risk reduction remains allowed in every valid safety state.
10. Risk increase is allowed only in NORMAL.
11. `liveOrderAllowed` is always false.
12. `physicalPurchaseAllowed` is always false.
13. All money uses bigint Rappen.
14. No JS floating-point CHF arithmetic.
15. Safety-decision verification must recompute from the source request.
16. Input order that is semantically set-like must not change identity.
17. Position identity order must not change identity.
18. A hard breach must produce a deterministic trip identity.
19. Re-evaluating an already latched switch must preserve its original trip identity.
20. O15 imports/calls no broker, ledger-write, registry, champion or network mutation path.

## High-priority adversarial review

### A. External-flow manipulation

Attack the sign convention and accounting formula:

```
adjustedCurrentNetWorth = currentNetWorth - netExternalFlowsToday
adjustedDailyPnl = adjustedCurrentNetWorth - startNetWorth
```

Try:

- positive deposit;
- withdrawal;
- deposit plus trading loss;
- withdrawal plus trading gain;
- flows larger than current net worth;
- alternating equivalent flow/current-state pairs;
- negative zero is not relevant for bigint but check boundary semantics.

Check whether an attacker can hide a daily loss by changing external-flow input while keeping a structurally accepted summary.

Document what O15 can prove and what remains the responsibility of the authoritative risk-day-summary producer.

### B. Daily-loss boundaries

Attack:

- zero loss;
- one Rappen below CHF limit;
- exactly CHF limit;
- one Rappen above;
- one bp below;
- exactly bp limit;
- one bp above;
- both CHF and bp limits at once;
- configured zero CHF limit;
- very large safe bigint values.

Check conservative rounding: basis-point loss calculations should not create a fail-open fractional boundary.

### C. Drawdown manipulation

Attack:

- peak equal to start;
- peak equal to current;
- peak below start;
- peak below current adjusted net worth;
- current adjusted net worth below zero;
- exactly CHF drawdown limit;
- exactly bp limit;
- peak changes with equivalent current risk state.

The source peak is caller-provided. Identify the provenance limit explicitly.

### D. Pricing/data fail-closed

Attack every combination:

- `financialMarketData = complete` but a position has null market value;
- `financialMarketData = complete` but priceStatus stale;
- coverage partial while every current PositionView happens to have a value;
- stale/unpriced status arrays that disagree with PositionViews;
- status arrays contain unknown position ids;
- closed position is stale/unpriced;
- open position has marketValue but no lastQuote;
- open position lastQuote timestamp after portfolio asOf;
- open position quote stale according to CapitalPolicy but PositionView claims live.

Decide which inconsistencies O15 can independently prove from PortfolioSnapshot and which remain upstream trust boundaries.

Prefer fail closed when directly visible fields contradict one another.

### E. Exposure denominator edge cases

Attack:

- total net worth = 0;
- negative;
- 1 Rappen;
- gross exposure greater than net worth;
- multiple positions;
- position market value zero;
- exact cap with ceiling bp rounding;
- values whose true ratio lies just below a bp boundary;
- values whose rounded bp reaches a cap.

Check whether conservative `ceil` is appropriate and documented.

### F. Position-count semantics

Attack:

- closed positions;
- duplicate broker/instrument pairs;
- same instrument at two brokers;
- exact max open count;
- over max count;
- zero configured max count;
- malformed `isOpen` at runtime.

### G. Kill-switch latching

Attack:

- ARMED + one hard breach -> one deterministic trip.
- Same request repeated -> same trip id.
- Same breach reasons in different order -> same trip identity.
- Existing TRIPPED + no current breach -> original trip preserved.
- Existing TRIPPED + different current breach -> original trip preserved.
- Existing TRIPPED + DATA_HOLD -> still original trip.
- Attempt to supply TRIPPED without trip id.
- Attempt future `trippedAt`.
- Duplicate reasons.
- Reordered reasons.
- Re-issued trip id or triggering fingerprint.

Look for any function/API that can turn TRIPPED back to ARMED.

### H. Priority semantics

Pin:

`TRIPPED > DATA_HOLD > CAPACITY_BLOCK > NORMAL`

Try states containing multiple simultaneous conditions.

Ensure reason lists retain all relevant conditions even when state priority hides the lower-priority state.

### I. Capacity vs trip boundaries

For gross exposure, single-position exposure and open-position count:

- below cap -> no capacity block;
- exactly cap -> CAPACITY_BLOCK;
- above cap -> TRIPPED.

Check interaction when one dimension is at cap and another is over cap.

### J. Portfolio input integrity

Attack runtime malformed values:

- non-bigint capital numbers;
- negative market values;
- malformed dataStatus;
- duplicate status ids;
- malformed broker/instrument ids;
- duplicate position identity;
- invalid priceStatus;
- malformed inventory arrays if they affect hashing;
- getters/prototypes/class instances if they produce unstable hashes.

O15 should not duplicate the full Capital Engine verifier, but learner-visible contradictions are irrelevant here: focus on fields that change safety state/metrics/identity.

### K. Risk-day source identity

Attack:

- malformed hashes;
- swapped hashes;
- same day economic data with a different sourceFingerprint;
- changed economic data while sourceFingerprint is reused;
- dayId not matching timestamp date;
- dayStartedAt exactly asOf;
- dayStartedAt after asOf;
- prior-day start with current dayId.

Decide whether `dayId` must match a UTC calendar day or may represent a policy/trading day. Document the chosen rule.

### L. Decision identity

Try reordering:

- positions;
- stale/unpriced ids;
- prior kill-switch reasons.

Try changing:

- policy;
- source hashes;
- current metrics;
- data hold;
- capacity reasons;
- hard breaches.

A semantic change must change decision identity; a set-order-only change must not.

### M. Verifier/reissue attacks

Modify a returned decision and reissue superficial ids/hashes:

- metrics;
- state;
- canIncreaseRisk;
- canReduceRisk;
- liveOrderAllowed;
- reasons;
- alerts;
- kill-switch state;
- trip id;
- source fingerprints.

`verifyPortfolioSafetyDecision` should recompute and reject.

### N. Side-effect and build-lock boundary

Verify O15 does not import or call:

- BrokerAdapter;
- CapitalEngine write methods;
- CapitalLedger append;
- ModelRegistry;
- ChampionBoard;
- audit writers;
- network adapters.

Verify existing `LockedBroker.place` behavior remains unchanged.

## Mutation testing

Run a focused mutation campaign if practical.

Prioritize:

- `>=` vs `>` on loss/drawdown;
- `>` vs `>=` on exposure caps;
- external-flow subtraction sign;
- drawdown peak subtraction;
- DATA_HOLD detection;
- state priority;
- previous TRIPPED branch;
- `canIncreaseRisk`;
- verifier recomputation;
- exposure bp rounding.

Classify survivors as:

- real test gap;
- equivalent mutant;
- redundant guard.

Restore source byte-for-byte after each campaign.

## Scope restrictions

Do not change:

- O9–O14;
- Capital Engine accounting rules;
- broker adapters;
- Risk Engine live lock;
- registry/champion governance;
- alert transport;
- audit persistence;
- kill-switch reset/approval flow.

If an upstream inconsistency is found, document file/function/risk rather than widening this branch unless a tiny integration fix is strictly required to preserve O15 safety.

## Delivery

- Work only on `feature/o15-haiku-review-hardening-v1`.
- Keep commits small and reviewable.
- Do not weaken/delete existing tests.
- Run full `npm run check`.
- Push only after final full check is green.
- Do not merge PR #14.

Report:

1. commit hashes
2. files changed
3. full test count
4. mutation result
5. bugs found with severity
6. fixes made
7. guarantees already held/newly pinned
8. unresolved trust/provenance limits
9. recommendation: MERGE / MERGE NACH FIX / REJECT
