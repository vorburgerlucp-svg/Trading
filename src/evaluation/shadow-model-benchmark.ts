import {
  DEFAULT_CHAMPION_POLICY,
  shadowExitGate,
  type ChampionPolicy,
} from '../ai/champion-challenger.js';
import {
  DEFAULT_PERFORMANCE_POLICY,
  ModelPerformance,
  type PerformancePolicy,
} from '../ai/model-performance.js';
import type { ModelRegistry } from '../ai/model-registry.js';
import {
  DOMAINS,
  SUBTASKS,
  type Domain,
  type ModelKey,
  type Recommendation,
  type Subtask,
} from '../ai/model-types.js';
import { NexusMemory } from '../memory/nexus-memory.js';
import { hashOf } from '../persistence/canonical-json.js';

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

const HEX64 = /^[0-9a-f]{64}$/;
const RECOMMENDATIONS = new Set<Recommendation>(['buy', 'sell', 'hold', 'no_trade']);
const compareCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function assertHash(value: unknown, code: 'INVALID_CASES' | 'INVALID_MODEL_OUTPUT' | 'INVALID_SCORE', label: string): asserts value is string {
  if (typeof value !== 'string' || !HEX64.test(value)) throw new ShadowModelBenchmarkError(code, label + ' must be a lowercase 64-character hex hash');
}

function assertPolicy(performance: PerformancePolicy, champion: ChampionPolicy): void {
  if (!Number.isSafeInteger(performance.minSamplesForScore) || performance.minSamplesForScore < 1) {
    throw new ShadowModelBenchmarkError('INVALID_CASES', 'performance minSamplesForScore must be a positive integer');
  }
  if (!Number.isFinite(performance.priorScore) || performance.priorScore < 0 || performance.priorScore > 1) {
    throw new ShadowModelBenchmarkError('INVALID_CASES', 'performance priorScore must be within 0..1');
  }
  if (!Number.isFinite(performance.priorWeight) || performance.priorWeight < 0) {
    throw new ShadowModelBenchmarkError('INVALID_CASES', 'performance priorWeight must be finite and non-negative');
  }
  if (!Number.isSafeInteger(champion.minSamplesToLeaveShadow) || champion.minSamplesToLeaveShadow < 1) {
    throw new ShadowModelBenchmarkError('INVALID_CASES', 'shadow exit minimum samples must be a positive integer');
  }
  if (!Number.isFinite(champion.minScoreToLeaveShadow) || champion.minScoreToLeaveShadow < 0 || champion.minScoreToLeaveShadow > 1) {
    throw new ShadowModelBenchmarkError('INVALID_CASES', 'shadow exit minimum score must be within 0..1');
  }
  if (!Number.isSafeInteger(champion.minSamplesForChampion) || champion.minSamplesForChampion < 1) {
    throw new ShadowModelBenchmarkError('INVALID_CASES', 'champion minimum samples must be a positive integer');
  }
  if (!Number.isFinite(champion.minScoreMargin) || champion.minScoreMargin < 0 || champion.minScoreMargin > 1) {
    throw new ShadowModelBenchmarkError('INVALID_CASES', 'champion score margin must be within 0..1');
  }
}

function canonicalCases(raw: readonly ShadowBenchmarkCase[]): Array<ShadowBenchmarkCase & { caseFingerprint: string }> {
  if (!Array.isArray(raw) || raw.length === 0) throw new ShadowModelBenchmarkError('INVALID_CASES', 'at least one historical case is required');
  const seen = new Set<string>();
  const out: Array<ShadowBenchmarkCase & { caseFingerprint: string }> = [];

  for (const one of raw) {
    if (!one || typeof one.caseId !== 'string' || one.caseId.trim() === '' || one.caseId !== one.caseId.trim()) {
      throw new ShadowModelBenchmarkError('INVALID_CASES', 'caseId must be a non-empty trimmed string');
    }
    if (seen.has(one.caseId)) throw new ShadowModelBenchmarkError('INVALID_CASES', 'duplicate caseId ' + one.caseId);
    seen.add(one.caseId);

    if (!Number.isFinite(Date.parse(one.asOf))) throw new ShadowModelBenchmarkError('INVALID_CASES', one.caseId + ' asOf must be an ISO timestamp');
    if (!(DOMAINS as readonly string[]).includes(one.domain)) throw new ShadowModelBenchmarkError('INVALID_CASES', one.caseId + ' domain is invalid');
    if (!(SUBTASKS as readonly string[]).includes(one.subtask)) throw new ShadowModelBenchmarkError('INVALID_CASES', one.caseId + ' subtask is invalid');
    if (typeof one.modelInput !== 'object' || one.modelInput === null || Array.isArray(one.modelInput)) {
      throw new ShadowModelBenchmarkError('INVALID_CASES', one.caseId + ' modelInput must be an object');
    }
    if (typeof one.outcome !== 'object' || one.outcome === null || Array.isArray(one.outcome)) {
      throw new ShadowModelBenchmarkError('INVALID_CASES', one.caseId + ' outcome must be an object');
    }

    assertHash(one.modelInputFingerprint, 'INVALID_CASES', one.caseId + ' modelInputFingerprint');
    assertHash(one.outcomeFingerprint, 'INVALID_CASES', one.caseId + ' outcomeFingerprint');
    if (hashOf(one.modelInput) !== one.modelInputFingerprint) {
      throw new ShadowModelBenchmarkError('INVALID_CASES', one.caseId + ' model input fingerprint does not match its payload');
    }
    if (hashOf(one.outcome) !== one.outcomeFingerprint) {
      throw new ShadowModelBenchmarkError('INVALID_CASES', one.caseId + ' outcome fingerprint does not match its payload');
    }

    const modelInput = structuredClone(one.modelInput);
    const outcome = structuredClone(one.outcome);
    const normalized: ShadowBenchmarkCase = {
      caseId: one.caseId,
      asOf: one.asOf,
      domain: one.domain,
      subtask: one.subtask,
      modelInput,
      modelInputFingerprint: one.modelInputFingerprint,
      outcome,
      outcomeFingerprint: one.outcomeFingerprint,
    };
    const caseFingerprint = hashOf({
      caseId: normalized.caseId,
      asOf: normalized.asOf,
      domain: normalized.domain,
      subtask: normalized.subtask,
      modelInputFingerprint: normalized.modelInputFingerprint,
      outcomeFingerprint: normalized.outcomeFingerprint,
    });
    out.push({ ...normalized, caseFingerprint });
  }

  return out.sort((a, b) => compareCodeUnit(a.caseId, b.caseId));
}

function validateModelKey(key: string): void {
  if (
    typeof key !== 'string' ||
    key.trim() !== key ||
    key.includes(' ') ||
    key.split('/').length !== 2 ||
    key.startsWith('/') ||
    key.endsWith('/')
  ) {
    throw new ShadowModelBenchmarkError('INVALID_MODEL', 'modelKey must be provider/model');
  }
}

function normalizeOutput(raw: ShadowBenchmarkModelOutput, expectedModel: string, expectedCase: string): ShadowBenchmarkModelOutput {
  if (!raw || raw.modelKey !== expectedModel || raw.caseId !== expectedCase) {
    throw new ShadowModelBenchmarkError('INVALID_MODEL_OUTPUT', expectedCase + ' model output identity does not match request');
  }
  if (!RECOMMENDATIONS.has(raw.recommendation)) {
    throw new ShadowModelBenchmarkError('INVALID_MODEL_OUTPUT', expectedCase + ' recommendation is invalid');
  }
  if (!Number.isFinite(raw.confidenceScore) || raw.confidenceScore < 0 || raw.confidenceScore > 1) {
    throw new ShadowModelBenchmarkError('INVALID_MODEL_OUTPUT', expectedCase + ' confidenceScore must be within 0..1');
  }
  if (typeof raw.modelVersion !== 'string' || raw.modelVersion.trim() === '') {
    throw new ShadowModelBenchmarkError('INVALID_MODEL_OUTPUT', expectedCase + ' modelVersion is required');
  }
  assertHash(raw.evidenceFingerprint, 'INVALID_MODEL_OUTPUT', expectedCase + ' evidenceFingerprint');
  assertHash(raw.outputFingerprint, 'INVALID_MODEL_OUTPUT', expectedCase + ' outputFingerprint');
  const expectedOutputFingerprint = hashOf({
    modelKey: raw.modelKey,
    caseId: raw.caseId,
    recommendation: raw.recommendation,
    confidenceScore: raw.confidenceScore,
    modelVersion: raw.modelVersion,
    evidenceFingerprint: raw.evidenceFingerprint,
  });
  if (raw.outputFingerprint !== expectedOutputFingerprint) {
    throw new ShadowModelBenchmarkError('INVALID_MODEL_OUTPUT', expectedCase + ' outputFingerprint does not bind the returned output fields');
  }
  return {
    modelKey: raw.modelKey,
    caseId: raw.caseId,
    recommendation: raw.recommendation,
    confidenceScore: raw.confidenceScore,
    modelVersion: raw.modelVersion,
    evidenceFingerprint: raw.evidenceFingerprint,
    outputFingerprint: raw.outputFingerprint,
  };
}

function normalizeScore(
  raw: Awaited<ReturnType<ShadowBenchmarkScorer['score']>>,
  expectedModel: string,
  expectedCase: string,
  outcomeFingerprint: string,
  outputFingerprint: string,
): { score: number; scoringFingerprint: string } {
  if (!raw || raw.modelKey !== expectedModel || raw.caseId !== expectedCase) {
    throw new ShadowModelBenchmarkError('INVALID_SCORE', expectedCase + ' score identity does not match request');
  }
  if (!Number.isFinite(raw.score) || raw.score < 0 || raw.score > 1) {
    throw new ShadowModelBenchmarkError('INVALID_SCORE', expectedCase + ' score must be finite and within 0..1');
  }
  assertHash(raw.scoringFingerprint, 'INVALID_SCORE', expectedCase + ' scoringFingerprint');
  const expectedScoringFingerprint = hashOf({
    modelKey: raw.modelKey,
    caseId: raw.caseId,
    score: String(raw.score),
    outcomeFingerprint,
    outputFingerprint,
  });
  if (raw.scoringFingerprint !== expectedScoringFingerprint) {
    throw new ShadowModelBenchmarkError('INVALID_SCORE', expectedCase + ' scoringFingerprint does not bind score, outcome and model output');
  }
  return { score: raw.score, scoringFingerprint: raw.scoringFingerprint };
}

/**
 * Measures a registered model on an immutable historical case set. The model evaluator never receives
 * the outcome payload or outcome fingerprint. Only after its output is validated and frozen does the
 * scorer receive the realized outcome.
 */
export async function runShadowModelBenchmark(
  request: ShadowBenchmarkRequest,
  evaluator: ShadowBenchmarkEvaluator,
  scorer: ShadowBenchmarkScorer,
): Promise<ShadowModelBenchmarkResult> {
  validateModelKey(request.modelKey);
  const registryEntry = request.registry.get(request.modelKey);
  if (!registryEntry) throw new ShadowModelBenchmarkError('INVALID_MODEL', 'model is not registered: ' + request.modelKey);

  const performancePolicy = structuredClone(request.performancePolicy ?? DEFAULT_PERFORMANCE_POLICY);
  const championPolicy = structuredClone(request.championPolicy ?? DEFAULT_CHAMPION_POLICY);
  assertPolicy(performancePolicy, championPolicy);

  const normalizedCases = canonicalCases(request.cases);
  const caseSetFingerprint = hashOf(
    normalizedCases.map((one) => ({
      caseId: one.caseId,
      caseFingerprint: one.caseFingerprint,
    })),
  );

  const outputs = new Set<string>();
  const scores = new Set<string>();
  const caseResults: ShadowBenchmarkCaseResult[] = [];

  const memory = await NexusMemory.open();
  const performance = new ModelPerformance(memory, performancePolicy);

  for (const one of normalizedCases) {
    const modelRequest: ShadowBenchmarkModelRequest = deepFreeze({
      modelKey: request.modelKey,
      caseId: one.caseId,
      asOf: one.asOf,
      domain: one.domain,
      subtask: one.subtask,
      modelInput: deepFreeze(structuredClone(one.modelInput)),
      modelInputFingerprint: one.modelInputFingerprint,
    });

    const modelOutput = normalizeOutput(
      await evaluator.evaluate(modelRequest),
      request.modelKey,
      one.caseId,
    );
    if (outputs.has(modelOutput.outputFingerprint)) {
      throw new ShadowModelBenchmarkError('INVALID_MODEL_OUTPUT', 'duplicate outputFingerprint ' + modelOutput.outputFingerprint);
    }
    outputs.add(modelOutput.outputFingerprint);
    const frozenOutput = deepFreeze(structuredClone(modelOutput));

    const scoreRequest: ShadowBenchmarkScoreRequest = deepFreeze({
      modelKey: request.modelKey,
      caseId: one.caseId,
      asOf: one.asOf,
      domain: one.domain,
      subtask: one.subtask,
      modelOutput: frozenOutput,
      outcome: deepFreeze(structuredClone(one.outcome)),
      outcomeFingerprint: one.outcomeFingerprint,
    });
    const scoreResult = normalizeScore(
      await scorer.score(scoreRequest),
      request.modelKey,
      one.caseId,
      one.outcomeFingerprint,
      frozenOutput.outputFingerprint,
    );
    if (scores.has(scoreResult.scoringFingerprint)) {
      throw new ShadowModelBenchmarkError('INVALID_SCORE', 'duplicate scoringFingerprint ' + scoreResult.scoringFingerprint);
    }
    scores.add(scoreResult.scoringFingerprint);

    await performance.record('o11:' + request.modelKey + ':' + one.caseId, {
      modelKey: request.modelKey,
      domain: one.domain,
      subtask: one.subtask,
      role: 'analyst',
      decisionId: one.caseId,
      score: scoreResult.score,
      shadow: registryEntry.shadowMode,
      occurredAt: one.asOf,
      availableAt: one.asOf,
    });

    caseResults.push({
      caseId: one.caseId,
      caseFingerprint: one.caseFingerprint,
      modelOutput: structuredClone(frozenOutput),
      score: scoreResult.score,
      scoringFingerprint: scoreResult.scoringFingerprint,
    });
  }

  const gateAsOf = normalizedCases
    .map((one) => one.asOf)
    .reduce((latest, current) => (Date.parse(current) > Date.parse(latest) ? current : latest));
  const stats = performance.stats(request.modelKey, gateAsOf);
  const gateBase = shadowExitGate(request.modelKey, performance, gateAsOf, championPolicy);
  const gate: ShadowBenchmarkGate = {
    passed: gateBase.passed,
    reasons: [...gateBase.reasons],
    status: gateBase.passed ? 'GATE_PASSED_HUMAN_REVIEW_REQUIRED' : 'GATE_FAILED',
  };

  const identity = {
    engine: SHADOW_MODEL_BENCHMARK_VERSION,
    modelKey: request.modelKey,
    shadowModeAtBenchmark: registryEntry.shadowMode,
    performancePolicy,
    championPolicy,
    caseSetFingerprint,
    cases: caseResults.map((one) => ({
      caseId: one.caseId,
      caseFingerprint: one.caseFingerprint,
      outputFingerprint: one.modelOutput.outputFingerprint,
      evidenceFingerprint: one.modelOutput.evidenceFingerprint,
      confidenceScore: one.modelOutput.confidenceScore,
      recommendation: one.modelOutput.recommendation,
      modelVersion: one.modelOutput.modelVersion,
      score: one.score,
      scoringFingerprint: one.scoringFingerprint,
    })),
  };
  const inputFingerprint = hashOf(identity);

  return {
    benchmarkRunId: 'smb_' + inputFingerprint.slice(0, 40),
    engineVersion: SHADOW_MODEL_BENCHMARK_VERSION,
    inputFingerprint,
    modelKey: request.modelKey,
    shadowModeAtBenchmark: registryEntry.shadowMode,
    sampleSize: stats.sampleSize,
    meanScore: stats.mean ?? 0,
    shrunkScore: stats.shrunk,
    performancePolicy,
    championPolicy,
    caseSetFingerprint,
    cases: caseResults,
    gate,
  };
}

/** Recomputes every identity and derived value of a benchmark result from its own evidence (O11 review; not implemented yet). */
export function verifyShadowModelBenchmarkResult(_result: ShadowModelBenchmarkResult): void {
  throw new Error('not implemented');
}

export function compareShadowBenchmarks(
  results: readonly ShadowModelBenchmarkResult[],
): ShadowBenchmarkComparison {
  if (!Array.isArray(results) || results.length < 2) {
    throw new ShadowModelBenchmarkError('BENCHMARK_COMPARISON_MISMATCH', 'at least two benchmark results are required');
  }
  const first = results[0]!;
  const policyFingerprint = hashOf({
    performancePolicy: first.performancePolicy,
    championPolicy: first.championPolicy,
  });
  const seenModels = new Set<string>();

  for (const result of results) {
    if (result.caseSetFingerprint !== first.caseSetFingerprint) {
      throw new ShadowModelBenchmarkError('BENCHMARK_COMPARISON_MISMATCH', 'benchmark case sets differ');
    }
    if (result.sampleSize !== first.sampleSize) {
      throw new ShadowModelBenchmarkError('BENCHMARK_COMPARISON_MISMATCH', 'benchmark sample sizes differ');
    }
    if (
      hashOf({
        performancePolicy: result.performancePolicy,
        championPolicy: result.championPolicy,
      }) !== policyFingerprint
    ) {
      throw new ShadowModelBenchmarkError('BENCHMARK_COMPARISON_MISMATCH', 'benchmark policies differ');
    }
    if (seenModels.has(result.modelKey)) {
      throw new ShadowModelBenchmarkError('BENCHMARK_COMPARISON_MISMATCH', 'duplicate model benchmark ' + result.modelKey);
    }
    seenModels.add(result.modelKey);
  }

  return {
    caseSetFingerprint: first.caseSetFingerprint,
    rankedModelKeys: [...results]
      .sort((a, b) => b.shrunkScore - a.shrunkScore || compareCodeUnit(a.modelKey, b.modelKey))
      .map((result) => result.modelKey),
  };
}
