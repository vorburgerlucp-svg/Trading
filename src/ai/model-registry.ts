// Model Registry: which models exist, what they can do, how they measurably perform, and their
// runtime health. Governance rules:
//  - new models always start in SHADOW MODE (they analyse, but never influence decisions)
//  - anything that increases a model's influence (activation, enabling, bootstrap) needs a human
//  - domain scores are written only from measured outcomes (ModelPerformance), never by a model
//  - a model has no actor identity at all, so it cannot change its own rights

import { divRound } from '../money/decimal.js';
import type { Actor } from '../opportunities/opportunity-types.js';
import { modelKey, type Domain, type ModelCapability, type ModelKey, type Subtask } from './model-types.js';

export interface ModelCapabilityScore {
  domain: Domain;
  subtask?: Subtask;
  sampleSize: number;
  /** 0..1, measured from evaluated outcomes. */
  score: number;
  calibrationScore?: number;
  reliabilityScore?: number;
  updatedAt: string;
}

export interface ModelRegistryEntry {
  provider: string;
  model: string;
  enabled: boolean;
  shadowMode: boolean;
  capabilities: ModelCapability[];
  domainScores: ModelCapabilityScore[];
  latencyEmaMs?: number;
  /** Cost per analysis in CHF minor units (Rappen). */
  costEmaMinor?: bigint;
  /** EMA of failed calls (0..1). */
  failureRate?: number;
  lastEvaluatedAt?: string;
}

export interface ModelHealth {
  consecutiveFailures: number;
  lastFailureAt?: string;
  lastFailureKind?: string;
  lastSuccessAt?: string;
}

export interface RegistryChange {
  at: string;
  modelKey: ModelKey;
  change: 'registered_shadow' | 'registered_active' | 'activated' | 'enabled' | 'disabled' | 'returned_to_shadow';
  by: Actor;
  reason: string;
}

export class RegistryError extends Error {
  override readonly name = 'RegistryError';
}

export interface ModelRegistration {
  provider: string;
  model: string;
  capabilities: ModelCapability[];
  latencyEmaMs?: number;
  costEmaMinor?: bigint;
}

type ChangeInput = { at: string; by: Actor; reason: string };

const EMA_ALPHA = 0.2;

export class ModelRegistry {
  private readonly entries = new Map<ModelKey, ModelRegistryEntry>();
  private readonly healthByKey = new Map<ModelKey, ModelHealth>();
  private readonly changeLog: RegistryChange[] = [];

  /** Registers a new model in SHADOW MODE. */
  register(input: ModelRegistration, change: ChangeInput): ModelRegistryEntry {
    return this.add(input, true, 'registered_shadow', change);
  }

  /** Bootstrap of the initial council without shadow phase: explicit human decision only. */
  registerActive(input: ModelRegistration, change: ChangeInput): ModelRegistryEntry {
    requireHuman(change.by, 'register a model as active');
    return this.add(input, false, 'registered_active', change);
  }

  /** Leaves shadow mode after benchmarking. Requires a human and a passed benchmark gate. */
  activate(key: ModelKey, change: ChangeInput, gate: { passed: boolean; reasons: string[] }): ModelRegistryEntry {
    requireHuman(change.by, 'activate a model');
    if (!gate.passed) throw new RegistryError('benchmark gate not passed for ' + key + ': ' + gate.reasons.join('; '));
    return this.update(key, { shadowMode: false }, 'activated', change);
  }

  returnToShadow(key: ModelKey, change: ChangeInput): ModelRegistryEntry {
    return this.update(key, { shadowMode: true }, 'returned_to_shadow', change);
  }

  /** Enabling needs a human; disabling (a safety action) may also be done by the system. */
  setEnabled(key: ModelKey, enabled: boolean, change: ChangeInput): ModelRegistryEntry {
    if (enabled) requireHuman(change.by, 'enable a model');
    return this.update(key, { enabled }, enabled ? 'enabled' : 'disabled', change);
  }

  get(key: ModelKey): ModelRegistryEntry | undefined {
    const entry = this.entries.get(key);
    return entry ? structuredClone(entry) : undefined;
  }

  list(): ModelRegistryEntry[] {
    return [...this.entries.keys()].sort().map((k) => this.get(k) as ModelRegistryEntry);
  }

  health(key: ModelKey): ModelHealth {
    return { ...(this.healthByKey.get(key) ?? { consecutiveFailures: 0 }) };
  }

  changes(): readonly RegistryChange[] {
    return [...this.changeLog];
  }

  recordSuccess(key: ModelKey, sample: { at: string; latencyMs: number; costMinor?: bigint }): void {
    const entry = this.require(key);
    entry.latencyEmaMs = entry.latencyEmaMs === undefined ? sample.latencyMs : entry.latencyEmaMs + EMA_ALPHA * (sample.latencyMs - entry.latencyEmaMs);
    if (sample.costMinor !== undefined) {
      entry.costEmaMinor = entry.costEmaMinor === undefined ? sample.costMinor : entry.costEmaMinor + divRound(sample.costMinor - entry.costEmaMinor, 5n, 'half_even');
    }
    entry.failureRate = (entry.failureRate ?? 0) * (1 - EMA_ALPHA);
    this.healthByKey.set(key, { ...this.health(key), consecutiveFailures: 0, lastSuccessAt: sample.at });
  }

  recordFailure(key: ModelKey, failure: { at: string; kind: string }): void {
    const entry = this.require(key);
    entry.failureRate = (entry.failureRate ?? 0) * (1 - EMA_ALPHA) + EMA_ALPHA;
    const health = this.health(key);
    this.healthByKey.set(key, { ...health, consecutiveFailures: health.consecutiveFailures + 1, lastFailureAt: failure.at, lastFailureKind: failure.kind });
  }

  /** Written only by ModelPerformance from measured, published scores. */
  setDomainScores(key: ModelKey, scores: ModelCapabilityScore[], at: string): void {
    const entry = this.require(key);
    entry.domainScores = scores.map((s) => ({ ...s }));
    entry.lastEvaluatedAt = at;
  }

  private add(input: ModelRegistration, shadowMode: boolean, change: RegistryChange['change'], meta: ChangeInput): ModelRegistryEntry {
    const key = modelKey(input.provider, input.model);
    if (this.entries.has(key)) throw new RegistryError('model ' + key + ' is already registered');
    if (input.provider.trim() === '' || input.model.trim() === '' || input.provider.includes('/')) throw new RegistryError('invalid provider/model');
    const entry: ModelRegistryEntry = {
      provider: input.provider,
      model: input.model,
      enabled: true,
      shadowMode,
      capabilities: [...input.capabilities],
      domainScores: [],
      ...(input.latencyEmaMs !== undefined ? { latencyEmaMs: input.latencyEmaMs } : {}),
      ...(input.costEmaMinor !== undefined ? { costEmaMinor: input.costEmaMinor } : {}),
    };
    this.entries.set(key, entry);
    this.changeLog.push({ at: meta.at, modelKey: key, change, by: meta.by, reason: requireReason(meta.reason) });
    return this.get(key) as ModelRegistryEntry;
  }

  private update(key: ModelKey, patch: Partial<Pick<ModelRegistryEntry, 'enabled' | 'shadowMode'>>, change: RegistryChange['change'], meta: ChangeInput): ModelRegistryEntry {
    const entry = this.require(key);
    Object.assign(entry, patch);
    this.changeLog.push({ at: meta.at, modelKey: key, change, by: meta.by, reason: requireReason(meta.reason) });
    return this.get(key) as ModelRegistryEntry;
  }

  private require(key: ModelKey): ModelRegistryEntry {
    const entry = this.entries.get(key);
    if (!entry) throw new RegistryError('unknown model ' + key);
    return entry;
  }
}

function requireHuman(actor: Actor, action: string): void {
  if (actor.kind !== 'human') throw new RegistryError('only a human may ' + action);
}

function requireReason(reason: string): string {
  if (reason.trim() === '') throw new RegistryError('a registry change needs a reason');
  return reason;
}
