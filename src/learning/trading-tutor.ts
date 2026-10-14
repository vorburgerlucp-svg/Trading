import {
  POST_TRADE_REVIEW_VERSION,
  classifyPostTradeOutcome,
  classifyPostTradeProcess,
  type PostTradeFeedbackCode,
  type PostTradeReview,
} from '../evaluation/post-trade-review.js';
import { hashOf } from '../persistence/canonical-json.js';

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

const LEVELS: readonly LearnerLevel[] = ['beginner', 'intermediate', 'advanced'];
const CATEGORY_ORDER: readonly TutorLessonCategory[] = [
  'PROCESS_DISCIPLINE',
  'EVIDENCE_QUALITY',
  'RISK_DISCIPLINE',
  'MODEL_CONFIDENCE',
  'QUANT_SUPPORT',
  'EXECUTION_VS_THESIS',
  'STOP_TARGET_REVIEW',
  'KEEP_PROCESS',
];

const FEEDBACK_CATEGORY: Readonly<Record<PostTradeFeedbackCode, TutorLessonCategory>> = Object.freeze({
  KEEP_PROCESS: 'KEEP_PROCESS',
  REVIEW_EVIDENCE_QUALITY: 'EVIDENCE_QUALITY',
  REVIEW_MODEL_CONFIDENCE: 'MODEL_CONFIDENCE',
  REVIEW_STOP_PLACEMENT: 'STOP_TARGET_REVIEW',
  REVIEW_TARGET_PLACEMENT: 'STOP_TARGET_REVIEW',
  REVIEW_RISK_DISCIPLINE: 'RISK_DISCIPLINE',
  REVIEW_PROVIDER_DIVERSITY: 'PROCESS_DISCIPLINE',
  REVIEW_QUANT_SUPPORT: 'QUANT_SUPPORT',
  REVIEW_EXECUTION_VS_THESIS: 'EXECUTION_VS_THESIS',
});

function fail(code: TradingTutorError['code'], message: string): never {
  throw new TradingTutorError(code, message);
}

/** The exact policy keys. An unknown key would otherwise be hashed into the lesson identity without being validated. */
const POLICY_KEYS = [
  'includeCalibrationDiagnostics',
  'includeExecutionDiagnostics',
  'learnerLevel',
  'maxLearningObjectives',
  'maxReflectionQuestions',
  'version',
];
const FEEDBACK_SEVERITIES: readonly string[] = ['info', 'minor', 'major'];
const FEEDBACK_BASES: readonly string[] = ['process', 'outcome', 'both'];
const CALIBRATION_TARGET = 'recommendation_direction_correct:v1' as const;

function validatePolicy(raw: TradingTutorPolicy): TradingTutorPolicy {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Object.keys(raw).sort().join('|') !== POLICY_KEYS.join('|') ||
    raw.version !== TRADING_TUTOR_POLICY_VERSION ||
    !LEVELS.includes(raw.learnerLevel) ||
    !Number.isSafeInteger(raw.maxLearningObjectives) ||
    raw.maxLearningObjectives < 1 ||
    raw.maxLearningObjectives > 3 ||
    !Number.isSafeInteger(raw.maxReflectionQuestions) ||
    raw.maxReflectionQuestions < 1 ||
    raw.maxReflectionQuestions > 3 ||
    typeof raw.includeCalibrationDiagnostics !== 'boolean' ||
    typeof raw.includeExecutionDiagnostics !== 'boolean'
  ) {
    fail('INVALID_POLICY', 'trading tutor policy is invalid');
  }
  return { ...raw };
}

function validateReview(review: PostTradeReview): void {
  if (!review || typeof review !== 'object' || review.engineVersion !== POST_TRADE_REVIEW_VERSION) {
    fail('INVALID_REVIEW', 'only post-trade-review:v1 is supported');
  }
  if (
    typeof review.reviewId !== 'string' ||
    !/^ptr_[0-9a-f]{40}$/.test(review.reviewId) ||
    typeof review.inputFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(review.inputFingerprint)
  ) {
    fail('INVALID_REVIEW', 'review identity is malformed');
  }
  const process = review.processClassification;
  if (
    process !== 'PROCESS_STRONG' &&
    process !== 'PROCESS_ACCEPTABLE' &&
    process !== 'PROCESS_WEAK' &&
    process !== 'PROCESS_BLOCKED'
  ) {
    fail('INVALID_REVIEW', 'process classification is invalid');
  }
  if (
    review.outcomeClassification !== 'OUTCOME_FAVORABLE' &&
    review.outcomeClassification !== 'OUTCOME_FLAT' &&
    review.outcomeClassification !== 'OUTCOME_ADVERSE'
  ) {
    fail('INVALID_REVIEW', 'outcome classification is invalid');
  }
  if (
    !review.policy ||
    review.policy.version !== 'post-trade-review-policy:v1' ||
    !Number.isSafeInteger(review.policy.minimumEvidenceCountForStrong) ||
    review.policy.minimumEvidenceCountForStrong < 1
  ) {
    fail('INVALID_REVIEW', 'embedded O13 process policy is invalid');
  }
  const d = review.processDiagnostics;
  const o = review.outcomeDiagnostics;
  if (!d || !o || !Array.isArray(review.calibrationDiagnostics) || !Array.isArray(review.feedback)) {
    fail('INVALID_REVIEW', 'O13 review is missing diagnostics, calibration or feedback');
  }
  const counts = [
    d.evidenceCount, d.excludedLookAheadCount, d.evidenceWarningCount, d.blockingEvidenceImpactCount,
    d.successfulNonShadowAnalysts, d.distinctAnalystProviders, d.requiredIndependentOpinions,
    d.independentOpinionShortfall, d.planStepShortfallCount, d.blockingFindingCount, d.majorFindingCount,
  ];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    fail('INVALID_REVIEW', 'process diagnostics must be non-negative integers');
  }
  const flags = [
    d.riskPassed, d.criticRequired, d.criticObserved, d.counterAnalysisRequired, d.counterAnalysisObserved,
    d.humanApprovalRequired, d.paperIntentAllowed, d.capitalStateRefPresent,
  ];
  if (flags.some((flag) => typeof flag !== 'boolean')) fail('INVALID_REVIEW', 'process diagnostics must be booleans where O13 defines booleans');
  if (d.liveOrderAllowed !== false || d.physicalPurchaseAllowed !== false) fail('INVALID_REVIEW', 'execution locks must remain false');
  if (!['confirmed', 'contradicts', 'not_available'].includes(d.quantStatus)) fail('INVALID_REVIEW', 'quant status is invalid');
  if (!['pending', 'not_required'].includes(d.humanApprovalStatus)) fail('INVALID_REVIEW', 'human approval status is invalid');
  // Reuse O13's single outcome classifier rather than duplicating its flat-band semantics.
  if (!Number.isSafeInteger(o.returnBp)) fail('INVALID_REVIEW', 'outcome return must be an integer basis-point value');
  if (review.outcomeClassification !== classifyPostTradeOutcome(o.returnBp)) {
    fail('INVALID_REVIEW', 'outcome classification does not match the embedded return');
  }
  // O13 always emits at least one feedback item (KEEP_PROCESS when nothing fired). An empty list is not a valid review.
  if (review.feedback.length === 0) fail('INVALID_REVIEW', 'O13 review carries no feedback');
  for (const item of review.feedback) {
    if (!Object.prototype.hasOwnProperty.call(FEEDBACK_CATEGORY, item.code)) {
      fail('INVALID_REVIEW', 'unknown O13 feedback code ' + String(item.code));
    }
    if (!FEEDBACK_SEVERITIES.includes(item.severity) || !FEEDBACK_BASES.includes(item.basis)) {
      fail('INVALID_REVIEW', 'malformed O13 feedback severity or basis');
    }
    if (!Array.isArray(item.references) || item.references.some((ref) => typeof ref !== 'string') || typeof item.explanation !== 'string') {
      fail('INVALID_REVIEW', 'malformed O13 feedback item');
    }
  }

  if (process !== classifyPostTradeProcess(d, review.policy)) {
    fail('INVALID_REVIEW', 'process classification does not match the embedded O13 diagnostics');
  }
  // "Keep this process" is a statement about a process that passed review; it cannot accompany a weak or blocked one.
  if ((process === 'PROCESS_WEAK' || process === 'PROCESS_BLOCKED') && review.feedback.some((item) => item.code === 'KEEP_PROCESS')) {
    fail('INVALID_REVIEW', 'KEEP_PROCESS cannot accompany a weak or blocked process');
  }
  for (const diagnostic of review.calibrationDiagnostics) {
    if (
      !Number.isFinite(diagnostic.calibratedProbability) ||
      diagnostic.calibratedProbability < 0 ||
      diagnostic.calibratedProbability > 1 ||
      !Number.isFinite(diagnostic.brierContribution) ||
      diagnostic.brierContribution < 0 ||
      diagnostic.brierContribution > 1 ||
      (diagnostic.outcomeLabel !== 0 && diagnostic.outcomeLabel !== 1)
    ) {
      fail('INVALID_REVIEW', 'calibration diagnostic is invalid');
    }
    if (diagnostic.targetId !== CALIBRATION_TARGET) fail('INVALID_REVIEW', 'calibration target is not supported');
    // The Brier contribution is re-derived from the probability and the binary label, not trusted from the artifact.
    if (diagnostic.brierContribution !== (diagnostic.calibratedProbability - diagnostic.outcomeLabel) ** 2) {
      fail('INVALID_REVIEW', 'Brier contribution does not match its probability and label');
    }
  }
}

function categoriesOf(review: PostTradeReview): TutorLessonCategory[] {
  const found = new Set<TutorLessonCategory>();
  if (review.processClassification === 'PROCESS_WEAK' || review.processClassification === 'PROCESS_BLOCKED') {
    found.add('PROCESS_DISCIPLINE');
  }
  for (const item of review.feedback) {
    const mapped = FEEDBACK_CATEGORY[item.code];
    if (mapped) found.add(mapped);
  }
  return CATEGORY_ORDER.filter((category) => found.has(category));
}

function objective(category: TutorLessonCategory, level: LearnerLevel): string {
  const prefix =
    level === 'beginner' ? 'Recognize' :
    level === 'intermediate' ? 'Explain' :
    'Evaluate';
  const body: Record<TutorLessonCategory, string> = {
    PROCESS_DISCIPLINE: 'why process quality is judged separately from trade outcome',
    EVIDENCE_QUALITY: 'how evidence quality and point-in-time discipline affect a decision',
    RISK_DISCIPLINE: 'why a blocked risk process cannot be rescued by a profitable outcome',
    MODEL_CONFIDENCE: 'how calibrated forecast confidence should be reviewed after outcomes',
    QUANT_SUPPORT: 'the role of quantitative support in the original decision process',
    EXECUTION_VS_THESIS: 'the difference between thesis quality and actual execution',
    STOP_TARGET_REVIEW: 'how stop and target behavior can be reviewed without hindsight bias',
    KEEP_PROCESS: 'which parts of a strong process should be retained despite outcome noise',
  };
  return prefix + ' ' + body[category] + '.';
}

function reflection(category: TutorLessonCategory, level: LearnerLevel): string {
  const suffix = level === 'advanced' ? ' Which evidence would falsify your conclusion?' : '';
  const base: Record<TutorLessonCategory, string> = {
    PROCESS_DISCIPLINE: 'Which pre-trade process requirement mattered most in this review?',
    EVIDENCE_QUALITY: 'Which evidence was usable at decision time, and what was excluded?',
    RISK_DISCIPLINE: 'Would the same risk decision still be correct if the trade outcome were reversed?',
    MODEL_CONFIDENCE: 'Was the calibrated confidence consistent with the realized directional outcome?',
    QUANT_SUPPORT: 'What quantitative support was present or missing before the outcome was known?',
    EXECUTION_VS_THESIS: 'What belongs to thesis quality, and what belongs to execution quality?',
    STOP_TARGET_REVIEW: 'What can be learned from the stop or target behavior without changing the original process grade?',
    KEEP_PROCESS: 'Which process elements should be repeated on the next comparable decision?',
  };
  return base[category] + suffix;
}

function processOutcomeExplanation(review: PostTradeReview): string {
  const processWord =
    review.processClassification === 'PROCESS_STRONG' ? 'strong' :
    review.processClassification === 'PROCESS_ACCEPTABLE' ? 'acceptable' :
    review.processClassification === 'PROCESS_WEAK' ? 'weak' : 'blocked';
  const outcomeWord =
    review.outcomeClassification === 'OUTCOME_FAVORABLE' ? 'favorable' :
    review.outcomeClassification === 'OUTCOME_ADVERSE' ? 'adverse' : 'flat';

  if (review.processClassification === 'PROCESS_BLOCKED') {
    return 'The pre-trade process was blocked. The ' + outcomeWord + ' outcome does not upgrade a blocked process.';
  }
  if (review.processClassification === 'PROCESS_WEAK') {
    return 'The pre-trade process was weak while the realized outcome was ' + outcomeWord + '. Outcome and process must be judged separately.';
  }
  if (review.processClassification === 'PROCESS_STRONG') {
    return 'The pre-trade process was strong while the realized outcome was ' + outcomeWord + '. A single outcome does not redefine process quality.';
  }
  return 'The pre-trade process was ' + processWord + ' and the realized outcome was ' + outcomeWord + '. Review each dimension separately.';
}

function factsOf(review: PostTradeReview, policy: TradingTutorPolicy): string[] {
  const facts = [
    'Process classification: ' + review.processClassification,
    'Outcome classification: ' + review.outcomeClassification,
    'Evidence used: ' + review.processDiagnostics.evidenceCount,
    'Look-ahead evidence excluded: ' + review.processDiagnostics.excludedLookAheadCount,
    'Risk gate passed: ' + String(review.processDiagnostics.riskPassed),
  ];
  if (policy.includeExecutionDiagnostics) {
    facts.push('Executed trade: ' + String(review.executed));
    facts.push('Paper intent allowed at decision time: ' + String(review.processDiagnostics.paperIntentAllowed));
  }
  if (policy.includeCalibrationDiagnostics) {
    facts.push('Calibration diagnostics: ' + review.calibrationDiagnostics.length);
  }
  return facts;
}

export function buildTradingTutorLesson(
  review: PostTradeReview,
  rawPolicy: TradingTutorPolicy,
): TradingTutorLesson {
  validateReview(review);
  const policy = validatePolicy(rawPolicy);
  const categories = categoriesOf(review);
  if (categories.length === 0) fail('INVALID_REVIEW', 'O13 review yields no lesson category');
  const sourceFingerprint = hashOf(review);
  const inputFingerprint = hashOf({
    engineVersion: TRADING_TUTOR_VERSION,
    reviewId: review.reviewId,
    sourceFingerprint,
    policy,
  });
  const lessonId = 'ttl_' + inputFingerprint.slice(0, 40);
  const title = 'Post-trade lesson: ' + review.processClassification + ' / ' + review.outcomeClassification;
  const learningObjectives = categories
    .map((category) => objective(category, policy.learnerLevel))
    .slice(0, policy.maxLearningObjectives);
  const reflectionQuestions = categories
    .map((category) => reflection(category, policy.learnerLevel))
    .slice(0, policy.maxReflectionQuestions);
  const references = [
    'review:' + review.reviewId,
    ...review.feedback.map((item) => 'feedback:' + item.code),
  ].sort();

  return {
    lessonId,
    engineVersion: TRADING_TUTOR_VERSION,
    reviewId: review.reviewId,
    policy,
    title,
    categories,
    learningObjectives,
    keyFacts: factsOf(review, policy),
    processOutcomeExplanation: processOutcomeExplanation(review),
    reflectionQuestions,
    references,
    sourceFingerprint,
  };
}

/**
 * Recomputes the lesson from its review. A lesson carries its own policy, so a consumer that expects a specific policy passes
 * it in: a lesson re-issued under another policy is then refused, instead of verifying against its own stored policy.
 */
export function verifyTradingTutorLesson(
  review: PostTradeReview,
  lesson: TradingTutorLesson,
  expectedPolicy?: TradingTutorPolicy,
): void {
  if (!lesson || typeof lesson !== 'object') fail('INVALID_LESSON', 'lesson is missing');
  if (expectedPolicy !== undefined && hashOf(lesson.policy) !== hashOf(validatePolicy(expectedPolicy))) {
    fail('INVALID_LESSON', 'lesson was built under a different tutor policy than the expected one');
  }
  let expected: TradingTutorLesson;
  try {
    expected = buildTradingTutorLesson(review, lesson.policy);
  } catch (error) {
    if (error instanceof TradingTutorError && error.code === 'INVALID_POLICY') {
      fail('INVALID_LESSON', 'lesson policy is invalid');
    }
    throw error;
  }
  if (hashOf(expected) !== hashOf(lesson)) {
    fail('INVALID_LESSON', 'lesson does not match its source review');
  }
}
