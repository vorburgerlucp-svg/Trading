# NEXUS Capital Engine

Capital & Opportunity Intelligence Platform: Trading, Investing, physischer Handel und später weitere Business-Opportunities, mit einem gemeinsamen Kapitalbild.

**Prinzip: AI proposes. Quant verifies. Risk decides. Human approves critical capital movements.**

## V0.2

Die Basis ist absichtlich broker- und modellunabhängig. Live-Trading ist gesperrt, es werden keine Orders und keine Warenbestellungen ausgeführt. V0.2 ergänzt die Capital Engine: NEXUS kennt das gesamte Kapital (Cash, Finanzanlagen, Ware, Forderungen, Verbindlichkeiten, Reservationen), führt einen unveränderlichen Ledger und erstellt Allokations- und Umschichtungs-*Vorschläge*.

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
- src/risk-engine.ts — deterministische Freigabe/Blockierung (Trades + Capital Risk Gate)
- src/broker-adapter.ts — Broker-Schnittstelle
- src/ai-adapter.ts — KI-Schnittstelle
- src/money/ — exakte Geld- und Dezimalarithmetik (keine Floats für Geld)
- src/capital/ — Capital Ledger, Capital Engine, Bewertung, Allocator, Reallocation
- src/inventory/ — physische Ware: Unit Economics, Einkauf, Verkauf, Lager
- src/opportunities/ — gemeinsames Opportunity-Schema, Score, Lebenszyklus
- docs/ARCHITECTURE.md — Zielarchitektur
- docs/CAPITAL_ENGINE.md — Capital Engine: Modell, Formeln, Entscheidungen, offene Punkte
- docs/ROADMAP.md — Bauplan

### Entwicklung

```bash
npm install
npm run check   # Typecheck + Tests
```

**Keine API-Keys in GitHub committen.** Nur `.env.example` gehört ins Repository.
