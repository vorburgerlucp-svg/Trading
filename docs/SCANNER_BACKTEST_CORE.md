# Scanner / Backtest Core – OpenAI continuation

Branch: `feature/scanner-backtest-core-openai`

This branch intentionally starts from the last fully-pushed market-data/quant commit and does **not** try to reproduce Claude's unpushed local work.

## Added now

- point-in-time bar event queue ordered by `availableAt`
- point-in-time state that refuses future queries
- deterministic warm-up policy
- point-in-time instrument universe membership
- deterministic scanner filters/ranking over audited `QuantResult`
- deterministic spread/slippage/commission cost model
- conservative long-only stop/take-profit OHLC execution rules

## Safety invariants

1. Data is visible only when `availableAt <= T`.
2. A final-bar decision cannot execute on the same bar.
3. A gap through a stop fills at the gap/open price, not the stop.
4. If stop and take-profit are both hit in the same OHLC bar, default handling is adverse/conservative.
5. Scanner ranking scores are relative scores, never probabilities.
6. Market data marked unusable for trading cannot become a candidate.

## Not claimed complete

This is a conflict-minimizing core, not Scanner + Backtest V1 completion. Still needed:

- portfolio/event-loop backtest engine
- sizing and cash accounting
- scanner/backtest PostgreSQL persistence
- corporate-action position handling
- historical universe persistence and delisting lifecycle
- benchmark + full integration tests
- linkage into NEXUS DecisionRecord

Tomorrow's model can compare/cherry-pick this branch against Claude's local scanner/backtest implementation.
