import type { PatternObservation, PatternStatus, PatternType, PatternDirection } from '../patterns/pattern-types.js';
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

export function buildPatternQuiz(
  _observation: PatternObservation,
  _policy: PatternQuizPolicy,
): PatternQuiz {
  throw new Error('O14 pattern quiz not implemented');
}

export function gradePatternQuiz(
  _quiz: PatternQuiz,
  _submittedOptionId: string,
): PatternQuizGrade {
  throw new Error('O14 pattern quiz grading not implemented');
}

export function verifyPatternQuiz(
  _observation: PatternObservation,
  _quiz: PatternQuiz,
): void {
  throw new Error('O14 pattern quiz verifier not implemented');
}
