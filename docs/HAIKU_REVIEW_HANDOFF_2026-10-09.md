# Haiku 5.5 Review Handoff — 2026-10-09

## Mission

You are the independent second reviewer for NEXUS.

Do **not** begin by adding features.

Your first job is to try to falsify the current Scanner + Backtest Core and the review performed on 2026-10-08.

Treat this as a professional trading-infrastructure review, not as a normal code-completion task.

## Repository state to review

Repository: `vorburgerlucp-svg/Trading`

Branch:
`feature/scanner-backtest-core-openai`

Current branch head after adding this handoff document:
`87959d33fcd956104481c41cf6a0eaefe2bbd399`

Code-review baseline before this documentation-only handoff commit:
`a81f35ef4583e05437a8dec81bdc3d24d7191295`

Draft PR:
`#2 Scanner + Backtest core: point-in-time safety and deterministic execution`

Primary review document:
`docs/REVIEW_2026-10-08.md`

Scanner/Backtest handoff:
`docs/SCANNER_BACKTEST_CORE.md`

## Verified starting state

At the end of the 2026-10-08 review:

- TypeScript typecheck: PASS
- Test files: 37/37 PASS
- Tests: 402/402 PASS
- PostgreSQL integration: real PostgreSQL 17.10
- Live trading: LOCKED
- Physical purchase execution: LOCKED
- OpenAI adapter: NOT CONNECTED
- Claude adapter: NOT CONNECTED
- Gemini adapter: NOT CONNECTED

Do not trust this blindly. Reproduce it yourself.

## Required first steps

1. Fresh checkout of `feature/scanner-backtest-core-openai`.
2. Verify HEAD is `87959d33fcd956104481c41cf6a0eaefe2bbd399` or a documented descendant. If it differs, report the exact commits before continuing.
3. Run:
   - `npm ci`
   - `npm run check`
4. Confirm the PostgreSQL integration tests actually ran and were not skipped.
5. Read:
   - `docs/REVIEW_2026-10-08.md`
   - `docs/SCANNER_BACKTEST_CORE.md`
   - relevant Scanner / Backtest / Quant / Persistence / NEXUS Brain source files.

If any baseline check fails, stop feature work and diagnose the failure first.

## Review posture

Assume the previous reviewer may have missed something.

Your goal is to find:

- look-ahead bias
- survivorship bias
- stale-data reuse
- impossible fills
- impossible timestamps
- silent data mixing
- unverifiable assumptions
- incorrect P&L
- incorrect sizing
- incorrect drawdown/equity
- false quality grades
- broken audit linkage
- weak idempotency
- persistence integrity holes
- race/concurrency problems
- integer/decimal precision errors
- missing transaction costs
- hidden optimistic assumptions
- anything that can create a falsely profitable backtest

Do not optimize for finding “something different”.
Optimize for correctness.

## Mandatory adversarial review of fixed findings

Try to break each of these previous fixes independently.

### R1 — Retroactive next-bar fill

Construct delayed-data cases where:
- a bar becomes available after the next bar opened,
- multiple future bars have already opened,
- the first executable bar is much later,
- availability sits exactly on a candidate open timestamp.

Prove NEXUS never fills before the strategy could have known the signal.

### R2 — Reused stale QuantResult

Try to reuse a QuantResult:
- one minute later,
- one session later,
- after a weekend,
- after a market holiday,
- after a source/freshness status change.

Confirm the scanner cannot inherit an old `usableForTrading=true` verdict incorrectly.

### R3 — Partial universe

Test:
- 0/100 snapshots
- 1/100
- 99/100
- duplicate + missing instruments
- extra snapshots for instruments outside the universe
- changing historical membership

Confirm incomplete coverage can never masquerade as a complete market-wide ranking.

### R4 — Duplicate snapshots

Try same instrument with:
- identical duplicates
- conflicting QuantResult
- conflicting lastPrice
- different availability timestamps

Confirm duplicate coverage fails closed.

### R5 — Market-value availability

Test future `lastPriceAvailableAt`, missing `averageVolumeAvailableAt`, and values whose source data become available after scanner asOf.

### R6 — Interval mismatch

Test:
- 1d scanner + 5m quant
- 5m scanner + 1d quant
- same interval but different session
- same interval but different adjustment/source

Decide whether session/adjustment/source also need scanner-level enforcement.

### R7 — False corporate-action claim

Confirm Backtest Engine cannot report corporate actions as modeled until open-position handling exists.

Then inspect whether adjusted bars could still create a hidden workaround.

### R8 — Mixed backtest series

Try mixing:
- source
- interval
- session
- adjustment
- duplicate timestamps
- conflicting OHLC at same timestamp

Confirm the engine fails closed.

### R9 — Strategy fingerprint

Try:
- same id/version, different parameters
- same parameters, different object key order
- semantically same config with different insertion order
- nested config changes
- definition tampering after persistence
- implementation code change without version bump

Confirm what is and is not protected.

## Open HIGH risks that must be reviewed

### O1 — Referential audit validation in NEXUS Brain

Current Brain validates scanner/backtest ID syntax and includes IDs in QuantAssessment / Decision fingerprint.

It does not yet prove that referenced runs:
- exist,
- match the decision instrument,
- are available at decision asOf,
- have sufficient quality,
- have compatible scanner/backtest/quant lineage.

Review the cleanest architecture for read-only referential validation.

Do not let the Brain write to those stores.

### O2 — Corporate actions on open positions

Review what is needed for:
- stock splits
- reverse splits
- cash dividends
- symbol changes
- later mergers/spinoffs if relevant

Position quantity, entry basis, stops/TPs, cash, P&L and audit must remain coherent.

### O3 — Warm-up enforcement

Warm-up policy exists but Backtest Engine does not yet make warm-up a hard execution gate.

Find the correct point-in-time invariant:
no strategy order can be created until the required feature set is ready.

### O4 — Real point-in-time universe

Review survivorship-bias exposure.
A point-in-time-capable in-memory universe is not enough without trustworthy historical membership data.

### O5 — Risk-per-trade sizing

Current stop-distance sizing must be reviewed for:
- entry spread
- entry slippage
- entry commission
- stop-side spread
- stop-side slippage
- exit commission
- gap-through-stop risk

A stop price is not a guaranteed maximum loss.

### O6 — Intrabar time precision

OHLC often proves only “touched sometime within this bar”.

Review whether fills should carry:
- exact timestamp,
- bar/window timestamp,
- precision metadata,
- or an execution-time uncertainty field.

### O7 — Equity valuation policy

Review whether open positions should be marked at:
- close/mid,
- bid,
- estimated liquidation value after spread/slippage/commission.

The choice must be explicit, versioned and consistent with risk metrics.

### O8 — BacktestQuality trust boundary

Current quality context still includes caller-supplied assertions.

Review how to derive these from verified stores/results instead:
- dataComplete
- providerProduction
- pointInTimeUniverse
- corporateActions

### O9 — Strategy implementation identity

Declarative parameter fingerprinting now exists.

Review whether production quality also needs:
- build hash
- implementation artifact hash
- git commit hash
- strategy code checksum

Do not assume a manual version bump is sufficient forever.

### O10 — Multi-instrument event loop

Do not build it until review is complete.

When it is built later it must be event-ordered by availability across instruments/calendars.
No instrument may see information that was unavailable at that global decision time.

### O11 — Execution lifecycle

Review missing realism:
- partial fills
- limit orders
- expiry
- market halts
- borrow availability
- margin
- shorting
- bid/ask data

## Additional checks not yet fully reviewed

Inspect these specifically:

1. Are intrabar stop/TP fills recorded with misleading timestamps?
2. Can mark-to-market equity overstate liquidation value?
3. Can two different entry fills ever be confused when closing a position?
4. Can a position remain open at the end of a backtest and distort metrics?
5. Is profit factor behavior correct with no losing trades?
6. Is exposure measured in the intended unit (event points vs elapsed time)?
7. Are strategy decisions deterministic for identical inputs?
8. Can canonical JSON fail or differ on any supported strategy definition type?
9. Can persisted normalized rows disagree with the lossless JSON payload without detection?
10. Can a privileged DB writer alter normalized scanner candidates/fills/trades while leaving the JSON hash valid?
11. Are all scanner ranking inputs included in the scanner fingerprint?
12. Does ScannerCoverage count outside-universe snapshots correctly and intentionally?
13. Can a QuantResult with correct asOf but stale underlying latest bar still be accepted due to previously computed DataQuality?
14. Are timezone/DST boundaries still safe with delayed data?
15. Are non-production/demo data paths impossible to treat as production trading evidence?

## Modification rules

During review:

- Prefer a failing regression test before changing logic.
- Never loosen an invariant just to make a test pass.
- Never introduce fake market data into the product path.
- Never enable live trading.
- Never enable automatic physical purchases.
- Do not connect real AI providers yet.
- Do not weaken PostgreSQL integrity controls.
- Do not change risk limits automatically.
- Do not merge the PR.

If you disagree with an existing architectural decision, explain why before changing it.

## If you find a bug

For every material bug:

1. State severity: CRITICAL / HIGH / MEDIUM / LOW.
2. Explain the false assumption.
3. Write a regression test that fails on the current behavior.
4. Apply the smallest correct fix.
5. Run targeted tests.
6. Run full `npm run check`.
7. Confirm PostgreSQL integration tests actually ran.
8. Document the finding.

## Only after review passes

Preferred implementation order:

1. O1 — Referential Scanner/Backtest validation in NEXUS Brain.
2. O3 — Warm-up hard execution gate.
3. O2 — Corporate actions on open positions.
4. O4 — Real point-in-time universe ingestion.
5. Multi-instrument availability-ordered event loop.
6. O5 — Execution-aware risk sizing.
7. Intrabar time-precision policy.
8. Equity valuation policy.
9. Richer execution lifecycle.

Do not jump directly to AI-provider integration.

## Required final report

Return exactly this operational summary structure:

```text
HEAD reviewed:
Baseline typecheck:
Baseline tests:
PostgreSQL integration actually ran: YES / NO

Independent review:
Critical findings:
High findings:
Medium findings:
Low findings:

Previous R1-R9:
R1: CONFIRMED / BROKEN / MODIFIED
R2: ...
...
R9: ...

Open O1-O11:
O1: assessment
...
O11: assessment

Changes made:
Commits:
Tests added:
Final typecheck:
Final tests:
PostgreSQL final:
Live Trading: LOCKED
Physical Purchase: LOCKED

Disagreements with previous review:
Remaining blockers before live trading:
Recommended next implementation block:
```

If there are no disagreements, explicitly say so.

## Quality bar

The goal is not “many tests”.

The goal is:
- no hidden look-ahead,
- no silent optimism,
- reproducible decisions,
- point-in-time correctness,
- auditability,
- deterministic financial arithmetic,
- fail-closed behavior,
- and clear separation between evidence, model opinion, risk and execution.

A profitable backtest is irrelevant if any of those are violated.
