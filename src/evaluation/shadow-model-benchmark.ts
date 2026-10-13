import type { ChampionPolicy } from '../ai/champion-challenger.js';
import type { PerformancePolicy } from '../ai/model-performance.js';
import type { ModelRegistry } from '../ai/model-registry.js';
import type { Domain, ModelKey, Recommendation, Subtask } from '../ai/model-types.js';

export const SHADOW_MODEL_BENCHMARK_VERSION = 'shadow-model-benchmark:v1' as const;

export interface ShadowBenchmarkCase {
  caseId: string;
  asOf: string;
  domain: Domain;
  subtask: Subtask;
  modelInput: Readonly<Record<string, unknown>>;
  modelInputFingerprint: string;
  outcome: Readonly<Record<string, unknown>>;
  outcomeFingerprint: string;
}

export interface ShadowBenchmarkModelRequest {
  modelKey: ModelKey;
  caseId: string;
  asOf: string;
  domain: Domain;
  subtask: Subtask;
  modelInput: Readonly<Record<string, unknown>>;
  modelInputFingerprint: string;
}

export interface ShadowBenchmarkModelOutput {
  modelKey: ModelKey;
  caseId: string;
  recommendation: Recommendation;
  confidenceScore: number;
  modelVersion: string;
  evidenceFingerprint: string;
  outputFingerprint: string;
}

export interface ShadowBenchmarkEvaluator {
  evaluate(input: ShadowBenchmarkModelRequest): Promise<ShadowBenchmarkModelOutput>;
}

export interface ShadowBenchmarkScoreRequest {
  modelKey: ModelKey;
  caseId: string;
  asOf: string;
  domain: Domain;
  subtask: Subtask;
  modelOutput: ShadowBenchmarkModelOutput;
  outcome: Readonly<Record<string, unknown>>;
  outcomeFingerprint: string;
}

export interface ShadowBenchmarkScoreResult {
  modelKey: ModelKey;
  caseId: string;
  score: number;
  scoringFingerprint: string;
}

export interface ShadowBenchmarkScorer {
  score(input: ShadowBenchmarkScoreRequest): Promise<ShadowBenchmarkScoreResult>;
}

export interface ShadowBenchmarkRequest {
  modelKey: ModelKey;
  cases: readonly ShadowBenchmarkCase[];
  registry: ModelRegistry;
  performancePolicy?: PerformancePolicy;
  championPolicy?: ChampionPolicy;
}

export interface ShadowBenchmarkCaseResult {
  caseId: string;
  caseFingerprint: string;
  modelOutput: ShadowBenchmarkModelOutput;
  score: number;
  scoringFingerprint: string;
}

export interface ShadowBenchmarkGate {
  passed: boolean;
  reasons: string[];
  status: 'GATE_PASSED_HUMAN_REVIEW_REQUIRED' | 'GATE_FAILED';
}

export interface ShadowModelBenchmarkResult {
  benchmarkRunId: string;
  engineVersion: typeof SHADOW_MODEL_BENCHMARK_VERSION;
  inputFingerprint: string;
  modelKey: ModelKey;
  shadowModeAtBenchmark: boolean;
  sampleSize: number;
  meanScore: number;
  shrunkScore: number;
  performancePolicy: PerformancePolicy;
  championPolicy: ChampionPolicy;
  caseSetFingerprint: string;
  cases: ShadowBenchmarkCaseResult[];
  gate: ShadowBenchmarkGate;
}

export class ShadowModelBenchmarkError extends Error {
  override readonly name = 'ShadowModelBenchmarkError';
  constructor(
    readonly code:
      | 'INVALID_MODEL'
      | 'INVALID_CASES'
      | 'INVALID_MODEL_OUTPUT'
      | 'INVALID_SCORE'
      | 'BENCHMARK_COMPARISON_MISMATCH',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

export interface ShadowBenchmarkComparison {
  caseSetFingerprint: string;
  rankedModelKeys: ModelKey[];
}

/** O11 RED API surface. Implementation follows after the behavior tests pin the contract. */
export async function runShadowModelBenchmark(
  _request: ShadowBenchmarkRequest,
  _evaluator: ShadowBenchmarkEvaluator,
  _scorer: ShadowBenchmarkScorer,
): Promise<ShadowModelBenchmarkResult> {
  throw new Error('O11 shadow model benchmark not implemented');
}

export function compareShadowBenchmarks(
  _results: readonly ShadowModelBenchmarkResult[],
): ShadowBenchmarkComparison {
  throw new Error('O11 shadow model benchmark comparison not implemented');
}
