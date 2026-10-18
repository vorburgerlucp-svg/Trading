// O22: what a portfolio safety source for the eToro demo account would need, and which of it NEXUS can prove today. A pure report:
// it is not a safety decision, it is never passed to the execution gate, and it cannot open anything. The runtime safety source stays
// NO_DEMO_SAFETY_SOURCE, so every open is still refused with PORTFOLIO_SAFETY_NOT_CONNECTED.
//
// An input that is unknown, unverified or stale is never read as zero, as sufficient or as approved. The O15 envelope values a
// portfolio in CHF from the NEXUS capital ledger; the demo account is valued by eToro in USD and is not in the ledger. Its equity,
// available cash and day P&L have no verified source yet: clientPortfolio.credit is documented but its meaning is not verified, and
// a non-empty /demo/pnl has never been observed. Until such a source exists and is reviewed, connected stays false.

import type { EtoroSnapshotView } from '../etoro-broker-service.js';
import type { KillSwitchState } from '../../../safety/portfolio-safety-envelope.js';

export const DEMO_SAFETY_READINESS_VERSION = 'etoro-demo-safety-readiness:v1' as const;

export type ReadinessStatus = 'verified' | 'not_verified' | 'not_available' | 'stale' | 'blocking';

export interface ReadinessItem {
  readonly input: 'accountContext' | 'positionsAndOrders' | 'grossExposure' | 'availableFunds' | 'drawdownAndLossLimits' | 'dataFreshness' | 'killSwitch';
  readonly status: ReadinessStatus;
  readonly reason: string;
}

export interface DemoSafetyReadiness {
  readonly schema: typeof DEMO_SAFETY_READINESS_VERSION;
  /** Always false in this build: no verified demo account valuation exists. */
  readonly connected: false;
  /** What the gate answers for every open while connected is false. */
  readonly gateReason: 'PORTFOLIO_SAFETY_NOT_CONNECTED';
  readonly items: readonly ReadinessItem[];
}

export interface DemoSafetyReadinessInput {
  readonly now: string;
  readonly broker: { readonly connection: string; readonly lastSuccessfulSync: string | null };
  readonly snapshot: EtoroSnapshotView | null;
  readonly killSwitch: KillSwitchState;
  readonly maxSyncAgeMs: number;
}

export function assessDemoSafetyReadiness(input: DemoSafetyReadinessInput): DemoSafetyReadiness {
  const syncAge = input.broker.lastSuccessfulSync === null ? null : Date.parse(input.now) - Date.parse(input.broker.lastSuccessfulSync);
  const fresh = input.broker.connection === 'connected' && syncAge !== null && Number.isFinite(syncAge) && syncAge >= 0 && syncAge <= input.maxSyncAgeMs && input.snapshot?.freshness === 'fresh';
  const coverage = input.snapshot?.content.coverage ?? null;
  const items: ReadinessItem[] = [
    {
      input: 'accountContext',
      status: 'not_verified',
      reason: coverage === null ? 'no snapshot' : 'the portfolio states no account identity (accountIdentity: ' + coverage.accountIdentity + '); demo context rests on the demo route and keys only',
    },
    {
      input: 'positionsAndOrders',
      status: coverage === null ? 'not_available' : fresh ? 'verified' : 'stale',
      reason: coverage === null ? 'no snapshot' : 'positions: ' + coverage.positions + ', orders: ' + coverage.openOrders + (fresh ? '' : ' (not fresh)'),
    },
    { input: 'grossExposure', status: 'not_available', reason: '/demo/portfolio has no current rate; a current valuation of the demo positions is not verified' },
    { input: 'availableFunds', status: 'not_verified', reason: 'clientPortfolio.credit is documented as available balance, its meaning is not verified; cash is not_read' },
    { input: 'drawdownAndLossLimits', status: 'not_available', reason: 'no verified demo equity or day P&L series; the O15 envelope values the CHF ledger, which does not hold the demo account' },
    { input: 'dataFreshness', status: fresh ? 'verified' : 'stale', reason: fresh ? 'last read-only sync within the limit' : 'no fresh successful read-only sync' },
    {
      input: 'killSwitch',
      status: input.killSwitch.status === 'ARMED' ? 'verified' : 'blocking',
      reason: input.killSwitch.status === 'ARMED' ? 'kill switch armed' : 'kill switch tripped: every open is refused',
    },
  ];
  return Object.freeze({ schema: DEMO_SAFETY_READINESS_VERSION, connected: false, gateReason: 'PORTFOLIO_SAFETY_NOT_CONNECTED', items: Object.freeze(items) });
}
