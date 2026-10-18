// O22: what has been PROVED about the eToro demo account values, as a compile-time record of this build. The demo account safety
// source (demo-account-safety.ts) reads it directly each time, like BUILD_LOCKS: there is no constructor option, configuration,
// environment variable or route for it. Changing a value is a reviewed code change that cites the observation it rests on.
//
// The valuation formulas are DOCUMENTED (official guides, checked 2026-10-18). The account values they use come from
// GET /api/v1/trading/info/demo/pnl. That response has been LIVE_OBSERVED only EMPTY (O21A.1, 2026-10-17): no position, no order.
// A non-empty /demo/pnl, the shape the valuation needs (positions with a nested unrealizedPnL), has NOT been observed. Until it is,
// the safety source answers null: the gate keeps refusing every open with PORTFOLIO_SAFETY_NOT_CONNECTED.

export interface DemoAccountValuationEvidence {
  /** A non-empty /demo/pnl was observed live, matched the REFERENCE_SCHEMA and was accepted by parseDemoPnlValuationInput. */
  readonly nonEmptyPnlLiveObserved: boolean;
  /** Where that observation is recorded (a docs/evidence path), null until it exists. */
  readonly evidenceRef: string | null;
  /** The account currency observed live: accountCurrencyId 1 ("1 = USD") in an empty /demo/pnl (O21A.1, direct GET). */
  readonly accountCurrencyIdObserved: 1;
  /**
   * The demo context of the keys: the operator checked that the key environment is Demo (O21A section 11, 2026-10-17), and the
   * reference states that each user key is valid for one environment only. Not an account identity: no account id is read.
   */
  readonly demoKeyEnvironment: 'operator_confirmed';
}

export const DEMO_ACCOUNT_VALUATION_EVIDENCE: DemoAccountValuationEvidence = Object.freeze({
  nonEmptyPnlLiveObserved: false,
  evidenceRef: null,
  accountCurrencyIdObserved: 1,
  demoKeyEnvironment: 'operator_confirmed',
});
