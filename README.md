# NEXUS Capital Engine

Trading- und Opportunity-Intelligence-Plattform.

**Prinzip: AI proposes. Quant verifies. Risk decides.**

## V0.1

Die erste Basis ist absichtlich broker- und modellunabhängig. Live-Trading ist noch gesperrt. Wir bauen zuerst reproduzierbare Analyse, Risk-Gates und saubere Adapter.

### Ziel-Broker
- IBKR: bevorzugtes langfristiges Execution-Backend wegen breiter Markt-/Instrumentabdeckung und reifer API.
- eToro: zusätzlicher Adapter für Demo/Live und kleine Testgrössen.
- Krypto-Börsen: später als eigene Adapter.

### Ziel-KI
- OpenAI
- Anthropic Claude
- später Gemini und weitere Modelle über dieselbe Schnittstelle

### Struktur
- src/contracts.ts — gemeinsames Datenmodell
- src/risk-engine.ts — deterministische Freigabe/Blockierung
- src/broker-adapter.ts — Broker-Schnittstelle
- src/ai-adapter.ts — KI-Schnittstelle
- docs/ARCHITECTURE.md — Zielarchitektur
- docs/ROADMAP.md — Bauplan

**Keine API-Keys in GitHub committen.**
