import { hashOf } from '../persistence/canonical-json.js';
import {
  PATTERN_TYPES,
  type PatternObservation,
  type PatternStatus,
  type PatternType,
  type PatternDirection,
} from '../patterns/pattern-types.js';
import type { LearnerLevel } from './trading-tutor.js';

export const PATTERN_QUIZ_VERSION = 'pattern-quiz:v1' as const;
export const PATTERN_QUIZ_POLICY_VERSION = 'pattern-quiz-policy:v1' as const;

export type PatternQuizMode = 'pattern_identification' | 'direction' | 'lifecycle';

export interface PatternQuizPolicy {
  version: typeof PATTERN_QUIZ_POLICY_VERSION;
  mode: PatternQuizMode;
  optionCount: number;
  learnerLevel: LearnerLevel;
  revealGeometryMetrics: boolean;
  revealChartContext: boolean;
  revealLifecycleTimestampsAvailableByAsOfOnly: boolean;
}

export interface PatternQuizOption {
  id: string;
  label: string;
}

export interface PatternQuizVisibleEvidence {
  patternObservationId: string;
  patternInstanceId: string;
  instrumentId: string;
  interval: string;
  asOf: string;
  firstSeenAt: string;
  anchors: Array<{ role: string; kind: 'high' | 'low'; price: string; time: string; confirmedAt: string }>;
  confirmation: { direction: 'up' | 'down' | null; level: string | null; buffer: string; confirmedByBarTime: string | null };
  invalidation: { rule: string; level: string | null };
  boundaries: Record<string, { intercept: string; slope: string }>;
  geometryMetrics: Record<string, string> | null;
  chartContext: PatternObservation['chartContext'] | null;
  lifecycleTimestamps: {
    confirmedAt: string | null;
    invalidatedAt: string | null;
    resolvedAt: string | null;
  };
  evidenceRefs: string[];
}

export interface PatternQuizPublicView {
  quizId: string;
  engineVersion: typeof PATTERN_QUIZ_VERSION;
  mode: PatternQuizMode;
  learnerLevel: LearnerLevel;
  prompt: string;
  options: PatternQuizOption[];
  visibleEvidence: PatternQuizVisibleEvidence;
}

export interface PatternQuizAnswer {
  optionId: string;
  label: PatternType | PatternDirection | PatternStatus;
  explanation: string;
  answerFingerprint: string;
}

export interface PatternQuiz {
  quizId: string;
  engineVersion: typeof PATTERN_QUIZ_VERSION;
  inputFingerprint: string;
  policy: PatternQuizPolicy;
  sourceObservationId: string;
  sourceInstanceId: string;
  sourceAsOf: string;
  visibleEvidenceFingerprint: string;
  publicView: PatternQuizPublicView;
  answer: PatternQuizAnswer;
}

export interface PatternQuizGrade {
  quizId: string;
  selectedOptionId: string;
  selectedAnswer: string | null;
  correctOptionId: string;
  correctAnswer: string;
  correct: boolean;
  explanation: string;
}

export class PatternQuizError extends Error {
  override readonly name = 'PatternQuizError';
  constructor(
    readonly code: 'INVALID_OBSERVATION' | 'INVALID_POLICY' | 'INVALID_QUIZ' | 'INVALID_SUBMISSION',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

const DIRECTIONS: readonly PatternDirection[] = ['bullish', 'bearish', 'neutral'];
const STATUSES: readonly PatternStatus[] = [
  'forming',
  'confirmed',
  'retest_pending',
  'retest_confirmed',
  'target_active',
  'completed',
  'invalidated',
  'failed_breakout',
  'expired',
  'outcome_ambiguous',
];
const LEVELS: readonly LearnerLevel[] = ['beginner', 'intermediate', 'advanced'];
const MODES: readonly PatternQuizMode[] = ['pattern_identification', 'direction', 'lifecycle'];

function fail(code: PatternQuizError['code'], message: string): never {
  throw new PatternQuizError(code, message);
}

function canonicalMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

function validatePolicy(raw: PatternQuizPolicy): PatternQuizPolicy {
  if (
    !raw ||
    raw.version !== PATTERN_QUIZ_POLICY_VERSION ||
    !MODES.includes(raw.mode) ||
    !LEVELS.includes(raw.learnerLevel) ||
    !Number.isSafeInteger(raw.optionCount) ||
    raw.optionCount < 2 ||
    raw.optionCount > 6 ||
    typeof raw.revealGeometryMetrics !== 'boolean' ||
    typeof raw.revealChartContext !== 'boolean' ||
    typeof raw.revealLifecycleTimestampsAvailableByAsOfOnly !== 'boolean'
  ) {
    fail('INVALID_POLICY', 'pattern quiz policy is invalid');
  }
  const vocabularySize =
    raw.mode === 'pattern_identification' ? PATTERN_TYPES.length :
    raw.mode === 'direction' ? DIRECTIONS.length : STATUSES.length;
  if (raw.optionCount > vocabularySize) fail('INVALID_POLICY', 'optionCount exceeds the mode vocabulary');
  return { ...raw };
}

function validateObservation(observation: PatternObservation, mode: PatternQuizMode): number {
  if (!observation || typeof observation !== 'object') fail('INVALID_OBSERVATION', 'pattern observation is required');
  if (
    typeof observation.patternObservationId !== 'string' || observation.patternObservationId.trim() === '' ||
    typeof observation.patternInstanceId !== 'string' || observation.patternInstanceId.trim() === '' ||
    typeof observation.instrumentId !== 'string' || observation.instrumentId.trim() === ''
  ) {
    fail('INVALID_OBSERVATION', 'pattern identities are required');
  }
  if (!PATTERN_TYPES.includes(observation.patternType)) fail('INVALID_OBSERVATION', 'pattern type is invalid');
  if (!DIRECTIONS.includes(observation.direction)) fail('INVALID_OBSERVATION', 'pattern direction is invalid');
  if (!STATUSES.includes(observation.status)) fail('INVALID_OBSERVATION', 'pattern status is invalid');

  const asOfMs = canonicalMs(observation.asOf);
  const firstSeenMs = canonicalMs(observation.firstSeenAt);
  if (asOfMs === null || firstSeenMs === null || firstSeenMs > asOfMs) {
    fail('INVALID_OBSERVATION', 'asOf and firstSeenAt must be canonical and point-in-time consistent');
  }
  for (const [label, value] of [
    ['confirmedAt', observation.confirmedAt],
    ['invalidatedAt', observation.invalidatedAt],
    ['resolvedAt', observation.resolvedAt],
  ] as const) {
    if (value !== null && canonicalMs(value) === null) fail('INVALID_OBSERVATION', label + ' is not canonical UTC');
  }
  for (const anchor of observation.anchors) {
    const timeMs = canonicalMs(anchor.time);
    const confirmedMs = canonicalMs(anchor.confirmedAt);
    if (timeMs === null || confirmedMs === null || confirmedMs < timeMs) {
      fail('INVALID_OBSERVATION', 'anchor timestamps are invalid');
    }
  }

  if (mode === 'lifecycle') {
    for (const value of [observation.confirmedAt, observation.invalidatedAt, observation.resolvedAt]) {
      if (value !== null && Date.parse(value) > asOfMs) {
        fail('INVALID_OBSERVATION', 'lifecycle quiz cannot use a lifecycle fact known after asOf');
      }
    }
  }
  return asOfMs;
}

function knownAtOrNull(value: string | null, asOfMs: number): string | null {
  if (value === null) return null;
  return Date.parse(value) <= asOfMs ? value : null;
}

function visibleEvidenceOf(
  observation: PatternObservation,
  policy: PatternQuizPolicy,
  asOfMs: number,
): PatternQuizVisibleEvidence {
  const confirmationKnown =
    observation.confirmedAt !== null && Date.parse(observation.confirmedAt) <= asOfMs;
  const hideDirection = policy.mode === 'direction';

  const anchors = observation.anchors
    .filter((anchor) => Date.parse(anchor.time) <= asOfMs && Date.parse(anchor.confirmedAt) <= asOfMs)
    .map((anchor) => ({
      role: anchor.role,
      kind: anchor.kind,
      price: anchor.price,
      time: anchor.time,
      confirmedAt: anchor.confirmedAt,
    }));

  return {
    patternObservationId: observation.patternObservationId,
    patternInstanceId: observation.patternInstanceId,
    instrumentId: observation.instrumentId,
    interval: observation.interval,
    asOf: observation.asOf,
    firstSeenAt: observation.firstSeenAt,
    anchors,
    confirmation: {
      direction: confirmationKnown && !hideDirection ? observation.confirmation.direction : null,
      level: confirmationKnown ? observation.confirmation.level : null,
      buffer: observation.confirmation.buffer,
      confirmedByBarTime:
        observation.confirmation.confirmedByBarTime !== null &&
        Date.parse(observation.confirmation.confirmedByBarTime) <= asOfMs
          ? observation.confirmation.confirmedByBarTime
          : null,
    },
    invalidation: { ...observation.invalidation },
    boundaries: Object.fromEntries(
      Object.entries(observation.boundaries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    geometryMetrics: policy.revealGeometryMetrics
      ? Object.fromEntries(
          Object.entries(observation.geometryMetrics).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : null,
    chartContext: policy.revealChartContext ? observation.chartContext : null,
    lifecycleTimestamps: policy.revealLifecycleTimestampsAvailableByAsOfOnly
      ? {
          confirmedAt: knownAtOrNull(observation.confirmedAt, asOfMs),
          invalidatedAt: knownAtOrNull(observation.invalidatedAt, asOfMs),
          resolvedAt: knownAtOrNull(observation.resolvedAt, asOfMs),
        }
      : { confirmedAt: null, invalidatedAt: null, resolvedAt: null },
    evidenceRefs: [
      observation.evidenceRefs.patternRunId,
      ...(observation.evidenceRefs.chartContextId === null ? [] : [observation.evidenceRefs.chartContextId]),
    ].sort(),
  };
}

function answerLabel(observation: PatternObservation, mode: PatternQuizMode): PatternType | PatternDirection | PatternStatus {
  if (mode === 'pattern_identification') return observation.patternType;
  if (mode === 'direction') return observation.direction;
  return observation.status;
}

function vocabulary(mode: PatternQuizMode): readonly string[] {
  if (mode === 'pattern_identification') return PATTERN_TYPES;
  if (mode === 'direction') return DIRECTIONS;
  return STATUSES;
}

function optionsOf(correct: string, count: number, seed: string, mode: PatternQuizMode): PatternQuizOption[] {
  const candidates = vocabulary(mode).filter((value) => value !== correct);
  const start = parseInt(seed.slice(0, 8), 16) % candidates.length;
  const distractors: string[] = [];
  for (let i = 0; distractors.length < count - 1; i++) {
    const value = candidates[(start + i) % candidates.length]!;
    if (!distractors.includes(value)) distractors.push(value);
  }
  const labels = [correct, ...distractors];
  const rotate = parseInt(seed.slice(8, 16), 16) % labels.length;
  const ordered = [...labels.slice(rotate), ...labels.slice(0, rotate)];
  return ordered.map((label, index) => ({ id: 'option_' + (index + 1), label }));
}

function promptOf(mode: PatternQuizMode, level: LearnerLevel): string {
  const prefix = level === 'beginner' ? 'Identify' : level === 'intermediate' ? 'Determine' : 'Evaluate';
  if (mode === 'pattern_identification') return prefix + ' the chart pattern from the visible evidence.';
  if (mode === 'direction') return prefix + ' the pattern direction from the visible evidence.';
  return prefix + ' the lifecycle status known at the observation asOf.';
}

function explanationOf(mode: PatternQuizMode, answer: string, observation: PatternObservation): string {
  if (mode === 'pattern_identification') {
    return 'The point-in-time geometry in observation ' + observation.patternObservationId + ' is classified as ' + answer + '.';
  }
  if (mode === 'direction') {
    return 'The observation records the point-in-time pattern direction as ' + answer + '.';
  }
  return 'At ' + observation.asOf + ', the observation lifecycle status is ' + answer + '.';
}

function validateQuizStructure(quiz: PatternQuiz): void {
  if (!quiz || quiz.engineVersion !== PATTERN_QUIZ_VERSION) fail('INVALID_QUIZ', 'quiz version is invalid');
  if (quiz.publicView.quizId !== quiz.quizId) fail('INVALID_QUIZ', 'public view quiz id mismatch');
  if (quiz.publicView.engineVersion !== PATTERN_QUIZ_VERSION) fail('INVALID_QUIZ', 'public view version mismatch');
  const ids = quiz.publicView.options.map((o) => o.id);
  const labels = quiz.publicView.options.map((o) => o.label);
  if (new Set(ids).size !== ids.length || new Set(labels).size !== labels.length) fail('INVALID_QUIZ', 'quiz options must be unique');
  if (quiz.publicView.options.filter((o) => o.id === quiz.answer.optionId && o.label === quiz.answer.label).length !== 1) {
    fail('INVALID_QUIZ', 'correct answer must appear exactly once in options');
  }
}

export function buildPatternQuiz(
  observation: PatternObservation,
  rawPolicy: PatternQuizPolicy,
): PatternQuiz {
  const policy = validatePolicy(rawPolicy);
  const asOfMs = validateObservation(observation, policy.mode);
  const visibleEvidence = visibleEvidenceOf(observation, policy, asOfMs);
  const visibleEvidenceFingerprint = hashOf(visibleEvidence);
  const label = answerLabel(observation, policy.mode);
  const answerFingerprint = hashOf({
    patternObservationId: observation.patternObservationId,
    patternInstanceId: observation.patternInstanceId,
    asOf: observation.asOf,
    mode: policy.mode,
    label,
  });
  const inputFingerprint = hashOf({
    engineVersion: PATTERN_QUIZ_VERSION,
    sourceObservationId: observation.patternObservationId,
    sourceInstanceId: observation.patternInstanceId,
    sourceAsOf: observation.asOf,
    mode: policy.mode,
    policy,
    visibleEvidenceFingerprint,
    answerFingerprint,
  });
  const quizId = 'pq_' + inputFingerprint.slice(0, 40);
  const options = optionsOf(label, policy.optionCount, inputFingerprint, policy.mode);
  const correct = options.find((option) => option.label === label);
  if (!correct) fail('INVALID_QUIZ', 'correct answer is missing from generated options');

  const quiz: PatternQuiz = {
    quizId,
    engineVersion: PATTERN_QUIZ_VERSION,
    inputFingerprint,
    policy,
    sourceObservationId: observation.patternObservationId,
    sourceInstanceId: observation.patternInstanceId,
    sourceAsOf: observation.asOf,
    visibleEvidenceFingerprint,
    publicView: {
      quizId,
      engineVersion: PATTERN_QUIZ_VERSION,
      mode: policy.mode,
      learnerLevel: policy.learnerLevel,
      prompt: promptOf(policy.mode, policy.learnerLevel),
      options,
      visibleEvidence,
    },
    answer: {
      optionId: correct.id,
      label,
      explanation: explanationOf(policy.mode, label, observation),
      answerFingerprint,
    },
  };
  validateQuizStructure(quiz);
  return quiz;
}

export function gradePatternQuiz(
  quiz: PatternQuiz,
  submittedOptionId: string,
): PatternQuizGrade {
  validateQuizStructure(quiz);
  if (typeof submittedOptionId !== 'string' || submittedOptionId.trim() === '') {
    fail('INVALID_SUBMISSION', 'submitted option id is required');
  }
  const selected = quiz.publicView.options.find((option) => option.id === submittedOptionId);
  if (!selected) fail('INVALID_SUBMISSION', 'submitted option does not belong to this quiz');
  return {
    quizId: quiz.quizId,
    selectedOptionId: submittedOptionId,
    selectedAnswer: selected.label,
    correctOptionId: quiz.answer.optionId,
    correctAnswer: quiz.answer.label,
    correct: submittedOptionId === quiz.answer.optionId,
    explanation: quiz.answer.explanation,
  };
}

export function verifyPatternQuiz(
  observation: PatternObservation,
  quiz: PatternQuiz,
): void {
  validateQuizStructure(quiz);
  let expected: PatternQuiz;
  try {
    expected = buildPatternQuiz(observation, quiz.policy);
  } catch (error) {
    if (error instanceof PatternQuizError && error.code === 'INVALID_POLICY') {
      fail('INVALID_QUIZ', 'stored quiz policy is invalid');
    }
    throw error;
  }
  if (hashOf(expected) !== hashOf(quiz)) {
    fail('INVALID_QUIZ', 'quiz does not match its source observation');
  }
}
