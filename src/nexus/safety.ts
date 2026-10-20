// Safety configuration and the execution gate.
//
// BUILD_LOCKS are compile-time constants of this build. Even if the environment says
// TRADING_MODE=live and ALLOW_LIVE_TRADING=true, this build cannot place live orders or buy goods.
// Unlocking requires a code change, review and deployment by a human, never a model or a document.

import type { TradingMode } from '../contracts.js';
import type { CapitalBucket } from '../opportunities/opportunity-types.js';
import type { DecisionOutcome, ExecutionGateResult } from './nexus-types.js';

// etoroDemoExecution (O21) is a separate lock for eToro DEMO execution only. It does not touch brokerOrders, which stays the lock of
// every live or real broker order. true = locked: the demo execution layer refuses every broker write in this build.
//
// O22 B1 RELEASE (draft, docs/O22_DEMO_RELEASE_PROPOSAL.md): opened for exactly ONE controlled eToro DEMO cycle under the runtime
// policy etoro-demo-e2e-cycle-policy:v2 (one market buy of at most 100 USD at leverage 1, one close, then the cycle budget refuses
// every further write). liveTrading, brokerOrders and physicalPurchase stay locked. The runtime still needs ETORO_DEMO_EXECUTION_ENABLED=1,
// ETORO_TRADING_MODE=demo and operator authentication. This build must be re-locked right after the cycle (feature/o22-demo-cycle-relock).
export const BUILD_LOCKS = Object.freeze({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: false } as const);

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
