import type { PerformanceObservation } from '../ai/model-performance.js';
import type { ModelKey, Recommendation } from '../ai/model-types.js';
import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import type { AttemptRecord, DecisionTrace } from '../nexus/nexus-types.js';
import { evaluateTrade, FLAT_BAND_BP, scoreAttempt, type TradeEvaluation, type TradeOutcome } from './outcome-evaluator.js';

export const POST_TRADE_REVIEW_VERSION = 'post-trade-review:v1' as const;
export const POST_TRADE_REVIEW_POLICY_VERSION = 'post-trade-review-policy:v1' as const;

export type ProcessClassification =
  | 'PROCESS_STRONG'
  | 'PROCESS_ACCEPTABLE'
  | 'PROCESS_WEAK'
  | 'PROCESS_BLOCKED';

export type OutcomeClassification =
  | 'OUTCOME_FAVORABLE'
  | 'OUTCOME_FLAT'
  | 'OUTCOME_ADVERSE';

export interface PostTradeReviewPolicy {
  version: typeof POST_TRADE_REVIEW_POLICY_VERSION;
  minimumEvidenceCountForStrong: number;
}

export const DEFAULT_POST_TRADE_REVIEW_POLICY: PostTradeReviewPolicy = Object.freeze({
  version: POST_TRADE_REVIEW_POLICY_VERSION,
  minimumEvidenceCountForStrong: 1,
});

export interface PostTradeReviewRequest {
  trace: DecisionTrace;
  outcome: TradeOutcome;
  evaluation: TradeEvaluation;
  performanceObservations: readonly PerformanceObservation[];
  policy?: PostTradeReviewPolicy;
}

export interface ProcessDiagnostics {
  evidenceCount: number;
  excludedLookAheadCount: number;
  evidenceWarningCount: number;
  blockingEvidenceImpactCount: number;
  successfulNonShadowAnalysts: number;
  distinctAnalystProviders: number;
  requiredIndependentOpinions: number;
  independentOpinionShortfall: number;
  criticRequired: boolean;
  criticObserved: boolean;
  counterAnalysisRequired: boolean;
  counterAnalysisObserved: boolean;
  quantStatus: 'confirmed' | 'contradicts' | 'not_available';
  quantRunId: string | null;
  scannerRunId: string | null;
  backtestRunIds: string[];
  riskPassed: boolean;
  blockingFindingCount: number;
  majorFindingCount: number;
  humanApprovalRequired: boolean;
  humanApprovalStatus: 'pending' | 'not_required';
  paperIntentAllowed: boolean;
  liveOrderAllowed: false;
  physicalPurchaseAllowed: false;
  capitalStateRefPresent: boolean;
  allocationSkipReasons: string[];
}

export interface OutcomeDiagnostics {
  returnBp: number;
  maxAdverseExcursionBp: number;
  maxFavorableExcursionBp: number;
  stop: TradeEvaluation['stop'];
  target: TradeEvaluation['target'];
  directionCorrect: boolean | null;
  netResultChf: bigint;
  feesChf: bigint;
}

export interface AttemptAttribution {
  stepId: string;
  modelKey: ModelKey;
  role: 'analyst' | 'counter_analyst' | 'critic';
  shadow: boolean;
  recommendation: Recommendation;
  confidenceScore: number | null;
  calibratedProbability: number | null;
  calibrationMethod: string | null;
  performanceScore: number;
  directionCorrect: boolean | null;
}

export interface CalibrationDiagnostic {
  stepId: string;
  modelKey: ModelKey;
  targetId: 'recommendation_direction_correct:v1';
  calibratedProbability: number;
  outcomeLabel: 0 | 1;
  brierContribution: number;
}

export type PostTradeFeedbackCode =
  | 'KEEP_PROCESS'
  | 'REVIEW_EVIDENCE_QUALITY'
  | 'REVIEW_MODEL_CONFIDENCE'
  | 'REVIEW_STOP_PLACEMENT'
  | 'REVIEW_TARGET_PLACEMENT'
  | 'REVIEW_RISK_DISCIPLINE'
  | 'REVIEW_PROVIDER_DIVERSITY'
  | 'REVIEW_QUANT_SUPPORT'
  | 'REVIEW_EXECUTION_VS_THESIS';

export interface PostTradeFeedbackItem {
  code: PostTradeFeedbackCode;
  severity: 'info' | 'minor' | 'major';
  basis: 'process' | 'outcome' | 'both';
  references: string[];
  explanation: string;
}

export interface PostTradeReview {
  reviewId: string;
  engineVersion: typeof POST_TRADE_REVIEW_VERSION;
  inputFingerprint: string;
  policy: PostTradeReviewPolicy;
  decisionId: string;
  decisionAsOf: string;
  outcomeKnownAt: string;
  instrumentId: string;
  executed: boolean;
  processClassification: ProcessClassification;
  outcomeClassification: OutcomeClassification;
  processDiagnostics: ProcessDiagnostics;
  outcomeDiagnostics: OutcomeDiagnostics;
  attemptAttribution: AttemptAttribution[];
  calibrationDiagnostics: CalibrationDiagnostic[];
  feedback: PostTradeFeedbackItem[];
  sourceFingerprints: {
    trace: string;
    outcome: string;
    evaluation: string;
    performanceObservations: string;
  };
}

export class PostTradeReviewError extends Error {
  override readonly name = 'PostTradeReviewError';
  constructor(
    readonly code:
      | 'INVALID_TRACE'
      | 'INVALID_OUTCOME'
      | 'INVALID_EVALUATION'
      | 'INVALID_PERFORMANCE'
      | 'INVALID_POLICY',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

const compareCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function fail(code: PostTradeReviewError['code'], message: string): never {
  throw new PostTradeReviewError(code, message);
}

function canonicalMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnit);
}

function normalizeTraceIdentity(trace: DecisionTrace): unknown {
  return {
    ...trace,
    record: {
      ...trace.record,
      evidenceRefs: sortedUnique(trace.record.evidenceRefs),
      reasonCodes: sortedUnique(trace.record.reasonCodes),
    },
    task: {
      ...trace.task,
      requiredCapabilities: sortedUnique(trace.task.requiredCapabilities),
      contextRefs: sortedUnique(trace.task.contextRefs),
    },
    plan: {
      ...trace.plan,
      reasons: sortedUnique(trace.plan.reasons),
    },
    inputs: {
      ...trace.inputs,
      evidence: [...trace.inputs.evidence].sort((a, b) => compareCodeUnit(a.id, b.id)),
      excludedLookAhead: sortedUnique(trace.inputs.excludedLookAhead),
      quant:
        trace.inputs.quant === null
          ? null
          : {
              ...trace.inputs.quant,
              backtestRunIds: sortedUnique(trace.inputs.quant.backtestRunIds ?? []),
            },
    },
    routing: trace.routing.map((one) => ({
      ...one,
      primaries: sortedUnique(one.primaries),
      fallbacks: sortedUnique(one.fallbacks),
      shadow: sortedUnique(one.shadow),
      rejected: [...one.rejected]
        .map((r) => ({ ...r, reasons: sortedUnique(r.reasons) }))
        .sort((a, b) => compareCodeUnit(a.modelKey, b.modelKey)),
    })),
    decision: {
      ...trace.decision,
      reasonCodes: sortedUnique(trace.decision.reasonCodes),
      humanApprovalReasons: sortedUnique(trace.decision.humanApprovalReasons),
      capital:
        trace.decision.capital === null
          ? null
          : {
              ...trace.decision.capital,
              cappedBy: sortedUnique(trace.decision.capital.cappedBy),
              allocationSkipReasons: sortedUnique(trace.decision.capital.allocationSkipReasons),
            },
      evidence: {
        ...trace.decision.evidence,
        warnings: [...trace.decision.evidence.warnings].sort((a, b) =>
          compareCodeUnit(a.code + '|' + a.ref, b.code + '|' + b.ref),
        ),
        impact: sortedUnique(trace.decision.evidence.impact),
      },
    },
    risk: { ...trace.risk, reasons: sortedUnique(trace.risk.reasons) },
    humanApproval: { ...trace.humanApproval, reasons: sortedUnique(trace.humanApproval.reasons) },
  };
}

function validatePolicy(raw: PostTradeReviewPolicy | undefined): PostTradeReviewPolicy {
  const policy = raw ?? DEFAULT_POST_TRADE_REVIEW_POLICY;
  if (
    policy.version !== POST_TRADE_REVIEW_POLICY_VERSION ||
    !Number.isSafeInteger(policy.minimumEvidenceCountForStrong) ||
    policy.minimumEvidenceCountForStrong < 1
  ) {
    fail('INVALID_POLICY', 'post-trade review policy is invalid');
  }
  return {
    version: POST_TRADE_REVIEW_POLICY_VERSION,
    minimumEvidenceCountForStrong: policy.minimumEvidenceCountForStrong,
  };
}

function validateTrace(trace: DecisionTrace): void {
  if (!trace || typeof trace !== 'object') fail('INVALID_TRACE', 'decision trace is required');
  const decisionMs = canonicalMs(trace.decision?.asOf);
  if (decisionMs === null) fail('INVALID_TRACE', 'decision asOf must be a canonical UTC instant');
  if (
    trace.decision.decisionId !== trace.record.decisionId ||
    trace.decision.taskId !== trace.record.taskId ||
    trace.decision.taskId !== trace.task.id ||
    trace.plan.taskId !== trace.task.id ||
    trace.record.asOf !== trace.decision.asOf
  ) {
    fail('INVALID_TRACE', 'decision, record, task and plan identities do not align');
  }
  if (
    trace.decision.execution.liveOrderAllowed !== false ||
    trace.decision.execution.physicalPurchaseAllowed !== false
  ) {
    fail('INVALID_TRACE', 'execution locks must remain false');
  }
  validateRecordAgreement(trace, decisionMs);
  validateEvidence(trace, decisionMs);

  const steps = new Map(trace.plan.steps.map((step) => [step.id, step]));
  const attributable = new Set<string>();
  for (const attempt of trace.attempts) {
    const step = steps.get(attempt.stepId);
    if (!step) fail('INVALID_TRACE', 'attempt references unknown plan step ' + attempt.stepId);
    if (attempt.role !== step.role) fail('INVALID_TRACE', 'attempt role does not match plan step ' + attempt.stepId);
    validateProbabilityFields(attempt);
    if (attempt.status === 'ok') {
      if (!attempt.opinion) fail('INVALID_TRACE', 'successful attempt has no opinion');
      if (attempt.provider + '/' + attempt.model !== attempt.modelKey) {
        fail('INVALID_TRACE', 'attempt modelKey does not match provider/model');
      }
      const key = attributionKey(
        attempt.modelKey,
        attempt.role,
        trace.task.domain,
        step.subtask ?? trace.task.subtask,
      );
      if (attributable.has(key)) {
        fail('INVALID_TRACE', 'multiple successful attempts are ambiguous for performance attribution: ' + key);
      }
      attributable.add(key);
    }
  }
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort(compareCodeUnit);
  const y = [...b].sort(compareCodeUnit);
  return x.length === y.length && x.every((value, i) => value === y[i]);
}

/** The record, the decision, the capital read and the approval state must describe one decision, not three. */
function validateRecordAgreement(trace: DecisionTrace, asOfMs: number): void {
  const { record, decision, inputs, humanApproval } = trace;
  if (record.finalAction !== decision.finalAction) fail('INVALID_TRACE', 'record and decision disagree on finalAction');
  if (!sameStrings(record.reasonCodes, decision.reasonCodes)) fail('INVALID_TRACE', 'record and decision disagree on reasonCodes');
  if (record.capitalStateRef !== decision.capitalStateRef || decision.capitalStateRef !== inputs.capitalStateRef) {
    fail('INVALID_TRACE', 'record, decision and inputs disagree on the capital state reference');
  }
  const capitalMs = canonicalMs(inputs.capitalStateTimestamp);
  if (capitalMs === null || capitalMs > asOfMs) fail('INVALID_TRACE', 'capital state must be read at or before the decision asOf');
  if (decision.requiresHumanApproval !== humanApproval.required) {
    fail('INVALID_TRACE', 'decision and humanApproval disagree on whether approval is required');
  }
  if (humanApproval.required ? humanApproval.status !== 'pending' : humanApproval.status !== 'not_required') {
    fail('INVALID_TRACE', 'humanApproval status contradicts whether approval is required');
  }
  const runIds = trace.attempts.map((attempt) => {
    if (!attempt.runId) fail('INVALID_TRACE', 'attempt has no recorded model run');
    return attempt.runId;
  });
  if (!sameStrings(runIds, record.modelRuns)) fail('INVALID_TRACE', 'record model runs do not match the recorded attempts');
}

type EvidenceItem = DecisionTrace['inputs']['evidence'][number];

/** Evidence the decision could use: the Brain only cites statuses other than unknown and not_yet_available. */
function isUsable(item: EvidenceItem): boolean {
  return item.status !== 'unknown' && item.status !== 'not_yet_available';
}

/**
 * Evidence inside the trace must be point-in-time: availability never precedes observation, look-ahead items are
 * exactly the excluded ones, quarantined items are never cited, and every usable item is cited by the record.
 */
function validateEvidence(trace: DecisionTrace, asOfMs: number): void {
  const { inputs, record, security } = trace;
  const excluded = new Set<string>();
  for (const id of inputs.excludedLookAhead) {
    if (excluded.has(id)) fail('INVALID_TRACE', 'duplicate excluded look-ahead evidence ' + id);
    excluded.add(id);
  }
  const items = new Map<string, EvidenceItem>();
  for (const item of inputs.evidence) {
    if (items.has(item.id)) fail('INVALID_TRACE', 'duplicate evidence id ' + item.id);
    items.set(item.id, item);
    if (item.status === 'unknown') continue;
    const observedMs = canonicalMs(item.observedAt);
    const availableMs = canonicalMs(item.availableAt);
    if (observedMs === null || availableMs === null) fail('INVALID_TRACE', 'evidence ' + item.id + ' has non-canonical timestamps');
    if (availableMs < observedMs) fail('INVALID_TRACE', 'evidence ' + item.id + ' is available before it was observed');
    const lookAhead = availableMs > asOfMs;
    if (lookAhead !== (item.status === 'not_yet_available')) {
      fail('INVALID_TRACE', 'evidence ' + item.id + ' status contradicts its availability time');
    }
    if (lookAhead !== excluded.has(item.id)) fail('INVALID_TRACE', 'evidence ' + item.id + ' look-ahead exclusion is inconsistent');
  }
  for (const id of excluded) {
    const item = items.get(id);
    if (!item || item.status !== 'not_yet_available') fail('INVALID_TRACE', 'excluded look-ahead evidence is not a look-ahead item: ' + id);
  }

  const cited = new Set(record.evidenceRefs);
  if (cited.size !== record.evidenceRefs.length) fail('INVALID_TRACE', 'record evidence references contain duplicates');
  const quarantined = new Set(security.quarantinedEvidence.map((q) => q.evidenceId));
  for (const ref of cited) {
    if (ref === inputs.capitalEvidenceId) continue;
    const item = items.get(ref);
    if (!item) fail('INVALID_TRACE', 'record evidence reference does not resolve to trace inputs: ' + ref);
    if (!isUsable(item)) fail('INVALID_TRACE', 'record cites evidence that was not usable: ' + ref);
    if (quarantined.has(ref)) fail('INVALID_TRACE', 'record cites quarantined evidence: ' + ref);
  }
  for (const item of items.values()) {
    if (isUsable(item) && !cited.has(item.id)) fail('INVALID_TRACE', 'usable evidence is missing from the record references: ' + item.id);
  }
}

function validateProbabilityFields(attempt: AttemptRecord): void {
  if (
    attempt.confidenceScore !== undefined &&
    attempt.confidenceScore !== null &&
    (!Number.isFinite(attempt.confidenceScore) || attempt.confidenceScore < 0 || attempt.confidenceScore > 1)
  ) {
    fail('INVALID_TRACE', 'attempt confidenceScore must be within 0..1');
  }
  const hasProbability = attempt.calibratedProbability !== undefined && attempt.calibratedProbability !== null;
  const hasMethod = attempt.calibrationMethod !== undefined && attempt.calibrationMethod !== null;
  if (hasProbability) {
    if (
      !Number.isFinite(attempt.calibratedProbability) ||
      attempt.calibratedProbability! < 0 ||
      attempt.calibratedProbability! > 1
    ) {
      fail('INVALID_TRACE', 'attempt calibratedProbability must be within 0..1');
    }
  }
  if (hasProbability !== hasMethod) {
    fail('INVALID_TRACE', 'calibrated probability and calibration method must be set together');
  }
  if (hasMethod && (typeof attempt.calibrationMethod !== 'string' || attempt.calibrationMethod!.trim() === '')) {
    fail('INVALID_TRACE', 'calibration method must be a non-empty string');
  }
}

function validateOutcome(trace: DecisionTrace, outcome: TradeOutcome): void {
  if (!outcome || outcome.kind !== 'trade') fail('INVALID_OUTCOME', 'O13 V1 accepts trade outcomes only');
  if (outcome.decisionId !== trace.decision.decisionId) fail('INVALID_OUTCOME', 'outcome belongs to another decision');
  const decisionMs = canonicalMs(trace.decision.asOf)!;
  const knownAtMs = canonicalMs(outcome.knownAt);
  if (knownAtMs === null || knownAtMs <= decisionMs) {
    fail('INVALID_OUTCOME', 'outcome knownAt must be canonical UTC and later than the decision');
  }
  const openedAtMs = canonicalMs(outcome.openedAt);
  const closedAtMs = canonicalMs(outcome.closedAt);
  if (openedAtMs === null) fail('INVALID_OUTCOME', 'openedAt must be a canonical UTC instant');
  if (closedAtMs === null) fail('INVALID_OUTCOME', 'closedAt must be a canonical UTC instant');
  if (closedAtMs < openedAtMs) fail('INVALID_OUTCOME', 'closedAt cannot precede openedAt');
  if (knownAtMs < closedAtMs) fail('INVALID_OUTCOME', 'knownAt cannot precede closedAt');
  if (openedAtMs < decisionMs) fail('INVALID_OUTCOME', 'trade cannot open before the decision was made');
  if (typeof outcome.executed !== 'boolean') fail('INVALID_OUTCOME', 'executed must be a boolean');
  if (typeof outcome.feesChf !== 'bigint' || outcome.feesChf < 0n) {
    fail('INVALID_OUTCOME', 'feesChf must be a non-negative Rappen amount');
  }
  if (typeof outcome.netResultChf !== 'bigint') fail('INVALID_OUTCOME', 'netResultChf must be a Rappen amount');

  if (!(outcome.entryPrice instanceof Decimal) || !outcome.entryPrice.isPositive()) fail('INVALID_OUTCOME', 'entryPrice must be a positive Decimal');
  if (!(outcome.exitPrice instanceof Decimal) || !outcome.exitPrice.isPositive()) fail('INVALID_OUTCOME', 'exitPrice must be a positive Decimal');
  if (!(outcome.highestPrice instanceof Decimal) || !outcome.highestPrice.isPositive()) fail('INVALID_OUTCOME', 'highestPrice must be a positive Decimal');
  if (!(outcome.lowestPrice instanceof Decimal) || !outcome.lowestPrice.isPositive()) fail('INVALID_OUTCOME', 'lowestPrice must be a positive Decimal');
  if (outcome.highestPrice.lt(outcome.lowestPrice)) fail('INVALID_OUTCOME', 'highestPrice cannot be below lowestPrice');
  if (outcome.highestPrice.lt(outcome.entryPrice) || outcome.highestPrice.lt(outcome.exitPrice)) {
    fail('INVALID_OUTCOME', 'highestPrice must cover entryPrice and exitPrice');
  }
  if (outcome.lowestPrice.gt(outcome.entryPrice) || outcome.lowestPrice.gt(outcome.exitPrice)) {
    fail('INVALID_OUTCOME', 'lowestPrice must cover entryPrice and exitPrice');
  }
  if (outcome.stopLoss !== undefined && (!(outcome.stopLoss instanceof Decimal) || !outcome.stopLoss.isPositive())) {
    fail('INVALID_OUTCOME', 'stopLoss must be a positive Decimal when set');
  }
  if (outcome.takeProfit !== undefined && (!(outcome.takeProfit instanceof Decimal) || !outcome.takeProfit.isPositive())) {
    fail('INVALID_OUTCOME', 'takeProfit must be a positive Decimal when set');
  }
  // evaluateTrade treats a stop as "lowest price at or below the stop" and a target as "highest price at or above the target",
  // which is only the long-side meaning. A short cannot be graded with those semantics, so it is refused rather than mis-graded.
  if (trace.decision.direction === 'bearish' && (outcome.stopLoss !== undefined || outcome.takeProfit !== undefined)) {
    fail('INVALID_OUTCOME', 'bearish trades cannot carry a stop or target: stop and target semantics are long-only');
  }
  if (trace.decision.direction === 'bullish') {
    if (outcome.stopLoss !== undefined && !outcome.stopLoss.lt(outcome.entryPrice)) {
      fail('INVALID_OUTCOME', 'bullish stop must sit below the entry price');
    }
    if (outcome.takeProfit !== undefined && !outcome.takeProfit.gt(outcome.entryPrice)) {
      fail('INVALID_OUTCOME', 'bullish target must sit above the entry price');
    }
  }
}

function validateEvaluation(trace: DecisionTrace, outcome: TradeOutcome, evaluation: TradeEvaluation): void {
  let recomputed: TradeEvaluation;
  try {
    recomputed = evaluateTrade(outcome, trace.decision.direction);
  } catch (error) {
    fail('INVALID_EVALUATION', 'could not re-evaluate trade outcome: ' + String(error));
  }
  if (hashOf(recomputed) !== hashOf(evaluation)) {
    fail('INVALID_EVALUATION', 'trade evaluation does not correspond to the supplied outcome');
  }
}

function attributionKey(modelKey: ModelKey, role: string, domain: string, subtask: string): string {
  return modelKey + '|' + role + '|' + domain + '|' + subtask;
}

function observationFingerprint(observation: PerformanceObservation): string {
  return hashOf({
    modelKey: observation.modelKey,
    domain: observation.domain,
    subtask: observation.subtask,
    role: observation.role,
    decisionId: observation.decisionId,
    score: observation.score,
    shadow: observation.shadow,
    occurredAt: observation.occurredAt,
    availableAt: observation.availableAt,
  });
}

function validateAndIndexPerformance(
  trace: DecisionTrace,
  outcome: TradeOutcome,
  evaluation: TradeEvaluation,
  observations: readonly PerformanceObservation[],
): Map<string, PerformanceObservation> {
  if (!Array.isArray(observations)) fail('INVALID_PERFORMANCE', 'performanceObservations must be an array');
  const byKey = new Map<string, PerformanceObservation>();
  const fingerprints = new Set<string>();
  for (const observation of observations) {
    if (observation.decisionId !== trace.decision.decisionId) {
      fail('INVALID_PERFORMANCE', 'performance observation belongs to another decision');
    }
    if (!Number.isFinite(observation.score) || observation.score < 0 || observation.score > 1) {
      fail('INVALID_PERFORMANCE', 'performance score must be within 0..1');
    }
    if (
      observation.occurredAt !== trace.decision.asOf ||
      observation.availableAt !== outcome.knownAt
    ) {
      fail('INVALID_PERFORMANCE', 'performance observation time does not match decision/outcome');
    }
    const fp = observationFingerprint(observation);
    if (fingerprints.has(fp)) fail('INVALID_PERFORMANCE', 'duplicate performance observation');
    fingerprints.add(fp);
    const key = attributionKey(
      observation.modelKey,
      observation.role,
      observation.domain,
      observation.subtask,
    );
    if (byKey.has(key)) fail('INVALID_PERFORMANCE', 'multiple observations map to the same attempt');
    byKey.set(key, observation);
  }

  const planSteps = new Map(trace.plan.steps.map((step) => [step.id, step]));
  const expected = new Set<string>();
  for (const attempt of trace.attempts) {
    if (attempt.status !== 'ok' || !attempt.opinion) continue;
    const step = planSteps.get(attempt.stepId)!;
    const key = attributionKey(attempt.modelKey, attempt.role, trace.task.domain, step.subtask ?? trace.task.subtask);
    expected.add(key);
    const observation = byKey.get(key);
    if (!observation) fail('INVALID_PERFORMANCE', 'missing performance observation for successful attempt ' + key);
    if (observation.shadow !== attempt.shadow) fail('INVALID_PERFORMANCE', 'performance shadow flag does not match attempt');
    // The stored score must be the one OutcomeEvaluator's rule gives this attempt, not any value in range.
    if (observation.score !== scoreAttempt(attempt, evaluation.returnBp)) {
      fail('INVALID_PERFORMANCE', 'performance score does not match the OutcomeEvaluator rule for ' + key);
    }
  }
  for (const key of byKey.keys()) {
    if (!expected.has(key)) fail('INVALID_PERFORMANCE', 'performance observation does not map to a successful trace attempt');
  }
  return byKey;
}

function processDiagnosticsOf(trace: DecisionTrace): ProcessDiagnostics {
  const successfulNonShadowAnalysts = trace.attempts.filter(
    (attempt) => attempt.status === 'ok' && attempt.opinion && attempt.role === 'analyst' && !attempt.shadow,
  );
  const criticObserved = trace.attempts.some(
    (attempt) => attempt.status === 'ok' && !!attempt.opinion && attempt.role === 'critic' && !attempt.shadow,
  );
  const counterAnalysisObserved = trace.attempts.some(
    (attempt) => attempt.status === 'ok' && !!attempt.opinion && attempt.role === 'counter_analyst' && !attempt.shadow,
  );
  const quant = trace.inputs.quant;
  const requiredIndependentOpinions = trace.plan.minIndependentOpinions;
  return {
    evidenceCount: trace.inputs.evidence.filter(isUsable).length,
    excludedLookAheadCount: trace.inputs.excludedLookAhead.length,
    evidenceWarningCount: trace.decision.evidence.warnings.length,
    blockingEvidenceImpactCount: trace.decision.evidence.impact.length,
    successfulNonShadowAnalysts: successfulNonShadowAnalysts.length,
    distinctAnalystProviders: new Set(successfulNonShadowAnalysts.map((attempt) => attempt.provider)).size,
    requiredIndependentOpinions,
    independentOpinionShortfall: Math.max(0, requiredIndependentOpinions - successfulNonShadowAnalysts.length),
    criticRequired: trace.plan.requiresCritic,
    criticObserved,
    counterAnalysisRequired: trace.plan.requiresCounterAnalysis,
    counterAnalysisObserved,
    quantStatus: quant?.status ?? 'not_available',
    quantRunId: quant?.quantRunId ?? null,
    scannerRunId: quant?.scannerRunId ?? null,
    backtestRunIds: sortedUnique(quant?.backtestRunIds ?? []),
    riskPassed: trace.risk.passed,
    blockingFindingCount: trace.decision.consensus.findings.blocking.length,
    majorFindingCount: trace.decision.consensus.findings.major.length,
    humanApprovalRequired: trace.humanApproval.required,
    humanApprovalStatus: trace.humanApproval.status,
    paperIntentAllowed: trace.decision.execution.paperIntentAllowed,
    liveOrderAllowed: false,
    physicalPurchaseAllowed: false,
    capitalStateRefPresent:
      typeof trace.decision.capitalStateRef === 'string' && trace.decision.capitalStateRef.trim() !== '',
    allocationSkipReasons: sortedUnique(trace.decision.capital?.allocationSkipReasons ?? []),
  };
}

function classifyProcess(diagnostics: ProcessDiagnostics, policy: PostTradeReviewPolicy): ProcessClassification {
  if (!diagnostics.riskPassed || diagnostics.blockingFindingCount > 0) return 'PROCESS_BLOCKED';
  if (
    diagnostics.independentOpinionShortfall > 0 ||
    (diagnostics.criticRequired && !diagnostics.criticObserved) ||
    (diagnostics.counterAnalysisRequired && !diagnostics.counterAnalysisObserved) ||
    diagnostics.majorFindingCount > 0
  ) {
    return 'PROCESS_WEAK';
  }
  if (
    diagnostics.evidenceCount >= policy.minimumEvidenceCountForStrong &&
    diagnostics.evidenceWarningCount === 0 &&
    diagnostics.blockingEvidenceImpactCount === 0
  ) {
    return 'PROCESS_STRONG';
  }
  return 'PROCESS_ACCEPTABLE';
}

function classifyOutcome(evaluation: TradeEvaluation): OutcomeClassification {
  if (evaluation.returnBp > FLAT_BAND_BP) return 'OUTCOME_FAVORABLE';
  if (evaluation.returnBp < -FLAT_BAND_BP) return 'OUTCOME_ADVERSE';
  return 'OUTCOME_FLAT';
}

function directionalCorrect(recommendation: Recommendation, returnBp: number): boolean | null {
  // A flat move has no direction to be right about, so it carries no label at all (not a "wrong" label).
  if (Math.abs(returnBp) <= FLAT_BAND_BP) return null;
  if (recommendation === 'buy') return returnBp > FLAT_BAND_BP;
  if (recommendation === 'sell') return returnBp < -FLAT_BAND_BP;
  return null;
}

function attributionsOf(
  trace: DecisionTrace,
  evaluation: TradeEvaluation,
  byPerformanceKey: Map<string, PerformanceObservation>,
): { attributions: AttemptAttribution[]; calibration: CalibrationDiagnostic[] } {
  const steps = new Map(trace.plan.steps.map((step) => [step.id, step]));
  const attributions: AttemptAttribution[] = [];
  const calibration: CalibrationDiagnostic[] = [];

  for (const attempt of trace.attempts) {
    if (attempt.status !== 'ok' || !attempt.opinion) continue;
    const step = steps.get(attempt.stepId)!;
    const key = attributionKey(attempt.modelKey, attempt.role, trace.task.domain, step.subtask ?? trace.task.subtask);
    const observation = byPerformanceKey.get(key)!;
    const probability = attempt.calibratedProbability ?? null;
    const method = attempt.calibrationMethod ?? null;
    const correct =
      attempt.role === 'analyst'
        ? directionalCorrect(attempt.opinion.recommendation, evaluation.returnBp)
        : null;
    // A calibrated probability is attributed only where its binary target exists: an analyst's buy/sell on a non-flat move.
    // Elsewhere (hold/no_trade, critic, counter-analyst, flat moves) the probability has no defined meaning for this outcome.
    const targetApplies = correct !== null && probability !== null;
    const calibratedProbability = targetApplies ? probability : null;

    attributions.push({
      stepId: attempt.stepId,
      modelKey: attempt.modelKey,
      role: attempt.role,
      shadow: attempt.shadow,
      recommendation: attempt.opinion.recommendation,
      confidenceScore: attempt.confidenceScore ?? null,
      calibratedProbability,
      calibrationMethod: targetApplies ? method : null,
      performanceScore: observation.score,
      directionCorrect: correct,
    });

    if (correct !== null && probability !== null) {
      const label: 0 | 1 = correct ? 1 : 0;
      calibration.push({
        stepId: attempt.stepId,
        modelKey: attempt.modelKey,
        targetId: 'recommendation_direction_correct:v1',
        calibratedProbability: probability,
        outcomeLabel: label,
        brierContribution: (probability - label) ** 2,
      });
    }
  }
  return { attributions, calibration };
}

function feedbackOf(
  process: ProcessClassification,
  diagnostics: ProcessDiagnostics,
  evaluation: TradeEvaluation,
  executed: boolean,
  calibration: readonly CalibrationDiagnostic[],
): PostTradeFeedbackItem[] {
  const feedback: PostTradeFeedbackItem[] = [];

  if (process === 'PROCESS_BLOCKED') {
    feedback.push({
      code: 'REVIEW_RISK_DISCIPLINE',
      severity: 'major',
      basis: 'process',
      references: ['risk'],
      explanation: 'The pre-trade process was blocked by risk or unresolved blocking findings.',
    });
  }
  if (diagnostics.evidenceWarningCount > 0 || diagnostics.blockingEvidenceImpactCount > 0) {
    feedback.push({
      code: 'REVIEW_EVIDENCE_QUALITY',
      severity: diagnostics.blockingEvidenceImpactCount > 0 ? 'major' : 'minor',
      basis: 'process',
      references: ['evidence'],
      explanation: 'Review the evidence warnings or decision impacts present before the outcome was known.',
    });
  }
  if (
    diagnostics.independentOpinionShortfall > 0 ||
    (diagnostics.criticRequired && !diagnostics.criticObserved) ||
    (diagnostics.counterAnalysisRequired && !diagnostics.counterAnalysisObserved)
  ) {
    feedback.push({
      code: 'REVIEW_PROVIDER_DIVERSITY',
      severity: 'major',
      basis: 'process',
      references: ['plan', 'attempts'],
      explanation: 'The observed independent review did not satisfy the pre-declared review requirements.',
    });
  }
  if (diagnostics.quantStatus !== 'confirmed') {
    feedback.push({
      code: 'REVIEW_QUANT_SUPPORT',
      severity: 'minor',
      basis: 'process',
      references: ['quant'],
      explanation: 'The decision did not carry confirmed quantitative support.',
    });
  }
  if (evaluation.stop === 'hit_then_recovered') {
    feedback.push({
      code: 'REVIEW_STOP_PLACEMENT',
      severity: 'minor',
      basis: 'outcome',
      references: ['trade-evaluation'],
      explanation: 'The stop was touched before the trade later recovered; review stop placement without changing the original process grade.',
    });
  }
  if (evaluation.target === 'not_reached' && evaluation.returnBp > FLAT_BAND_BP) {
    feedback.push({
      code: 'REVIEW_TARGET_PLACEMENT',
      severity: 'info',
      basis: 'outcome',
      references: ['trade-evaluation'],
      explanation: 'The trade moved favorably without reaching the declared target; review target placement.',
    });
  }
  if (!executed) {
    feedback.push({
      code: 'REVIEW_EXECUTION_VS_THESIS',
      severity: 'info',
      basis: 'both',
      references: ['decision', 'outcome'],
      explanation: 'This was a counterfactual outcome; separate thesis quality from actual execution results.',
    });
  }
  if (calibration.some((one) => one.brierContribution >= 0.25)) {
    feedback.push({
      code: 'REVIEW_MODEL_CONFIDENCE',
      severity: 'minor',
      basis: 'both',
      references: sortedUnique(calibration.filter((one) => one.brierContribution >= 0.25).map((one) => one.modelKey)),
      explanation: 'At least one calibrated probability had a large binary forecast error on this outcome.',
    });
  }

  if (feedback.length === 0) {
    feedback.push({
      code: 'KEEP_PROCESS',
      severity: 'info',
      basis: 'process',
      references: ['decision'],
      explanation: 'No deterministic process-review trigger fired for this decision.',
    });
  }

  return feedback;
}

function performanceFingerprint(observations: readonly PerformanceObservation[]): string {
  return hashOf(
    observations
      .map((observation) => ({
        fingerprint: observationFingerprint(observation),
        observation,
      }))
      .sort((a, b) => compareCodeUnit(a.fingerprint, b.fingerprint))
      .map((one) => one.observation),
  );
}

export function buildPostTradeReview(request: PostTradeReviewRequest): PostTradeReview {
  const policy = validatePolicy(request.policy);
  validateTrace(request.trace);
  validateOutcome(request.trace, request.outcome);
  validateEvaluation(request.trace, request.outcome, request.evaluation);
  const performance = validateAndIndexPerformance(
    request.trace,
    request.outcome,
    request.evaluation,
    request.performanceObservations,
  );

  const processDiagnostics = processDiagnosticsOf(request.trace);
  const processClassification = classifyProcess(processDiagnostics, policy);
  const outcomeClassification = classifyOutcome(request.evaluation);
  const { attributions, calibration } = attributionsOf(request.trace, request.evaluation, performance);

  const sourceFingerprints = {
    trace: hashOf(normalizeTraceIdentity(request.trace)),
    outcome: hashOf(request.outcome),
    evaluation: hashOf(request.evaluation),
    performanceObservations: performanceFingerprint(request.performanceObservations),
  };
  const identity = {
    engineVersion: POST_TRADE_REVIEW_VERSION,
    policy,
    decisionId: request.trace.decision.decisionId,
    decisionAsOf: request.trace.decision.asOf,
    outcomeKnownAt: request.outcome.knownAt,
    sourceFingerprints,
  };
  const inputFingerprint = hashOf(identity);

  const review: PostTradeReview = {
    reviewId: 'ptr_' + inputFingerprint.slice(0, 40),
    engineVersion: POST_TRADE_REVIEW_VERSION,
    inputFingerprint,
    policy,
    decisionId: request.trace.decision.decisionId,
    decisionAsOf: request.trace.decision.asOf,
    outcomeKnownAt: request.outcome.knownAt,
    instrumentId: request.outcome.instrumentId,
    executed: request.outcome.executed,
    processClassification,
    outcomeClassification,
    processDiagnostics,
    outcomeDiagnostics: {
      returnBp: request.evaluation.returnBp,
      maxAdverseExcursionBp: request.evaluation.maxAdverseExcursionBp,
      maxFavorableExcursionBp: request.evaluation.maxFavorableExcursionBp,
      stop: request.evaluation.stop,
      target: request.evaluation.target,
      directionCorrect: request.evaluation.directionCorrect,
      netResultChf: request.evaluation.netResultChf,
      feesChf: request.evaluation.feesChf,
    },
    attemptAttribution: attributions,
    calibrationDiagnostics: calibration,
    feedback: feedbackOf(
      processClassification,
      processDiagnostics,
      request.evaluation,
      request.outcome.executed,
      calibration,
    ),
    sourceFingerprints,
  };
  return review;
}

export function verifyPostTradeReview(
  request: PostTradeReviewRequest,
  review: PostTradeReview,
): void {
  const recomputed = buildPostTradeReview(request);
  if (hashOf(recomputed) !== hashOf(review)) {
    fail('INVALID_EVALUATION', 'post-trade review does not match its source request');
  }
}
