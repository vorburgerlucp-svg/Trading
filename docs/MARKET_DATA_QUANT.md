# NEXUS Market Intelligence Foundation V1: Marktdaten und Quant Engine

**Echte Marktdaten → geprüfte kanonische Daten → deterministische Quant-Berechnung → auditierbares QuantResult.**

Dieser Baustein funktioniert vollständig ohne OpenAI, Claude oder Gemini. Eine KI darf Quant-Ergebnisse später *interpretieren*, aber nie RSI, MACD, Pivots oder ATR selbst erfinden. Quant liefert Beschreibungen des Marktes (Trend, RSI, Levels), **keine Handelsempfehlung und keine Wahrscheinlichkeit**.

```text
Provider (Twelve Data, später Massive/IBKR/eToro)
  → strikte Schema-Validierung (untrusted input)
  → kanonische Bars (Decimal, UTC, isFinal, observedAt/availableAt/retrievedAt)
  → Validierung + Quarantäne (nie still reparieren)
  → Market Data Store (idempotent, revisioniert, lückenlose Ingest-Sequenz)
  → Point-in-Time-Read (asOf + storedThrough) + Data Quality
  → Quant Engine (reine Funktionen) → QuantResult (Fingerprint, Versionen) → quant_runs
```

Code: `src/market-data/`, `src/quant/`, Migration `db/migrations/004_market_data.sql`.

## 1. Provider-Architektur

- `MarketDataProvider` ist das Port-Interface mit `searchInstruments`, `getInstrument`, `getHistoricalBars`, `getQuote`, `getCorporateActions?` und `health`. Strategien und die Quant Engine sprechen nie direkt mit einem Provider. Die Orchestrierung übernimmt `MarketDataService`.
- Die Domain kennt keine Provider-IDs. Provider-Symbole existieren nur als `ProviderInstrumentMapping` mit Gültigkeitszeitraum.
- **Rollen** (`PROVIDER_ROLES`):

  | Provider | Status | Rolle |
  |---|---|---|
  | Twelve Data | IMPLEMENTIERT | globale Marktdaten: Discovery, historische Bars, Quotes |
  | Massive | GEPLANT | weitere Marktdatenquelle |
  | IBKR | GEPLANT | Broker Source of Truth: Positionen, Cash, Execution, Broker-Marktdaten |
  | eToro | GEPLANT | Portfolio, Broker State, Execution, Broker-Quote-Verifikation |

  Breites Scanning hängt nie von einem Broker ab.

- **Mehrere Provider:** Jede Bar, Quote und Corporate Action trägt ihre Quelle (`source` = Provider + Dataset + Umgebung). Abweichende Kurse verschiedener Provider gelten nicht automatisch als Korruption. Source Priority und Cross-Provider-Validierung folgen später (`provider_disagreement` ist als Code reserviert).
- **Lizenz und Herkunft:** `market_data_sources` speichert Provider, Dataset, Umgebung (`production | demo | test_fixture`) und die Lizenzklasse (`internal_use | display_allowed | redistributable | not_redistributable | unreviewed`). Twelve Data steht auf `unreviewed`, bis ein Mensch die Vertragsbedingungen geprüft hat. Demo- und Fixture-Daten sind **nie handelbar** (`usableForTrading = false`).

## 2. Twelve Data Adapter

- **Schlüssel:** `TWELVE_DATA_API_KEY`, nur serverseitig. Der Schlüssel wird nur im `Authorization`-Header gesendet, nie in der URL, und liegt in einem echten privaten Feld (`#apiKey`). JSON-Ausgabe und Inspect enthalten ihn nicht. Provider-Meldungen werden vor dem Weiterreichen von ihm bereinigt (getestet).
- **Ohne Schlüssel** gilt `fromEnv()` als null, also ist kein Provider vorhanden (DATA NOT CONNECTED). Es gibt keine Ersatzdaten.
- **Zeit:** Intraday wird mit `timezone=UTC` angefragt. Tagesbars sind Handelsdaten der Börse; Twelve Data ignoriert `timezone` bei `1day`. Sie werden auf das Kalenderfenster abgebildet (lokale Mitternacht bis Mitternacht). Ob ein Bar `isFinal` ist, entscheiden Kalender und Abrufzeit (Settle: intraday 60 s, täglich 15 min), nie eine Annahme.
- **Robustheit:**
  - Timeout; Retry nur bei Timeout, Netzwerkfehler, 5xx und 429
  - exponentielles Backoff mit Jitter; `Retry-After` (Sekunden oder HTTP-Datum) wird respektiert, 429 ohne Header wartet mindestens 15 s
  - Circuit Breaker mit Half-open-Probe und Health-Status
  - kein Retry bei ungültigem Symbol, Auth, fehlender Berechtigung, Bad Request oder Schemafehler; Programmierfehler werden nie als „transient“ wiederholt
  - Paging: Eine volle Seite (5000 Zeilen) lädt die Restfenster auf beiden Seiten nach, ohne Dubletten. Eine Meldung „No data“ zählt als leeres Fenster.
- **Schema:** Jede Antwort wird strikt validiert (Quelle: offizielle OpenAPI-Spezifikation).
  - Preise müssen reine Dezimalzahlen sein; Exponent-Notation wird abgelehnt.
  - `{"close":"IGNORE ALL RULES"}` ergibt `schema_invalid`. Die ganze Antwort wird verworfen, ohne Retry, und nichts erreicht die Domain.
  - Freitext (Instrumentname) wird von Steuerzeichen bereinigt, gekürzt und bleibt Daten.
- **MIC:** Twelve Data meldet das genaue Börsensegment (AAPL → `XNGS`). Für Prüfung und Kalender wird es auf den Betreiber-MIC abgebildet (`XNGS/XNCM/XNMS → XNAS`). Dieser Befund stammt aus dem echten API-Kontakt.
- **Demo-Schlüssel:** Der dokumentierte öffentliche Demo-Schlüssel akzeptiert nur Minimal-Requests (Symbol, Intervall, Outputsize). Der Adapter hat dafür einen Minimal-Modus: Börsenzeit wird DST-korrekt in UTC umgerechnet, und die Daten werden ehrlich als `split_adjusted` (Provider-Default) und Umgebung `demo` markiert.

## 3. Instrument Registry

- Die `instrumentId` ist opak und dauerhaft. Ein Tickerwechsel (`changeSymbol`) schliesst die alte Zuordnung und öffnet die neue in einem einzigen Event.
- Ein Backfill über den Wechsel fragt pro Zeitfenster das jeweils gültige Symbol ab (`mappingsOverlapping`, getestet: FB → META).
- Die Registry ist event-sourced auf dem hash-verketteten Log `instruments`, die Projektion schreibt in `instruments`, `provider_instrument_mappings` und `instrument_events`.
- Regeln (auch beim Replay geprüft):
  - keine überlappenden Zuordnungen
  - Zeitzone, Währung und Asset-Klasse sind unveränderlich, weil sie gespeicherte Historie umdeuten würden
  - Änderungen nur durch Mensch oder System
- Eine regelwidrig direkt geschriebene Zuordnung ergibt `INSTRUMENT_REGISTRY_INTEGRITY_ERROR`.

## 4. Kanonische Bars, Zeit, Sessions

- **Zeit:**
  - Intern ist alles UTC. Zeitstempel ohne `Z` gelten als mehrdeutig und werden abgelehnt.
  - Die Börsen-Zeitzone bleibt Metadatum.
  - DST-Umrechnung läuft über `Intl`, ohne handgeschriebene Regeln. Nicht existierende lokale Zeiten werden abgelehnt.
- **Bar:**
  - Fenster `[startTime, endTime)`; Preise als Decimal; Volumen optional und nie erfunden
  - `session`: `regular | extended | continuous`; `adjustment`: `raw | split_adjusted | total_return_adjusted`
  - `isFinal`, `observedAt`, `availableAt`, `retrievedAt`
- **Kalender** (`src/market-data/sessions.ts`):
  - **Exchange**, z. B. XNYS und XNAS:
    - Regular Hours 09:30–16:00 New York, Wochenenden, Feiertage und Early Closes um 13:00
    - Daten aus dem offiziellen NYSE-Kalender (abgerufen 2026-10-08), Nasdaq 2026 gegengeprüft; Abdeckung 2026–2027
    - Ausserhalb der Abdeckung ist ein Wochentag „unknown“ und die Session nur *angenommen*: Gemeldet wird `calendar_coverage`, keine falsche Lücke und keine falsche Sicherheit.
    - Extended Hours (04:00–20:00) sind nicht verifiziert und deshalb immer „angenommen“.
  - **24/7** (Crypto): eine Session pro UTC-Tag; eine fehlende Sonntagskerze ist eine Lücke.
  - **24/5** (FX): Sonntag 17:00 bis Freitag 17:00 New York, DST-abhängig in UTC.
- **1h-Bars einer Aktie** beginnen um 09:30. Der letzte endet am Sessionschluss um 16:00, nicht 16:30.

## 5. Datenqualität und Freshness

`MarketDataQualityService` liefert `{ valid, severity, issues[], usableForTrading, usableForBacktest }`.

| Schwere | Codes |
|---|---|
| critical | `invalid_number`, `invalid_ohlc`, `negative_price` (ausser bei explizit erlaubten Instrumenten), `invalid_time` (u. a. finaler Bar vor seiner Fertigstellung „verfügbar“), `future_timestamp`, `conflicting_duplicate` |
| error | `mixed_series` (Raw/Adjusted, Quelle, Intervall gemischt), `not_yet_available` (Look-ahead), `misaligned_interval`, `outside_session` (Börse), `missing_bars` ohne Daten |
| warning | `gap` (kalenderbasiert), `missing_bars` (Fensterrand), `stale`, `partial_bar`, `out_of_order`, `duplicate` (identisch), `calendar_coverage`, `calendar_unknown`, `non_production_source` |

**Handelbar** sind Daten nur, wenn alle folgenden Bedingungen erfüllt sind:
- valide und frisch
- kein Partial Bar und kein Fehlbestand am Ende
- Kalender bekannt und verifiziert
- Quelle `production`

Fehlerhafte Bars werden **nie repariert**: Sie gehen in die Quarantäne (`market_data_quarantine`, Rohdaten als JSON).

**Freshness** kennt keine globale Zahl. Sie hängt ab von Asset-Klasse, Intervall, Session (offen oder geschlossen) und Use Case:
- Aktienquote bei offenem Markt: 15 s für den Handel, 5 min für die Analyse.
- Bei geschlossenem Markt zählt eine Quote, wenn sie den letzten Schluss widerspiegelt.
- Bars sind frisch, solange laut Kalender höchstens N *erwartete* Bars fehlen (Handel: intraday 1, täglich 0). Eine Freitagskerze ist am Sonntag also für eine Aktie aktuell, für BTC nicht.

## 6. Persistenz

| Tabelle | Inhalt |
|---|---|
| `market_data_sources` | Herkunft und Lizenzklasse, unveränderlich |
| `instruments`, `provider_instrument_mappings`, `instrument_events` | Registry-Projektion (Wahrheit: hash-verketteter Log) |
| `market_data_heads` | lückenlose Ingest-Sequenz pro Instrument |
| `market_bars`, `market_quotes`, `corporate_actions` | eine Zeile pro **Revision**, append-only |
| `market_data_quarantine` | abgewiesene Rohdatensätze |
| `quant_runs` | unveränderliches Audit jeder Quant-Berechnung |

**Schlüssel:**
- Bars: `(instrument, source, interval, session, adjustment, start_time, revision)`
- Quotes: `(instrument, source, observed_at, revision)`
- Corporate Actions: `(instrument, source, action_key, revision)`

**Idempotenz und Revisionen:**
- Ein identischer Datensatz ergibt `unchanged`. Gleiches Fenster mit anderem Inhalt ergibt eine **neue Revision**; nichts wird überschrieben.
- Eine Revision ist erst ab ihrem Abruf sichtbar (`availableAt ≥ retrievedAt`), sodass eine Provider-Korrektur nie in die Vergangenheit rutscht.
- Final → in-progress wird abgewiesen.

**Reproduzierbarkeit:** Jede Ingest-Operation bekommt die nächste Nummer der Sequenz `ingest_seq`, unter Zeilensperre und lückenlos. Ein Read mit `storedThrough` liefert genau die damals gespeicherten Daten, auch nach späteren Backfills mit alten Zeitstempeln. Der QuantRun speichert `storedThrough`; `QuantService.replay()` beweist die Identität (auf PostgreSQL getestet).

**Datenbank-Invarianten** (Trigger und CHECK):
- OHLC-Konsistenz, Volumen ≥ 0
- `ingest_seq = head + 1`
- `revision = vorherige + 1`
- keine Final-Regression und keine Revision vor ihrem Abruf
- finaler Intraday-Bar nicht vor seinem Ende verfügbar
- UPDATE/DELETE/TRUNCATE verboten

Gelesene Zeilen werden neu gehasht; eine Abweichung ergibt `MARKET_DATA_INTEGRITY_ERROR` (fail closed, getestet mit Superuser-Manipulation).

## 7. Corporate Actions

- Splits, Reverse Splits, Bardividenden und Symbolwechsel werden getrennt gespeichert und revisioniert. Dividenden werden *unadjustiert* abgefragt (`adjust=false`).
- **Raw-Bars sind die kanonische Quelle.** `split_adjusted` wird für einen Zeitpunkt `asOf` abgeleitet (`splitAdjustBars`): Ein Split zählt nur, wenn er bei `asOf` bekannt war (`availableAt ≤ asOf`) **und** sein Ex-Datum erreicht ist. Ein künftiger Split gelangt nie unbemerkt in einen Backtest.
- Abgeleitete Bars erben `availableAt`/`retrievedAt` = max(Bar, Split), denn der angepasste Preis ist erst mit dem Split bekannt. Diese Regel wurde nach einem gefundenen Fehler ergänzt.
- Die Rechnung ist exakt mit Decimal; nicht teilbare Faktoren werden half-even auf Eingangsskala + 6 Stellen gerundet.
- Raw und Adjusted werden nie gemischt (Fehler `mixed_series`); abgeleitete Bars werden nicht gespeichert.
- **Annahme bei Backfills:** Ein historisch nachgeladener Split gilt spätestens ab Ex-Datum als bekannt (`availableAt = min(Abruf, Ex-Datum 00:00 Börsenzeit)`).
- **Nicht umgesetzt:** Total-Return-Adjustierung (Dividenden) als abgeleitete Serie. Gespeichert werden darf sie nur, wenn sie vom Provider explizit so geliefert wird.

## 8. Quant Engine V1: exakte Konventionen

Reine Funktionen (`src/quant/indicators`, `src/quant/structure`), O(n), ohne HTTP, KI oder Datenbank.

**Präzision:** Statistiken laufen in float64, ausschliesslich mit +, −, ×, ÷, abs und sqrt. Diese Operationen sind korrekt gerundet, also bitgleich deterministisch; `Math.pow`, `exp` und `log` werden nicht verwendet. Ausgaben werden auf 12 signifikante Stellen normalisiert. Preislevels (Pivots, Swings, S/R) sind exakte Decimals. Aus Indikator-Floats wird nie gebucht.

| Kennzahl | Version | Konvention | Erster Wert (Warm-up) |
|---|---|---|---|
| SMA(n) | `sma:arithmetic:v1` | arithmetisches Mittel der letzten n Closes | Index n−1 |
| EMA(n) | `ema:sma-seed:v1` | α = 2/(n+1); **Seed = SMA der ersten n Werte**; e ← e + α(x − e) | Index n−1 |
| RSI(14) | `rsi:wilder:v1` | Wilder: erste Mittel = arithmetische Mittel der Gewinne/Verluste aus Änderung 1…n; danach (m·(n−1) + x)/n. Nur Gewinne = 100, nur Verluste = 0, keine Bewegung = **50** | Index n |
| MACD(12,26,9) | `macd:ema-sma-seed:v1` | EMA12 − EMA26 (eigenständige SMA-geseedete EMAs); Signal = EMA9 der MACD-Linie, Seed = SMA der ersten 9 MACD-Werte; Histogramm = MACD − Signal | MACD ab 25, Signal ab 33 |
| ATR(14) | `atr:wilder:v1` | TR = max(H−L, \|H−C₋₁\|, \|L−C₋₁\|); TR₀ existiert nicht; erster ATR = Mittel TR₁…TRₙ; Wilder-Glättung | Index n |
| ADX(14) | `adx:wilder-sum-seed:v1` | +DM/−DM nach Wilder; Wilder-Summen, Startwert = **Summe** der ersten n (Lehrbuch; TA-Lib startet mit n−1 + Glättung); DI = 100·S(DM)/S(TR); DX = 100·\|+DI − −DI\|/(+DI + −DI); ADX = Mittel DX(n…2n−1), dann Wilder | +DI/−DI/DX ab n, ADX ab 2n−1 |
| Bollinger(20,2) | `bollinger:sma-population-stddev:v1` | Mitte = SMA; **Populations-σ** (÷N); Bänder = Mitte ± 2σ; %B und Bandbreite | Index n−1 |
| VWAP | `vwap:session-typical-price:v1` | Σ(TP·V)/ΣV, TP = (H+L+C)/3, **Reset pro Session** (Kalender); fehlt Volumen in der Session, ist der VWAP *unavailable*; nur intraday | erster Bar mit Volumen |
| Pivots classic | `pivots:classic:v1` | aus der **vorherigen abgeschlossenen** Periode: P = (H+L+C)/3 (half-even, Eingangsskala + 4); R1 = 2P−L, S1 = 2P−H, R2 = P+(H−L), S2 = P−(H−L), R3 = H+2(P−L), S3 = L−2(H−P) | 1 abgeschlossene Periode |
| Pivots Fibonacci | `pivots:fibonacci:v1` | P wie oben; R/S = P ± {0.382, 0.618, 1.000}·(H−L), exakt | dito |
| Swings | `swings:fractal-strict-left:v1` | Hoch bei i: strikt über allen `leftBars` links, ≥ allen `rightBars` rechts (das erste von gleichen Hochs gewinnt); Tief gespiegelt; **confirmedAt = availableAt des Bars i + rightBars** (Default 3/3) | Index left + right |
| Support/Resistance | `sr:swing-cluster:v1` | bestätigte Swings der letzten 500 Bars; nach Preis sortiert, gieriges Clustering mit Toleranz 0.5·ATR(14), sonst 0.5 % des Closes; Level = Mittel (Decimal), ≥ 2 Berührungen; confirmedAt = Bestätigung der 2. Berührung; strengthScore = 0.6·min(1, Berührungen/5) + 0.4·Aktualität, ein **Quant-Score, keine Wahrscheinlichkeit** | 2 bestätigte Swings |
| Market Structure | `structure:swing-hhll:v1` | HH/LH/EH und HL/LL/EL gegen den vorherigen Swing; HH+HL = bullish, LH+LL = bearish, sonst range; weniger als 2 Hochs und 2 Tiefs = unknown | 2 + 2 Swings |

**QuantResult:**
- `quantRunId` = `qr_` + Fingerprint; gleiche Eingaben ergeben dieselbe ID.
- `inputFingerprint` über Engine-, Algorithmus- und Parameter-Versionen, Instrument, Serie, asOf, Modus, Use Case und die tatsächlich verwendeten Bars.
- `dataQuality`, `algorithmVersions`, `parameters`, Indikatoren mit `status` (`ok | insufficient_data | unavailable`), `requiredBars` und `availableBars`.
- Pivots (mit Basis-Periode), Swings, S/R, Struktur, `insufficientData`, `warmupStatus`, `createdAt`. `createdAt` ist nicht Teil des `resultHash`.
- **Zu wenig Historie ergibt keinen Wert**, nie einen erfundenen.
- Fail closed: Ist die Datenqualität `error` oder `critical`, wird nichts berechnet.
- **Selbstschutz:** Dieselbe `quantRunId` mit anderem Ergebnis wird vom Store abgewiesen (`QUANT_RUN_CONFLICT`). Das deutet auf Nicht-Determinismus oder eine Formeländerung ohne Versionssprung hin.

**Neue Formel = neue Version.** Alte `quant_runs` bleiben unverändert (DB-Trigger).

## 9. Kein Look-ahead

- Die Engine schneidet die Eingabe zuerst auf `availableAt ≤ asOf`, `startTime < asOf` und standardmässig `isFinal`. Alles danach (Qualität, Indikatoren, Swings, Fingerprint) sieht nur diese Auswahl.
- **Pflichttest:** Alle Bars nach T werden massiv verändert, dazu kommen eine spätere Korrektur und ein bildender Bar. Das Ergebnis für T bleibt kanonisch identisch (täglich und intraday mitten in der Session).
- **Swings:** Ein Hoch auf Bar 10 mit `rightBars = 3` ist vor Bar 13 unbekannt. Zusätzlich gilt die Präfix-Eigenschaft auf Zufallsserien: Ein einmal bestätigter Swing ändert sich durch spätere Bars nie.
- Pivots stammen nur aus abgeschlossenen Perioden, VWAP setzt sich pro Session zurück, S/R und Struktur verwenden nur bestätigte Swings, in-progress-Bars bestätigen nie einen Swing.
- Ein finaler Bar, der vor seiner Fertigstellung (Tagesbar: Sessionschluss) als verfügbar markiert ist, ist **kritisch** (fail closed).
- **Gleiche Mathematik für LIVE und BACKTEST:** Beide laufen über denselben `QuantService` mit `asOf` (+ `storedThrough`).

## 10. Tests und Messungen

**Golden Tests:**
- Von Hand aus den Formeln hergeleitete Werte für SMA, EMA, RSI, MACD, ATR, ADX (inkl. +DI/−DI/DX), Bollinger, VWAP sowie Pivots classic und Fibonacci.
- Querprüfung gegen eine **unabhängige Referenzimplementierung** mit exakten Brüchen (`test/quant/reference.ts`). Sie verwendet keine Engine-Funktion.

**Property-Tests:** Konstante und monotone Serien, Wertebereiche, Verschiebungs- und Skalierungsinvarianz, Determinismus, Präfix-Stabilität der Swings.

**Real Provider Smoke Test** (`npm run test:live`, nicht Teil von `npm run check`):
- Mit `TWELVE_DATA_API_KEY` (Produktion) oder `NEXUS_TWELVE_DATA_DEMO=1` (öffentlicher Demo-Schlüssel); ohne beides wird er als NOT RUN übersprungen.
- **Lauf am 2026-10-08:** öffentlicher Demo-Schlüssel, AAPL (XNGS → XNAS), `1d`, Bereich 2026-09-24 bis 2026-10-08.
- Antwort: 1 Request, 9 echte Tagesbars, 9 eingefügt, 0 in Quarantäne.
- Erster Bar 2026-09-25 (04:00Z bis 04:00Z, final ab 20:00Z), letzter 2026-10-07 (Close 336.67001).
- Quote: last 336.67001, beobachtet 2026-10-07T19:59Z.
- Datenqualität valid; einzige Warnung `non_production_source` (demo), also nicht handelbar.

**Benchmark** (`npm run bench`; synthetische 1-Minuten-Bars, 24/7; Windows-Laptop, Werte schwanken um etwa ±50 %):

| | 10'000 Bars | 100'000 Bars |
|---|---|---|
| einzelner Indikator (SMA, EMA, RSI, MACD, ATR, ADX, Bollinger, Swings) | 1–5 ms | 5–35 ms |
| Datenqualität (inkl. Kalender) | ≈ 80 ms | ≈ 1.0–1.8 s |
| computeQuant gesamt | ≈ 0.2 s | ≈ 3.5 s |

**Komplexität:**
- Alle Bausteine sind O(n). Ausnahmen: Bollinger O(n·Periode); Swings O(n·(links + rechts)); S/R O(S log S) über S Swings im Lookback.
- Gemessen ist das Verhältnis 100k/10k = 15–25 statt der idealen 10. Die Ursache sind Allokation und GC (100k Decimal-Objekte). Ein Micro-Benchmark mit *konstanter* Eingabe zeigt dasselbe Wachstum der Kosten pro Aufruf.
- Zwei echte O(n·k)-Stellen wurden beim Messen gefunden und behoben: das Parsen im Sortier-Komparator und das Kopieren der Session-Gruppe pro Bar.

## 11. Grenzen von V1 (ehrlich)

- Nur Twelve Data ist implementiert. Massive, IBKR und eToro sind nur als Rollen geplant.
- Der Produktions-Schlüssel ist nicht konfiguriert. Der echte Test lief mit dem Demo-Schlüssel (minimale Requests, split-adjustierte Daten). Produktionspfad (Raw, Datumsbereich, `mic_code`), Splits/Dividenden und Paging sind gegen Antwortformen der offiziellen Spezifikation getestet, nicht live.
- Kalender: nur US-Aktien (2026–2027 verifiziert), 24/7 und FX 24/5 (ohne FX-Feiertage). Extended Hours sind nicht verifiziert. Andere Börsen (z. B. SIX) fehlen; ohne Kalender ist nichts handelbar.
- Backfill-Annahme: Ein historisch erstmals geladener finaler Bar gilt ab seiner Fertigstellung als verfügbar. Provider-Korrekturen *vor* unserem ersten Abruf sind unsichtbar.
- Lizenzklassen sind `unreviewed`. Eine Neuklassifizierung braucht eine eigene, nachvollziehbare Historie, die noch fehlt.
- Keine Total-Return-Adjustierung, kein BOS/CHOCH, keine Liquidity Sweeps, keine Cross-Provider-Konsens-Engine.
