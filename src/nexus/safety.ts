// Safety configuration and the execution gate.
//
// BUILD_LOCKS are compile-time constants of this build. Even if the environment says
// TRADING_MODE=live and ALLOW_LIVE_TRADING=true, this build cannot place live orders or buy goods.
// Unlocking requires a code change, review and deployment by a human, never a model or a document.

import type { TradingMode } from '../contracts.js';
import type { CapitalBucket } from '../opportunities/opportunity-types.js';
import type { DecisionOutcome, ExecutionGateResult } from './nexus-types.js';

export const BUILD_LOCKS = Object.freeze({ liveTrading: true, brokerOrders: true, physicalPurchase: true } as const);

export interface SafetyConfig {
  readonly tradingMode: TradingMode;
  readonly allowLiveTrading: boolean;
}

/** Strict parsing: anything but the exact values falls back to the safe side. */
export function loadSafetyConfig(env: Readonly<Record<string, string | undefined>>): SafetyConfig {
  const mode = env.TRADING_MODE;
  return Object.freeze({
    tradingMode: mode === 'live' || mode === 'backtest' ? mode : 'paper',
    allowLiveTrading: env.ALLOW_LIVE_TRADING === 'true',
  });
}

const FINANCIAL_BUCKETS: readonly CapitalBucket[] = ['equities', 'crypto', 'forex', 'commodities', 'derivatives'];

export function isFinancialBucket(bucket: CapitalBucket | null): boolean {
  return bucket !== null && FINANCIAL_BUCKETS.includes(bucket);
}

/** In this build nothing is ever executed; a RECOMMEND may at most become a paper-trading intent. */
export function executionGate(input: { outcome: DecisionOutcome; bucket: CapitalBucket | null; safety: SafetyConfig }): ExecutionGateResult {
  const reasons: string[] = [];
  if (input.outcome !== 'RECOMMEND') reasons.push('no actionable recommendation');
  if (input.safety.tradingMode === 'live') {
    if (!input.safety.allowLiveTrading) reasons.push('LIVE_TRADING_DISABLED_BY_CONFIG');
    if (BUILD_LOCKS.liveTrading) reasons.push('LIVE_TRADING_LOCKED_IN_BUILD');
  }
  if (BUILD_LOCKS.brokerOrders) reasons.push('BROKER_ORDERS_LOCKED_IN_BUILD');
  const physical = input.bucket === 'physical_trade' || input.bucket === 'business';
  if (physical && BUILD_LOCKS.physicalPurchase) reasons.push('PHYSICAL_PURCHASE_LOCKED_IN_BUILD');
  return {
    liveOrderAllowed: false,
    physicalPurchaseAllowed: false,
    paperIntentAllowed: input.outcome === 'RECOMMEND' && isFinancialBucket(input.bucket) && input.safety.tradingMode === 'paper',
    reasons,
  };
}
