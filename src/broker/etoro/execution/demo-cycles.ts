// O22 Plan C: independent, auditable demo cycles. A cycle is a record in its own append-only log (etoro-demo-cycles): it is
// DEFINED with its own immutable policy (version, limits and budget), ACTIVATED by an explicit human authorization once every earlier
// broker state is settled, and CLOSED with its test verdict. A pure module: the records, the projection and the rules. The service
// (etoro-demo-execution-service.ts) binds every new intent to the active cycle and counts the budget of that cycle only.
//
// Invariants:
//   - a cycle id and a policy version are used once (fixed record ids; a version reused by another cycle is refused);
//   - the policy is stored with the definition and its hash; the activation names that hash, so nothing else can be activated;
//   - a budget is the count of the cycle's own intents that reached SUBMITTING: a new cycle has a new, separate count, never a reset
//     of an old one; historical intents, attempts and records stay as they are;
//   - at most one cycle is active; a cycle is active only between its activation and its close or its expiry (activeUntil);
//   - activation needs every earlier intent (of every cycle and of the time before cycles, such as O22) to be settled by NEXUS's own
//     records: nothing in flight, ambiguous or unconfirmed; every filled position closed by a filled NEXUS close (a position closed
//     outside NEXUS does not count, even when attested); no intent still waiting for approval or execution;
//   - an intent of another cycle (or from before cycles) is never executed in a new one;
//   - a position closed by hand never makes a cycle "passed": the close record carries the test verdict (POSITION_CLOSED_EXTERNALLY).
// Nothing here activates anything. The runtime does not open this log: without it the service behaves exactly as before (O22 policy).

import { hashOf } from '../../../persistence/canonical-json.js';
import type { DemoExecutionPolicy } from './execution-gate.js';
import type { IntentActor, IntentState } from './execution-intent.js';

export const DEMO_CYCLE_RECORD_SCHEMA = 'etoro-demo-cycle:v1' as const;
/** The statement a human makes to activate a cycle; anything else is refused. */
export const CYCLE_ACTIVATION_STATEMENT = 'ACTIVATE_DEMO_CYCLE_WITH_THIS_POLICY' as const;
/** The longest a cycle may stay active after its activation. */
export const MAX_CYCLE_ACTIVE_MS = 7 * 24 * 60 * 60 * 1000;
/** The largest budget a cycle may define, per kind (open, close). */
export const MAX_CYCLE_SUBMISSIONS = 3;

const CYCLE_ID = /^cycle-[0-9]{1,4}(-[a-z0-9]{1,24})?$/;
const POLICY_VERSION = /^etoro-demo-cycle-policy:[a-z0-9.-]{1,40}$/;

export type DemoCycleRecord =
  | {
      readonly schema: typeof DEMO_CYCLE_RECORD_SCHEMA;
      readonly kind: 'defined';
      readonly cycleId: string;
      readonly policy: DemoExecutionPolicy;
      readonly policyHash: string;
      /** How long the cycle may stay active after its activation. */
      readonly maxActiveMs: number;
      readonly definedBy: IntentActor;
      readonly definedAt: string;
    }
  | {
      readonly schema: typeof DEMO_CYCLE_RECORD_SCHEMA;
      readonly kind: 'activated';
      readonly cycleId: string;
      readonly policyHash: string;
      readonly statement: typeof CYCLE_ACTIVATION_STATEMENT;
      readonly activatedBy: IntentActor;
      readonly activatedAt: string;
      readonly activeUntil: string;
      /** The heads of the intent log and the cycle log the preconditions were checked against. */
      readonly checkedIntentLogSize: number;
    }
  | {
      /**
       * Review of PR #35 (R3): the close has begun. From this record on no new reservation of the cycle is possible (the reservation
       * reads the cycle log in its own critical section). It becomes 'closed' only when no write of the cycle can still be sent.
       */
      readonly schema: typeof DEMO_CYCLE_RECORD_SCHEMA;
      readonly kind: 'closing';
      readonly cycleId: string;
      readonly closingBy: IntentActor;
      readonly closingAt: string;
    }
  | {
      readonly schema: typeof DEMO_CYCLE_RECORD_SCHEMA;
      readonly kind: 'closed';
      readonly cycleId: string;
      readonly closedBy: IntentActor;
      readonly closedAt: string;
      /** The cycle's test verdict when it was closed (never "passed" with a position closed outside NEXUS). */
      readonly verdict: 'passed' | 'failed' | 'incomplete' | 'not_evaluated';
      readonly failures: readonly string[];
    };

export interface DemoCycle {
  readonly cycleId: string;
  readonly policy: DemoExecutionPolicy;
  readonly policyHash: string;
  readonly maxActiveMs: number;
  readonly status: 'draft' | 'active' | 'closing' | 'closed';
  readonly activatedAt: string | null;
  readonly activeUntil: string | null;
  readonly closingAt: string | null;
  readonly closedAt: string | null;
  readonly verdict: string | null;
}

export function policyHashOf(policy: DemoExecutionPolicy): string {
  return 'epol_' + hashOf(policy).slice(0, 40);
}

/** The fixed record ids: each step of a cycle is recorded once. */
export function cycleRecordId(cycleId: string, kind: DemoCycleRecord['kind']): string {
  return cycleId + ':' + kind;
}

/** Folds the cycle log. A record of an unknown or not yet defined cycle, or out of order, is ignored (the rules refuse such writes). */
export function projectCycles(records: readonly DemoCycleRecord[]): Map<string, DemoCycle> {
  const map = new Map<string, DemoCycle>();
  for (const r of records) {
    const c = map.get(r.cycleId);
    if (r.kind === 'defined') {
      if (c === undefined) map.set(r.cycleId, { cycleId: r.cycleId, policy: r.policy, policyHash: r.policyHash, maxActiveMs: r.maxActiveMs, status: 'draft', activatedAt: null, activeUntil: null, closingAt: null, closedAt: null, verdict: null });
    } else if (r.kind === 'activated') {
      if (c !== undefined && c.status === 'draft' && r.policyHash === c.policyHash) map.set(r.cycleId, { ...c, status: 'active', activatedAt: r.activatedAt, activeUntil: r.activeUntil });
    } else if (r.kind === 'closing') {
      if (c !== undefined && c.status === 'active') map.set(r.cycleId, { ...c, status: 'closing', closingAt: r.closingAt });
    } else if (c !== undefined && c.status === 'closing') {
      map.set(r.cycleId, { ...c, status: 'closed', closedAt: r.closedAt, verdict: r.verdict });
    }
  }
  return map;
}

/** The cycle that may take new intents now: active and not past its activeUntil. At most one exists (the activation rule). */
export function activeCycle(cycles: ReadonlyMap<string, DemoCycle>, now: string): DemoCycle | null {
  for (const c of cycles.values()) {
    if (c.status === 'active' && c.activeUntil !== null && Date.parse(now) < Date.parse(c.activeUntil)) return c;
  }
  return null;
}

/** A definition: a new id, a new policy version, a bounded budget and active time. Pure; fixed reason codes. */
export function cycleDefinitionRefusals(input: { cycleId: unknown; policy: DemoExecutionPolicy; maxActiveMs: unknown }, cycles: ReadonlyMap<string, DemoCycle>): string[] {
  const reasons: string[] = [];
  if (typeof input.cycleId !== 'string' || !CYCLE_ID.test(input.cycleId)) reasons.push('CYCLE_ID_INVALID');
  else if (cycles.has(input.cycleId)) reasons.push('CYCLE_ALREADY_DEFINED');
  const p = input.policy;
  if (typeof p.version !== 'string' || !POLICY_VERSION.test(p.version)) reasons.push('CYCLE_POLICY_VERSION_INVALID');
  else if ([...cycles.values()].some((c) => c.policy.version === p.version)) reasons.push('CYCLE_POLICY_VERSION_REUSED');
  const budgetOk = (n: number | null) => n !== null && Number.isSafeInteger(n) && n >= 1 && n <= MAX_CYCLE_SUBMISSIONS;
  if (!budgetOk(p.maxOpenSubmissions) || !budgetOk(p.maxCloseSubmissions)) reasons.push('CYCLE_BUDGET_INVALID');
  if (!Number.isSafeInteger(input.maxActiveMs) || (input.maxActiveMs as number) <= 0 || (input.maxActiveMs as number) > MAX_CYCLE_ACTIVE_MS) reasons.push('CYCLE_ACTIVE_TIME_INVALID');
  return reasons;
}

/** What activation reads of every intent in the log (all cycles, and the intents from before cycles). */
export interface CycleIntentFact {
  readonly action: 'open' | 'close';
  readonly state: IntentState;
  readonly expiresAt: string;
  readonly positionIds: readonly number[];
  readonly positionId: number | null;
}

/**
 * Review of PR #35 (R3): the states in which a write of a cycle may still be sent or its answer is outstanding (SUBMITTING), or its
 * result is unclear (AMBIGUOUS). While one exists, a closing cycle is not reported closed.
 */
export const CYCLE_IN_FLIGHT_STATES: ReadonlySet<IntentState> = new Set(['SUBMITTING', 'AMBIGUOUS']);

/**
 * Review of PR #35 (R5): what is still open of a cycle, by NEXUS's own records, in three separate kinds. A cycle is SETTLED, and may
 * be reported CLOSED, only when all three are zero. Ending new activity (CLOSING) is a separate step and needs none of this.
 *   writesInFlight    a write may still be sent, its answer is outstanding, or its result is unclear (SUBMITTING, AMBIGUOUS)
 *   ordersUnresolved  an order at the broker without a final status read: submitted, accepted (pending), found by reference, or
 *                     partially filled (SUBMITTED, ACCEPTED, RECONCILED, PARTIALLY_FILLED), of an open or a close
 *   positionsOpen     a position of a FILLED open of the cycle that no FILLED NEXUS close of the cycle closed. A position closed by
 *                     hand (attested or not) counts as open here: NEXUS did not settle it (see docs, decision template)
 */
export interface CycleSettlement {
  readonly writesInFlight: number;
  readonly ordersUnresolved: number;
  readonly positionsOpen: number;
}

const ORDER_UNRESOLVED: ReadonlySet<IntentState> = new Set(['SUBMITTED', 'ACCEPTED', 'RECONCILED', 'PARTIALLY_FILLED']);

/** R5: the settlement of a cycle from the facts of its own intents (pure). */
export function cycleSettlement(intents: readonly CycleIntentFact[]): CycleSettlement {
  const closedByNexus = new Set(intents.filter((i) => i.action === 'close' && i.state === 'FILLED' && i.positionId !== null).map((i) => i.positionId!));
  let positionsOpen = 0;
  for (const i of intents) {
    if (i.action !== 'open' || i.state !== 'FILLED') continue;
    // A filled open names its position; one without a confirmed position is not settled either.
    positionsOpen += i.positionIds.length === 0 ? 1 : i.positionIds.filter((id) => !closedByNexus.has(id)).length;
  }
  return {
    writesInFlight: intents.filter((i) => CYCLE_IN_FLIGHT_STATES.has(i.state)).length,
    ordersUnresolved: intents.filter((i) => ORDER_UNRESOLVED.has(i.state)).length,
    positionsOpen,
  };
}

export function isSettled(s: CycleSettlement): boolean {
  return s.writesInFlight === 0 && s.ordersUnresolved === 0 && s.positionsOpen === 0;
}

/** States in which a write may have reached the broker without a final, confirmed outcome. */
const UNRESOLVED: ReadonlySet<IntentState> = new Set(['SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'AMBIGUOUS', 'RECONCILED', 'PARTIALLY_FILLED']);
const PENDING: ReadonlySet<IntentState> = new Set(['CREATED', 'RISK_APPROVED', 'APPROVED']);

/**
 * The activation rule (pure). Every earlier broker state must be settled by NEXUS's own records:
 *   - nothing in flight, ambiguous or unconfirmed                                   PRIOR_INTENT_UNRESOLVED
 *   - every filled open's position closed by a FILLED NEXUS close                     PRIOR_POSITION_NOT_CLOSED_BY_NEXUS
 *     (a position closed outside NEXUS, even when attested, is not settled for a new cycle: it ends liveness, not the cycle; a
 *      separate, explicitly approved policy would be needed to accept it)
 *   - no intent waiting for approval or execution that has not expired                PRIOR_INTENT_PENDING
 * and the cycle must be a draft with exactly the named policy, no other cycle active, the kill switch armed, and the statement made.
 */
export function cycleActivationRefusals(input: {
  cycleId: string;
  policyHash: unknown;
  statement: unknown;
  now: string;
  cycles: ReadonlyMap<string, DemoCycle>;
  intents: readonly CycleIntentFact[];
  killSwitchArmed: boolean;
}): string[] {
  const reasons: string[] = [];
  const c = input.cycles.get(input.cycleId);
  if (c === undefined) return ['CYCLE_NOT_DEFINED'];
  if (c.status !== 'draft') reasons.push('CYCLE_NOT_DRAFT');
  if (input.statement !== CYCLE_ACTIVATION_STATEMENT) reasons.push('CYCLE_ACTIVATION_STATEMENT_MISSING');
  if (input.policyHash !== c.policyHash) reasons.push('CYCLE_POLICY_HASH_MISMATCH');
  if ([...input.cycles.values()].some((o) => o.cycleId !== c.cycleId && (o.status === 'active' || o.status === 'closing'))) reasons.push('ANOTHER_CYCLE_ACTIVE');
  if (!input.killSwitchArmed) reasons.push('KILL_SWITCH_TRIPPED');
  const closedByNexus = new Set(input.intents.filter((i) => i.action === 'close' && i.state === 'FILLED' && i.positionId !== null).map((i) => i.positionId!));
  if (input.intents.some((i) => UNRESOLVED.has(i.state))) reasons.push('PRIOR_INTENT_UNRESOLVED');
  if (input.intents.some((i) => i.action === 'open' && i.state === 'FILLED' && (i.positionIds.length === 0 || i.positionIds.some((id) => !closedByNexus.has(id))))) reasons.push('PRIOR_POSITION_NOT_CLOSED_BY_NEXUS');
  if (input.intents.some((i) => PENDING.has(i.state) && Date.parse(input.now) < Date.parse(i.expiresAt))) reasons.push('PRIOR_INTENT_PENDING');
  return reasons;
}

/** The refusals of an intent against the cycle system: it must belong to the cycle that is active now (pure). */
export function intentCycleRefusals(intentCycleId: string | undefined, cycles: ReadonlyMap<string, DemoCycle>, now: string): string[] {
  const active = activeCycle(cycles, now);
  if (active === null) return ['CYCLE_NOT_ACTIVE'];
  if (intentCycleId !== active.cycleId) return ['INTENT_NOT_OF_ACTIVE_CYCLE'];
  return [];
}

/**
 * O22 Plan C, phase 4: the PROPOSED policy of demo cycle 2 (an inactive draft). Nothing uses it: it takes effect only after a cycle
 * is defined with it and a human activates that cycle (cycleActivationRefusals), and the runtime opens no cycle log at all. The
 * build lock stays closed whatever a policy says. Every field is at least as strict as the O22 cycle policy (v2), plus a single
 * instrument: ETH (eToro 100001), the instrument of cycle 1. The limits it does not cover are analysed in docs/O22_PLAN_C_CYCLES.md.
 */
export const DEMO_CYCLE_2_POLICY_DRAFT: DemoExecutionPolicy = Object.freeze({
  version: 'etoro-demo-cycle-policy:cycle-2-draft.1',
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
  allowedEtoroInstrumentIds: Object.freeze([100001]),
});
/** The proposed active time of cycle 2: 24 hours from its activation. */
export const DEMO_CYCLE_2_MAX_ACTIVE_MS_DRAFT = 24 * 60 * 60 * 1000;
