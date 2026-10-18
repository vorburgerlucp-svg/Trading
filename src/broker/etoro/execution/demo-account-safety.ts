// O22: the portfolio safety source of the eToro DEMO account (B2 variant A: a verified account valuation, not a limit-only release).
//
// It values the whole demo account from one read of GET /api/v1/trading/info/demo/pnl with the formulas of the official guides
// ("Calculate Available Cash", "Calculate Total Invested", "Calculate Profit/Loss", "Calculate Equity", checked 2026-10-18):
//
//   Available Cash = credit - (Σ ordersForOpen.amount + Σ orders.amount)                       (mirrors are refused by the parser)
//   Total Invested = Σ positions.amount + Σ ordersForOpen.amount + Σ orders.amount + Σ ordersForOpen.totalExternalCosts
//   Unrealized PnL = Σ positions.unrealizedPnL.pnL
//   Equity         = Available Cash + Total Invested + Unrealized PnL
//
// Every position of the account counts, including positions the operator opened by hand (external to NEXUS): they enter the
// exposure, the position count and the equity, and they are never closed or reported as NEXUS positions. Nothing is subtracted.
//
// Fail closed, at every step:
//   - no evidence that a non-empty /demo/pnl was observed live (demo-account-evidence.ts): null, and no request is sent;
//   - the read fails, is not HTTP 200, or the parser refuses it: null;
//   - a value a formula needs is not stated (a position without unrealizedPnL.pnL, an order without totalExternalCosts, an account
//     currency other than USD or unknown): a DATA_HOLD decision, which cannot increase risk. It is never read as zero;
//   - a loss or drawdown limit is reached, equity is not positive, or the kill switch is tripped: TRIPPED (blocks every open);
//   - the account cannot take one more cycle order within the limits (exposure, positions and pending orders, available cash):
//     CAPACITY_BLOCK.
// The decision never allows a live order, never touches the ledger, and is only read by the demo execution gate.
//
// Risk day: each valuation that has all values is appended to an append-only log. The day start is the first valuation of the UTC
// day, the peak the highest equity of the day so far. A breach does not latch the shared kill switch (it is recomputed on every read);
// with the cycle budget of one open, a recovery after a breach cannot lead to more than that one open.

import { BrokerError } from '../../broker-errors.js';
import { Decimal } from '../../../money/decimal.js';
import { hashOf } from '../../../persistence/canonical-json.js';
import type { AppendOnlyLog } from '../../../persistence/append-only-log.js';
import type { KillSwitchState } from '../../../safety/portfolio-safety-envelope.js';
import type { PortfolioKillSwitchStore } from '../../../safety/portfolio-kill-switch-store.js';
import { parseDemoPnlValuationInput, type EtoroDemoPnlValuationInput } from '../etoro-pnl-validation.js';
import type { EtoroTransport } from '../etoro-transport.js';
import { DEMO_ACCOUNT_VALUATION_EVIDENCE } from './demo-account-evidence.js';

export const DEMO_ACCOUNT_SAFETY_DECISION_VERSION = 'etoro-demo-account-safety-decision:v1' as const;
export const DEMO_ACCOUNT_SAFETY_POLICY_VERSION = 'etoro-demo-account-safety-policy:v1' as const;

export interface DemoAccountSafetyPolicy {
  readonly version: typeof DEMO_ACCOUNT_SAFETY_POLICY_VERSION;
  /** Gross exposure of the WHOLE account (all positions and pending orders, external ones included) plus one reserved order. */
  readonly maxAccountGrossExposureUsd: string;
  /** Positions plus pending orders of the whole account, including the one reserved order. */
  readonly maxAccountPositionsAndOrders: number;
  /** The order the account must be able to take: the cycle's largest open (DEMO_E2E_CYCLE_POLICY.maxOrderInvestmentUsd). */
  readonly orderReserveUsd: string;
  readonly maxDailyLossUsd: string;
  readonly maxDailyLossBp: number;
  readonly maxDrawdownUsd: string;
  readonly maxDrawdownBp: number;
}

/**
 * The account limits of the one controlled cycle. A code constant for review. They are the cycle limits applied to the whole account:
 * with any other position or pending order in the account, the one 100 USD cycle open does not fit, and stays refused.
 */
export const DEMO_ACCOUNT_SAFETY_POLICY: DemoAccountSafetyPolicy = Object.freeze({
  version: DEMO_ACCOUNT_SAFETY_POLICY_VERSION,
  maxAccountGrossExposureUsd: '100',
  maxAccountPositionsAndOrders: 1,
  orderReserveUsd: '100',
  maxDailyLossUsd: '100',
  maxDailyLossBp: 100,
  maxDrawdownUsd: '100',
  maxDrawdownBp: 100,
});

export interface DemoAccountValues {
  readonly availableCashUsd: string;
  readonly totalInvestedUsd: string;
  readonly unrealizedPnlUsd: string;
  readonly equityUsd: string;
  /** Σ |amount × leverage + pnL| of all positions + Σ amount × leverage of all pending orders. */
  readonly grossExposureUsd: string;
  readonly positions: number;
  readonly pendingOrders: number;
  /** Positions an eToro order status confirmed for a NEXUS intent; all others are external. Reported only, never subtracted. */
  readonly nexusPositions: number;
  readonly externalPositions: number;
  readonly externalExposureUsd: string;
}

export type DemoAccountValuation =
  | { readonly kind: 'complete'; readonly values: DemoAccountValues }
  | { readonly kind: 'incomplete'; readonly dataHoldReasons: readonly string[] };

/** The guide formulas over a parsed response. A missing value is a data hold, never zero. Pure. */
export function valueDemoAccount(input: EtoroDemoPnlValuationInput, nexusPositionIds: ReadonlySet<number>): DemoAccountValuation {
  const holds: string[] = [];
  if (input.account.accountCurrencyId !== 1) holds.push('ACCOUNT_CURRENCY_NOT_USD_OR_UNKNOWN');
  if (input.ordersForOpen.length > 0 && input.account.ordersForOpenExternalCostsUsd === null) holds.push('ORDER_EXTERNAL_COSTS_UNKNOWN');
  if (input.positions.some((p) => p.unrealizedPnl === null || p.unrealizedPnl.pnlAccountCurrency === null)) holds.push('POSITION_PNL_UNKNOWN');
  if (holds.length > 0) return { kind: 'incomplete', dataHoldReasons: holds };

  const zero = Decimal.from(0);
  const pendingAmount = [...input.orders.map((o) => o.amountUsd), ...input.ordersForOpen.map((o) => o.amountUsd)].reduce((acc, a) => acc.plus(a), zero);
  const pendingExposure = [...input.orders, ...input.ordersForOpen].reduce((acc, o) => acc.plus(Decimal.from(o.amountUsd).times(o.leverage)), zero);
  const positionAmount = input.positions.reduce((acc, p) => acc.plus(p.amountUsd), zero);
  const pnl = input.positions.reduce((acc, p) => acc.plus(p.unrealizedPnl!.pnlAccountCurrency!), zero);
  const exposureOf = (p: (typeof input.positions)[number]): Decimal => Decimal.from(p.amountUsd).times(p.leverage).plus(p.unrealizedPnl!.pnlAccountCurrency!).abs();
  const positionExposure = input.positions.reduce((acc, p) => acc.plus(exposureOf(p)), zero);
  const external = input.positions.filter((p) => !nexusPositionIds.has(p.positionId));

  const availableCash = Decimal.from(input.account.creditUsd).minus(pendingAmount);
  const totalInvested = positionAmount.plus(pendingAmount).plus(input.account.ordersForOpenExternalCostsUsd ?? '0');
  const equity = availableCash.plus(totalInvested).plus(pnl);
  return {
    kind: 'complete',
    values: Object.freeze({
      availableCashUsd: availableCash.toString(),
      totalInvestedUsd: totalInvested.toString(),
      unrealizedPnlUsd: pnl.toString(),
      equityUsd: equity.toString(),
      grossExposureUsd: positionExposure.plus(pendingExposure).toString(),
      positions: input.positions.length,
      pendingOrders: input.orders.length + input.ordersForOpen.length,
      nexusPositions: input.positions.length - external.length,
      externalPositions: external.length,
      externalExposureUsd: external.reduce((acc, p) => acc.plus(exposureOf(p)), zero).toString(),
    }),
  };
}

export interface DemoRiskDay {
  readonly dayId: string;
  readonly startEquityUsd: string;
  readonly peakEquityUsd: string;
}

export type DemoAccountSafetyState = 'NORMAL' | 'DATA_HOLD' | 'CAPACITY_BLOCK' | 'TRIPPED';

export interface DemoAccountSafetyDecision {
  readonly schema: typeof DEMO_ACCOUNT_SAFETY_DECISION_VERSION;
  readonly decisionId: string;
  readonly policyVersion: typeof DEMO_ACCOUNT_SAFETY_POLICY_VERSION;
  readonly asOf: string;
  readonly state: DemoAccountSafetyState;
  readonly canIncreaseRisk: boolean;
  readonly canReduceRisk: true;
  readonly liveOrderAllowed: false;
  readonly killSwitch: KillSwitchState;
  readonly hardBreachReasons: readonly string[];
  readonly capacityBlockReasons: readonly string[];
  readonly dataHoldReasons: readonly string[];
  readonly values: DemoAccountValues | null;
  readonly riskDay: DemoRiskDay | null;
  readonly metrics: { readonly dailyLossUsd: string; readonly dailyLossBp: number; readonly drawdownUsd: string; readonly drawdownBp: number } | null;
}

function bp(part: Decimal, whole: Decimal): number {
  if (!whole.isPositive() || !part.isPositive()) return 0;
  return Number(part.times(10_000).dividedBy(whole, 0, 'ceil').toString());
}

/** The decision over a valuation, the risk day and the kill switch. Pure and deterministic. */
export function evaluateDemoAccountSafety(input: {
  asOf: string;
  valuation: DemoAccountValuation;
  riskDay: DemoRiskDay | null;
  killSwitch: KillSwitchState;
  policy: DemoAccountSafetyPolicy;
}): DemoAccountSafetyDecision {
  const { valuation, riskDay, policy } = input;
  const hard: string[] = [];
  const capacity: string[] = [];
  const holds: string[] = valuation.kind === 'incomplete' ? [...valuation.dataHoldReasons] : [];
  let metrics: DemoAccountSafetyDecision['metrics'] = null;
  const values = valuation.kind === 'complete' ? valuation.values : null;
  if (values !== null && riskDay === null) holds.push('RISK_DAY_UNKNOWN');
  if (values !== null && riskDay !== null) {
    const equity = Decimal.from(values.equityUsd);
    const start = Decimal.from(riskDay.startEquityUsd);
    const peak = Decimal.from(riskDay.peakEquityUsd);
    const zero = Decimal.from(0);
    const dailyLoss = start.minus(equity).isPositive() ? start.minus(equity) : zero;
    const drawdown = peak.minus(equity).isPositive() ? peak.minus(equity) : zero;
    metrics = { dailyLossUsd: dailyLoss.toString(), dailyLossBp: bp(dailyLoss, start), drawdownUsd: drawdown.toString(), drawdownBp: bp(drawdown, peak) };
    if (!equity.isPositive()) hard.push('EQUITY_NOT_POSITIVE');
    if (dailyLoss.gte(policy.maxDailyLossUsd) || metrics.dailyLossBp >= policy.maxDailyLossBp) hard.push('DAILY_LOSS_LIMIT');
    if (drawdown.gte(policy.maxDrawdownUsd) || metrics.drawdownBp >= policy.maxDrawdownBp) hard.push('DRAWDOWN_LIMIT');
    if (Decimal.from(values.grossExposureUsd).plus(policy.orderReserveUsd).gt(policy.maxAccountGrossExposureUsd)) capacity.push('ACCOUNT_EXPOSURE_LIMIT');
    if (values.positions + values.pendingOrders + 1 > policy.maxAccountPositionsAndOrders) capacity.push('ACCOUNT_POSITION_LIMIT');
    if (Decimal.from(values.availableCashUsd).lt(policy.orderReserveUsd)) capacity.push('AVAILABLE_CASH_BELOW_ORDER');
  }
  const killSwitchTripped = input.killSwitch.status !== 'ARMED';
  if (killSwitchTripped) hard.push('KILL_SWITCH_TRIPPED');
  const state: DemoAccountSafetyState = hard.length > 0 ? 'TRIPPED' : holds.length > 0 ? 'DATA_HOLD' : capacity.length > 0 ? 'CAPACITY_BLOCK' : 'NORMAL';
  const content = { asOf: input.asOf, state, hard, capacity, holds, values, riskDay, metrics, killSwitch: input.killSwitch.status, policy: policy.version };
  return Object.freeze({
    schema: DEMO_ACCOUNT_SAFETY_DECISION_VERSION,
    decisionId: 'edsd_' + hashOf(content).slice(0, 40),
    policyVersion: policy.version,
    asOf: input.asOf,
    state,
    canIncreaseRisk: state === 'NORMAL',
    canReduceRisk: true,
    liveOrderAllowed: false,
    killSwitch: input.killSwitch,
    hardBreachReasons: Object.freeze(hard),
    capacityBlockReasons: Object.freeze(capacity),
    dataHoldReasons: Object.freeze(holds),
    values,
    riskDay,
    metrics,
  });
}

/** One complete valuation, appended for the risk day. No account id, no position id, no raw response. */
export interface DemoAccountValuationRecord {
  readonly schema: 'etoro-demo-account-valuation:v1';
  readonly valuationId: string;
  readonly dayId: string;
  readonly observedAt: string;
  readonly equityUsd: string;
}

export type DemoAccountSourceStatus =
  | { readonly outcome: 'not_evaluated' }
  | { readonly outcome: 'no_evidence'; readonly at: string }
  | { readonly outcome: 'read_failed' | 'response_invalid'; readonly at: string; readonly code: string }
  | { readonly outcome: 'decision'; readonly at: string; readonly decision: DemoAccountSafetyDecision };

export interface EtoroDemoAccountSafetySourceDeps {
  /** The O20 read-only transport: the source calls exactly 'pnl.demo', one GET per evaluation, never retried. */
  transport: EtoroTransport;
  killSwitch: PortfolioKillSwitchStore;
  valuations: AppendOnlyLog<DemoAccountValuationRecord>;
  /** Position ids an eToro order status confirmed for NEXUS intents (to report external positions; nothing is subtracted). */
  nexusPositionIds: () => Promise<ReadonlySet<number>>;
  policy?: DemoAccountSafetyPolicy;
}

export class EtoroDemoAccountSafetySource {
  private last: DemoAccountSourceStatus = { outcome: 'not_evaluated' };
  private readonly policy: DemoAccountSafetyPolicy;

  constructor(private readonly deps: EtoroDemoAccountSafetySourceDeps) {
    this.policy = deps.policy ?? DEMO_ACCOUNT_SAFETY_POLICY;
  }

  /** The last evaluation, for the status route. No request. */
  status(): DemoAccountSourceStatus {
    return this.last;
  }

  /** The current decision, or null when it cannot be produced from verified data. Read at most once per call. */
  async current(now: string): Promise<DemoAccountSafetyDecision | null> {
    // The evidence record is a compile-time constant, read here each time; nothing can switch it at run time.
    if (!DEMO_ACCOUNT_VALUATION_EVIDENCE.nonEmptyPnlLiveObserved) {
      this.last = { outcome: 'no_evidence', at: now };
      return null;
    }
    let body: unknown;
    try {
      const response = await this.deps.transport.call('pnl.demo');
      if (response.status !== 200) {
        this.last = { outcome: 'read_failed', at: now, code: 'HTTP_' + response.status };
        return null;
      }
      body = response.body;
    } catch (error) {
      this.last = { outcome: 'read_failed', at: now, code: error instanceof BrokerError ? error.code : 'READ_FAILED' };
      return null;
    }
    let input: EtoroDemoPnlValuationInput;
    try {
      input = parseDemoPnlValuationInput(body);
    } catch (error) {
      this.last = { outcome: 'response_invalid', at: now, code: error instanceof BrokerError ? error.code : 'RESPONSE_INVALID' };
      return null;
    }
    const valuation = valueDemoAccount(input, await this.deps.nexusPositionIds());
    const riskDay = valuation.kind === 'complete' ? await this.recordAndReadDay(now, valuation.values.equityUsd) : null;
    await this.deps.killSwitch.sync();
    const decision = evaluateDemoAccountSafety({ asOf: now, valuation, riskDay, killSwitch: this.deps.killSwitch.current(), policy: this.policy });
    this.last = { outcome: 'decision', at: now, decision };
    return decision;
  }

  private async recordAndReadDay(now: string, equityUsd: string): Promise<DemoRiskDay> {
    const dayId = now.slice(0, 10);
    const content = { dayId, observedAt: now, equityUsd };
    const valuationId = 'edav_' + hashOf(content).slice(0, 40);
    await this.deps.valuations.append(valuationId, { schema: 'etoro-demo-account-valuation:v1', valuationId, ...content });
    await this.deps.valuations.sync();
    const today = this.deps.valuations.all().map((r) => r.payload).filter((v) => v.dayId === dayId);
    const first = today.reduce((a, b) => (Date.parse(b.observedAt) < Date.parse(a.observedAt) ? b : a));
    const peak = today.reduce((acc, v) => (Decimal.from(v.equityUsd).gt(acc) ? Decimal.from(v.equityUsd) : acc), Decimal.from(first.equityUsd));
    return { dayId, startEquityUsd: first.equityUsd, peakEquityUsd: peak.toString() };
  }
}
