import { describe, expect, it } from 'vitest';
import { ChampionBoard } from '../../src/ai/champion-challenger.js';
import { NotConnectedAdapter, providerStatus } from '../../src/ai/model-adapter.js';
import { ModelPerformance } from '../../src/ai/model-performance.js';
import { ModelRegistry } from '../../src/ai/model-registry.js';
import { modelKey } from '../../src/ai/model-types.js';
import { NexusMemory } from '../../src/memory/nexus-memory.js';
import { chf } from '../../src/money/money.js';
import { AiRouter } from '../../src/nexus/ai-router.js';
import type { PlanStep } from '../../src/nexus/nexus-types.js';
import { decideDepth, planTask } from '../../src/nexus/task-planner.js';
import { T0 } from '../helpers.js';
import { CLAUDE, GEMINI, HUMAN, MODELS, OPENAI, opinion, ScriptedAdapter, task } from './fakes.js';

const analystStep = (models = 1, minDistinctProviders = 1): PlanStep => ({ id: 'analysts', role: 'analyst', subtask: 'technical_interpretation', models, minDistinctProviders, isolation: 'independent' });

async function routerSetup(options: { champions?: Record<string, string>; connected?: string[] } = {}) {
  const memory = await NexusMemory.open();
  const performance = new ModelPerformance(memory);
  const registry = new ModelRegistry();
  for (const m of Object.values(MODELS)) registry.registerActive(m, { at: T0, by: HUMAN, reason: 'test' });
  const connected = options.connected ?? [OPENAI, CLAUDE, GEMINI];
  const adapters = new Map(
    Object.values(MODELS).map((m) => {
      const key = modelKey(m.provider, m.model);
      return [key, connected.includes(key) ? new ScriptedAdapter(m.provider, m.model, () => opinion()) : new NotConnectedAdapter(m.provider, m.model)] as const;
    }),
  );
  const champions = new ChampionBoard(options.champions ?? {});
  return { router: new AiRouter(registry, performance, champions, adapters), registry, performance, memory, adapters };
}

describe('Planner: DecisionDepth', () => {
  it('5 CHF und geringe Unsicherheit → single', () => {
    expect(decideDepth(task({ capitalAtRiskMinor: chf(5), uncertainty: 'low' })).depth).toBe('single');
  });
  it('50\'000 CHF + hohe Unsicherheit + widersprüchliche Daten → critical_committee', () => {
    const { depth, reasons } = decideDepth(task({ capitalAtRiskMinor: chf(50_000), uncertainty: 'high', conflictingData: true }));
    expect(depth).toBe('critical_committee');
    expect(reasons.join(' ')).toMatch(/capital at risk/);
  });
  it('Tiefe wächst mit Kapital, Wichtigkeit, Unabhängigkeitsbedarf und Unsicherheit', () => {
    expect(decideDepth(task({ capitalAtRiskMinor: chf(150) })).depth).toBe('reviewed');
    expect(decideDepth(task({ capitalAtRiskMinor: chf(2000) })).depth).toBe('committee');
    expect(decideDepth(task({ importance: 'medium' })).depth).toBe('reviewed');
    expect(decideDepth(task({ requiresIndependentOpinions: true })).depth).toBe('committee');
    expect(decideDepth(task({ uncertainty: 'high' })).depth).toBe('reviewed');
  });
  it('Arbeitsteilung → sequenzielle Pipeline; Unabhängigkeit → parallel', () => {
    const sequential = planTask(task({ importance: 'medium', pipeline: ['discovery', 'news_sentiment', 'fundamental_analysis'] }));
    expect(sequential.mode).toBe('sequential');
    expect(sequential.steps.map((s) => [s.subtask, s.isolation])).toEqual([
      ['discovery', 'independent'],
      ['news_sentiment', 'sees_prior_steps'],
      ['fundamental_analysis', 'sees_prior_steps'],
      ['risk_review', 'sees_prior_steps'],
    ]);
    const parallel = planTask(task({ importance: 'high', pipeline: ['discovery'] }));
    expect(parallel.mode).toBe('parallel');
    expect(parallel.reasons.join(' ')).toMatch(/pipeline ignored/);
  });
});

describe('AiRouter', () => {
  it('nutzt Champion nur als Startpräferenz, solange er verfügbar ist', async () => {
    const { router } = await routerSetup({ champions: { equities: CLAUDE } });
    const d = router.route({ task: task(), step: analystStep(), asOf: T0, stakes: 'low' });
    expect(d.primaries.map((p) => p.modelKey)).toEqual([CLAUDE]);
    expect(d.primaries[0]?.champion).toBe(true);
  });

  it('nicht verbundene Modelle werden nie gewählt; Fallbacks stehen bereit', async () => {
    const { router, adapters } = await routerSetup({ connected: [OPENAI, GEMINI] });
    const d = router.route({ task: task({ importance: 'high' }), step: analystStep(2, 2), asOf: T0, stakes: 'high' });
    expect(d.primaries.map((p) => p.modelKey).sort()).toEqual([GEMINI, OPENAI].sort());
    expect(d.rejected.find((r) => r.modelKey === CLAUDE)?.reasons).toContain('adapter not connected');
    expect(providerStatus(adapters, ['openai', 'anthropic', 'google']).map((p) => p.status)).toEqual(['connected', 'not_connected', 'connected']);
  });

  it('meldet fehlende Unabhängigkeit statt sie vorzutäuschen', async () => {
    const { router } = await routerSetup({ connected: [GEMINI] });
    const d = router.route({ task: task(), step: analystStep(2, 2), asOf: T0, stakes: 'high' });
    expect(d.satisfied).toBe(false);
    expect(d.reasons[0]).toMatch(/only 1 of 2 required models/);
  });

  it('filtert nach Fähigkeiten, Latenz, Fehlern und Budget', async () => {
    const { router, registry } = await routerSetup();
    const vision = router.route({ task: task({ requiredCapabilities: ['vision'] }), step: analystStep(), asOf: T0, stakes: 'low' });
    expect(vision.primaries.map((p) => p.modelKey)).toEqual([GEMINI]);

    const fast = router.route({ task: task({ maximumLatencyMs: 800 }), step: analystStep(2, 1), asOf: T0, stakes: 'medium' });
    expect(fast.primaries.map((p) => p.modelKey)).toEqual([GEMINI]);
    expect(fast.rejected.find((r) => r.modelKey === CLAUDE)?.reasons[0]).toMatch(/latency 1200 ms above limit 800 ms/);

    for (let i = 0; i < 3; i++) registry.recordFailure(GEMINI, { at: T0, kind: 'failed' });
    const afterOutage = router.route({ task: task(), step: analystStep(), asOf: T0, stakes: 'low' });
    expect(afterOutage.primaries.map((p) => p.modelKey)).toEqual([OPENAI]);
    expect(afterOutage.rejected.find((r) => r.modelKey === GEMINI)?.reasons.join(' ')).toMatch(/circuit open/);

    // Gemini is circuit-open; OpenAI 0.20 + Claude 0.30 = 0.50 CHF.
    const enough = router.route({ task: task(), step: analystStep(2, 2), asOf: T0, stakes: 'high', remainingBudgetMinor: chf('0.50') });
    expect(enough.primaries.map((p) => p.modelKey).sort()).toEqual([CLAUDE, OPENAI].sort());
    expect(enough.satisfied).toBe(true);
    const tooSmall = router.route({ task: task(), step: analystStep(2, 2), asOf: T0, stakes: 'high', remainingBudgetMinor: chf('0.45') });
    expect(tooSmall.estimatedCostMinor).toBeLessThanOrEqual(chf('0.45'));
    expect(tooSmall.primaries).toHaveLength(1);
    expect(tooSmall.satisfied).toBe(false); // budget never silently reduces the required depth
  });

  it('gewichtet bei hohen Einsätzen Leistung statt Kosten', async () => {
    const { router, performance } = await routerSetup();
    for (let i = 0; i < 25; i++) {
      await performance.record('obs-' + i, {
        modelKey: CLAUDE,
        domain: 'equities',
        subtask: 'technical_interpretation',
        role: 'analyst',
        decisionId: 'd' + i,
        score: 0.9,
        shadow: false,
        occurredAt: '2026-09-01T00:00:00.000Z',
        availableAt: '2026-09-15T00:00:00.000Z',
      });
    }
    const cheap = router.route({ task: task(), step: analystStep(), asOf: T0, stakes: 'low' });
    const critical = router.route({ task: task(), step: analystStep(), asOf: T0, stakes: 'critical' });
    expect(cheap.primaries[0]?.modelKey).toBe(GEMINI);
    expect(critical.primaries[0]).toMatchObject({ modelKey: CLAUDE, measured: true });
  });
});
