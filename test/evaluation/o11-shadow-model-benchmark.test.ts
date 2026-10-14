import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAMPION_POLICY, type ChampionPolicy } from '../../src/ai/champion-challenger.js';
import { DEFAULT_PERFORMANCE_POLICY, type PerformancePolicy } from '../../src/ai/model-performance.js';
import { ModelRegistry } from '../../src/ai/model-registry.js';
import { modelKey } from '../../src/ai/model-types.js';
import {
  SHADOW_MODEL_BENCHMARK_VERSION,
  ShadowModelBenchmarkError,
  compareShadowBenchmarks,
  runShadowModelBenchmark,
  verifyShadowModelBenchmarkResult,
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
      outputFingerprint: hashOf({
        modelKey: this.modelKey,
        caseId: input.caseId,
        recommendation: 'buy',
        confidenceScore: 0.7,
        modelVersion: 'fixture-v1',
        evidenceFingerprint: hashOf({ caseId: input.caseId, evidence: input.modelInputFingerprint }),
      }),
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
      scoringFingerprint: hashOf({
        modelKey: input.modelKey,
        caseId: input.caseId,
        score: String(score),
        outcomeFingerprint: input.outcomeFingerprint,
        outputFingerprint: input.modelOutput.outputFingerprint,
      }),
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
          scoringFingerprint: hashOf({
            modelKey: input.modelKey,
            caseId: input.caseId,
            score: '1',
            outcomeFingerprint: input.outcomeFingerprint,
            outputFingerprint: input.modelOutput.outputFingerprint,
          }),
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

  it('rejects a model output fingerprint that does not bind the returned output fields', async () => {
    const registry = await registryWith(MODEL);
    const forged = new FakeEvaluator(MODEL, (output) => ({ ...output, recommendation: 'sell' }));

    await expect(runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry }, forged, new FakeScorer())).rejects.toMatchObject({
      code: 'INVALID_MODEL_OUTPUT',
    } satisfies Partial<ShadowModelBenchmarkError>);
  });

  it('rejects a scoring fingerprint that does not bind the frozen output and outcome', async () => {
    const registry = await registryWith(MODEL);
    const scorer: ShadowBenchmarkScorer = {
      async score(input) {
        return {
          modelKey: input.modelKey,
          caseId: input.caseId,
          score: 0.8,
          scoringFingerprint: hashOf({ unrelated: true, caseId: input.caseId }),
        };
      },
    };

    await expect(runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry }, new FakeEvaluator(), scorer)).rejects.toMatchObject({
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

// ---------------------------------------------------------------------------
// Independent review (adversarial probes). Each probe names the review item it attacks. "guard" probes pin behaviour that
// already holds; the others fail on the implementation under review until the fix lands.
// ---------------------------------------------------------------------------

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof ShadowModelBenchmarkError ? error.code : 'UNCLASSIFIED: ' + String(error);
  }
}

async function codeOfAsync(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof ShadowModelBenchmarkError ? error.code : 'UNCLASSIFIED: ' + String(error);
  }
}

function withOutcome(one: ShadowBenchmarkCase, outcome: Record<string, unknown>): ShadowBenchmarkCase {
  return { ...one, outcome, outcomeFingerprint: hashOf(outcome) };
}

function withInput(one: ShadowBenchmarkCase, modelInput: Record<string, unknown>): ShadowBenchmarkCase {
  return { ...one, modelInput, modelInputFingerprint: hashOf(modelInput) };
}

const benchmark = (cs: ShadowBenchmarkCase[], registry: ModelRegistry, scoreValue = 0.8) =>
  runShadowModelBenchmark({ modelKey: MODEL, cases: cs, registry }, new FakeEvaluator(), new FakeScorer(scoreValue));

describe('O11 review — results are verified, not trusted (RED)', () => {
  it('A1 a result with a forged shrunkScore is refused by the comparison', async () => {
    const a = await benchmark(cases(3), await registryWith(MODEL), 0.4);
    const b = await runShadowModelBenchmark({ modelKey: MODEL_2, cases: cases(3), registry: await registryWith(MODEL_2) }, new FakeEvaluator(MODEL_2), new FakeScorer(0.6));
    expect(codeOf(() => compareShadowBenchmarks([{ ...a, shrunkScore: 0.99 }, b]))).toBe('INVALID_RESULT');
  });

  it('A2 two results forged to share a caseSetFingerprint but carry different case evidence are refused', async () => {
    const base = cases(3);
    const changed = base.map((c, i) => (i === 1 ? withOutcome(c, { ...c.outcome, returnBp: 1234 }) : c));
    const a = await benchmark(base, await registryWith(MODEL), 0.4);
    const b = await runShadowModelBenchmark({ modelKey: MODEL_2, cases: changed, registry: await registryWith(MODEL_2) }, new FakeEvaluator(MODEL_2), new FakeScorer(0.6));
    expect(b.caseSetFingerprint).not.toBe(a.caseSetFingerprint);
    expect(codeOf(() => compareShadowBenchmarks([a, { ...b, caseSetFingerprint: a.caseSetFingerprint }]))).toBe('INVALID_RESULT');
  });

  it('A3 a case score edited without re-issuing its scoring fingerprint fails verification', async () => {
    const a = await benchmark(cases(2), await registryWith(MODEL), 0.4);
    const tampered = structuredClone(a);
    tampered.cases[0]!.score = 0.1;
    expect(codeOf(() => verifyShadowModelBenchmarkResult(tampered))).toBe('INVALID_RESULT');
    expect(codeOf(() => verifyShadowModelBenchmarkResult(a))).toBe('NO_ERROR');
  });

  it('A4 forged derived fields (sampleSize, meanScore, gate) fail verification', async () => {
    const a = await benchmark(cases(3), await registryWith(MODEL), 0.4);
    expect(codeOf(() => verifyShadowModelBenchmarkResult({ ...a, sampleSize: 30 }))).toBe('INVALID_RESULT');
    expect(codeOf(() => verifyShadowModelBenchmarkResult({ ...a, meanScore: 0.99 }))).toBe('INVALID_RESULT');
    expect(codeOf(() => verifyShadowModelBenchmarkResult({ ...a, gate: { passed: true, reasons: [], status: 'GATE_PASSED_HUMAN_REVIEW_REQUIRED' } }))).toBe('INVALID_RESULT');
  });

  it('A5 a forged inputFingerprint fails verification', async () => {
    const a = await benchmark(cases(2), await registryWith(MODEL), 0.4);
    expect(codeOf(() => verifyShadowModelBenchmarkResult({ ...a, inputFingerprint: 'b'.repeat(64) }))).toBe('INVALID_RESULT');
  });
});

describe('O11 review — point-in-time availability (RED)', () => {
  it('B1 the gate is evaluated at the instant every counted observation is available (outcome knownAt is respected)', async () => {
    const result = await benchmark(cases(3), await registryWith(MODEL));
    expect((result as unknown as { gateAsOf?: string }).gateAsOf).toBe('2026-01-10T20:00:00.000Z');
  });

  it('B2 outcomes known before their decisions are available from the decision instant, not earlier', async () => {
    const cs = cases(2).map((c) => withOutcome(c, { ...c.outcome, knownAt: '2025-12-01T00:00:00.000Z' }));
    const result = await benchmark(cs, await registryWith(MODEL));
    expect((result as unknown as { gateAsOf?: string }).gateAsOf).toBe('2026-01-03T20:00:00.000Z');
  });
});

describe('O11 review — payloads must be exactly what their fingerprints bind (RED)', () => {
  it('C1 a Date inside modelInput is refused: its canonical hash would not bind the instant', async () => {
    const cs = cases(1);
    const input = { when: new Date('2026-01-01T00:00:00.000Z') };
    cs[0] = withInput(cs[0]!, input);
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });

  it('C2 a bigint inside modelInput is refused: it would hash like its string form', async () => {
    const cs = cases(1);
    cs[0] = withInput(cs[0]!, { n: 1n } as unknown as Record<string, unknown>);
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });

  it('C3 an undefined field is refused: the fingerprint drops it but the evaluator would still see it', async () => {
    const cs = cases(1);
    cs[0] = { ...cs[0]!, modelInput: { ...cs[0]!.modelInput, extra: undefined }, modelInputFingerprint: hashOf(cs[0]!.modelInput) };
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });

  it('C4 a getter whose value changes between reads is refused: the hashed value and the evaluated value would differ', async () => {
    let calls = 0;
    const cs = cases(1);
    cs[0] = { ...cs[0]!, modelInput: { get v() { calls += 1; return calls; } }, modelInputFingerprint: hashOf({ v: 1 }) };
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });

  it('C5 a function inside modelInput is refused: canonical hashing would give it the same text as any other function', async () => {
    const cs = cases(1);
    cs[0] = { ...cs[0]!, modelInput: { f: () => 2 }, modelInputFingerprint: hashOf({ f: () => 1 }) };
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });

  it('C6 a circular modelInput is refused with the benchmark error, not a stack overflow', async () => {
    const cs = cases(1);
    const input: Record<string, unknown> = {};
    input.self = input;
    cs[0] = { ...cs[0]!, modelInput: input, modelInputFingerprint: 'a'.repeat(64) };
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });

  it('C7 a Proxy inside modelInput is refused with the benchmark error, not a cloning error', async () => {
    const cs = cases(1);
    cs[0] = { ...cs[0]!, modelInput: new Proxy({ a: 1 }, {}), modelInputFingerprint: hashOf({ a: 1 }) };
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });

  it('C8 a class instance inside modelInput is refused: only plain JSON objects are accepted', async () => {
    class Box {
      a = 1;
    }
    const cs = cases(1);
    cs[0] = withInput(cs[0]!, new Box() as unknown as Record<string, unknown>);
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });

  it('C9 NaN inside modelInput is refused with the benchmark error', async () => {
    const cs = cases(1);
    cs[0] = { ...cs[0]!, modelInput: { x: Number.NaN }, modelInputFingerprint: 'b'.repeat(64) };
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });

  it('C10 an own __proto__ key stays data: the evaluator sees it as a property and no prototype is polluted (guard)', async () => {
    const input = JSON.parse('{"__proto__": {"x": 1}, "a": 2}') as Record<string, unknown>;
    const cs = cases(1);
    cs[0] = withInput(cs[0]!, input);
    const seen: ShadowBenchmarkModelRequest[] = [];
    const evaluator: ShadowBenchmarkEvaluator = {
      async evaluate(request) {
        seen.push(request);
        return new FakeEvaluator().evaluate(request);
      },
    };
    await runShadowModelBenchmark({ modelKey: MODEL, cases: cs, registry: await registryWith(MODEL) }, evaluator, new FakeScorer());
    expect(Object.getPrototypeOf(seen[0]!.modelInput)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(seen[0]!.modelInput, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('C11 an object with an inherited property is refused: the inherited value is outside the fingerprint', async () => {
    const input = Object.assign(Object.create({ secret: 1 }) as object, { a: 1 }) as Record<string, unknown>;
    const cs = cases(1);
    cs[0] = withInput(cs[0]!, input);
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });
});

describe('O11 review — duplicate content, historical time and outcome time (RED)', () => {
  it('D1 two cases with identical evidence under different case ids are refused: they would inflate the sample size', async () => {
    const cs = [oneCase('case-a', 0), oneCase('case-b', 0)];
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });

  it('D2 a non-ISO as-of such as "Jan 2 2026" is refused', async () => {
    const cs = [{ ...oneCase('case-001', 0), asOf: 'Jan 2 2026' }];
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });

  it('D3 a non-canonical as-of without milliseconds is refused: the same instant must have one identity', async () => {
    const cs = [{ ...oneCase('case-001', 0), asOf: '2026-01-02T20:00:00Z' }];
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });

  it('D4 an outcome without a knownAt time is refused: the outcome must say when it became known', async () => {
    const cs = [withOutcome(oneCase('case-001', 0), { returnBp: 500 })];
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });

  it('D5 a non-canonical knownAt such as "2026-01-10" is refused', async () => {
    const cs = [withOutcome(oneCase('case-001', 0), { returnBp: 500, knownAt: '2026-01-10' })];
    expect(await codeOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toBe('INVALID_CASES');
  });
});

describe('O11 review — model keys and policies (RED and guards)', () => {
  it('E1 a model key with an embedded control character is refused before any evaluator call', async () => {
    const registry = await ModelRegistry.open();
    await registry.register(
      { provider: 'google', model: 'shadow\tgemini', capabilities: ['structured_output'] },
      { at: T0, by: { kind: 'system', id: 'o11-test' }, reason: 'review probe' },
    );
    const key = 'google/shadow\tgemini';
    const evaluator = new FakeEvaluator(key);
    expect(await codeOfAsync(async () => runShadowModelBenchmark({ modelKey: key, cases: cases(1), registry }, evaluator, new FakeScorer()))).toBe('INVALID_MODEL');
    expect(evaluator.calls).toHaveLength(0);
  });

  it('E2 a registered model name containing a second slash is refused before any evaluator call (guard, documents the strict key rule)', async () => {
    const registry = await ModelRegistry.open();
    await registry.register(
      { provider: 'google', model: 'a/b', capabilities: ['structured_output'] },
      { at: T0, by: { kind: 'system', id: 'o11-test' }, reason: 'review probe' },
    );
    const evaluator = new FakeEvaluator('google/a/b');
    expect(await codeOfAsync(async () => runShadowModelBenchmark({ modelKey: 'google/a/b', cases: cases(1), registry }, evaluator, new FakeScorer()))).toBe('INVALID_MODEL');
    expect(evaluator.calls).toHaveLength(0);
  });

  it('H6 an out-of-range performance policy is reported with its own code, not as a case error', async () => {
    const registry = await registryWith(MODEL);
    expect(
      await codeOfAsync(async () =>
        runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry, performancePolicy: { minSamplesForScore: 20, priorScore: 2, priorWeight: 10 } }, new FakeEvaluator(), new FakeScorer()),
      ),
    ).toBe('INVALID_POLICY');
  });
});

describe('O11 review — frozen inputs, substitution and comparison (guards)', () => {
  it('F1 an evaluator that writes into its frozen input cannot change the benchmark identity', async () => {
    const baseline = await benchmark(cases(2), await registryWith(MODEL));
    const tampering: ShadowBenchmarkEvaluator = {
      async evaluate(input) {
        try {
          (input.modelInput as Record<string, unknown>).feature = 999;
        } catch {
          /* the frozen input refuses the write */
        }
        return new FakeEvaluator().evaluate(input);
      },
    };
    const result = await runShadowModelBenchmark({ modelKey: MODEL, cases: cases(2), registry: await registryWith(MODEL) }, tampering, new FakeScorer(0.8));
    expect(result.inputFingerprint).toBe(baseline.inputFingerprint);
  });

  it('F2 a scorer that writes into its frozen model output cannot change the benchmark identity', async () => {
    const baseline = await benchmark(cases(2), await registryWith(MODEL));
    const tampering: ShadowBenchmarkScorer = {
      async score(input) {
        try {
          (input.modelOutput as { confidenceScore: number }).confidenceScore = 0;
        } catch {
          /* the frozen output refuses the write */
        }
        return new FakeScorer(0.8).score(input);
      },
    };
    const result = await runShadowModelBenchmark({ modelKey: MODEL, cases: cases(2), registry: await registryWith(MODEL) }, new FakeEvaluator(), tampering);
    expect(result.inputFingerprint).toBe(baseline.inputFingerprint);
  });

  it('F3 a scorer that writes into its frozen outcome cannot change the benchmark identity', async () => {
    const baseline = await benchmark(cases(2), await registryWith(MODEL));
    const tampering: ShadowBenchmarkScorer = {
      async score(input) {
        try {
          (input.outcome as Record<string, unknown>).returnBp = 0;
        } catch {
          /* the frozen outcome refuses the write */
        }
        return new FakeScorer(0.8).score(input);
      },
    };
    const result = await runShadowModelBenchmark({ modelKey: MODEL, cases: cases(2), registry: await registryWith(MODEL) }, new FakeEvaluator(), tampering);
    expect(result.inputFingerprint).toBe(baseline.inputFingerprint);
  });

  it('G1 a scorer that returns another model key is refused', async () => {
    const scorer: ShadowBenchmarkScorer = {
      async score(input) {
        return { modelKey: MODEL_2, caseId: input.caseId, score: 0.5, scoringFingerprint: 'a'.repeat(64) };
      },
    };
    expect(await codeOfAsync(async () => runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry: await registryWith(MODEL) }, new FakeEvaluator(), scorer))).toBe('INVALID_SCORE');
  });

  it('G2 a scorer that returns another case id is refused', async () => {
    const scorer: ShadowBenchmarkScorer = {
      async score(input) {
        return { modelKey: input.modelKey, caseId: 'other-case', score: 0.5, scoringFingerprint: 'a'.repeat(64) };
      },
    };
    expect(await codeOfAsync(async () => runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry: await registryWith(MODEL) }, new FakeEvaluator(), scorer))).toBe('INVALID_SCORE');
  });

  it('G3 infinite and string scores are refused', async () => {
    expect(await codeOfAsync(async () => benchmark(cases(1), await registryWith(MODEL), Number.POSITIVE_INFINITY))).toBe('INVALID_SCORE');
    const stringScore: ShadowBenchmarkScorer = {
      async score(input) {
        return { modelKey: input.modelKey, caseId: input.caseId, score: '0.5' as unknown as number, scoringFingerprint: 'a'.repeat(64) };
      },
    };
    expect(await codeOfAsync(async () => runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry: await registryWith(MODEL) }, new FakeEvaluator(), stringScore))).toBe('INVALID_SCORE');
  });

  it('G4 a NaN confidence in the model output is refused', async () => {
    const nanConfidence = new FakeEvaluator(MODEL, (output) => ({ ...output, confidenceScore: Number.NaN }));
    expect(await codeOfAsync(async () => runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry: await registryWith(MODEL) }, nanConfidence, new FakeScorer()))).toBe('INVALID_MODEL_OUTPUT');
  });

  it('H1 comparing results with different performance policies is refused', async () => {
    const a = await benchmark(cases(3), await registryWith(MODEL), 0.4);
    const b = await runShadowModelBenchmark(
      { modelKey: MODEL_2, cases: cases(3), registry: await registryWith(MODEL_2), performancePolicy: { ...DEFAULT_PERFORMANCE_POLICY, priorWeight: 5 } },
      new FakeEvaluator(MODEL_2),
      new FakeScorer(0.6),
    );
    expect(codeOf(() => compareShadowBenchmarks([a, b]))).toBe('BENCHMARK_COMPARISON_MISMATCH');
  });

  it('H2 comparing results with different champion policies is refused', async () => {
    const a = await benchmark(cases(3), await registryWith(MODEL), 0.4);
    const b = await runShadowModelBenchmark(
      { modelKey: MODEL_2, cases: cases(3), registry: await registryWith(MODEL_2), championPolicy: { ...DEFAULT_CHAMPION_POLICY, minSamplesToLeaveShadow: 10 } },
      new FakeEvaluator(MODEL_2),
      new FakeScorer(0.6),
    );
    expect(codeOf(() => compareShadowBenchmarks([a, b]))).toBe('BENCHMARK_COMPARISON_MISMATCH');
  });

  it('H3 equal shrunk scores rank deterministically, independent of input order', async () => {
    const a = await benchmark(cases(3), await registryWith(MODEL), 0.7);
    const b = await runShadowModelBenchmark({ modelKey: MODEL_2, cases: cases(3), registry: await registryWith(MODEL_2) }, new FakeEvaluator(MODEL_2), new FakeScorer(0.7));
    expect(a.shrunkScore).toBe(b.shrunkScore);
    expect(compareShadowBenchmarks([a, b]).rankedModelKeys).toEqual(compareShadowBenchmarks([b, a]).rankedModelKeys);
    expect(compareShadowBenchmarks([a, b]).rankedModelKeys).toEqual([MODEL, MODEL_2]);
  });

  it('H4 the same model twice in one comparison is refused', async () => {
    const a = await benchmark(cases(3), await registryWith(MODEL), 0.4);
    expect(codeOf(() => compareShadowBenchmarks([a, a]))).toBe('BENCHMARK_COMPARISON_MISMATCH');
  });

  it('I1 a model that is already active is measured, reported as active, and never changed', async () => {
    const registry = await ModelRegistry.open();
    await registry.registerActive(
      { provider: 'google', model: 'shadow-gemini', capabilities: ['structured_output'] },
      { at: T0, by: { kind: 'human', id: 'luc' }, reason: 'bootstrap fixture' },
    );
    const before = registry.get(MODEL);
    const changesBefore = registry.changes();
    const result = await benchmark(cases(30), registry, 1);
    expect(result.shadowModeAtBenchmark).toBe(false);
    expect(result.gate.status).toBe('GATE_PASSED_HUMAN_REVIEW_REQUIRED');
    expect(registry.get(MODEL)).toEqual(before);
    expect(registry.changes()).toEqual(changesBefore);
  });
});

// Coverage of the individual validation branches (guards and tests that would catch each branch if it were removed).

function messageOf(run: () => unknown): string {
  try {
    run();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function messageOfAsync(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('O11 review — each validation branch is covered (guards)', () => {
  it('A6 a case field edited without re-issuing its caseFingerprint is refused', async () => {
    const tampered = structuredClone(await benchmark(cases(2), await registryWith(MODEL), 0.4));
    tampered.cases[0]!.asOf = '2026-01-05T20:00:00.000Z';
    expect(codeOf(() => verifyShadowModelBenchmarkResult(tampered))).toBe('INVALID_RESULT');
    expect(messageOf(() => verifyShadowModelBenchmarkResult(tampered))).toMatch(/caseFingerprint/);
  });

  it('A7 a model output edited without re-issuing its outputFingerprint is refused', async () => {
    const tampered = structuredClone(await benchmark(cases(2), await registryWith(MODEL), 0.4));
    tampered.cases[0]!.modelOutput.recommendation = 'sell';
    expect(messageOf(() => verifyShadowModelBenchmarkResult(tampered))).toMatch(/outputFingerprint/);
  });

  it('A8 a forged gateAsOf is refused', async () => {
    const a = await benchmark(cases(3), await registryWith(MODEL), 0.4);
    expect(messageOf(() => verifyShadowModelBenchmarkResult({ ...a, gateAsOf: '2026-02-01T00:00:00.000Z' }))).toMatch(/gateAsOf/);
  });

  it('A9 a forged benchmark run id and a forged engine version are refused', async () => {
    const a = await benchmark(cases(2), await registryWith(MODEL), 0.4);
    expect(messageOf(() => verifyShadowModelBenchmarkResult({ ...a, benchmarkRunId: 'smb_' + 'c'.repeat(40) }))).toMatch(/benchmarkRunId/);
    expect(messageOf(() => verifyShadowModelBenchmarkResult({ ...a, engineVersion: 'shadow-model-benchmark:v0' as typeof a.engineVersion }))).toMatch(/engine version/);
  });

  it('A10 a result without cases, or with cases out of canonical order, is refused', async () => {
    const a = await benchmark(cases(2), await registryWith(MODEL), 0.4);
    expect(codeOf(() => verifyShadowModelBenchmarkResult({ ...a, cases: [] }))).toBe('INVALID_RESULT');
    expect(messageOf(() => verifyShadowModelBenchmarkResult({ ...a, cases: [a.cases[1]!, a.cases[0]!] }))).toMatch(/canonical caseId order/);
  });

  it('C4b the getter refusal names the accessor, not a downstream check', async () => {
    let calls = 0;
    const cs = cases(1);
    cs[0] = { ...cs[0]!, modelInput: { get v() { calls += 1; return calls; } }, modelInputFingerprint: hashOf({ v: 1 }) };
    expect(await messageOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toMatch(/accessor/);
  });

  it('C12 a symbol-keyed property is refused: structured cloning would drop it', async () => {
    const cs = cases(1);
    cs[0] = withInput(cs[0]!, { a: 1, [Symbol('hidden')]: 2 } as unknown as Record<string, unknown>);
    cs[0] = { ...cs[0]!, modelInputFingerprint: hashOf({ a: 1 }) };
    expect(await messageOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toMatch(/symbol key/);
  });

  it('C13 a non-enumerable property is refused: canonical hashing would not bind it', async () => {
    const input = { a: 1 } as Record<string, unknown>;
    Object.defineProperty(input, 'hidden', { value: 1, enumerable: false });
    const cs = cases(1);
    cs[0] = { ...cs[0]!, modelInput: input, modelInputFingerprint: hashOf({ a: 1 }) };
    expect(await messageOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toMatch(/not enumerable/);
  });

  it('C14 a sparse array is refused', async () => {
    const cs = cases(1);
    const list = [1, , 3] as unknown[];
    cs[0] = { ...cs[0]!, modelInput: { list } as Record<string, unknown>, modelInputFingerprint: hashOf({ list: [1, null, 3] }) };
    expect(await messageOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toMatch(/sparse/);
  });

  it('C15 an array with a foreign prototype is refused', async () => {
    const list = [1, 2];
    Object.setPrototypeOf(list, {});
    const cs = cases(1);
    cs[0] = { ...cs[0]!, modelInput: { list } as Record<string, unknown>, modelInputFingerprint: hashOf({ list: [1, 2] }) };
    expect(await messageOfAsync(async () => benchmark(cs, await registryWith(MODEL)))).toMatch(/non-standard prototype/);
  });

  it('D6 blank and untrimmed case ids, unknown domains and unknown subtasks are refused', async () => {
    const registry = await registryWith(MODEL);
    const invalid = [
      { ...oneCase('case-001', 0), caseId: '  ' },
      { ...oneCase('case-001', 0), caseId: ' padded' },
      { ...oneCase('case-001', 0), domain: 'weather' as never },
      { ...oneCase('case-001', 0), subtask: 'vibes' as never },
    ];
    for (const one of invalid) {
      expect(await codeOfAsync(async () => benchmark([one], registry))).toBe('INVALID_CASES');
    }
  });

  it('F4 a frozen model input still reads back its original value after an attempted write', async () => {
    const observed: unknown[] = [];
    const evaluator: ShadowBenchmarkEvaluator = {
      async evaluate(input) {
        try {
          (input.modelInput as Record<string, unknown>).feature = 999;
        } catch {
          /* the frozen input refuses the write */
        }
        observed.push(input.modelInput.feature);
        return new FakeEvaluator().evaluate(input);
      },
    };
    await runShadowModelBenchmark({ modelKey: MODEL, cases: cases(2), registry: await registryWith(MODEL) }, evaluator, new FakeScorer());
    expect(observed).toEqual([0, 1]);
  });

  it('F5 a frozen outcome still reads back its original value after an attempted write', async () => {
    const observed: unknown[] = [];
    const scorer: ShadowBenchmarkScorer = {
      async score(input) {
        try {
          (input.outcome as Record<string, unknown>).returnBp = 0;
        } catch {
          /* the frozen outcome refuses the write */
        }
        observed.push(input.outcome.returnBp);
        return new FakeScorer(0.8).score(input);
      },
    };
    await runShadowModelBenchmark({ modelKey: MODEL, cases: cases(2), registry: await registryWith(MODEL) }, new FakeEvaluator(), scorer);
    expect(observed).toEqual([500, -300]);
  });

  it('G5 an invalid recommendation, a blank model version and a malformed evidence hash are refused', async () => {
    const registry = await registryWith(MODEL);
    const recommendation = new FakeEvaluator(MODEL, (output) => ({ ...output, recommendation: 'maybe' as never }));
    expect(await codeOfAsync(async () => runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry }, recommendation, new FakeScorer()))).toBe('INVALID_MODEL_OUTPUT');
    const blankVersion = new FakeEvaluator(MODEL, (output) => ({ ...output, modelVersion: ' ' }));
    expect(await codeOfAsync(async () => runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry }, blankVersion, new FakeScorer()))).toBe('INVALID_MODEL_OUTPUT');
    const shortEvidence = new FakeEvaluator(MODEL, (output) => ({ ...output, evidenceFingerprint: 'short' }));
    expect(await codeOfAsync(async () => runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry }, shortEvidence, new FakeScorer()))).toBe('INVALID_MODEL_OUTPUT');
  });

  it('H7 a comparison needs at least two results', async () => {
    const a = await benchmark(cases(3), await registryWith(MODEL), 0.4);
    expect(codeOf(() => compareShadowBenchmarks([a]))).toBe('BENCHMARK_COMPARISON_MISMATCH');
  });

  it('I2 every performance and champion policy bound is enforced with the policy code', async () => {
    const registry = await registryWith(MODEL);
    const invalid: Array<{ performancePolicy?: PerformancePolicy; championPolicy?: ChampionPolicy }> = [
      { performancePolicy: { minSamplesForScore: 0, priorScore: 0.5, priorWeight: 10 } },
      { performancePolicy: { minSamplesForScore: 20, priorScore: 0.5, priorWeight: -1 } },
      { performancePolicy: { minSamplesForScore: 20, priorScore: -0.1, priorWeight: 10 } },
      { championPolicy: { ...DEFAULT_CHAMPION_POLICY, minSamplesToLeaveShadow: 0 } },
      { championPolicy: { ...DEFAULT_CHAMPION_POLICY, minScoreToLeaveShadow: 1.5 } },
      { championPolicy: { ...DEFAULT_CHAMPION_POLICY, minSamplesForChampion: 0 } },
      { championPolicy: { ...DEFAULT_CHAMPION_POLICY, minScoreMargin: 2 } },
    ];
    for (const policy of invalid) {
      expect(await codeOfAsync(async () => runShadowModelBenchmark({ modelKey: MODEL, cases: cases(1), registry, ...policy }, new FakeEvaluator(), new FakeScorer()))).toBe('INVALID_POLICY');
    }
  });

  it('E3 model keys with leading, trailing or inner spaces, or with an empty side, are refused before any evaluator call', async () => {
    const registry = await registryWith(MODEL);
    for (const key of [' google/shadow-gemini', 'google/shadow-gemini ', '/shadow-gemini', 'google/', 'google/shadow gemini']) {
      const evaluator = new FakeEvaluator(key);
      expect(await codeOfAsync(async () => runShadowModelBenchmark({ modelKey: key, cases: cases(1), registry }, evaluator, new FakeScorer())), key).toBe('INVALID_MODEL');
      expect(evaluator.calls).toHaveLength(0);
    }
  });
});
