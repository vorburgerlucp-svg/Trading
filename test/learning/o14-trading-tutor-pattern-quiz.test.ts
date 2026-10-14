import { describe, expect, it } from 'vitest';
import {
  POST_TRADE_REVIEW_VERSION,
  type PostTradeReview,
  type PostTradeFeedbackItem,
} from '../../src/evaluation/post-trade-review.js';
import {
  TRADING_TUTOR_POLICY_VERSION,
  TradingTutorError,
  buildTradingTutorLesson,
  verifyTradingTutorLesson,
  type TradingTutorPolicy,
} from '../../src/learning/trading-tutor.js';
import {
  PATTERN_QUIZ_POLICY_VERSION,
  PatternQuizError,
  buildPatternQuiz,
  gradePatternQuiz,
  verifyPatternQuiz,
  type PatternQuizPolicy,
} from '../../src/learning/pattern-quiz.js';
import type { PatternObservation } from '../../src/patterns/pattern-types.js';

function feedback(code: PostTradeFeedbackItem['code'], basis: PostTradeFeedbackItem['basis'] = 'process'): PostTradeFeedbackItem {
  return {
    code,
    severity: code === 'REVIEW_RISK_DISCIPLINE' ? 'major' : 'minor',
    basis,
    references: ['fixture'],
    explanation: 'fixture explanation',
  };
}

function review(overrides: Partial<PostTradeReview> = {}): PostTradeReview {
  return {
    reviewId: 'ptr_' + 'a'.repeat(40),
    engineVersion: POST_TRADE_REVIEW_VERSION,
    inputFingerprint: 'b'.repeat(64),
    policy: {
      version: 'post-trade-review-policy:v1',
      minimumEvidenceCountForStrong: 1,
    },
    decisionId: 'decision-1',
    decisionAsOf: '2026-01-01T12:00:00.000Z',
    outcomeKnownAt: '2026-01-02T12:00:00.000Z',
    instrumentId: 'AAPL',
    executed: false,
    processClassification: 'PROCESS_WEAK',
    outcomeClassification: 'OUTCOME_FAVORABLE',
    processDiagnostics: {
      evidenceCount: 2,
      excludedLookAheadCount: 1,
      evidenceWarningCount: 0,
      blockingEvidenceImpactCount: 0,
      successfulNonShadowAnalysts: 1,
      distinctAnalystProviders: 1,
      requiredIndependentOpinions: 2,
      independentOpinionShortfall: 1,
      planStepShortfallCount: 1,
      criticRequired: false,
      criticObserved: false,
      counterAnalysisRequired: false,
      counterAnalysisObserved: false,
      quantStatus: 'not_available',
      quantRunId: null,
      scannerRunId: null,
      backtestRunIds: [],
      riskPassed: true,
      blockingFindingCount: 0,
      majorFindingCount: 0,
      humanApprovalRequired: false,
      humanApprovalStatus: 'not_required',
      paperIntentAllowed: false,
      liveOrderAllowed: false,
      physicalPurchaseAllowed: false,
      capitalStateRefPresent: true,
      allocationSkipReasons: [],
    },
    outcomeDiagnostics: {
      returnBp: 800,
      maxAdverseExcursionBp: -300,
      maxFavorableExcursionBp: 1100,
      stop: 'not_set',
      target: 'not_set',
      directionCorrect: true,
      netResultChf: 7850n,
      feesChf: 150n,
    },
    attemptAttribution: [
      {
        stepId: 'analysts',
        modelKey: 'anthropic/test',
        role: 'analyst',
        shadow: false,
        recommendation: 'buy',
        confidenceScore: 0.7,
        calibratedProbability: null,
        calibrationMethod: null,
        performanceScore: 1,
        directionCorrect: true,
      },
    ],
    calibrationDiagnostics: [],
    feedback: [feedback('REVIEW_PROVIDER_DIVERSITY')],
    sourceFingerprints: {
      trace: 'c'.repeat(64),
      outcome: 'd'.repeat(64),
      evaluation: 'e'.repeat(64),
      performanceObservations: 'f'.repeat(64),
    },
    ...overrides,
  };
}

function cleanProcessDiagnostics(source = review().processDiagnostics): PostTradeReview['processDiagnostics'] {
  return {
    ...source,
    evidenceCount: Math.max(1, source.evidenceCount),
    evidenceWarningCount: 0,
    blockingEvidenceImpactCount: 0,
    independentOpinionShortfall: 0,
    planStepShortfallCount: 0,
    criticRequired: false,
    criticObserved: false,
    counterAnalysisRequired: false,
    counterAnalysisObserved: false,
    quantStatus: 'confirmed',
    riskPassed: true,
    blockingFindingCount: 0,
    majorFindingCount: 0,
    humanApprovalRequired: false,
    humanApprovalStatus: 'not_required',
  };
}

const tutorPolicy: TradingTutorPolicy = {
  version: TRADING_TUTOR_POLICY_VERSION,
  learnerLevel: 'beginner',
  maxLearningObjectives: 3,
  maxReflectionQuestions: 3,
  includeCalibrationDiagnostics: true,
  includeExecutionDiagnostics: true,
};

function observation(overrides: Partial<PatternObservation> = {}): PatternObservation {
  return {
    patternInstanceId: 'pi_fixture',
    patternObservationId: 'po_fixture',
    patternType: 'head_and_shoulders',
    direction: 'bearish',
    status: 'forming',
    instrumentId: 'AAPL',
    interval: '1d',
    series: {
      source: 'fixture',
      interval: '1d',
      session: 'regular',
      adjustment: 'raw',
    },
    asOf: '2026-01-10T00:00:00.000Z',
    firstSeenAt: '2026-01-05T00:00:00.000Z',
    confirmedAt: '2026-01-12T00:00:00.000Z',
    invalidatedAt: null,
    resolvedAt: '2026-01-20T00:00:00.000Z',
    anchors: [
      {
        role: 'left_shoulder',
        kind: 'high',
        price: '110',
        time: '2026-01-02T00:00:00.000Z',
        barIndex: 2,
        confirmedAt: '2026-01-03T00:00:00.000Z',
      },
      {
        role: 'head',
        kind: 'high',
        price: '120',
        time: '2026-01-04T00:00:00.000Z',
        barIndex: 4,
        confirmedAt: '2026-01-05T00:00:00.000Z',
      },
      {
        role: 'right_shoulder',
        kind: 'high',
        price: '111',
        time: '2026-01-06T00:00:00.000Z',
        barIndex: 6,
        confirmedAt: '2026-01-07T00:00:00.000Z',
      },
    ],
    confirmation: {
      direction: 'down',
      level: '100',
      buffer: '0.5',
      confirmedByBarTime: '2026-01-12T00:00:00.000Z',
    },
    invalidation: { rule: 'close_above_head', level: '121' },
    target: { method: 'head_to_neckline', price: '82' },
    boundaries: {
      neckline: { intercept: '100', slope: '0' },
    },
    geometryMetrics: {
      symmetry: '0.92',
      height: '20',
    },
    chartContext: {
      chartContextId: 'ctx-1',
      dominantTrend: 'down',
      currentPhase: 'distribution',
      timeframeAlignment: 'aligned',
    },
    evidenceRefs: {
      patternRunId: 'pr_fixture',
      chartContextId: 'ctx-1',
    },
    ...overrides,
  };
}

function quizPolicy(overrides: Partial<PatternQuizPolicy> = {}): PatternQuizPolicy {
  return {
    version: PATTERN_QUIZ_POLICY_VERSION,
    mode: 'pattern_identification',
    optionCount: 4,
    learnerLevel: 'beginner',
    revealGeometryMetrics: true,
    revealChartContext: false,
    revealLifecycleTimestampsAvailableByAsOfOnly: true,
    ...overrides,
  };
}

function errorCode(run: () => unknown): string {
  try {
    run();
    return 'NO_ERROR';
  } catch (error) {
    if (error instanceof TradingTutorError || error instanceof PatternQuizError) return error.code;
    return 'UNCLASSIFIED:' + String(error);
  }
}

describe('O14 Trading Tutor — RED', () => {
  it('same review and policy produce the same deterministic lesson', () => {
    const source = review();
    const a = buildTradingTutorLesson(source, tutorPolicy);
    const b = buildTradingTutorLesson(source, tutorPolicy);

    expect(b).toEqual(a);
    expect(a.lessonId).toMatch(/^ttl_[0-9a-f]{40}$/);
    expect(() => verifyTradingTutorLesson(source, a)).not.toThrow();
  });

  it('weak process plus favorable outcome remains a cautionary process lesson', () => {
    const lesson = buildTradingTutorLesson(review(), tutorPolicy);
    expect(lesson.categories).toContain('PROCESS_DISCIPLINE');
    expect(lesson.processOutcomeExplanation.toLowerCase()).toContain('weak');
    expect(lesson.processOutcomeExplanation.toLowerCase()).not.toContain('good decision because it made money');
  });

  it('strong process plus adverse outcome remains process-positive', () => {
    const source = review({
      processClassification: 'PROCESS_STRONG',
      processDiagnostics: cleanProcessDiagnostics(),
      outcomeClassification: 'OUTCOME_ADVERSE',
      feedback: [feedback('KEEP_PROCESS')],
      outcomeDiagnostics: {
        ...review().outcomeDiagnostics,
        returnBp: -800,
        netResultChf: -8150n,
        directionCorrect: false,
      },
    });
    const lesson = buildTradingTutorLesson(source, tutorPolicy);
    expect(lesson.categories).toContain('KEEP_PROCESS');
    expect(lesson.processOutcomeExplanation.toLowerCase()).toContain('strong');
    expect(lesson.processOutcomeExplanation.toLowerCase()).not.toContain('bad process because');
  });

  it('blocked process is never converted to praise by a favorable result', () => {
    const source = review({
      processClassification: 'PROCESS_BLOCKED',
      outcomeClassification: 'OUTCOME_FAVORABLE',
      processDiagnostics: {
        ...review().processDiagnostics,
        riskPassed: false,
      },
      feedback: [feedback('REVIEW_RISK_DISCIPLINE')],
    });
    const lesson = buildTradingTutorLesson(source, tutorPolicy);
    expect(lesson.categories).toContain('RISK_DISCIPLINE');
    expect(lesson.processOutcomeExplanation.toLowerCase()).toContain('blocked');
    expect(lesson.processOutcomeExplanation.toLowerCase()).not.toContain('successful process');
  });

  it('maps O13 feedback codes to deterministic lesson categories', () => {
    const source = review({
      processClassification: 'PROCESS_ACCEPTABLE',
      processDiagnostics: {
        ...cleanProcessDiagnostics(),
        evidenceCount: 0,
      },
      feedback: [
        feedback('REVIEW_EVIDENCE_QUALITY'),
        feedback('REVIEW_MODEL_CONFIDENCE', 'both'),
        feedback('REVIEW_STOP_PLACEMENT', 'outcome'),
        feedback('REVIEW_QUANT_SUPPORT'),
      ],
    });
    const lesson = buildTradingTutorLesson(source, tutorPolicy);
    expect(lesson.categories).toEqual([
      'EVIDENCE_QUALITY',
      'MODEL_CONFIDENCE',
      'QUANT_SUPPORT',
      'STOP_TARGET_REVIEW',
    ]);
  });

  it('learner level changes lesson identity', () => {
    const source = review();
    const beginner = buildTradingTutorLesson(source, tutorPolicy);
    const advanced = buildTradingTutorLesson(source, { ...tutorPolicy, learnerLevel: 'advanced' });
    expect(advanced.lessonId).not.toBe(beginner.lessonId);
  });

  it('enforces configured objective and reflection-question limits', () => {
    const source = review({
      feedback: [
        feedback('REVIEW_EVIDENCE_QUALITY'),
        feedback('REVIEW_MODEL_CONFIDENCE', 'both'),
        feedback('REVIEW_QUANT_SUPPORT'),
      ],
    });
    const lesson = buildTradingTutorLesson(source, {
      ...tutorPolicy,
      maxLearningObjectives: 1,
      maxReflectionQuestions: 1,
    });
    expect(lesson.learningObjectives).toHaveLength(1);
    expect(lesson.reflectionQuestions).toHaveLength(1);
  });

  it('rejects malformed policy and unsupported review version', () => {
    expect(errorCode(() => buildTradingTutorLesson(review(), { ...tutorPolicy, maxLearningObjectives: 0 }))).toBe('INVALID_POLICY');
    expect(errorCode(() => buildTradingTutorLesson({ ...review(), engineVersion: 'other' as never }, tutorPolicy))).toBe('INVALID_REVIEW');
  });

  it('rejects non-finite calibration diagnostics instead of teaching from corrupt metrics', () => {
    const source = review({
      calibrationDiagnostics: [
        {
          stepId: 'analysts',
          modelKey: 'anthropic/test',
          targetId: 'recommendation_direction_correct:v1',
          calibratedProbability: 0.7,
          outcomeLabel: 1,
          brierContribution: Number.NaN,
        },
      ],
    });
    expect(errorCode(() => buildTradingTutorLesson(source, tutorPolicy))).toBe('INVALID_REVIEW');
  });

  it('refuses an internally inconsistent O13 process classification', () => {
    const impossibleStrong = review({
      processClassification: 'PROCESS_STRONG',
      processDiagnostics: {
        ...review().processDiagnostics,
        riskPassed: false,
        blockingFindingCount: 0,
      },
    });
    expect(errorCode(() => buildTradingTutorLesson(impossibleStrong, tutorPolicy))).toBe('INVALID_REVIEW');

    const impossibleWeak = review({
      processClassification: 'PROCESS_WEAK',
      processDiagnostics: {
        ...review().processDiagnostics,
        independentOpinionShortfall: 0,
        planStepShortfallCount: 0,
        majorFindingCount: 0,
        blockingEvidenceImpactCount: 0,
        criticRequired: false,
        criticObserved: false,
        counterAnalysisRequired: false,
        counterAnalysisObserved: false,
        quantStatus: 'confirmed',
      },
      feedback: [feedback('KEEP_PROCESS')],
    });
    expect(errorCode(() => buildTradingTutorLesson(impossibleWeak, tutorPolicy))).toBe('INVALID_REVIEW');
  });

  it('lesson verifier detects tampering and lesson has no execution-command field', () => {
    const source = review();
    const lesson = buildTradingTutorLesson(source, tutorPolicy);
    expect('tradeInstruction' in lesson).toBe(false);
    expect('order' in lesson).toBe(false);

    const tampered = { ...lesson, title: lesson.title + ' BUY NOW' };
    expect(errorCode(() => verifyTradingTutorLesson(source, tampered))).toBe('INVALID_LESSON');
  });
});

describe('O14 Pattern Quiz — RED', () => {
  it('same observation and policy produce the same deterministic quiz', () => {
    const source = observation();
    const policy = quizPolicy();
    const a = buildPatternQuiz(source, policy);
    const b = buildPatternQuiz(source, policy);
    expect(b).toEqual(a);
    expect(a.quizId).toMatch(/^pq_[0-9a-f]{40}$/);
    expect(() => verifyPatternQuiz(source, a)).not.toThrow();
  });

  it('pattern-identification answer is the source pattern type without exposing it in visible evidence', () => {
    const quiz = buildPatternQuiz(observation(), quizPolicy({ mode: 'pattern_identification' }));
    expect(quiz.answer.label).toBe('head_and_shoulders');
    expect(JSON.stringify(quiz.publicView.visibleEvidence)).not.toContain('head_and_shoulders');
  });

  it('direction quiz answer uses the observation direction and does not expose confirmation direction', () => {
    const quiz = buildPatternQuiz(observation(), quizPolicy({ mode: 'direction', optionCount: 3 }));
    expect(quiz.answer.label).toBe('bearish');
    expect(quiz.publicView.visibleEvidence.confirmation.direction).toBeNull();
  });

  it('lifecycle quiz uses the status known at asOf and refuses future lifecycle state', () => {
    const valid = observation({
      status: 'confirmed',
      confirmedAt: '2026-01-09T00:00:00.000Z',
      resolvedAt: null,
    });
    const quiz = buildPatternQuiz(valid, quizPolicy({ mode: 'lifecycle' }));
    expect(quiz.answer.label).toBe('confirmed');

    const inconsistent = observation({
      status: 'completed',
      confirmedAt: '2026-01-09T00:00:00.000Z',
      resolvedAt: '2026-01-20T00:00:00.000Z',
    });
    expect(errorCode(() => buildPatternQuiz(inconsistent, quizPolicy({ mode: 'lifecycle' })))).toBe('INVALID_OBSERVATION');
  });

  it('visible payload omits lifecycle timestamps that occur after asOf', () => {
    const quiz = buildPatternQuiz(observation(), quizPolicy());
    expect(quiz.publicView.visibleEvidence.lifecycleTimestamps).toEqual({
      confirmedAt: null,
      invalidatedAt: null,
      resolvedAt: null,
    });
    expect(JSON.stringify(quiz.publicView)).not.toContain('2026-01-12T00:00:00.000Z');
    expect(JSON.stringify(quiz.publicView)).not.toContain('2026-01-20T00:00:00.000Z');
  });

  it('future-only lifecycle changes do not alter the visible quiz or its identity', () => {
    const a = observation({
      confirmedAt: '2026-01-12T00:00:00.000Z',
      resolvedAt: '2026-01-20T00:00:00.000Z',
      confirmation: {
        direction: 'down',
        level: '100',
        buffer: '0.5',
        confirmedByBarTime: '2026-01-12T00:00:00.000Z',
      },
    });
    const b = observation({
      confirmedAt: '2026-02-12T00:00:00.000Z',
      resolvedAt: '2026-03-20T00:00:00.000Z',
      confirmation: {
        direction: 'up',
        level: '999',
        buffer: '0.5',
        confirmedByBarTime: '2026-02-12T00:00:00.000Z',
      },
    });
    const qa = buildPatternQuiz(a, quizPolicy({ mode: 'pattern_identification' }));
    const qb = buildPatternQuiz(b, quizPolicy({ mode: 'pattern_identification' }));

    expect(qb.publicView).toEqual(qa.publicView);
    expect(qb.quizId).toBe(qa.quizId);
    expect(qb.inputFingerprint).toBe(qa.inputFingerprint);
  });

  it('visible payload never serializes target outcome or the complete source observation', () => {
    const quiz = buildPatternQuiz(observation(), quizPolicy());
    const visible = JSON.stringify(quiz.publicView);
    expect(visible).not.toContain('"target"');
    expect(visible).not.toContain('"status"');
    expect(visible).not.toContain('"patternType"');
    expect(visible).not.toContain('"direction":"bearish"');
  });

  it('distractors are deterministic, unique, valid and contain the correct answer exactly once', () => {
    const quiz = buildPatternQuiz(observation(), quizPolicy({ optionCount: 4 }));
    const labels = quiz.publicView.options.map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.filter((x) => x === quiz.answer.label)).toHaveLength(1);
    expect(buildPatternQuiz(observation(), quizPolicy({ optionCount: 4 })).publicView.options).toEqual(quiz.publicView.options);
  });

  it('grades correct and incorrect options deterministically', () => {
    const quiz = buildPatternQuiz(observation(), quizPolicy());
    const correct = gradePatternQuiz(quiz, quiz.answer.optionId);
    expect(correct.correct).toBe(true);
    expect(correct.correctAnswer).toBe('head_and_shoulders');

    const wrongId = quiz.publicView.options.find((o) => o.id !== quiz.answer.optionId)!.id;
    const wrong = gradePatternQuiz(quiz, wrongId);
    expect(wrong.correct).toBe(false);
    expect(wrong.selectedAnswer).not.toBe(wrong.correctAnswer);
  });

  it('quiz verifier detects tampered options and tampered correct answer', () => {
    const source = observation();
    const quiz = buildPatternQuiz(source, quizPolicy());

    const optionTamper = structuredClone(quiz);
    optionTamper.publicView.options[0]!.label = 'fake-pattern';
    expect(errorCode(() => verifyPatternQuiz(source, optionTamper))).toBe('INVALID_QUIZ');

    const answerTamper = structuredClone(quiz);
    answerTamper.answer.label = 'double_top';
    expect(errorCode(() => verifyPatternQuiz(source, answerTamper))).toBe('INVALID_QUIZ');
  });

  it('refuses observation asOf before firstSeenAt and non-canonical times', () => {
    expect(errorCode(() => buildPatternQuiz(
      observation({ asOf: '2026-01-04T00:00:00.000Z' }),
      quizPolicy(),
    ))).toBe('INVALID_OBSERVATION');

    expect(errorCode(() => buildPatternQuiz(
      observation({ asOf: '2026-01-10T00:00:00Z' }),
      quizPolicy(),
    ))).toBe('INVALID_OBSERVATION');
  });

  it('enforces quiz policy bounds and valid mode', () => {
    expect(errorCode(() => buildPatternQuiz(observation(), quizPolicy({ optionCount: 1 })))).toBe('INVALID_POLICY');
    expect(errorCode(() => buildPatternQuiz(observation(), quizPolicy({ optionCount: 10 })))).toBe('INVALID_POLICY');
    expect(errorCode(() => buildPatternQuiz(observation(), quizPolicy({ mode: 'future_outcome' as never })))).toBe('INVALID_POLICY');
  });

  it('set-like visible evidence refs do not make identity order-dependent', () => {
    const a = observation({
      evidenceRefs: { patternRunId: 'pr_fixture', chartContextId: 'ctx-1' },
    });
    const b = observation({
      evidenceRefs: { chartContextId: 'ctx-1', patternRunId: 'pr_fixture' },
    });
    expect(buildPatternQuiz(a, quizPolicy()).quizId).toBe(buildPatternQuiz(b, quizPolicy()).quizId);
  });

  it('does not reveal geometry or chart context when policy hides them', () => {
    const quiz = buildPatternQuiz(observation(), quizPolicy({
      revealGeometryMetrics: false,
      revealChartContext: false,
    }));
    expect(quiz.publicView.visibleEvidence.geometryMetrics).toBeNull();
    expect(quiz.publicView.visibleEvidence.chartContext).toBeNull();
  });

  it('refuses invalid submission ids instead of inventing an answer', () => {
    const quiz = buildPatternQuiz(observation(), quizPolicy());
    expect(errorCode(() => gradePatternQuiz(quiz, 'missing-option'))).toBe('INVALID_SUBMISSION');
  });
});

// ---------------------------------------------------------------------------
// Independent review probes (RED). Each probe names one attack from the O14 review. Probes that fail today expect a refusal or
// a non-leaking view; the pins below them already hold and keep the guarantee from regressing.
// ---------------------------------------------------------------------------

describe('O14 review — tutor probes (RED)', () => {
  it('T1 refuses an outcome classification that contradicts the embedded return', () => {
    const r = review({ outcomeClassification: 'OUTCOME_ADVERSE' });
    expect(errorCode(() => buildTradingTutorLesson(r, tutorPolicy))).toBe('INVALID_REVIEW');
  });

  it('T2 refuses an unknown feedback code instead of silently dropping it', () => {
    const r = review({ feedback: [{ ...feedback('KEEP_PROCESS'), code: 'REVIEW_MADE_UP' as never }] });
    expect(errorCode(() => buildTradingTutorLesson(r, tutorPolicy))).toBe('INVALID_REVIEW');
  });

  it('T3 refuses malformed feedback severity or basis at runtime', () => {
    const badSeverity = review({ feedback: [{ ...feedback('REVIEW_PROVIDER_DIVERSITY'), severity: 'critical' as never }] });
    const badBasis = review({ feedback: [{ ...feedback('REVIEW_PROVIDER_DIVERSITY'), basis: 'luck' as never }] });
    expect(errorCode(() => buildTradingTutorLesson(badSeverity, tutorPolicy))).toBe('INVALID_REVIEW');
    expect(errorCode(() => buildTradingTutorLesson(badBasis, tutorPolicy))).toBe('INVALID_REVIEW');
  });

  it('T4 refuses a Brier contribution that is not (probability minus label) squared', () => {
    const r = review({
      calibrationDiagnostics: [{
        stepId: 'analysts', modelKey: 'anthropic/test', targetId: 'recommendation_direction_correct:v1',
        calibratedProbability: 0.75, outcomeLabel: 1, brierContribution: 0.5,
      }],
    });
    expect(errorCode(() => buildTradingTutorLesson(r, tutorPolicy))).toBe('INVALID_REVIEW');
  });

  it('T5 refuses a calibration diagnostic for an unsupported binary target', () => {
    const r = review({
      calibrationDiagnostics: [{
        stepId: 'analysts', modelKey: 'anthropic/test', targetId: 'something_else' as never,
        calibratedProbability: 0.75, outcomeLabel: 1, brierContribution: 0.0625,
      }],
    });
    expect(errorCode(() => buildTradingTutorLesson(r, tutorPolicy))).toBe('INVALID_REVIEW');
  });

  it('T6 refuses non-finite or malformed O13 process diagnostics', () => {
    const r = review({
      processClassification: 'PROCESS_ACCEPTABLE',
      processDiagnostics: { ...cleanProcessDiagnostics(), evidenceCount: Number.NaN },
    });
    expect(errorCode(() => buildTradingTutorLesson(r, tutorPolicy))).toBe('INVALID_REVIEW');
  });

  it('T7 refuses KEEP_PROCESS on a weak or blocked review', () => {
    const r = review({ feedback: [feedback('KEEP_PROCESS')] });
    expect(errorCode(() => buildTradingTutorLesson(r, tutorPolicy))).toBe('INVALID_REVIEW');
  });

  it('T8 refuses a review without feedback instead of inventing a process lesson', () => {
    const r = review({ feedback: [] });
    expect(errorCode(() => buildTradingTutorLesson(r, tutorPolicy))).toBe('INVALID_REVIEW');
  });

  it('T9 refuses a policy with unknown fields instead of hashing them into lesson identity', () => {
    const p = { ...tutorPolicy, sneakyField: 'x' } as TradingTutorPolicy;
    expect(errorCode(() => buildTradingTutorLesson(review(), p))).toBe('INVALID_POLICY');
  });

  it('T10 verifier can pin the policy the consumer expects and refuses a lesson re-issued under another policy', () => {
    const reissued = buildTradingTutorLesson(review(), { ...tutorPolicy, learnerLevel: 'advanced' });
    const verifyPinned = verifyTradingTutorLesson as unknown as (r: PostTradeReview, l: unknown, expected: TradingTutorPolicy) => void;
    expect(errorCode(() => verifyPinned(review(), reissued, tutorPolicy))).toBe('INVALID_LESSON');
  });
});

describe('O14 review — quiz probes (RED)', () => {
  it('Q1 lifecycle refuses forming status when a confirmation time is already known by asOf', () => {
    const src = observation({ status: 'forming', confirmedAt: '2026-01-09T00:00:00.000Z', resolvedAt: null });
    expect(errorCode(() => buildPatternQuiz(src, quizPolicy({ mode: 'lifecycle' })))).toBe('INVALID_OBSERVATION');
  });

  it('Q2 lifecycle refuses confirmed status without a confirmation time', () => {
    const src = observation({ status: 'confirmed', confirmedAt: null, resolvedAt: null });
    expect(errorCode(() => buildPatternQuiz(src, quizPolicy({ mode: 'lifecycle' })))).toBe('INVALID_OBSERVATION');
  });

  it('Q3 lifecycle refuses completed status without a resolution time', () => {
    const src = observation({ status: 'completed', confirmedAt: '2026-01-09T00:00:00.000Z', resolvedAt: null });
    expect(errorCode(() => buildPatternQuiz(src, quizPolicy({ mode: 'lifecycle' })))).toBe('INVALID_OBSERVATION');
  });

  it('Q4 lifecycle refuses invalidated status without an invalidation time', () => {
    const src = observation({ status: 'invalidated', confirmedAt: null, invalidatedAt: null, resolvedAt: null });
    expect(errorCode(() => buildPatternQuiz(src, quizPolicy({ mode: 'lifecycle' })))).toBe('INVALID_OBSERVATION');
  });

  it('Q5 refuses invalidation and resolution as mutually exclusive terminal times in every mode', () => {
    const src = observation({ confirmedAt: null, invalidatedAt: '2026-01-09T00:00:00.000Z', resolvedAt: '2026-01-11T00:00:00.000Z' });
    expect(errorCode(() => buildPatternQuiz(src, quizPolicy({ mode: 'pattern_identification' })))).toBe('INVALID_OBSERVATION');
  });

  it('Q6 refuses resolution before confirmation in every mode', () => {
    const src = observation({ confirmedAt: '2026-01-08T00:00:00.000Z', resolvedAt: '2026-01-07T00:00:00.000Z', invalidatedAt: null });
    expect(errorCode(() => buildPatternQuiz(src, quizPolicy({ mode: 'pattern_identification' })))).toBe('INVALID_OBSERVATION');
  });

  it('Q7 refuses confirmation before the pattern was first seen in every mode', () => {
    const src = observation({ firstSeenAt: '2026-01-05T00:00:00.000Z', confirmedAt: '2026-01-04T00:00:00.000Z', resolvedAt: null });
    expect(errorCode(() => buildPatternQuiz(src, quizPolicy({ mode: 'pattern_identification' })))).toBe('INVALID_OBSERVATION');
  });

  it('Q8 refuses duplicate anchor roles', () => {
    const base = observation();
    const src = observation({ anchors: [base.anchors[0]!, base.anchors[0]!] });
    expect(errorCode(() => buildPatternQuiz(src, quizPolicy()))).toBe('INVALID_OBSERVATION');
  });

  it('Q9 refuses non-decimal prices and boundary values', () => {
    const base = observation();
    const badPrice = observation({ anchors: [{ ...base.anchors[0]!, price: 'high' }] });
    const badBoundary = observation({ boundaries: { neckline: { intercept: 'abc', slope: '0' } } });
    expect(errorCode(() => buildPatternQuiz(badPrice, quizPolicy()))).toBe('INVALID_OBSERVATION');
    expect(errorCode(() => buildPatternQuiz(badBoundary, quizPolicy()))).toBe('INVALID_OBSERVATION');
  });

  it('Q10 refuses a malformed boundaries container with a classified error', () => {
    const src = observation({ boundaries: null as never });
    expect(errorCode(() => buildPatternQuiz(src, quizPolicy()))).toBe('INVALID_OBSERVATION');
  });

  it('Q11 identification does not show the confirmation direction, which discriminates breakout families', () => {
    const src = observation({ status: 'confirmed', confirmedAt: '2026-01-09T00:00:00.000Z', resolvedAt: null });
    const quiz = buildPatternQuiz(src, quizPolicy({ mode: 'pattern_identification' }));
    expect(quiz.publicView.visibleEvidence.confirmation.direction).toBeNull();
  });

  it('Q12 public view carries no pattern-role names in identification mode', () => {
    const visible = JSON.stringify(buildPatternQuiz(observation(), quizPolicy({ mode: 'pattern_identification' })).publicView);
    expect(visible).not.toContain('left_shoulder');
    expect(visible).not.toContain('"head"');
  });

  it('Q13 public view carries no boundary names in identification or direction mode', () => {
    for (const mode of ['pattern_identification', 'direction'] as const) {
      const visible = JSON.stringify(buildPatternQuiz(observation(), quizPolicy({ mode, optionCount: 3 })).publicView);
      expect(visible).not.toContain('neckline');
    }
  });

  it('Q14 public view carries no invalidation rule name', () => {
    const visible = JSON.stringify(buildPatternQuiz(observation(), quizPolicy()).publicView);
    expect(visible).not.toContain('close_above_head');
  });

  it('Q15 public view carries no geometry metric names', () => {
    const visible = JSON.stringify(buildPatternQuiz(observation(), quizPolicy({ revealGeometryMetrics: true })).publicView);
    expect(visible).not.toContain('"symmetry"');
  });

  it('Q16 public view shares no mutable state with the source observation', () => {
    const src = observation();
    const quiz = buildPatternQuiz(src, quizPolicy({ revealChartContext: true }));
    // The public boundary key is positional now (line_1), so the shared-state check reads it under that key.
    quiz.publicView.visibleEvidence.boundaries.line_1!.intercept = 'tampered';
    quiz.publicView.visibleEvidence.chartContext!.currentPhase = 'tampered';
    expect(src.boundaries.neckline!.intercept).toBe('100');
    expect(src.chartContext!.currentPhase).toBe('distribution');
  });

  it('Q17 grading refuses a quiz whose answer was rewritten without re-deriving its fingerprints', () => {
    const quiz = buildPatternQuiz(observation(), quizPolicy());
    const other = quiz.publicView.options.find((o) => o.id !== quiz.answer.optionId)!;
    const forged = structuredClone(quiz);
    forged.answer.optionId = other.id;
    forged.answer.label = other.label as never;
    expect(errorCode(() => gradePatternQuiz(forged, other.id))).toBe('INVALID_QUIZ');
  });

  it('Q18 verifier can pin the quiz policy the consumer expects and refuses a quiz re-issued under another policy', () => {
    const reissued = buildPatternQuiz(observation(), quizPolicy({ optionCount: 2 }));
    const verifyPinned = verifyPatternQuiz as unknown as (o: PatternObservation, q: unknown, expected: PatternQuizPolicy) => void;
    expect(errorCode(() => verifyPinned(observation(), reissued, quizPolicy()))).toBe('INVALID_QUIZ');
  });
});

describe('O14 review — pins that already hold', () => {
  it('the tutor and quiz modules import no memory, registry, champion, risk, capital, broker, audit, provider or network module at runtime', async () => {
    const { readFileSync } = await import('node:fs');
    const forbidden = /nexus-memory|model-performance|model-registry|champion|risk|capital|broker|audit|postgres|append-only|provider|http|adapter/i;
    for (const file of ['src/learning/trading-tutor.ts', 'src/learning/pattern-quiz.ts']) {
      const source = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
      const runtimeImports = [...source.matchAll(/^import (?!type )[^;]*from '([^']+)';/gm)].map((match) => match[1]!);
      expect(runtimeImports.filter((spec) => forbidden.test(spec)), file).toEqual([]);
    }
  });

  it('confirmation exactly at asOf is known, and one millisecond later is a lifecycle refusal and a hidden fact otherwise', () => {
    const atAsOf = observation({ status: 'confirmed', confirmedAt: '2026-01-10T00:00:00.000Z', resolvedAt: null });
    expect(errorCode(() => buildPatternQuiz(atAsOf, quizPolicy({ mode: 'lifecycle' })))).toBe('NO_ERROR');

    const afterAsOf = observation({ status: 'forming', confirmedAt: '2026-01-10T00:00:00.001Z', resolvedAt: null });
    expect(errorCode(() => buildPatternQuiz(afterAsOf, quizPolicy({ mode: 'lifecycle' })))).toBe('INVALID_OBSERVATION');
    const identification = buildPatternQuiz(afterAsOf, quizPolicy({ mode: 'pattern_identification' }));
    expect(identification.publicView.visibleEvidence.confirmation.level).toBeNull();
  });

  it('the option count is bounded by the vocabulary of the mode', () => {
    expect(errorCode(() => buildPatternQuiz(observation(), quizPolicy({ mode: 'direction', optionCount: 4 })))).toBe('INVALID_POLICY');
    const three = buildPatternQuiz(observation(), quizPolicy({ mode: 'direction', optionCount: 3 }));
    expect(three.publicView.options.map((o) => o.label).sort()).toEqual(['bearish', 'bullish', 'neutral']);
  });

  it('future-only confirmation, invalidation and anchor values do not alter the visible quiz or its identity', () => {
    const base = observation();
    // resolvedAt is null here: invalidation and resolution are mutually exclusive, so the future invalidation is the only terminal time.
    const a = buildPatternQuiz(observation({
      invalidatedAt: '2026-02-01T00:00:00.000Z',
      resolvedAt: null,
      anchors: [...base.anchors, { ...base.anchors[0]!, role: 'future_point', time: '2026-03-01T00:00:00.000Z', confirmedAt: '2026-03-02T00:00:00.000Z' }],
    }), quizPolicy());
    const b = buildPatternQuiz(observation({
      invalidatedAt: '2026-04-01T00:00:00.000Z',
      resolvedAt: null,
      anchors: [...base.anchors, { ...base.anchors[0]!, role: 'future_point', time: '2026-05-01T00:00:00.000Z', confirmedAt: '2026-05-02T00:00:00.000Z' }],
    }), quizPolicy());
    expect(b.publicView).toEqual(a.publicView);
    expect(b.quizId).toBe(a.quizId);
  });
});
