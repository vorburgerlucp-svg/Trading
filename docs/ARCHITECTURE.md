# NEXUS Architecture v0.1

## Leitprinzip

**AI proposes. Quant verifies. Risk decides.**

Die KI bekommt niemals unkontrollierten Broker-Zugriff. Jede ausführbare Order muss durch ein deterministisches Risk-Gate.

## Pipeline

1. Market/Data Ingestion
2. Quant Engine
3. News/Fundamental/Macro Enrichment
4. AI Committee (OpenAI + Claude; später weitere)
5. Consensus Engine
6. Risk Engine
7. Broker Adapter
8. Journal + Post-Trade Evaluation

## Broker-Strategie

Broker-spezifische Details bleiben hinter BrokerAdapter. IBKR ist unser bevorzugtes langfristiges Execution-Backend. eToro bleibt als zusätzlicher Adapter. Strategien dürfen keine broker-spezifischen IDs kennen.

## AI-Strategie

Jedes Modell liefert dasselbe AiAnalysis-Schema. Neue Modelle laufen zuerst im Shadow Mode und werden gegen historische und Paper-Trading-Fälle benchmarked, bevor sie Entscheidungen beeinflussen.

## Live-Safety

V0.1 führt keine Netzwerk-Order aus. Später brauchen Live-Orders zusätzlich: Strategy Approval, Daten-Frischeprüfung, Spread-Check, Positions-/Tagesverlustlimit, Duplicate-Order-Schutz, Audit Log und Kill Switch.
