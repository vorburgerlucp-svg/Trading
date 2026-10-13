// Connector registry (financial-connector-registry:v1, docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §4, docs/FINANCIAL_GOVERNANCE_HARDENING.md). State changes only
// through validated append-only events. One rule set checks every event when it is written and again when it is replayed. A stored event that breaks a
// rule stops the registry from opening (GOVERNANCE_INTEGRITY_ERROR). Nothing outside reaches internal state: every returned value is a frozen copy.

import { randomUUID } from 'node:crypto';
import type { Actor } from '../opportunities/opportunity-types.js';
import { canonicalUtc } from '../market-data/time.js';
import { AppendOnlyLog, deepFreeze, InMemoryAppendOnlyStore, type AppendOnlyStore } from '../persistence/append-only-log.js';
import { licenseOf, licenseServes, type FinancialSourceLicense } from './financial-license.js';
import { FinancialGatewayError, IMPLEMENTED_CAPABILITIES, type FinancialCapability, type FinancialErrorCode, type FinancialMode, type FinancialTransport } from './financial-types.js';

const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EVENT_ID = /^fce_[A-Za-z0-9-]{1,128}$/;
const TRANSPORTS: readonly FinancialTransport[] = ['mcp', 'rest', 'internal'];

const EVENT_KEYS = ['type', 'eventId', 'connectorId', 'at', 'by', 'reason', 'entry', 'gate'];
const ENTRY_KEYS = ['connectorId', 'provider', 'transport', 'capabilities', 'license', 'mode', 'enabled', 'registeredAt'];
const LICENSE_KEYS = ['status', 'redistribution', 'note'];
const GATE_KEYS = ['passed', 'reasons'];
const ACTOR_KEYS = ['kind', 'id'];

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

/** Stored registry history breaks the governance rules. This is an integrity failure of the stored data, not a caller error: the registry will not open. */
export class FinancialGovernanceIntegrityError extends Error {
  override readonly name = 'FinancialGovernanceIntegrityError';
  readonly code = 'GOVERNANCE_INTEGRITY_ERROR' as const;
}

/** A broken rule, stated as the caller error it is on a live write. */
function rule(condition: boolean, code: FinancialErrorCode, message: string): asserts condition {
  if (!condition) throw new FinancialGatewayError(code, message);
}

function utcOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return canonicalUtc(value);
  } catch {
    return null;
  }
}

function onlyKeys(record: unknown, allowed: readonly string[], what: string): void {
  rule(typeof record === 'object' && record !== null && !Array.isArray(record), 'REGISTRATION_INVALID', what + ' must be an object');
  for (const key of Object.keys(record).filter((k) => (record as Record<string, unknown>)[k] !== undefined)) {
    rule(allowed.includes(key), 'REGISTRATION_INVALID', what + ' has an unexpected field "' + key + '"');
  }
}

function existingOf(entries: ReadonlyMap<string, ConnectorEntry>, connectorId: string): ConnectorEntry {
  const entry = entries.get(connectorId);
  rule(entry !== undefined, 'CONNECTOR_NOT_FOUND', 'unknown connector ' + connectorId);
  return entry;
}

function lawfulRegistration(event: RegistryEvent, entries: ReadonlyMap<string, ConnectorEntry>): void {
  rule(event.entry !== undefined && event.gate === undefined, 'REGISTRATION_INVALID', 'a registration carries one entry and no gate');
  const entry = event.entry as unknown as Record<string, unknown>;
  rule(ENTRY_KEYS.every((key) => entry[key] !== undefined), 'REGISTRATION_INVALID', 'the registered entry is incomplete');
  onlyKeys(entry, ENTRY_KEYS, 'the registered entry');
  rule(entry.connectorId === event.connectorId, 'REGISTRATION_INVALID', 'the registered entry names another connector');
  rule(typeof entry.provider === 'string' && entry.provider.trim() !== '' && entry.provider.length <= 64, 'REGISTRATION_INVALID', 'provider must be a non-empty name of at most 64 characters');
  rule(TRANSPORTS.includes(entry.transport as FinancialTransport), 'REGISTRATION_INVALID', 'transport must be mcp, rest or internal');
  rule(Array.isArray(entry.capabilities) && entry.capabilities.length > 0, 'REGISTRATION_INVALID', 'at least one capability is required');
  const capabilities = entry.capabilities as unknown[];
  for (const capability of capabilities) {
    rule((IMPLEMENTED_CAPABILITIES as readonly unknown[]).includes(capability), 'CAPABILITY_NOT_IMPLEMENTED', String(capability) + ' has no validator in V1');
  }
  rule(new Set(capabilities).size === capabilities.length, 'REGISTRATION_INVALID', 'a capability may be listed only once');
  rule(entry.mode === 'SHADOW' || entry.mode === 'RESEARCH', 'REGISTRATION_INVALID', 'a registered connector starts in SHADOW or RESEARCH, never PRODUCTION');
  rule(entry.enabled === false, 'REGISTRATION_INVALID', 'a registered connector starts disabled');
  onlyKeys(entry.license, LICENSE_KEYS, 'the license');
  licenseOf(entry.license);
  rule(entry.registeredAt === event.at, 'REGISTRATION_INVALID', 'registeredAt must equal the registration event time');
  rule(!entries.has(event.connectorId), 'CONNECTOR_ALREADY_REGISTERED', 'connector ' + event.connectorId + ' is already registered');
}

function lawfulEnable(event: RegistryEvent, entries: ReadonlyMap<string, ConnectorEntry>): void {
  rule(event.entry === undefined && event.gate === undefined, 'REGISTRATION_INVALID', 'an enable carries no entry and no gate');
  const target = existingOf(entries, event.connectorId);
  rule(event.by.kind === 'human', 'ACTIVATION_REQUIRES_HUMAN', 'enabling a connector is a human act');
  rule(!target.enabled, 'REGISTRATION_INVALID', event.connectorId + ' is already enabled');
}

function lawfulDisable(event: RegistryEvent, entries: ReadonlyMap<string, ConnectorEntry>): void {
  rule(event.entry === undefined && event.gate === undefined, 'REGISTRATION_INVALID', 'a disable carries no entry and no gate');
  const target = existingOf(entries, event.connectorId);
  rule(target.enabled, 'REGISTRATION_INVALID', event.connectorId + ' is not enabled');
}

function lawfulActivation(event: RegistryEvent, entries: ReadonlyMap<string, ConnectorEntry>): void {
  rule(event.entry === undefined && event.gate !== undefined, 'REGISTRATION_INVALID', 'an activation carries a gate and no entry');
  const target = existingOf(entries, event.connectorId);
  rule(event.by.kind === 'human', 'ACTIVATION_REQUIRES_HUMAN', 'activating PRODUCTION is a human act');
  rule(target.mode !== 'PRODUCTION', 'REGISTRATION_INVALID', event.connectorId + ' is already PRODUCTION');
  rule(licenseServes(target.license, 'production'), 'LICENSE_NOT_ALLOWED', event.connectorId + ' needs an approved license with internal or wider redistribution for PRODUCTION');
  rule(target.enabled, 'CONNECTOR_DISABLED', event.connectorId + ' must be enabled before PRODUCTION');
  const gate = event.gate as unknown as Record<string, unknown>;
  onlyKeys(gate, GATE_KEYS, 'the gate');
  rule(typeof gate.passed === 'boolean' && Array.isArray(gate.reasons) && (gate.reasons as unknown[]).every((reason) => typeof reason === 'string'), 'REGISTRATION_INVALID', 'the gate needs a passed flag and string reasons');
  rule(gate.passed === true, 'ACTIVATION_GATE_FAILED', 'schema and benchmark gate not passed: ' + (gate.reasons as string[]).join('; '));
}

/** The one rule set. A live write sees a broken rule as a caller error; a replayed record sees it as a governance integrity failure. */
function lawful(event: RegistryEvent, entries: ReadonlyMap<string, ConnectorEntry>): void {
  onlyKeys(event, EVENT_KEYS, 'the registry event');
  rule(typeof event.eventId === 'string' && EVENT_ID.test(event.eventId), 'REGISTRATION_INVALID', 'eventId must be a registry event id');
  rule(utcOf(event.at) === event.at, 'REGISTRATION_INVALID', 'the event time must be canonical UTC');
  rule(typeof event.reason === 'string' && event.reason.trim() !== '' && event.reason.length <= 500, 'REGISTRATION_INVALID', 'reason must be a non-empty string of at most 500 characters');
  onlyKeys(event.by, ACTOR_KEYS, 'the actor');
  rule(event.by.kind === 'human' || event.by.kind === 'system', 'REGISTRATION_INVALID', 'registry changes need a human or system actor');
  rule(typeof event.by.id === 'string' && event.by.id.trim() !== '' && event.by.id.length <= 128, 'REGISTRATION_INVALID', 'the actor needs an id');
  rule(typeof event.connectorId === 'string' && CONNECTOR_ID.test(event.connectorId), 'REGISTRATION_INVALID', 'connectorId must be a lower-case identifier');
  switch (event.type) {
    case 'registered':
      return lawfulRegistration(event, entries);
    case 'enabled':
      return lawfulEnable(event, entries);
    case 'disabled':
      return lawfulDisable(event, entries);
    case 'activated_production':
      return lawfulActivation(event, entries);
    default:
      rule(false, 'REGISTRATION_INVALID', 'unknown registry event type');
  }
}

/** A deep-frozen copy. Nothing returned to a caller shares a reference with internal state. */
function snapshotOf(entry: ConnectorEntry): ConnectorEntry {
  return deepFreeze({ ...entry, capabilities: [...entry.capabilities], license: { ...entry.license } });
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
      onApply: (record) => registry.apply(record.id, record.payload),
    });
    return registry;
  }

  async register(input: RegisterInput, change: RegistryChange): Promise<ConnectorEntry> {
    const entry = this.entryFor(input, change);
    await this.emit({ type: 'registered', eventId: this.eventId(), connectorId: entry.connectorId, ...this.changeOf(change), entry });
    return this.require(entry.connectorId);
  }

  async enable(connectorId: string, change: RegistryChange): Promise<ConnectorEntry> {
    await this.emit({ type: 'enabled', eventId: this.eventId(), connectorId, ...this.changeOf(change) });
    return this.require(connectorId);
  }

  /** A system actor may disable a connector as a safety action. */
  async disable(connectorId: string, change: RegistryChange): Promise<ConnectorEntry> {
    await this.emit({ type: 'disabled', eventId: this.eventId(), connectorId, ...this.changeOf(change) });
    return this.require(connectorId);
  }

  async activateProduction(connectorId: string, change: RegistryChange, gate: ProductionGate): Promise<ConnectorEntry> {
    await this.emit({ type: 'activated_production', eventId: this.eventId(), connectorId, ...this.changeOf(change), gate });
    return this.require(connectorId);
  }

  /** A frozen copy of the connector's current state. Changing it cannot change the registry. */
  get(connectorId: string): ConnectorEntry | undefined {
    const entry = this.entries.get(connectorId);
    return entry ? snapshotOf(entry) : undefined;
  }

  /** A frozen copy of the connector's history. */
  history(connectorId: string): ConnectorHistoryItem[] {
    return deepFreeze(this.journal.filter((item) => item.connectorId === connectorId).map((item) => ({ ...item, by: { ...item.by } })));
  }

  private eventId(): string {
    return 'fce_' + this.newId();
  }

  /** The change time is normalised to canonical UTC, so a stored event always carries the form the rules check. */
  private changeOf(change: RegistryChange): { at: string; by: Actor; reason: string } {
    const at = utcOf(change.at);
    if (at === null) throw new FinancialGatewayError('REGISTRATION_INVALID', 'change time must be a UTC instant');
    return { at, by: { kind: change.by.kind, id: change.by.id }, reason: change.reason };
  }

  private entryFor(input: RegisterInput, change: RegistryChange): ConnectorEntry {
    if (typeof input.connectorId !== 'string' || !CONNECTOR_ID.test(input.connectorId)) throw new FinancialGatewayError('REGISTRATION_INVALID', 'connectorId must be a lower-case identifier');
    if (typeof input.provider !== 'string' || input.provider.trim() === '' || input.provider.length > 64) throw new FinancialGatewayError('REGISTRATION_INVALID', 'provider must be a non-empty name of at most 64 characters');
    if (!TRANSPORTS.includes(input.transport)) throw new FinancialGatewayError('REGISTRATION_INVALID', 'transport must be mcp, rest or internal');
    const mode = input.mode ?? 'SHADOW';
    if (mode !== 'SHADOW' && mode !== 'RESEARCH') throw new FinancialGatewayError('REGISTRATION_INVALID', 'a new connector starts in SHADOW or RESEARCH, never PRODUCTION');
    if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) throw new FinancialGatewayError('REGISTRATION_INVALID', 'at least one capability is required');
    for (const capability of input.capabilities) {
      if (!IMPLEMENTED_CAPABILITIES.includes(capability)) throw new FinancialGatewayError('CAPABILITY_NOT_IMPLEMENTED', capability + ' has no validator in V1');
    }
    if (new Set(input.capabilities).size !== input.capabilities.length) throw new FinancialGatewayError('REGISTRATION_INVALID', 'a capability may be listed only once');
    return Object.freeze({
      connectorId: input.connectorId,
      provider: input.provider,
      transport: input.transport,
      capabilities: Object.freeze([...input.capabilities]),
      license: licenseOf(input.license),
      mode,
      enabled: false,
      registeredAt: this.changeOf(change).at,
    });
  }

  private async emit(event: RegistryEvent): Promise<void> {
    await this.log.append(event.eventId, event, { precondition: () => lawful(event, this.entries) });
  }

  private require(connectorId: string): ConnectorEntry {
    return snapshotOf(existingOf(this.entries, connectorId));
  }

  /** Applies one record. It runs for live writes and for every replayed record, and it fails closed on any broken rule. */
  private apply(recordId: string, event: RegistryEvent): void {
    try {
      rule(event.eventId === recordId, 'REGISTRATION_INVALID', 'the event id differs from its record id');
      lawful(event, this.entries);
    } catch (error) {
      throw new FinancialGovernanceIntegrityError('stored registry history violates the governance rules: ' + (error instanceof Error ? error.message : String(error)));
    }
    switch (event.type) {
      case 'registered':
        this.entries.set(event.connectorId, snapshotOf(event.entry!));
        break;
      case 'enabled':
        this.entries.set(event.connectorId, deepFreeze({ ...existingOf(this.entries, event.connectorId), enabled: true }));
        break;
      case 'disabled':
        this.entries.set(event.connectorId, deepFreeze({ ...existingOf(this.entries, event.connectorId), enabled: false }));
        break;
      case 'activated_production':
        this.entries.set(event.connectorId, deepFreeze({ ...existingOf(this.entries, event.connectorId), mode: 'PRODUCTION' as const }));
        break;
    }
    this.journal.push(deepFreeze({ type: event.type, connectorId: event.connectorId, at: event.at, by: { kind: event.by.kind, id: event.by.id }, reason: event.reason }));
  }
}
