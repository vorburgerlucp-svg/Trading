# NEXUS Architecture v0.2

## Leitprinzip

**AI proposes. Quant verifies. Risk decides. Human approves critical capital movements.**

Die KI bekommt niemals unkontrollierten Broker-Zugriff. Jede ausführbare Order und jede Kapitalbewegung muss durch ein deterministisches Risk-Gate; grössere Bewegungen zusätzlich durch eine explizite Freigabe des Menschen.

## Pipeline

1. Market/Data Ingestion
2. Quant Engine
3. News/Fundamental/Macro Enrichment
4. AI Committee (OpenAI + Claude; später weitere)
5. Consensus Engine
6. Opportunity Engine: alle Kapitalverwendungen (Trades, Ware, Business) im gleichen Schema, deterministischer Score
7. Capital Allocator / Reallocation: Vorschläge aus verfügbarem bzw. gebundenem Kapital
8. Risk Engine: Trade-Risk (`assessRisk`) + Capital Risk Gate (`assessAllocationProposal`, `assessReallocationProposal`)
9. Human Approval (kritische Kapitalbewegungen)
10. Broker Adapter / manuelle Beschaffung (Ausführung, in v0.2 gesperrt)
11. Capital Ledger: unveränderliche, doppelte Buchführung aller Kapitalbewegungen
12. Capital State + Journal + Post-Trade Evaluation (Learning Engine)

## Capital Layer (v0.2)

Die Capital Engine kennt das gesamte Kapital: Cash (Bank, Broker, Stablecoins, Bargeld), Finanzanlagen, physische Ware, Forderungen, Verbindlichkeiten und Reservationen. Alle Werte sind aus dem Ledger rekonstruierbar; Marktwerte entstehen nur aus echten, frischen Kursen, sonst `DATA NOT CONNECTED`.

Details, Formeln, Entscheidungen und offene Punkte: [CAPITAL_ENGINE.md](CAPITAL_ENGINE.md).

```text
src/money/          exakte Geld- und Dezimalarithmetik (bigint)
src/capital/        Ledger, Engine, Bewertung, Allocator, Reallocation
src/inventory/      Produkte, Unit Economics, Lagerbuchungen
src/opportunities/  Opportunity-Schema, Score, Lebenszyklus
src/risk-engine.ts  Trade-Risk + Capital Risk Gate
```

## Broker-Strategie

Broker-spezifische Details bleiben hinter BrokerAdapter. IBKR ist unser bevorzugtes langfristiges Execution-Backend. eToro bleibt als zusätzlicher Adapter. Strategien dürfen keine broker-spezifischen IDs kennen. Die Capital Engine *bucht* Fills, die ein Broker gemeldet hat; sie platziert keine Orders.

## AI-Strategie

Jedes Modell liefert dasselbe AiAnalysis-Schema. Neue Modelle laufen zuerst im Shadow Mode und werden gegen historische und Paper-Trading-Fälle benchmarked, bevor sie Entscheidungen beeinflussen. KI-Modelle liefern Thesen und Schätzungen für Opportunities, aber nie deren Score.

## Live-Safety

V0.2 führt keine Netzwerk-Order und keine Warenbestellung aus. Später brauchen Live-Orders zusätzlich: Strategy Approval, Daten-Frischeprüfung, Spread-Check, Positions-/Tagesverlustlimit, Duplicate-Order-Schutz (Ledger-IDs sind bereits idempotent), Audit Log (Ledger-Hash-Kette) und Kill Switch.
