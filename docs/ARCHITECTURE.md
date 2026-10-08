# NEXUS Architecture v0.4

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
                     QUANT ENGINE      (V1: deterministisch, point-in-time; Marktdaten via Provider-Port)
                           │
                     RISK ENGINE       (Trade-Risk + Capital Risk Gate)
                           │
                    CAPITAL ENGINE     (finanzielle Source of Truth, nur lesend fürs Brain)
                           │
                RECOMMEND / NO_ACTION  → Execution Gate (gesperrt)
                           │
                        MEMORY  → Outcome Evaluator → Model Performance → nächster Zyklus
```

Details: [NEXUS_BRAIN.md](NEXUS_BRAIN.md) (Brain) · [CAPITAL_ENGINE.md](CAPITAL_ENGINE.md) (Kapital) · [PERSISTENCE.md](PERSISTENCE.md) (PostgreSQL, Audit) · [MARKET_DATA_QUANT.md](MARKET_DATA_QUANT.md) (Marktdaten, Quant).

## Module

```text
src/money/          exakte Geld- und Dezimalarithmetik; currency.ts: Money { currency, minor } + explizite FX
src/persistence/    kanonisches JSON, verlustfreier JSON-Codec, generisches hash-verkettetes Append-only-Log (Store-Port)
src/persistence/postgres/  Pool (nur DATABASE_URL), Migrationsrunner, PostgresLedgerStore, PostgresAppendOnlyStore, Projektoren
src/audit/          Audit Event Store, normalisierter DecisionRecord
db/migrations/      versionierte SQL-Migrationen (001 Ledger, 002 Append-only-Logs, 003 Domänen-Projektionen, 004 Marktdaten)
src/market-data/    kanonisches Marktdatenmodell, Zeit/DST, Kalender, Validierung, Datenqualität, Freshness,
                    Instrument Registry, Corporate Actions, Store (Port + In-Memory), MarketDataService
src/market-data/providers/  Resilienz (Timeout, Retry, Circuit Breaker), Twelve Data Adapter + Schema
src/quant/          Quant Engine V1, QuantResult, Quant-Run-Store, QuantService (Live = Backtest)
src/quant/indicators/  SMA, EMA, RSI, MACD, ATR, ADX, Bollinger, VWAP, Pivots
src/quant/structure/   Swings, Support/Resistance, Market Structure
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

**PostgreSQL** ist die kanonische Datenbank für den finanziellen Kern und das Audit (Ledger, Idempotenz, Reservierungen, Audit Events, Decision Records, Evidence, Registry, Performance, Memory, Snapshots). Firebase ist kein Finanz-Ledger.

- Gespeichert werden Quell-Ereignisse, der Zustand wird daraus abgeleitet. Normalisierte Tabellen sind Projektionen, die in derselben Transaktion geschrieben werden.
- Jeder Store besitzt den kritischen Abschnitt: Zeilensperre auf dem Kopf des Logs in einer READ-COMMITTED-Transaktion, Nachladen fremder Einträge, dann Prüfung und Einfügen. Mehrere Instanzen sind damit sicher.
- Die Datenbank erzwingt die Ledger-Invarianten zusätzlich selbst: Nullsumme, Vollständigkeit, Währungen, Kette, keine Mutation.
- In-Memory- und PostgreSQL-Adapter bestehen dieselben Contract-Tests.

Details: [PERSISTENCE.md](PERSISTENCE.md).

## Live-Safety

V0.4 führt keine Netzwerk-Order und keine Warenbestellung aus. `BUILD_LOCKS` sperren Live Trading, Brokerorders und physische Einkäufe unabhängig von der Umgebung. Vor Live-Betrieb nötig: Freigabe-Workflow, Daten-Frischeprüfung (vorhanden), Spread-Check, Positions- und Tagesverlustlimit, Duplicate-Order-Schutz (Ledger-Idempotenz per DB-Constraint vorhanden), Audit (vorhanden) und Kill Switch.
