// O22: a readable report of the demo account safety: which input NEXUS can prove right now, from the evidence record, the last
// evaluation of the demo account safety source, the O20 sync and the kill switch. It is a report, never a decision: the gate reads
// only the source's decision. An input that is unknown, unverified or stale is never reported as verified.

import type { EtoroSnapshotView } from '../etoro-broker-service.js';
import type { KillSwitchState } from '../../../safety/portfolio-safety-envelope.js';
import { DEMO_ACCOUNT_VALUATION_EVIDENCE } from './demo-account-evidence.js';
import type { DemoAccountSourceStatus } from './demo-account-safety.js';

export const DEMO_SAFETY_READINESS_VERSION = 'etoro-demo-safety-readiness:v2' as const;

export type ReadinessStatus = 'verified' | 'operator_confirmed' | 'not_verified' | 'not_available' | 'stale' | 'blocking';

export interface ReadinessItem {
  readonly input: 'accountContext' | 'valuationEvidence' | 'positionsAndOrders' | 'grossExposure' | 'availableFunds' | 'drawdownAndLossLimits' | 'dataFreshness' | 'killSwitch';
  readonly status: ReadinessStatus;
  readonly reason: string;
}

export interface DemoSafetyReadiness {
  readonly schema: typeof DEMO_SAFETY_READINESS_VERSION;
  /** True only when the source is wired AND the evidence record allows it to produce decisions. */
  readonly connected: boolean;
  /** The source's last decision state, or null. Only NORMAL lets the gate pass the safety checks. */
  readonly lastDecisionState: string | null;
  readonly lastDecisionAt: string | null;
  /** The reasons the last evaluation gave (gate reason, hard, capacity and data-hold reasons, or the read failure). */
  readonly reasons: readonly string[];
  readonly items: readonly ReadinessItem[];
}

export interface DemoSafetyReadinessInput {
  readonly now: string;
  readonly broker: { readonly connection: string; readonly lastSuccessfulSync: string | null };
  readonly snapshot: EtoroSnapshotView | null;
  readonly killSwitch: KillSwitchState;
  readonly maxSyncAgeMs: number;
  /** The demo account safety source's last evaluation; null when the source is not wired. */
  readonly source: DemoAccountSourceStatus | null;
}

export function assessDemoSafetyReadiness(input: DemoSafetyReadinessInput): DemoSafetyReadiness {
  const evidence = DEMO_ACCOUNT_VALUATION_EVIDENCE;
  const connected = input.source !== null && evidence.nonEmptyPnlLiveObserved;
  const syncAge = input.broker.lastSuccessfulSync === null ? null : Date.parse(input.now) - Date.parse(input.broker.lastSuccessfulSync);
  const fresh = input.broker.connection === 'connected' && syncAge !== null && Number.isFinite(syncAge) && syncAge >= 0 && syncAge <= input.maxSyncAgeMs && input.snapshot?.freshness === 'fresh';
  const coverage = input.snapshot?.content.coverage ?? null;
  const decision = input.source?.outcome === 'decision' ? input.source.decision : null;
  const decisionAge = decision === null ? null : Date.parse(input.now) - Date.parse(decision.asOf);
  const decisionFresh = decisionAge !== null && decisionAge >= 0 && decisionAge <= input.maxSyncAgeMs;
  const values = decisionFresh ? decision!.values : null;

  const reasons: string[] = [];
  if (!connected) reasons.push('PORTFOLIO_SAFETY_NOT_CONNECTED');
  if (input.source !== null && input.source.outcome === 'no_evidence') reasons.push('DEMO_PNL_NONEMPTY_NOT_LIVE_OBSERVED');
  if (input.source !== null && (input.source.outcome === 'read_failed' || input.source.outcome === 'response_invalid')) reasons.push(input.source.code);
  if (decision !== null) reasons.push(...decision.hardBreachReasons, ...decision.capacityBlockReasons, ...decision.dataHoldReasons);

  const valuationStatus = (verified: boolean): ReadinessStatus => (!evidence.nonEmptyPnlLiveObserved ? 'not_verified' : verified ? 'verified' : 'not_available');
  const items: ReadinessItem[] = [
    { input: 'accountContext', status: 'operator_confirmed', reason: 'demo route and a demo key (operator confirmed the key environment; a user key serves one environment only); no account id is read' },
    {
      input: 'valuationEvidence',
      status: evidence.nonEmptyPnlLiveObserved ? 'verified' : 'not_verified',
      reason: evidence.nonEmptyPnlLiveObserved ? 'non-empty /demo/pnl observed live: ' + String(evidence.evidenceRef) : 'formulas documented; a non-empty /demo/pnl has not been observed live',
    },
    {
      input: 'positionsAndOrders',
      status: coverage === null ? 'not_available' : fresh ? 'verified' : 'stale',
      reason: coverage === null ? 'no snapshot' : 'positions: ' + coverage.positions + ', orders: ' + coverage.openOrders + (fresh ? '' : ' (not fresh)'),
    },
    { input: 'grossExposure', status: valuationStatus(values !== null), reason: values === null ? 'no fresh complete valuation' : 'account gross exposure ' + values.grossExposureUsd + ' USD, external ' + values.externalExposureUsd + ' USD' },
    { input: 'availableFunds', status: valuationStatus(values !== null), reason: values === null ? 'no fresh complete valuation' : 'available cash ' + values.availableCashUsd + ' USD (guide formula)' },
    {
      input: 'drawdownAndLossLimits',
      status: valuationStatus(decisionFresh && decision!.metrics !== null),
      reason: decisionFresh && decision!.metrics !== null ? 'daily loss ' + decision!.metrics.dailyLossUsd + ' USD, drawdown ' + decision!.metrics.drawdownUsd + ' USD' : 'no fresh risk day',
    },
    { input: 'dataFreshness', status: fresh ? 'verified' : 'stale', reason: fresh ? 'last read-only sync within the limit' : 'no fresh successful read-only sync' },
    {
      input: 'killSwitch',
      status: input.killSwitch.status === 'ARMED' ? 'verified' : 'blocking',
      reason: input.killSwitch.status === 'ARMED' ? 'kill switch armed' : 'kill switch tripped: every open is refused',
    },
  ];
  return Object.freeze({
    schema: DEMO_SAFETY_READINESS_VERSION,
    connected,
    lastDecisionState: decision?.state ?? null,
    lastDecisionAt: decision?.asOf ?? null,
    reasons: Object.freeze([...new Set(reasons)]),
    items: Object.freeze(items),
  });
}
