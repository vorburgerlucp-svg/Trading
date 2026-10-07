# NEXUS Capital Engine (v0.2)

Die Capital Engine weiss jederzeit, **wo das Kapital steht**, und beantwortet die Kernfrage:
*Wo kann das aktuell verfügbare Kapital mit vertretbarem Risiko am sinnvollsten eingesetzt werden?*

**AI proposes. Quant verifies. Risk decides. Human approves critical capital movements.**

v0.2 enthält Datenmodelle, Services, Schnittstellen und Tests. Es wird **nichts ausgeführt**:
keine Brokerorder, keine Warenbestellung. Alle Vorschläge haben den Status `proposed`.

---

## 1. Überblick

```text
 Ereignisse (Einzahlung, Fill, Verkauf, Gebühr …)
        │  CapitalEngine / InventoryService  (einziger Schreibpfad, Geschäftsregeln)
        ▼
 CapitalLedger  ── unveränderlich, doppelte Buchführung, Hash-Kette, idempotent
        │  Salden (jederzeit rekonstruierbar, auch historisch)
        ▼
 PortfolioSnapshot = CapitalState + Positionen + Lager      ◄── Marktdaten (nur echt, sonst DATA NOT CONNECTED)
        │
        ├──► CapitalAllocator      ──► AllocationProposal   ─┐
        │         ▲                                         ├─► Capital Risk Gate ─► Mensch ─► (später) Ausführung
        └──► Reallocation          ──► ReallocationProposal ─┘
                  ▲
       OpportunityEngine (Aktie, Krypto, Kaugummi, Batterien … gleiches Schema, deterministischer Score)
```

## 2. Dateien

| Datei | Inhalt |
|---|---|
| `src/money/decimal.ts` | Exakte Festkomma-Dezimalzahl (bigint) für Mengen, Kurse, FX, Faktoren; explizite Rundungsmodi |
| `src/money/money.ts` | CHF als `Rappen` (gebrandeter bigint), Parsing, Basispunkte, Pro-rata, Aufteilung, Formatierung |
| `src/capital/capital-types.ts` | Kontenmodell, Buchungen, Marktdaten-Typen, `CapitalPolicy`, `CapitalState`, `PortfolioSnapshot` |
| `src/capital/accounts.ts` | Kontenplan: einzige Stelle, die Kontoschlüssel baut und parst |
| `src/capital/capital-ledger.ts` | Append-only Ledger, `LedgerStore`-Port, `InMemoryLedgerStore`, Hash-Kette |
| `src/capital/capital-engine.ts` | Befehle (Einzahlung, Fills, Gebühren, Reservationen, Storno) + `computePortfolioSnapshot` |
| `src/capital/portfolio.ts` | Positionen und Lagerbestände aus Salden + Bewertung mit frischen Kursen |
| `src/capital/capital-allocator.ts` | Allokationsvorschlag aus verfügbarem Kapital |
| `src/capital/capital-reallocation.ts` | Umschichtungsvorschläge aus bestehenden Positionen |
| `src/inventory/inventory-types.ts` | Produktstammdaten, Kostenmodell, Unit Economics, Lagerstand |
| `src/inventory/inventory-service.ts` | Unit Economics, Einkauf/Verkauf/Reservation von Ware, Produkt → Opportunity |
| `src/opportunities/opportunity-types.ts` | Gemeinsames Opportunity-Schema für alle Kapitalverwendungen |
| `src/opportunities/opportunity-engine.ts` | Validierung, Score, harte Gates, Lebenszyklus, Ranking |
| `src/risk-engine.ts` | bestehend `assessRisk` + neu `assessAllocationProposal`, `assessReallocationProposal` |
| `test/*.test.ts` | 85 Tests (Szenarien 1–10, Ledger, Geld, Inventar, Opportunities, Allocator, Umschichtung) |

## 3. Geld: keine Float-Logik

- **CHF-Beträge sind `Rappen`**: ganzzahliger `bigint` mit Typ-Brand. `20n` ist *kein* Geld; Beträge entstehen nur über
  `chf('35.50')`, `chfRounded(x, mode)` oder `rappen(units)`. Addieren/Subtrahieren ist exakt.
- `chf()` **verweigert** mehr als zwei Nachkommastellen: `chf(0.1 + 0.2)` wirft einen Fehler, statt still zu runden.
- **Mengen, Kurse, FX-Kurse** sind `Decimal` (bigint-Festkomma). Multiplikation ist exakt; Division und
  Skalenreduktion verlangen immer einen expliziten Rundungsmodus.
- **Rundungspolitik**: Wo eine Richtung sicherer ist, wird konservativ gerundet: Kosten, Downside und Reserve
  aufrunden, Budgets und erwartete Gewinne abrunden. Sonst `half_even`. Es wird nur **einmal** am Ende gerundet,
  nicht in Zwischenschritten.
- Vom Broker gemeldete Beträge werden **so gebucht, wie gemeldet** (`grossAmountChf`), nicht aus Menge × Kurs nachgerechnet.
- Scores und Verhältnisse (ROI, Opportunity Score) sind *kein Geld* und dürfen `number` sein.

## 4. Capital Ledger

**Doppelte Buchführung.** Jede Buchung (`JournalEntry`) besteht aus mindestens zwei Postings, deren Summe **exakt
0 Rappen** ist. Geld kann nicht aus dem Nichts entstehen oder verschwinden. Vermögen, Einlagen, realisierter P&L und
Gebühren ergeben sich aus den Salden, nie aus Frontend-Zahlen.

**Kontenplan** (`accounts.ts`):

```text
asset:cash:<bank|broker|crypto|physical>:<id>                  Cash (Stablecoins = crypto)
asset:cash:<typ>:<id>:reserved:<zweck>:<reservationId>         reserviertes Cash (Unterkonto)
asset:position:<broker>:<instrument>                           Position zu Anschaffungskosten (+ Menge)
asset:inventory:<produkt>[:reserved]                           Ware zu Einstandskosten (+ Menge)
asset:receivable:<gegenpartei>                                 Forderung (z. B. Marketplace-Auszahlung)
liability:payable:<gegenpartei> | liability:tax:<art>          Verbindlichkeiten, MWST
equity:contributions                                           Einlagen − Entnahmen
income:trading:<broker>:<instrument>                           realisierter Trading-P&L pro Position
income:sales:<produkt>                                         Warenumsatz (netto MWST)
expense:cogs:<produkt>                                         Wareneinsatz
expense:fee:<art>[:scope…] | expense:<shipping|advertising|returns|tax|other>[:scope…]
```

**Garantien des Ledgers** (strukturell, bei jedem Append):

| Garantie | Umsetzung |
|---|---|
| Ausgeglichen | Σ Postings = 0, sonst `unbalanced` |
| Idempotent | `id` ist eindeutig, eine erneut gesendete Broker-/Bankbuchung wird abgelehnt (`duplicate_id`) |
| Unveränderlich | Einträge werden eingefroren; keine Update-/Delete-API; Korrektur nur per `reversal` |
| Manipulationserkennung | SHA-256-Hash-Kette über kanonisches JSON; `open()` verweigert manipulierte Historie |
| Mengen nur wo sinnvoll | Menge Pflicht auf Positions-/Lagerkonten, verboten auf allen anderen |
| Keine Race Conditions | Appends sind serialisiert; Draft-Factory und Guard sehen exakt den Zustand, auf den gebucht wird |
| Zeitreise | `balances({ asOf })` rekonstruiert jeden historischen Stand (`occurredAt` ≠ `recordedAt`) |

**Geschäftsregeln** (CapitalEngine, im selben serialisierten Abschnitt): kein Cash-, Reservations- oder
Forderungskonto unter 0 (kein Überziehen), keine negative Stückzahl (kein Leerverkauf/Überverkauf), keine
Restkosten auf leerer Position, keine Überzahlung von Verbindlichkeiten. Geprüft werden nur die *berührten* Konten,
damit ein importierter Fakt (z. B. Margin-Soll aus einem Brokerauszug) nicht unbeteiligte Buchungen blockiert.

**Abbildung des Entwurfs `CapitalTransaction`**: `type`, `id`, `timestamp` (= `occurredAt`), `description`,
`opportunityId`/`tradeId`/`inventoryId` (= `refs`) bleiben. `amountChf` + `sourceAccount`/`destinationAccount`
werden zu Postings, weil ein Warenverkauf (Erlös, Gebühren, MWST, Wareneinsatz, Lagerabgang) mehr als zwei Seiten
hat. Neue Typen: `expense`, `liability_payment`, `reversal`.

## 5. Capital State

`engine.snapshot(options)` liefert den `PortfolioSnapshot` = `CapitalState` + Positionen + Lager, stets **neu
berechnet** aus Ledger-Salden + übergebenen Marktdaten.

| Feld | Definition |
|---|---|
| `totalNetWorthChf` | Cash + Finanzanlagen (Buchwert) + Ware zu Kosten + Forderungen − Verbindlichkeiten |
| `cash.*` | Saldo je Cash-Art inkl. reservierter Unterkonten; `unreservedChf` ohne Reservationen |
| `reservedCapitalChf` | interne Reservationen (`earmark`), jederzeit freigebbar |
| `committedCapitalChf` | Dritten zugesagt: offene Orders + zugesagte Einkäufe |
| `safetyReserveChf` | max(Mindestbetrag, % des Vermögens), aufgerundet (Policy) |
| `availableCapitalChf` | max(0, nicht reserviertes Cash − Verbindlichkeiten − Sicherheitsreserve) |
| `capitalShortfallChf` | Unterdeckung, falls Cash die Verbindlichkeiten + Reserve nicht deckt (statt negativer Verfügbarkeit) |
| `investedCapitalChf` | Finanzanlagen + Ware |
| `boundCapitalChf` | gebundenes Kapital = investiert + reserviert + zugesagt |
| `pnl.realizedChf` | Erträge − Aufwände aus dem Ledger (Trades, Verkäufe, Gebühren, Kosten) |
| `pnl.unrealizedChf` | Marktwert − Kosten offener Positionen; `null`, sobald eine Position keinen frischen Kurs hat |
| `pnl.totalChf` / `returnSinceStartBp` | Vermögen − Nettoeinlagen; einfache Rendite auf Nettoeinlagen |

**Verfügbares Kapital ist nicht der Kontostand**: Cash − offene Orders − Reservationen − zugesagte Einkäufe −
Verbindlichkeiten (fällige Kosten, Lieferantenrechnungen, MWST) − Sicherheitsreserve. Forderungen zählen erst nach
Zahlungseingang.

**Identität** (in Tests geprüft):
`Vermögen + Unterdeckung = Verfügbar + Sicherheitsreserve + Reserviert + Zugesagt + Investiert + Forderungen`.

**Bewertung** (`portfolio.ts`): Marktwert nur mit frischem Kurs (`maxQuoteAgeMs`) und, bei Fremdwährung, frischem
FX-Kurs. Fehlt etwas, ist der Marktwert `null`, die Position zählt zum Anschaffungswert, und `dataStatus` meldet
`not_connected` / `stale` / `partial` mit den betroffenen Positionen. **Ware wird zu Einstandskosten bewertet**,
erwartete Verkaufspreise sind Schätzungen und fliessen nie ins Vermögen.

## 6. Physical Inventory

- **Einstandskosten**: Kaufpreis + Eingangsfracht + Zoll werden aktiviert (`landedCosts`). Durchschnittskosten pro Produkt.
- **Verkauf**: Erlös (netto MWST) an `income:sales`, Wareneinsatz an `expense:cogs`, Marketplace-/Zahlungsgebühren,
  Versand, Werbung als Aufwand pro Produkt; Auszahlung netto auf ein Cash-Konto oder als Forderung (Marketplace-Payout).
- **Reservierte Einheiten** (offene Bestellungen) liegen auf `asset:inventory:<p>:reserved`, inkl. ihrer Kosten.
- **Lagerstand** (`stock()`): Bestand, reserviert, frei, verkauft (Stornos berücksichtigt), Kosten, Ø-Kosten, alles aus dem Ledger.
- **Unit Economics** (`calculateUnitEconomics`): MWST-Extraktion, Gebühren aufgerundet, Netto-Marge, ROI, Kapitalbindung.
  Beispiel Kaugummi: Einkauf 20, Verkauf 35, Kosten 5 → **Netto 10 CHF, ROI 50 %, 7 Tage**.
- **Produkt → Opportunity** (`toOpportunityInput`): Kapazität = min(lieferbar, absetzbar), Downside = Einheiten ×
  (Einstand − Restwert), Confidence = Sell-Through-Score. So konkurriert Ware direkt mit Trades.

## 7. Opportunity Engine

Ein Schema für alle Kapitalverwendungen (`OpportunityInput`). Die KI darf These und Schätzungen liefern, **setzt aber
nie ihren eigenen Score**. Der Score wird deterministisch berechnet:

```text
risikoadjustierter Gewinn   R = c · Gewinn − (1 − c) · Downside           (c = confidenceScore, unkalibriert)
Tagesrendite                r = R / Kapital / max(1, Haltedauer)
return     = r / (r + 0.005)        (sättigend: kleine Deals mit hohen % dominieren nicht)
safety     = 1 − min(1, Downside / Kapital)
risk       = 1 − riskScore          liquidity = liquidityScore
effort     = 1 − effortScore        regulatory = 1 − regulatoryRiskScore
opportunityScore = 100 · Σ wᵢ·cᵢ / Σ wᵢ      (w = 0.35 / 0.20 / 0.15 / 0.15 / 0.05 / 0.10, konfigurierbar)
capitalEfficiencyScore = 100 · return
```

**Harte Gates** (kein Score kann sie aufwiegen): Schätzungen nicht mit echten Daten verbunden (`DATA NOT CONNECTED`)
oder veraltet; kein positiver Nettogewinn nach Kosten; risikoadjustierter Gewinn ≤ 0; regulatorische Sperre.
Beispiel aus den Tests: BTC verspricht 15 % (mehr als Apple mit 8 %), ist risikoadjustiert aber negativ und wird nie finanziert.

**Lebenszyklus**: `discovered → research → approved → funded → active → exited`, jederzeit (vor `funded`) `rejected`.
`approved` nur durch einen **Menschen** und nur für zulässige Opportunities. Jeder Wechsel wird protokolliert.
`confidenceScore` bleibt als Score markiert (`calibrated: false`), bis die Learning Engine ihn kalibriert.

## 8. Capital Allocator (nur Vorschlag)

Deterministische Greedy-Verteilung in Score-Reihenfolge. Jede Opportunity erhält höchstens das Minimum aus:
Restbudget (`maxDeploymentBpOfAvailable`) · Cap pro Opportunity (CHF und % Vermögen) · Konzentrationsraum im Bucket
(inkl. bestehender Positionen) · Kapazität der Opportunity · Downside-Budget für neue Allokationen. Danach Rundung auf
Losgrösse; feste Tickets (z. B. ein Grosshandelslos) ganz oder gar nicht. Die bindende Grenze steht in der Begründung.

Kleine Deals mit hoher Rendite werden **bis zu ihrer Kapazität** gefüllt (Kaugummi: 20 CHF), der Rest fliesst zur
nächsten Opportunity. Buckets, die nicht in der Policy stehen, erhalten nichts. Ab einem Schwellwert
(CHF oder % Vermögen) ist **menschliche Freigabe** markiert.

## 9. Capital Reallocation (nur Vorschlag, immer menschliche Freigabe)

Erkennt Kapital, das in einer Position mit schwächerer Prognose gebunden ist, wenn eine Opportunity nicht aus freiem Cash
finanzierbar ist. **Nie allein wegen höherer prognostizierter Rendite.** Voraussetzungen:

1. explizite, verbundene Prognose für die bestehende Position (NEXUS nimmt nie an, eine Position sei schlechter)
2. frischer Kurs der Position (keine Fake-Bewertung)
3. Opportunity-Seite rechnet mit dem **risikoadjustierten** Gewinn minus aller Ausstiegskosten (Kommission, Spread, Steuer auf realisierten Gewinn)
4. beide Seiten über denselben Horizont (Haltedauer der Opportunity + Settlement-Tage)
5. Nettovorteil ≥ max(absolute Hürde, relative Hürde)
6. Zusatzrisiko, Mindest-Confidence und Mindest-Score eingehalten
7. höchstens ein Teil der Position pro Vorschlag (`maxReductionBpOfPosition`)
8. **selbstfinanzierend**: Verkaufsbetrag deckt Investition + Ausstiegskosten

Beispiel (Test): Aktie A 100 CHF, 3 % in 30 Tagen; Produkt 25 % in 14 Tagen → *Aktie A um 30 CHF reduzieren, 30 CHF
ins Produkt* (ohne Kosten). Mit 1 CHF Kommission + 10 bp Spread → 21.03 CHF verkaufen, 20 CHF investieren.

## 10. Capital Risk Gate

`assessAllocationProposal` und `assessReallocationProposal` in `src/risk-engine.ts` prüfen Vorschläge **unabhängig**
gegen den *aktuellen* Zustand: veraltete Vorschläge (Kapitalstand geändert), Summen, Doppelungen, Überschreitung des
verfügbaren Kapitals, Unterdeckung der Reserve, Position ohne Kurs, Investition > Nettoerlös. `passed` ersetzt nie
eine erforderliche menschliche Freigabe.

## 11. Entscheidungen

| # | Entscheidung | Begründung |
|---|---|---|
| 1 | Doppelte Buchführung statt einfacher Transaktionsliste | Ausgeglichenheit ist prüfbar; P&L, Einlagen, Gebühren fallen aus den Salden; Warenverkauf hat > 2 Seiten |
| 2 | Rappen als bigint, Mengen/Kurse als bigint-Dezimal, keine Library | Exakt, keine Abhängigkeit im Kern; Rundung immer explizit und getestet |
| 3 | Reservationen als Cash-Unterkonten | Kein Doppelreservieren, Verbrauch beim Bezahlen automatisch, alles im Ledger rekonstruierbar |
| 4 | Bewertung ist eine Sicht, keine Buchung | Ledger enthält nur Fakten; Mark-to-Market hängt von (evtl. fehlenden) Marktdaten ab |
| 5 | Finanzanlagen zum Marktwert nur mit frischem Kurs, Ware immer zu Kosten | Börsenkurse sind beobachtbar; Wiederverkaufspreise sind Schätzungen |
| 6 | Durchschnittskostenmethode | Einfach, deterministisch; Leeren einer Position löst exakt die Restkosten (kein Rundungsrest) |
| 7 | Asynchrone Schreib-API mit `LedgerStore`-Port | Persistenz (Postgres/Firestore) später ohne API-Bruch; optimistische Sequenzprüfung |
| 8 | Scores deterministisch im Code, nicht von der KI | „Quant verifies“: erklärbar, reproduzierbar, später durch Learning Engine kalibrierbar |
| 9 | Allocator/Reallocator geben nur Vorschläge zurück | Keine Ausführungspfade in v0.2; Risk Gate + Mensch vor jeder Kapitalbewegung |
| 10 | `TradePlan` in `contracts.ts` unverändert | KI-Schnittstelle bleibt stabil; Umrechnung in Rappen an der Grenze zur Capital Engine |

## 12. Offene Punkte

1. **Persistenz**: Entschieden: **PostgreSQL** (siehe NEXUS_MASTER_SPEC.md). Offen ist der `LedgerStore`-Adapter (append-only auf DB-Ebene, Sequenz-Constraint). Firebase wird nicht der kanonische Finanz-Ledger.
2. **Mehrwährung**: Ledger ist CHF-only. IBKR hält USD-Cash. Basis vorhanden: `src/money/currency.ts` (`Money { currency, minor }`, explizite, frische FX-Kurse). Offen: Postings mit Originalwährung + CHF-Gegenwert, FX-Gewinne/-Verluste auf eigenen Konten.
3. **Settlement**: Trade-Erlöse sind sofort Broker-Cash; settled vs. unsettled Cash (T+n) fehlt.
4. **Today's P&L / zeitgewichtete Rendite**: braucht historische Bewertungs-Snapshots (Kurse zum Tagesbeginn). Heute: einfache Rendite auf Nettoeinlagen.
5. **Wertberichtigung Ware** (Niederstwertprinzip) als explizite Ledger-Buchung; heute nur Warnsignal über Marktwert-Daten.
6. **Lots/FIFO** für Steuerzwecke (heute Durchschnittskosten).
7. **Stammdaten-Persistenz** für Produkte, Instrumente, Opportunities und Vorschläge (heute In-Memory).
8. **Freigabe-Workflow**: Approval-Objekt (wer, wann, welcher Vorschlag, Hash) → Ausführung über `BrokerAdapter` (bleibt gesperrt) bzw. manuelle Bestellung.
9. **Broker-Sync & Reconciliation**: IBKR Flex Query / eToro-Auszüge als `broker_sync`-Buchungen mit `externalRef`; Abgleich Ledger ↔ Broker.
10. **Korrelation** zwischen Positionen im Allocator (heute nur Bucket-Limits).
11. **Fälligkeiten von Verbindlichkeiten** (heute konservativ alle sofort fällig).
12. **Steuermodell Schweiz** (Privatanleger vs. gewerbsmässiger Handel, MWST-Pflicht) als Policy statt Parameter.
13. **Konfiguration**: `CapitalPolicy`, `AllocationPolicy`, `ReallocationPolicy` noch nicht aus `.env`/Config geladen; braucht validierten Loader.
14. **Kein Leerverkauf, keine Margin, kein Hebel**: bewusst durch die Guards blockiert.

## 13. Nächster Entwicklungsschritt

**Persistenter Ledger + serverseitige Capital-API + Dashboard-Kopfzeile mit echten Zahlen.**

1. `LedgerStore` auf einer echten Datenbank (append-only, Sequenz-Constraint, Backups) inkl. Integritätsprüfung beim Start.
2. Kleine Server-API (nur serverseitig, keine Keys im Browser): Einzahlung/Entnahme, Warenkauf/-verkauf manuell erfassen; `GET /capital/state` als DTO (Beträge als Dezimalstrings).
3. Dashboard-Kopfzeile: NET WORTH · AVAILABLE NOW · INVESTED · RESERVE · FINANCIAL MARKETS · PHYSICAL INVENTORY · Total P&L, mit `DATA NOT CONNECTED`, wo Kurse fehlen.
4. Danach: IBKR read-only Sync (Positionen, Cash, Fills) mit Reconciliation, ohne Order-Rechte.

Damit wird die 500-CHF-Challenge sofort mit echten, nachvollziehbaren Zahlen führbar, bevor irgendein Broker schreiben darf.
