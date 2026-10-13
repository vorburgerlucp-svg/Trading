import { describe, expect, it } from 'vitest';
import {
  WALK_FORWARD_OOS_VERSION,
  WalkForwardOosError,
  runWalkForwardOos,
  type WalkForwardEvaluation,
  type WalkForwardEvaluator,
  type WalkForwardEvaluatorInput,
  type WalkForwardFoldSpec,
  type WalkForwardRequest,
  type WalkForwardVariant,
} from '../../src/evaluation/walk-forward-oos.js';
import type { HistoricalScannerReplayResult, HistoricalScannerReplayStep } from '../../src/scanner/historical-scanner-replay.js';

const TIMES = [
  '2026-01-01T20:00:00.000Z',
  '2026-01-02T20:00:00.000Z',
  '2026-01-03T20:00:00.000Z',
  '2026-01-04T20:00:00.000Z',
  '2026-01-05T20:00:00.000Z',
  '2026-01-06T20:00:00.000Z',
] as const;

function step(asOf: string, index: number, candidates: string[] = ['A']): HistoricalScannerReplayStep {
  const scannerFingerprint = String(index + 1).repeat(64).slice(0, 64);
  return {
    asOf,
    scannerRunId: 'scan_' + scannerFingerprint.slice(0, 40),
    scannerInputFingerprint: scannerFingerprint,
    universeFingerprint: String(index + 7).repeat(64).slice(0, 64),
    universeSnapshotRevisionId: 'u:' + index,
    quantRunIds: [{ instrumentId: 'A', quantRunId: 'quant_' + String(index + 3).repeat(40).slice(0, 40), storedThrough: 10 }],
    candidateInstrumentIds: candidates,
    rankingComplete: true,
  };
}

function replay(overrides: Partial<HistoricalScannerReplayResult> = {}): HistoricalScannerReplayResult {
  const fingerprint = 'a'.repeat(64);
  return {
    replayRunId: 'hsr_' + fingerprint.slice(0, 40),
    engineVersion: 'historical-scanner-replay:v1',
    inputFingerprint: fingerprint,
    replay: 'historical_research',
    definitionId: 'scanner',
    definitionVersion: '1',
    universeId: 'U',
    universeSourceId: 'fixture:u',
    universeStoredThrough: 1,
    marketStoredThroughByInstrument: { A: 10 },
    asOf: [...TIMES],
    steps: TIMES.map((at, i) => step(at, i)),
    ...overrides,
  };
}

const variants: WalkForwardVariant[] = [
  { variantId: 'alpha', definition: { threshold: 1 } },
  { variantId: 'beta', definition: { threshold: 2 } },
  { variantId: 'gamma', definition: { threshold: 3 } },
];

const fold: WalkForwardFoldSpec = {
  foldId: 'fold-1',
  train: { from: TIMES[0], through: TIMES[1] },
  validation: { from: TIMES[2], through: TIMES[3] },
  test: { from: TIMES[4], through: TIMES[5] },
};

function request(overrides: Partial<WalkForwardRequest> = {}): WalkForwardRequest {
  return {
    sourceReplay: replay(),
    variants,
    folds: [fold],
    minimumTrainingObjective: 0,
    ...overrides,
  };
}

class FakeEvaluator implements WalkForwardEvaluator {
  readonly calls: Array<{ variantId: string; foldId: string; phase: string; steps: string[] }> = [];

  constructor(
    private readonly values: Readonly<Record<string, number>> = {
      'fold-1|train|alpha': 1,
      'fold-1|train|beta': -1,
      'fold-1|train|gamma': 2,
      'fold-1|validation|alpha': 5,
      'fold-1|validation|gamma': 7,
      'fold-1|test|gamma': 9,
    },
    private readonly mutate?: (evaluation: WalkForwardEvaluation, input: WalkForwardEvaluatorInput) => WalkForwardEvaluation,
  ) {}

  async evaluate(input: WalkForwardEvaluatorInput): Promise<WalkForwardEvaluation> {
    this.calls.push({
      variantId: input.variant.variantId,
      foldId: input.foldId,
      phase: input.phase,
      steps: input.steps.map((s) => s.asOf),
    });
    const key = input.foldId + '|' + input.phase + '|' + input.variant.variantId;
    const value = this.values[key] ?? 0;
    const fingerprint = (input.variant.variantId + input.foldId + input.phase).split('').reduce((s, c) => s + c.charCodeAt(0).toString(16), '').padEnd(64, '0').slice(0, 64);
    const evaluation: WalkForwardEvaluation = {
      variantId: input.variant.variantId,
      foldId: input.foldId,
      phase: input.phase,
      stepFrom: input.steps[0]!.asOf,
      stepThrough: input.steps.at(-1)!.asOf,
      objectiveValue: value,
      evaluationFingerprint: fingerprint,
    };
    return this.mutate ? this.mutate(evaluation, input) : evaluation;
  }
}

describe('O10 walk-forward and out-of-sample evaluation — RED', () => {
  it('has an explicit engine identity', () => {
    expect(WALK_FORWARD_OOS_VERSION).toBe('walk-forward-oos:v1');
  });

  it('evaluates every variant on train, only eligible variants on validation, and only the winner on test', async () => {
    const evaluator = new FakeEvaluator();
    const result = await runWalkForwardOos(request(), evaluator);

    expect(evaluator.calls.map((c) => [c.phase, c.variantId])).toEqual([
      ['train', 'alpha'],
      ['train', 'beta'],
      ['train', 'gamma'],
      ['validation', 'alpha'],
      ['validation', 'gamma'],
      ['test', 'gamma'],
    ]);
    expect(result.foldResults[0]!.selectedVariantId).toBe('gamma');
    expect(result.foldResults[0]!.testEvaluation.variantId).toBe('gamma');
  });

  it('never passes future-phase steps to an evaluator call', async () => {
    const evaluator = new FakeEvaluator();
    await runWalkForwardOos(request(), evaluator);

    expect(evaluator.calls.find((c) => c.phase === 'train')!.steps).toEqual([TIMES[0], TIMES[1]]);
    expect(evaluator.calls.find((c) => c.phase === 'validation')!.steps).toEqual([TIMES[2], TIMES[3]]);
    expect(evaluator.calls.find((c) => c.phase === 'test')!.steps).toEqual([TIMES[4], TIMES[5]]);
  });

  it('changing only test-window replay content cannot change which variant is selected', async () => {
    const base = replay();
    const changedSteps = base.steps.map((s, i) => (i >= 4 ? { ...s, candidateInstrumentIds: [] } : s));
    const changed = replay({ steps: changedSteps });

    const a = await runWalkForwardOos(request({ sourceReplay: base }), new FakeEvaluator());
    const b = await runWalkForwardOos(request({ sourceReplay: changed }), new FakeEvaluator());

    expect(b.foldResults[0]!.selectedVariantId).toBe(a.foldResults[0]!.selectedVariantId);
    expect(b.foldResults[0]!.selectionEvidence).toEqual(a.foldResults[0]!.selectionEvidence);
  });

  it('training eligibility can exclude the validation winner before validation is run', async () => {
    const evaluator = new FakeEvaluator({
      'fold-1|train|alpha': 1,
      'fold-1|train|beta': 10,
      'fold-1|train|gamma': 2,
      'fold-1|validation|beta': 100,
      'fold-1|validation|gamma': 7,
      'fold-1|test|gamma': 9,
    });
    const result = await runWalkForwardOos(request({ minimumTrainingObjective: 2 }), evaluator);

    expect(evaluator.calls.filter((c) => c.phase === 'validation').map((c) => c.variantId)).toEqual(['beta', 'gamma']);
    expect(result.foldResults[0]!.selectedVariantId).toBe('beta');
  });

  it('fails closed on an exact validation tie instead of inventing a tie-breaker', async () => {
    const evaluator = new FakeEvaluator({
      'fold-1|train|alpha': 1,
      'fold-1|train|beta': 1,
      'fold-1|train|gamma': -1,
      'fold-1|validation|alpha': 5,
      'fold-1|validation|beta': 5,
    });

    await expect(runWalkForwardOos(request(), evaluator)).rejects.toMatchObject({
      code: 'WALK_FORWARD_SELECTION_AMBIGUOUS',
    } satisfies Partial<WalkForwardOosError>);
    expect(evaluator.calls.some((c) => c.phase === 'test')).toBe(false);
  });

  it('fails closed when no variant is training-eligible', async () => {
    const evaluator = new FakeEvaluator();
    await expect(runWalkForwardOos(request({ minimumTrainingObjective: 100 }), evaluator)).rejects.toMatchObject({
      code: 'NO_ELIGIBLE_VARIANT',
    } satisfies Partial<WalkForwardOosError>);
    expect(evaluator.calls.some((c) => c.phase !== 'train')).toBe(false);
  });

  it('rejects duplicate variants before any evaluator call', async () => {
    const evaluator = new FakeEvaluator();
    await expect(
      runWalkForwardOos(request({ variants: [variants[0]!, { ...variants[0]! }] }), evaluator),
    ).rejects.toMatchObject({ code: 'INVALID_VARIANTS' } satisfies Partial<WalkForwardOosError>);
    expect(evaluator.calls).toHaveLength(0);
  });

  it('rejects unknown, overlapping or reversed fold boundaries before any evaluator call', async () => {
    const bad: WalkForwardFoldSpec[] = [
      { ...fold, train: { from: '2025-12-31T20:00:00.000Z', through: TIMES[1] } },
      { ...fold, validation: { from: TIMES[1], through: TIMES[3] } },
      { ...fold, test: { from: TIMES[5], through: TIMES[4] } },
    ];
    for (const one of bad) {
      const evaluator = new FakeEvaluator();
      await expect(runWalkForwardOos(request({ folds: [one] }), evaluator)).rejects.toMatchObject({
        code: 'INVALID_FOLDS',
      } satisfies Partial<WalkForwardOosError>);
      expect(evaluator.calls).toHaveLength(0);
    }
  });

  it('rejects duplicate fold ids before evaluation', async () => {
    const evaluator = new FakeEvaluator();
    await expect(runWalkForwardOos(request({ folds: [fold, { ...fold }] }), evaluator)).rejects.toMatchObject({
      code: 'INVALID_FOLDS',
    } satisfies Partial<WalkForwardOosError>);
    expect(evaluator.calls).toHaveLength(0);
  });

  it('rejects non-finite objective values and evaluator metadata substitution', async () => {
    const nonFinite = new FakeEvaluator(
      { 'fold-1|train|alpha': Number.NaN },
    );
    await expect(runWalkForwardOos(request(), nonFinite)).rejects.toMatchObject({
      code: 'INVALID_EVALUATION',
    } satisfies Partial<WalkForwardOosError>);

    const wrongPhase = new FakeEvaluator(undefined, (evaluation) => ({ ...evaluation, phase: 'test' }));
    await expect(runWalkForwardOos(request(), wrongPhase)).rejects.toMatchObject({
      code: 'INVALID_EVALUATION',
    } satisfies Partial<WalkForwardOosError>);
  });

  it('normalizes variant input order without changing result identity or evaluation ordering', async () => {
    const a = await runWalkForwardOos(request({ variants: [variants[0]!, variants[1]!, variants[2]!] }), new FakeEvaluator());
    const b = await runWalkForwardOos(request({ variants: [variants[2]!, variants[0]!, variants[1]!] }), new FakeEvaluator());

    expect(b.variants.map((v) => v.variantId)).toEqual(['alpha', 'beta', 'gamma']);
    expect(b.foldResults).toEqual(a.foldResults);
    expect(b.inputFingerprint).toBe(a.inputFingerprint);
    expect(b.walkForwardRunId).toBe(a.walkForwardRunId);
  });

  it('aggregates only OOS test objectives', async () => {
    const fold2: WalkForwardFoldSpec = {
      foldId: 'fold-2',
      train: { from: TIMES[0], through: TIMES[0] },
      validation: { from: TIMES[1], through: TIMES[2] },
      test: { from: TIMES[3], through: TIMES[4] },
    };
    const evaluator = new FakeEvaluator({
      'fold-1|train|alpha': 1,
      'fold-1|train|beta': -1,
      'fold-1|train|gamma': -1,
      'fold-1|validation|alpha': 1000,
      'fold-1|test|alpha': 10,
      'fold-2|train|alpha': -1,
      'fold-2|train|beta': 1,
      'fold-2|train|gamma': -1,
      'fold-2|validation|beta': -1000,
      'fold-2|test|beta': 20,
    });
    const result = await runWalkForwardOos(request({ folds: [fold, fold2] }), evaluator);

    expect(result.oosSummary).toMatchObject({
      foldCount: 2,
      meanTestObjective: 15,
      medianTestObjective: 15,
      minimumTestObjective: 10,
      maximumTestObjective: 20,
      selectedVariantCounts: { alpha: 1, beta: 1 },
    });
  });

  it('changing the O9 source replay identity changes O10 identity', async () => {
    const first = await runWalkForwardOos(request(), new FakeEvaluator());
    const otherFingerprint = 'b'.repeat(64);
    const second = await runWalkForwardOos(
      request({
        sourceReplay: replay({
          inputFingerprint: otherFingerprint,
          replayRunId: 'hsr_' + otherFingerprint.slice(0, 40),
        }),
      }),
      new FakeEvaluator(),
    );

    expect(second.inputFingerprint).not.toBe(first.inputFingerprint);
    expect(second.walkForwardRunId).not.toBe(first.walkForwardRunId);
  });
});
