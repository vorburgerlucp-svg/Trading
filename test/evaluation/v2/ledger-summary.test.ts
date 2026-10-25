// R2: sealing plans, the authenticity of a seal, recording evaluations (final only, append-only), and aggregates that never mix.
import { describe, expect, it } from 'vitest';
import { InMemoryAppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import { EvaluationLedgerV2, TradePlanLedger, type SealedPlanRecord } from '../../../src/evaluation/v2/plan-ledger.js';
import { evaluateDecisionFromLedger, evaluateDecisionV2, type EvaluationV2 } from '../../../src/evaluation/v2/outcome-eval-v2.js';
import { EvaluationMixError, summarizeEvaluationsV2 } from '../../../src/evaluation/v2/evaluation-summary.js';
import { performanceObservationOfV2 } from '../../../src/evaluation/v2/performance-v2.js';
import { TradePlanError } from '../../../src/evaluation/v2/trade-plan.js';
import { AFTER, CAL, ENTRY_AT, bars, continuation, plan, sealed } from './fixtures.js';

const clockAt = (iso: string) => () => new Date(iso);
const WIN = bars([['100', '101', '99', '100'], ['100', '111', '99', '109']]);
const LOSS = bars([['100', '101', '99', '100'], ['99', '99', '94', '96']]);
const ledgerAt = (iso: string) => TradePlanLedger.open(new InMemoryAppendOnlyStore<SealedPlanRecord>(), { clock: clockAt(iso) });
const ANALYST = { modelKey: 'openai/test-gpt', role: 'analyst' as const, domain: 'equities' as const, subtask: 'technical_interpretation' as const, shadow: false, occurredAt: '2026-10-07T09:58:00.000Z' };
const fromLedger = (ledger: TradePlanLedger, planId: string | null, action: 'ENTER_LONG' | 'HOLD' = 'ENTER_LONG', b = WIN) =>
  evaluateDecisionFromLedger({ ledger, planId, decision: { decisionId: 'dec-1', action, positionContext: action === 'HOLD' ? 'long_open' : 'flat' }, bars: b, calendar: CAL, evaluatedAt: AFTER });

describe('R2 seal authenticity', () => {
  it('a research plan read from the ledger, stored before its first bar: sealed_before_outcome; it may become an observation', async () => {
    const ledger = await ledgerAt('2026-10-07T09:50:00.000Z');
    await ledger.seal(plan({ origin: 'research' }), '100');
    const e = await fromLedger(ledger, 'plan-1');
    expect(e).toMatchObject({ status: 'EVALUATED', authenticity: 'sealed_before_outcome', planSealedAt: '2026-10-07T09:50:00.000Z', planSequence: 1 });
    expect(performanceObservationOfV2(e, ANALYST)).not.toBeNull();
  });

  it('the same plan handed in by the caller with a convincing early seal is only a claim: unverified, never an observation', () => {
    const forged = { ...sealed(plan({ origin: 'research' }), '2026-10-07T09:55:00.000Z'), sequence: 7 };
    const e = evaluateDecisionV2({ decision: { decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat', plan: forged }, bars: WIN, calendar: CAL, evaluatedAt: AFTER });
    expect(e).toMatchObject({ status: 'EVALUATED', authenticity: 'unverified' });
    expect(performanceObservationOfV2(e, ANALYST)).toBeNull();
  });

  it('a research plan stored after its earliest entry is sealed, but never evaluated (submitted late)', async () => {
    const ledger = await ledgerAt('2026-10-07T10:30:00.000Z');
    const s = await ledger.seal(plan({ origin: 'research' }));
    expect(await fromLedger(ledger, 'plan-1')).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['PLAN_SEALED_TOO_LATE'] });
    expect(Date.parse(s.sealedAt)).toBeGreaterThan(Date.parse(ENTRY_AT));
  });

  it('a historical simulation stored today about the past: historical_reconstruction (never a decision of that time)', async () => {
    const ledger = await ledgerAt('2026-10-25T12:00:00.000Z');
    await ledger.seal(plan());
    expect(await fromLedger(ledger, 'plan-1')).toMatchObject({ status: 'EVALUATED', authenticity: 'historical_reconstruction' });
  });

  it('a plan the ledger does not hold is not evaluable; a continuation plan is read and evaluated the same way', async () => {
    const ledger = await ledgerAt('2026-10-07T09:50:00.000Z');
    expect(await fromLedger(ledger, 'missing')).toMatchObject({ status: 'NOT_EVALUABLE', reasons: ['PLAN_NOT_IN_LEDGER'] });
    await ledger.seal(continuation({ origin: 'research' }), '100');
    expect(await fromLedger(ledger, 'cont-1', 'HOLD')).toMatchObject({ status: 'EVALUATED', valueR: '2', authenticity: 'sealed_before_outcome' });
  });

  it('the same plan again is idempotent; a changed plan under the same id and an incomplete plan are refused', async () => {
    const ledger = await ledgerAt('2026-10-07T09:50:00.000Z');
    const first = await ledger.seal(plan());
    expect(await ledger.seal(plan())).toEqual(first);
    await expect(ledger.seal(plan({ stopLoss: '90' }))).rejects.toThrow(/different content/);
    await expect(ledger.seal(plan({ planId: 'plan-2', maxHoldingBars: 0 }))).rejects.toThrow(TradePlanError);
  });
});

describe('R2 evaluation ledger and aggregates', () => {
  const evaluation = (decisionId: string, b = WIN, over: Parameters<typeof plan>[0] = {}): EvaluationV2 =>
    evaluateDecisionV2({ decision: { decisionId, action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan({ decisionId, ...over })) }, bars: b, calendar: CAL, evaluatedAt: AFTER });

  it('records a final evaluation once per decision, method, policy version and origin; never overwrites; never records PENDING', async () => {
    const ledger = await EvaluationLedgerV2.open(new InMemoryAppendOnlyStore<EvaluationV2>());
    const e = evaluation('dec-1');
    expect(await ledger.record(e)).toBe('APPLIED');
    expect(await ledger.record(e)).toBe('ALREADY_APPLIED');
    await expect(ledger.record({ ...e, valueR: '5' })).rejects.toThrow(/different content/);
    expect(EvaluationLedgerV2.idOf(e)).toBe('dec-1:outcome-eval:v2:outcome-eval-policy:v2.1:historical_simulation');
    const pending = evaluateDecisionV2({ decision: { decisionId: 'dec-9', action: 'ENTER_LONG', positionContext: 'flat', plan: sealed(plan({ decisionId: 'dec-9' })) }, bars: WIN.slice(0, 1), calendar: CAL, evaluatedAt: '2026-10-07T10:20:00.000Z' });
    expect(pending.status).toBe('PENDING');
    await expect(ledger.record(pending)).rejects.toThrow(/pending/);
  });

  it('an aggregate is built from one origin, realization and policy version only: a mixed input is refused, not filtered', () => {
    const sim = [evaluation('a'), evaluation('b', LOSS)];
    const research = evaluation('c', WIN, { origin: 'research' });
    expect(() => summarizeEvaluationsV2([...sim, research], { origin: 'historical_simulation', realization: 'HYPOTHETICAL' })).toThrow(EvaluationMixError);
    expect(() => summarizeEvaluationsV2([...sim, { ...sim[0]!, policyVersion: 'outcome-eval-policy:v2.0' as never }], { origin: 'historical_simulation', realization: 'HYPOTHETICAL' })).toThrow(/policy versions/);
    const s = summarizeEvaluationsV2(sim, { origin: 'historical_simulation', realization: 'HYPOTHETICAL' });
    expect(s).toMatchObject({ total: 2, evaluated: 2, meanR: '0.5', sufficientSample: false, minSamples: 30, policyVersion: 'outcome-eval-policy:v2.1' });
  });

  it('a research aggregate refuses caller-supplied (unverified) plans', () => {
    const r = [evaluation('r1', WIN, { origin: 'research' })];
    expect(() => summarizeEvaluationsV2(r, { origin: 'research', realization: 'HYPOTHETICAL' })).toThrow(/caller-supplied/);
    expect(summarizeEvaluationsV2(r, { origin: 'research', realization: 'HYPOTHETICAL', allowUnverified: true }).authenticity).toEqual({ unverified: 1 });
  });

  it('few cases are descriptive only; many cases give an interval for the mean', () => {
    const many = Array.from({ length: 40 }, (_, i) => evaluation('d' + i, i % 2 === 0 ? WIN : LOSS));
    const s = summarizeEvaluationsV2(many, { origin: 'historical_simulation', realization: 'HYPOTHETICAL' });
    expect(s).toMatchObject({ evaluated: 40, meanR: '0.5', sufficientSample: true });
    const [lo, hi] = s.ci95R!.map(Number);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
    expect(summarizeEvaluationsV2([evaluation('one')], { origin: 'historical_simulation', realization: 'HYPOTHETICAL' })).toMatchObject({ evaluated: 1, ci95R: null, sufficientSample: false });
  });
});
