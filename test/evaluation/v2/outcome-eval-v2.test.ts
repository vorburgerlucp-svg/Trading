// R2 evaluation v2: actions and position context, sealing before the outcome, process versus outcome, forecasts.
import { describe, expect, it } from 'vitest';
import { evaluateDecisionV2, type DecisionV2, type ProcessAssessment } from '../../../src/evaluation/v2/outcome-eval-v2.js';
import { tradePlanProblems } from '../../../src/evaluation/v2/trade-plan.js';
import { AFTER, CAL, ENTRY_AT, bars, plan, sealed, shortPlan } from './fixtures.js';

const RISE_TO_TARGET = bars([['100', '101', '99', '100'], ['100', '111', '99', '109']]);
const FALL_TO_STOP = bars([['100', '101', '99', '100'], ['99', '99', '94', '96']]);
const FALL_TO_SHORT_TARGET = bars([['100', '101', '99', '100'], ['100', '101', '89', '91']]);
/** The price ends far higher, but a long candidate would have been stopped out on the way. */
const DIP_THEN_RISE = bars([['100', '101', '99', '100'], ['99', '99', '94', '96'], ['96', '130', '96', '128']]);
const GOOD: ProcessAssessment = { assessedAt: '2026-10-07T09:58:00.000Z', dataQualityOk: true, rulesPassed: true, riskWithinLimits: true, expectedEdgeExceedsCosts: true };
const WEAK: ProcessAssessment = { ...GOOD, rulesPassed: false };

const evaluate = (decision: DecisionV2, b = RISE_TO_TARGET, at = AFTER) => evaluateDecisionV2({ decision, bars: b, calendar: CAL, evaluatedAt: at });

describe('R2: decisions are evaluated against the right plan', () => {
  it('ENTER_LONG and ENTER_SHORT: the entered plan, in their own direction', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()) })).toMatchObject({ status: 'EVALUATED', valueR: '2', outcome: 'FAVORABLE' });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_SHORT', positionContext: 'flat', plan: sealed(shortPlan()) }, FALL_TO_SHORT_TARGET)).toMatchObject({ status: 'EVALUATED', valueR: '2' });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_SHORT', positionContext: 'flat', plan: sealed(shortPlan()) }, RISE_TO_TARGET)).toMatchObject({ status: 'EVALUATED', outcome: 'ADVERSE' });
  });

  it('a plan whose side does not fit the action is not evaluated', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_SHORT', positionContext: 'flat', plan: sealed(plan()) })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['PLAN_SIDE_DOES_NOT_FIT_ACTION'], valueR: null });
  });

  it('HOLD with an open LONG is the long continuation: a fall to the stop is -1R (not a correct "hold" as in v1)', () => {
    const hold = plan({ positionContext: 'long_open' });
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'long_open', plan: sealed(hold) }, FALL_TO_STOP)).toMatchObject({ status: 'EVALUATED', valueR: '-1', outcome: 'ADVERSE' });
  });

  it('HOLD with an open SHORT is the short continuation: a fall to the target is +2R', () => {
    const hold = shortPlan({ positionContext: 'short_open' });
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'short_open', plan: sealed(hold) }, FALL_TO_SHORT_TARGET)).toMatchObject({ status: 'EVALUATED', valueR: '2', outcome: 'FAVORABLE' });
  });

  it('HOLD without a position, or with a plan of the other side, is not evaluated', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'flat', plan: sealed(plan()) })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['HOLD_WITHOUT_POSITION'] });
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'short_open', plan: sealed(plan({ positionContext: 'long_open' })) })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['PLAN_POSITION_CONTEXT_MISMATCH'] });
  });

  it('EXIT of an open long is valued by what the continuation would have done: avoiding a stop-out is +1R', () => {
    const continuation = plan({ positionContext: 'long_open' });
    expect(evaluate({ decisionId: 'dec-1', action: 'EXIT', positionContext: 'long_open', plan: sealed(continuation) }, FALL_TO_STOP)).toMatchObject({ status: 'EVALUATED', valueR: '1', outcome: 'FAVORABLE', lossWithinPlannedRisk: null });
    expect(evaluate({ decisionId: 'dec-1', action: 'EXIT', positionContext: 'flat', plan: sealed(plan()) })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['EXIT_WITHOUT_POSITION'] });
  });

  it('NO_TRADE: the rejected candidate plan decides, not the later price direction', () => {
    // The price ends at 128 (far up), but the long candidate would have hit its stop first: the rejection avoided -1R.
    expect(evaluate({ decisionId: 'dec-1', action: 'NO_TRADE', positionContext: 'flat', plan: sealed(plan()) }, DIP_THEN_RISE)).toMatchObject({ status: 'EVALUATED', valueR: '1', outcome: 'FAVORABLE' });
    // The candidate reached its target: the rejection missed +2R (an observation of this case, not by itself a bad decision).
    expect(evaluate({ decisionId: 'dec-1', action: 'NO_TRADE', positionContext: 'flat', plan: sealed(plan()), process: GOOD })).toMatchObject({ valueR: '-2', outcome: 'ADVERSE', quadrant: 'good_decision_bad_outcome' });
  });

  it('NO_TRADE without a concrete candidate plan, NO_ACTION and INSUFFICIENT_DATA get no score', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'NO_TRADE', positionContext: 'flat' })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['NO_CANDIDATE_PLAN'], valueR: null, outcome: null });
    expect(evaluate({ decisionId: 'dec-1', action: 'NO_ACTION', positionContext: 'flat', plan: sealed(plan()) })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['NO_JUDGEMENT'], valueR: null, simulation: null });
    expect(evaluate({ decisionId: 'dec-1', action: 'INSUFFICIENT_DATA', positionContext: 'flat' })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['DECISION_HAD_INSUFFICIENT_DATA'], valueR: null });
  });

  it('pending, data gap and indeterminate results carry no value', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()) }, RISE_TO_TARGET.slice(0, 1), '2026-10-07T10:20:00.000Z')).toMatchObject({ status: 'PENDING', valueR: null });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan({ intrabarPolicy: 'indeterminate' })) }, bars([['100', '101', '99', '100'], ['100', '111', '94', '100']]))).toMatchObject({ status: 'INDETERMINATE', valueR: null });
  });
});

describe('R2: the plan must exist before its outcome', () => {
  it('a plan sealed at or after the earliest entry is refused (submitted late)', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan(), ENTRY_AT) })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['PLAN_SEALED_TOO_LATE'] });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan(), '2026-10-07T12:00:00.000Z') })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['PLAN_SEALED_TOO_LATE'] });
  });

  it('a plan made from data newer than its seal, a changed plan, or a plan of another decision is refused', () => {
    const late = plan({ dataBasis: { asOf: '2026-10-07T09:59:30.000Z', storedThrough: 1, inputFingerprint: 'a'.repeat(64) } });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(late) })).toMatchObject({ reasons: ['PLAN_DATA_AFTER_SEAL'] });
    const tampered = { ...sealed(plan()), plan: plan({ stopLoss: '80' }) };
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: tampered })).toMatchObject({ reasons: ['PLAN_HASH_MISMATCH'] });
    expect(evaluate({ decisionId: 'dec-2', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()) })).toMatchObject({ reasons: ['PLAN_OF_ANOTHER_DECISION'] });
  });

  it('a demo, paper or live plan is never simulated: it needs the observed fills', () => {
    for (const realization of ['DEMO', 'PAPER', 'LIVE'] as const) {
      expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan({ realization, origin: 'demo' })) })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['OBSERVED_FILLS_REQUIRED'], realization });
    }
  });

  it('an incomplete plan is refused before it can be sealed', () => {
    const p = plan();
    expect(tradePlanProblems(p, '100')).toEqual([]);
    const { stopLoss: _s, ...noStop } = p;
    expect(tradePlanProblems(noStop)).toContain('stopLoss is required (a positive price)');
    expect(tradePlanProblems({ ...p, costs: undefined as never })).toContainEqual(expect.stringMatching(/costs are required/));
    expect(tradePlanProblems({ ...p, maxHoldingBars: 0 })).toContainEqual(expect.stringMatching(/maxHoldingBars/));
    expect(tradePlanProblems({ ...p, positionContext: 'short_open' })).toContainEqual(expect.stringMatching(/continue the open side/));
    expect(tradePlanProblems(p, '94')).toContain('stopLoss must lie on the loss side of the reference price');
    expect(tradePlanProblems(shortPlan(), '100')).toEqual([]);
    expect(tradePlanProblems(shortPlan({ stopLoss: '95' }), '100')).toContain('stopLoss must lie on the loss side of the reference price');
    expect(tradePlanProblems({ ...p, dataBasis: { ...p.dataBasis, asOf: '2026-10-07T10:30:00.000Z' } })).toContain('dataBasis.asOf lies after the earliest entry');
  });
});

describe('R2: decision quality apart from the result', () => {
  it('the four quadrants', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), process: GOOD })).toMatchObject({ quadrant: 'good_decision_good_outcome', process: 'STRONG' });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), process: GOOD }, FALL_TO_STOP)).toMatchObject({ quadrant: 'good_decision_bad_outcome', lossWithinPlannedRisk: true });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), process: WEAK })).toMatchObject({ quadrant: 'bad_decision_good_outcome', process: 'WEAK' });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), process: WEAK }, FALL_TO_STOP)).toMatchObject({ quadrant: 'bad_decision_bad_outcome' });
  });

  it('a gap loss beyond the planned risk is flagged; a loss at the stop is within it', () => {
    const gap = bars([['100', '101', '99', '100'], ['90', '92', '88', '91']]);
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()) }, gap)).toMatchObject({ valueR: '-2', lossWithinPlannedRisk: false });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()) }, FALL_TO_STOP)).toMatchObject({ lossWithinPlannedRisk: true });
  });

  it('a process assessed after the entry does not count', () => {
    const late = { ...GOOD, assessedAt: '2026-10-07T11:00:00.000Z' };
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), process: late })).toMatchObject({ process: 'UNKNOWN', quadrant: null, reasons: ['PROCESS_ASSESSED_AFTER_ENTRY'] });
  });

  it('a flat result has no quadrant; a single case is marked as such', () => {
    const flat = bars([['100', '101', '99', '100'], ['100', '101', '99', '100.2'], ['100', '101', '99', '100'], ['100', '101', '99', '100.1']]);
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), process: GOOD }, flat)).toMatchObject({ outcome: 'FLAT', quadrant: null, evidence: 'single_case' });
  });
});

describe('R2: forecasts are scored as probabilities of a defined event', () => {
  const forecast = (probability: number, statedAt = '2026-10-07T09:58:00.000Z') => ({ event: 'target_before_stop' as const, probability, statedAt });

  it('target first: Brier (0.7 - 1)^2 = 0.09; stop first: (0.7 - 0)^2 = 0.49', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), forecast: forecast(0.7) }).forecast).toMatchObject({ occurred: true, brier: expect.closeTo(0.09, 10) });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), forecast: forecast(0.7) }, FALL_TO_STOP).forecast).toMatchObject({ occurred: false, brier: expect.closeTo(0.49, 10) });
  });

  it('no outcome of the event (time exit, or an assumed intrabar order): not scored; a forecast stated after the seal: not scored', () => {
    const timeExit = bars([['100', '101', '99', '100'], ['100', '101', '99', '100'], ['100', '101', '99', '100'], ['100', '101', '99', '100']]);
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), forecast: forecast(0.7) }, timeExit).forecast).toMatchObject({ occurred: null, brier: null });
    const ambiguous = bars([['100', '101', '99', '100'], ['100', '111', '94', '100']]);
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), forecast: forecast(0.7) }, ambiguous).forecast).toMatchObject({ occurred: null, brier: null });
    const late = evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), forecast: forecast(0.7, '2026-10-07T10:30:00.000Z') });
    expect(late.forecast).toBeNull();
    expect(late.reasons).toContain('FORECAST_NOT_SCORED');
  });
});
