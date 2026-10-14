import { describe, expect, it } from 'vitest';
import type { ModelKey } from '../../src/ai/model-types.js';
import type { PerformanceObservation } from '../../src/ai/model-performance.js';
import { evaluateTrade, FLAT_BAND_BP, OutcomeEvaluator, scoreAttempt, type TradeOutcome } from '../../src/evaluation/outcome-evaluator.js';
import {
  POST_TRADE_REVIEW_POLICY_VERSION,
  POST_TRADE_REVIEW_VERSION,
  PostTradeReviewError,
  buildPostTradeReview,
  verifyPostTradeReview,
  type PostTradeReviewRequest,
} from '../../src/evaluation/post-trade-review.js';
import { Decimal } from '../../src/money/decimal.js';
import { chf } from '../../src/money/money.js';
import type { DecisionTrace } from '../../src/nexus/nexus-types.js';
import { hashOf } from '../../src/persistence/canonical-json.js';
import { T0 } from '../helpers.js';
import {
  CLAUDE,
  MODELS,
  ScriptedAdapter,
  byRole,
  decisionRequest,
  opinion,
  setupBrain,
  task,
} from '../nexus/fakes.js';

const OUTCOME_KNOWN_AT = '2026-10-10T16:05:00.000Z';

function tradeOutcome(decisionId: string, overrides: Partial<TradeOutcome> = {}): TradeOutcome {
  return {
    kind: 'trade',
    decisionId,
    instrumentId: 'AAPL',
    executed: true,
    entryPrice: Decimal.from('100'),
    exitPrice: Decimal.from('108'),
    stopLoss: Decimal.from('95'),
    takeProfit: Decimal.from('110'),
    highestPrice: Decimal.from('111'),
    lowestPrice: Decimal.from('97'),
    feesChf: chf('1.50'),
    netResultChf: chf('78.50'),
    openedAt: T0,
    closedAt: '2026-10-10T16:00:00.000Z',
    knownAt: OUTCOME_KNOWN_AT,
    ...overrides,
  };
}

async function fixture(overrides: { recommendation?: 'buy' | 'sell' | 'hold' | 'no_trade'; executed?: boolean } = {}) {
  const recommendation = overrides.recommendation ?? 'buy';
  const stance = recommendation === 'sell' ? 'bearish' : recommendation === 'buy' ? 'bullish' : 'neutral';
  const adapter = new ScriptedAdapter(
    'anthropic',
    'test-claude',
    byRole({ analyst: opinion({ recommendation, stance, confidence: 0.7 }) }),
  );
  const ctx = await setupBrain({ adapters: [adapter], active: [MODELS.anthropic] });
  const decision = await ctx.brain.decide(decisionRequest(task({ importance: 'low', requiresIndependentOpinions: false })));
  const trace = ctx.brain.trace(decision.decisionId) as DecisionTrace;
  const outcome = tradeOutcome(decision.decisionId, { executed: overrides.executed ?? true });
  const evaluator = new OutcomeEvaluator(ctx.memory, ctx.performance);
  const { evaluation, observations } = await evaluator.evaluate(trace, outcome);
  if (evaluation.kind !== 'trade') throw new Error('fixture expected trade evaluation');
  return { trace, outcome, evaluation, observations };
}

function requestOf(
  base: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<PostTradeReviewRequest> = {},
): PostTradeReviewRequest {
  return {
    trace: base.trace,
    outcome: base.outcome,
    evaluation: base.evaluation,
    performanceObservations: base.observations,
    ...overrides,
  };
}

function strongTrace(source: DecisionTrace): DecisionTrace {
  const trace = structuredClone(source);
  trace.risk = { passed: true, reasons: [] };
  trace.plan.minIndependentOpinions = 1;
  // A plan step that is still present but never answered is a shortfall, so the requirement and its step are removed together.
  // The base fixture is a committee plan (two analysts, one answered), so a strong trace declares one analyst and one provider.
  trace.plan.steps = trace.plan.steps
    .filter((step) => step.role !== 'critic' && step.role !== 'counter_analyst')
    .map((step) => (step.role === 'analyst' ? { ...step, models: 1, minDistinctProviders: 1 } : step));
  trace.plan.requiresCritic = false;
  trace.plan.requiresCounterAnalysis = false;
  trace.decision.consensus.findings.blocking = [];
  trace.decision.consensus.findings.major = [];
  trace.decision.evidence.warnings = [];
  trace.decision.evidence.impact = [];
  return trace;
}

/** A look-ahead item as the Brain records it: listed as evidence with status not_yet_available, and excluded. */
function lookAheadItem(id: string): DecisionTrace['inputs']['evidence'][number] {
  return { id, type: 'news', source: 'test', observedAt: '2026-10-01T09:00:00.000Z', availableAt: '2026-10-01T09:00:00.000Z', status: 'not_yet_available', version: null };
}

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof PostTradeReviewError ? error.code : 'UNCLASSIFIED:' + String(error);
  }
}

describe('O13 post-trade review — RED', () => {
  it('has an explicit engine identity', () => {
    expect(POST_TRADE_REVIEW_VERSION).toBe('post-trade-review:v1');
  });

  it('is deterministic for identical review inputs and verifies its own result', async () => {
    const base = await fixture();
    const request = requestOf(base);
    const a = buildPostTradeReview(request);
    const b = buildPostTradeReview(request);

    expect(b).toEqual(a);
    expect(a.reviewId).toMatch(/^ptr_[0-9a-f]{40}$/);
    expect(() => verifyPostTradeReview(request, a)).not.toThrow();
  });

  it('refuses an outcome that belongs to another decision', async () => {
    const base = await fixture();
    const outcome = tradeOutcome('other-decision');
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { outcome })))).toBe('INVALID_OUTCOME');
  });

  it('refuses outcome knownAt at or before the decision and refuses non-canonical instants', async () => {
    const base = await fixture();
    const atDecision = tradeOutcome(base.trace.decision.decisionId, { knownAt: base.trace.decision.asOf });
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { outcome: atDecision })))).toBe('INVALID_OUTCOME');

    const nonCanonical = tradeOutcome(base.trace.decision.decisionId, { knownAt: '2026-10-10T16:05:00Z' });
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { outcome: nonCanonical })))).toBe('INVALID_OUTCOME');
  });

  it('does not mutate trace, outcome, evaluation or observations', async () => {
    const base = await fixture();
    const before = {
      trace: hashOf(base.trace),
      outcome: hashOf(base.outcome),
      evaluation: hashOf(base.evaluation),
      observations: hashOf(base.observations),
    };
    buildPostTradeReview(requestOf(base));
    expect(hashOf(base.trace)).toBe(before.trace);
    expect(hashOf(base.outcome)).toBe(before.outcome);
    expect(hashOf(base.evaluation)).toBe(before.evaluation);
    expect(hashOf(base.observations)).toBe(before.observations);
  });

  it('a favorable outcome can never upgrade a blocked process', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.risk.passed = false;
    trace.risk.reasons = ['risk gate failed'];

    const review = buildPostTradeReview(requestOf(base, { trace }));
    expect(review.outcomeClassification).toBe('OUTCOME_FAVORABLE');
    expect(review.processClassification).toBe('PROCESS_BLOCKED');
  });

  it('an adverse outcome does not downgrade an otherwise strong process', async () => {
    const base = await fixture();
    const adverseOutcome = tradeOutcome(base.trace.decision.decisionId, {
      exitPrice: Decimal.from('90'),
      highestPrice: Decimal.from('102'),
      lowestPrice: Decimal.from('88'),
      netResultChf: chf('-101.50'),
    });
    const adverseEvaluation = evaluateTrade(adverseOutcome, base.trace.decision.direction);
    const observations = base.observations.map((o) => ({ ...o, score: 0 }));

    const review = buildPostTradeReview(requestOf(base, {
      trace: strongTrace(base.trace),
      outcome: adverseOutcome,
      evaluation: adverseEvaluation,
      performanceObservations: observations,
    }));
    expect(review.outcomeClassification).toBe('OUTCOME_ADVERSE');
    expect(review.processClassification).toBe('PROCESS_STRONG');
  });

  it('preserves look-ahead exclusions and empirical-support references in process diagnostics', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.inputs.evidence = [...trace.inputs.evidence, lookAheadItem('future-news'), lookAheadItem('future-price')];
    trace.inputs.excludedLookAhead = ['future-news', 'future-price'];
    trace.inputs.quant = {
      status: 'confirmed',
      direction: 'bullish',
      quantRunId: 'quant-run-1',
      scannerRunId: 'scanner-run-1',
      backtestRunIds: ['bt-2', 'bt-1'],
    };

    const review = buildPostTradeReview(requestOf(base, { trace }));
    expect(review.processDiagnostics).toMatchObject({
      excludedLookAheadCount: 2,
      quantStatus: 'confirmed',
      quantRunId: 'quant-run-1',
      scannerRunId: 'scanner-run-1',
    });
    expect(review.processDiagnostics.backtestRunIds).toEqual(['bt-1', 'bt-2']);
  });

  it('reports provider diversity and independent-opinion shortfall deterministically', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.plan.minIndependentOpinions = 2;

    const review = buildPostTradeReview(requestOf(base, { trace }));
    expect(review.processDiagnostics.successfulNonShadowAnalysts).toBe(1);
    expect(review.processDiagnostics.distinctAnalystProviders).toBe(1);
    expect(review.processDiagnostics.requiredIndependentOpinions).toBe(2);
    expect(review.processDiagnostics.independentOpinionShortfall).toBe(1);
    expect(review.processClassification).toBe('PROCESS_WEAK');
  });

  it('reports missing required critic/counter-analysis without inventing participation', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.plan.requiresCritic = true;
    trace.plan.requiresCounterAnalysis = true;

    const review = buildPostTradeReview(requestOf(base, { trace }));
    expect(review.processDiagnostics).toMatchObject({
      criticRequired: true,
      criticObserved: false,
      counterAnalysisRequired: true,
      counterAnalysisObserved: false,
    });
    expect(review.processClassification).toBe('PROCESS_WEAK');
  });

  it('preserves risk and execution gate state; live and physical execution remain locked', async () => {
    const base = await fixture();
    const review = buildPostTradeReview(requestOf(base));

    expect(review.processDiagnostics.riskPassed).toBe(base.trace.risk.passed);
    expect(review.processDiagnostics.paperIntentAllowed).toBe(base.trace.decision.execution.paperIntentAllowed);
    expect(review.processDiagnostics.liveOrderAllowed).toBe(false);
    expect(review.processDiagnostics.physicalPurchaseAllowed).toBe(false);
  });

  it('distinguishes executed from counterfactual outcomes', async () => {
    const executed = await fixture({ executed: true });
    const counterfactual = await fixture({ executed: false });

    expect(buildPostTradeReview(requestOf(executed)).executed).toBe(true);
    expect(buildPostTradeReview(requestOf(counterfactual)).executed).toBe(false);
  });

  it('reuses FLAT_BAND_BP exactly for outcome classification', async () => {
    const base = await fixture();
    const flatOutcome = tradeOutcome(base.trace.decision.decisionId, { exitPrice: Decimal.from('100.5') });
    const flatEvaluation = evaluateTrade(flatOutcome, base.trace.decision.direction);
    expect(flatEvaluation.returnBp).toBe(FLAT_BAND_BP);

    const review = buildPostTradeReview(requestOf(base, {
      outcome: flatOutcome,
      evaluation: flatEvaluation,
      performanceObservations: base.observations.map((o) => ({ ...o, score: 0.5 })),
    }));
    expect(review.outcomeClassification).toBe('OUTCOME_FLAT');
  });

  it('refuses performance observations for another decision or an unknown model attempt', async () => {
    const base = await fixture();
    const wrongDecision = base.observations.map((o) => ({ ...o, decisionId: 'other' }));
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { performanceObservations: wrongDecision })))).toBe('INVALID_PERFORMANCE');

    const unknown: PerformanceObservation = {
      ...base.observations[0]!,
      modelKey: 'openai/not-in-trace',
    };
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { performanceObservations: [unknown] })))).toBe('INVALID_PERFORMANCE');
  });

  it('refuses duplicate performance observations and ambiguous attempt attribution', async () => {
    const base = await fixture();
    expect(codeOf(() => buildPostTradeReview(requestOf(base, {
      performanceObservations: [base.observations[0]!, { ...base.observations[0]! }],
    })))).toBe('INVALID_PERFORMANCE');

    const trace = structuredClone(base.trace);
    trace.attempts.push({ ...trace.attempts[0]!, stepId: trace.attempts[0]!.stepId + '-duplicate' });
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('reuses OutcomeEvaluator performance scores instead of silently rescoring attempts', async () => {
    // Corrected in the GREEN step: the earlier version fed an arbitrary score (0.123) and asserted it was copied through.
    // That encoded the bug (review C). The review now reuses the evaluator's own score, and refuses any other value (P7).
    const base = await fixture();
    const review = buildPostTradeReview(requestOf(base));

    expect(review.attemptAttribution).toHaveLength(1);
    expect(review.attemptAttribution[0]!.performanceScore).toBe(base.observations[0]!.score);
    expect(review.attemptAttribution[0]!.performanceScore).toBe(scoreAttempt(base.trace.attempts[0]!, base.evaluation.returnBp));
  });

  it('never treats raw confidence as probability', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.attempts[0]!.confidenceScore = 0.9;
    trace.attempts[0]!.calibratedProbability = null;
    trace.attempts[0]!.calibrationMethod = null;

    const review = buildPostTradeReview(requestOf(base, { trace }));
    expect(review.attemptAttribution[0]!.confidenceScore).toBe(0.9);
    expect(review.calibrationDiagnostics).toEqual([]);
  });

  it('refuses invalid calibrated probabilities', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.attempts[0]!.calibratedProbability = 1.01;
    trace.attempts[0]!.calibrationMethod = 'histogram_binning@test';

    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('computes a per-attempt Brier contribution only for buy/sell binary direction correctness', async () => {
    const base = await fixture({ recommendation: 'buy' });
    const trace = structuredClone(base.trace);
    trace.attempts[0]!.confidenceScore = 0.8;
    trace.attempts[0]!.calibratedProbability = 0.75;
    trace.attempts[0]!.calibrationMethod = 'histogram_binning@test';

    const review = buildPostTradeReview(requestOf(base, { trace }));
    expect(review.calibrationDiagnostics).toEqual([
      expect.objectContaining({
        modelKey: CLAUDE,
        targetId: 'recommendation_direction_correct:v1',
        calibratedProbability: 0.75,
        outcomeLabel: 1,
        brierContribution: 0.0625,
      }),
    ]);
  });

  it('does not invent a binary calibration target for hold/no_trade', async () => {
    const base = await fixture({ recommendation: 'hold' });
    const trace = structuredClone(base.trace);
    trace.attempts[0]!.calibratedProbability = 0.75;
    trace.attempts[0]!.calibrationMethod = 'histogram_binning@test';

    const review = buildPostTradeReview(requestOf(base, { trace }));
    expect(review.calibrationDiagnostics).toEqual([]);
  });

  it('feedback is advisory only and cannot mutate source policy or system state', async () => {
    const base = await fixture();
    const traceBefore = hashOf(base.trace);
    const review = buildPostTradeReview(requestOf(base));

    expect(review.feedback.length).toBeGreaterThan(0);
    expect(hashOf(base.trace)).toBe(traceBefore);
    expect(review.feedback.every((item) => ['process', 'outcome', 'both'].includes(item.basis))).toBe(true);
  });

  it('normalizes set-like references without erasing semantically meaningful attempt order', async () => {
    const base = await fixture();
    const aTrace = structuredClone(base.trace);
    const bTrace = structuredClone(base.trace);
    aTrace.inputs.evidence = [...aTrace.inputs.evidence, lookAheadItem('a'), lookAheadItem('z')];
    bTrace.inputs.evidence = [...bTrace.inputs.evidence, lookAheadItem('z'), lookAheadItem('a')];
    aTrace.inputs.excludedLookAhead = ['z', 'a'];
    bTrace.inputs.excludedLookAhead = ['a', 'z'];
    aTrace.inputs.quant = { status: 'confirmed', backtestRunIds: ['b', 'a'] };
    bTrace.inputs.quant = { status: 'confirmed', backtestRunIds: ['a', 'b'] };

    const a = buildPostTradeReview(requestOf(base, { trace: aTrace }));
    const b = buildPostTradeReview(requestOf(base, { trace: bTrace }));
    expect(b.inputFingerprint).toBe(a.inputFingerprint);
    expect(b.reviewId).toBe(a.reviewId);
  });

  it('keeps the routing fallback order in identity, because it decides which model is tried next', async () => {
    const base = await fixture();
    const first = 'anthropic/fallback-a' as ModelKey;
    const second = 'anthropic/fallback-b' as ModelKey;
    const aTrace = structuredClone(base.trace);
    const bTrace = structuredClone(base.trace);
    aTrace.routing = [{ stepId: 'analysts', primaries: [CLAUDE], fallbacks: [first, second], shadow: [], rejected: [] }];
    bTrace.routing = [{ stepId: 'analysts', primaries: [CLAUDE], fallbacks: [second, first], shadow: [], rejected: [] }];

    const a = buildPostTradeReview(requestOf(base, { trace: aTrace }));
    const b = buildPostTradeReview(requestOf(base, { trace: bTrace }));
    expect(b.reviewId).not.toBe(a.reviewId);
  });

  it('changing the realized outcome changes review identity', async () => {
    const base = await fixture();
    const a = buildPostTradeReview(requestOf(base));
    const changedOutcome = tradeOutcome(base.trace.decision.decisionId, {
      exitPrice: Decimal.from('109'),
      netResultChf: chf('88.50'),
    });
    const changedEvaluation = evaluateTrade(changedOutcome, base.trace.decision.direction);
    const b = buildPostTradeReview(requestOf(base, {
      outcome: changedOutcome,
      evaluation: changedEvaluation,
    }));

    expect(b.inputFingerprint).not.toBe(a.inputFingerprint);
    expect(b.reviewId).not.toBe(a.reviewId);
  });

  it('refuses an evaluation that does not correspond to the supplied outcome', async () => {
    const base = await fixture();
    const tampered = { ...base.evaluation, returnBp: base.evaluation.returnBp + 1 };
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { evaluation: tampered })))).toBe('INVALID_EVALUATION');
  });

  it('refuses impossible trade chronology and price envelopes', async () => {
    const base = await fixture();

    const closedBeforeOpen = tradeOutcome(base.trace.decision.decisionId, {
      openedAt: '2026-10-10T16:00:00.000Z',
      closedAt: '2026-10-10T15:59:59.999Z',
    });
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { outcome: closedBeforeOpen })))).toBe('INVALID_OUTCOME');

    const knownBeforeClose = tradeOutcome(base.trace.decision.decisionId, {
      closedAt: '2026-10-10T16:06:00.000Z',
      knownAt: '2026-10-10T16:05:00.000Z',
    });
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { outcome: knownBeforeClose })))).toBe('INVALID_OUTCOME');

    const impossibleHigh = tradeOutcome(base.trace.decision.decisionId, {
      exitPrice: Decimal.from('108'),
      highestPrice: Decimal.from('107'),
    });
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { outcome: impossibleHigh })))).toBe('INVALID_OUTCOME');

    const impossibleLow = tradeOutcome(base.trace.decision.decisionId, {
      entryPrice: Decimal.from('100'),
      lowestPrice: Decimal.from('101'),
    });
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { outcome: impossibleLow })))).toBe('INVALID_OUTCOME');
  });

  it('refuses malformed review policy and detects tampered review artifacts', async () => {
    const base = await fixture();
    expect(codeOf(() => buildPostTradeReview(requestOf(base, {
      policy: { version: POST_TRADE_REVIEW_POLICY_VERSION, minimumEvidenceCountForStrong: -1 },
    })))).toBe('INVALID_POLICY');

    const request = requestOf(base);
    const review = buildPostTradeReview(request);
    const tampered = { ...review, processClassification: 'PROCESS_BLOCKED' as const };
    expect(codeOf(() => verifyPostTradeReview(request, tampered))).toBe('INVALID_EVALUATION');
  });

  it('keeps weak-process/favorable-outcome and strong-process/adverse-outcome distinct', async () => {
    const favorable = await fixture();
    const weakTrace = structuredClone(favorable.trace);
    weakTrace.plan.minIndependentOpinions = 2;
    const weak = buildPostTradeReview(requestOf(favorable, { trace: weakTrace }));
    expect([weak.processClassification, weak.outcomeClassification]).toEqual(['PROCESS_WEAK', 'OUTCOME_FAVORABLE']);

    const adverseOutcome = tradeOutcome(favorable.trace.decision.decisionId, {
      exitPrice: Decimal.from('90'),
      highestPrice: Decimal.from('101'),
      lowestPrice: Decimal.from('88'),
      netResultChf: chf('-101.50'),
    });
    const adverseEvaluation = evaluateTrade(adverseOutcome, favorable.trace.decision.direction);
    const strong = buildPostTradeReview(requestOf(favorable, {
      trace: strongTrace(favorable.trace),
      outcome: adverseOutcome,
      evaluation: adverseEvaluation,
      performanceObservations: favorable.observations.map((o) => ({ ...o, score: 0 })),
    }));
    expect([strong.processClassification, strong.outcomeClassification]).toEqual(['PROCESS_STRONG', 'OUTCOME_ADVERSE']);
  });
});

// ---------------------------------------------------------------------------
// Independent review probes (RED). Each probe names the review item it attacks. Probes that test a fail-closed refusal expect an error code; probes that
// test a classification expect the classification. The fixture is the real Brain output (see the explore note in the review commit): its decision is
// NO_ACTION and its outcome is executed, which is itself inconsistent and is documented as a finding rather than repaired here.
// ---------------------------------------------------------------------------

function messageOf(run: () => unknown): string {
  try {
    run();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('O13 review — evidence and time inside the trace (RED)', () => {
  it('P1 evidence available after the decision asOf is refused, not graded as pre-trade evidence (review A)', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.inputs.evidence.push({ id: 'future-news', type: 'news', source: 'test', observedAt: '2026-10-01T09:00:00.000Z', availableAt: '2026-10-01T09:00:00.000Z', status: 'fresh', version: null });
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('P2 evidence whose availableAt precedes its observedAt is refused', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.inputs.evidence.push({ id: 'impossible', type: 'news', source: 'test', observedAt: '2026-10-01T07:59:00.000Z', availableAt: '2026-10-01T07:58:00.000Z', status: 'fresh', version: null });
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('P3 an item present both as included evidence and as excluded look-ahead is refused', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.inputs.excludedLookAhead = ['price-aapl'];
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('P4 duplicate evidence ids are refused rather than counted twice (review item 7)', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.inputs.evidence.push({ ...trace.inputs.evidence[0]! });
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('P5 quarantined evidence is not counted as evidence', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.security.quarantinedEvidence = [{ evidenceId: 'price-aapl', rules: ['test-rule'] }];
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('P6 a capital state read after the decision asOf is refused', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.inputs.capitalStateTimestamp = '2026-10-01T09:00:00.000Z';
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('P9 record and decision must agree on finalAction (review D)', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.record.finalAction = 'RECOMMEND';
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('P10 record, decision and inputs must agree on the capital state reference', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.record.capitalStateRef = 'ledger:other@9:00#asOf=2026-10-01T08:00:00.000Z';
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('P11 a successful attempt must be one of the recorded model runs', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.record.modelRuns = ['not-a-recorded-run'];
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('P12 record evidence references must resolve to the trace inputs (review §6)', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.record.evidenceRefs = [...trace.record.evidenceRefs, 'ghost-evidence'];
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });
});

describe('O13 review — outcome and price semantics (RED)', () => {
  it('P13 a trade opened before the decision was made is refused', async () => {
    const base = await fixture();
    const outcome = tradeOutcome(base.trace.decision.decisionId, { openedAt: '2026-10-01T07:59:59.000Z' });
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { outcome })))).toBe('INVALID_OUTCOME');
  });

  it('P14 a bullish trade whose stop sits above its entry is refused', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.decision.direction = 'bullish';
    const outcome = tradeOutcome(base.trace.decision.decisionId, { stopLoss: Decimal.from('105') });
    const evaluation = evaluateTrade(outcome, 'bullish');
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace, outcome, evaluation })))).toBe('INVALID_OUTCOME');
  });

  it('P15 a bearish trade with stop or target is refused: the stop and target semantics are long-only', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.decision.direction = 'bearish';
    const outcome = tradeOutcome(base.trace.decision.decisionId);
    const evaluation = evaluateTrade(outcome, 'bearish');
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace, outcome, evaluation })))).toBe('INVALID_OUTCOME');
  });

  it('P16 negative fees are refused at runtime', async () => {
    const base = await fixture();
    const outcome = tradeOutcome(base.trace.decision.decisionId, { feesChf: -1n as never });
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { outcome })))).toBe('INVALID_OUTCOME');
  });

  it('P8 a flat buy or sell carries no direction-correct label, so it produces no Brier diagnostic (review G)', async () => {
    const base = await fixture({ recommendation: 'buy' });
    const trace = structuredClone(base.trace);
    trace.attempts[0]!.calibratedProbability = 0.75;
    trace.attempts[0]!.calibrationMethod = 'histogram_binning@test';
    const outcome = tradeOutcome(base.trace.decision.decisionId, { exitPrice: Decimal.from('100.5') });
    const evaluation = evaluateTrade(outcome, trace.decision.direction);
    const observations = base.observations.map((o) => ({ ...o, score: 0.5 }));
    const review = buildPostTradeReview(requestOf(base, { trace, outcome, evaluation, performanceObservations: observations }));
    expect(review.calibrationDiagnostics).toEqual([]);
  });

  it('P22 a calibrated probability on a hold is not reported as an attributed probability (review G)', async () => {
    const base = await fixture({ recommendation: 'hold' });
    const trace = structuredClone(base.trace);
    trace.attempts[0]!.calibratedProbability = 0.75;
    trace.attempts[0]!.calibrationMethod = 'histogram_binning@test';
    const review = buildPostTradeReview(requestOf(base, { trace }));
    expect(review.attemptAttribution[0]!.calibratedProbability).toBeNull();
  });

  it('P21 a calibration method without a probability is refused', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.attempts[0]!.calibrationMethod = 'histogram_binning@test';
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });
});

describe('O13 review — performance scores and classification (RED)', () => {
  it('P7 an observation score that differs from the OutcomeEvaluator rule is refused (review C)', async () => {
    const base = await fixture();
    const observations = base.observations.map((o) => ({ ...o, score: 0.123 }));
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { performanceObservations: observations })))).toBe('INVALID_PERFORMANCE');
  });

  it('P17 evidence impact on the outcome makes the process weak, not merely not strong (review B)', async () => {
    const base = await fixture();
    const trace = strongTrace(base.trace);
    trace.decision.evidence.impact = ['EVIDENCE_IMPACT_TEST' as never];
    expect(buildPostTradeReview(requestOf(base, { trace })).processClassification).toBe('PROCESS_WEAK');
  });

  it('P18 a quant assessment that contradicts the decision makes the process weak (review B)', async () => {
    const base = await fixture();
    const trace = strongTrace(base.trace);
    trace.inputs.quant = { status: 'contradicts', direction: 'bearish', quantRunId: 'quant-run-x' };
    expect(buildPostTradeReview(requestOf(base, { trace })).processClassification).toBe('PROCESS_WEAK');
  });

  it('P19 a pending required human approval prevents a strong process grade (review B)', async () => {
    const base = await fixture();
    const trace = strongTrace(base.trace);
    trace.decision.requiresHumanApproval = true;
    trace.humanApproval = { required: true, status: 'pending', reasons: ['test approval'] };
    expect(buildPostTradeReview(requestOf(base, { trace })).processClassification).toBe('PROCESS_ACCEPTABLE');
  });

  it('P20 a plan step whose model or provider requirement is unmet makes the process weak (review B)', async () => {
    const base = await fixture();
    const trace = strongTrace(base.trace);
    trace.plan.steps = trace.plan.steps.map((step) => (step.id === 'analysts' ? { ...step, models: 2, minDistinctProviders: 2 } : step));
    expect(buildPostTradeReview(requestOf(base, { trace })).processClassification).toBe('PROCESS_WEAK');
  });

  it('P24 a policy that allows a strong process without any evidence is refused', async () => {
    const base = await fixture();
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { policy: { version: POST_TRADE_REVIEW_POLICY_VERSION, minimumEvidenceCountForStrong: 0 } })))).toBe('INVALID_POLICY');
  });

  it('P23 set-like reasons do not change review identity (review D, item 16)', async () => {
    const base = await fixture();
    const a = structuredClone(base.trace);
    const b = structuredClone(base.trace);
    a.decision.reasons = ['ALPHA', 'BETA'];
    b.decision.reasons = ['BETA', 'ALPHA'];
    expect(buildPostTradeReview(requestOf(base, { trace: b })).reviewId).toBe(buildPostTradeReview(requestOf(base, { trace: a })).reviewId);
  });

  it('P25 the review message names the reason for an impossible stop (guard for the new refusals)', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.decision.direction = 'bearish';
    const outcome = tradeOutcome(base.trace.decision.decisionId);
    const evaluation = evaluateTrade(outcome, 'bearish');
    expect(messageOf(() => buildPostTradeReview(requestOf(base, { trace, outcome, evaluation })))).toMatch(/stop|target/i);
  });
});

// Isolated tests for the rules the mutation campaign found untested. Each one fails only through the rule it names: the trace
// is otherwise consistent, so a mutation of that rule cannot be masked by another check.
describe('O13 review — isolated rule tests (from the mutation campaign)', () => {
  it('refuses a net result that is not a Rappen amount', async () => {
    const base = await fixture();
    const outcome = tradeOutcome(base.trace.decision.decisionId, { netResultChf: 78.5 as never });
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { outcome })))).toBe('INVALID_OUTCOME');
  });

  it('refuses an executed flag that is not a boolean', async () => {
    const base = await fixture();
    const outcome = tradeOutcome(base.trace.decision.decisionId, { executed: 'yes' as never });
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { outcome })))).toBe('INVALID_OUTCOME');
  });

  it('refuses a bullish stop that sits exactly at entry', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.decision.direction = 'bullish';
    const outcome = tradeOutcome(base.trace.decision.decisionId, { stopLoss: Decimal.from('100') });
    const evaluation = evaluateTrade(outcome, 'bullish');
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace, outcome, evaluation })))).toBe('INVALID_OUTCOME');
  });

  it('refuses a bullish target that sits exactly at entry', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.decision.direction = 'bullish';
    const outcome = tradeOutcome(base.trace.decision.decisionId, { takeProfit: Decimal.from('100') });
    const evaluation = evaluateTrade(outcome, 'bullish');
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace, outcome, evaluation })))).toBe('INVALID_OUTCOME');
  });

  it('refuses a record reasonCodes list that disagrees with the decision', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.record.reasonCodes = [...trace.record.reasonCodes, 'EXTRA_UNRECORDED_CODE'];
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('refuses decision and humanApproval that disagree on whether approval is required', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.decision.requiresHumanApproval = true;
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('refuses an approval that is required but not pending', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.decision.requiresHumanApproval = true;
    trace.humanApproval = { required: true, status: 'not_required', reasons: ['test approval'] };
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('accepts evidence that becomes available exactly at asOf', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    const asOf = trace.decision.asOf;
    trace.inputs.evidence = trace.inputs.evidence.map((item) =>
      item.id === 'price-aapl' ? { ...item, observedAt: asOf, availableAt: asOf } : item,
    );
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('NO_ERROR');
  });

  it('refuses a look-ahead item that is not listed as excluded', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.inputs.evidence = [...trace.inputs.evidence, lookAheadItem('future-unlisted')];
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('refuses evidence whose availability precedes observation even when the record cites it', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.inputs.evidence = [...trace.inputs.evidence, {
      id: 'impossible-cited', type: 'news', source: 'test',
      observedAt: '2026-10-01T07:59:00.000Z', availableAt: '2026-10-01T07:58:00.000Z', status: 'fresh', version: null,
    }];
    trace.record.evidenceRefs = [...trace.record.evidenceRefs, 'impossible-cited'];
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('refuses a usable evidence item that the record does not cite', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.inputs.evidence = [...trace.inputs.evidence, {
      id: 'uncited-fresh', type: 'news', source: 'test',
      observedAt: '2026-10-01T07:00:00.000Z', availableAt: '2026-10-01T07:00:00.000Z', status: 'fresh', version: null,
    }];
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('counts a strong process at the policy minimum, inclusive', async () => {
    const base = await fixture();
    const trace = strongTrace(base.trace);
    const count = buildPostTradeReview(requestOf(base, { trace })).processDiagnostics.evidenceCount;
    const review = buildPostTradeReview(requestOf(base, {
      trace,
      policy: { version: POST_TRADE_REVIEW_POLICY_VERSION, minimumEvidenceCountForStrong: count },
    }));
    expect(review.processClassification).toBe('PROCESS_STRONG');
  });

  it('refuses a plan step whose provider diversity is unmet even when its model count is met', async () => {
    const base = await fixture();
    const trace = strongTrace(base.trace);
    trace.plan.steps = trace.plan.steps.map((step) => (step.id === 'analysts' ? { ...step, minDistinctProviders: 2 } : step));
    expect(buildPostTradeReview(requestOf(base, { trace })).processClassification).toBe('PROCESS_WEAK');
  });

  it('refuses a second successful attempt for the same step and model as ambiguous attribution', async () => {
    const base = await fixture();
    const trace = structuredClone(base.trace);
    trace.attempts.push({ ...trace.attempts[0]!, runId: 'duplicate-run' });
    trace.record.modelRuns = [...trace.record.modelRuns, 'duplicate-run'];
    expect(codeOf(() => buildPostTradeReview(requestOf(base, { trace })))).toBe('INVALID_TRACE');
  });

  it('reports REVIEW_MODEL_CONFIDENCE when a calibrated probability has a large binary error', async () => {
    const base = await fixture({ recommendation: 'buy' });
    const trace = structuredClone(base.trace);
    trace.attempts[0]!.calibratedProbability = 0.1;
    trace.attempts[0]!.calibrationMethod = 'histogram_binning@test';
    const review = buildPostTradeReview(requestOf(base, { trace }));
    expect(review.feedback.map((item) => item.code)).toContain('REVIEW_MODEL_CONFIDENCE');
  });

  it('reports only KEEP_PROCESS when no process-review trigger fires', async () => {
    const base = await fixture();
    const review = buildPostTradeReview(requestOf(base, { trace: strongTrace(base.trace) }));
    expect(review.feedback.map((item) => item.code)).toEqual(['KEEP_PROCESS']);
  });

  it('treats a bullish move of exactly the flat band as not directionally correct', async () => {
    const base = await fixture();
    const flat = tradeOutcome(base.trace.decision.decisionId, { exitPrice: Decimal.from('100.5') });
    expect(evaluateTrade(flat, 'bullish').directionCorrect).toBe(false);
  });

  it('treats a low equal to the stop as a stop hit', async () => {
    const base = await fixture();
    const touched = tradeOutcome(base.trace.decision.decisionId, { lowestPrice: Decimal.from('95'), stopLoss: Decimal.from('95') });
    expect(evaluateTrade(touched, 'bullish').stop).toBe('hit_then_recovered');
  });
});

describe('O13 review — the pure core has no side effects (guard)', () => {
  it('the review module imports no memory, registry, champion, risk, capital, broker or audit module at runtime', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../src/evaluation/post-trade-review.ts', import.meta.url), 'utf8');
    const runtimeImports = [...source.matchAll(/^import (?!type )[^;]*from '([^']+)';/gm)].map((match) => match[1]!);
    const forbidden = /nexus-memory|model-registry|champion|risk|capital|broker|audit|postgres|model-performance/i;
    expect(runtimeImports.filter((spec) => forbidden.test(spec))).toEqual([]);
  });
});
