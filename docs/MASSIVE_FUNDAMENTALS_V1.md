# Massive Fundamentals V1

Status: **BLOCKED: CURRENCY_PROVENANCE_BLOCKER.** Design only. No connector, mapping or canonical fundamentals evidence is implemented on this branch.
Base: `daa84a9` (`feature/massive-news-schema-hardening`, pushed). Branch: `feature/massive-fundamentals-v1`. Not merged.

The brief is a hard correctness gate. Before any monetary value is mapped into canonical fundamentals, the currency or unit basis must be authoritatively
documented or provided. This branch checked the current official Massive documentation for the three GA endpoints. Neither the documentation nor the
response schema states a currency or unit basis, so the gate fails and the work stops here.

## 1. Evidence reviewed for currency provenance

Each page was fetched from Massive's official documentation during this session. The statements below are quoted or summarised from those pages.

| Endpoint | Source | Finding |
|---|---|---|
| income-statements | https://massive.com/docs/rest/stocks/fundamentals/income-statements.md | "No currency field, reporting-currency field, or unit field is documented. The page also gives no per-value unit. Monetary fields are plain numbers, and the sample values (for example, `revenue: 94036000000`) are unlabeled." |
| balance-sheets | https://massive.com/docs/rest/stocks/fundamentals/balance-sheets.md | No currency, reporting-currency or unit field. Monetary fields are typed only as `number`. Currency and scale are not specified. |
| cash-flow-statements | https://massive.com/docs/rest/stocks/fundamentals/cash-flow-statements.md | No currency, reporting-currency or unit field. The sample shows raw integers such as `27867000000` with no currency or scale. |

What this does not allow:

- Assuming USD because the ticker trades in the USA, because the trading currency is USD, because SEC data is involved, or because the request asked for USD.
  The brief states that trading currency is not statement reporting currency.
- Inferring currency from the SEC XBRL convention. That convention is ISO 4217 at the SEC, but it is not documented as Massive's convention for these records.

Result: **CURRENCY_PROVENANCE_BLOCKER**. No canonical fundamentals evidence is produced, and no fake success is reported.

## 2. What the official documentation does establish

These facts are recorded so that the next attempt starts from them. None of them resolves the blocker.

- Three flat GA endpoints: `GET /stocks/financials/v1/income-statements`, `/balance-sheets` and `/cash-flow-statements`. The deprecated `/vX/reference/financials` is not used.
- Query filters are `tickers` (plural, array-contains), `cik`, `fiscal_year` (integer), `fiscal_quarter` (integer 1 to 4), `timeframe` (`quarterly`, `annual`, `trailing_twelve_months`),
  `period_end` and `filing_date` with `.gt`, `.gte`, `.lt` and `.lte`, a `limit` (default 100, maximum 50000), and `sort`.
- `filing_date` is the date of the most recent SEC filing that carried the period's data. Later filings restate prior periods, so one filing date can
  cover several periods. Point-in-time selection uses `filing_date.lte`, not `period_end`.
- The `sort` parameter is documented as comma-separated columns with `.asc` or `.desc`. Only `period_end` (ascending, by default) is named. Sorting by
  `filing_date` is not documented, so this branch does not sort by it.
- Record metadata includes `tickers`, `cik`, `period_end`, `filing_date`, `fiscal_year`, `fiscal_quarter` and `timeframe`.
- Monetary and share values are JSON numbers, not strings. A pure `JSON.parse` path cannot guarantee exact decimal preservation for large values, so the parser
  boundary is a second gate (§4).
- No EBIT field exists. `ebitda` is a different concept, and EBIT must not be derived from it.
- There is no total-debt field. Debt is spread across `debt_current` and `long_term_debt_and_capital_lease_obligations`, and a total-debt formula would
  have to be documented and versioned before use.
- Capex is `purchase_of_property_plant_and_equipment`. The page says it is "typically reported as negative values". "Typically" leaves the convention
  approximate, and it is not a guarantee.
- Operating cash flow is `net_cash_from_operating_activities`.

## 3. What is needed to unblock (CURRENCY_PROVENANCE_BLOCKER)

One of the following, from Massive, before any monetary mapping is written:

1. Official documentation that states the currency or unit basis of the monetary values for these three endpoints, for example a unit field in each record, or
   a guarantee that every monetary value of a record is in one stated currency.
2. A written statement from Massive about the reporting currency of these records.
3. A live response, captured under an entitled key, that shows an explicit currency or unit indicator. Documentation alone is preferred, but a field that
   appears in a real response would also settle the question.

Until one of these exists, the currency gate fails, and NEXUS's rule that currency must be explicit stands unchanged.

## 4. Other gates recorded for the next attempt

- **Numeric boundary.** `JSON.parse` turns JSON numbers into binary floats. A numeric-lexical parser that keeps each number's decimal text must be designed and
  tested first, with mandatory cases for large integers, decimal EPS, negative capex, zero, null, scientific notation and values above `Number.MAX_SAFE_INTEGER`.
- **Capex sign.** The canonical convention must be chosen and documented. The provider's "typically negative" is not enough.
- **Free cash flow.** Not computed until the sign convention is fixed, and then only with a versioned formula.
- **Debt.** Null by policy until a total-debt formula is documented and versioned.
- **Zero.** A provider `0` may mean "not reported" rather than a filed zero. It is preserved as provided, with no inference, and the semantic limit is documented.
- **Provider publication instant.** The statements carry `filing_date` as a date only. `providerPublishedAt` stays null unless a real instant exists. The
  database seal alone proves NEXUS's knowledge time.
- **Entitlement.** Massive financials require a plan or add-on. A `403` with `NOT_AUTHORIZED` is an entitlement limit, mapped to `not_entitled`, and is not a code defect.
  No test may require a paid plan.

## 5. Design to build once the gates pass

- Connector `massive-fundamentals-rest` (provider `massive`, transport `rest`, capability `fundamentals`, mode `RESEARCH`, licence `unreviewed` with redistribution `unknown`).
- Period mapping: `YYYY-Q1..Q4` becomes `fiscal_year=YYYY`, `fiscal_quarter=N`, `timeframe=quarterly`; `YYYY-FY` becomes `fiscal_year=YYYY`, `timeframe=annual`. The fiscal
  quarter from the record is authoritative, and calendar quarters are not inferred from `period_end`.
- Point-in-time: every request includes `filing_date.lte` derived from `request.asOf`. No record with a later filing date is ever selected.
- Ticker: from `InstrumentRegistry` only, sent as `tickers` (plural).
- Coherence: the three selected records must agree on ticker, CIK where present, fiscal year, fiscal quarter, timeframe, and period end. A mismatch fails before evidence is built.
- Exact candidates: zero exact records is a deterministic missing-data error, and more than one candidate fails closed. Revisions are resolved only by a documented rule
  that never uses a filing after `asOf`.
- Raw provenance: `rawPayloadHash` is the canonical hash of `{ provider: "massive", incomeStatement, balanceSheet, cashFlowStatement, mappingPolicyVersion }`.
- Composite: the evidence is documented as produced from three HTTP responses, and it is not presented as one response.
- Failures: if any of the three calls fails, the whole request fails. No partial evidence is produced.

## 6. Not in this branch

No code, no tests, no ratios, no TTM, no market bars, no MCP, no migration. Migrations 001–012 are unchanged. Live Trading, Broker Orders and Physical Purchase remain LOCKED.
