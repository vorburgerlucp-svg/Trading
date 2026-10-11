import { describe, expect, it } from 'vitest';
import { FinancialConnectorRegistry, type RegistryEvent } from '../../src/financial/financial-registry.js';
import { FinancialDataGateway } from '../../src/financial/financial-gateway.js';
import { McpFinancialConnector } from '../../src/financial/mcp-transport.js';
import { GENESIS_HASH, hashRecord, InMemoryAppendOnlyStore, type AppendOnlyStore, type LogRecord } from '../../src/persistence/append-only-log.js';
import { AAPL_ID, APPROVED, change, fakeMcp, FUNDAMENTALS_RAW, HUMAN, instrumentRegistry, PROVIDER, RESEARCH_ONLY, SYSTEM, T0 } from './fixtures.js';

// docs/FINANCIAL_GOVERNANCE_HARDENING.md §1–§3, §6. Registry state changes only through validated events. Callers never reach internal state. A stored
// event that breaks a rule stops the registry from opening: a hash proves a row was not modified, not that it was lawful.

const NOW = T0;
const clock = () => new Date(T0);

/** Writes a field the way untrusted code would. In strict mode a frozen target throws TypeError. */
function set(target: object, key: string, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

async function enabledResearch(license: typeof APPROVED | typeof RESEARCH_ONLY = APPROVED) {
  const registry = await FinancialConnectorRegistry.open();
  await registry.register({ connectorId: 'fund-a', provider: PROVIDER, transport: 'mcp', capabilities: ['fundamentals'], license, mode: 'RESEARCH' }, change());
  await registry.enable('fund-a', change());
  return registry;
}

const map = (_capability: string, raw: unknown) => ({ candidate: raw, providerSymbol: 'AAPL' });

async function gatewayOver(registry: FinancialConnectorRegistry) {
  const fake = fakeMcp({ get_company_fundamentals: FUNDAMENTALS_RAW });
  const connector = new McpFinancialConnector({ connectorId: 'fund-a', provider: PROVIDER, serverId: 'srv-1', client: fake.client, tools: { fundamentals: 'get_company_fundamentals' }, map, clock });
  return new FinancialDataGateway({ registry, instruments: await instrumentRegistry(), connectors: [connector], clock });
}

const PRODUCTION_REQUEST = { requestId: 'r-prod', capability: 'fundamentals', connectorId: 'fund-a', asOf: T0, environment: 'production', instrumentId: AAPL_ID, currency: 'USD', period: '2025-Q4' };

describe('registry state cannot be changed from outside the event log (§1, §2)', () => {
  it('a mode change through get() is refused and the registered mode stays RESEARCH (reproduces the bypass)', async () => {
    const registry = await enabledResearch();
    const entry = registry.get('fund-a')!;
    expect(() => set(entry, 'mode', 'PRODUCTION')).toThrow(TypeError);
    expect(registry.get('fund-a')!.mode).toBe('RESEARCH');
  });

  it('a production request is refused after an attempted external mode change (the served-production bypass)', async () => {
    const registry = await enabledResearch();
    const gateway = await gatewayOver(registry);
    try {
      set(registry.get('fund-a')!, 'mode', 'PRODUCTION');
    } catch {
      // refused, as required
    }
    await expect(gateway.fetch(PRODUCTION_REQUEST)).rejects.toMatchObject({ code: 'MODE_NOT_ALLOWED' });
  });

  it('enabled and license cannot be replaced through get()', async () => {
    const registry = await enabledResearch(RESEARCH_ONLY);
    await registry.disable('fund-a', change(SYSTEM));
    const entry = registry.get('fund-a')!;
    expect(() => set(entry, 'enabled', true)).toThrow(TypeError);
    expect(() => set(entry, 'license', APPROVED)).toThrow(TypeError);
    expect(registry.get('fund-a')).toMatchObject({ enabled: false, license: { status: 'research_only' } });
  });

  it('the returned entry, its license and its capabilities are deep-frozen copies', async () => {
    const registry = await enabledResearch();
    const entry = registry.get('fund-a')!;
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.license)).toBe(true);
    expect(Object.isFrozen(entry.capabilities)).toBe(true);
    expect(registry.get('fund-a')).not.toBe(entry);
  });

  it('license fields cannot be altered in place', async () => {
    const registry = await enabledResearch(RESEARCH_ONLY);
    const license = registry.get('fund-a')!.license;
    expect(() => set(license, 'status', 'production_approved')).toThrow(TypeError);
    expect(() => set(license, 'redistribution', 'internal_only')).toThrow(TypeError);
    expect(() => set(license, 'note', 'approved by someone')).toThrow(TypeError);
    expect(registry.get('fund-a')!.license.status).toBe('research_only');
  });

  it('the capability list cannot be widened through get()', async () => {
    const registry = await enabledResearch();
    const capabilities = registry.get('fund-a')!.capabilities as unknown as string[];
    expect(() => capabilities.push('portfolio_read')).toThrow(TypeError);
    expect(registry.get('fund-a')!.capabilities).toEqual(['fundamentals']);
  });

  it('returned history cannot change the journal, and the returned list is frozen', async () => {
    const registry = await enabledResearch();
    const items = registry.history('fund-a');
    try {
      set(items[0]!.by, 'id', 'attacker');
    } catch {
      // refused, as required
    }
    expect(registry.history('fund-a')[0]!.by.id).toBe(HUMAN.id);
    expect(Object.isFrozen(items)).toBe(true);
  });
});

/** A store that serves a fixed history. It stands in for a faulty or malicious database. Writes are not used by these tests. */
class FixedStore implements AppendOnlyStore<RegistryEvent> {
  constructor(private readonly records: readonly LogRecord<RegistryEvent>[]) {}
  async loadAll(): Promise<readonly LogRecord<RegistryEvent>[]> {
    return this.records;
  }
  async loadAfter(sequence: number): Promise<readonly LogRecord<RegistryEvent>[]> {
    return this.records.slice(sequence);
  }
  writeExclusive(): never {
    throw new Error('the fixed store is read-only');
  }
}

/** A hash-valid chain. The hashes are correct, so only semantic governance can reject it. */
function chainOf(events: Array<{ id?: string; event: RegistryEvent }>): FixedStore {
  const records: LogRecord<RegistryEvent>[] = [];
  let prevHash = GENESIS_HASH;
  events.forEach(({ id, event }, index) => {
    const unsigned = { sequence: index + 1, id: id ?? event.eventId, recordedAt: NOW, payload: event, prevHash };
    const record = { ...unsigned, hash: hashRecord(unsigned) };
    records.push(record);
    prevHash = record.hash;
  });
  return new FixedStore(records);
}

let counter = 0;
const nextId = () => 'fce_t' + ++counter;

function entryOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectorId: 'fund-a',
    provider: PROVIDER,
    transport: 'mcp',
    capabilities: ['fundamentals'],
    license: { status: 'production_approved', redistribution: 'internal_only' },
    mode: 'RESEARCH',
    enabled: false,
    registeredAt: NOW,
    ...overrides,
  };
}

function registration(overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): RegistryEvent {
  return { type: 'registered', eventId: nextId(), connectorId: 'fund-a', at: NOW, by: HUMAN, reason: 'test', entry: entryOf(overrides), ...extra } as unknown as RegistryEvent;
}

function step(type: 'enabled' | 'disabled', by = HUMAN, connectorId = 'fund-a'): RegistryEvent {
  return { type, eventId: nextId(), connectorId, at: NOW, by, reason: 'test' };
}

function activation(gate: { passed: boolean; reasons: string[] }, by = HUMAN): RegistryEvent {
  return { type: 'activated_production', eventId: nextId(), connectorId: 'fund-a', at: NOW, by, reason: 'test', gate } as RegistryEvent;
}

const seq = (...events: RegistryEvent[]) => events.map((event) => ({ event }));
const PASSED = { passed: true, reasons: [] };

const forged: Array<[string, () => Array<{ id?: string; event: RegistryEvent }>]> = [
  ['a registration that starts in PRODUCTION', () => seq(registration({ mode: 'PRODUCTION' }))],
  ['a registration that starts enabled', () => seq(registration({ enabled: true }))],
  ['a registration whose entry names another connector', () => seq(registration({ connectorId: 'other' }))],
  ['a registration with an unknown transport', () => seq(registration({ transport: 'ftp' }))],
  ['a registration with no capabilities', () => seq(registration({ capabilities: [] }))],
  ['a registration with a reserved capability', () => seq(registration({ capabilities: ['order_execution'] }))],
  ['a registration that lists a capability twice', () => seq(registration({ capabilities: ['fundamentals', 'fundamentals'] }))],
  ['a registration with an invented license status', () => seq(registration({ license: { status: 'approved_forever', redistribution: 'internal_only' } }))],
  ['a registration with an unexpected entry field', () => seq(registration({ rogue: true }))],
  ['a registration whose registeredAt differs from its event time', () => seq(registration({ registeredAt: '2020-01-01T00:00:00.000Z' }))],
  ['a registration without an entry', () => seq({ type: 'registered', eventId: nextId(), connectorId: 'fund-a', at: NOW, by: HUMAN, reason: 'test' } as RegistryEvent)],
  ['a registration with an unexpected event field', () => seq(registration({}, { surprise: 1 }))],
  ['an enable of an unknown connector', () => seq(step('enabled', HUMAN, 'ghost'))],
  ['an enable by a system actor', () => seq(registration(), step('enabled', SYSTEM))],
  ['an enable of a connector that is already enabled', () => seq(registration(), step('enabled'), step('enabled'))],
  ['a disable of a connector that is not enabled', () => seq(registration(), step('disabled'))],
  ['an activation with no gate', () => seq(registration(), step('enabled'), { type: 'activated_production', eventId: nextId(), connectorId: 'fund-a', at: NOW, by: HUMAN, reason: 'test' } as RegistryEvent)],
  ['an activation whose gate did not pass', () => seq(registration(), step('enabled'), activation({ passed: false, reasons: ['schema suite red'] }))],
  ['an activation of a research-only connector', () => seq(registration({ license: { status: 'research_only', redistribution: 'internal_only' } }), step('enabled'), activation(PASSED))],
  ['an activation of a disabled connector', () => seq(registration(), activation(PASSED))],
  ['an activation by a system actor', () => seq(registration(), step('enabled'), activation(PASSED, SYSTEM))],
  ['a second activation of a connector that is already PRODUCTION', () => seq(registration(), step('enabled'), activation(PASSED), activation(PASSED))],
  ['a second registration of the same connector', () => seq(registration(), registration())],
  ['an event whose id differs from its record id', () => [{ id: 'fce_forged', event: registration() }]],
  ['an unknown event type', () => seq({ ...registration(), type: 'deleted' } as unknown as RegistryEvent)],
];

describe('replay is semantic: a hash-valid but unlawful history fails closed (§3, §6)', () => {
  for (const [label, build] of forged) {
    it('refuses to open a history with ' + label, async () => {
      await expect(FinancialConnectorRegistry.open(chainOf(build()))).rejects.toMatchObject({ code: 'GOVERNANCE_INTEGRITY_ERROR' });
    });
  }

  it('a registration that starts in PRODUCTION with enabled true is refused on replay (the forged-production case)', async () => {
    const forgedStart = chainOf(seq(registration({ mode: 'PRODUCTION', enabled: true })));
    await expect(FinancialConnectorRegistry.open(forgedStart)).rejects.toMatchObject({ code: 'GOVERNANCE_INTEGRITY_ERROR' });
  });

  it('a history written by the registry itself replays into the same state', async () => {
    const store = new InMemoryAppendOnlyStore<RegistryEvent>();
    const live = await FinancialConnectorRegistry.open(store);
    await live.register({ connectorId: 'fund-a', provider: PROVIDER, transport: 'mcp', capabilities: ['fundamentals'], license: APPROVED, mode: 'RESEARCH' }, change());
    await live.enable('fund-a', change());
    await live.activateProduction('fund-a', change(), { passed: true, reasons: [] });
    const reopened = await FinancialConnectorRegistry.open(store);
    expect(reopened.get('fund-a')).toMatchObject({ mode: 'PRODUCTION', enabled: true });
    expect(reopened.history('fund-a').map((item) => item.type)).toEqual(['registered', 'enabled', 'activated_production']);
  });

  it('a lawful stored history of registration and enable replays', async () => {
    const reopened = await FinancialConnectorRegistry.open(chainOf(seq(registration(), step('enabled'))));
    expect(reopened.get('fund-a')).toMatchObject({ mode: 'RESEARCH', enabled: true });
  });
});
