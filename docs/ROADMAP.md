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

- ✅ v0.5 Market Intelligence Foundation V1 (siehe docs/MARKET_DATA_QUANT.md):
  - Twelve Data Adapter
  - Instrument Registry mit Ticker-Historie
  - Kalender (Börse, 24/7, 24/5)
  - Datenqualität und Freshness
  - Corporate Actions mit point-in-time Split-Adjustierung
  - revisionierte, reproduzierbare Marktdaten-Persistenz
  - Quant Engine V1 (SMA, EMA, RSI, MACD, ATR, ADX, Bollinger, VWAP, Pivots, Swings, Support/Resistance, Market Structure) mit auditierbaren Quant-Runs
  - Golden-, Property- und Look-ahead-Tests

## Phase 1b — Echte Anbindung, weiterhin ohne Kapitalbewegung
- **Nächster Schritt: Market Scanner V1 + Backtest Engine V1**, beide auf derselben Quant-Mathematik (`QuantService`, `asOf` + `storedThrough`); dazu ein point-in-time Instrument-Universum (gegen Survivorship Bias)
- Danach: erster echter AI-Provider im Shadow Mode (Keys nur serverseitig, Timeouts, Kostenmessung), dann die weiteren Provider-Adapter für OpenAI, Anthropic und Gemini. Erst dann bewerten AI Council und Quant gemeinsam echte Opportunities.
- Twelve Data Produktionsschlüssel konfigurieren und Lizenzbedingungen klassifizieren; weitere Börsenkalender (z. B. SIX) aus offiziellen Quellen
- Externe, signierte Ledger-Checkpoints; DB-Rollen ohne UPDATE/DELETE-Rechte für die Anwendung
- Serverseitige API + Dashboard-Kopfzeile mit echten Ledger-Zahlen und `DATA NOT CONNECTED`
- Validierter Config-Loader für alle Policies
- Freigabe-Workflow (Approval-Objekte mit Audit)

## Phase 2 — Echte Daten + Paper
- weitere Indikatoren nach Bedarf (OBV, Stochastic, ROC, Volatilität), BOS/CHOCH, Liquidity Sweeps
- Cross-Provider-Validierung und Source Priority (Massive, Broker-Quotes)
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
