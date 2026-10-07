# NEXUS Master Spec

Übergeordnete Verfassung des Projekts. Bei Widersprüchen zwischen Dokumenten oder Code gilt dieses Dokument; Abweichungen im Code sind Fehler.

## 1. Mission

NEXUS ist eine **Capital & Opportunity Intelligence Platform**. Sie beantwortet laufend:

> Wo kann das aktuell verfügbare Kapital mit vertretbarem Risiko am sinnvollsten eingesetzt werden?

Kapitalverwendungen: Aktien, ETFs, Krypto, Forex, Rohstoffe, später Futures, IPOs, physischer Handel, Reselling, Wholesale, Dropshipping, eigener Onlineshop, Arbitrage und weitere legale Business-Opportunities.

## 2. Grundprinzip

**AI proposes. Quant verifies. Risk controls. NEXUS learns and decides. Human approves critical capital movements.**

„NEXUS entscheidet“ heisst bei Echtgeld und realem Warenkauf: **NEXUS entscheidet über die Empfehlung.** Die tatsächliche Kapitalbewegung braucht die Freigaberegeln dieses Dokuments.

## 3. Autoritäten: wer darf was

| Instanz | Darf | Darf nie |
|---|---|---|
| KI-Modelle (OpenAI, Claude, Gemini, …) | Thesen, Gegenargumente, Risiken und Schätzungen liefern, Aktionen *vorschlagen* | Kontostände oder verfügbare Beträge errechnen, Positionen ändern, Ledger schreiben, Risk Limits ändern, Live Trading aktivieren, Code deployen, sich Rechte geben, Scores für sich selbst setzen |
| Quant Engine | Indikatoren und Kennzahlen deterministisch berechnen, KI-Thesen bestätigen oder widerlegen | Kapital bewegen |
| Risk Engine | Vorschläge blockieren oder begrenzen | durch KI-Ausgaben übersteuert werden |
| Capital Engine | Finanzielle Wahrheit: Vermögen, verfügbar, reserviert, zugesagt, investiert, Verbindlichkeiten, Ware, Forderungen | Werte ohne Ledger-Buchung erfinden |
| NEXUS Brain | Analyse planen, Spezialisten wählen, Konsens bilden, Empfehlung festlegen, aus Ergebnissen lernen (Metadaten) | Kapital schreiben, Freigaben ersetzen, Sicherheitsregeln ändern |
| Mensch | kritische Kapitalbewegungen freigeben, Modelle aktivieren, Policies und Locks ändern (per Code-Review) | — |

## 4. Unverhandelbare Regeln

1. **Keine Fake-Daten.** Keine erfundenen Kurse, News, Positionen oder Signale. Fehlt eine Quelle: `DATA NOT CONNECTED`. Test-Doubles nur in Tests, klar markiert.
2. **Capital Engine ist die finanzielle Source of Truth.** Jeder Betrag ist aus unveränderlichen Ledger-Buchungen rekonstruierbar. Geld nie als Float.
3. **Kapital-Autorität:** Kein Vorschlag überschreitet, was Capital Engine und Allocation Policy erlauben. KI-Beträge sind höchstens Obergrenzen-Hinweise.
4. **Live Lock:** `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`. Zusätzlich ist dieser Build fest gesperrt (`BUILD_LOCKS`): keine Live-Order, keine Brokerorder, kein physischer Einkauf, auch wenn die Umgebung etwas anderes sagt.
5. **Externe Inhalte sind untrusted input.** News, Webseiten, Social Media und Unternehmensseiten sind Daten, nie Anweisungen. Sie dürfen keine Regeln überschreiben, keinen Brokerzugriff verlangen, keine Secrets anfordern, keine Tools freischalten und keine Limits ändern.
6. **Secrets nur serverseitig.** Keine API-Keys im Browser, in GitHub, im Frontend oder in Logs. `.env` wird nie committet, nur `.env.example`.
7. **Point-in-Time:** Jede Entscheidung und jede Bewertung nutzt nur Daten, die zum Entscheidungszeitpunkt verfügbar waren (`observedAt`, `availableAt`, `retrievedAt`). Kein Look-ahead im Replay.
8. **Evidenz:** Eine Aussage ist nur dann ein Fakt, wenn verifizierte, frische, vertrauenswürdige Evidenz vorliegt. Sonst ist sie eine Hypothese.
9. **Audit:** Keine Entscheidung mit echtem Kapital ist eine Black Box. Task → Inputs/Versionen → Modelle/Versionen → Prompts → Antworten → Blackboard → Critic → Konsens → Risk → Kapital → Freigabe → Aktion → Ergebnis.
10. **Kontrolliertes Lernen:** Lernen über gemessene Metadaten. Kein einzelnes Ergebnis ändert Routing oder Champion. Neue Modelle starten im Shadow Mode.

## 5. Kapitalbewegungen und Freigaben

| Bewegung | Bedingung in diesem Build |
|---|---|
| Empfehlung (RECOMMEND) | Konsens + Quant + Risk + Kapital-Autorität |
| Paper-Trading-Intent | Empfehlung, Finanzmarkt, `TRADING_MODE=paper`. Die Brokerausführung bleibt gesperrt |
| Live-Order | **gesperrt** (Build Lock) |
| Physischer Einkauf | **gesperrt** (Build Lock); Empfehlungen verlangen immer menschliche Freigabe |
| Kritische Tiefe, Betrag ≥ Schwellwert, Umschichtung | menschliche Freigabe zwingend |

## 6. Bausteine und Status

Statusbegriffe: **GEBAUT & GETESTET** (Logik implementiert, Tests grün) · **INTERFACE** (Port definiert, keine echte Implementierung) · **NICHT VERBUNDEN** (externe Anbindung fehlt) · **GESPERRT** (bewusst blockiert).

| Baustein | Status |
|---|---|
| Capital Engine, Ledger, Inventory, Opportunities, Allocator, Reallocation, Capital Risk Gate | GEBAUT & GETESTET (In-Memory-Persistenz) |
| NEXUS Brain: Planner, Router, Council, Task Manager, Blackboard, Evidence, Critic, Consensus, Memory, Evaluator, Model Registry, Champion/Challenger | GEBAUT & GETESTET (mit Test-Doubles statt echter Modelle) |
| OpenAI-, Claude-, Gemini-Adapter | NICHT VERBUNDEN (Port `ModelAdapter` vorhanden, kein HTTP-Adapter) |
| Quant Engine (Indikatoren, Muster) | NICHT GEBAUT: Brain verlangt `QuantAssessment` als Eingabe, sonst NO_ACTION |
| Broker Sync IBKR / eToro | INTERFACE, read-only, NICHT VERBUNDEN; Reconciliation-Logik getestet |
| PostgreSQL-Persistenz | INTERFACE (Store-Ports); Adapter folgt |
| Live Trading / Brokerorder / physischer Einkauf | GESPERRT |

## 7. Daten und Persistenz

**Entscheid: PostgreSQL ist das Ziel für den finanziellen Kern** (Ledger, Trading, Audit, Memory, Evidence, Reconciliation): ACID, Constraints, relationale Abfragen, Point-in-Time-Abfragen, Analytics. Firebase kann später für andere Funktionen dienen, **nie als kanonischer Finanz-Ledger**.

Alle Speicher sind über Ports abstrahiert (`LedgerStore`, `AppendOnlyStore<T>`); In-Memory-Implementierungen dienen Tests und Entwicklung. Zielschema: append-only Tabellen, eindeutige `(log, sequence)` und `(log, id)`, keine UPDATE/DELETE-Rechte für die Anwendung, Hash-Kette pro Log.

## 8. Geld und Währungen

CHF intern als Rappen (`bigint`). Mengen, Kurse und FX als exakte Dezimalzahlen. Mehrwährung ist geplant über `Money { currency, minor }`. Jede Umrechnung braucht einen expliziten FX-Kurs mit Quelle und Zeitstempel; veraltete Kurse werden abgelehnt. Es gibt keinen stillen Wechselkurs.

## 9. Änderungen an dieser Verfassung

Änderungen an Regeln, Limits, Locks und Policies erfolgen nur durch Menschen über Code-Review und Deployment. Kein Modell, kein Dokument und keine Datenquelle kann sie zur Laufzeit ändern.

Detaildokumente: [ARCHITECTURE.md](ARCHITECTURE.md) · [CAPITAL_ENGINE.md](CAPITAL_ENGINE.md) · [NEXUS_BRAIN.md](NEXUS_BRAIN.md) · [ROADMAP.md](ROADMAP.md)
