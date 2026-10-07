# NEXUS Capital Engine

Capital & Opportunity Intelligence Platform: Trading, Investing, physischer Handel und später weitere Business-Opportunities, mit einem gemeinsamen Kapitalbild.

**Prinzip: AI proposes. Quant verifies. Risk controls. NEXUS learns and decides. Human approves critical capital movements.**

Verfassung: [docs/NEXUS_MASTER_SPEC.md](docs/NEXUS_MASTER_SPEC.md)

## Stand v0.3

- **Capital Engine (v0.2):** NEXUS kennt das gesamte Kapital (Cash, Finanzanlagen, Ware, Forderungen, Verbindlichkeiten, Reservationen), führt einen unveränderlichen Ledger und erstellt Allokations- und Umschichtungs-*Vorschläge*.
- **NEXUS Brain (v0.3):** NEXUS koordiniert KI-Modelle als Spezialisten: Planner mit Decision Depth, AI Router, AI Council, Shared Blackboard mit Evidenzregel, Critic, Consensus Engine, Memory, Outcome Evaluator, Model Registry mit Champion/Challenger. Getestet mit Test-Doubles; **echte Provider sind noch nicht verbunden**.
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
- src/persistence/ — Append-only-Log mit Hash-Kette, Store-Port
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
- docs/ROADMAP.md — Bauplan

### Entwicklung

```bash
npm install
npm run check   # Typecheck + Tests
```

**Keine API-Keys in GitHub committen.** Nur `.env.example` gehört ins Repository.
