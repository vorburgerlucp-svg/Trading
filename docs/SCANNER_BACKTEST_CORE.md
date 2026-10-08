# Scanner / Backtest Core – OpenAI continuation

Branch: `feature/scanner-backtest-core-openai`

Base: `feature/market-data-quant-v1` at `3abae8c`.

This branch was created from the last fully-pushed Market Data + Quant V1 state because Claude's larger Scanner + Backtest work existed only in its local session when usage ran out. The purpose is to preserve the critical invariants and provide a tested, reviewable core that can be compared with or cherry-picked into the larger implementation later.

## Verified state

GitHub Actions runs the repository's strict TypeScript check plus the complete unit and PostgreSQL test suite on Node 22.

Latest verified result at this handoff:

- Typecheck: PASS
- Test files: 36/36 PASS
- Tests: 386/386 PASS
- PostgreSQL integration: real PostgreSQL 17.10
- Live trading: still locked
- Physical purchases: still locked
- AI providers: not connected

## Implemented

### Point-in-time market state

- bar events ordered by `availableAt`, not by bar start/end
- an instrument is invisible until its data is actually available
- future point-in-time reads fail closed
- V1 rejects per-instrument availability inversion rather than retroactively trading a delayed old bar

### Warm-up

- deterministic `warmup:v1`
- hard requirement is the longest indicator requirement
- a deterministic preferred history is recorded for recursive indicators

### Point-in-time universe

- `validFrom`, `validTo`, and `availableAt`
- delisted/removed members remain visible historically when they belonged to the universe
- snapshot fingerprint and explicit `pointInTimeSafe` flag

### Scanner core

Deterministic filters/ranking over audited `QuantResult`:

- minimum price
- minimum average volume
- RSI range
- price above EMA
- EMA alignment
- ADX minimum
- ATR percent range
- market structure

Scanner rules:

- final-only Quant data
- market data must be usable for trading
- rejected inputs affect the run fingerprint
- universe point-in-time safety is retained in the run
- ranking score is a relative score, never a probability

### Execution and costs

- final-close decisions cannot execute on the same bar
- next-bar market entry semantics
- gap through stop fills at the gap/open price
- gap through take-profit fills at the open
- same OHLC bar hitting stop and target defaults to the adverse stop
- optional `mark_ambiguous` policy refuses to invent intrabar ordering
- deterministic spread, slippage, commission and minimum commission
- affordability calculation includes fees

### Single-instrument Backtest Engine V1 core

Event order for each final bar when it becomes available:

1. execute an eligible order created from an earlier final bar at the new bar's open
2. process existing protective stop/take-profit orders
3. mark portfolio equity at the now-known close
4. evaluate strategy using only history available at that event time
5. create a new order for a later bar; never fill it retroactively

Tracks:

- cash
- open long position
- fills
- completed trades
- commissions
- equity curve
- realized trade P&L
- return
- max drawdown
- wins/losses
- win rate
- average winner/loser
- profit factor
- expectancy
- exposure

Sizing:

- fixed cash
- percent of equity
- risk per trade with a cash cap

### Backtest quality

Quality is methodology, not performance.

A profitable run can still be C or INVALID.

Factors currently include:

- point-in-time-safe universe
- data completeness
- corporate-action modeling declaration
- production/non-production provider
- zero-cost assumptions
- unresolved intrabar ambiguity
- minimum sample size

Small samples are explicitly labeled `INSUFFICIENT_SAMPLE`.

## Regression tests added

Among other cases:

- cross-instrument availability delay
- ordering by availability rather than bar start
- future state read rejected
- final-bar decision fills only next bar
- stop gap fills at open
- same-bar SL + TP uses conservative adverse path
- optional ambiguous intrabar policy
- realistic costs can turn a small gross winner into a loss
- historical universe membership / removal
- stale/non-tradable Quant data rejected
- scanner rejection changes run fingerprint
- deterministic warm-up
- backtest quality does not depend on headline return

## Important limitations / next work

This branch is deliberately a core, not the final Scanner + Backtest V1.

Still needed:

1. PostgreSQL persistence for universe/scanner/backtest runs, candidates, orders, fills and metrics.
2. Multi-instrument portfolio/world event loop.
3. Corporate-action application to open positions (splits/dividends/mergers).
4. Historical point-in-time universe ingestion from real sources.
5. Full warm-up integration with QuantService instead of only the policy.
6. Scanner historical replay service.
7. Benchmark for 100 / 1,000 scanner instruments and multi-instrument backtests.
8. Link scanner/backtest run IDs into NEXUS DecisionRecord / QuantAssessment.
9. Buy-and-hold benchmark.
10. More complete fill lifecycle (partial fills, limit expiry, trading halts).
11. SIX and additional exchange calendars.
12. Provider/bid-ask execution data when available.

## Tomorrow's Haiku workflow

Do not start from scratch.

1. Fetch this branch and run `npm run check`.
2. Confirm 386/386 or higher are green.
3. If Claude's local `feature/scanner-backtest-v1` still exists, compare its implementation against this branch rather than blindly choosing one.
4. Preserve the point-in-time, next-bar, conservative intrabar and quality invariants from this branch.
5. Prefer the more complete implementation only after its regression tests prove the same invariants.
6. Continue with persistence + multi-instrument event loop.
7. Do not connect real AI providers or live broker execution until Scanner + Backtest V1 is fully auditable.

No code on this branch should be treated as live-trading authorization.
