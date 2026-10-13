import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAMPION_POLICY } from '../../src/ai/champion-challenger.js';
import { DEFAULT_PERFORMANCE_POLICY } from '../../src/ai/model-performance.js';
import { ModelRegistry } from '../../src/ai/model-registry.js';
import { modelKey } from '../../src/ai/model-types.js';
import {
  SHADOW_MODEL_BENCHMARK_VERSION,
  ShadowModelBenchmarkError,
  compareShadowBenchmarks,
  runShadowModelBenchmark,
  type ShadowBenchmarkCase,
  type ShadowBenchmarkEvaluator,
  type ShadowBenchmarkModelOutput,
  type ShadowBenchmarkModelRequest,
  type ShadowBenchmarkScoreRequest,
  type ShadowBenchmarkScorer,
} from '../../src/evaluation/shadow-model-benchmark.js';
import { hashOf } from '../../src/persistence/canonical-json.js';

const MODEL = modelKey('google', 'shadow-gemini');
const MODEL_2 = modelKey('openai', 'shadow-gpt');
const T0 = '2026-01-01T12:00:00.000Z';

async function registryWith(...keys: string[]): Promise<ModelRegistry> {
  const registry = await ModelRegistry.open();
  for (const key of keys) {
    const slash = key.indexOf('/');
    await registry.register(
      {
        provider: key.slice(0, slash),
        model: key.slice(slash + 1),
        capabilities: ['structured_output', 'reasoning'],
      },
      { at: T0, by: { kind: 'system', id: 'o11-test' }, reason: 'shadow benchmark fixture' },
    );
  }
  return registry;
}

function oneCase(id: string, index: number): ShadowBenchmarkCase {
  const modelInput = { symbol: 'SYM' + index, feature: index, informationKnownAt: '2025-12-31T20:00:00.000Z' };
  const outcome = { returnBp: index % 2 === 0 ? 500 : -300, knownAt: '2026-01-10T20:00:00.000Z' };
  return {
    caseId: id,
    asOf: new Date(Date.parse('2026-01-02T20:00:00.000Z') + index * 86_400_000).toISOString(),
    domain: 'equities',
    subtask: 'technical_interpretation',
    modelInput,
    modelInputFingerprint: hashOf(modelInput),
    outcome,
    outcomeFingerprint: hashOf(outcome),
  };
}

function cases(count: number): ShadowBenchmarkCase[] {
  return Array.from({ length: count }, (_, i) => oneCase('case-' + String(i + 1).padStart(3, '0'), i));
}

class FakeEvaluator implements ShadowBenchmarkEvaluator {
  readonly calls: ShadowBenchmarkModelRequest[] = [];

  constructor(
    private readonly modelKey = MODEL,
    private readonly mutate?: (output: ShadowBenchmarkModelOutput, input: ShadowBenchmarkModelRequest) => ShadowBenchmarkModelOutput,
  ) {}

  async evaluate(input: ShadowBenchmarkModelRequest): Promise<ShadowBenchmarkModelOutput> {
    this.calls.push(input);
    const output: ShadowBenchmarkModelOutput = {
      modelKey: this.modelKey,
      caseId: input.caseId,
      recommendation: 'buy',
      confidenceScore: 0.7,
      modelVersion: 'fixture-v1',
      evidenceFingerprint: hashOf({ caseId: input.caseId, evidence: input.modelInputFingerprint }),
      outputFingerprint: hashOf({ modelKey: this.modelKey, caseId: input.caseId, recommendation: 'buy', confidenceScore: 0.7, modelVersion: 'fixture-v1' }),
    };
    return this.mutate ? this.mutate(output, input) : output;
  }
}

class FakeScorer implements ShadowBenchmarkScorer {
  readonly calls: ShadowBenchmarkScoreRequest[] = [];

  constructor(private readonly scoreValue: number | ((input: ShadowBenchmarkScoreRequest) => number) = 0.8) {}

  async score(input: ShadowBenchmarkScoreRequest) {
    this.calls.push(input);
    const score = typeof this.scoreValue === 'function' ? this.scoreValue(input) : this.scoreValue;
    return {
      modelKey: input.modelKey,
      caseId: input.caseId,
      score,
      scoringFingerprint: hashOf({ modelKey: input.modelKey, caseId: input.caseId, score: String(score), outcomeFingerprint: input.outcomeFingerprint }),
    };
  }
}

describe('O11 shadow model benchmark — RED', () => {
  it('has an explicit benchmark engine identity', () => {
    expect(SHADOW_MODEL_BENCHMARK_VERSION).toBe('shadow-model-benchmark:v1');
  });

  it('evaluates every historical case exactly once and scores only after model output exists', async () => {
    const registry = await registryWith(MODEL);
    const evaluator = new FakeEvaluator();
    const scorer = new FakeScorer();
    const result = await runShadowModelBenchmark({ modelKey: MODEL, cases: cases(3), registry }, evaluator, scorer);

    expect(evaluator.calls.map((c) => c.caseId)).toEqual(['case-001', 'case-002', 'case-003']);
    expect(scorer.calls.map((c) => c.caseId)).toEqual(['case-001', 'case-002', 'case-003']);
    expect(result.sampleSize).toBe(3);
    expect(result.cases).toHaveLength(3);
  });

  it('never exposes realized outcome data to the model evaluator', async () => {
    const registry = await registryWith(MODEL);
    const evaluator: ShadowBenchmarkEvaluator = {
      async evaluate(input) {
        expect(Object.prototype.hasOwnProperty.call(input, 'outcome')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(input, 'outcomeFingerprint')).toBe(false);
        expect(Object.keys(input).sort()).toEqual([
          'asOf',
          'caseId',
          'domain',
          'modelInput',
          'modelInputFingerprint',
          'modelKey',
          'subtask',
        ]);
        return new FakeEvaluator().evaluate(input);
      },
    };

    await runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry }, evaluator, new FakeScorer());
  });

  it('passes the frozen model output to scoring only after evaluation', async () => {
    const registry = await registryWith(MODEL);
    const scorer: ShadowBenchmarkScorer = {
      async score(input) {
        expect(Object.isFrozen(input.modelOutput)).toBe(true);
        expect(input.modelOutput.caseId).toBe(input.caseId);
        return {
          modelKey: input.modelKey,
          caseId: input.caseId,
          score: 1,
          scoringFingerprint: hashOf({ frozen: true, caseId: input.caseId }),
        };
      },
    };

    await runShadowModelBenchmark({ modelKey: MODEL, cases: cases(2), registry }, new FakeEvaluator(), scorer);
  });

  it('normalizes case input order without changing result identity', async () => {
    const registryA = await registryWith(MODEL);
    const registryB = await registryWith(MODEL);
    const ordered = cases(3);
    const reversed = [...ordered].reverse();
    const a = await runShadowModelBenchmark({ modelKey: MODEL, cases: ordered, registry: registryA }, new FakeEvaluator(), new FakeScorer());
    const b = await runShadowModelBenchmark({ modelKey: MODEL, cases: reversed, registry: registryB }, new FakeEvaluator(), new FakeScorer());

    expect(b.cases.map((c) => c.caseId)).toEqual(['case-001', 'case-002', 'case-003']);
    expect(b.cases).toEqual(a.cases);
    expect(b.caseSetFingerprint).toBe(a.caseSetFingerprint);
    expect(b.inputFingerprint).toBe(a.inputFingerprint);
    expect(b.benchmarkRunId).toBe(a.benchmarkRunId);
  });

  it('rejects duplicate case ids before any evaluator call', async () => {
    const registry = await registryWith(MODEL);
    const evaluator = new FakeEvaluator();
    const duplicated = [oneCase('same', 0), oneCase('same', 1)];

    await expect(runShadowModelBenchmark({ modelKey: MODEL, cases: duplicated, registry }, evaluator, new FakeScorer())).rejects.toMatchObject({
      code: 'INVALID_CASES',
    } satisfies Partial<ShadowModelBenchmarkError>);
    expect(evaluator.calls).toHaveLength(0);
  });

  it('rejects an unknown model before any evaluator call', async () => {
    const registry = await registryWith();
    const evaluator = new FakeEvaluator();

    await expect(runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry }, evaluator, new FakeScorer())).rejects.toMatchObject({
      code: 'INVALID_MODEL',
    } satisfies Partial<ShadowModelBenchmarkError>);
    expect(evaluator.calls).toHaveLength(0);
  });

  it('rejects evaluator substitution of model or case identity', async () => {
    const registry = await registryWith(MODEL);
    const wrongModel = new FakeEvaluator(MODEL_2);
    await expect(runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry }, wrongModel, new FakeScorer())).rejects.toMatchObject({
      code: 'INVALID_MODEL_OUTPUT',
    } satisfies Partial<ShadowModelBenchmarkError>);

    const wrongCase = new FakeEvaluator(MODEL, (output) => ({ ...output, caseId: 'other-case' }));
    await expect(runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry }, wrongCase, new FakeScorer())).rejects.toMatchObject({
      code: 'INVALID_MODEL_OUTPUT',
    } satisfies Partial<ShadowModelBenchmarkError>);
  });

  it('rejects invalid confidence and score values', async () => {
    const registry = await registryWith(MODEL);
    const badConfidence = new FakeEvaluator(MODEL, (output) => ({ ...output, confidenceScore: 1.5 }));
    await expect(runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry }, badConfidence, new FakeScorer())).rejects.toMatchObject({
      code: 'INVALID_MODEL_OUTPUT',
    } satisfies Partial<ShadowModelBenchmarkError>);

    await expect(runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry }, new FakeEvaluator(), new FakeScorer(Number.NaN))).rejects.toMatchObject({
      code: 'INVALID_SCORE',
    } satisfies Partial<ShadowModelBenchmarkError>);
    await expect(runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry }, new FakeEvaluator(), new FakeScorer(1.01))).rejects.toMatchObject({
      code: 'INVALID_SCORE',
    } satisfies Partial<ShadowModelBenchmarkError>);
  });

  it('uses the existing performance shrinkage formula', async () => {
    const registry = await registryWith(MODEL);
    const result = await runShadowModelBenchmark(
      {
        modelKey: MODEL,
        cases: cases(20),
        registry,
        performancePolicy: DEFAULT_PERFORMANCE_POLICY,
      },
      new FakeEvaluator(),
      new FakeScorer(0.8),
    );

    expect(result.meanScore).toBeCloseTo(0.8, 12);
    expect(result.shrunkScore).toBeCloseTo((10 * 0.5 + 20 * 0.8) / 30, 12);
    expect(result.performancePolicy).toEqual(DEFAULT_PERFORMANCE_POLICY);
  });

  it('fails the shadow-exit gate below the minimum sample size', async () => {
    const registry = await registryWith(MODEL);
    const result = await runShadowModelBenchmark(
      { modelKey: MODEL, cases: cases(29), registry, championPolicy: DEFAULT_CHAMPION_POLICY },
      new FakeEvaluator(),
      new FakeScorer(1),
    );

    expect(result.gate.passed).toBe(false);
    expect(result.gate.status).toBe('GATE_FAILED');
    expect(result.gate.reasons.join(' ')).toMatch(/29 benchmark samples < 30/);
  });

  it('fails the shadow-exit gate below the minimum shrunk score', async () => {
    const registry = await registryWith(MODEL);
    const result = await runShadowModelBenchmark(
      { modelKey: MODEL, cases: cases(30), registry, championPolicy: DEFAULT_CHAMPION_POLICY },
      new FakeEvaluator(),
      new FakeScorer(0),
    );

    expect(result.gate.passed).toBe(false);
    expect(result.gate.reasons.join(' ')).toMatch(/benchmark score/);
  });

  it('can pass the gate but never activates or otherwise changes registry governance state', async () => {
    const registry = await registryWith(MODEL);
    const before = registry.get(MODEL)!;
    const changesBefore = registry.changes();
    const result = await runShadowModelBenchmark(
      { modelKey: MODEL, cases: cases(30), registry },
      new FakeEvaluator(),
      new FakeScorer(1),
    );

    expect(result.gate).toMatchObject({ passed: true, status: 'GATE_PASSED_HUMAN_REVIEW_REQUIRED' });
    expect(result.shadowModeAtBenchmark).toBe(true);
    expect(registry.get(MODEL)?.shadowMode).toBe(true);
    expect(registry.get(MODEL)).toEqual(before);
    expect(registry.changes()).toEqual(changesBefore);
  });

  it('repeating the same benchmark is deterministic', async () => {
    const a = await runShadowModelBenchmark({ modelKey: MODEL, cases: cases(4), registry: await registryWith(MODEL) }, new FakeEvaluator(), new FakeScorer(0.75));
    const b = await runShadowModelBenchmark({ modelKey: MODEL, cases: cases(4), registry: await registryWith(MODEL) }, new FakeEvaluator(), new FakeScorer(0.75));

    expect(b).toEqual(a);
  });

  it('changing one historical case changes benchmark identity', async () => {
    const baseCases = cases(2);
    const changed = baseCases.map((c) => ({ ...c }));
    const changedInput = { ...changed[1]!.modelInput, feature: 999 };
    changed[1] = { ...changed[1]!, modelInput: changedInput, modelInputFingerprint: hashOf(changedInput) };

    const a = await runShadowModelBenchmark({ modelKey: MODEL, cases: baseCases, registry: await registryWith(MODEL) }, new FakeEvaluator(), new FakeScorer());
    const b = await runShadowModelBenchmark({ modelKey: MODEL, cases: changed, registry: await registryWith(MODEL) }, new FakeEvaluator(), new FakeScorer());

    expect(b.caseSetFingerprint).not.toBe(a.caseSetFingerprint);
    expect(b.inputFingerprint).not.toBe(a.inputFingerprint);
    expect(b.benchmarkRunId).not.toBe(a.benchmarkRunId);
  });

  it('compares models only when the historical case set is identical', async () => {
    const c = cases(3);
    const a = await runShadowModelBenchmark({ modelKey: MODEL, cases: c, registry: await registryWith(MODEL) }, new FakeEvaluator(MODEL), new FakeScorer(0.7));
    const b = await runShadowModelBenchmark({ modelKey: MODEL_2, cases: c, registry: await registryWith(MODEL_2) }, new FakeEvaluator(MODEL_2), new FakeScorer(0.9));

    expect(compareShadowBenchmarks([a, b])).toEqual({
      caseSetFingerprint: a.caseSetFingerprint,
      rankedModelKeys: [MODEL_2, MODEL],
    });

    const other = await runShadowModelBenchmark({ modelKey: MODEL_2, cases: cases(2), registry: await registryWith(MODEL_2) }, new FakeEvaluator(MODEL_2), new FakeScorer(0.9));
    expect(() => compareShadowBenchmarks([a, other])).toThrow(ShadowModelBenchmarkError);
  });
});
