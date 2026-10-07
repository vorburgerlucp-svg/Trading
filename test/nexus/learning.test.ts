import { describe, expect, it } from 'vitest';
import { ChampionBoard, shadowExitGate } from '../../src/ai/champion-challenger.js';
import { ModelPerformance, type PerformanceObservation } from '../../src/ai/model-performance.js';
import { ModelRegistry } from '../../src/ai/model-registry.js';
import { evaluatePhysical, evaluateTrade, OutcomeEvaluator, scoreRecommendation, type TradeOutcome } from '../../src/evaluation/outcome-evaluator.js';
import { NexusMemory } from '../../src/memory/nexus-memory.js';
import { Decimal } from '../../src/money/decimal.js';
import { chf } from '../../src/money/money.js';
import type { DecisionTrace } from '../../src/nexus/nexus-types.js';
import { T0 } from '../helpers.js';
import { byRole, CLAUDE, decisionRequest, GEMINI, HUMAN, MODELS, OPENAI, opinion, ScriptedAdapter, setupBrain, SYSTEM, task } from './fakes.js';

const LATER = '2026-11-01T00:00:00.000Z';

async function learningSetup() {
  const memory = await NexusMemory.open();
  const performance = new ModelPerformance(memory);
  const registry = await ModelRegistry.open();
  await registry.registerActive(MODELS.openai, { at: T0, by: HUMAN, reason: 'initial council' });
  await registry.registerActive(MODELS.anthropic, { at: T0, by: HUMAN, reason: 'initial council' });
  const champions = await ChampionBoard.open({ performance, initialChampions: { macro: OPENAI } });
  let n = 0;
  const observe = async (key: string, score: number, count: number, availableAt = '2026-10-15T00:00:00.000Z') => {
    for (let i = 0; i < count; i++) {
      const o: PerformanceObservation = { modelKey: key, domain: 'macro', subtask: 'macro_analysis', role: 'analyst', decisionId: 'd' + n, score, shadow: false, occurredAt: '2026-10-01T00:00:00.000Z', availableAt };
      await performance.record('obs-' + n++, o);
    }
  };
  return { memory, performance, registry, champions, observe };
}

describe('Model Registry Governance', () => {
  it('neue Modelle starten im Shadow Mode; nur ein Mensch erweitert Rechte, und nur nach Benchmark', async () => {
    const { registry, performance, observe } = await learningSetup();
    const entry = await registry.register(MODELS.google, { at: T0, by: SYSTEM, reason: 'new model available' });
    expect(entry.shadowMode).toBe(true);

    await expect(registry.registerActive({ ...MODELS.google, model: 'other' }, { at: T0, by: SYSTEM, reason: 'self-promotion' })).rejects.toThrow(/only a human/);
    await expect(registry.activate(GEMINI, { at: T0, by: SYSTEM, reason: 'x' }, { passed: true, reasons: [] })).rejects.toThrow(/only a human/);
    await expect(registry.activate(GEMINI, { at: T0, by: HUMAN, reason: 'x' }, shadowExitGate(GEMINI, performance, LATER))).rejects.toThrow(/benchmark gate not passed/);

    await observe(GEMINI, 0.8, 30);
    const gate = shadowExitGate(GEMINI, performance, LATER);
    expect(gate.passed).toBe(true);
    expect((await registry.activate(GEMINI, { at: LATER, by: HUMAN, reason: 'benchmark passed' }, gate)).shadowMode).toBe(false);
    expect(registry.changes().map((c) => c.change)).toEqual(['registered_active', 'registered_active', 'registered_shadow', 'activated']);
  });

  it('Domain-Scores in der Registry ändern sich nur über gemessene Performance', async () => {
    const { registry } = await learningSetup();
    expect(registry.get(OPENAI)?.domainScores).toEqual([]);
    const copy = registry.get(OPENAI)!;
    copy.domainScores.push({ domain: 'macro', sampleSize: 999, score: 1, updatedAt: T0 });
    expect(registry.get(OPENAI)?.domainScores).toEqual([]); // returned entries are copies
  });
});

describe('Lernen: kontrolliert', () => {
  it('ein einzelnes Ergebnis ersetzt keinen Champion und publiziert keinen Score', async () => {
    const { registry, performance, champions, observe } = await learningSetup();
    await observe(CLAUDE, 1, 1);
    expect(performance.published(CLAUDE, 'macro', undefined, LATER)).toBeNull();
    await performance.syncRegistry(registry, LATER);
    expect(registry.get(CLAUDE)?.domainScores).toEqual([]);
    const decision = champions.evaluate('macro', registry, LATER);
    expect(decision.promote).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/1 samples < 50 required/);
    expect(champions.champion('macro')).toBe(OPENAI);
  });

  it('ausreichende Samples → Score wird angepasst; klarer Vorsprung → neuer Champion', async () => {
    const { registry, performance, champions, observe } = await learningSetup();
    await observe(OPENAI, 0.55, 60);
    await observe(CLAUDE, 0.75, 20);
    await performance.syncRegistry(registry, LATER);
    const claudeScore = registry.get(CLAUDE)?.domainScores.find((s) => s.domain === 'macro' && s.subtask === undefined);
    expect(claudeScore?.sampleSize).toBe(20);
    expect(claudeScore?.score).toBeCloseTo((10 * 0.5 + 20 * 0.75) / 30, 10); // shrunk toward the prior
    expect(champions.evaluate('macro', registry, LATER).promote).toBe(false); // 20 < 50 samples

    await observe(CLAUDE, 0.75, 40);
    const decision = champions.evaluate('macro', registry, LATER);
    expect(decision).toMatchObject({ promote: true, currentChampion: OPENAI, candidate: CLAUDE });
    await champions.apply(decision, SYSTEM);
    expect(champions.champion('macro')).toBe(CLAUDE);
    expect(champions.history()[0]).toMatchObject({ from: OPENAI, to: CLAUDE });
  });

  it('Lernen ist point-in-time: spätere Ergebnisse zählen nicht rückwirkend', async () => {
    const { performance, observe } = await learningSetup();
    await observe(CLAUDE, 0.9, 25, '2026-12-01T00:00:00.000Z');
    expect(performance.stats(CLAUDE, LATER).sampleSize).toBe(0);
    expect(performance.stats(CLAUDE, '2026-12-02T00:00:00.000Z').sampleSize).toBe(25);
  });
});

describe('OutcomeEvaluator', () => {
  const tradeOutcome = (decisionId: string, overrides: Partial<TradeOutcome> = {}): TradeOutcome => ({
    kind: 'trade',
    decisionId,
    instrumentId: 'AAPL',
    executed: false,
    entryPrice: Decimal.from('100'),
    exitPrice: Decimal.from('88'),
    stopLoss: Decimal.from('95'),
    takeProfit: Decimal.from('110'),
    highestPrice: Decimal.from('102'),
    lowestPrice: Decimal.from('85'),
    feesChf: chf(0),
    netResultChf: chf(0),
    openedAt: T0,
    closedAt: '2026-10-10T16:00:00.000Z',
    knownAt: '2026-10-10T16:05:00.000Z',
    ...overrides,
  });

  it('Claude BUY, OpenAI NO_TRADE, Ergebnis −12 % → OpenAI erhält Kredit, Claude nicht', async () => {
    const buyer = new ScriptedAdapter('anthropic', 'test-claude', byRole({ analyst: opinion() }));
    const skeptic = new ScriptedAdapter('openai', 'test-gpt', byRole({ analyst: opinion({ stance: 'bearish', recommendation: 'no_trade', riskFlags: [{ check: 'liquidity', severity: 'major', statement: 'Thin order book', evidenceRefIds: [] }] }) }));
    const critic = new ScriptedAdapter('google', 'test-gemini', byRole({}));
    const ctx = await setupBrain({ adapters: [buyer, skeptic, critic] });
    await ctx.registry.setEnabled(GEMINI, false, { at: T0, by: SYSTEM, reason: 'two-model committee for this test' });
    const d = await ctx.brain.decide(decisionRequest(task({ importance: 'high', domain: 'equities' })));
    expect(d.outcome).toBe('NO_ACTION');

    const evaluator = new OutcomeEvaluator(ctx.memory, ctx.performance);
    const record = ctx.brain.trace(d.decisionId) as DecisionTrace;
    const { evaluation, observations } = await evaluator.evaluate(record, tradeOutcome(d.decisionId));

    expect(evaluation).toMatchObject({ kind: 'trade', returnBp: -1200, maxAdverseExcursionBp: -1500, maxFavorableExcursionBp: 200, stop: 'hit', target: 'not_reached' });
    const score = (key: string) => observations.find((o) => o.modelKey === key && o.role === 'analyst')?.score;
    expect(score(OPENAI)).toBe(1);
    expect(score(CLAUDE)).toBe(0);
    expect(ctx.memory.recall({ kind: 'trade', subject: 'AAPL', asOf: '2026-10-11T00:00:00.000Z' })).toHaveLength(1);
    expect(ctx.memory.recall({ kind: 'trade', subject: 'AAPL', asOf: '2026-10-09T00:00:00.000Z' })).toHaveLength(0);
  });

  it('Ergebnis vor der Entscheidung wird abgelehnt (kein Look-ahead)', async () => {
    const ctx = await setupBrain({ adapters: [new ScriptedAdapter('google', 'test-gemini', byRole({}))], active: [MODELS.google] });
    const d = await ctx.brain.decide(decisionRequest(task()));
    const evaluator = new OutcomeEvaluator(ctx.memory, ctx.performance);
    await expect(evaluator.evaluate(ctx.brain.trace(d.decisionId) as DecisionTrace, tradeOutcome(d.decisionId, { knownAt: '2026-09-30T00:00:00.000Z' }))).rejects.toThrow(/look-ahead/);
  });

  it('Trading-Kennzahlen: Stop zu eng, wenn danach erholt', () => {
    const e = evaluateTrade(
      { ...tradeOutcome('x'), exitPrice: Decimal.from('108'), lowestPrice: Decimal.from('94'), highestPrice: Decimal.from('111') },
      'bullish',
    );
    expect(e).toMatchObject({ returnBp: 800, stop: 'hit_then_recovered', target: 'reached', directionCorrect: true });
    expect(scoreRecommendation('buy', 800)).toBe(1);
    expect(scoreRecommendation('no_trade', 20)).toBe(0.5);
  });

  it('physischer Handel: Preis-, Dauer- und Margenabweichung', () => {
    const e = evaluatePhysical({
      kind: 'physical',
      decisionId: 'd',
      productId: 'kaugummi',
      units: 4,
      predicted: { unitCostChf: chf(20), salePriceChf: chf(35), daysToSell: 7, netProfitPerUnitChf: chf(10) },
      actual: { unitCostChf: chf(20), averageSalePriceChf: chf(31), daysToSell: 12, feesChf: chf(20), returnsChf: chf(0), netProfitChf: chf(24), unitsSold: 4 },
      knownAt: LATER,
    });
    expect(e).toMatchObject({ returnBp: 3000, priceErrorBp: -1143, durationErrorDays: 5, capitalBindingDays: 12, sellThroughBp: 10_000 });
    expect(e.profitErrorChf).toBe(chf(-16));
  });
});
