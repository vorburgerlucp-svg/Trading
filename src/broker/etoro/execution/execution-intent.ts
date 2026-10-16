// The ExecutionIntent of the eToro demo execution layer (O21) and its state machine.
//
// No broker request can come from anywhere but an intent. An intent is created from validated input, gets a stable id derived
// from its content, passes the risk gate, is approved by a named human, and only then may be submitted, once. Its life is a fixed
// state machine: every state is entered at most once per intent (the persisted record id is intentId:STATE), so no transition can
// lead back to SUBMITTING, and an intent can never be sent to the broker twice.

import { Decimal } from '../../../money/decimal.js';
import { hashOf } from '../../../persistence/canonical-json.js';
import { DemoExecutionError } from './etoro-demo-execution-errors.js';
import { isBrokerId } from './etoro-demo-execution-endpoints.js';

export const EXECUTION_INTENT_VERSION = 'etoro-demo-execution-intent:v1' as const;

/** The longest an intent may live from creation to expiry. A stale intent is never executed. */
export const MAX_INTENT_LIFETIME_MS = 15 * 60 * 1000;

export type IntentState =
  | 'CREATED'
  | 'RISK_APPROVED'
  | 'APPROVED'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'ACCEPTED'
  | 'FILLED'
  | 'PARTIALLY_FILLED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'AMBIGUOUS'
  | 'RECONCILED';

export const INTENT_STATES: readonly IntentState[] = [
  'CREATED', 'RISK_APPROVED', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'AMBIGUOUS', 'RECONCILED',
];

/** The only allowed transitions. Nothing leads back to CREATED, RISK_APPROVED, APPROVED or SUBMITTING. */
export const INTENT_TRANSITIONS: Readonly<Record<IntentState, readonly IntentState[]>> = Object.freeze({
  CREATED: ['RISK_APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  RISK_APPROVED: ['APPROVED', 'EXPIRED', 'CANCELLED'],
  APPROVED: ['SUBMITTING', 'EXPIRED', 'CANCELLED'],
  SUBMITTING: ['SUBMITTED', 'REJECTED', 'AMBIGUOUS'],
  SUBMITTED: ['ACCEPTED', 'FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'CANCELLED'],
  PARTIALLY_FILLED: ['FILLED'],
  AMBIGUOUS: ['RECONCILED'],
  RECONCILED: ['ACCEPTED', 'FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'CANCELLED'],
  FILLED: [],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
});

/** States whose entry after a submission states broker knowledge: they need a stored broker confirmation. */
export const BROKER_CONFIRMED_STATES: ReadonlySet<IntentState> = new Set(['SUBMITTED', 'ACCEPTED', 'FILLED', 'PARTIALLY_FILLED']);

/** States in which the intent may have a live order or exposure at the broker. */
export const LIVE_AT_BROKER_STATES: ReadonlySet<IntentState> = new Set(['SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'AMBIGUOUS', 'RECONCILED', 'PARTIALLY_FILLED', 'FILLED']);

export function canTransition(from: IntentState, to: IntentState): boolean {
  return INTENT_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: IntentState, to: IntentState): void {
  if (!canTransition(from, to)) throw new DemoExecutionError('INTENT_STATE_INVALID', from + ' -> ' + to + ' is not an allowed transition');
}

export type IntentSide = 'buy' | 'sell';
export type IntentAction = 'open' | 'close';
export type IntentOrderType = 'mkt' | 'mit';

export interface IntentActor {
  readonly kind: 'human' | 'strategy';
  readonly id: string;
}

/** A validated intent. Decimal values are canonical decimal strings; they are converted to JSON numbers only at the broker edge. */
export interface ExecutionIntent {
  readonly version: typeof EXECUTION_INTENT_VERSION;
  readonly intentId: string;
  readonly action: IntentAction;
  /** The NEXUS instrument. Its eToro identity comes from a human-governed mapping, never from this intent alone. */
  readonly instrumentId: string;
  /** The eToro instrumentId the intent was made for; the gate checks it against the governed mapping. */
  readonly etoroInstrumentId: number;
  readonly side: IntentSide;
  readonly orderType: IntentOrderType;
  /** Exactly one of amount (in currency) and units, for an open. For a close, units is optional (null closes all). */
  readonly amount: string | null;
  readonly units: string | null;
  readonly currency: 'USD';
  readonly leverage: number;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  /** MIT trigger rate; required for mit, absent otherwise. */
  readonly triggerRate: string | null;
  /** For a close: the open intent whose position is closed. The only reference a caller gives. */
  readonly closesIntentId: string | null;
  /**
   * For a close: the broker position. Never taken from input: bindClosePosition sets it from the broker-confirmed state of the
   * closed intent (an order status read from eToro), and the intent id is computed over it.
   */
  readonly positionId: number | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly strategyRunId: string;
  readonly createdBy: IntentActor;
}

const TEXT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const INTENT_ID = /^eint_[0-9a-f]{40}$/;
const ACTOR_ID = /^[A-Za-z0-9_.@-]{1,64}$/;
const MAX_LEVERAGE = 100;

function bad(detail: string): never {
  throw new DemoExecutionError('INTENT_INVALID', detail);
}

function canonicalUtc(value: unknown, name: string): string {
  if (typeof value !== 'string') bad(name + ' must be a canonical UTC instant');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) bad(name + ' must be a canonical UTC instant');
  return value;
}

/** A positive decimal with at most maxScale places, given as a string so no precision is lost on the way in. */
function positiveDecimal(value: unknown, name: string, maxScale: number): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$/.test(value)) bad(name + ' must be a positive decimal string');
  const decimal = Decimal.from(value);
  if (!decimal.isPositive()) bad(name + ' must be greater than zero');
  if ((value.split('.')[1] ?? '').length > maxScale) bad(name + ' has too many decimal places');
  // The broker takes a JSON number (double): the value must survive that conversion exactly.
  if (!Decimal.from(Number(value)).eq(decimal)) bad(name + ' is not exactly representable for the broker');
  return decimal.toString();
}

function optionalDecimal(value: unknown, name: string, maxScale: number): string | null {
  return value === undefined || value === null ? null : positiveDecimal(value, name, maxScale);
}

function actor(value: unknown, name: string): IntentActor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad(name + ' must be an actor');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'kind' && k !== 'id')) bad(name + ' has unknown fields');
  if (v.kind !== 'human' && v.kind !== 'strategy') bad(name + '.kind must be human or strategy');
  if (typeof v.id !== 'string' || !ACTOR_ID.test(v.id)) bad(name + '.id is invalid');
  return { kind: v.kind, id: v.id };
}

const INPUT_FIELDS = new Set([
  'action', 'instrumentId', 'etoroInstrumentId', 'side', 'orderType', 'amount', 'units', 'currency', 'leverage', 'stopLoss', 'takeProfit',
  'triggerRate', 'closesIntentId', 'createdAt', 'expiresAt', 'strategyRunId',
]);

/** The stable intent id: a hash of the complete validated content. The same input always yields the same id. */
export function intentIdOf(content: Omit<ExecutionIntent, 'intentId'>): string {
  return 'eint_' + hashOf(content).slice(0, 40);
}

export function isIntentId(value: unknown): value is string {
  return typeof value === 'string' && INTENT_ID.test(value);
}

/** A human or strategy actor with a valid id. Used for the creator, which is always given by trusted code, never by input. */
export function parseActor(value: unknown, name = 'actor'): IntentActor {
  return actor(value, name);
}

/**
 * Validates untrusted input into an ExecutionIntent. Fail closed: an unknown field, a missing field, a wrong type, an
 * inconsistent combination or a value outside the bounds is INTENT_INVALID. Only what the eToro reference supports is accepted:
 * open with buy or sell (sent as sellShort), mkt or mit; close by position, market only.
 *
 * The creator is not part of the input: createdBy is given by the caller from trusted state (the authenticated operator in the
 * runtime). An input that names a creator is refused as an unknown field.
 */
export function parseExecutionIntent(input: unknown, createdByActor: unknown): ExecutionIntent {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) bad('intent must be an object');
  const v = input as Record<string, unknown>;
  const unknown = Object.keys(v).filter((k) => !INPUT_FIELDS.has(k));
  if (unknown.length > 0) bad('unknown field ' + unknown[0]);

  if (v.action !== 'open' && v.action !== 'close') bad('action must be open or close');
  if (typeof v.instrumentId !== 'string' || !TEXT_ID.test(v.instrumentId)) bad('instrumentId is invalid');
  if (!isBrokerId(v.etoroInstrumentId) || v.etoroInstrumentId > 2_147_483_647) bad('etoroInstrumentId must be a positive int32');
  if (v.side !== 'buy' && v.side !== 'sell') bad('side must be buy or sell');
  if (v.orderType !== 'mkt' && v.orderType !== 'mit') bad('orderType must be mkt or mit');
  if (v.currency !== 'USD') bad('currency must be USD: the broker supports only USD order amounts');
  if (typeof v.leverage !== 'number' || !Number.isSafeInteger(v.leverage) || v.leverage < 1 || v.leverage > MAX_LEVERAGE) bad('leverage must be an integer from 1 to ' + MAX_LEVERAGE);
  if (typeof v.strategyRunId !== 'string' || !TEXT_ID.test(v.strategyRunId)) bad('strategyRunId is invalid');

  const createdAt = canonicalUtc(v.createdAt, 'createdAt');
  const expiresAt = canonicalUtc(v.expiresAt, 'expiresAt');
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetime <= 0 || lifetime > MAX_INTENT_LIFETIME_MS) bad('expiresAt must be after createdAt and at most 15 minutes later');

  const amount = optionalDecimal(v.amount, 'amount', 2);
  const units = optionalDecimal(v.units, 'units', 8);
  const stopLoss = optionalDecimal(v.stopLoss, 'stopLoss', 8);
  const takeProfit = optionalDecimal(v.takeProfit, 'takeProfit', 8);
  const triggerRate = optionalDecimal(v.triggerRate, 'triggerRate', 8);
  const createdBy = actor(createdByActor, 'createdBy');

  let closesIntentId: string | null = null;
  if (v.action === 'open') {
    if ((amount === null) === (units === null)) bad('an open needs exactly one of amount and units');
    if (v.orderType === 'mit' && triggerRate === null) bad('a mit order needs triggerRate');
    if (v.orderType === 'mkt' && triggerRate !== null) bad('triggerRate is only allowed for mit orders');
    // The reference: leverage above 1 and a short open both require a stop-loss rate.
    if ((v.leverage > 1 || v.side === 'sell') && stopLoss === null) bad('leverage above 1 or a sell needs stopLoss');
    if (v.closesIntentId !== undefined && v.closesIntentId !== null) bad('closesIntentId is only allowed for a close');
  } else {
    if (v.orderType !== 'mkt') bad('a close is a market close');
    if (amount !== null) bad('a close takes units or nothing, not an amount');
    if (stopLoss !== null || takeProfit !== null || triggerRate !== null) bad('a close takes no stopLoss, takeProfit or triggerRate');
    if (v.leverage !== 1) bad('a close takes no leverage');
    if (!isIntentId(v.closesIntentId)) bad('a close needs closesIntentId of the open intent');
    closesIntentId = v.closesIntentId;
  }

  const content: Omit<ExecutionIntent, 'intentId'> = {
    version: EXECUTION_INTENT_VERSION,
    action: v.action,
    instrumentId: v.instrumentId,
    etoroInstrumentId: v.etoroInstrumentId,
    side: v.side,
    orderType: v.orderType,
    amount,
    units,
    currency: 'USD',
    leverage: v.leverage,
    stopLoss,
    takeProfit,
    triggerRate,
    closesIntentId,
    positionId: null,
    createdAt,
    expiresAt,
    strategyRunId: v.strategyRunId,
    createdBy,
  };
  return Object.freeze({ ...content, intentId: intentIdOf(content) });
}

/**
 * Binds the broker position to a parsed close intent. The position comes from trusted, persisted, broker-confirmed state of the
 * closed intent (the service resolves it), never from the request. The intent id is recomputed over the bound position.
 */
export function bindClosePosition(intent: ExecutionIntent, positionId: number): ExecutionIntent {
  if (intent.action !== 'close' || intent.positionId !== null) throw new DemoExecutionError('INTENT_INVALID', 'only an unbound close takes a position');
  if (!isBrokerId(positionId)) throw new DemoExecutionError('INTENT_INVALID', 'the broker position id is invalid');
  const { intentId: _unbound, ...rest } = intent;
  void _unbound;
  const content: Omit<ExecutionIntent, 'intentId'> = { ...rest, positionId };
  return Object.freeze({ ...content, intentId: intentIdOf(content) });
}

/**
 * The economic fingerprint: two intents with the same fingerprint would place the same trade. Only one of them may be active,
 * whatever their timestamps.
 */
export function economicFingerprint(intent: ExecutionIntent): string {
  return hashOf({
    action: intent.action,
    instrumentId: intent.instrumentId,
    side: intent.side,
    orderType: intent.orderType,
    amount: intent.amount,
    units: intent.units,
    triggerRate: intent.triggerRate,
    positionId: intent.positionId,
    strategyRunId: intent.strategyRunId,
  });
}

/** The exact request body of "Create an order" for this intent. Only documented fields; nothing optional is guessed. */
export function openOrderBody(intent: ExecutionIntent): Readonly<Record<string, unknown>> {
  if (intent.action !== 'open') throw new DemoExecutionError('INTENT_INVALID', 'not an open intent');
  const body: Record<string, unknown> = {
    action: 'open',
    // The reference supports buy and sellShort for an open; a NEXUS sell is a short open.
    transaction: intent.side === 'buy' ? 'buy' : 'sellShort',
    instrumentId: intent.etoroInstrumentId,
    orderType: intent.orderType,
    leverage: intent.leverage,
  };
  if (intent.amount !== null) {
    body.amount = Number(intent.amount);
    body.orderCurrency = 'usd';
  }
  if (intent.units !== null) body.units = Number(intent.units);
  if (intent.triggerRate !== null) body.triggerRate = Number(intent.triggerRate);
  if (intent.stopLoss !== null) {
    body.stopLossRate = Number(intent.stopLoss);
    body.stopLossType = 'fixed';
  }
  if (intent.takeProfit !== null) body.takeProfitRate = Number(intent.takeProfit);
  return Object.freeze(body);
}

/** The exact request body of "Close demo position by units". Property names are as in the reference: InstrumentID, UnitsToDeduct. */
export function closePositionBody(intent: ExecutionIntent): Readonly<Record<string, unknown>> {
  if (intent.action !== 'close') throw new DemoExecutionError('INTENT_INVALID', 'not a close intent');
  return Object.freeze({ InstrumentID: intent.etoroInstrumentId, UnitsToDeduct: intent.units === null ? null : Number(intent.units) });
}
