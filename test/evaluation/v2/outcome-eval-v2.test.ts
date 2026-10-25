// R2 evaluation v2 (policy v2.1): actions and position context, the seal and its authenticity, process versus outcome, forecasts.
import { describe, expect, it } from 'vitest';
import { evaluateDecisionV2, type DecisionV2, type ProcessAssessment } from '../../../src/evaluation/v2/outcome-eval-v2.js';
import { tradePlanHash, tradePlanProblems } from '../../../src/evaluation/v2/trade-plan.js';
import { AFTER, CAL, ENTRY_AT, bars, continuation, plan, sealed, shortContinuation, shortPlan } from './fixtures.js';

const RISE_TO_TARGET = bars([['100', '101', '99', '100'], ['100', '111', '99', '109']]);
const FALL_TO_STOP = bars([['100', '101', '99', '100'], ['99', '99', '94', '96']]);
const FALL_TO_SHORT_TARGET = bars([['100', '101', '99', '100'], ['100', '101', '89', '91']]);
const RISE_TO_SHORT_STOP = bars([['100', '101', '99', '100'], ['101', '106', '100', '104']]);
/** The price ends far higher, but a long candidate would have been stopped out on the way. */
const DIP_THEN_RISE = bars([['100', '101', '99', '100'], ['99', '99', '94', '96'], ['96', '130', '96', '128']]);
const GOOD: ProcessAssessment = { assessedAt: '2026-10-07T09:58:00.000Z', dataQualityOk: true, rulesPassed: true, riskWithinLimits: true, expectedEdgeExceedsCosts: true };
const WEAK: ProcessAssessment = { ...GOOD, rulesPassed: false };
const research = { origin: 'research' as const };

const evaluate = (decision: DecisionV2, b = RISE_TO_TARGET, at = AFTER) => evaluateDecisionV2({ decision, bars: b, calendar: CAL, evaluatedAt: at });

describe('R2: entry decisions', () => {
  it('ENTER_LONG and ENTER_SHORT: the entered plan, in their own direction', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()) })).toMatchObject({ status: 'EVALUATED', valueR: '2', outcome: 'FAVORABLE', policyVersion: 'outcome-eval-policy:v2.1' });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_SHORT', positionContext: 'flat', plan: sealed(shortPlan()) }, FALL_TO_SHORT_TARGET)).toMatchObject({ status: 'EVALUATED', valueR: '2' });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_SHORT', positionContext: 'flat', plan: sealed(shortPlan()) }, RISE_TO_TARGET)).toMatchObject({ status: 'EVALUATED', outcome: 'ADVERSE' });
  });

  it('a plan whose side does not fit the action, or an entry with an open position, is not evaluated', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_SHORT', positionContext: 'flat', plan: sealed(plan()) })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['PLAN_SIDE_DOES_NOT_FIT_ACTION'], valueR: null });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'long_open', plan: sealed(plan()) })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['ENTRY_WITH_OPEN_POSITION'] });
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

describe('R2: HOLD and EXIT of an OPEN position (hold versus close now, no new entry)', () => {
  const costs = { version: 'c-hold', commissionBps: 10, fixedFeePerSide: '1', feeCurrency: 'USD', spreadBps: 0, spreadSource: 'modeled' as const, slippageBps: 0 };

  it('open long, HOLD, target reached: hold sells at 110 instead of 100 now: +100, +2R; the old entry at 90 plays no role', () => {
    const e = evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'long_open', plan: sealed(continuation()) });
    expect(e).toMatchObject({ status: 'EVALUATED', valueR: '2', outcome: 'FAVORABLE', simulation: { kind: 'continuation', entry: null, closeNow: { fillPrice: '100', barStart: ENTRY_AT }, exit: { reason: 'target', fillPrice: '110' }, netPnl: '100', riskAmount: '50' } });
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'long_open', plan: sealed(continuation({ position: { ...continuation().position, entryPrice: '50' } })) }).valueR).toBe('2');
  });

  it('entry costs are never charged again: only the exit fees of the two alternatives differ', () => {
    // Hold: sells at 110, fee 10 × 110 × 0.001 + 1 = 2.1. Close now: sells at 100, fee 10 × 100 × 0.001 + 1 = 2.0. Value 100 − 0.1.
    const e = evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'long_open', plan: sealed(continuation({ costs })) });
    expect(e.simulation).toMatchObject({ grossPnl: '100', fees: '0.1', netPnl: '99.9', closeNow: { fees: '2' } });
    expect(e.valueR).toBe('1.998');
  });

  it('the OPEN quantity counts (7 left after an earlier partial exit), not a plan size', () => {
    const e = evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'long_open', plan: sealed(continuation({ position: { ...continuation().position, quantity: '7' } })) });
    expect(e.simulation).toMatchObject({ quantity: '7', netPnl: '70', riskAmount: '35' });
    expect(e.valueR).toBe('2');
  });

  it('open long, HOLD into the stop: -1R; EXIT of the same position: +1R (the loss it avoided)', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'long_open', plan: sealed(continuation()), process: GOOD }, FALL_TO_STOP)).toMatchObject({ valueR: '-1', outcome: 'ADVERSE', lossWithinPlannedRisk: true, quadrant: 'good_decision_bad_outcome' });
    expect(evaluate({ decisionId: 'dec-1', action: 'EXIT', positionContext: 'long_open', plan: sealed(continuation()) }, FALL_TO_STOP)).toMatchObject({ valueR: '1', outcome: 'FAVORABLE', lossWithinPlannedRisk: null });
    expect(evaluate({ decisionId: 'dec-1', action: 'EXIT', positionContext: 'long_open', plan: sealed(continuation()) })).toMatchObject({ valueR: '-2', outcome: 'ADVERSE' });
  });

  it('open short, HOLD: a fall to the target is +2R, a rise to the stop -1R; EXIT mirrors it', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'short_open', plan: sealed(shortContinuation()) }, FALL_TO_SHORT_TARGET)).toMatchObject({ valueR: '2', simulation: { closeNow: { fillPrice: '100' }, exit: { reason: 'target', fillPrice: '90' } } });
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'short_open', plan: sealed(shortContinuation()) }, RISE_TO_SHORT_STOP)).toMatchObject({ valueR: '-1' });
    expect(evaluate({ decisionId: 'dec-1', action: 'EXIT', positionContext: 'short_open', plan: sealed(shortContinuation()) }, RISE_TO_SHORT_STOP)).toMatchObject({ valueR: '1' });
  });

  it('both alternatives use the same fill model: with spread, close now sells at 99.9 and hold at 109.89', () => {
    const spread = { ...costs, commissionBps: 0, fixedFeePerSide: '0', spreadBps: 20 };
    const e = evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'long_open', plan: sealed(continuation({ costs: spread })) });
    expect(e.simulation).toMatchObject({ closeNow: { fillPrice: '99.9' }, exit: { fillPrice: '109.89' }, netPnl: '99.9' });
  });

  it('the decision bar opens below the stop: holding exits at the same open as closing: value 0 (flat)', () => {
    const gap = bars([['94', '96', '93', '95']]);
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'long_open', plan: sealed(continuation()) }, gap)).toMatchObject({ valueR: '0', outcome: 'FLAT', simulation: { exit: { reason: 'stop_gap' } } });
  });

  it('without the real position state a HOLD or EXIT is not evaluable (no invented entry)', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'long_open' })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['NO_POSITION_STATE'] });
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'long_open', plan: sealed(plan()) })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['NO_POSITION_STATE'] });
    const noPosition = { ...continuation(), position: undefined as never };
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'long_open', plan: sealed(noPosition) })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['PLAN_INCOMPLETE'] });
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'flat', plan: sealed(continuation()) })).toMatchObject({ reasons: ['HOLD_WITHOUT_POSITION'] });
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'short_open', plan: sealed(continuation()) })).toMatchObject({ reasons: ['PLAN_POSITION_CONTEXT_MISMATCH'] });
  });

  it('a partial exit is not modelled and not evaluated', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'EXIT', positionContext: 'long_open', exitFraction: 0.5, plan: sealed(continuation()) })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['PARTIAL_EXIT_NOT_SUPPORTED'] });
    expect(evaluate({ decisionId: 'dec-1', action: 'EXIT', positionContext: 'long_open', exitFraction: 1, plan: sealed(continuation()) }).status).toBe('EVALUATED');
  });

  it('a continuation plan is checked: position side and context agree, opened before the decision, stop on the loss side', () => {
    expect(tradePlanProblems(continuation(), '100')).toEqual([]);
    expect(tradePlanProblems(shortContinuation(), '100')).toEqual([]);
    expect(tradePlanProblems(continuation({ positionContext: 'short_open' }))).toContainEqual(expect.stringMatching(/does not match the open long position/));
    expect(tradePlanProblems(continuation({ position: { ...continuation().position, openedAt: '2026-10-07T11:00:00.000Z' } }))).toContain('the position was opened after the decision point');
    expect(tradePlanProblems(continuation(), '94')).toContain('stopLoss must lie on the loss side of the reference price');
  });
});

describe('R2: the plan must exist before its outcome', () => {
  it('a LIVE (research) plan sealed at or after its first bar is refused (submitted late)', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan(research), ENTRY_AT) })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['PLAN_SEALED_TOO_LATE'] });
    expect(evaluate({ decisionId: 'dec-1', action: 'HOLD', positionContext: 'long_open', plan: sealed(continuation(research), '2026-10-07T12:00:00.000Z') })).toMatchObject({ reasons: ['PLAN_SEALED_TOO_LATE'] });
  });

  it('a HISTORICAL simulation is made now about the past: no wall-clock seal is required, it is never a live decision', () => {
    const e = evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan(), '2026-10-25T12:00:00.000Z') });
    expect(e).toMatchObject({ status: 'EVALUATED', origin: 'historical_simulation', authenticity: 'unverified' });
  });

  it('a plan made from data newer than its start or its seal, a changed plan, or a plan of another decision is refused', () => {
    const late = plan({ ...research, dataBasis: { asOf: '2026-10-07T09:59:30.000Z', storedThrough: 1, inputFingerprint: 'a'.repeat(64) } });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(late) })).toMatchObject({ reasons: ['PLAN_DATA_AFTER_SEAL'] });
    const afterStart = plan({ dataBasis: { asOf: '2026-10-07T10:30:00.000Z', storedThrough: 1, inputFingerprint: 'a'.repeat(64) } });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(afterStart) })).toMatchObject({ reasons: ['PLAN_INCOMPLETE'] });
    const tampered = { ...sealed(plan()), plan: plan({ stopLoss: '80' }) };
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: tampered })).toMatchObject({ reasons: ['PLAN_HASH_MISMATCH'] });
    expect(evaluate({ decisionId: 'dec-2', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()) })).toMatchObject({ reasons: ['PLAN_OF_ANOTHER_DECISION'] });
  });

  it('a superseded plan schema (trade-plan:v1, which simulated a new entry for HOLD) is never evaluated', () => {
    const old = { ...plan(), schema: 'trade-plan:v1' } as unknown as ReturnType<typeof plan>;
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: { plan: old, planHash: tradePlanHash(old), sealedAt: '2026-10-07T09:00:00.000Z', sequence: 1 } })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['PLAN_SCHEMA_SUPERSEDED'] });
  });

  it('a demo, paper or live plan is never simulated: it needs the observed fills', () => {
    for (const realization of ['DEMO', 'PAPER', 'LIVE'] as const) {
      expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan({ realization, origin: 'demo' })) })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['OBSERVED_FILLS_REQUIRED'], realization });
    }
  });

  it('an incomplete or inconsistent plan is refused', () => {
    const p = plan();
    expect(tradePlanProblems(p, '100')).toEqual([]);
    const { stopLoss: _s, ...noStop } = p;
    expect(tradePlanProblems(noStop)).toContain('stopLoss is required (a positive price)');
    expect(tradePlanProblems({ ...p, costs: undefined as never })).toContainEqual(expect.stringMatching(/costs are required/));
    expect(tradePlanProblems({ ...p, maxHoldingBars: 0 })).toContainEqual(expect.stringMatching(/maxHoldingBars/));
    expect(tradePlanProblems({ ...p, positionContext: 'short_open' as never })).toContainEqual(expect.stringMatching(/an entry plan starts flat/));
    expect(tradePlanProblems(p, '94')).toContain('stopLoss must lie on the loss side of the reference price');
    expect(tradePlanProblems(shortPlan(), '100')).toEqual([]);
    expect(tradePlanProblems(shortPlan({ stopLoss: '95' }), '100')).toContain('stopLoss must lie on the loss side of the reference price');
    expect(tradePlanProblems({ ...p, costs: { ...p.costs, feeCurrency: 'CHF' } })).toContainEqual(expect.stringMatching(/fee currency CHF differs from the quote currency USD/));
    const { quoteCurrency: _q, ...noCurrency } = p;
    expect(tradePlanProblems(noCurrency)).toContain('quoteCurrency is required (ISO code)');
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

  it('a process assessed after the plan start does not count', () => {
    const late = { ...GOOD, assessedAt: '2026-10-07T11:00:00.000Z' };
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), process: late })).toMatchObject({ process: 'UNKNOWN', quadrant: null, reasons: ['PROCESS_ASSESSED_AFTER_START'] });
  });

  it('a flat result has no quadrant; a single case is marked as such; every result lists its assumptions', () => {
    const flat = bars([['100', '101', '99', '100'], ['100', '101', '99', '100.2'], ['100', '101', '99', '100'], ['100', '101', '99', '100.1']]);
    const e = evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), process: GOOD }, flat);
    expect(e).toMatchObject({ outcome: 'FLAT', quadrant: null, evidence: 'single_case' });
    expect(e.simulation!.assumptions).toEqual(['FULL_FILL_AT_MODELED_PRICE', 'FIXED_STOP_AND_TARGET', 'MODELED_SPREAD']);
  });
});

describe('R2: forecasts are scored as probabilities of a defined event', () => {
  const forecast = (probability: number, statedAt = '2026-10-07T09:58:00.000Z') => ({ event: 'target_before_stop' as const, probability, statedAt });

  it('target first: Brier (0.7 - 1)^2 = 0.09; stop first: (0.7 - 0)^2 = 0.49', () => {
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), forecast: forecast(0.7) }).forecast).toMatchObject({ occurred: true, brier: expect.closeTo(0.09, 10) });
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), forecast: forecast(0.7) }, FALL_TO_STOP).forecast).toMatchObject({ occurred: false, brier: expect.closeTo(0.49, 10) });
  });

  it('no outcome of the event (time exit, or an assumed intrabar order): not scored; a forecast stated after the seal or start: not scored', () => {
    const timeExit = bars([['100', '101', '99', '100'], ['100', '101', '99', '100'], ['100', '101', '99', '100'], ['100', '101', '99', '100']]);
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), forecast: forecast(0.7) }, timeExit).forecast).toMatchObject({ occurred: null, brier: null });
    const ambiguous = bars([['100', '101', '99', '100'], ['100', '111', '94', '100']]);
    expect(evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), forecast: forecast(0.7) }, ambiguous).forecast).toMatchObject({ occurred: null, brier: null });
    const late = evaluate({ decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan()), forecast: forecast(0.7, '2026-10-07T10:30:00.000Z') });
    expect(late.forecast).toBeNull();
    expect(late.reasons).toContain('FORECAST_NOT_SCORED');
  });
});
