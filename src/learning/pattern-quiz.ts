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

/** Exact decimal text as the Pattern Engine writes it (Decimal.toString, which may use an exponent for very small values). */
const DECIMAL_TEXT = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

function isDecimalText(value: unknown): boolean {
  return typeof value === 'string' && DECIMAL_TEXT.test(value);
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Lifecycle status against the timestamps it implies, as Pattern Engine lifecycle.ts and price-action.ts set them:
 * c = confirmedAt is set, i = invalidatedAt is set, r = resolvedAt is set.
 * Only applied to lifecycle quizzes, where the status is the answer.
 */
const LIFECYCLE_SHAPE: Partial<Record<PatternStatus, (c: boolean, i: boolean, r: boolean) => boolean>> = {
  forming: (c, i, r) => !c && !i && !r,
  retest_pending: (c, i, r) => !c && !i && !r,
  confirmed: (c, i, r) => c && !i && !r,
  target_active: (c, i, r) => c && !i && !r,
  retest_confirmed: (c, i, r) => c && !i && !r,
  completed: (c, i, r) => c && !i && r,
  outcome_ambiguous: (c, i, r) => c && !i && r,
  failed_breakout: (_c, i, r) => !i && r,
  invalidated: (c, i, r) => !c && i && !r,
  expired: (c, i, r) => !i && (!r || c),
};

/** The exact policy keys. An unknown key would otherwise be part of the quiz identity without being validated. */
const QUIZ_POLICY_KEYS = [
  'learnerLevel',
  'mode',
  'optionCount',
  'revealChartContext',
  'revealGeometryMetrics',
  'revealLifecycleTimestampsAvailableByAsOfOnly',
  'version',
];

function validatePolicy(raw: PatternQuizPolicy): PatternQuizPolicy {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Object.keys(raw).sort().join('|') !== QUIZ_POLICY_KEYS.join('|') ||
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
    if (!isDecimalText(anchor.price)) fail('INVALID_OBSERVATION', 'anchor price must be exact decimal text');
  }
  const roles = observation.anchors.map((anchor) => anchor.role);
  if (new Set(roles).size !== roles.length) fail('INVALID_OBSERVATION', 'anchor roles must be unique');

  // Values the quiz publishes must be the exact decimal text the engine writes, not arbitrary strings or objects.
  if (!isObject(observation.boundaries) || Object.values(observation.boundaries).some((line) => !isObject(line) || !isDecimalText(line.intercept) || !isDecimalText(line.slope))) {
    fail('INVALID_OBSERVATION', 'boundary lines must carry exact decimal intercept and slope');
  }
  if (!isObject(observation.geometryMetrics) || Object.values(observation.geometryMetrics).some((value) => !isDecimalText(value))) {
    fail('INVALID_OBSERVATION', 'geometry metrics must be exact decimal text');
  }
  if (observation.confirmation.level !== null && !isDecimalText(observation.confirmation.level)) {
    fail('INVALID_OBSERVATION', 'confirmation level must be exact decimal text or null');
  }
  if (!isDecimalText(observation.confirmation.buffer)) fail('INVALID_OBSERVATION', 'confirmation buffer must be exact decimal text');
  if (observation.invalidation.level !== null && !isDecimalText(observation.invalidation.level)) {
    fail('INVALID_OBSERVATION', 'invalidation level must be exact decimal text or null');
  }

  // Ordering and exclusivity that hold for every mode: nothing happens before the pattern is first seen, and the
  // terminal states do not overlap.
  const confirmedMs = observation.confirmedAt === null ? null : canonicalMs(observation.confirmedAt);
  const invalidatedMs = observation.invalidatedAt === null ? null : canonicalMs(observation.invalidatedAt);
  const resolvedMs = observation.resolvedAt === null ? null : canonicalMs(observation.resolvedAt);
  if (confirmedMs !== null && confirmedMs < firstSeenMs) fail('INVALID_OBSERVATION', 'confirmation cannot precede the first sighting');
  if (invalidatedMs !== null && invalidatedMs < firstSeenMs) fail('INVALID_OBSERVATION', 'invalidation cannot precede the first sighting');
  if (observation.invalidatedAt !== null && observation.resolvedAt !== null) {
    fail('INVALID_OBSERVATION', 'invalidation and resolution are mutually exclusive terminal times');
  }
  if (confirmedMs !== null && resolvedMs !== null && resolvedMs < confirmedMs) fail('INVALID_OBSERVATION', 'resolution cannot precede confirmation');

  if (mode === 'lifecycle') {
    for (const value of [observation.confirmedAt, observation.invalidatedAt, observation.resolvedAt]) {
      if (value !== null && Date.parse(value) > asOfMs) {
        fail('INVALID_OBSERVATION', 'lifecycle quiz cannot use a lifecycle fact known after asOf');
      }
    }
    // The status is the answer, so it must be the one the lifecycle timestamps at asOf imply.
    const shape = LIFECYCLE_SHAPE[observation.status];
    if (!shape || !shape(confirmedMs !== null, invalidatedMs !== null, resolvedMs !== null)) {
      fail('INVALID_OBSERVATION', 'status ' + observation.status + ' contradicts the lifecycle timestamps at asOf');
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
  // The breakout direction discriminates pattern families (resistance vs support breakout), so it is shown only where it
  // is itself the question: the lifecycle mode. Pattern identification and direction hide it.
  const showDirection = policy.mode === 'lifecycle';

  // Role, boundary and metric names encode the answer (a "neckline" or "head" names a pattern), so the view uses positional
  // labels. The numbers that carry the geometry (prices, times, slopes, metric values) stay.
  const anchors = observation.anchors
    .filter((anchor) => Date.parse(anchor.time) <= asOfMs && Date.parse(anchor.confirmedAt) <= asOfMs)
    .map((anchor, index) => ({
      role: 'point_' + (index + 1),
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
      direction: confirmationKnown && showDirection ? observation.confirmation.direction : null,
      level: confirmationKnown ? observation.confirmation.level : null,
      buffer: observation.confirmation.buffer,
      confirmedByBarTime:
        observation.confirmation.confirmedByBarTime !== null &&
        Date.parse(observation.confirmation.confirmedByBarTime) <= asOfMs
          ? observation.confirmation.confirmedByBarTime
          : null,
    },
    // The invalidation rule is a named answer clue ("close_above_head"); the invalidation level is the geometry and stays.
    invalidation: { rule: 'withheld', level: observation.invalidation.level },
    boundaries: Object.fromEntries(
      Object.entries(observation.boundaries)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, line], index) => ['line_' + (index + 1), { intercept: line.intercept, slope: line.slope }]),
    ),
    geometryMetrics: policy.revealGeometryMetrics
      ? Object.fromEntries(
          Object.entries(observation.geometryMetrics)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([, value], index) => ['metric_' + (index + 1), value]),
        )
      : null,
    chartContext: policy.revealChartContext && observation.chartContext !== null ? cloneJson(observation.chartContext) : null,
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

function explanationOf(mode: PatternQuizMode, answer: string, observationId: string, asOf: string): string {
  if (mode === 'pattern_identification') {
    return 'The point-in-time geometry in observation ' + observationId + ' is classified as ' + answer + '.';
  }
  if (mode === 'direction') {
    return 'The observation records the point-in-time pattern direction as ' + answer + '.';
  }
  return 'At ' + asOf + ', the observation lifecycle status is ' + answer + '.';
}

interface DerivedQuiz {
  answerFingerprint: string;
  inputFingerprint: string;
  quizId: string;
  options: PatternQuizOption[];
  prompt: string;
  explanation: string;
}

/**
 * Every deterministic field of a quiz, from its source identity, policy, visible-evidence fingerprint and correct label.
 * The builder and the verifier both use it, so a quiz whose fields were rewritten without re-deriving them does not match.
 */
function derivedOf(input: {
  sourceObservationId: string;
  sourceInstanceId: string;
  sourceAsOf: string;
  policy: PatternQuizPolicy;
  visibleEvidenceFingerprint: string;
  label: string;
}): DerivedQuiz {
  const { policy, label } = input;
  const answerFingerprint = hashOf({
    patternObservationId: input.sourceObservationId,
    patternInstanceId: input.sourceInstanceId,
    asOf: input.sourceAsOf,
    mode: policy.mode,
    label,
  });
  const inputFingerprint = hashOf({
    engineVersion: PATTERN_QUIZ_VERSION,
    sourceObservationId: input.sourceObservationId,
    sourceInstanceId: input.sourceInstanceId,
    sourceAsOf: input.sourceAsOf,
    mode: policy.mode,
    policy,
    visibleEvidenceFingerprint: input.visibleEvidenceFingerprint,
    answerFingerprint,
  });
  return {
    answerFingerprint,
    inputFingerprint,
    quizId: 'pq_' + inputFingerprint.slice(0, 40),
    options: optionsOf(label, policy.optionCount, inputFingerprint, policy.mode),
    prompt: promptOf(policy.mode, policy.learnerLevel),
    explanation: explanationOf(policy.mode, label, input.sourceObservationId, input.sourceAsOf),
  };
}

function validateQuizStructure(quiz: PatternQuiz): void {
  if (!quiz || typeof quiz !== 'object' || !quiz.publicView || !quiz.answer || !quiz.policy) fail('INVALID_QUIZ', 'quiz is incomplete');
  if (quiz.engineVersion !== PATTERN_QUIZ_VERSION) fail('INVALID_QUIZ', 'quiz version is invalid');
  if (quiz.publicView.quizId !== quiz.quizId) fail('INVALID_QUIZ', 'public view quiz id mismatch');
  if (quiz.publicView.engineVersion !== PATTERN_QUIZ_VERSION) fail('INVALID_QUIZ', 'public view version mismatch');
  const ids = quiz.publicView.options.map((o) => o.id);
  const labels = quiz.publicView.options.map((o) => o.label);
  if (new Set(ids).size !== ids.length || new Set(labels).size !== labels.length) fail('INVALID_QUIZ', 'quiz options must be unique');
  if (quiz.publicView.options.filter((o) => o.id === quiz.answer.optionId && o.label === quiz.answer.label).length !== 1) {
    fail('INVALID_QUIZ', 'correct answer must appear exactly once in options');
  }

  // Self-consistency: every deterministic field must re-derive from the quiz's own identity fields. This needs no source
  // observation, so a rewrite of the answer, the options, the prompt or the evidence without re-deriving the fingerprints fails
  // here. Reissuing every fingerprint is caught by verifyPatternQuiz, which recomputes from the source.
  let policy: PatternQuizPolicy;
  try {
    policy = validatePolicy(quiz.policy);
  } catch {
    fail('INVALID_QUIZ', 'stored quiz policy is invalid');
  }
  if (quiz.publicView.mode !== policy.mode || quiz.publicView.learnerLevel !== policy.learnerLevel) {
    fail('INVALID_QUIZ', 'public view mode or level does not match the policy');
  }
  if (hashOf(quiz.publicView.visibleEvidence) !== quiz.visibleEvidenceFingerprint) {
    fail('INVALID_QUIZ', 'visible evidence does not match its fingerprint');
  }
  if (!vocabulary(policy.mode).includes(quiz.answer.label)) fail('INVALID_QUIZ', 'correct answer is outside the mode vocabulary');
  const derived = derivedOf({
    sourceObservationId: quiz.sourceObservationId,
    sourceInstanceId: quiz.sourceInstanceId,
    sourceAsOf: quiz.sourceAsOf,
    policy,
    visibleEvidenceFingerprint: quiz.visibleEvidenceFingerprint,
    label: quiz.answer.label,
  });
  if (derived.quizId !== quiz.quizId || derived.inputFingerprint !== quiz.inputFingerprint) {
    fail('INVALID_QUIZ', 'quiz identity does not re-derive from its fields');
  }
  if (derived.answerFingerprint !== quiz.answer.answerFingerprint) fail('INVALID_QUIZ', 'answer fingerprint does not re-derive from the answer');
  if (hashOf(derived.options) !== hashOf(quiz.publicView.options)) fail('INVALID_QUIZ', 'options are not the deterministic option set');
  if (derived.prompt !== quiz.publicView.prompt) fail('INVALID_QUIZ', 'prompt does not match its mode and level');
  if (derived.explanation !== quiz.answer.explanation) fail('INVALID_QUIZ', 'explanation does not match the answer');
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
  const derived = derivedOf({
    sourceObservationId: observation.patternObservationId,
    sourceInstanceId: observation.patternInstanceId,
    sourceAsOf: observation.asOf,
    policy,
    visibleEvidenceFingerprint,
    label,
  });
  const correct = derived.options.find((option) => option.label === label);
  if (!correct) fail('INVALID_QUIZ', 'correct answer is missing from generated options');

  const quiz: PatternQuiz = {
    quizId: derived.quizId,
    engineVersion: PATTERN_QUIZ_VERSION,
    inputFingerprint: derived.inputFingerprint,
    policy,
    sourceObservationId: observation.patternObservationId,
    sourceInstanceId: observation.patternInstanceId,
    sourceAsOf: observation.asOf,
    visibleEvidenceFingerprint,
    publicView: {
      quizId: derived.quizId,
      engineVersion: PATTERN_QUIZ_VERSION,
      mode: policy.mode,
      learnerLevel: policy.learnerLevel,
      prompt: derived.prompt,
      options: derived.options,
      visibleEvidence,
    },
    answer: {
      optionId: correct.id,
      label,
      explanation: derived.explanation,
      answerFingerprint: derived.answerFingerprint,
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

/**
 * Recomputes the quiz from its source observation. A quiz carries its own policy, so a consumer that expects a specific policy
 * passes it in: a quiz re-issued under another policy is then refused instead of verifying against its stored policy.
 */
export function verifyPatternQuiz(
  observation: PatternObservation,
  quiz: PatternQuiz,
  expectedPolicy?: PatternQuizPolicy,
): void {
  validateQuizStructure(quiz);
  if (expectedPolicy !== undefined && hashOf(quiz.policy) !== hashOf(validatePolicy(expectedPolicy))) {
    fail('INVALID_QUIZ', 'quiz was built under a different policy than the expected one');
  }
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
