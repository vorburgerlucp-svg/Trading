import type { ModelCapability, CouncilRole, Domain, ModelKey, ModelOpinion, Recommendation, RiskFlag, Stance, Subtask } from '../ai/model-types.js';
import type { Rappen } from '../money/money.js';

export type Importance = 'low' | 'medium' | 'high' | 'critical';

export interface AiTask {
  id: string;
  domain: Domain;
  subtask: Subtask;
  importance: Importance;
  /** Capital affected by the decision, CHF minor units (Rappen). */
  capitalAtRiskMinor?: Rappen;
  requiresIndependentOpinions: boolean;
  maximumLatencyMs?: number;
  /** Total AI budget for the task, CHF minor units (Rappen). */
  maximumAiCostMinor?: Rappen;
  requiredCapabilities: ModelCapability[];
  contextRefs: string[];
  /** Uncertainty signalled by data/quant (raises decision depth). */
  uncertainty?: 'low' | 'medium' | 'high';
  /** Known contradictory data (raises decision depth). */
  conflictingData?: boolean;
  /** Optional division-of-labour pipeline (sequential mode), e.g. discovery → news_sentiment → risk_review. */
  pipeline?: Subtask[];
}

/** Analysis depth grows with stakes and uncertainty. */
export type DecisionDepth = 'single' | 'reviewed' | 'committee' | 'critical_committee';
export const DEPTH_ORDER: readonly DecisionDepth[] = ['single', 'reviewed', 'committee', 'critical_committee'];

export type CollaborationMode = 'parallel' | 'sequential';

export interface PlanStep {
  id: string;
  role: CouncilRole;
  subtask: Subtask;
  /** Number of successful, non-shadow model answers this step needs. */
  models: number;
  minDistinctProviders: number;
  /** independent: sees only system/quant/human context, never other model output. */
  isolation: 'independent' | 'sees_prior_steps';
}

export interface TaskPlan {
  taskId: string;
  depth: DecisionDepth;
  mode: CollaborationMode;
  steps: PlanStep[];
  minIndependentOpinions: number;
  requiresCritic: boolean;
  requiresCounterAnalysis: boolean;
  requiresHumanApproval: boolean;
  /** All voting analysts must recommend the same action. */
  requireUnanimity: boolean;
  /** Major (not only blocking) unresolved findings stop the decision. */
  strictRisk: boolean;
  reasons: string[];
}

/** Deterministic verification from the Quant Engine (not yet built: callers pass it or 'not_available'). */
export interface QuantAssessment {
  status: 'confirmed' | 'contradicts' | 'not_available';
  direction?: 'bullish' | 'bearish' | 'neutral';
  evidenceRefId?: string;
  summary?: string;
}

export interface AttemptRecord {
  stepId: string;
  role: CouncilRole;
  modelKey: ModelKey;
  provider: string;
  model: string;
  shadow: boolean;
  /** Set when this call replaced a failed primary. */
  fallbackFor?: ModelKey;
  status: 'ok' | 'failed' | 'timeout' | 'invalid_output' | 'not_connected';
  error?: string;
  promptId: string;
  promptVersion: string;
  requestHash: string;
  responseHash?: string;
  modelVersion?: string;
  latencyMs: number;
  opinion?: ModelOpinion;
}

export interface AuthoredRiskFlag extends RiskFlag {
  modelKey: ModelKey;
  role: CouncilRole;
  /** Evidence is known, visible, trusted and fresh/timeless at decision time. */
  verified: boolean;
  /** Severity after the evidence rule (unverified "blocking" becomes "major"). */
  effectiveSeverity: RiskFlag['severity'];
}

export interface Contradiction {
  between: string[];
  about: 'direction' | 'action' | 'quant_vs_ai';
  statements: string[];
}

export interface ConsensusResult {
  /** Market view. */
  direction: 'bullish' | 'bearish' | 'neutral' | 'contested' | 'insufficient';
  /** Action view: market opinion and action are separate decisions. */
  execution: 'PROCEED_TO_RISK' | 'NO_ACTION';
  recommendation: Recommendation | null;
  votes: { modelKey: ModelKey; stance: Stance; recommendation: Recommendation; confidence: number }[];
  confidenceRange: { min: number; max: number } | null;
  contradictions: Contradiction[];
  knowledge: { facts: string[]; calculations: string[]; forecasts: string[]; opinions: string[]; risks: string[]; contradictions: string[] };
  findings: { blocking: AuthoredRiskFlag[]; major: AuthoredRiskFlag[]; minor: AuthoredRiskFlag[] };
  uncertainty: 'low' | 'medium' | 'high';
  blockingReasons: string[];
}

export interface CapitalDecision {
  availableChf: Rappen;
  /** Upper bound from Capital Engine + allocation policy for this opportunity. */
  maxAllowedChf: Rappen;
  /** Lowest suggestion from voting analysts (a hint, never authority). */
  aiSuggestedChf: Rappen | null;
  recommendedChf: Rappen;
  cappedBy: string[];
  allocationSkipReasons: string[];
}

export interface ExecutionGateResult {
  liveOrderAllowed: false;
  physicalPurchaseAllowed: false;
  paperIntentAllowed: boolean;
  reasons: string[];
}

export type DecisionOutcome = 'RECOMMEND' | 'NO_ACTION' | 'ANALYSIS_ONLY';

export interface NexusDecision {
  decisionId: string;
  taskId: string;
  asOf: string;
  outcome: DecisionOutcome;
  direction: ConsensusResult['direction'];
  recommendation: Recommendation | null;
  depth: DecisionDepth;
  mode: CollaborationMode;
  capital: CapitalDecision | null;
  requiresHumanApproval: boolean;
  humanApprovalReasons: string[];
  execution: ExecutionGateResult;
  reasons: string[];
  consensus: ConsensusResult;
}

/** Full reconstruction of a decision: Task → Inputs → Models → Prompts → Responses → Blackboard → Critic → Consensus → Risk → Capital → Approval → Action (→ Outcome, linked later). */
export interface DecisionRecord {
  decision: NexusDecision;
  task: AiTask;
  question: string;
  plan: TaskPlan;
  inputs: {
    evidence: { id: string; type: string; source: string; observedAt: string; availableAt: string; status: string; version: string | null }[];
    excludedLookAhead: string[];
    capitalStateTimestamp: string;
    capitalEvidenceId: string;
    quant: QuantAssessment | null;
  };
  routing: { stepId: string; primaries: ModelKey[]; fallbacks: ModelKey[]; shadow: ModelKey[]; rejected: { modelKey: ModelKey; reasons: string[] }[] }[];
  attempts: AttemptRecord[];
  blackboardEntryIds: string[];
  criticFindings: AuthoredRiskFlag[];
  risk: { passed: boolean; reasons: string[] };
  humanApproval: { required: boolean; status: 'pending' | 'not_required'; reasons: string[] };
  security: { quarantinedEvidence: { evidenceId: string; rules: string[] }[] };
}
