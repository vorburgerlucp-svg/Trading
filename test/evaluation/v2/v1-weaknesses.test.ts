// R2: the nine weaknesses of outcome-eval:v1 (src/evaluation/outcome-evaluator.ts). Each test pins the v1 behaviour, which
// stays UNCHANGED (old observations and post-trade reviews must remain reproducible), and shows how v2 treats the same case.
import { describe, expect, it } from 'vitest';
import { evaluateTrade, FLAT_BAND_BP, scoreRecommendation, scoreWarning, type TradeOutcome } from '../../../src/evaluation/outcome-evaluator.js';
import { evaluateDecisionV2 } from '../../../src/evaluation/v2/outcome-eval-v2.js';
import { ModelPerformance } from '../../../src/ai/model-performance.js';
import { NexusMemory } from '../../../src/memory/nexus-memory.js';
import { Decimal } from '../../../src/money/decimal.js';
import { rappen } from '../../../src/money/money.js';
import { AFTER, CAL, bars, continuation, plan, sealed, shortPlan } from './fixtures.js';

const v2 = (action: 'ENTER_LONG' | 'ENTER_SHORT' | 'HOLD' | 'NO_TRADE', p: ReturnType<typeof plan> | ReturnType<typeof continuation>, b: ReturnType<typeof bars>, positionContext: 'flat' | 'long_open' | 'short_open' = 'flat') =>
  evaluateDecisionV2({ decision: { decisionId: 'dec-1', action, positionContext, plan: sealed(p) }, bars: b, calendar: CAL, evaluatedAt: AFTER });

const outcome = (over: Partial<TradeOutcome>): TradeOutcome => ({
  kind: 'trade',
  decisionId: 'd',
  instrumentId: 'i',
  executed: false,
  entryPrice: Decimal.from('100'),
  exitPrice: Decimal.from('103'),
  highestPrice: Decimal.from('104'),
  lowestPrice: Decimal.from('94'),
  feesChf: rappen(0n),
  netResultChf: rappen(0n),
  openedAt: '2026-10-07T10:00:00Z',
  closedAt: '2026-10-07T11:00:00Z',
  knownAt: '2026-10-07T11:01:00Z',
  ...over,
});

describe('outcome-eval:v1 weaknesses, pinned (v1 unchanged) and fixed in v2', () => {
  it('B1 v1 scores hold and no_trade like sell: a correct "hold" of a long before a rise scores 0', () => {
    expect(scoreRecommendation('hold', 300)).toBe(0);
    expect(scoreRecommendation('no_trade', 300)).toBe(0);
    // v2: HOLD of an open long that reaches its target is +2R (hold versus close now).
    expect(v2('HOLD', continuation(), bars([['100', '101', '99', '100'], ['100', '111', '99', '109']]), 'long_open')).toMatchObject({ valueR: '2', outcome: 'FAVORABLE' });
  });

  it('B2 v1 scores the gross price move: costs and the stop do not count', () => {
    // A buy that hit its stop (low 94 < 95) and later recovered to 103: v1 scores it 1 (right), evaluateTrade says hit_then_recovered.
    expect(scoreRecommendation('buy', 300)).toBe(1);
    expect(evaluateTrade(outcome({ stopLoss: Decimal.from('95') }), 'bullish')).toMatchObject({ stop: 'hit_then_recovered', returnBp: 300 });
    // v2: the stop ends the position at -1R.
    expect(v2('ENTER_LONG', plan(), bars([['100', '101', '99', '100'], ['99', '99', '94', '96'], ['96', '104', '96', '103']]))).toMatchObject({ valueR: '-1' });
  });

  it('B3 v1 stop and target geometry is long-only: a short is read with long rules', () => {
    // A short with stop 105 whose high stayed at 104 was NEVER stopped out, but v1 checks low <= stop (the long rule): "hit".
    expect(evaluateTrade(outcome({ stopLoss: Decimal.from('105'), lowestPrice: Decimal.from('99'), highestPrice: Decimal.from('104'), exitPrice: Decimal.from('98') }), 'bearish').stop).toBe('hit');
    // v2 short: stop at 105 first: -1R.
    expect(v2('ENTER_SHORT', shortPlan(), bars([['100', '101', '99', '100'], ['101', '106', '100', '104']]))).toMatchObject({ valueR: '-1' });
  });

  it('B4 v1 takes exit and horizon from the caller; v2 takes them only from the sealed plan', () => {
    const early = evaluateTrade(outcome({ exitPrice: Decimal.from('101') }), 'bullish').returnBp;
    const later = evaluateTrade(outcome({ exitPrice: Decimal.from('103') }), 'bullish').returnBp;
    expect(early).not.toBe(later); // the caller chooses the result
    // v2 has no exit input: the same bars always give the same result.
    const b = bars([['100', '101', '99', '100'], ['100', '102', '99', '101'], ['101', '103', '100', '103'], ['103', '104', '102', '103']]);
    expect(v2('ENTER_LONG', plan(), b).valueR).toBe(v2('ENTER_LONG', plan(), b).valueR);
  });

  it('B5 v1 flat band is a fixed 50 bp for every horizon; v2 measures in R of the plan', () => {
    expect(FLAT_BAND_BP).toBe(50);
    expect(scoreRecommendation('buy', 49)).toBe(0.5);
  });

  it('B6 v1 rewards a critic for staying silent before a gain; v2 does not score warnings against the outcome', () => {
    expect(scoreWarning(false, 300)).toBe(1);
    expect(scoreWarning(true, 300)).toBe(0);
  });

  it('B7 v1 mixes the consensus direction (directionCorrect) and the model recommendation (score)', () => {
    const e = evaluateTrade(outcome({}), 'bearish');
    expect(e.directionCorrect).toBe(false);
    expect(scoreRecommendation('buy', e.returnBp)).toBe(1); // two different "truths" for the same decision
  });

  it('B8 v1 only checks knownAt > asOf; v2 also refuses a plan stored after its earliest entry', () => {
    expect(v2('ENTER_LONG', plan(), bars([['100', '101', '99', '100']]))).not.toMatchObject({ reasons: ['PLAN_SEALED_TOO_LATE'] });
    const late = evaluateDecisionV2({ decision: { decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan({ origin: 'research' }), '2026-10-07T10:05:00.000Z') }, bars: bars([['100', '101', '99', '100']]), calendar: CAL, evaluatedAt: AFTER });
    expect(late.reasons).toEqual(['PLAN_SEALED_TOO_LATE']);
  });

  it('B9 v1 observations count for routing as soon as 20 exist; v2 observations are quarantined (see quarantine.test.ts)', async () => {
    const performance = new ModelPerformance(await NexusMemory.open());
    expect(performance.policy.minSamplesForScore).toBe(20);
    expect(performance.acceptedScoringMethods()).toEqual(['outcome-eval:v1']);
  });
});
