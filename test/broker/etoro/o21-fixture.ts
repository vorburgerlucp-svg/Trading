// Shared fixture of the O21 eToro demo execution tests. TEST DATA ONLY: no network. Every broker answer is scripted, and every
// request the code sends is recorded, so a test can count broker writes exactly. Keys are artificial markers.

import { Decimal } from '../../../src/money/decimal.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore, type AppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import { InstrumentRegistry, type InstrumentEvent } from '../../../src/market-data/instrument-registry.js';
import { PortfolioKillSwitchStore } from '../../../src/safety/portfolio-kill-switch-store.js';
import type { KillSwitchState, PortfolioSafetyDecision } from '../../../src/safety/portfolio-safety-envelope.js';
import { EToroDemoExecutionAdapter, DemoWritePacer } from '../../../src/broker/etoro/execution/etoro-demo-execution-adapter.js';
import { HttpsDemoExecutionTransport, type DemoExecutionFetch } from '../../../src/broker/etoro/execution/etoro-demo-execution-transport.js';
import {
  EtoroDemoExecutionService,
  type DemoPositionSource,
  type DemoSafetySource,
  type AttemptRecord,
  type ConfirmationRecord,
  type IntentEvent,
  type ReconciliationRecord,
} from '../../../src/broker/etoro/execution/etoro-demo-execution-service.js';
import { DEFAULT_DEMO_EXECUTION_POLICY, type DemoExecutionPolicy, type EvidencePosition, type GateQuote } from '../../../src/broker/etoro/execution/execution-gate.js';
import { AAPL } from '../../market-data/fixtures.js';

export const O21_NOW = '2026-10-16T14:00:00.000Z';
export const API_KEY_MARKER = 'O21-API-KEY-MARKER-0000000000000001';
export const USER_KEY_MARKER = 'O21-USER-KEY-MARKER-000000000000000000000000000000000002';
export const ETORO_AAPL_ID = 1001;
/** A second test instrument with its own governed eToro mapping, for cross-instrument limits. */
export const MSFT = Object.freeze({ ...AAPL, instrumentId: 'ins_o21_msft', symbol: 'MSFT', name: 'Microsoft Corp' });
export const ETORO_MSFT_ID = 1002;
export const HUMAN = { kind: 'human' as const, id: 'operator-1' };
/** The creator of test intents: trusted code passes it to create(); it is never part of the intent input. */
export const CREATOR = { kind: 'strategy' as const, id: 'strategy-a' };

/** A scripted broker answer: an HTTP response, or a thrown fetch error (no answer). */
export type Scripted = { status: number; body?: unknown; headers?: Record<string, string>; raw?: string } | { throws: 'timeout' | 'network' };

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** O22 F10: the request body exactly as it went on the wire (text), for tests that compare the sent bytes. */
  rawBody?: string;
}

/** An answer can depend on the request (e.g. echo its x-request-id), and can be held back (a pending broker answer). */
export type ScriptedAnswer = Scripted | ((request: RecordedRequest) => Scripted | Promise<Scripted>);

export class ScriptedBroker {
  readonly requests: RecordedRequest[] = [];
  private readonly queue: ScriptedAnswer[] = [];

  next(...answers: ScriptedAnswer[]): this {
    this.queue.push(...answers);
    return this;
  }

  get writes(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== 'GET');
  }

  readonly fetch: DemoExecutionFetch = async (url, init) => {
    this.requests.push({
      method: String(init.method),
      url,
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      ...(init.body === undefined ? {} : { rawBody: String(init.body) }),
    });
    const scripted = this.queue.shift();
    if (scripted === undefined) throw new Error('unscripted broker request: ' + String(init.method) + ' ' + url);
    const answer = typeof scripted === 'function' ? await scripted(this.requests.at(-1)!) : scripted;
    if ('throws' in answer) {
      const error = new Error(answer.throws);
      error.name = answer.throws === 'timeout' ? 'TimeoutError' : 'TypeError';
      throw error;
    }
    const text = answer.raw ?? (answer.body === undefined ? '' : JSON.stringify(answer.body));
    return new Response(answer.status === 204 ? null : text, { status: answer.status, headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) } });
  };
}

export function normalSafety(asOf = O21_NOW): PortfolioSafetyDecision {
  return {
    asOf,
    state: 'NORMAL',
    canIncreaseRisk: true,
    canReduceRisk: true,
    hardBreachReasons: [],
    capacityBlockReasons: [],
    dataHoldReasons: [],
    killSwitch: { status: 'ARMED' },
  } as unknown as PortfolioSafetyDecision;
}

export function freshQuote(overrides: Partial<GateQuote> = {}): GateQuote {
  return { last: Decimal.from('200'), bid: Decimal.from('199.9'), ask: Decimal.from('200.1'), currency: 'USD', observedAt: '2026-10-16T13:59:50.000Z', production: true, ...overrides };
}

export function trippedKillSwitch(): KillSwitchState {
  const fingerprint = 'a'.repeat(64);
  return {
    version: 'portfolio-kill-switch:v1',
    status: 'TRIPPED',
    tripId: 'trip_' + fingerprint.slice(0, 40),
    trippedAt: '2026-10-16T13:00:00.000Z',
    reasons: ['DAILY_LOSS_LIMIT'],
    triggeringDecisionFingerprint: fingerprint,
  };
}

/** The four execution stores. Two fixtures given the same stores behave like two NEXUS processes on one database. */
export interface O21Stores {
  intents: AppendOnlyStore<IntentEvent>;
  attempts: AppendOnlyStore<AttemptRecord>;
  confirmations: AppendOnlyStore<ConfirmationRecord>;
  reconciliations: AppendOnlyStore<ReconciliationRecord>;
}

export function inMemoryStores(): O21Stores {
  return {
    intents: new InMemoryAppendOnlyStore<IntentEvent>(),
    attempts: new InMemoryAppendOnlyStore<AttemptRecord>(),
    confirmations: new InMemoryAppendOnlyStore<ConfirmationRecord>(),
    reconciliations: new InMemoryAppendOnlyStore<ReconciliationRecord>(),
  };
}

export interface FixtureOptions {
  executionEnabled?: boolean;
  /** Shared stores (another "process" uses the same ones). Default: fresh in-memory stores. */
  stores?: O21Stores;
  /** A shared broker, to count the writes of several processes together. */
  sharedBroker?: ScriptedBroker;
  policy?: DemoExecutionPolicy;
  /** Replaces the quote source, e.g. to hold a gate back while another process acts. */
  quoteSource?: (instrumentId: string) => Promise<GateQuote | null>;
  safety?: PortfolioSafetyDecision | null;
  /** O22: a real safety source (e.g. the demo account source over a fixture transport) instead of a fixed decision. */
  safetySource?: DemoSafetySource;
  quote?: GateQuote | null;
  killSwitch?: KillSwitchState;
  broker?: { connection: string; lastSuccessfulSync: string | null };
  etoroMapping?: string | null;
  /** O22 C3: replaces the service's request id source (e.g. an id that is not a UUID, to refuse a request before the reservation). */
  requestId?: () => string;
  /**
   * O22 D4: the positions of the stored broker snapshot a close is checked against (observed "now" on the fixture clock, fresh,
   * complete). Default: the default test position, open (AAPL, buy). null: no snapshot at all.
   */
  brokerPositions?: EvidencePosition[] | null;
  /** O22 D4: replaces the scripted snapshot by a real position source (e.g. storedPositionSource over the stored O20 logs). */
  positionSource?: DemoPositionSource;
}

/** The position filledOpen() binds by default, as the broker snapshot shows it. */
export const DEFAULT_BROKER_POSITION: EvidencePosition = Object.freeze({ positionId: 2150941015, etoroInstrumentId: 1001, direction: 'buy', openOrderId: null });

export interface Fixture {
  service: EtoroDemoExecutionService;
  killSwitch: PortfolioKillSwitchStore;
  broker: ScriptedBroker;
  clock: { now: Date };
  stores: O21Stores;
  intents: AppendOnlyLog<IntentEvent>;
  attempts: AppendOnlyLog<AttemptRecord>;
  confirmations: AppendOnlyLog<ConfirmationRecord>;
  reconciliations: AppendOnlyLog<ReconciliationRecord>;
  setQuote(quote: GateQuote | null): void;
  setSafety(safety: PortfolioSafetyDecision | null): void;
  setBroker(status: { connection: string; lastSuccessfulSync: string | null }): void;
  /** O22 D4: the stored broker snapshot a close is checked against (null: none). */
  setSnapshot(snapshot: { observedAt?: string; freshness?: 'fresh' | 'stale'; positionCount?: number; positions: EvidencePosition[] } | null): void;
  advance(ms: number): void;
  requestIds: string[];
}

let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  return '00000000-0000-4000-8000-' + uuidCounter.toString(16).padStart(12, '0');
}

/**
 * A service wired like the runtime. The service has no lock option: it always reads BUILD_LOCKS.etoroDemoExecution. A test file
 * that exercises the write path replaces that constant with vi.mock (test-only, see o21-service.test.ts); without the mock the
 * lock is closed and every write is refused.
 */
export async function o21Fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const clock = { now: new Date(O21_NOW) };
  const now = () => new Date(clock.now.getTime());
  const instruments = new InMemoryAppendOnlyStore<InstrumentEvent>();
  const registry = await InstrumentRegistry.open(instruments, { clock: now });
  const change = { at: '2026-10-01T00:00:00.000Z', by: { kind: 'human' as const, id: 'mapping-owner' }, reason: 'O21 test: governed eToro mapping' };
  await registry.register({ ...AAPL }, change);
  const mapping = options.etoroMapping === undefined ? String(ETORO_AAPL_ID) : options.etoroMapping;
  if (mapping !== null) await registry.addMapping({ instrumentId: AAPL.instrumentId, provider: 'etoro', providerSymbol: mapping, validFrom: '2026-10-01T00:00:00.000Z' }, change);
  await registry.register({ ...MSFT }, change);
  await registry.addMapping({ instrumentId: MSFT.instrumentId, provider: 'etoro', providerSymbol: String(ETORO_MSFT_ID), validFrom: '2026-10-01T00:00:00.000Z' }, change);

  const killStore = new InMemoryAppendOnlyStore<KillSwitchState>();
  const killSwitch = await PortfolioKillSwitchStore.open(killStore);
  if (options.killSwitch) await killSwitch.latch(options.killSwitch);

  const broker = options.sharedBroker ?? new ScriptedBroker();
  const transport = new HttpsDemoExecutionTransport({ credentials: { apiKey: API_KEY_MARKER, userKey: USER_KEY_MARKER }, fetch: broker.fetch });
  const requestIds: string[] = [];
  const adapter = new EToroDemoExecutionAdapter({
    transport,
    clock: now,
    pacer: new DemoWritePacer(),
    requestId: () => {
      const id = nextUuid();
      requestIds.push(id);
      return id;
    },
    sleep: async (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  });
  const stores = options.stores ?? inMemoryStores();
  const intents = await AppendOnlyLog.open<IntentEvent>('etoro-demo-execution-intents', stores.intents, { clock: now });
  const attempts = await AppendOnlyLog.open<AttemptRecord>('etoro-demo-execution-attempts', stores.attempts, { clock: now });
  const confirmations = await AppendOnlyLog.open<ConfirmationRecord>('etoro-demo-broker-confirmations', stores.confirmations, { clock: now });
  const reconciliations = await AppendOnlyLog.open<ReconciliationRecord>('etoro-demo-execution-reconciliations', stores.reconciliations, { clock: now });
  let quote: GateQuote | null = options.quote === undefined ? freshQuote() : options.quote;
  let safety: PortfolioSafetyDecision | null = options.safety === undefined ? normalSafety() : options.safety;
  let brokerStatus = options.broker ?? { connection: 'connected', lastSuccessfulSync: '2026-10-16T13:58:00.000Z' };
  type SnapshotSetting = { observedAt?: string; freshness?: 'fresh' | 'stale'; positionCount?: number; positions: EvidencePosition[] } | null;
  let snapshot: SnapshotSetting = options.brokerPositions === null ? null : { positions: options.brokerPositions ?? [DEFAULT_BROKER_POSITION] };
  const service = new EtoroDemoExecutionService({
    adapter,
    intents,
    attempts,
    confirmations,
    reconciliations,
    registry,
    killSwitch,
    safety: options.safetySource ?? { current: async () => safety },
    quotes: { latest: async (instrumentId) => (options.quoteSource ? options.quoteSource(instrumentId) : quote) },
    brokerStatus: () => brokerStatus,
    positions: options.positionSource ?? {
      latest: async () => ({
        snapshot: snapshot === null ? null : {
          observedAt: snapshot.observedAt ?? now().toISOString(),
          freshness: snapshot.freshness ?? 'fresh',
          positionCount: snapshot.positionCount ?? snapshot.positions.length,
          positions: snapshot.positions,
        },
        problem: null,
      }),
    },
    executionEnabled: options.executionEnabled ?? true,
    policy: options.policy ?? DEFAULT_DEMO_EXECUTION_POLICY,
    clock: now,
    requestId: options.requestId ?? (() => {
      const id = nextUuid();
      requestIds.push(id);
      return id;
    }),
  });
  return {
    service, killSwitch, broker, clock, stores, intents, attempts, confirmations, reconciliations, requestIds,
    setQuote: (q) => { quote = q; },
    setSafety: (s) => { safety = s; },
    setBroker: (b) => { brokerStatus = b; },
    setSnapshot: (s) => { snapshot = s; },
    advance: (ms) => { clock.now = new Date(clock.now.getTime() + ms); },
  };
}

/** A valid market buy of 500 USD of AAPL. */
export function openInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'open',
    instrumentId: AAPL.instrumentId,
    etoroInstrumentId: ETORO_AAPL_ID,
    side: 'buy',
    orderType: 'mkt',
    amount: '500',
    currency: 'USD',
    leverage: 1,
    stopLoss: '180',
    takeProfit: '230',
    createdAt: '2026-10-16T13:59:00.000Z',
    expiresAt: '2026-10-16T14:10:00.000Z',
    strategyRunId: 'run-o21-1',
    ...overrides,
  };
}

/** The broker answer of "Create an order": it echoes the x-request-id of the request as referenceId, as the reference states. */
export function orderAccepted(orderId = 13902598): ScriptedAnswer {
  return (request) => ({ status: 200, body: { token: '066faaee-e1e9-49d2-a568-c6e1cc336ad8', orderId, referenceId: request.headers['x-request-id'] } });
}

/** The broker answer of "orders:lookup". */
export function lookupAnswer(statusId: number, options: { orderId?: number; positionIds?: number[]; instrumentId?: number; settlementType?: string | null } = {}): Scripted {
  return {
    status: 200,
    body: {
      accountId: 777, gcid: 888, portfolioId: 1,
      orderId: options.orderId ?? 13902598,
      action: 'open', transaction: 'buy', type: 'mkt', etoroOrderTypeId: 17,
      status: { id: statusId, name: 'x', errorCode: 0, errorMessage: null },
      asset: {
        symbol: 'AAPL', instrumentId: options.instrumentId ?? ETORO_AAPL_ID, currency: 'USD', leverage: 1, side: 'long',
        // O22: settlementType is 'real' unless a test states another one; null leaves the field out (not stated by the broker).
        ...(options.settlementType === null ? {} : { settlementType: options.settlementType ?? 'real' }),
      },
      orderCurrency: 'USD', requestedAmount: 500,
      positionExecutions: (options.positionIds ?? []).map((positionId) => ({ positionId, state: 'open', remainingUnits: 2.5 })),
      requestTime: '2026-10-16T14:00:00.000Z', lastUpdate: '2026-10-16T14:00:01.000Z',
    },
  };
}

/** Creates and approves an open intent. */
export async function approvedOpen(f: Fixture, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await f.service.create(openInput(overrides), CREATOR);
  if (created.state !== 'RISK_APPROVED') throw new Error('fixture intent was not risk-approved: ' + created.gateReasons.join(','));
  await f.service.approve(created.intentId, HUMAN);
  return created.intentId;
}

/** An open intent that eToro accepted and then reported FILLED with one position. */
export async function filledOpen(f: Fixture, positionId = 2150941015): Promise<string> {
  const intentId = await approvedOpen(f);
  f.broker.next(orderAccepted());
  await f.service.execute(intentId, HUMAN);
  f.broker.next(lookupAnswer(3, { positionIds: [positionId] }));
  await f.service.refresh(intentId);
  return intentId;
}

/** A valid market close of the position of an open intent. The position is never part of the input. */
export function closeInput(closesIntentId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'close',
    instrumentId: AAPL.instrumentId,
    etoroInstrumentId: ETORO_AAPL_ID,
    side: 'buy',
    orderType: 'mkt',
    currency: 'USD',
    leverage: 1,
    closesIntentId,
    createdAt: '2026-10-16T14:00:00.000Z',
    expiresAt: '2026-10-16T14:10:00.000Z',
    strategyRunId: 'run-o21-close',
    ...overrides,
  };
}
