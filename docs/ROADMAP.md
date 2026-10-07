# NEXUS Roadmap

## Phase 1 — Foundation
- Gemeinsame Contracts
- AI Adapter
- Broker Adapter
- Risk Gate
- Live Safety Lock
- ✅ v0.2 Capital Engine: exakte Geldarithmetik, unveränderlicher Capital Ledger (doppelte Buchführung, Hash-Kette), Capital State, Physical Inventory, Opportunity-Schema, Capital Allocator, Reallocation-Vorschläge, Capital Risk Gate (siehe docs/CAPITAL_ENGINE.md)

## Phase 1b — Capital Engine produktiv nutzbar
- Persistenter LedgerStore (append-only DB) + Integritätsprüfung beim Start
- Serverseitige Capital-API (manuelle Erfassung, CapitalState-DTO)
- Dashboard-Kopfzeile: Net Worth, Available, Invested, Reserve, Financial Markets, Physical Inventory, P&L
- Validierter Config-Loader für Capital-/Allocation-/Reallocation-Policy
- Freigabe-Workflow für Vorschläge (Approval-Objekte mit Audit)

## Phase 2 — Echte Daten + Paper
- Instrument Registry
- OHLCV/Quotes
- EMA, SMA, RSI, MACD, ATR, ADX, VWAP, Bollinger
- Pivot Points, Support/Resistance, Market Structure
- OpenAI + Claude Structured Analysis
- eToro Demo + IBKR What-If/Paper
- IBKR read-only Sync (Positionen, Cash, Fills) in den Ledger + Reconciliation
- Mehrwährungs-Ledger (USD-Cash bei IBKR, FX-Gewinne/-Verluste)
- Trade Journal

## Phase 3 — Scanner + Backtesting
- Multi-Market Scanner
- Chart-/Candlestick-Muster
- Gebühren/Slippage
- Walk-forward + Out-of-sample
- Confidence Calibration (Opportunity Score → kalibrierte Wahrscheinlichkeit)

## Phase 4 — Kleines Echtgeld
- kleinste Positionsgrössen
- Portfolio-/Daily-Loss-Limits
- Kill Switch
- Alerting + Audit

## Phase 5 — Opportunity Engine (Ausbau)
- Fundamentals / Earnings / SEC / IPO
- Makro-Regime
- Krypto-Risk/Flows
- Marktdaten für physischen Handel (beobachtete Wiederverkaufspreise), Reselling / Dropshipping / Onlineshop
- Korrelation im Capital Allocator, Learning Engine kalibriert Score-Gewichte
