# NEXUS Capital Engine

Capital & Opportunity Intelligence Platform: Trading, Investing, physischer Handel und später weitere Business-Opportunities, mit einem gemeinsamen Kapitalbild.

**Prinzip: AI proposes. Quant verifies. Risk controls. NEXUS learns and decides. Human approves critical capital movements.**

Verfassung: [docs/NEXUS_MASTER_SPEC.md](docs/NEXUS_MASTER_SPEC.md)

## Stand v0.5

- **Capital Engine (v0.2):** NEXUS kennt das gesamte Kapital (Cash, Finanzanlagen, Ware, Forderungen, Verbindlichkeiten, Reservationen), führt einen unveränderlichen Ledger und erstellt Allokations- und Umschichtungs-*Vorschläge*.
- **NEXUS Brain (v0.3):** NEXUS koordiniert KI-Modelle als Spezialisten: Planner mit Decision Depth, AI Router, AI Council, Shared Blackboard mit Evidenzregel, Critic, Consensus Engine, Memory, Outcome Evaluator, Model Registry mit Champion/Challenger. Getestet mit Test-Doubles; **echte Provider sind noch nicht verbunden**.
- **Persistenz (v0.4):** PostgreSQL ist die kanonische Datenbank für Ledger, Idempotenz, Reservierungen, Audit Events, Decision Records, Evidence, Model Registry, Performance und Memory. Die Ledger-Invarianten werden auch in der Datenbank erzwungen. Die Tests laufen gegen echtes PostgreSQL. Siehe [docs/PERSISTENCE.md](docs/PERSISTENCE.md).
- **Market Intelligence Foundation V1 (v0.5):** echte Marktdaten über den Twelve Data Adapter (Schlüssel nur serverseitig) werden zu geprüften, kanonischen und revisionierten Daten. Darauf rechnet die deterministische Quant Engine (SMA, EMA, RSI, MACD, ATR, ADX, Bollinger, VWAP, Pivots, Swings, Support/Resistance, Market Structure) und erzeugt ein auditierbares QuantResult. Alles ist point-in-time und ohne Look-ahead, mit derselben Mathematik für Live und Backtest. **Keine KI-Handelsempfehlung, keine Brokerorder.** Siehe [docs/MARKET_DATA_QUANT.md](docs/MARKET_DATA_QUANT.md).
- Live Trading, Brokerorders und physische Einkäufe sind im Build gesperrt.

### Ziel-Broker
- IBKR: bevorzugtes langfristiges Execution-Backend wegen breiter Markt-/Instrumentabdeckung und reifer API.
- eToro: zusätzlicher Adapter für Demo/Live und kleine Testgrössen.
- Krypto-Börsen: später als eigene Adapter.

### Ziel-KI
- OpenAI, Anthropic Claude, Google Gemini und weitere Modelle über dieselbe Schnittstelle, ohne feste Rollen

### Struktur
- src/contracts.ts — gemeinsames Datenmodell (v0.1)
- src/risk-engine.ts — deterministische Freigabe/Blockierung (Trades + Capital Risk Gate)
- src/broker-adapter.ts — Broker-Order-Schnittstelle (gesperrt)
- src/ai-adapter.ts — KI-Schnittstelle (v0.1) + Re-Exports der neuen Registry/Adapter
- src/money/ — exakte Geld- und Dezimalarithmetik, Mehrwährungs-Basis
- src/persistence/ — Append-only-Log mit Hash-Kette, Store-Port, JSON-Codec; `postgres/` mit Pool, Migrationen, Stores, Projektoren
- src/audit/ — Audit Events und normalisierter DecisionRecord
- src/market-data/ — Marktdatenmodell, Kalender, Datenqualität, Instrument Registry, Corporate Actions, Store; `providers/` mit Twelve Data
- src/quant/ — Quant Engine V1: Indikatoren, Struktur, QuantResult, Quant-Runs
- db/migrations/ — versionierte SQL-Migrationen
- src/capital/ — Capital Ledger, Capital Engine, Bewertung, Allocator, Reallocation
- src/inventory/ — physische Ware: Unit Economics, Einkauf, Verkauf, Lager
- src/opportunities/ — gemeinsames Opportunity-Schema, Score, Lebenszyklus
- src/nexus/ — NEXUS Brain: Planner, Router, Task Manager, Critic, Consensus, Safety
- src/ai/ — Modell-Schema, Adapter-Port, Prompts, Registry, Performance, Champion/Challenger, Council
- src/blackboard/, src/evidence/, src/memory/, src/security/, src/evaluation/, src/broker/
- docs/NEXUS_MASTER_SPEC.md — Verfassung
- docs/ARCHITECTURE.md — Zielarchitektur
- docs/CAPITAL_ENGINE.md — Capital Engine
- docs/NEXUS_BRAIN.md — NEXUS Brain
- docs/PERSISTENCE.md — PostgreSQL, Invarianten, Concurrency, Audit
- docs/MARKET_DATA_QUANT.md — Marktdaten, Kalender, Datenqualität, Quant-Konventionen, Look-ahead-Schutz
- docs/ROADMAP.md — Bauplan

### Entwicklung

```bash
npm install
npm run check   # Typecheck + Unit-Tests + PostgreSQL-Integrationstests
npm run test:unit
npm run test:pg
npm run bench       # Quant-Benchmark 10k/100k Bars (nur Messung)
npm run test:live   # echter Twelve-Data-Smoke-Test (Netzwerk), sonst übersprungen
```

`test:live` läuft mit `TWELVE_DATA_API_KEY` (Produktion) oder mit `NEXUS_TWELVE_DATA_DEMO=1`, dem öffentlichen Demo-Schlüssel von Twelve Data. Dessen Daten sind als `demo` markiert und nie handelbar. Ohne beides wird der Test als NOT RUN gemeldet.

Die PostgreSQL-Tests starten lokal einen Wegwerf-Server aus den offiziellen PostgreSQL-Binaries (Dev-Abhängigkeit `embedded-postgres`) oder nutzen eine Test-Datenbank aus `NEXUS_TEST_DATABASE_URL`. Ist beides nicht verfügbar, werden sie mit Grund als übersprungen gemeldet.

Die Anwendung liest die Datenbank ausschliesslich aus `DATABASE_URL` in der Server-Umgebung. Migrationen liegen in `db/migrations/` und werden nie automatisch synchronisiert.

**Keine API-Keys und keine DB-Zugangsdaten in GitHub committen.** Nur `.env.example` gehört ins Repository.
