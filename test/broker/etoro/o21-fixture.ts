// Shared fixture of the O21 eToro demo execution tests. TEST DATA ONLY: no network. Every broker answer is scripted, and every
// request the code sends is recorded, so a test can count broker writes exactly. Keys are artificial markers.

import { Decimal } from '../../../src/money/decimal.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import { InstrumentRegistry, type InstrumentEvent } from '../../../src/market-data/instrument-registry.js';
import { PortfolioKillSwitchStore } from '../../../src/safety/portfolio-kill-switch-store.js';
import type { KillSwitchState, PortfolioSafetyDecision } from '../../../src/safety/portfolio-safety-envelope.js';
import { EToroDemoExecutionAdapter, DemoWritePacer } from '../../../src/broker/etoro/execution/etoro-demo-execution-adapter.js';
import { HttpsDemoExecutionTransport, type DemoExecutionFetch } from '../../../src/broker/etoro/execution/etoro-demo-execution-transport.js';
import {
  EtoroDemoExecutionService,
  type AttemptRecord,
  type ConfirmationRecord,
  type IntentEvent,
  type ReconciliationRecord,
} from '../../../src/broker/etoro/execution/etoro-demo-execution-service.js';
import type { GateQuote } from '../../../src/broker/etoro/execution/execution-gate.js';
import { AAPL } from '../../market-data/fixtures.js';

export const O21_NOW = '2026-10-16T14:00:00.000Z';
export const API_KEY_MARKER = 'O21-API-KEY-MARKER-0000000000000001';
export const USER_KEY_MARKER = 'O21-USER-KEY-MARKER-000000000000000000000000000000000002';
export const ETORO_AAPL_ID = 1001;
export const HUMAN = { kind: 'human' as const, id: 'operator-1' };

/** A scripted broker answer: an HTTP response, or a thrown fetch error (no answer). */
export type Scripted = { status: number; body?: unknown; headers?: Record<string, string>; raw?: string } | { throws: 'timeout' | 'network' };

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** An answer can depend on the request, e.g. to echo its x-request-id as referenceId. */
export type ScriptedAnswer = Scripted | ((request: RecordedRequest) => Scripted);

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
    });
    const scripted = this.queue.shift();
    if (scripted === undefined) throw new Error('unscripted broker request: ' + String(init.method) + ' ' + url);
    const answer = typeof scripted === 'function' ? scripted(this.requests.at(-1)!) : scripted;
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

export interface FixtureOptions {
  executionEnabled?: boolean;
  /** 'default' omits the dependency, so the service falls back to BUILD_LOCKS.etoroDemoExecution as the runtime does. */
  buildLocked?: boolean | 'default';
  safety?: PortfolioSafetyDecision | null;
  quote?: GateQuote | null;
  killSwitch?: KillSwitchState;
  broker?: { connection: string; lastSuccessfulSync: string | null };
  etoroMapping?: string | null;
}

export interface Fixture {
  service: EtoroDemoExecutionService;
  killSwitch: PortfolioKillSwitchStore;
  broker: ScriptedBroker;
  clock: { now: Date };
  intents: AppendOnlyLog<IntentEvent>;
  attempts: AppendOnlyLog<AttemptRecord>;
  confirmations: AppendOnlyLog<ConfirmationRecord>;
  reconciliations: AppendOnlyLog<ReconciliationRecord>;
  setQuote(quote: GateQuote | null): void;
  setSafety(safety: PortfolioSafetyDecision | null): void;
  setBroker(status: { connection: string; lastSuccessfulSync: string | null }): void;
  advance(ms: number): void;
  requestIds: string[];
}

let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  return '00000000-0000-4000-8000-' + uuidCounter.toString(16).padStart(12, '0');
}

/** A service wired like the runtime, with the build lock OPEN by default so the write path can be tested. */
export async function o21Fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const clock = { now: new Date(O21_NOW) };
  const now = () => new Date(clock.now.getTime());
  const instruments = new InMemoryAppendOnlyStore<InstrumentEvent>();
  const registry = await InstrumentRegistry.open(instruments, { clock: now });
  const change = { at: '2026-10-01T00:00:00.000Z', by: { kind: 'human' as const, id: 'mapping-owner' }, reason: 'O21 test: governed eToro mapping' };
  await registry.register({ ...AAPL }, change);
  const mapping = options.etoroMapping === undefined ? String(ETORO_AAPL_ID) : options.etoroMapping;
  if (mapping !== null) await registry.addMapping({ instrumentId: AAPL.instrumentId, provider: 'etoro', providerSymbol: mapping, validFrom: '2026-10-01T00:00:00.000Z' }, change);

  const killStore = new InMemoryAppendOnlyStore<KillSwitchState>();
  const killSwitch = await PortfolioKillSwitchStore.open(killStore);
  if (options.killSwitch) await killSwitch.latch(options.killSwitch);

  const broker = new ScriptedBroker();
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
  const intents = await AppendOnlyLog.inMemory<IntentEvent>('etoro-demo-execution-intents', { clock: now });
  const attempts = await AppendOnlyLog.inMemory<AttemptRecord>('etoro-demo-execution-attempts', { clock: now });
  const confirmations = await AppendOnlyLog.inMemory<ConfirmationRecord>('etoro-demo-broker-confirmations', { clock: now });
  const reconciliations = await AppendOnlyLog.inMemory<ReconciliationRecord>('etoro-demo-execution-reconciliations', { clock: now });
  let quote: GateQuote | null = options.quote === undefined ? freshQuote() : options.quote;
  let safety: PortfolioSafetyDecision | null = options.safety === undefined ? normalSafety() : options.safety;
  let brokerStatus = options.broker ?? { connection: 'connected', lastSuccessfulSync: '2026-10-16T13:58:00.000Z' };
  const service = new EtoroDemoExecutionService({
    adapter,
    intents,
    attempts,
    confirmations,
    reconciliations,
    registry,
    killSwitch,
    safety: { current: async () => safety },
    quotes: { latest: async () => quote },
    brokerStatus: () => brokerStatus,
    executionEnabled: options.executionEnabled ?? true,
    ...(options.buildLocked === 'default' ? {} : { buildLocked: options.buildLocked ?? false }),
    clock: now,
    requestId: () => {
      const id = nextUuid();
      requestIds.push(id);
      return id;
    },
  });
  return {
    service, killSwitch, broker, clock, intents, attempts, confirmations, reconciliations, requestIds,
    setQuote: (q) => { quote = q; },
    setSafety: (s) => { safety = s; },
    setBroker: (b) => { brokerStatus = b; },
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
    createdBy: { kind: 'strategy', id: 'strategy-a' },
    ...overrides,
  };
}

/** The broker answer of "Create an order": it echoes the x-request-id of the request as referenceId, as the reference states. */
export function orderAccepted(orderId = 13902598): ScriptedAnswer {
  return (request) => ({ status: 200, body: { token: '066faaee-e1e9-49d2-a568-c6e1cc336ad8', orderId, referenceId: request.headers['x-request-id'] } });
}

/** The broker answer of "orders:lookup". */
export function lookupAnswer(statusId: number, options: { orderId?: number; positionIds?: number[]; instrumentId?: number } = {}): Scripted {
  return {
    status: 200,
    body: {
      accountId: 777, gcid: 888, portfolioId: 1,
      orderId: options.orderId ?? 13902598,
      action: 'open', transaction: 'buy', type: 'mkt', etoroOrderTypeId: 17,
      status: { id: statusId, name: 'x', errorCode: 0, errorMessage: null },
      asset: { symbol: 'AAPL', instrumentId: options.instrumentId ?? ETORO_AAPL_ID, currency: 'USD', settlementType: 'real', leverage: 1, side: 'long' },
      orderCurrency: 'USD', requestedAmount: 500,
      positionExecutions: (options.positionIds ?? []).map((positionId) => ({ positionId, state: 'open', remainingUnits: 2.5 })),
      requestTime: '2026-10-16T14:00:00.000Z', lastUpdate: '2026-10-16T14:00:01.000Z',
    },
  };
}

/** Creates and approves an open intent. */
export async function approvedOpen(f: Fixture, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await f.service.create(openInput(overrides));
  if (created.state !== 'RISK_APPROVED') throw new Error('fixture intent was not risk-approved: ' + created.gateReasons.join(','));
  await f.service.approve(created.intentId, HUMAN);
  return created.intentId;
}

/** An open intent that eToro accepted and then reported FILLED with one position. */
export async function filledOpen(f: Fixture, positionId = 2150941015): Promise<string> {
  const intentId = await approvedOpen(f);
  f.broker.next(orderAccepted());
  await f.service.execute(intentId);
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
    createdBy: { kind: 'human', id: 'operator-1' },
    ...overrides,
  };
}
