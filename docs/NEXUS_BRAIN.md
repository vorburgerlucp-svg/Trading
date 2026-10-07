# NEXUS Brain (v0.3)

NEXUS ist das Gehirn; OpenAI, Claude, Gemini und spätere Modelle sind **Spezialisten innerhalb von NEXUS**. NEXUS plant die Analyse, wählt die Spezialisten nach gemessener Leistung, führt ihr Wissen strukturiert zusammen, bildet einen Konsens, holt die Kapitalgrenzen von der Capital Engine und lernt aus Ergebnissen. Kapital bewegt NEXUS in diesem Build nicht.

> Status: Die Brain-Logik ist **gebaut und getestet**, aber mit **Test-Doubles** statt echter Modelle. Es gibt noch keinen HTTP-Adapter zu OpenAI, Anthropic oder Google und keine Quant Engine. Echte Entscheidungen sind deshalb noch nicht möglich.

## 1. Ablauf eines Entscheidungszyklus

```text
DecisionRequest (Task, Frage, asOf, Evidence, Opportunity, QuantAssessment)
  │
  ├─ Inputs point-in-time: Evidence-Status (frisch / veraltet / noch nicht verfügbar), externer Text zitiert + gescannt
  ├─ Capital Engine (nur lesen): Vermögen, verfügbar, reserviert, zugesagt, investiert, Verbindlichkeiten → Blackboard-Fakten
  ├─ Capital at risk = max(deklariert, allozierbar) → Planner: DecisionDepth + Modus + Schritte
  ├─ Task Manager: pro Schritt Router → AI Council (isoliert, Timeout, Schema, Fallback, Shadow) → Blackboard
  ├─ Critic-Findings (Evidenz-geprüft) → Consensus Engine (Marktmeinung ≠ Handlung)
  ├─ Risk + Kapital-Autorität: Allocator + Capital Risk Gate, KI-Betrag nur Obergrenze
  ├─ Human-Approval-Regeln → Execution Gate (Live/Broker/Einkauf gesperrt)
  └─ DecisionRecord in Memory (Audit, hash-verkettet) + Failure Memory
        └─ später: OutcomeEvaluator → Model Performance → Router / Champion/Challenger
```

Code: `src/nexus/nexus-brain.ts`.

## 2. Planner und Decision Depth

`src/nexus/task-planner.ts`. Die Tiefe wächst mit Einsatz und Unsicherheit:

| Depth | Wann (Default-Schwellen) | Schritte |
|---|---|---|
| `single` | Importance low, < 100 CHF | 1 Analyst |
| `reviewed` | medium oder ≥ 100 CHF | Analyst → Critic (sequenziell) |
| `committee` | high, ≥ 1'000 CHF oder unabhängige Meinungen verlangt | 2 unabhängige Analysten (≥ 2 Anbieter, parallel) → Critic |
| `critical_committee` | critical oder ≥ 10'000 CHF | 3 unabhängige Analysten (≥ 2 Anbieter) + unabhängige Gegenanalyse → Critic; Einstimmigkeit, strenge Risk-Prüfung, menschliche Freigabe |

Hohe Unsicherheit und widersprüchliche Daten erhöhen die Tiefe je um eine Stufe. Der Planner rechnet mit **max(deklariertem, tatsächlich allozierbarem)** Kapital, eine zu tief deklarierte Summe kann die Analyse also nicht verflachen.

**Parallel vs. sequenziell:** Parallel, wenn unabhängige Meinungen gebraucht werden: Analysten sehen die Antworten der anderen nicht. Die Ergebnisse eines Schritts landen erst nach Abschluss des Schritts auf dem Blackboard. Sequenziell bei Arbeitsteilung (`task.pipeline`, z. B. `discovery → news_sentiment → fundamental_analysis`): Jeder Schritt sieht die vorherigen. Ab `committee` wird eine Pipeline ignoriert, weil dort Unabhängigkeit Vorrang hat.

## 3. AI Router

`src/nexus/ai-router.ts`. Es gibt **keine festen Rollen**: „OpenAI = Krypto“ kann höchstens ein konfigurierter Start-Champion sein.

- **Harte Filter:** aktiviert, kein Shadow Mode, Adapter verbunden, Circuit nicht offen (≥ 3 Fehler in Folge), Fehlerquote ≤ 50 %, benötigte Fähigkeiten (`structured_output` immer), Latenzgrenze, Kostenbudget. Unbekannte Kosten werden bei gesetztem Budget abgelehnt.
- **Score:** `w_perf·Leistung + w_rel·(1−Fehlerquote) − w_cost·rel. Kosten − w_lat·rel. Latenz`. Leistung = veröffentlichter Score für Domain + Subtask, sonst Domain, sonst neutraler Prior. Gewichte nach Einsatz: bei `low` zählen Kosten 30 %, bei `critical` 0 %.
- **Auswahl:** Domain-Champion zuerst (falls verfügbar), dann verschiedene Anbieter (Unabhängigkeit), dann der beste Rest. Der Critic soll keiner der Analysten sein. Fallbacks stehen nach Score bereit; Shadow-Modelle werden separat geführt.
- **Ehrlichkeit:** Reichen Modelle, Anbieter oder Budget nicht, meldet der Router `satisfied: false`. Die Tiefe wird nie still reduziert.

## 4. AI Council und Task Manager

`src/ai/ai-council.ts`, `src/nexus/task-manager.ts`.

- Alle Modelle eines Schritts erhalten die **identische** Anfrage (gleicher Kontext, gleiche Prompt-Version).
- Harte Zeitgrenze pro Aufruf, strikte Schema-Validierung (`nexus.opinion.v1`). Freitext wie „BUY BUY BUY“ ist `invalid_output`.
- Fällt ein Primary aus (Fehler, Timeout, ungültige Antwort, nicht verbunden), springt ein Fallback ein, bevorzugt von einem noch nicht vertretenen Anbieter. Gesundheit und Fehlerquote werden in der Registry nachgeführt.
- Reichen die gültigen Antworten nicht, bricht der Task Manager ab. Ergebnis: **NO_ACTION, „insufficient analysis“**, nie eine stille Entscheidung.

## 5. Shared Blackboard

`src/blackboard/`. Strukturierte, append-only Einträge (`fact`, `hypothesis`, `risk`, `catalyst`, `contradiction`, `calculation`, `recommendation`, `critique`) statt Chat zwischen Modellen. Bei jedem Eintrag läuft die Evidenzregel:

- `fact` braucht verifizierte Evidenz (bekannt, sichtbar, vertrauenswürdig, frisch oder zeitlos), sonst wird der Eintrag zur `hypothesis`. Die gewünschte und die akzeptierte Kategorie werden beide gespeichert.
- `calculation` gehört Quant/System; die Berechnung eines Modells ist eine Hypothese.
- Verweise auf Evidenz, die zum Entscheidungszeitpunkt noch nicht verfügbar war, werden abgelehnt bzw. entfernt (Look-ahead).
- Modell-Aussagen mit instruktionsartigem Text werden quarantäniert, bevor ein anderes Modell sie liest (Schutz gegen Second-Order-Injection).

## 6. Evidence und Provenance

`src/evidence/`. Jede `EvidenceRef` hat `source`, `observedAt`, `availableAt`, `retrievedAt`, optional `freshnessMs`, `trusted` und eine Inhalts-Prüfsumme. Status zum Zeitpunkt `asOf`: `fresh`, `timeless`, `stale`, `not_yet_available`, `unknown`. Ein alter Preis kann nie unbemerkt als aktueller gelten: Veraltete Schlüssel-Evidenz führt zu NO_ACTION, auch wenn alle Modelle bullish sind.

## 7. Critic / Devil's Advocate

`src/nexus/critic.ts`. Der Critic ist eine **Rolle**, an keinen Anbieter gebunden. Prüfliste: versteckte Risiken, Gegenargumente, Datenlücken, Korrelation, Liquidität, Event-Risiko, alternative Erklärung, falsche Annahmen, zu optimistische Prognosen. Ein `blocking`-Finding blockiert nur mit verifizierter Evidenz; ohne Evidenz zählt es als `major`. Im kritischen Modus blockieren auch offene `major`-Findings. Auf `critical_committee` gibt es zusätzlich eine **unabhängige Gegenanalyse** (`counter_analyst`), die die Bull-Thesen nicht sieht.

## 8. Consensus Engine

`src/nexus/consensus-engine.ts`. Kein Mitteln. Getrennt werden Fakten, Berechnungen, Prognosen, Meinungen, Risiken und Widersprüche, und **Marktmeinung (`direction`) und Handlung (`execution`)** sind getrennte Ergebnisse. Beispiel aus den Tests: Alle sind bullish, Quant bestätigt, aber der Critic belegt Earnings in 24 h → `direction: bullish`, `execution: NO_ACTION`, Grund: Event-Risiko.

Bullish gegen bearish ergibt `contested`, der Widerspruch wird mit beiden Positionen ausgewiesen. Unterschiedliche Aktionen ergeben keine Einigkeit (Einstimmigkeit nötig). Fehlender oder widersprechender Quant, veraltete Schlüsseldaten oder quarantänierte Eingaben führen ebenfalls zu NO_ACTION.

## 9. Memory

`src/memory/`. Arten: `market`, `trade`, `business`, `strategy`, `model_performance`, `failure`, `decision`. Append-only, hash-verkettet, Korrekturen nur als neue Einträge (`supersedes`). Abfragen sind immer point-in-time (`recall({ asOf })` sieht nur, was zu diesem Zeitpunkt bekannt war). **Memory trainiert kein Sprachmodell**; es speichert strukturierte Daten, die deterministischer Code auswertet.

## 10. Outcome Evaluator und Lernen

`src/evaluation/outcome-evaluator.ts`. Verknüpft Decision → Prediction → Action → Outcome.

- **Trading:** Rendite, Richtung korrekt, Maximum Adverse/Favorable Excursion, Stop (nicht gesetzt / nicht erreicht / erreicht / erreicht und danach erholt = zu eng), Ziel erreicht, Gebühren, Ergebnis.
- **Physischer Handel:** ROI, Marge, Preisabweichung, Abweichung der Verkaufsdauer, Gewinnabweichung, Kapitalbindung, Sell-Through.
- Bewertet werden auch NO_ACTION-Entscheidungen (kontrafaktisch). Beispiel: Claude BUY, OpenAI NO_TRADE, −12 % → OpenAI Score 1, Claude 0.
- Ergebnisse müssen **nach** der Entscheidung bekannt werden; Beobachtungen werden erst ab `knownAt` sichtbar.

## 11. Model Registry und Champion/Challenger

`src/ai/model-registry.ts`, `src/ai/model-performance.ts`, `src/ai/champion-challenger.ts`.

- **Neue Modelle starten im Shadow Mode:** Sie analysieren dieselben Fälle, ihre Antworten werden gespeichert und bewertet, beeinflussen aber nichts.
- Was den Einfluss eines Modells erhöht (Aktivierung, Einschalten, Bootstrap als aktiv), darf **nur ein Mensch**, und die Aktivierung nur nach bestandenem Benchmark (≥ 30 Samples, Score ≥ 0.5). Modelle haben keine Akteurs-Identität und können sich daher keine Rechte geben.
- Scores werden erst ab **20 Samples** veröffentlicht und zum Prior 0.5 hin geschrumpft. Ein einzelnes Ergebnis ändert weder Routing noch Registry.
- Ein Challenger wird Champion erst mit **≥ 50 Samples** und **≥ 0.05 Score-Vorsprung**, gemessen point-in-time. Jeder Wechsel wird protokolliert.

## 12. Sicherheitsgrenzen

| Grenze | Umsetzung |
|---|---|
| Externer Text ist nie Anweisung | eigenes `untrusted`-Feld, nie in Instruktionen oder Frage; Tripwire-Scanner quarantäniert Manipulationsversuche und erzwingt NO_ACTION mit menschlicher Prüfung |
| Modelle ohne Macht | keine Tools, kein Brokerzugriff, keine Secrets; nur ein validiertes Antwort-Schema |
| Kapital nur lesend | `CapitalReader` gibt dem Brain nur `snapshot(asOf)`; Beträge kommen aus Allocator + Capital Risk Gate |
| Policies eingefroren | Policies, Prompt-Vorlagen und `BUILD_LOCKS` sind unveränderliche Objekte |
| Live Lock doppelt | Umgebung (`ALLOW_LIVE_TRADING` nur exakt `true`) **und** Build Lock; `liveOrderAllowed` ist im Typ als `false` festgelegt |
| Lernen begrenzt | Modelle können weder Limits, Ledger, Sicherheitsregeln, Live-Schalter, Deployments noch eigene Rechte ändern |

Der Injection-Scanner ist heuristisch und umgehbar. Der eigentliche Schutz ist die Architektur: Selbst ein vollständig manipuliertes Modell kann nur eine Empfehlung abgeben, und die bleibt durch Kapital-Autorität, Risk, Freigabe und Locks begrenzt (getestet).

## 13. Audit Trail

Jeder Zyklus erzeugt einen `DecisionRecord` in Memory (Art `decision`): Task, Frage, Plan und Begründung, Evidence mit Status und Version (Hash), ausgeschlossene Look-ahead-Daten, Capital-State-Referenz, Quant, Routing pro Schritt (Primaries, Fallbacks, Shadow, Abgelehnte mit Grund), alle Aufrufe (Modell, Modellversion, Prompt-ID und -Version, Request- und Response-Hash, Status, Latenz, Antwort), Blackboard-Einträge, Critic-Findings, Konsens, Risk, Kapitalentscheid, Freigabestatus, Execution Gate und Security-Befunde. Ergebnisse werden später über `decisionId` verknüpft.

## 14. Offene Punkte

1. Echte Provider-Adapter (OpenAI, Anthropic, Gemini): serverseitig, mit Timeouts, Retries, Kostenmessung und strukturierter Ausgabe.
2. Quant Engine: Indikatoren deterministisch; bis dahin ist jede Finanzmarkt-Entscheidung NO_ACTION ohne `QuantAssessment`.
3. Persistenz: PostgreSQL-Adapter für `AppendOnlyStore`, `LedgerStore`; Registry/Champion-Board sind noch In-Memory.
4. Freigabe-Workflow: Approval-Objekt (wer, wann, Hash des Vorschlags) und erst dann eine Ausführung.
5. Historical Replay als Werkzeug (die Bausteine sind point-in-time, ein Replay-Runner fehlt).
6. Kalibrierung: Confidence → Wahrscheinlichkeit erst nach ausreichender Stichprobe (`calibrated: false`).
7. Scanner-Regeln erweitern und messen (Fehlalarme vs. Treffer); weitere Sprachen (Deutsch).
