// R2: sealing plans and recording evaluations (append-only, idempotent), and aggregates that never mix sources.
import { describe, expect, it } from 'vitest';
import { InMemoryAppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import { EvaluationLedgerV2, TradePlanLedger, type SealedPlanRecord } from '../../../src/evaluation/v2/plan-ledger.js';
import { evaluateDecisionV2, type EvaluationV2 } from '../../../src/evaluation/v2/outcome-eval-v2.js';
import { EvaluationMixError, summarizeEvaluationsV2 } from '../../../src/evaluation/v2/evaluation-summary.js';
import { TradePlanError } from '../../../src/evaluation/v2/trade-plan.js';
import { AFTER, CAL, ENTRY_AT, bars, plan, sealed } from './fixtures.js';

const clockAt = (iso: string) => () => new Date(iso);
const WIN = bars([['100', '101', '99', '100'], ['100', '111', '99', '109']]);
const LOSS = bars([['100', '101', '99', '100'], ['99', '99', '94', '96']]);

describe('R2 trade plan ledger', () => {
  it('a sealed plan carries the time it was stored; before the entry it is evaluable', async () => {
    const ledger = await TradePlanLedger.open(new InMemoryAppendOnlyStore<SealedPlanRecord>(), { clock: clockAt('2026-10-07T09:50:00.000Z') });
    const s = await ledger.seal(plan(), '100');
    expect(s).toMatchObject({ sealedAt: '2026-10-07T09:50:00.000Z', sequence: 1 });
    expect(await ledger.get('plan-1')).toEqual(s);
    expect(evaluateDecisionV2({ decision: { decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: s }, bars: WIN, calendar: CAL, evaluatedAt: AFTER }).status).toBe('EVALUATED');
  });

  it('a plan stored after its earliest entry is sealed, but never evaluated (submitted late)', async () => {
    const ledger = await TradePlanLedger.open(new InMemoryAppendOnlyStore<SealedPlanRecord>(), { clock: clockAt('2026-10-07T10:30:00.000Z') });
    const s = await ledger.seal(plan());
    expect(evaluateDecisionV2({ decision: { decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: s }, bars: WIN, calendar: CAL, evaluatedAt: AFTER })).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['PLAN_SEALED_TOO_LATE'] });
    expect(Date.parse(s.sealedAt)).toBeGreaterThan(Date.parse(ENTRY_AT));
  });

  it('the same plan again is idempotent; a changed plan under the same id and an incomplete plan are refused', async () => {
    const ledger = await TradePlanLedger.open(new InMemoryAppendOnlyStore<SealedPlanRecord>(), { clock: clockAt('2026-10-07T09:50:00.000Z') });
    const first = await ledger.seal(plan());
    expect(await ledger.seal(plan())).toEqual(first);
    await expect(ledger.seal(plan({ stopLoss: '90' }))).rejects.toThrow(/different content/);
    await expect(ledger.seal(plan({ planId: 'plan-2', maxHoldingBars: 0 }))).rejects.toThrow(TradePlanError);
  });
});

describe('R2 evaluation ledger and aggregates', () => {
  const evaluation = (decisionId: string, b = WIN, over: Parameters<typeof plan>[0] = {}): EvaluationV2 =>
    evaluateDecisionV2({ decision: { decisionId, action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan({ decisionId, ...over })) }, bars: b, calendar: CAL, evaluatedAt: AFTER });

  it('records once per decision, method and origin; never overwrites', async () => {
    const ledger = await EvaluationLedgerV2.open(new InMemoryAppendOnlyStore<EvaluationV2>());
    const e = evaluation('dec-1');
    expect(await ledger.record(e)).toBe('APPLIED');
    expect(await ledger.record(e)).toBe('ALREADY_APPLIED');
    await expect(ledger.record({ ...e, valueR: '5' })).rejects.toThrow(/different content/);
    expect(EvaluationLedgerV2.idOf(e)).toBe('dec-1:outcome-eval:v2:historical_simulation');
  });

  it('an aggregate is built from one origin and one realization only: a mixed input is refused, not filtered', () => {
    const sim = [evaluation('a'), evaluation('b', LOSS)];
    const research = evaluation('c', WIN, { origin: 'research' });
    expect(() => summarizeEvaluationsV2([...sim, research], { origin: 'historical_simulation', realization: 'HYPOTHETICAL' })).toThrow(EvaluationMixError);
    const s = summarizeEvaluationsV2(sim, { origin: 'historical_simulation', realization: 'HYPOTHETICAL' });
    expect(s).toMatchObject({ total: 2, evaluated: 2, meanR: '0.5', sufficientSample: false, minSamples: 30 });
  });

  it('few cases are descriptive only; many cases give an interval for the mean', () => {
    const many = Array.from({ length: 40 }, (_, i) => evaluation('d' + i, i % 2 === 0 ? WIN : LOSS));
    const s = summarizeEvaluationsV2(many, { origin: 'historical_simulation', realization: 'HYPOTHETICAL' });
    expect(s).toMatchObject({ evaluated: 40, meanR: '0.5', sufficientSample: true });
    const [lo, hi] = s.ci95R!.map(Number);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
    // A single gain is not evidence: one case is never "sufficient".
    expect(summarizeEvaluationsV2([evaluation('one')], { origin: 'historical_simulation', realization: 'HYPOTHETICAL' })).toMatchObject({ evaluated: 1, ci95R: null, sufficientSample: false });
  });
});
