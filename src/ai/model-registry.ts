// Model Registry: which models exist, what they can do, how they measurably perform, and their
// runtime health. Event-sourced: the state is derived from an append-only, hash-chained event log
// (governance + telemetry), never from mutable rows. Governance rules are checked on every event,
// including events loaded from storage, so a row written directly into the database cannot grant
// a model rights (it fails the replay → GOVERNANCE_INTEGRITY_ERROR, fail closed).
//
// Rules:
//  - new models always start in SHADOW MODE (they analyse, but never influence decisions)
//  - anything that increases a model's influence (active registration, activation, enabling) needs a human
//  - activation additionally needs a passed benchmark gate
//  - domain scores are written only from measured outcomes (ModelPerformance), never by a model
//  - a model has no actor identity at all, so it cannot change its own rights

import { randomUUID } from 'node:crypto';
import { divRound } from '../money/decimal.js';
import type { Actor } from '../opportunities/opportunity-types.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore, type AppendOnlyStore } from '../persistence/append-only-log.js';
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

export type GovernanceChange = 'registered_shadow' | 'registered_active' | 'activated' | 'enabled' | 'disabled' | 'returned_to_shadow';

export interface RegistryChange {
  at: string;
  modelKey: ModelKey;
  change: GovernanceChange;
  by: Actor;
  reason: string;
}

export type RegistryEvent =
  | {
      type: 'registered';
      eventId: string;
      at: string;
      modelKey: ModelKey;
      provider: string;
      model: string;
      capabilities: ModelCapability[];
      shadowMode: boolean;
      latencyEmaMs?: number;
      costEmaMinor?: bigint;
      by: Actor;
      reason: string;
    }
  | { type: 'activated'; eventId: string; at: string; modelKey: ModelKey; by: Actor; reason: string; gate: { passed: boolean; reasons: string[] } }
  | { type: 'enabled' | 'disabled' | 'returned_to_shadow'; eventId: string; at: string; modelKey: ModelKey; by: Actor; reason: string }
  | { type: 'call_succeeded'; eventId: string; at: string; modelKey: ModelKey; latencyMs: number; costMinor?: bigint }
  | { type: 'call_failed'; eventId: string; at: string; modelKey: ModelKey; kind: string }
  | { type: 'scores_published'; eventId: string; at: string; modelKey: ModelKey; scores: ModelCapabilityScore[] };

export class RegistryError extends Error {
  override readonly name = 'RegistryError';
}

export class GovernanceIntegrityError extends Error {
  override readonly name = 'GovernanceIntegrityError';
  readonly code = 'GOVERNANCE_INTEGRITY_ERROR' as const;
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
  private log!: AppendOnlyLog<RegistryEvent>;

  private constructor(private readonly newId: () => string) {}

  static async open(
    store: AppendOnlyStore<RegistryEvent> = new InMemoryAppendOnlyStore(),
    options: { clock?: () => Date; newId?: () => string } = {},
  ): Promise<ModelRegistry> {
    const registry = new ModelRegistry(options.newId ?? randomUUID);
    try {
      registry.log = await AppendOnlyLog.open<RegistryEvent>('model-registry', store, {
        ...(options.clock ? { clock: options.clock } : {}),
        onApply: (record) => registry.applyEvent(record.payload),
      });
    } catch (error) {
      if (error instanceof RegistryError) throw new GovernanceIntegrityError('model registry history violates governance rules: ' + error.message);
      throw error;
    }
    return registry;
  }

  /** Registers a new model in SHADOW MODE. */
  register(input: ModelRegistration, change: ChangeInput): Promise<ModelRegistryEntry> {
    return this.registration(input, true, change);
  }

  /** Bootstrap of the initial council without shadow phase: explicit human decision only. */
  registerActive(input: ModelRegistration, change: ChangeInput): Promise<ModelRegistryEntry> {
    return this.registration(input, false, change);
  }

  /** Leaves shadow mode after benchmarking. Requires a human and a passed benchmark gate. */
  async activate(key: ModelKey, change: ChangeInput, gate: { passed: boolean; reasons: string[] }): Promise<ModelRegistryEntry> {
    await this.emit({ type: 'activated', eventId: this.newId(), at: change.at, modelKey: key, by: change.by, reason: change.reason, gate: { passed: gate.passed, reasons: [...gate.reasons] } });
    return this.require(key, true);
  }

  async returnToShadow(key: ModelKey, change: ChangeInput): Promise<ModelRegistryEntry> {
    await this.emit({ type: 'returned_to_shadow', eventId: this.newId(), at: change.at, modelKey: key, by: change.by, reason: change.reason });
    return this.require(key, true);
  }

  /** Enabling needs a human; disabling (a safety action) may also be done by the system. */
  async setEnabled(key: ModelKey, enabled: boolean, change: ChangeInput): Promise<ModelRegistryEntry> {
    await this.emit({ type: enabled ? 'enabled' : 'disabled', eventId: this.newId(), at: change.at, modelKey: key, by: change.by, reason: change.reason });
    return this.require(key, true);
  }

  recordSuccess(key: ModelKey, sample: { at: string; latencyMs: number; costMinor?: bigint }): Promise<void> {
    return this.emit({ type: 'call_succeeded', eventId: this.newId(), at: sample.at, modelKey: key, latencyMs: sample.latencyMs, ...(sample.costMinor !== undefined ? { costMinor: sample.costMinor } : {}) });
  }

  recordFailure(key: ModelKey, failure: { at: string; kind: string }): Promise<void> {
    return this.emit({ type: 'call_failed', eventId: this.newId(), at: failure.at, modelKey: key, kind: failure.kind });
  }

  /** Written only by ModelPerformance from measured, published scores. */
  setDomainScores(key: ModelKey, scores: ModelCapabilityScore[], at: string): Promise<void> {
    return this.emit({ type: 'scores_published', eventId: this.newId(), at, modelKey: key, scores: scores.map((s) => ({ ...s })) });
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

  /** Catches up with events written by other NEXUS processes. */
  async sync(): Promise<void> {
    try {
      await this.log.sync();
    } catch (error) {
      throw this.classify(error);
    }
  }

  verifyIntegrity() {
    return this.log.verifyIntegrity();
  }

  private async registration(input: ModelRegistration, shadowMode: boolean, change: ChangeInput): Promise<ModelRegistryEntry> {
    const key = modelKey(input.provider, input.model);
    await this.emit({
      type: 'registered',
      eventId: this.newId(),
      at: change.at,
      modelKey: key,
      provider: input.provider,
      model: input.model,
      capabilities: [...input.capabilities],
      shadowMode,
      ...(input.latencyEmaMs !== undefined ? { latencyEmaMs: input.latencyEmaMs } : {}),
      ...(input.costEmaMinor !== undefined ? { costEmaMinor: input.costEmaMinor } : {}),
      by: change.by,
      reason: change.reason,
    });
    return this.require(key, true);
  }

  /**
   * Validates inside the log's critical section (after catching up with other processes), then appends;
   * the projection updates via onApply. A rule violation writes nothing.
   */
  private async emit(event: RegistryEvent): Promise<void> {
    try {
      await this.log.append(event.eventId, event, { precondition: () => this.validate(event) });
    } catch (error) {
      throw this.classify(error);
    }
  }

  /** A stored event that breaks governance rules (seen while catching up) is an integrity failure, not a validation error. */
  private classify(error: unknown): unknown {
    if (error instanceof RegistryError && this.log.corrupted) return new GovernanceIntegrityError('model registry history violates governance rules: ' + error.message);
    return error;
  }

  /** Governance rules. Used for new events AND for every replayed event. */
  private validate(event: RegistryEvent): void {
    const exists = this.entries.get(event.modelKey);
    const human = (action: string) => {
      if (!('by' in event) || event.by.kind !== 'human') throw new RegistryError('only a human may ' + action);
    };
    const reason = () => {
      if ('reason' in event && event.reason.trim() === '') throw new RegistryError('a registry change needs a reason');
    };
    if (Number.isNaN(Date.parse(event.at))) throw new RegistryError('event time must be ISO');
    switch (event.type) {
      case 'registered':
        if (exists) throw new RegistryError('model ' + event.modelKey + ' is already registered');
        if (event.provider.trim() === '' || event.model.trim() === '' || event.provider.includes('/')) throw new RegistryError('invalid provider/model');
        if (event.modelKey !== modelKey(event.provider, event.model)) throw new RegistryError('model key mismatch');
        if (!event.shadowMode) human('register a model as active');
        reason();
        return;
      case 'activated':
        if (!exists) throw new RegistryError('unknown model ' + event.modelKey);
        human('activate a model');
        if (!event.gate.passed) throw new RegistryError('benchmark gate not passed for ' + event.modelKey + ': ' + event.gate.reasons.join('; '));
        reason();
        return;
      case 'enabled':
        if (!exists) throw new RegistryError('unknown model ' + event.modelKey);
        human('enable a model');
        reason();
        return;
      case 'disabled':
      case 'returned_to_shadow':
        if (!exists) throw new RegistryError('unknown model ' + event.modelKey);
        reason();
        return;
      case 'call_succeeded':
      case 'call_failed':
        if (!exists) throw new RegistryError('unknown model ' + event.modelKey);
        return;
      case 'scores_published':
        if (!exists) throw new RegistryError('unknown model ' + event.modelKey);
        for (const s of event.scores) {
          if (!(s.score >= 0 && s.score <= 1) || !Number.isInteger(s.sampleSize) || s.sampleSize < 0) throw new RegistryError('invalid score for ' + event.modelKey);
        }
        return;
    }
  }

  private applyEvent(event: RegistryEvent): void {
    this.validate(event);
    const at = event.at;
    switch (event.type) {
      case 'registered': {
        this.entries.set(event.modelKey, {
          provider: event.provider,
          model: event.model,
          enabled: true,
          shadowMode: event.shadowMode,
          capabilities: [...event.capabilities],
          domainScores: [],
          ...(event.latencyEmaMs !== undefined ? { latencyEmaMs: event.latencyEmaMs } : {}),
          ...(event.costEmaMinor !== undefined ? { costEmaMinor: event.costEmaMinor } : {}),
        });
        this.changeLog.push({ at, modelKey: event.modelKey, change: event.shadowMode ? 'registered_shadow' : 'registered_active', by: event.by, reason: event.reason });
        return;
      }
      case 'activated':
      case 'returned_to_shadow':
      case 'enabled':
      case 'disabled': {
        const entry = this.entries.get(event.modelKey) as ModelRegistryEntry;
        if (event.type === 'activated') entry.shadowMode = false;
        if (event.type === 'returned_to_shadow') entry.shadowMode = true;
        if (event.type === 'enabled') entry.enabled = true;
        if (event.type === 'disabled') entry.enabled = false;
        this.changeLog.push({ at, modelKey: event.modelKey, change: event.type, by: event.by, reason: event.reason });
        return;
      }
      case 'call_succeeded': {
        const entry = this.entries.get(event.modelKey) as ModelRegistryEntry;
        entry.latencyEmaMs = entry.latencyEmaMs === undefined ? event.latencyMs : entry.latencyEmaMs + EMA_ALPHA * (event.latencyMs - entry.latencyEmaMs);
        if (event.costMinor !== undefined) {
          entry.costEmaMinor = entry.costEmaMinor === undefined ? event.costMinor : entry.costEmaMinor + divRound(event.costMinor - entry.costEmaMinor, 5n, 'half_even');
        }
        entry.failureRate = (entry.failureRate ?? 0) * (1 - EMA_ALPHA);
        this.healthByKey.set(event.modelKey, { ...this.health(event.modelKey), consecutiveFailures: 0, lastSuccessAt: at });
        return;
      }
      case 'call_failed': {
        const entry = this.entries.get(event.modelKey) as ModelRegistryEntry;
        entry.failureRate = (entry.failureRate ?? 0) * (1 - EMA_ALPHA) + EMA_ALPHA;
        const health = this.health(event.modelKey);
        this.healthByKey.set(event.modelKey, { ...health, consecutiveFailures: health.consecutiveFailures + 1, lastFailureAt: at, lastFailureKind: event.kind });
        return;
      }
      case 'scores_published': {
        const entry = this.entries.get(event.modelKey) as ModelRegistryEntry;
        entry.domainScores = event.scores.map((s) => ({ ...s }));
        entry.lastEvaluatedAt = at;
        return;
      }
    }
  }

  private require(key: ModelKey, mustExist: true): ModelRegistryEntry {
    const entry = this.get(key);
    if (!entry && mustExist) throw new RegistryError('unknown model ' + key);
    return entry as ModelRegistryEntry;
  }
}
