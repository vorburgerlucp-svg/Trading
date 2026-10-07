// TEST DOUBLES ONLY. Scripted model adapters and fixtures for NEXUS Brain tests.
// Nothing here is shipped or used outside tests; production providers are NotConnectedAdapter
// until real, credentialed adapters exist.

import { ChampionBoard } from '../../src/ai/champion-challenger.js';
import type { AdapterConnection, ModelAdapter, SpecialistRequest } from '../../src/ai/model-adapter.js';
import { ModelPerformance } from '../../src/ai/model-performance.js';
import { ModelRegistry, type ModelRegistration } from '../../src/ai/model-registry.js';
import { modelKey, type Domain, type ModelKey } from '../../src/ai/model-types.js';
import { SharedBlackboard } from '../../src/blackboard/shared-blackboard.js';
import { accounts } from '../../src/capital/accounts.js';
import type { AllocationPolicy } from '../../src/capital/capital-allocator.js';
import { EvidenceStore } from '../../src/evidence/evidence-store.js';
import type { EvidenceRef } from '../../src/evidence/evidence-types.js';
import { NexusMemory } from '../../src/memory/nexus-memory.js';
import { chf } from '../../src/money/money.js';
import { NexusBrain, readOnlyCapital, type DecisionRequest } from '../../src/nexus/nexus-brain.js';
import type { AiTask, QuantAssessment } from '../../src/nexus/nexus-types.js';
import { loadSafetyConfig, type SafetyConfig } from '../../src/nexus/safety.js';
import { createOpportunity } from '../../src/opportunities/opportunity-engine.js';
import { appleSwing } from '../fixtures/opportunities.js';
import { newEngine, policy, sequentialIds, T0 } from '../helpers.js';

export const HUMAN = { kind: 'human', id: 'luc' } as const;
export const SYSTEM = { kind: 'system', id: 'nexus' } as const;

type Behaviour = (request: SpecialistRequest) => unknown | Promise<unknown>;

/** Scripted model: returns whatever the test script says, records every request it received. */
export class ScriptedAdapter implements ModelAdapter {
  readonly requests: SpecialistRequest[] = [];
  constructor(
    readonly provider: string,
    readonly model: string,
    private readonly behaviour: Behaviour,
  ) {}
  connection(): AdapterConnection {
    return 'connected';
  }
  async run(request: SpecialistRequest): Promise<unknown> {
    this.requests.push(request);
    return this.behaviour(request);
  }
}

export function opinion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stance: 'bullish',
    recommendation: 'buy',
    confidence: 0.7,
    suggestedCapitalChf: null,
    claims: [{ category: 'hypothesis', statement: 'Trend intact above support', evidenceRefIds: [] }],
    riskFlags: [],
    modelVersion: 'test-double-1',
    ...overrides,
  };
}

/** Same scripted answer for every role, or role-specific answers. */
export function byRole(answers: { analyst?: unknown; counter_analyst?: unknown; critic?: unknown }): Behaviour {
  return (request) => {
    const answer = answers[request.role];
    if (answer === undefined) return opinion(request.role === 'analyst' ? {} : { stance: 'neutral', recommendation: 'hold', claims: [] });
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? (answer as Behaviour)(request) : answer;
  };
}

export const MODELS: Record<'openai' | 'anthropic' | 'google', ModelRegistration> = {
  openai: { provider: 'openai', model: 'test-gpt', capabilities: ['structured_output', 'reasoning', 'tool_use'], latencyEmaMs: 900, costEmaMinor: chf('0.20') },
  anthropic: { provider: 'anthropic', model: 'test-claude', capabilities: ['structured_output', 'reasoning', 'long_context'], latencyEmaMs: 1200, costEmaMinor: chf('0.30') },
  google: { provider: 'google', model: 'test-gemini', capabilities: ['structured_output', 'reasoning', 'vision', 'long_context'], latencyEmaMs: 700, costEmaMinor: chf('0.10') },
};
export const OPENAI = modelKey('openai', 'test-gpt');
export const CLAUDE = modelKey('anthropic', 'test-claude');
export const GEMINI = modelKey('google', 'test-gemini');

export const GENEROUS_ALLOCATION: AllocationPolicy = {
  maxDeploymentBpOfAvailable: 10_000,
  maxPerOpportunityChf: chf(1_000_000),
  maxPerOpportunityBpOfNetWorth: 10_000,
  maxBucketExposureBpOfNetWorth: { equities: 10_000, crypto: 10_000, physical_trade: 10_000, business: 10_000 },
  maxNewDownsideBpOfNetWorth: 10_000,
  minOpportunityScore: 0,
  minConfidenceScore: 0,
  maxRiskScore: 1,
  humanApproval: { thresholdChf: chf(10_000), thresholdBpOfNetWorth: 10_000 },
};

export function task(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: 'task-' + Math.random().toString(36).slice(2, 10),
    domain: 'equities',
    subtask: 'technical_interpretation',
    importance: 'low',
    capitalAtRiskMinor: chf(5),
    requiresIndependentOpinions: false,
    requiredCapabilities: ['reasoning'],
    contextRefs: [],
    ...overrides,
  };
}

export function evidenceRef(overrides: Partial<EvidenceRef> & { id: string }): EvidenceRef {
  return {
    type: 'market_price',
    source: 'test-fixture-feed',
    observedAt: '2026-10-01T07:59:00.000Z',
    availableAt: '2026-10-01T07:59:00.000Z',
    retrievedAt: '2026-10-01T07:59:30.000Z',
    freshnessMs: 15 * 60_000,
    trusted: true,
    contentKind: 'structured',
    ...overrides,
  };
}

export interface BrainSetup {
  adapters?: ModelAdapter[];
  /** Registered as active (human bootstrap). Default: all three test models. */
  active?: ModelRegistration[];
  shadow?: ModelRegistration[];
  champions?: Partial<Record<Domain, ModelKey>>;
  capitalChf?: string;
  safety?: SafetyConfig;
  allocation?: AllocationPolicy;
  modelTimeoutMs?: number;
}

export async function setupBrain(setup: BrainSetup = {}) {
  const { engine } = await newEngine(policy());
  await engine.deposit({ to: accounts.brokerCash('ibkr'), amountChf: chf(setup.capitalChf ?? '5000') });

  const clock = () => new Date(T0);
  const evidence = await EvidenceStore.open(undefined, { clock });
  const blackboard = await SharedBlackboard.open(evidence, undefined, { clock });
  const memory = await NexusMemory.open(undefined, { clock });
  const performance = new ModelPerformance(memory);
  const registry = new ModelRegistry();
  for (const m of setup.active ?? Object.values(MODELS)) registry.registerActive(m, { at: T0, by: HUMAN, reason: 'initial council (test)' });
  for (const m of setup.shadow ?? []) registry.register(m, { at: T0, by: SYSTEM, reason: 'new model (test)' });
  const champions = new ChampionBoard(setup.champions ?? {});
  const adapters = new Map((setup.adapters ?? []).map((a) => [modelKey(a.provider, a.model), a] as const));

  await evidence.register(evidenceRef({ id: 'price-aapl' }));
  await evidence.register(evidenceRef({ id: 'quant-aapl', type: 'quant_calculation', freshnessMs: undefined, source: 'nexus-quant (test)' }));

  const allocationPolicy = setup.allocation ?? GENEROUS_ALLOCATION;
  const brain = new NexusBrain({
    clock,
    newId: sequentialIds('n'),
    registry,
    performance,
    champions,
    adapters,
    evidence,
    blackboard,
    memory,
    capital: readOnlyCapital(engine),
    allocationPolicy,
    safety: setup.safety ?? loadSafetyConfig({ TRADING_MODE: 'paper', ALLOW_LIVE_TRADING: 'false' }),
    modelTimeoutMs: setup.modelTimeoutMs ?? 1_000,
  });
  return { brain, engine, evidence, blackboard, memory, performance, registry, champions, adapters, allocationPolicy };
}

export const apple = () => createOpportunity(appleSwing);

export const QUANT_CONFIRMS: QuantAssessment = { status: 'confirmed', direction: 'bullish', evidenceRefId: 'quant-aapl', summary: 'EMA20 > EMA50, RSI 58 (test fixture)' };

/** Standard trading question for AAPL as of T0, with fresh price and confirming quant. */
export function decisionRequest(t: AiTask, overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    task: t,
    question: 'Should NEXUS open the Apple swing trade described by the opportunity?',
    asOf: T0,
    evidenceIds: ['price-aapl', 'quant-aapl'],
    keyEvidenceIds: ['price-aapl'],
    opportunity: apple(),
    quant: QUANT_CONFIRMS,
    ...overrides,
  };
}
