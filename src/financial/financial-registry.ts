// Connector registry (financial-connector-registry:v1, docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §4). Event-sourced on the hash-chained append-only log, and
// every rule is checked again on replay. A new connector starts disabled, in SHADOW or RESEARCH. Only a human may enable a connector or activate
// PRODUCTION, and no connector or external data can change its own rights.

import { randomUUID } from 'node:crypto';
import type { Actor } from '../opportunities/opportunity-types.js';
import { parseUtc, toUtcIso } from '../market-data/time.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore, type AppendOnlyStore } from '../persistence/append-only-log.js';
import { licenseOf, licenseServes, type FinancialSourceLicense } from './financial-license.js';
import { FinancialGatewayError, IMPLEMENTED_CAPABILITIES, type FinancialCapability, type FinancialMode, type FinancialTransport } from './financial-types.js';

const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TRANSPORTS: readonly FinancialTransport[] = ['mcp', 'rest', 'internal'];

export interface RegisterInput {
  readonly connectorId: string;
  readonly provider: string;
  readonly transport: FinancialTransport;
  readonly capabilities: readonly FinancialCapability[];
  readonly license: FinancialSourceLicense;
  readonly mode?: FinancialMode;
}

export interface RegistryChange {
  readonly at: string;
  readonly by: Actor;
  readonly reason: string;
}

export interface ProductionGate {
  readonly passed: boolean;
  readonly reasons: readonly string[];
}

export interface ConnectorEntry {
  readonly connectorId: string;
  readonly provider: string;
  readonly transport: FinancialTransport;
  readonly capabilities: readonly FinancialCapability[];
  readonly license: FinancialSourceLicense;
  readonly mode: FinancialMode;
  readonly enabled: boolean;
  readonly registeredAt: string;
}

export interface ConnectorHistoryItem {
  readonly type: 'registered' | 'enabled' | 'disabled' | 'activated_production';
  readonly connectorId: string;
  readonly at: string;
  readonly by: Actor;
  readonly reason: string;
}

export interface RegistryEvent extends ConnectorHistoryItem {
  readonly eventId: string;
  readonly entry?: ConnectorEntry;
  readonly gate?: ProductionGate;
}

function invalid(message: string): never {
  throw new FinancialGatewayError('REGISTRATION_INVALID', message);
}

function instantOf(value: string): string {
  try {
    return toUtcIso(parseUtc(value));
  } catch {
    return invalid('change time must be a UTC instant');
  }
}

function requireHuman(by: Actor, why: string): void {
  if (by.kind !== 'human') throw new FinancialGatewayError('ACTIVATION_REQUIRES_HUMAN', why + ': only a human actor may do this');
}

export class FinancialConnectorRegistry {
  private readonly entries = new Map<string, ConnectorEntry>();
  private readonly journal: ConnectorHistoryItem[] = [];
  private log!: AppendOnlyLog<RegistryEvent>;

  private constructor(
    private readonly newId: () => string,
    private readonly clock: () => Date,
  ) {}

  static async open(store: AppendOnlyStore<RegistryEvent> = new InMemoryAppendOnlyStore<RegistryEvent>(), options: { clock?: () => Date; newId?: () => string } = {}): Promise<FinancialConnectorRegistry> {
    const registry = new FinancialConnectorRegistry(options.newId ?? randomUUID, options.clock ?? (() => new Date()));
    registry.log = await AppendOnlyLog.open<RegistryEvent>('financial-connectors', store, {
      clock: registry.clock,
      onApply: (record) => registry.apply(record.payload),
    });
    return registry;
  }

  async register(input: RegisterInput, change: RegistryChange): Promise<ConnectorEntry> {
    const entry = this.entryFor(input, change);
    await this.emit({ type: 'registered', eventId: this.eventId(), connectorId: entry.connectorId, at: change.at, by: actorOf(change), reason: change.reason, entry });
    return this.require(entry.connectorId);
  }

  async enable(connectorId: string, change: RegistryChange): Promise<ConnectorEntry> {
    await this.emit({ type: 'enabled', eventId: this.eventId(), connectorId, at: change.at, by: actorOf(change), reason: change.reason });
    return this.require(connectorId);
  }

  /** A system actor may disable a connector as a safety action. */
  async disable(connectorId: string, change: RegistryChange): Promise<ConnectorEntry> {
    await this.emit({ type: 'disabled', eventId: this.eventId(), connectorId, at: change.at, by: actorOf(change), reason: change.reason });
    return this.require(connectorId);
  }

  async activateProduction(connectorId: string, change: RegistryChange, gate: ProductionGate): Promise<ConnectorEntry> {
    await this.emit({ type: 'activated_production', eventId: this.eventId(), connectorId, at: change.at, by: actorOf(change), reason: change.reason, gate });
    return this.require(connectorId);
  }

  get(connectorId: string): ConnectorEntry | undefined {
    return this.entries.get(connectorId);
  }

  history(connectorId: string): ConnectorHistoryItem[] {
    return this.journal.filter((item) => item.connectorId === connectorId).map((item) => ({ ...item, by: { ...item.by } }));
  }

  private eventId(): string {
    return 'fce_' + this.newId();
  }

  private entryFor(input: RegisterInput, change: RegistryChange): ConnectorEntry {
    if (typeof input.connectorId !== 'string' || !CONNECTOR_ID.test(input.connectorId)) invalid('connectorId must be a lower-case identifier');
    if (typeof input.provider !== 'string' || input.provider.trim() === '' || input.provider.length > 64) invalid('provider must be a non-empty name of at most 64 characters');
    if (!TRANSPORTS.includes(input.transport)) invalid('transport must be mcp, rest or internal');
    const mode = input.mode ?? 'SHADOW';
    if (mode !== 'SHADOW' && mode !== 'RESEARCH') throw new FinancialGatewayError('REGISTRATION_INVALID', 'a new connector starts in SHADOW or RESEARCH, never PRODUCTION');
    if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) invalid('at least one capability is required');
    for (const capability of input.capabilities) {
      if (!IMPLEMENTED_CAPABILITIES.includes(capability)) throw new FinancialGatewayError('CAPABILITY_NOT_IMPLEMENTED', capability + ' has no validator in V1');
    }
    if (new Set(input.capabilities).size !== input.capabilities.length) invalid('a capability may be listed only once');
    return Object.freeze({
      connectorId: input.connectorId,
      provider: input.provider,
      transport: input.transport,
      capabilities: Object.freeze([...input.capabilities]),
      license: licenseOf(input.license),
      mode,
      enabled: false,
      registeredAt: instantOf(change.at),
    });
  }

  private async emit(event: RegistryEvent): Promise<void> {
    await this.log.append(event.eventId, event, { precondition: () => this.check(event) });
  }

  private existing(connectorId: string): ConnectorEntry {
    const entry = this.entries.get(connectorId);
    if (!entry) throw new FinancialGatewayError('CONNECTOR_NOT_FOUND', 'unknown connector ' + connectorId);
    return entry;
  }

  private require(connectorId: string): ConnectorEntry {
    return this.existing(connectorId);
  }

  /** Throws if the event would break a rule. Pure: it changes no state. Also runs on every replayed record. */
  private check(event: RegistryEvent): void {
    instantOf(event.at);
    if (event.by.kind !== 'human' && event.by.kind !== 'system') invalid('registry changes need a human or system actor');
    if (typeof event.reason !== 'string' || event.reason.trim() === '' || event.reason.length > 500) invalid('reason must be a non-empty string of at most 500 characters');
    switch (event.type) {
      case 'registered':
        if (this.entries.has(event.connectorId)) throw new FinancialGatewayError('CONNECTOR_ALREADY_REGISTERED', 'connector ' + event.connectorId + ' is already registered');
        return;
      case 'enabled': {
        const entry = this.existing(event.connectorId);
        requireHuman(event.by, 'enabling a connector');
        if (entry.enabled) invalid(event.connectorId + ' is already enabled');
        return;
      }
      case 'disabled':
        this.existing(event.connectorId);
        return;
      case 'activated_production': {
        const entry = this.existing(event.connectorId);
        requireHuman(event.by, 'activating PRODUCTION');
        if (!licenseServes(entry.license, 'production')) throw new FinancialGatewayError('LICENSE_NOT_ALLOWED', event.connectorId + ' needs an approved license with internal or wider redistribution for PRODUCTION');
        if (!entry.enabled) throw new FinancialGatewayError('CONNECTOR_DISABLED', event.connectorId + ' must be enabled before PRODUCTION');
        if (!event.gate?.passed) throw new FinancialGatewayError('ACTIVATION_GATE_FAILED', 'schema and benchmark gate not passed: ' + (event.gate?.reasons ?? []).join('; '));
        return;
      }
    }
  }

  private apply(event: RegistryEvent): void {
    this.check(event);
    switch (event.type) {
      case 'registered':
        this.entries.set(event.connectorId, event.entry!);
        break;
      case 'enabled':
        this.entries.set(event.connectorId, { ...this.existing(event.connectorId), enabled: true });
        break;
      case 'disabled':
        this.entries.set(event.connectorId, { ...this.existing(event.connectorId), enabled: false });
        break;
      case 'activated_production':
        this.entries.set(event.connectorId, { ...this.existing(event.connectorId), mode: 'PRODUCTION' });
        break;
    }
    this.journal.push({ type: event.type, connectorId: event.connectorId, at: event.at, by: { ...event.by }, reason: event.reason });
  }
}

function actorOf(change: RegistryChange): Actor {
  return { kind: change.by.kind, id: change.by.id };
}
