// O21 ExecutionIntent and state machine: strict input validation, a stable id, and a transition graph in which no path can lead
// to a second submission.
import { describe, expect, it } from 'vitest';
import { DemoExecutionError } from '../../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import {
  BROKER_CONFIRMED_STATES,
  INTENT_STATES,
  INTENT_TRANSITIONS,
  assertTransition,
  bindClosePosition,
  canTransition,
  parseExecutionIntent,
  type IntentState,
} from '../../../src/broker/etoro/execution/execution-intent.js';
import { CREATOR, closeInput, openInput } from './o21-fixture.js';

function refusal(input: unknown): string {
  try {
    parseExecutionIntent(input, CREATOR);
  } catch (error) {
    if (error instanceof DemoExecutionError && error.code === 'INTENT_INVALID') return error.message;
    throw error;
  }
  throw new Error('expected INTENT_INVALID');
}

describe('O21 intent: the minimum fields and a stable id', () => {
  it('an open intent carries every required field and a content-derived id', () => {
    const intent = parseExecutionIntent(openInput(), CREATOR);
    expect(intent).toMatchObject({
      action: 'open', side: 'buy', orderType: 'mkt', amount: '500', units: null, currency: 'USD', leverage: 1,
      stopLoss: '180', takeProfit: '230', createdAt: '2026-10-16T13:59:00.000Z', expiresAt: '2026-10-16T14:10:00.000Z', strategyRunId: 'run-o21-1',
    });
    expect(intent.intentId).toMatch(/^eint_[0-9a-f]{40}$/);
    expect(parseExecutionIntent(openInput(), CREATOR).intentId).toBe(intent.intentId);
    expect(parseExecutionIntent(openInput({ strategyRunId: 'run-o21-2' }), CREATOR).intentId).not.toBe(intent.intentId);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(parseExecutionIntent(openInput(), CREATOR))).toBe(true);
  });
});

describe('O21 intent: fail closed on input', () => {
  it.each([
    ['an unknown field', openInput({ settlementType: 'cfd' })],
    ['no expiry', openInput({ expiresAt: undefined })],
    ['an expiry before creation', openInput({ expiresAt: '2026-10-16T13:58:00.000Z' })],
    ['a lifetime above 15 minutes', openInput({ expiresAt: '2026-10-16T14:30:00.000Z' })],
    ['amount and units together', openInput({ units: '1' })],
    ['neither amount nor units', openInput({ amount: undefined })],
    ['a number instead of a decimal string', openInput({ amount: 500 })],
    ['a negative amount', openInput({ amount: '-5' })],
    ['a zero amount', openInput({ amount: '0' })],
    ['more than two decimals of USD', openInput({ amount: '1.005' })],
    ['a currency other than USD', openInput({ currency: 'EUR' })],
    ['a leverage of 0', openInput({ leverage: 0 })],
    ['a fractional leverage', openInput({ leverage: 1.5 })],
    ['leverage above 1 without stop-loss', openInput({ leverage: 2, stopLoss: undefined })],
    ['a sell without stop-loss', openInput({ side: 'sell', stopLoss: undefined, takeProfit: undefined })],
    ['mit without trigger rate', openInput({ orderType: 'mit' })],
    ['a trigger rate on a market order', openInput({ triggerRate: '190' })],
    ['an order type the reference does not support for NEXUS', openInput({ orderType: 'limitIOC' })],
    ['a side other than buy or sell', openInput({ side: 'sellShort' })],
    ['an eToro instrument id that is not a positive int32', openInput({ etoroInstrumentId: 2 ** 31 })],
    ['a non-canonical timestamp', openInput({ createdAt: '2026-10-16 13:59:00' })],
    ['a created-by that is neither human nor strategy', openInput({ createdBy: { kind: 'model', id: 'x' } })],
    ['an open with a close reference', openInput({ closesIntentId: 'eint_' + 'b'.repeat(40) })],
  ])('refuses %s', (_label, input) => {
    expect(refusal(input)).toContain('INTENT_INVALID');
  });

  it('a close never takes a position id from input: the field does not exist', () => {
    expect(refusal(closeInput('eint_' + 'a'.repeat(40), { positionId: 2150941015 }))).toContain('unknown field positionId');
  });

  it('a close needs the open intent it closes, is a market close, and takes no amount, SL, TP or leverage', () => {
    expect(refusal(closeInput('not-an-intent'))).toContain('closesIntentId');
    expect(refusal(closeInput('eint_' + 'a'.repeat(40), { orderType: 'mit', triggerRate: '1' }))).toContain('market close');
    expect(refusal(closeInput('eint_' + 'a'.repeat(40), { amount: '10' }))).toContain('INTENT_INVALID');
    expect(refusal(closeInput('eint_' + 'a'.repeat(40), { stopLoss: '1' }))).toContain('INTENT_INVALID');
    expect(refusal(closeInput('eint_' + 'a'.repeat(40), { leverage: 2 }))).toContain('INTENT_INVALID');
  });

  it('a parsed close has no position until the service binds a broker-confirmed one, and the id covers the position', () => {
    const unbound = parseExecutionIntent(closeInput('eint_' + 'a'.repeat(40)), CREATOR);
    expect(unbound.positionId).toBeNull();
    const bound = bindClosePosition(unbound, 2150941015);
    expect(bound.positionId).toBe(2150941015);
    expect(bound.intentId).not.toBe(unbound.intentId);
    expect(() => bindClosePosition(bound, 1)).toThrow(DemoExecutionError);
    expect(() => bindClosePosition(parseExecutionIntent(openInput(), CREATOR), 1)).toThrow(DemoExecutionError);
  });
});

describe('O21 state machine', () => {
  it('has exactly the required states', () => {
    expect([...INTENT_STATES].sort()).toEqual(
      ['CREATED', 'RISK_APPROVED', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'AMBIGUOUS', 'RECONCILED'].sort(),
    );
  });

  it('SUBMITTING is reachable only from APPROVED', () => {
    const into = INTENT_STATES.filter((s) => INTENT_TRANSITIONS[s].includes('SUBMITTING'));
    expect(into).toEqual(['APPROVED']);
  });

  it('no state reachable after SUBMITTING can lead back to APPROVED or SUBMITTING: a second submission is impossible', () => {
    const reachable = new Set<IntentState>();
    const stack: IntentState[] = [...INTENT_TRANSITIONS.SUBMITTING];
    while (stack.length > 0) {
      const state = stack.pop()!;
      if (reachable.has(state)) continue;
      reachable.add(state);
      stack.push(...INTENT_TRANSITIONS[state]);
    }
    for (const forbidden of ['CREATED', 'RISK_APPROVED', 'APPROVED', 'SUBMITTING'] as const) expect(reachable.has(forbidden)).toBe(false);
  });

  it('the graph has no cycle', () => {
    const visiting = new Set<IntentState>();
    const done = new Set<IntentState>();
    const visit = (s: IntentState): void => {
      if (done.has(s)) return;
      if (visiting.has(s)) throw new Error('cycle at ' + s);
      visiting.add(s);
      INTENT_TRANSITIONS[s].forEach(visit);
      visiting.delete(s);
      done.add(s);
    };
    expect(() => INTENT_STATES.forEach(visit)).not.toThrow();
  });

  it.each([
    ['CREATED', 'SUBMITTING'],
    ['RISK_APPROVED', 'SUBMITTING'],
    ['APPROVED', 'FILLED'],
    ['SUBMITTING', 'APPROVED'],
    ['SUBMITTED', 'SUBMITTING'],
    ['AMBIGUOUS', 'SUBMITTING'],
    ['AMBIGUOUS', 'APPROVED'],
    ['AMBIGUOUS', 'REJECTED'],
    ['RECONCILED', 'SUBMITTING'],
    ['REJECTED', 'APPROVED'],
    ['FILLED', 'SUBMITTED'],
    ['CANCELLED', 'CREATED'],
    ['EXPIRED', 'APPROVED'],
  ] as const)('refuses the illegal transition %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(DemoExecutionError);
  });

  it('an AMBIGUOUS intent can only be RECONCILED: it is never failed or resent without a broker read', () => {
    expect(INTENT_TRANSITIONS.AMBIGUOUS).toEqual(['RECONCILED']);
  });

  it('the broker-confirmed states are the ones entered on broker knowledge', () => {
    expect([...BROKER_CONFIRMED_STATES].sort()).toEqual(['ACCEPTED', 'FILLED', 'PARTIALLY_FILLED', 'SUBMITTED']);
  });
});

describe('O21 intent: the creator is trusted input, never part of the intent', () => {
  it('an input that names createdBy is refused as an unknown field', () => {
    expect(refusal({ ...openInput(), createdBy: { kind: 'human', id: 'someone' } })).toContain('unknown field createdBy');
  });

  it.each([
    ['no creator', undefined],
    ['a model', { kind: 'model', id: 'llm' }],
    ['an invalid id', { kind: 'human', id: 'has space' }],
    ['an extra field', { kind: 'human', id: 'operator-1', role: 'admin' }],
  ])('a creator with %s is refused', (_label, creator) => {
    expect(() => parseExecutionIntent(openInput(), creator)).toThrow(DemoExecutionError);
  });

  it('the creator is part of the content: the same input by another creator is another intent', () => {
    expect(parseExecutionIntent(openInput(), { kind: 'human', id: 'operator-1' }).intentId).not.toBe(parseExecutionIntent(openInput(), CREATOR).intentId);
  });
});
