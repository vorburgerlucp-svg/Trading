# NEXUS Architecture v0.3

Verfassung und Regeln: [NEXUS_MASTER_SPEC.md](NEXUS_MASTER_SPEC.md).

## Leitprinzip

**AI proposes. Quant verifies. Risk controls. NEXUS learns and decides. Human approves critical capital movements.**

Die KI bekommt niemals unkontrollierten Broker-Zugriff. Jede ausführbare Order und jede Kapitalbewegung muss durch ein deterministisches Risk-Gate; grössere Bewegungen zusätzlich durch eine explizite Freigabe des Menschen.

## Zielarchitektur

```text
                        NEXUS BRAIN
         Planner ── Memory ── Router ── Model Registry (Champion/Challenger)
                           │
                     TASK MANAGER
                 ┌─────────┴─────────┐
           PARALLEL MODE       SEQUENTIAL MODE
        OpenAI · Claude · Gemini (Spezialisten, austauschbar, Shadow-fähig)
                           │
                  SHARED BLACKBOARD  ◄── Evidence (point-in-time, Provenance)
                           │
               CRITIC / COUNTER-ANALYSIS
                           │
                    CONSENSUS ENGINE   (Marktmeinung ≠ Handlung)
                           │
                     QUANT ENGINE      (nicht gebaut: QuantAssessment als Eingabe)
                           │
                     RISK ENGINE       (Trade-Risk + Capital Risk Gate)
                           │
                    CAPITAL ENGINE     (finanzielle Source of Truth, nur lesend fürs Brain)
                           │
                RECOMMEND / NO_ACTION  → Execution Gate (gesperrt)
                           │
                        MEMORY  → Outcome Evaluator → Model Performance → nächster Zyklus
```

Details: [NEXUS_BRAIN.md](NEXUS_BRAIN.md) (Brain) · [CAPITAL_ENGINE.md](CAPITAL_ENGINE.md) (Kapital).

## Module

```text
src/money/          exakte Geld- und Dezimalarithmetik; currency.ts: Money { currency, minor } + explizite FX
src/persistence/    kanonisches JSON, generisches hash-verkettetes Append-only-Log (Store-Port)
src/capital/        Ledger, Engine, Bewertung, Allocator, Reallocation
src/inventory/      Produkte, Unit Economics, Lagerbuchungen
src/opportunities/  Opportunity-Schema, Score, Lebenszyklus
src/evidence/       EvidenceRef, Evidence Store (point-in-time)
src/blackboard/     Shared Blackboard mit Evidenzregel
src/memory/         NEXUS Memory (strukturiert, point-in-time)
src/security/       Untrusted-Input-Behandlung (Quarantäne, Tripwire)
src/ai/             Modell-Taxonomie und -Schema, Adapter-Port, Prompts, Registry, Performance, Champion/Challenger, Council
src/nexus/          Planner, Router, Task Manager, Critic, Consensus, Safety (Locks), NexusBrain
src/evaluation/     Outcome Evaluator
src/broker/         Read-only Broker Sync (Port + Reconciliation), nicht verbunden
src/risk-engine.ts  Trade-Risk + Capital Risk Gate
src/broker-adapter.ts, src/ai-adapter.ts, src/contracts.ts   v0.1-Schnittstellen (unverändert bzw. erweitert)
```

## Broker-Strategie

Broker-spezifische Details bleiben hinter Adaptern. Orders (`BrokerAdapter`) und Lesezugriff (`BrokerSyncAdapter`, nur `read_only`) sind getrennte Schnittstellen. IBKR ist bevorzugt, eToro der zweite Adapter. Der erste echte Sync wird read-only sein und Abweichungen über `reconcileBrokerSnapshot` melden, bevor etwas gebucht wird.

## AI-Strategie

Alle Modelle erhalten dasselbe Anfrage-Schema und müssen dasselbe Antwort-Schema liefern (`nexus.opinion.v1`). Es gibt keine festen Rollen pro Anbieter; Zuständigkeiten entstehen aus gemessener Leistung. Neue Modelle laufen im Shadow Mode und werden erst nach Benchmark und menschlicher Aktivierung wirksam.

## Persistenz

Ziel ist **PostgreSQL** für den finanziellen Kern (Ledger, Audit, Memory, Evidence, Reconciliation). Firebase ist kein kanonischer Finanz-Ledger. Alle Speicher laufen über Ports; aktuell gibt es In-Memory-Implementierungen.

## Live-Safety

V0.3 führt keine Netzwerk-Order und keine Warenbestellung aus. `BUILD_LOCKS` sperren Live Trading, Brokerorders und physische Einkäufe unabhängig von der Umgebung. Vor Live-Betrieb nötig: Freigabe-Workflow, Daten-Frischeprüfung (vorhanden), Spread-Check, Positions- und Tagesverlustlimit, Duplicate-Order-Schutz (Ledger-IDs idempotent), Audit (vorhanden) und Kill Switch.
