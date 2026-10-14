import { types } from 'node:util';
import {
  DEFAULT_CHAMPION_POLICY,
  shadowExitGate,
  type ChampionPolicy,
} from '../ai/champion-challenger.js';
import {
  DEFAULT_PERFORMANCE_POLICY,
  ModelPerformance,
  type PerformanceObservation,
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
import type { NexusMemory } from '../memory/nexus-memory.js';
import { hashOf } from '../persistence/canonical-json.js';

export const SHADOW_MODEL_BENCHMARK_VERSION = 'shadow-model-benchmark:v1' as const;

export interface ShadowBenchmarkCase {
  caseId: string;
  asOf: string;
  domain: Domain;
  subtask: Subtask;
  modelInput: Readonly<Record<string, unknown>>;
  modelInputFingerprint: string;
  /** Must carry `knownAt`: the canonical UTC instant the realized outcome became known. */
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

/** One scored case. It carries every field its caseFingerprint binds, so a result can be verified without the original payloads. */
export interface ShadowBenchmarkCaseResult {
  caseId: string;
  asOf: string;
  domain: Domain;
  subtask: Subtask;
  modelInputFingerprint: string;
  outcomeFingerprint: string;
  knownAt: string;
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
  /** The instant the gate is evaluated at: the latest availability of any observation (max of each decision time and outcome knowledge time). */
  gateAsOf: string;
  cases: ShadowBenchmarkCaseResult[];
  gate: ShadowBenchmarkGate;
}

export class ShadowModelBenchmarkError extends Error {
  override readonly name = 'ShadowModelBenchmarkError';
  constructor(
    readonly code:
      | 'INVALID_MODEL'
      | 'INVALID_CASES'
      | 'INVALID_POLICY'
      | 'INVALID_MODEL_OUTPUT'
      | 'INVALID_SCORE'
      | 'INVALID_RESULT'
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
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f]/;
const compareCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function fail(code: ShadowModelBenchmarkError['code'], message: string): never {
  throw new ShadowModelBenchmarkError(code, message);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

function assertHash(value: unknown, code: 'INVALID_CASES' | 'INVALID_MODEL_OUTPUT' | 'INVALID_SCORE', label: string): asserts value is string {
  if (!isHash(value)) fail(code, label + ' must be a lowercase 64-character hex hash');
}

/** Milliseconds of a canonical UTC instant (ISO with milliseconds and Z), or null. Another spelling of the same instant has another identity, so it is refused. */
function canonicalMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

/**
 * A payload is accepted only when canonical hashing binds every value in it: plain JSON objects and dense arrays of finite numbers, strings, booleans
 * and null, with enumerable data properties only. Anything else (dates, bigints, undefined, functions, getters, class instances, proxies, cycles) would
 * hash to something other than what the evaluator receives, so it is refused before any hashing.
 */
function assertPayload(value: unknown, label: string, ancestors: object[]): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_CASES', label + ' contains a non-finite number');
    return;
  }
  if (typeof value !== 'object') fail('INVALID_CASES', label + ' contains a ' + typeof value + ' value that canonical hashing cannot bind');
  const node = value as object;
  if (types.isProxy(node)) fail('INVALID_CASES', label + ' contains a proxy');
  if (ancestors.includes(node)) fail('INVALID_CASES', label + ' is circular');
  const prototype: unknown = Object.getPrototypeOf(node);
  ancestors.push(node);
  if (Array.isArray(node)) {
    if (prototype !== Array.prototype) fail('INVALID_CASES', label + ' is an array with a non-standard prototype');
    if (Reflect.ownKeys(node).length !== node.length + 1) fail('INVALID_CASES', label + ' is a sparse array or carries extra properties');
    for (let index = 0; index < node.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(node, index);
      if (!descriptor || !('value' in descriptor)) fail('INVALID_CASES', label + '[' + index + '] is not a data element');
      assertPayload(descriptor.value, label + '[' + index + ']', ancestors);
    }
  } else {
    if (prototype !== Object.prototype && prototype !== null) fail('INVALID_CASES', label + ' contains a non-plain object');
    for (const key of Reflect.ownKeys(node)) {
      if (typeof key !== 'string') fail('INVALID_CASES', label + ' has a symbol key');
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !('value' in descriptor)) fail('INVALID_CASES', label + '.' + key + ' is an accessor and may change between reads');
      if (!descriptor.enumerable) fail('INVALID_CASES', label + '.' + key + ' is not enumerable, so hashing would not bind it');
      assertPayload(descriptor.value, label + '.' + key, ancestors);
    }
  }
  ancestors.pop();
}

function assertPolicy(performance: PerformancePolicy, champion: ChampionPolicy): void {
  if (!Number.isSafeInteger(performance.minSamplesForScore) || performance.minSamplesForScore < 1) {
    fail('INVALID_POLICY', 'performance minSamplesForScore must be a positive integer');
  }
  if (!Number.isFinite(performance.priorScore) || performance.priorScore < 0 || performance.priorScore > 1) {
    fail('INVALID_POLICY', 'performance priorScore must be within 0..1');
  }
  if (!Number.isFinite(performance.priorWeight) || performance.priorWeight < 0) {
    fail('INVALID_POLICY', 'performance priorWeight must be finite and non-negative');
  }
  if (!Number.isSafeInteger(champion.minSamplesToLeaveShadow) || champion.minSamplesToLeaveShadow < 1) {
    fail('INVALID_POLICY', 'shadow exit minimum samples must be a positive integer');
  }
  if (!Number.isFinite(champion.minScoreToLeaveShadow) || champion.minScoreToLeaveShadow < 0 || champion.minScoreToLeaveShadow > 1) {
    fail('INVALID_POLICY', 'shadow exit minimum score must be within 0..1');
  }
  if (!Number.isSafeInteger(champion.minSamplesForChampion) || champion.minSamplesForChampion < 1) {
    fail('INVALID_POLICY', 'champion minimum samples must be a positive integer');
  }
  if (!Number.isFinite(champion.minScoreMargin) || champion.minScoreMargin < 0 || champion.minScoreMargin > 1) {
    fail('INVALID_POLICY', 'champion score margin must be within 0..1');
  }
}

/** Two cases with the same decision, inputs and outcome are one piece of evidence, whatever their case ids. */
function evidenceKeyOf(asOf: string, domain: Domain, subtask: Subtask, modelInputFingerprint: string, outcomeFingerprint: string): string {
  return hashOf({ asOf, domain, subtask, modelInputFingerprint, outcomeFingerprint });
}

function canonicalCases(raw: readonly ShadowBenchmarkCase[]): Array<ShadowBenchmarkCase & { caseFingerprint: string; knownAt: string }> {
  if (!Array.isArray(raw) || raw.length === 0) fail('INVALID_CASES', 'at least one historical case is required');
  const seen = new Set<string>();
  const evidence = new Map<string, string>();
  const out: Array<ShadowBenchmarkCase & { caseFingerprint: string; knownAt: string }> = [];

  for (const one of raw) {
    if (!one || typeof one.caseId !== 'string' || one.caseId.trim() === '' || one.caseId !== one.caseId.trim()) {
      fail('INVALID_CASES', 'caseId must be a non-empty trimmed string');
    }
    if (seen.has(one.caseId)) fail('INVALID_CASES', 'duplicate caseId ' + one.caseId);
    seen.add(one.caseId);

    if (canonicalMs(one.asOf) === null) fail('INVALID_CASES', one.caseId + ' asOf must be a canonical UTC instant (ISO with milliseconds and Z)');
    if (!(DOMAINS as readonly string[]).includes(one.domain)) fail('INVALID_CASES', one.caseId + ' domain is invalid');
    if (!(SUBTASKS as readonly string[]).includes(one.subtask)) fail('INVALID_CASES', one.caseId + ' subtask is invalid');
    assertPayload(one.modelInput, one.caseId + ' modelInput', []);
    assertPayload(one.outcome, one.caseId + ' outcome', []);
    assertHash(one.modelInputFingerprint, 'INVALID_CASES', one.caseId + ' modelInputFingerprint');
    assertHash(one.outcomeFingerprint, 'INVALID_CASES', one.caseId + ' outcomeFingerprint');
    if (hashOf(one.modelInput) !== one.modelInputFingerprint) fail('INVALID_CASES', one.caseId + ' model input fingerprint does not match its payload');
    if (hashOf(one.outcome) !== one.outcomeFingerprint) fail('INVALID_CASES', one.caseId + ' outcome fingerprint does not match its payload');
    if (canonicalMs(one.outcome.knownAt) === null) fail('INVALID_CASES', one.caseId + ' outcome knownAt must be a canonical UTC instant');

    const key = evidenceKeyOf(one.asOf, one.domain, one.subtask, one.modelInputFingerprint, one.outcomeFingerprint);
    const prior = evidence.get(key);
    if (prior !== undefined) fail('INVALID_CASES', 'cases ' + prior + ' and ' + one.caseId + ' carry identical evidence; each historical case counts once');
    evidence.set(key, one.caseId);

    const knownAt = String(one.outcome.knownAt);
    const normalized: ShadowBenchmarkCase = {
      caseId: one.caseId,
      asOf: one.asOf,
      domain: one.domain,
      subtask: one.subtask,
      modelInput: structuredClone(one.modelInput),
      modelInputFingerprint: one.modelInputFingerprint,
      outcome: structuredClone(one.outcome),
      outcomeFingerprint: one.outcomeFingerprint,
    };
    const caseFingerprint = hashOf({
      caseId: normalized.caseId,
      asOf: normalized.asOf,
      domain: normalized.domain,
      subtask: normalized.subtask,
      modelInputFingerprint: normalized.modelInputFingerprint,
      outcomeFingerprint: normalized.outcomeFingerprint,
      knownAt,
    });
    out.push({ ...normalized, knownAt, caseFingerprint });
  }

  return out.sort((a, b) => compareCodeUnit(a.caseId, b.caseId));
}

function validateModelKey(key: string): void {
  if (
    typeof key !== 'string' ||
    key.trim() !== key ||
    CONTROL_OR_SPACE.test(key) ||
    key.split('/').length !== 2 ||
    key.startsWith('/') ||
    key.endsWith('/')
  ) {
    fail('INVALID_MODEL', 'modelKey must be provider/model');
  }
}

function normalizeOutput(raw: ShadowBenchmarkModelOutput, expectedModel: string, expectedCase: string): ShadowBenchmarkModelOutput {
  if (!raw || raw.modelKey !== expectedModel || raw.caseId !== expectedCase) {
    fail('INVALID_MODEL_OUTPUT', expectedCase + ' model output identity does not match request');
  }
  if (!RECOMMENDATIONS.has(raw.recommendation)) fail('INVALID_MODEL_OUTPUT', expectedCase + ' recommendation is invalid');
  if (!Number.isFinite(raw.confidenceScore) || raw.confidenceScore < 0 || raw.confidenceScore > 1) {
    fail('INVALID_MODEL_OUTPUT', expectedCase + ' confidenceScore must be within 0..1');
  }
  if (typeof raw.modelVersion !== 'string' || raw.modelVersion.trim() === '') fail('INVALID_MODEL_OUTPUT', expectedCase + ' modelVersion is required');
  assertHash(raw.evidenceFingerprint, 'INVALID_MODEL_OUTPUT', expectedCase + ' evidenceFingerprint');
  assertHash(raw.outputFingerprint, 'INVALID_MODEL_OUTPUT', expectedCase + ' outputFingerprint');
  if (raw.outputFingerprint !== outputFingerprintOf(raw)) {
    fail('INVALID_MODEL_OUTPUT', expectedCase + ' outputFingerprint does not bind the returned output fields');
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

function outputFingerprintOf(output: ShadowBenchmarkModelOutput): string {
  return hashOf({
    modelKey: output.modelKey,
    caseId: output.caseId,
    recommendation: output.recommendation,
    confidenceScore: output.confidenceScore,
    modelVersion: output.modelVersion,
    evidenceFingerprint: output.evidenceFingerprint,
  });
}

function scoringFingerprintOf(modelKey: string, caseId: string, score: number, outcomeFingerprint: string, outputFingerprint: string): string {
  return hashOf({ modelKey, caseId, score: String(score), outcomeFingerprint, outputFingerprint });
}

function normalizeScore(
  raw: Awaited<ReturnType<ShadowBenchmarkScorer['score']>>,
  expectedModel: string,
  expectedCase: string,
  outcomeFingerprint: string,
  outputFingerprint: string,
): { score: number; scoringFingerprint: string } {
  if (!raw || raw.modelKey !== expectedModel || raw.caseId !== expectedCase) fail('INVALID_SCORE', expectedCase + ' score identity does not match request');
  if (!Number.isFinite(raw.score) || raw.score < 0 || raw.score > 1) fail('INVALID_SCORE', expectedCase + ' score must be finite and within 0..1');
  assertHash(raw.scoringFingerprint, 'INVALID_SCORE', expectedCase + ' scoringFingerprint');
  if (raw.scoringFingerprint !== scoringFingerprintOf(raw.modelKey, raw.caseId, raw.score, outcomeFingerprint, outputFingerprint)) {
    fail('INVALID_SCORE', expectedCase + ' scoringFingerprint does not bind score, outcome and model output');
  }
  return { score: raw.score, scoringFingerprint: raw.scoringFingerprint };
}

/** One scored case as the statistics see it: its decision time, the outcome knowledge time and the score. */
interface CaseEvidence {
  caseId: string;
  asOf: string;
  domain: Domain;
  subtask: Subtask;
  knownAt: string;
  score: number;
}

/** A case's observation is usable only once both its decision and its outcome knowledge exist. */
function availabilityOf(asOf: string, knownAt: string): string {
  return new Date(Math.max(Date.parse(asOf), Date.parse(knownAt))).toISOString();
}

/**
 * The benchmark's own observation store. ModelPerformance reads it through `recall`, and it applies the rule NexusMemory applies: a record is visible
 * only from its availability. It is synchronous and in process, so a verifier and the benchmark run the same statistics code.
 */
function evidenceMemory(records: readonly { availableAt: string; observation: PerformanceObservation }[]): NexusMemory {
  const memory = {
    recall: (query: { subject: string; asOf: string }) =>
      records
        .filter((r) => r.observation.modelKey === query.subject && Date.parse(r.availableAt) <= Date.parse(query.asOf))
        .map((r) => ({ content: r.observation })),
  };
  return memory as unknown as NexusMemory;
}

interface EvidenceSummary {
  gateAsOf: string;
  sampleSize: number;
  meanScore: number;
  shrunkScore: number;
  gate: ShadowBenchmarkGate;
}

/** The sample, its statistics and the shadow-exit gate, all computed from the case evidence alone. Run and verification both use this function. */
function evidenceSummaryOf(
  modelKey: ModelKey,
  shadowMode: boolean,
  evidence: readonly CaseEvidence[],
  performancePolicy: PerformancePolicy,
  championPolicy: ChampionPolicy,
): EvidenceSummary {
  const records = evidence.map((one) => {
    const availableAt = availabilityOf(one.asOf, one.knownAt);
    return {
      availableAt,
      observation: {
        modelKey,
        domain: one.domain,
        subtask: one.subtask,
        role: 'analyst' as const,
        decisionId: one.caseId,
        score: one.score,
        shadow: shadowMode,
        occurredAt: one.asOf,
        availableAt,
      },
    };
  });
  const gateAsOf = records.map((r) => r.availableAt).reduce((latest, current) => (Date.parse(current) > Date.parse(latest) ? current : latest));
  const performance = new ModelPerformance(evidenceMemory(records), performancePolicy);
  const stats = performance.stats(modelKey, gateAsOf);
  const base = shadowExitGate(modelKey, performance, gateAsOf, championPolicy);
  return {
    gateAsOf,
    sampleSize: stats.sampleSize,
    meanScore: stats.mean ?? 0,
    shrunkScore: stats.shrunk,
    gate: { passed: base.passed, reasons: [...base.reasons], status: base.passed ? 'GATE_PASSED_HUMAN_REVIEW_REQUIRED' : 'GATE_FAILED' },
  };
}

/** The benchmark identity: everything a result states, computed the same way when it is produced and when it is verified. */
function benchmarkIdentityOf(result: Pick<ShadowModelBenchmarkResult, 'modelKey' | 'shadowModeAtBenchmark' | 'performancePolicy' | 'championPolicy' | 'gateAsOf' | 'caseSetFingerprint' | 'cases'>): string {
  return hashOf({
    engine: SHADOW_MODEL_BENCHMARK_VERSION,
    modelKey: result.modelKey,
    shadowModeAtBenchmark: result.shadowModeAtBenchmark,
    performancePolicy: result.performancePolicy,
    championPolicy: result.championPolicy,
    gateAsOf: result.gateAsOf,
    caseSetFingerprint: result.caseSetFingerprint,
    cases: result.cases.map((one) => ({
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
  });
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
  if (!registryEntry) fail('INVALID_MODEL', 'model is not registered: ' + request.modelKey);

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
      fail('INVALID_MODEL_OUTPUT', 'duplicate outputFingerprint ' + modelOutput.outputFingerprint);
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
      fail('INVALID_SCORE', 'duplicate scoringFingerprint ' + scoreResult.scoringFingerprint);
    }
    scores.add(scoreResult.scoringFingerprint);

    caseResults.push({
      caseId: one.caseId,
      asOf: one.asOf,
      domain: one.domain,
      subtask: one.subtask,
      modelInputFingerprint: one.modelInputFingerprint,
      outcomeFingerprint: one.outcomeFingerprint,
      knownAt: one.knownAt,
      caseFingerprint: one.caseFingerprint,
      modelOutput: structuredClone(frozenOutput),
      score: scoreResult.score,
      scoringFingerprint: scoreResult.scoringFingerprint,
    });
  }

  const summary = evidenceSummaryOf(
    request.modelKey,
    registryEntry.shadowMode,
    caseResults.map((one) => ({ caseId: one.caseId, asOf: one.asOf, domain: one.domain, subtask: one.subtask, knownAt: one.knownAt, score: one.score })),
    performancePolicy,
    championPolicy,
  );
  const partial = {
    modelKey: request.modelKey,
    shadowModeAtBenchmark: registryEntry.shadowMode,
    performancePolicy,
    championPolicy,
    gateAsOf: summary.gateAsOf,
    caseSetFingerprint,
    cases: caseResults,
  };
  const inputFingerprint = benchmarkIdentityOf(partial);

  const result: ShadowModelBenchmarkResult = {
    benchmarkRunId: 'smb_' + inputFingerprint.slice(0, 40),
    engineVersion: SHADOW_MODEL_BENCHMARK_VERSION,
    inputFingerprint,
    modelKey: request.modelKey,
    shadowModeAtBenchmark: registryEntry.shadowMode,
    sampleSize: summary.sampleSize,
    meanScore: summary.meanScore,
    shrunkScore: summary.shrunkScore,
    performancePolicy,
    championPolicy,
    caseSetFingerprint,
    gateAsOf: summary.gateAsOf,
    cases: caseResults,
    gate: summary.gate,
  };
  // A result the verifier would refuse is never returned.
  verifyShadowModelBenchmarkResult(result);
  return result;
}

/**
 * Recomputes every identity and derived value of a benchmark result from its own evidence: each case's fingerprints and scores, the case set, the
 * sample, the shrunk score, the gate and the benchmark identity. Any inconsistency throws INVALID_RESULT; nothing is repaired.
 */
export function verifyShadowModelBenchmarkResult(result: ShadowModelBenchmarkResult): void {
  const bad = (message: string): never => fail('INVALID_RESULT', message);
  if (!result || typeof result !== 'object') bad('result is missing');
  if (result.engineVersion !== SHADOW_MODEL_BENCHMARK_VERSION) bad('engine version is not ' + SHADOW_MODEL_BENCHMARK_VERSION);
  if (!isHash(result.inputFingerprint)) bad('inputFingerprint is not a 64-character hash');
  if (result.benchmarkRunId !== 'smb_' + result.inputFingerprint.slice(0, 40)) bad('benchmarkRunId does not match the input fingerprint');
  try {
    validateModelKey(result.modelKey);
  } catch {
    bad('modelKey is invalid');
  }
  if (typeof result.shadowModeAtBenchmark !== 'boolean') bad('shadowModeAtBenchmark must be a boolean');
  try {
    assertPolicy(result.performancePolicy, result.championPolicy);
  } catch (error) {
    bad((error as Error).message);
  }
  if (!Array.isArray(result.cases) || result.cases.length === 0) bad('a benchmark result has no cases');

  const evidence: CaseEvidence[] = [];
  const evidenceKeys = new Map<string, string>();
  const outputFingerprints = new Set<string>();
  const scoringFingerprints = new Set<string>();
  let previousCaseId: string | null = null;
  for (const one of result.cases) {
    if (!one || typeof one.caseId !== 'string' || one.caseId.trim() === '' || one.caseId !== one.caseId.trim()) bad('caseId must be a non-empty trimmed string');
    if (previousCaseId !== null && compareCodeUnit(one.caseId, previousCaseId) <= 0) bad('cases are not in canonical caseId order or repeat a caseId');
    previousCaseId = one.caseId;
    if (canonicalMs(one.asOf) === null) bad(one.caseId + ' asOf is not a canonical UTC instant');
    if (canonicalMs(one.knownAt) === null) bad(one.caseId + ' knownAt is not a canonical UTC instant');
    if (!(DOMAINS as readonly string[]).includes(one.domain)) bad(one.caseId + ' domain is invalid');
    if (!(SUBTASKS as readonly string[]).includes(one.subtask)) bad(one.caseId + ' subtask is invalid');
    if (!isHash(one.modelInputFingerprint) || !isHash(one.outcomeFingerprint) || !isHash(one.caseFingerprint) || !isHash(one.scoringFingerprint)) {
      bad(one.caseId + ' carries a fingerprint that is not a 64-character hash');
    }
    if (one.caseFingerprint !== hashOf({
      caseId: one.caseId,
      asOf: one.asOf,
      domain: one.domain,
      subtask: one.subtask,
      modelInputFingerprint: one.modelInputFingerprint,
      outcomeFingerprint: one.outcomeFingerprint,
      knownAt: one.knownAt,
    })) {
      bad(one.caseId + ' caseFingerprint does not bind its case fields');
    }
    const key = evidenceKeyOf(one.asOf, one.domain, one.subtask, one.modelInputFingerprint, one.outcomeFingerprint);
    const prior = evidenceKeys.get(key);
    if (prior !== undefined) bad('cases ' + prior + ' and ' + one.caseId + ' carry identical evidence');
    evidenceKeys.set(key, one.caseId);

    const output = one.modelOutput;
    if (!output || output.modelKey !== result.modelKey || output.caseId !== one.caseId) bad(one.caseId + ' model output identity does not match the case');
    if (!RECOMMENDATIONS.has(output.recommendation)) bad(one.caseId + ' recommendation is invalid');
    if (!Number.isFinite(output.confidenceScore) || output.confidenceScore < 0 || output.confidenceScore > 1) bad(one.caseId + ' confidenceScore must be within 0..1');
    if (typeof output.modelVersion !== 'string' || output.modelVersion.trim() === '') bad(one.caseId + ' modelVersion is required');
    if (!isHash(output.evidenceFingerprint) || !isHash(output.outputFingerprint)) bad(one.caseId + ' model output carries a fingerprint that is not a 64-character hash');
    if (output.outputFingerprint !== outputFingerprintOf(output)) bad(one.caseId + ' outputFingerprint does not bind the model output fields');
    if (outputFingerprints.has(output.outputFingerprint)) bad('duplicate outputFingerprint ' + output.outputFingerprint);
    outputFingerprints.add(output.outputFingerprint);

    if (!Number.isFinite(one.score) || one.score < 0 || one.score > 1) bad(one.caseId + ' score must be finite and within 0..1');
    if (one.scoringFingerprint !== scoringFingerprintOf(result.modelKey, one.caseId, one.score, one.outcomeFingerprint, output.outputFingerprint)) {
      bad(one.caseId + ' scoringFingerprint does not bind score, outcome and model output');
    }
    if (scoringFingerprints.has(one.scoringFingerprint)) bad('duplicate scoringFingerprint ' + one.scoringFingerprint);
    scoringFingerprints.add(one.scoringFingerprint);

    evidence.push({ caseId: one.caseId, asOf: one.asOf, domain: one.domain, subtask: one.subtask, knownAt: one.knownAt, score: one.score });
  }

  const caseSetFingerprint = hashOf(result.cases.map((one) => ({ caseId: one.caseId, caseFingerprint: one.caseFingerprint })));
  if (result.caseSetFingerprint !== caseSetFingerprint) bad('caseSetFingerprint does not match the cases');

  const derived = evidenceSummaryOf(result.modelKey, result.shadowModeAtBenchmark, evidence, result.performancePolicy, result.championPolicy);
  if (result.gateAsOf !== derived.gateAsOf) bad('gateAsOf is not the instant every observation is available');
  if (result.sampleSize !== derived.sampleSize) bad('sampleSize does not match the case evidence');
  if (result.meanScore !== derived.meanScore) bad('meanScore does not match the case evidence');
  if (result.shrunkScore !== derived.shrunkScore) bad('shrunkScore does not match the case evidence and the performance policy');
  if (
    result.gate.passed !== derived.gate.passed ||
    result.gate.status !== derived.gate.status ||
    JSON.stringify(result.gate.reasons) !== JSON.stringify(derived.gate.reasons)
  ) {
    bad('gate does not match the recomputed shadow-exit gate');
  }

  if (result.inputFingerprint !== benchmarkIdentityOf(result)) bad('inputFingerprint does not match the result contents');
}

export function compareShadowBenchmarks(
  results: readonly ShadowModelBenchmarkResult[],
): ShadowBenchmarkComparison {
  if (!Array.isArray(results) || results.length < 2) {
    throw new ShadowModelBenchmarkError('BENCHMARK_COMPARISON_MISMATCH', 'at least two benchmark results are required');
  }
  for (const result of results) verifyShadowModelBenchmarkResult(result);
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
