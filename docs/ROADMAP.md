# NEXUS Roadmap

## Phase 1 — Foundation
- Gemeinsame Contracts
- AI Adapter
- Broker Adapter
- Risk Gate
- Live Safety Lock
- ✅ v0.2 Capital Engine: exakte Geldarithmetik, unveränderlicher Capital Ledger (doppelte Buchführung, Hash-Kette), Capital State, Physical Inventory, Opportunity-Schema, Capital Allocator, Reallocation-Vorschläge, Capital Risk Gate (siehe docs/CAPITAL_ENGINE.md)
- ✅ v0.3 NEXUS Brain (mit Test-Doubles): Planner/DecisionDepth, AI Router, AI Council, Task Manager, Shared Blackboard, Evidence/Provenance, Critic, Consensus, Memory, Outcome Evaluator, Model Registry, Champion/Challenger, Security-Grenzen, Audit Trail, Build Locks (siehe docs/NEXUS_BRAIN.md)

- ✅ v0.4 Persistenz: PostgreSQL ist die Source of Truth für Ledger, Idempotenz, Audit Events, Decision Records, Evidence, Registry, Performance, Memory und Snapshots. Dazu Migrationen, Integritätsprüfung beim Start (fail closed), Reconciliation sowie Contract-, Integrations- und adversariale Tests gegen echtes PostgreSQL (siehe docs/PERSISTENCE.md)

## Phase 1b — Echte Anbindung, weiterhin ohne Kapitalbewegung
- **Nächster Schritt: Real Market Data + Quant Engine V1**: Instrument Registry, OHLCV/Quotes als Evidence mit Provenance, Datenfrische, point-in-time und backtest-fähig; SMA, EMA, RSI, MACD, ATR, ADX, Bollinger, VWAP, Pivot Points, Support/Resistance, Market Structure
- Danach: erster echter AI-Provider im Shadow Mode (Keys nur serverseitig, Timeouts, Kostenmessung), dann die weiteren Provider-Adapter für OpenAI, Anthropic und Gemini
- Externe, signierte Ledger-Checkpoints; DB-Rollen ohne UPDATE/DELETE-Rechte für die Anwendung
- Serverseitige API + Dashboard-Kopfzeile mit echten Ledger-Zahlen und `DATA NOT CONNECTED`
- Validierter Config-Loader für alle Policies
- Freigabe-Workflow (Approval-Objekte mit Audit)

## Phase 2 — Echte Daten + Paper
- Instrument Registry
- OHLCV/Quotes (als Evidence mit Provenance)
- Quant Engine: EMA, SMA, RSI, MACD, ATR, ADX, VWAP, Bollinger, OBV, Stochastic, ROC, Volatilität
- Pivot Points, Fibonacci, Support/Resistance, Market Structure, Swing High/Low
- eToro Demo + IBKR What-If/Paper
- IBKR read-only Sync (Positionen, Cash, Fills) in den Ledger + Reconciliation
- Mehrwährungs-Ledger auf Basis `Money { currency, minor }` (USD-Cash bei IBKR, FX-Gewinne/-Verluste)
- Trade Journal

## Phase 3 — Scanner, Backtesting, Lernen
- Multi-Market Scanner
- Chart-/Candlestick-Muster
- Gebühren/Slippage
- Historical Replay (point-in-time) + Walk-forward + Out-of-sample
- Model-Benchmarking auf historischen Fällen (Shadow → Aktivierung)
- Confidence Calibration (Score → kalibrierte Wahrscheinlichkeit)
- Trading Tutor, Pattern Quiz, Post-Trade Review

## Phase 4 — Kleines Echtgeld
- kleinste Positionsgrössen
- Portfolio-/Daily-Loss-Limits
- Kill Switch
- Alerting + Audit
- Aufheben der Build Locks nur per Code-Review und menschlichem Entscheid

## Phase 5 — Opportunity Engine (Ausbau)
- Fundamentals / Earnings / SEC / IPO
- Makro-Regime
- Krypto-Risk/Flows
- Marktdaten für physischen Handel (beobachtete Wiederverkaufspreise), Reselling / Dropshipping / Onlineshop
- Korrelation im Capital Allocator, Learning Engine kalibriert Score-Gewichte
