# NEXUS Persistence (v0.4): finanzielle Wahrheit, Audit, PostgreSQL

**PostgreSQL ist die kanonische Datenbank** für Capital Ledger, Idempotenz, Reservationen, Audit Events, Decision Records, Evidence-Metadaten, Model Registry, Model Performance und Memory-Metadaten. Firebase ist nie Source of Truth für Finanzdaten. Die In-Memory-Stores bleiben als Test- und Entwicklungsadapter erhalten. Beide Varianten laufen durch **dieselben Contract-Tests**.

Grundsatz: **Quell-Ereignisse speichern, Zustand reproduzierbar ableiten.** Abgeleitete Tabellen (Modellstatus, Scores, Snapshots) sind Caches und werden nie als Wahrheit gelesen.

## 1. Invarianten

| # | Invariante | Anwendung | Datenbank |
|---|---|---|---|
| I1 | Jede Buchung ist pro Währung exakt 0 | `structuralIssues` | Deferred Constraint Trigger beim COMMIT |
| I2 | ≥ 2 Lines, genau `line_count` Lines, keine leeren Lines | `structuralIssues` | Deferred Trigger + CHECK |
| I3 | Sequenz lückenlos 1..n pro Ledger | Projektion prüft beim Nachholen | PK + Link-Trigger (`sequence = head + 1`) |
| I4 | Eine lineare Hash-Kette, keine Verzweigung | Hash-Prüfung beim Laden und Nachholen | Link-Trigger, `UNIQUE (ledger_id, prev_hash)`, Kopf nur +1 |
| I5 | Idempotenz: eine ID wird höchstens einmal gebucht | Prüfung im kritischen Abschnitt, Fingerprint-Vergleich | `UNIQUE (ledger_id, entry_id)` |
| I6 | Atomarität: Buchung mit allen Lines oder gar nicht | eine DB-Transaktion | Transaktion + Deferred Trigger |
| I7 | Append-only | keine Update/Delete-API | Trigger lehnen UPDATE/DELETE/TRUNCATE ab |
| I8 | Kein Überziehen / Überverkauf, auch über mehrere Server | Guard gegen den *nachgeholten* Stand | Zeilensperre serialisiert alle Schreiber |
| I9 | Nur freigeschaltete Währungen, keine stille Umrechnung | `unsupported_currency` | Deferred Trigger gegen `allowed_currencies` |
| I10 | Ein Storno pro Buchung, nur auf bestehende Buchungen | Prüfung im Ledger | Partial UNIQUE Index + FK |
| I11 | Fail closed bei Korruption | `FINANCIAL_INTEGRITY_ERROR`, Ledger sperrt Lesen und Schreiben | (Erkennung in der Anwendung) |
| I12 | Point-in-Time | `balances({ asOf })`, Evidence/Memory `availableAt` | Zeitstempel als `TIMESTAMPTZ` |

## 2. Serialisierung (Concurrency)

Der **Store** besitzt den kritischen Abschnitt. Nur die Datenbank kann mehrere NEXUS-Server serialisieren; prozesslokale Queues sind lediglich eine Optimierung.

```text
BEGIN ISOLATION LEVEL READ COMMITTED
SET LOCAL lock_timeout = 15s
SELECT head_sequence FROM ledgers WHERE ledger_id = $1 FOR UPDATE    -- ein Schreiber pro Ledger, clusterweit
SELECT … WHERE sequence > <lokal bekannte Sequenz>                   -- Buchungen anderer Server
  → Ledger holt nach (prüft Hash, Kette, Struktur), prüft Idempotenz, Regeln (Guard), baut den Eintrag
INSERT transaction, INSERT lines 1..n                                -- Trigger prüfen Verkettung
COMMIT                                                               -- Deferred Trigger: Nullsumme, Vollständigkeit, Währung
```

- **READ COMMITTED ist Absicht:** Nach dem Warten auf die Sperre muss die nächste Abfrage die Zeilen des vorherigen Sperrinhabers sehen. Unter REPEATABLE READ wäre das nicht der Fall.
- Pro Ledger gibt es genau eine Sperre, die immer zuerst genommen wird; Deadlocks sind damit ausgeschlossen.
- **Unbekannter COMMIT-Ausgang** (Verbindung stirbt genau beim Commit): Die lokale Projektion wird nicht verändert. Ein Retry mit derselben Idempotency-ID liefert `ALREADY_APPLIED` (falls der Commit angekommen ist) oder `APPLIED`.
- Eine Verbindung, die mitten in der Transaktion stirbt, bringt den Prozess nicht zum Absturz (Error-Listener). PostgreSQL bricht die offene Transaktion selbst ab.
- Die generischen Logs (Evidence, Blackboard, Memory, Audit, Decisions, Registry, Champions) nutzen dasselbe Schema mit einer Sperre auf `append_only_logs`.

## 3. Idempotenz

- Jeder Befehl hat eine ID; externe Ereignisse bringen ihre stabile ID mit, z. B. `broker-fill:ibkr:ORDER123:FILL4`.
- Gespeichert wird zusätzlich ein **Request-Fingerprint** (Hash des Befehls und seiner normalisierten Eingabe, ohne Defaults wie „jetzt“).
- Ist die ID bereits gebucht und der Fingerprint gleich, lautet das Ergebnis `ALREADY_APPLIED`; nichts wird gebucht. Bei anderem Fingerprint wird `idempotency_conflict` geworfen; nichts wird gebucht oder überschrieben.
- Die Prüfung läuft **vor** dem Neuberechnen aus dem aktuellen Zustand. Ein wiederholter Verkaufs-Fill wird nicht gegen den heutigen Bestand neu bewertet.
- `UNIQUE (ledger_id, entry_id)` ist die zweite Verteidigungslinie.

## 4. Hash-Kette: manipulationsevident, nicht manipulationssicher

Jeder Eintrag enthält den Hash seines Vorgängers. Eine geänderte Zeile bricht die Kette, was beim Laden erkannt wird (getestet mit Superuser-Rechten und ausgeschalteten Triggern). **Aber:** Wer vollen Schreibzugriff auf die Datenbank hat, kann die Historie *und* alle Hashes konsistent neu erzeugen.

Dafür gibt es `LedgerCheckpointStore` mit Checkpoints (`ledgerId`, `sequence`, `hash`, `createdAt`, `signature`). Checkpoints gehören in **getrennten Speicher** und sollen später signiert werden. Eine vollständig neu geschriebene oder abgeschnittene Historie passt dann nicht mehr zum Checkpoint und wird beim Öffnen erkannt (`CHECKPOINT_MISMATCH`, `LEDGER_BEHIND_CHECKPOINT`). Vorhanden ist derzeit die Schnittstelle mit einer In-Memory-Implementierung; ein externer, signierter Speicher fehlt noch.

## 5. Start-Integritätsprüfung und fail-closed

`CapitalLedger.open(store, { checkpoints })` prüft Sequenz, Kette, Hashes, Nullsumme, Vollständigkeit (Line-Anzahl), Währungen, Stornos und den letzten Checkpoint. Bei einem Befund wirft es `FINANCIAL_INTEGRITY_ERROR` und öffnet nicht. `verifyStoredLedger()` liefert denselben Bericht ohne Exception, z. B. für einen Health-Endpoint.

Wird zur Laufzeit beim Nachholen eine ungültige Buchung entdeckt, sperrt sich der Ledger für alle Lese- und Schreibzugriffe. Das Brain synchronisiert zu Beginn jeder Entscheidung und bricht dann ab, **bevor** irgendetwas entschieden oder auditiert wird (getestet).

## 6. Snapshots und Reconciliation

- **Snapshots** (`ledger_snapshots`) sind ein Performance-Cache mit `sequence`, `ledger_hash`, `taken_at`, Salden, Summen und `state_hash`.
- `LedgerReconciliationService.reconcileSnapshot()` prüft die Historie, dann den Snapshot selbst (`state_hash`), dann ob der Ledger an dieser Sequenz noch denselben Hash hat. Danach baut er den Zustand **auf einem unabhängigen zweiten Rechenweg** neu auf und vergleicht. Ergebnis: `MATCH`, `RECONCILIATION_FAILURE` (mit Differenzen pro Konto und Summe) oder `SNAPSHOT_INVALID`. Es wird **nie still korrigiert**.
- Beispiel aus den Tests: Ledger CHF 487.30 gegen Cache CHF 477.30 ergibt `RECONCILIATION_FAILURE` mit `cashMinor 48730 ≠ 47730`.

## 7. Schema (Migrationen)

| Migration | Inhalt |
|---|---|
| `001_ledger.sql` | `ledgers`, `ledger_transactions`, `ledger_lines`, Trigger (Verkettung, Kopf, Vollständigkeit/Nullsumme/Währung, append-only), Views `ledger_reservations`, `ledger_account_balances` |
| `002_append_only_logs.sql` | `append_only_logs`, `append_only_records` (JSONB, verlustfreier Codec für bigint/Decimal), gleiche Ketten- und Schutzregeln |
| `003_domain_projections.sql` | `evidence`, `audit_events`, `model_runs`, `decision_records`, `decision_evidence`, `decision_model_runs`, `memory_records`, `blackboard_entries`, `model_registry_events`, `models` (Cache), `model_domain_scores` (Cache), `champion_changes`, `ledger_snapshots` |
| `004_market_data.sql` | `market_data_sources`, `instruments` und `provider_instrument_mappings` (Projektionen des Logs `instruments`), `instrument_events`, `market_data_heads` (lückenlose Ingest-Sequenz), `market_bars`, `market_quotes`, `corporate_actions` (eine Zeile pro Revision), `market_data_quarantine`, `quant_runs`. Details: [MARKET_DATA_QUANT.md](MARKET_DATA_QUANT.md) |

- Geld: `BIGINT` Minor Units plus `CHAR(3)` Währung. Mengen: `NUMERIC`. Kein Float für Geld; Werte jenseits von 2^53 Rappen sind getestet.
- Reservationen sind Ledger-Unterkonten (Quell-Ereignisse) und werden über eine View abgefragt; es gibt keine zweite, abweichende Kopie.
- Projektionen werden **in derselben Transaktion** wie der hash-verkettete Eintrag geschrieben und verweisen per FK auf ihn.
- Der **Migrationsrunner** (`src/persistence/postgres/migrator.ts`) arbeitet mit Versionen `NNN_name.sql`, je Migration einer Transaktion, SHA-256 pro Datei in `schema_migrations` und einem Advisory Lock. Eine nachträglich geänderte Migration, Lücken oder unbekannte Versionen führen zu einem Fehler. Destruktive Top-Level-Statements (`DROP`, `TRUNCATE`, `DELETE FROM`, `UPDATE … SET`, `ALTER TABLE … DROP/DISABLE TRIGGER`) werden verweigert. Funktionskörper von Triggern sind vom Scan ausgenommen und werden im Review geprüft. Es gibt keine automatische Schema-Synchronisation.

## 8. Audit und Decision Record

- **Audit Events** (append-only, hash-verkettet, `audit_events`): `TASK_CREATED`, `MODEL_SELECTED`, `MODEL_RESPONSE_RECEIVED`, `BLACKBOARD_ENTRY`, `CRITIC_STARTED`, `CONSENSUS_CREATED`, `QUANT_RESULT`, `RISK_DECISION`, `CAPITAL_PROPOSAL`, `HUMAN_APPROVAL`, `BROKER_SNAPSHOT`, `ORDER_INTENT`, `ORDER_EXECUTION`, `OUTCOME_RECORDED`, `DECISION_RECORDED`. Das Schema unterstützt Order-Events; in diesem Build erzeugt nichts solche Events.
- **DecisionRecord** (normalisiert) enthält `decisionId`, `taskId`, `createdAt`, `asOf`, `inputFingerprint`, `evidenceRefs`, `modelRuns`, Referenzen auf Quant/Consensus/Risk/Approval-Events, `capitalStateRef = ledger:<id>@<sequence>:<hash>#asOf=…`, `finalAction` (`NO_ACTION | WATCH | RECOMMEND | REJECT`) und `reasonCodes`. Beziehungen liegen in `decision_evidence` und `decision_model_runs`.
- `brain.trace(decisionId)` **rekonstruiert** die vollständige Entscheidung aus Record und Events. Getestet: identisch nach einem Neustart mit frischen Verbindungen.

## 9. Evidence, Model Registry, Champions

- **Evidence** ist unveränderlich. `observedAt`, `availableAt`, `retrievedAt`, `freshnessMs`/`expires_at`, `content_hash` und Metadaten werden gespeichert. Geänderter externer Inhalt erhält eine **neue** ID; die Wiederverwendung der alten ID ist ein Idempotenzkonflikt. Entscheidungen referenzieren die Version (Record-Hash).
- **Model Registry** ist event-sourced (Governance- und Telemetrie-Events). Der Zustand wird beim Laden neu abgeleitet und gegen die Governance-Regeln geprüft. Ein direkt geschriebenes Event wie „Aktivierung durch das System“ führt zu `GOVERNANCE_INTEGRITY_ERROR`. Die Tabelle `models` ist nur ein Cache.
- **Champions:** Jede Beförderung wird beim Laden gegen die gemessene Performance zu ihrem Zeitpunkt neu verifiziert. Eine DB-Änderung allein macht kein Modell zum Champion (getestet).
  - Die Beförderung speichert `performancePosition`, also die Memory-Position, die ihre Bewertung gesehen hat. Die Verifikation zählt genau diese Beobachtungen: verfügbar zum Bewertungszeitpunkt **und** bis dahin gespeichert. So können später nachgetragene Ergebnisse eine korrekte Beförderung nicht nachträglich in einen falschen `GOVERNANCE_INTEGRITY_ERROR` verwandeln (getestet).
  - Verweist eine Beförderung eines anderen Prozesses auf Beobachtungen, die lokal noch fehlen, wird sie zurückgehalten, bis die Performance nachgeladen ist. Fehlen die Beobachtungen danach immer noch, wird sie als Fälschung abgelehnt (fail closed, getestet). Initiale Champions kommen aus der reviewten Konfiguration, nie aus der Datenbank.

## 10. Prompt-Injection-Härtung

Der heuristische Quarantänefilter ist nur eine Zusatzschicht. Die primäre Grenze ist die **Struktur**: Alles von Web, News, Nutzer-Dokumenten oder Modellen ist Daten. Modelle erhalten andere Modellaussagen nur als `{ sourceType: 'model_claim', untrusted: true, claim, evidenceRefs }`, nie als Instruktion. Getestet ist auch eine Umgehungsvariante ohne Filtertreffer: Sie erreicht den Critic nur als untrusted Datenfeld, und die „Genehmigung“ des Critics hat keine Wirkung, weil Critics kein Stimmrecht und keine Freigabemacht haben.

## 11. Planner: `potentialCapitalImpact`

Die Analysetiefe richtet sich nach max(deklariertem Kapital, **potentialCapitalImpact**). Letzteres ist der grösste Betrag, den **diese konkrete Entscheidung** bewegen kann: min(Kapazität der Opportunity, Limits aus Capital Engine und Allocation Policy). Gesamtes verfügbares Kapital zählt nicht. Getestet: 100'000 CHF verfügbar und ein 20-CHF-Produkttest ergeben `single`; eine skalierbare 80'000-CHF-Opportunity ergibt `critical_committee`.

## 12. Confidence ≠ Wahrscheinlichkeit

`model_runs.confidence_score` (unkalibrierter Score) und `calibrated_probability` sind getrennte Felder. Eine Wahrscheinlichkeit darf nur mit dokumentierter Methode (`calibration_method`) existieren; die DB erzwingt das per CHECK. Ohne Kalibrierungsmodell mit genug Samples ist der Wert `null` (`src/ai/calibration.ts`).

## 13. Tests

- **Contract-Tests** (`test/contracts/`) laufen identisch gegen In-Memory (`test/persistence/in-memory-contracts.test.ts`) und PostgreSQL (`test/pg/contracts.pg.test.ts`). Mehrere Store-Handles mit eigenen Verbindungspools simulieren mehrere Server.
- **Integrationstests** (`test/pg/*.pg.test.ts`) laufen gegen einen **echten PostgreSQL-Server**:
  - lokal ein Wegwerf-Server aus den offiziellen Binaries (`@embedded-postgres/<platform>`, Dev-Abhängigkeit) mit zufälligem, nur im Speicher gehaltenem Passwort
  - oder `NEXUS_TEST_DATABASE_URL`, eine bestehende, entbehrliche Test-Datenbank, z. B. ein CI-Container
- Ist keines verfügbar, melden sich die PG-Tests als **übersprungen mit Grund** und nie als grün.
- Diagnose bei hängenden Tests: Mit `NEXUS_PG_WATCHDOG=1` werden langsame Setup-/Teardown-Schritte und blockierte DB-Sitzungen (inklusive Wait Event) gemeldet. Geht der Rechner während eines Laufs in den Standby, frieren Node und PostgreSQL ein und die Tests laufen in Timeouts. Das ist kein Codefehler, der Lauf muss wiederholt werden.

```bash
npm run test:unit
```

```bash
npm run test:pg
```

## 14. Betrieb (noch nicht umgesetzt, Empfehlung)

- Eigene DB-Rolle für die Anwendung **ohne** Eigentümerschaft der Tabellen und ohne `UPDATE`/`DELETE`-Rechte auf Historientabellen. Die Migrationen laufen unter einer separaten Rolle.
- `session_replication_role` und Superuser nur für Notfälle, mit Audit. Die Tests zeigen, dass eine Manipulation auf diesem Weg erkannt wird.
- Checkpoints regelmässig in getrennten Speicher (später signiert) schreiben; Backups mit Point-in-Time-Recovery.
