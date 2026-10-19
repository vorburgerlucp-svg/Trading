// The deterministic risk gate of the eToro demo execution layer (O21). A pure function: the same input always gives the same
// verdict, and it has no side effect. It runs when an intent is created (risk approval) and again, with fresh input, right before
// a broker write. Every check that cannot be decided is a refusal (fail closed). Nothing in the intent, and nothing a model says,
// can switch a check off: the input is assembled by the service from trusted state, never from the request.
//
// Risk-increasing (an open) and risk-reducing (a close, a cancel) are separated, as in the portfolio safety envelope: a tripped kill
// switch or a missing safety decision blocks every open, and still allows a close of a known position.

import { Decimal } from '../../../money/decimal.js';
import type { Instrument, ProviderInstrumentMapping } from '../../../market-data/market-data-types.js';
import type { KillSwitchState } from '../../../safety/portfolio-safety-envelope.js';
import type { ExecutionIntent, IntentOrderType, IntentSide } from './execution-intent.js';

export const DEMO_EXECUTION_POLICY_VERSION = 'etoro-demo-execution-policy:v1' as const;
/** O22: the policy of the one controlled demo trading cycle (one market buy, one close, then nothing). v2: long-only, market-only. */
export const DEMO_E2E_CYCLE_POLICY_VERSION = 'etoro-demo-e2e-cycle-policy:v2' as const;
export type DemoExecutionPolicyVersion = typeof DEMO_EXECUTION_POLICY_VERSION | typeof DEMO_E2E_CYCLE_POLICY_VERSION;

/** The provider name of the human-governed eToro instrument mapping in the instrument registry. */
export const ETORO_MAPPING_PROVIDER = 'etoro';

export interface DemoExecutionPolicy {
  readonly version: DemoExecutionPolicyVersion;
  /** The most one open may invest (amount, or units times the quote), in USD. */
  readonly maxOrderInvestmentUsd: string;
  readonly maxLeverage: number;
  /** Open demo positions and live orders of NEXUS, including the new one. */
  readonly maxOpenPositions: number;
  /** Exposure (investment times leverage) of all live NEXUS demo intents plus the new one, in USD. */
  readonly maxGrossExposureUsd: string;
  readonly maxQuoteAgeMs: number;
  readonly maxSafetyDecisionAgeMs: number;
  readonly maxBrokerSyncAgeMs: number;
  /** An MIT trigger rate must be within this distance of the quote, in basis points. */
  readonly maxTriggerDistanceBp: number;
  /**
   * O22 cycle budget: how many open (close) intents may ever reach SUBMITTING, counted over the whole persistent intent log, whatever
   * their outcome (a rejected, ambiguous or crashed write counts). null = no budget. Checked in the reservation step, so it holds
   * across processes; once spent, no further write of that kind is possible without a code change.
   */
  readonly maxOpenSubmissions: number | null;
  readonly maxCloseSubmissions: number | null;
  /**
   * O22: the only sides and order types an open may have. Absent = no restriction (the O21 default). Checked by the gate at
   * creation and at execute, and again in the reservation step. A close is not affected: it closes a position by its id.
   */
  readonly allowedOpenSides?: readonly IntentSide[];
  readonly allowedOpenOrderTypes?: readonly IntentOrderType[];
}

/** Conservative demo defaults. A change is a code change and a review, never a request field. */
export const DEFAULT_DEMO_EXECUTION_POLICY: DemoExecutionPolicy = Object.freeze({
  version: DEMO_EXECUTION_POLICY_VERSION,
  maxOrderInvestmentUsd: '1000',
  maxLeverage: 1,
  maxOpenPositions: 3,
  maxGrossExposureUsd: '3000',
  maxQuoteAgeMs: 60_000,
  maxSafetyDecisionAgeMs: 5 * 60_000,
  maxBrokerSyncAgeMs: 5 * 60_000,
  maxTriggerDistanceBp: 1000,
  maxOpenSubmissions: null,
  maxCloseSubmissions: null,
});

/**
 * O22: the policy of the one controlled demo trading cycle, used by the runtime. One market buy of at most 100 USD at leverage 1, one
 * open position, and exactly one open and one close submission over the lifetime of the intent log: after them, every further write
 * is refused (CYCLE_*_BUDGET_EXHAUSTED). A timeout, an ambiguous answer or a crash spends the budget too, so it can never lead to a
 * second order. The open may only be a buy (long) at market: a sell (short) or an MIT open is refused (CYCLE_SIDE_NOT_ALLOWED,
 * CYCLE_ORDER_TYPE_NOT_ALLOWED). Stricter than the O21 default in every field.
 */
export const DEMO_E2E_CYCLE_POLICY: DemoExecutionPolicy = Object.freeze({
  version: DEMO_E2E_CYCLE_POLICY_VERSION,
  maxOrderInvestmentUsd: '100',
  maxLeverage: 1,
  maxOpenPositions: 1,
  maxGrossExposureUsd: '100',
  maxQuoteAgeMs: 60_000,
  maxSafetyDecisionAgeMs: 5 * 60_000,
  maxBrokerSyncAgeMs: 5 * 60_000,
  maxTriggerDistanceBp: 1000,
  maxOpenSubmissions: 1,
  maxCloseSubmissions: 1,
  allowedOpenSides: Object.freeze(['buy'] as const),
  allowedOpenOrderTypes: Object.freeze(['mkt'] as const),
});

export interface GateQuote {
  readonly last: Decimal;
  readonly bid: Decimal | null;
  readonly ask: Decimal | null;
  readonly currency: string | null;
  readonly observedAt: string;
  /** Production market data only: demo data is never usable for a broker order. */
  readonly production: boolean;
}

/**
 * What the gate reads of a portfolio safety decision. The O15 envelope decision (PortfolioSafetyDecision) and, since O22, the eToro
 * demo account decision (demo-account-safety.ts) both have this shape; the gate's checks are unchanged.
 */
export interface GateSafetyDecision {
  readonly asOf: string;
  readonly state: string;
  readonly canIncreaseRisk: boolean;
  readonly killSwitch: { readonly status: KillSwitchState['status'] };
  readonly hardBreachReasons: readonly string[];
  readonly capacityBlockReasons: readonly string[];
}

/** What NEXUS itself knows about its live demo intents. Derived from the intent log by the service. */
export interface GateBook {
  readonly liveIntentCount: number;
  readonly grossExposureUsd: Decimal;
  readonly instrumentHasLiveIntent: boolean;
  readonly anyAmbiguous: boolean;
  readonly activeDuplicate: boolean;
  /** For a close: the position was confirmed by an eToro order status for a FILLED or PARTIALLY_FILLED open intent of NEXUS. */
  readonly closeTargetKnown: boolean;
  /** For a close: another close of the same position is approved or may be live at the broker. */
  readonly closeTargetAlreadyClosing: boolean;
  /** O22: open and close intents that ever reached SUBMITTING (any outcome), over the whole intent log. */
  readonly openSubmissions: number;
  readonly closeSubmissions: number;
}

export interface GateInput {
  readonly phase: 'create' | 'execute';
  readonly intent: ExecutionIntent;
  readonly now: string;
  readonly policy: DemoExecutionPolicy;
  readonly buildLocked: boolean;
  readonly executionEnabled: boolean;
  readonly killSwitch: KillSwitchState;
  /** A decision of a trusted portfolio safety source, or null when none is connected. */
  readonly safety: GateSafetyDecision | null;
  readonly instrument: Instrument | null;
  readonly mapping: ProviderInstrumentMapping | null;
  readonly quote: GateQuote | null;
  readonly book: GateBook;
  readonly broker: { readonly connection: string; readonly lastSuccessfulSync: string | null };
  /** False while the local write pacing or a broker Retry-After forbids a write. */
  readonly writeSlotAvailable: boolean;
}

export type GateCheck = 'pass' | 'fail' | 'not_applicable' | 'not_available';

export interface GateVerdict {
  readonly passed: boolean;
  /** Fixed reason codes of this module, in check order. */
  readonly reasons: readonly string[];
  readonly checks: Readonly<Record<string, GateCheck>>;
  readonly policyVersion: DemoExecutionPolicyVersion;
}

interface BookCheck {
  readonly name: string;
  readonly reason: string;
  readonly applies: (opens: boolean) => boolean;
  readonly ok: (book: GateBook, exposureUsd: Decimal | null, policy: DemoExecutionPolicy, intent: ExecutionIntent) => boolean;
}

/** The checks that depend on the book of NEXUS intents. One table, used by the gate and by the atomic reservation. */
const BOOK_CHECKS: readonly BookCheck[] = Object.freeze([
  { name: 'maxExposure', reason: 'GROSS_EXPOSURE_ABOVE_LIMIT', applies: (o) => o, ok: (b, e, p) => e !== null && b.grossExposureUsd.plus(e).lte(p.maxGrossExposureUsd) },
  { name: 'maxOpenPositions', reason: 'OPEN_POSITIONS_ABOVE_LIMIT', applies: (o) => o, ok: (b, _e, p) => b.liveIntentCount + 1 <= p.maxOpenPositions },
  { name: 'existingPositionOrOrder', reason: 'INSTRUMENT_HAS_LIVE_POSITION_OR_ORDER', applies: (o) => o, ok: (b) => !b.instrumentHasLiveIntent },
  { name: 'noAmbiguousIntent', reason: 'AMBIGUOUS_INTENT_UNRESOLVED', applies: (o) => o, ok: (b) => !b.anyAmbiguous },
  { name: 'duplicateIntent', reason: 'DUPLICATE_INTENT', applies: () => true, ok: (b) => !b.activeDuplicate },
  // A close needs a position NEXUS proved from broker-confirmed state, and no other close for it. Identity checks still apply.
  { name: 'closeTargetKnown', reason: 'CLOSE_TARGET_UNKNOWN', applies: (o) => !o, ok: (b) => b.closeTargetKnown },
  { name: 'closeTargetNotClosing', reason: 'CLOSE_TARGET_ALREADY_CLOSING', applies: (o) => !o, ok: (b) => !b.closeTargetAlreadyClosing },
  // O22 cycle budget: spent by every submission, whatever its outcome. Never reset by a rejection, a timeout or a crash.
  { name: 'cycleOpenBudget', reason: 'CYCLE_OPEN_BUDGET_EXHAUSTED', applies: (o) => o, ok: (b, _e, p) => p.maxOpenSubmissions === null || b.openSubmissions < p.maxOpenSubmissions },
  { name: 'cycleCloseBudget', reason: 'CYCLE_CLOSE_BUDGET_EXHAUSTED', applies: (o) => !o, ok: (b, _e, p) => p.maxCloseSubmissions === null || b.closeSubmissions < p.maxCloseSubmissions },
  // O22 open restrictions: they read only the intent and the policy, and are in this table so that the reservation step checks
  // them again, immediately before SUBMITTING.
  { name: 'openSide', reason: 'CYCLE_SIDE_NOT_ALLOWED', applies: (o) => o, ok: (_b, _e, p, i) => p.allowedOpenSides === undefined || p.allowedOpenSides.includes(i.side) },
  { name: 'openOrderType', reason: 'CYCLE_ORDER_TYPE_NOT_ALLOWED', applies: (o) => o, ok: (_b, _e, p, i) => p.allowedOpenOrderTypes === undefined || p.allowedOpenOrderTypes.includes(i.orderType) },
]);

/**
 * The book checks alone, for the reservation step: the service runs them inside the critical section of the intent log, after it
 * caught up with every other process, so two intents cannot both pass against the same old book.
 */
export function bookRefusals(intent: ExecutionIntent, book: GateBook, exposureUsd: Decimal | null, policy: DemoExecutionPolicy): string[] {
  const opens = intent.action === 'open';
  return BOOK_CHECKS.filter((c) => c.applies(opens) && !c.ok(book, exposureUsd, policy, intent)).map((c) => c.reason);
}

function ageMs(now: string, at: string | null): number | null {
  if (at === null) return null;
  const ms = Date.parse(now) - Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

export function evaluateDemoExecutionGate(input: GateInput): GateVerdict {
  const reasons: string[] = [];
  const checks: Record<string, GateCheck> = {};
  const { intent, policy, now } = input;
  const opens = intent.action === 'open';
  const check = (name: string, ok: boolean, reason: string, applicable = true): void => {
    if (!applicable) {
      checks[name] = 'not_applicable';
      return;
    }
    checks[name] = ok ? 'pass' : 'fail';
    if (!ok) reasons.push(reason);
  };

  // Locks and configuration. At creation the intent is only risk-approved, so the build lock and the switch are checked at execute.
  const atExecute = input.phase === 'execute';
  check('buildLock', !input.buildLocked, 'ETORO_DEMO_EXECUTION_LOCKED_IN_BUILD', atExecute);
  check('executionEnabled', input.executionEnabled, 'ETORO_DEMO_EXECUTION_DISABLED', atExecute);

  // Expiry: an intent is never executed outside its window.
  const nowMs = Date.parse(now);
  check('intentWindow', Date.parse(intent.createdAt) <= nowMs && nowMs < Date.parse(intent.expiresAt), 'INTENT_EXPIRED_OR_NOT_YET_VALID');

  // Kill switch and portfolio safety envelope: both block risk increase only.
  check('killSwitch', input.killSwitch.status === 'ARMED', 'KILL_SWITCH_TRIPPED', opens);
  const safety = input.safety;
  const safetyAge = safety === null ? null : ageMs(now, safety.asOf);
  if (opens && safety === null) {
    checks.safetyEnvelope = 'fail';
    reasons.push('PORTFOLIO_SAFETY_NOT_CONNECTED');
  } else {
    check(
      'safetyEnvelope',
      safety !== null && safety.state === 'NORMAL' && safety.canIncreaseRisk && safety.killSwitch.status === 'ARMED' && safety.hardBreachReasons.length === 0,
      'PORTFOLIO_SAFETY_BLOCKS_RISK_INCREASE',
      opens,
    );
    check('safetyFreshness', safetyAge !== null && safetyAge >= 0 && safetyAge <= policy.maxSafetyDecisionAgeMs, 'PORTFOLIO_SAFETY_DECISION_STALE', opens);
  }
  // Drawdown limits are part of the envelope (daily loss, intraday drawdown): a breach makes its state TRIPPED or blocks risk.
  check('drawdownLimits', safety !== null && safety.hardBreachReasons.length === 0 && safety.capacityBlockReasons.length === 0, 'DRAWDOWN_OR_CAPACITY_LIMIT', opens);

  // Instrument identity: a known, active NEXUS instrument with a human-governed eToro mapping to exactly this eToro id.
  check('instrumentKnown', input.instrument !== null && input.instrument.active, 'INSTRUMENT_UNKNOWN_OR_INACTIVE');
  check(
    'instrumentMapping',
    input.mapping !== null && input.mapping.provider === ETORO_MAPPING_PROVIDER && input.mapping.instrumentId === intent.instrumentId && input.mapping.providerSymbol === String(intent.etoroInstrumentId),
    'INSTRUMENT_MAPPING_MISSING_OR_MISMATCH',
  );

  // Market data and quote: fresh, production, consistent, and in USD (the only order currency of the broker).
  const quote = input.quote;
  const quoteAge = quote === null ? null : ageMs(now, quote.observedAt);
  check('marketDataProduction', quote !== null && quote.production, 'MARKET_DATA_NOT_PRODUCTION', opens);
  check('quoteFreshness', quoteAge !== null && quoteAge >= 0 && quoteAge <= policy.maxQuoteAgeMs, 'QUOTE_STALE_OR_MISSING', opens);
  const quoteSane =
    quote !== null &&
    quote.last.isPositive() &&
    (quote.bid === null || quote.bid.isPositive()) &&
    (quote.ask === null || quote.ask.isPositive()) &&
    (quote.bid === null || quote.ask === null || quote.bid.lte(quote.ask));
  check('quoteIntegrity', quoteSane, 'QUOTE_INVALID', opens);
  check('quoteCurrency', quote !== null && quote.currency === 'USD' && input.instrument?.currency === 'USD', 'INSTRUMENT_NOT_USD', opens);

  // Sizing, leverage, exposure. The reference price is the trigger for MIT, else the quote.
  let investment: Decimal | null = null;
  if (opens && quoteSane && quote !== null) {
    investment = intent.amount !== null ? Decimal.from(intent.amount) : Decimal.from(intent.units ?? '0').times(quote.last);
  }
  check('positionSizing', investment !== null && investment.isPositive() && investment.lte(policy.maxOrderInvestmentUsd), 'ORDER_SIZE_ABOVE_LIMIT', opens);
  check('leverage', intent.leverage >= 1 && intent.leverage <= policy.maxLeverage, 'LEVERAGE_ABOVE_LIMIT', opens);
  const exposure = investment === null ? null : investment.times(intent.leverage);
  // Cash and margin: clientPortfolio.credit is not verified (O20), so they cannot be checked. The exposure limit applies instead.
  checks.cashMargin = opens ? 'not_available' : 'not_applicable';

  // Stop-loss and take-profit must sit on the right side of the reference price.
  if (opens && quote !== null && quoteSane) {
    const reference = intent.triggerRate !== null ? Decimal.from(intent.triggerRate) : quote.last;
    const long = intent.side === 'buy';
    const slOk = intent.stopLoss === null || (long ? Decimal.from(intent.stopLoss).lt(reference) : Decimal.from(intent.stopLoss).gt(reference));
    const tpOk = intent.takeProfit === null || (long ? Decimal.from(intent.takeProfit).gt(reference) : Decimal.from(intent.takeProfit).lt(reference));
    check('stopLossTakeProfit', slOk && tpOk, 'STOP_LOSS_OR_TAKE_PROFIT_ON_WRONG_SIDE');
    if (intent.triggerRate !== null) {
      const distanceBp = Decimal.from(intent.triggerRate).minus(quote.last).abs().times(10_000).dividedBy(quote.last, 4, 'half_even');
      check('triggerDistance', distanceBp.lte(policy.maxTriggerDistanceBp), 'MIT_TRIGGER_TOO_FAR_FROM_QUOTE');
    } else {
      checks.triggerDistance = 'not_applicable';
    }
  } else {
    check('stopLossTakeProfit', !opens, 'STOP_LOSS_OR_TAKE_PROFIT_UNCHECKABLE', opens);
    checks.triggerDistance = 'not_applicable';
  }

  // The book: exposure and position limits, one live intent per instrument, no new risk while anything is ambiguous, no duplicate,
  // and for a close a proved target that nothing else is closing. The same checks run again in the reservation step (bookRefusals).
  for (const c of BOOK_CHECKS) check(c.name, c.ok(input.book, exposure, policy, intent), c.reason, c.applies(opens));

  // Broker connectivity: the last read-only sync succeeded recently. Checked before an open is written. A close does not depend on
  // it: the O20 sync refuses a non-empty portfolio, and a known position must stay closable.
  const syncAge = ageMs(now, input.broker.lastSuccessfulSync);
  check('brokerConnectivity', input.broker.connection === 'connected' && syncAge !== null && syncAge >= 0 && syncAge <= policy.maxBrokerSyncAgeMs, 'BROKER_NOT_CONNECTED_OR_STALE', atExecute && opens);
  check('writePacing', input.writeSlotAvailable, 'BROKER_WRITE_PACING', atExecute);

  return Object.freeze({ passed: reasons.length === 0, reasons: Object.freeze(reasons), checks: Object.freeze(checks), policyVersion: policy.version });
}
