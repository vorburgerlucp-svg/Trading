// R2 learning quarantine: outcome-eval:v2 observations are stored, but routing, published scores, the model registry, the
// champion-challenger and the shadow exit gate decide EXACTLY as without them. A positive control proves the test is sensitive:
// once a policy accepts v2, the same observations do change the routing.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChampionBoard, shadowExitGate } from '../../../src/ai/champion-challenger.js';
import { ModelPerformance, type PerformanceObservation, type PerformancePolicy, DEFAULT_PERFORMANCE_POLICY } from '../../../src/ai/model-performance.js';
import { ModelRegistry } from '../../../src/ai/model-registry.js';
import { modelKey } from '../../../src/ai/model-types.js';
import { NexusMemory } from '../../../src/memory/nexus-memory.js';
import { AiRouter } from '../../../src/nexus/ai-router.js';
import type { PlanStep } from '../../../src/nexus/nexus-types.js';
import { performanceObservationOfV2, recordQuarantinedV2 } from '../../../src/evaluation/v2/performance-v2.js';
import { evaluateDecisionFromLedger, evaluateDecisionV2 } from '../../../src/evaluation/v2/outcome-eval-v2.js';
import { TradePlanLedger, type SealedPlanRecord } from '../../../src/evaluation/v2/plan-ledger.js';
import { InMemoryAppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import { CLAUDE, GEMINI, HUMAN, MODELS, OPENAI, ScriptedAdapter, opinion, task } from '../../nexus/fakes.js';
import { AFTER, CAL, bars, plan } from './fixtures.js';

const T = '2026-10-01T08:00:00.000Z';
const AS_OF = '2026-12-01T00:00:00.000Z';
const step = (subtask: PlanStep['subtask'] = 'technical_interpretation', models = 2): PlanStep => ({ id: 'analysts', role: 'analyst', subtask, models, minDistinctProviders: 1, isolation: 'independent' });

function obs(model: string, i: number, score: number, scoringMethod?: string): PerformanceObservation {
  const day = String(1 + (i % 28)).padStart(2, '0');
  return { modelKey: model, domain: 'equities', subtask: 'technical_interpretation', role: 'analyst', decisionId: 'd-' + model + '-' + i + '-' + (scoringMethod ?? 'v1'), score, shadow: false, occurredAt: '2026-10-' + day + 'T10:00:00.000Z', availableAt: '2026-11-' + day + 'T10:00:00.000Z', ...(scoringMethod ? { scoringMethod } : {}) };
}

/** One NEXUS learning state: registry, performance, champions, router. v1 history is identical in every world. */
async function world(options: { v2: boolean; policy?: PerformancePolicy }) {
  const memory = await NexusMemory.open();
  const performance = new ModelPerformance(memory, options.policy ?? DEFAULT_PERFORMANCE_POLICY);
  const registry = await ModelRegistry.open();
  for (const m of Object.values(MODELS)) await registry.registerActive(m, { at: T, by: HUMAN, reason: 'test' });
  // v1 history: 60 observations each, OPENAI best.
  for (let i = 0; i < 60; i++) {
    await performance.record('v1-o-' + i, obs(OPENAI, i, 0.8));
    await performance.record('v1-c-' + i, obs(CLAUDE, i, 0.6));
    await performance.record('v1-g-' + i, obs(GEMINI, i, 0.4));
  }
  if (options.v2) {
    // v2 says the opposite, strongly and often: GEMINI perfect, OPENAI worthless.
    for (let i = 0; i < 80; i++) {
      await performance.record('v2-g-' + i, obs(GEMINI, i, 1, 'outcome-eval:v2'));
      await performance.record('v2-o-' + i, obs(OPENAI, i, 0, 'outcome-eval:v2'));
    }
  }
  const adapters = new Map(Object.values(MODELS).map((m) => [modelKey(m.provider, m.model), new ScriptedAdapter(m.provider, m.model, () => opinion())] as const));
  const champions = await ChampionBoard.open({ performance, initialChampions: { equities: CLAUDE } });
  return { performance, registry, champions, router: new AiRouter(registry, performance, champions, adapters) };
}

async function decisions(w: Awaited<ReturnType<typeof world>>) {
  const routes = [
    w.router.route({ task: task({ id: 't1' }), step: step(), asOf: AS_OF, stakes: 'low' }),
    w.router.route({ task: task({ id: 't2', importance: 'high' }), step: step('technical_interpretation', 3), asOf: AS_OF, stakes: 'high' }),
    w.router.route({ task: task({ id: 't3' }), step: { ...step(), role: 'critic', id: 'critic' }, asOf: AS_OF, stakes: 'medium' }),
  ];
  await w.performance.syncRegistry(w.registry, AS_OF);
  return {
    routes,
    published: [OPENAI, CLAUDE, GEMINI].map((k) => w.performance.published(k, 'equities', 'technical_interpretation', AS_OF)),
    stats: [OPENAI, CLAUDE, GEMINI].map((k) => w.performance.stats(k, AS_OF)),
    registry: w.registry.list().map((e) => ({ key: e.provider + '/' + e.model, scores: (e as unknown as { domainScores?: unknown }).domainScores ?? null })),
    // Everything the champion decision consists of; performancePosition is only the memory position the evaluation read at (it
    // differs with more stored records, also quarantined ones, and is compared separately below).
    champion: (({ performancePosition: _p, ...decision }) => decision)(w.champions.evaluate('equities', w.registry, AS_OF)),
    shadowGate: [OPENAI, CLAUDE, GEMINI].map((k) => shadowExitGate(k, w.performance, AS_OF)),
  };
}

describe('R2 learning quarantine', () => {
  it('with and without stored v2 evaluations, routing, scores, registry, champion and shadow gate decide exactly the same', async () => {
    const without = await decisions(await world({ v2: false }));
    const withV2World = await world({ v2: true });
    const withV2 = await decisions(withV2World);
    const plain = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() + 'n' : v)));
    expect(plain(withV2)).toEqual(plain(without));
    // The v2 observations exist and can be analysed, they just influence nothing.
    expect(withV2World.performance.quarantinedObservations(GEMINI, AS_OF)).toHaveLength(80);
    expect(withV2World.performance.observations(GEMINI, AS_OF)).toHaveLength(60);
    // The champion read a later memory position (the v2 records are stored), and still decided the same.
    expect(withV2World.champions.evaluate('equities', withV2World.registry, AS_OF).performancePosition).toBeGreaterThan(0);
  });

  it('positive control: a policy that ACCEPTS v2 lets the same observations change scores and routing', async () => {
    const accepting = { ...DEFAULT_PERFORMANCE_POLICY, acceptedScoringMethods: ['outcome-eval:v1', 'outcome-eval:v2'] };
    const quarantined = await decisions(await world({ v2: true }));
    const accepted = await decisions(await world({ v2: true, policy: accepting }));
    expect(accepted.stats[2]!.sampleSize).toBe(140);
    expect(accepted.published[2]!.score).toBeGreaterThan(quarantined.published[2]!.score);
    expect(accepted.routes[0]!.primaries.map((p) => p.modelKey)).not.toEqual(quarantined.routes[0]!.primaries.map((p) => p.modelKey));
  });

  it('an observation without a method label is v1 (all records written before R2 keep counting); a malformed label is refused', async () => {
    const performance = new ModelPerformance(await NexusMemory.open());
    await performance.record('legacy', obs(OPENAI, 1, 0.7));
    expect(performance.observations(OPENAI, AS_OF)).toHaveLength(1);
    await expect(performance.record('bad', obs(OPENAI, 2, 0.7, 'my-own-method'))).rejects.toThrow(/scoringMethod/);
  });

  it('a v2 evaluation becomes an observation only for an analyst and only when EVALUATED; recording it quarantines it', async () => {
    const ledger = await TradePlanLedger.open(new InMemoryAppendOnlyStore<SealedPlanRecord>(), { clock: () => new Date('2026-10-07T09:50:00.000Z') });
    await ledger.seal(plan({ origin: 'research' }));
    const evaluated = await evaluateDecisionFromLedger({ ledger, planId: 'plan-1', decision: { decisionId: 'dec-1', action: 'ENTER_LONG', positionContext: 'flat' }, bars: bars([['100', '101', '99', '100'], ['100', '111', '99', '109']]), calendar: CAL, evaluatedAt: AFTER });
    const attempt = { modelKey: OPENAI, role: 'analyst' as const, domain: 'equities' as const, subtask: 'technical_interpretation' as const, shadow: false, occurredAt: '2026-10-07T09:58:00.000Z' };
    const o = performanceObservationOfV2(evaluated, attempt)!;
    expect(o).toMatchObject({ scoringMethod: 'outcome-eval:v2', score: 1, availableAt: AFTER });
    expect(performanceObservationOfV2(evaluated, { ...attempt, role: 'critic' })).toBeNull();
    const notEvaluable = evaluateDecisionV2({ decision: { decisionId: 'dec-1', action: 'NO_ACTION', positionContext: 'flat' }, bars: [], calendar: CAL, evaluatedAt: AFTER });
    expect(performanceObservationOfV2(notEvaluable, attempt)).toBeNull();
    const performance = new ModelPerformance(await NexusMemory.open());
    await recordQuarantinedV2(performance, o);
    expect(performance.observations(OPENAI, AS_OF)).toEqual([]);
    expect(performance.quarantinedObservations(OPENAI, AS_OF)).toHaveLength(1);
    await expect(recordQuarantinedV2(performance, { ...o, scoringMethod: undefined })).rejects.toThrow(/only outcome-eval:v2/);
  });

  it('the executed code of the v2 modules reaches no router, champion, registry, calibration or decision code', () => {
    const root = resolve(__dirname, '..', '..', '..');
    const files = new Set<string>();
    const pending = ['src/evaluation/v2/outcome-eval-v2.ts', 'src/evaluation/v2/plan-ledger.ts', 'src/evaluation/v2/performance-v2.ts', 'src/evaluation/v2/evaluation-summary.ts'];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (files.has(file)) continue;
      files.add(file);
      const text = readFileSync(join(root, file), 'utf8');
      // Value imports only (type imports are erased and execute nothing).
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"](\.[^'"]+)['"]/g)) {
        pending.push(relative(root, resolve(root, dirname(file), m[1]!)).replace(/\\/g, '/').replace(/\.js$/, '.ts'));
      }
    }
    const forbidden = [...files].filter((f) => /ai-router|champion-challenger|model-registry|calibration|src\/nexus\/|src\/broker\/|src\/runtime\/|src\/capital\/(?!ledger-errors)/.test(f));
    expect(forbidden).toEqual([]);
  });
});

describe('R2 guard against the flawed v1 method in a future runtime', () => {
  it('runtime and research code never import the v1 evaluator, and any ModelPerformance they build names its accepted methods', () => {
    const root = resolve(__dirname, '..', '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(root, dir))) {
        const rel = dir + '/' + name;
        if (statSync(join(root, rel)).isDirectory()) walk(rel);
        else if (rel.endsWith('.ts')) files.push(rel);
      }
    };
    for (const dir of ['src/runtime', 'src/research']) {
      try {
        walk(dir);
      } catch {
        // the directory does not exist on this branch
      }
    }
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text, file).not.toMatch(/evaluation\/outcome-evaluator/);
      for (const m of text.matchAll(/new ModelPerformance\(([^;]*)\)/g)) expect(m[1], file).toMatch(/acceptedScoringMethods/);
    }
  });
});
