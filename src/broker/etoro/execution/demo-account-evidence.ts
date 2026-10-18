// O22: what has been PROVED about the eToro demo account values, as a compile-time record of this build. The demo account safety
// source (demo-account-safety.ts) reads it directly each time, like BUILD_LOCKS: there is no constructor option, configuration,
// environment variable or route for it. Changing a value is a reviewed code change that cites the observation it rests on.
//
// The valuation formulas are DOCUMENTED (official guides, checked 2026-10-18). The account values they use come from
// GET /api/v1/trading/info/demo/pnl. LIVE_OBSERVED:
//   - empty (O21A.1, 2026-10-17), with accountCurrencyId 1;
//   - non-empty, twice (O22, 2026-10-18, one operator-approved read each, sanitized reports in docs/evidence):
//       1. structure: parser accepted; one position; nested unrealizedPnL with all schema keys; schema spelling; nothing undocumented;
//       2. the two remaining gaps: G1, every position's unrealizedPnL.pnL is a finite JSON number; G2, accountCurrencyId is 1.
//     The inputs parseDemoPnlValuationInput reads beyond parseDemoPnl (credit as a number, accountCurrencyId as a code, the external
//     costs of ordersForOpen) are proved by the same reports (credit: positive number; code 1; ordersForOpen empty).
// What this does NOT prove: a non-empty orders / ordersForOpen (never observed; any pending order blocks the cycle open anyway), and
// anything about trading. It enables the source to produce decisions; it releases nothing: the build lock and the account limits stay.

export interface DemoAccountValuationEvidence {
  /** A non-empty /demo/pnl was observed live, matched the REFERENCE_SCHEMA and its valuation inputs were proved (G1, G2). */
  readonly nonEmptyPnlLiveObserved: boolean;
  /** Where those observations are recorded (docs/evidence paths), null until they exist. */
  readonly evidenceRef: string | null;
  /** The account currency observed live: accountCurrencyId 1 ("1 = USD") (O21A.1 empty; O22 non-empty, report 2). */
  readonly accountCurrencyIdObserved: 1;
  /**
   * The demo context of the keys: the operator checked that the key environment is Demo (O21A section 11, 2026-10-17), and the
   * reference states that each user key is valid for one environment only. Not an account identity: no account id is read.
   */
  readonly demoKeyEnvironment: 'operator_confirmed';
}

export const DEMO_ACCOUNT_VALUATION_EVIDENCE: DemoAccountValuationEvidence = Object.freeze({
  nonEmptyPnlLiveObserved: true,
  evidenceRef: 'docs/evidence/O22_etoro_demo_pnl_observation_2026-10-18.json; docs/evidence/O22_etoro_demo_pnl_observation_2026-10-18_2.json',
  accountCurrencyIdObserved: 1,
  demoKeyEnvironment: 'operator_confirmed',
});
