import type { PostTradeReview } from '../evaluation/post-trade-review.js';

export const TRADING_TUTOR_VERSION = 'trading-tutor:v1' as const;
export const TRADING_TUTOR_POLICY_VERSION = 'trading-tutor-policy:v1' as const;

export type LearnerLevel = 'beginner' | 'intermediate' | 'advanced';

export interface TradingTutorPolicy {
  version: typeof TRADING_TUTOR_POLICY_VERSION;
  learnerLevel: LearnerLevel;
  maxLearningObjectives: number;
  maxReflectionQuestions: number;
  includeCalibrationDiagnostics: boolean;
  includeExecutionDiagnostics: boolean;
}

export type TutorLessonCategory =
  | 'PROCESS_DISCIPLINE'
  | 'EVIDENCE_QUALITY'
  | 'RISK_DISCIPLINE'
  | 'MODEL_CONFIDENCE'
  | 'QUANT_SUPPORT'
  | 'EXECUTION_VS_THESIS'
  | 'STOP_TARGET_REVIEW'
  | 'KEEP_PROCESS';

export interface TradingTutorLesson {
  lessonId: string;
  engineVersion: typeof TRADING_TUTOR_VERSION;
  reviewId: string;
  policy: TradingTutorPolicy;
  title: string;
  categories: TutorLessonCategory[];
  learningObjectives: string[];
  keyFacts: string[];
  processOutcomeExplanation: string;
  reflectionQuestions: string[];
  references: string[];
  sourceFingerprint: string;
}

export class TradingTutorError extends Error {
  override readonly name = 'TradingTutorError';
  constructor(
    readonly code: 'INVALID_REVIEW' | 'INVALID_POLICY' | 'INVALID_LESSON',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

export function buildTradingTutorLesson(
  _review: PostTradeReview,
  _policy: TradingTutorPolicy,
): TradingTutorLesson {
  throw new Error('O14 trading tutor not implemented');
}

export function verifyTradingTutorLesson(
  _review: PostTradeReview,
  _lesson: TradingTutorLesson,
): void {
  throw new Error('O14 trading tutor verifier not implemented');
}
