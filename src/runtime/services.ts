// The NEXUS runtime services: the composition of the existing market data, quant and safety services behind the
// RuntimeServices interface. Every response is built from validated NEXUS data. No provider object, raw HTTP body or stack
// trace leaves this module, and demo data is never usable for trading.

import { BUILD_LOCKS } from '../nexus/safety.js';
import type { InstrumentRegistry } from '../market-data/instrument-registry.js';
import type { MarketDataService } from '../market-data/market-data-service.js';
import { MarketDataError, type InstrumentCandidate, type MarketDataProvider } from '../market-data/market-data-provider.js';
import {
  INTERVAL_MS,
  type BarInterval,
  type BarSession,
  type Instrument,
  type PriceAdjustment,
  type StoredBar,
  type StoredQuote,
} from '../market-data/market-data-types.js';
import { toUtcIso } from '../market-data/time.js';
import type { QuantService } from '../quant/quant-service.js';
import type { PortfolioKillSwitchStore } from '../safety/portfolio-kill-switch-store.js';
import { BrokerError } from '../broker/broker-errors.js';
import type { EtoroBrokerService } from '../broker/etoro/etoro-broker-service.js';
import type { EtoroDemoExecutionService } from '../broker/etoro/execution/etoro-demo-execution-service.js';
import type { BarsRequest, DemoExecutionRoutes, InstrumentRegisterRequest, InstrumentSearchItem, QuantRequest, RuntimeHealth, RuntimeServices } from './app.js';
import { RuntimeApiError } from './errors.js';
import type { OperatorIdentity } from './operator-auth.js';

/** A quote older than this is stale and is never usable for trading. */
export const QUOTE_MAX_AGE_MS = 15 * 60 * 1000;
/** Bars read back before an as-of time for the quant run. */
export const QUANT_LOOKBACK_BARS = 300;
const SEARCH_LIMIT = 25;

export type MarketDataMode = 'production' | 'demo' | 'not_configured';

export interface RuntimeDeps {
  registry: InstrumentRegistry;
  marketData: MarketDataService;
  quant: QuantService;
  killSwitch: PortfolioKillSwitchStore;
  /** The one configured provider: production (Twelve Data with the server-side key) or the labelled demo. Null when not connected. */
  provider: MarketDataProvider | null;
  marketDataMode: MarketDataMode;
  /** Database connectivity. Never throws; false when the database does not answer. */
  ping: () => Promise<boolean>;
  version: string;
  clock?: () => Date;
  /** The eToro demo read-only service. Absent when eToro is not enabled: the broker then reports not connected. */
  etoro?: EtoroBrokerService | null;
  /** The eToro demo execution service (O21). Absent unless ETORO_DEMO_EXECUTION_ENABLED=1; the routes then answer EXECUTION_DISABLED. */
  etoroDemoExecution?: EtoroDemoExecutionService | null;
}

function sanitizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // External text is untrusted: no control characters, bounded length, never interpreted.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned === '' ? null : cleaned.slice(0, 120);
}

function pattern(value: unknown, regex: RegExp): string | null {
  return typeof value === 'string' && regex.test(value) ? value : null;
}

function validTimezone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** One provider candidate, validated field by field. A candidate that fails the minimum is dropped, never passed on. */
function toSearchItem(candidate: InstrumentCandidate, provider: string, registry: InstrumentRegistry, now: string): InstrumentSearchItem | null {
  const providerSymbol = pattern(candidate.providerSymbol, /^[A-Za-z0-9._\-/:]{1,64}$/);
  if (providerSymbol === null || candidate.assetClass === null || candidate.assetClass === undefined) return null;
  const name = sanitizeName(candidate.name);
  if (name === null) return null;
  const exchange = pattern(candidate.exchange, /^[A-Za-z0-9._-]{1,32}$/);
  return {
    instrumentId: registry.resolve(provider, providerSymbol, now, exchange ?? undefined) ?? registry.resolve(provider, providerSymbol, now),
    provider,
    providerSymbol,
    name,
    assetClass: String(candidate.assetClass),
    exchange,
    mic: pattern(candidate.mic, /^[A-Z0-9]{4}$/),
    currency: pattern(candidate.currency, /^[A-Z0-9]{3,10}$/),
    timezone: validTimezone(candidate.timezone),
  };
}

function adjustmentFor(mode: MarketDataMode): PriceAdjustment {
  // Mirrors the live smoke test: a production key requests raw prices, the public demo key only serves split-adjusted ones.
  return mode === 'production' ? 'raw' : 'split_adjusted';
}

function sessionFor(instrument: Instrument): BarSession {
  return instrument.assetClass === 'crypto' || instrument.assetClass === 'forex' ? 'continuous' : 'regular';
}

function lookbackMs(interval: BarInterval): number {
  return (interval === '1d' ? 86_400_000 : INTERVAL_MS[interval]) * QUANT_LOOKBACK_BARS;
}

function barJson(bar: StoredBar): unknown {
  return {
    startTime: bar.startTime,
    endTime: bar.endTime,
    open: bar.open.toString(),
    high: bar.high.toString(),
    low: bar.low.toString(),
    close: bar.close.toString(),
    volume: bar.volume === undefined ? null : bar.volume.toString(),
    isFinal: bar.isFinal,
    observedAt: bar.observedAt,
    availableAt: bar.availableAt,
    retrievedAt: bar.retrievedAt,
    source: bar.source,
  };
}

function quoteJson(quote: StoredQuote, freshness: 'fresh' | 'stale', mode: MarketDataMode): unknown {
  return {
    instrumentId: quote.instrumentId,
    source: quote.source,
    last: quote.last.toString(),
    bid: quote.bid === undefined ? null : quote.bid.toString(),
    ask: quote.ask === undefined ? null : quote.ask.toString(),
    observedAt: quote.observedAt,
    availableAt: quote.availableAt,
    retrievedAt: quote.retrievedAt,
    freshness,
    maxAgeMs: QUOTE_MAX_AGE_MS,
    dataMode: mode,
    usableForTrading: freshness === 'fresh' && mode === 'production',
  };
}

export class RuntimeServiceImpl implements RuntimeServices {
  /** O21: every intent route goes through the service; nothing here reaches the adapter or the transport. */
  readonly demoExecution?: DemoExecutionRoutes;

  constructor(private readonly deps: RuntimeDeps) {
    const execution = deps.etoroDemoExecution ?? null;
    if (execution !== null) {
      // The operator is the identity the HTTP layer authenticated; it is the approver, and it is recorded on every write attempt.
      this.demoExecution = Object.freeze({
        create: (intent: unknown, operator: OperatorIdentity) => execution.create(intent, { kind: operator.kind, id: operator.id }),
        get: (intentId: string) => execution.get(intentId),
        approve: (intentId: string, operator: OperatorIdentity) => execution.approve(intentId, { kind: operator.kind, id: operator.id }),
        execute: (intentId: string, operator: OperatorIdentity) => execution.execute(intentId, { kind: operator.kind, id: operator.id }),
        refresh: (intentId: string) => execution.refresh(intentId),
        cancel: (intentId: string, operator: OperatorIdentity) => execution.cancel(intentId, { kind: operator.kind, id: operator.id }),
      });
    }
  }

  private now(): string {
    return toUtcIso((this.deps.clock ?? (() => new Date()))().getTime());
  }

  private requireProvider(): MarketDataProvider {
    if (!this.deps.provider) throw new MarketDataError('not_configured', 'nexus', 'market data provider is not configured (DATA NOT CONNECTED)');
    return this.deps.provider;
  }

  private requireInstrument(instrumentId: string): Instrument {
    const instrument = this.deps.registry.get(instrumentId);
    if (!instrument) throw new MarketDataError('not_found', 'nexus', 'unknown instrument');
    return instrument;
  }

  async health(): Promise<RuntimeHealth> {
    const databaseUp = await this.deps.ping().catch(() => false);
    return {
      status: databaseUp ? 'ok' : 'degraded',
      database: databaseUp ? 'connected' : 'unavailable',
      marketData: this.deps.marketDataMode === 'production' ? 'configured' : this.deps.marketDataMode,
      providerHealth: this.deps.provider ? this.deps.provider.health().state : 'not_configured',
      tradingMode: 'paper',
      liveTrading: 'locked',
      buildLocks: {
        liveTrading: BUILD_LOCKS.liveTrading,
        brokerOrders: BUILD_LOCKS.brokerOrders,
        physicalPurchase: BUILD_LOCKS.physicalPurchase,
        etoroDemoExecution: BUILD_LOCKS.etoroDemoExecution,
      },
      version: this.deps.version,
    };
  }

  async searchInstruments(query: string): Promise<InstrumentSearchItem[]> {
    const provider = this.requireProvider();
    const now = this.now();
    const candidates = await provider.searchInstruments(query);
    const items: InstrumentSearchItem[] = [];
    for (const candidate of candidates) {
      const item = toSearchItem(candidate, provider.providerId, this.deps.registry, now);
      if (item !== null) items.push(item);
      if (items.length === SEARCH_LIMIT) break;
    }
    return items;
  }

  async registerInstrument(request: InstrumentRegisterRequest): Promise<InstrumentSearchItem> {
    const provider = this.requireProvider();
    const now = this.now();
    const validFromMs = Date.parse(request.validFrom);
    if (!Number.isFinite(validFromMs) || new Date(validFromMs).toISOString() !== request.validFrom || validFromMs > Date.parse(now)) {
      throw new MarketDataError('bad_request', provider.providerId, 'mapping validFrom must be a canonical UTC instant at or before now');
    }
    const candidate = await provider.getInstrument(request.providerSymbol, {
      ...(request.mic !== undefined ? { mic: request.mic } : {}),
      ...(request.exchange !== undefined ? { exchange: request.exchange } : {}),
    });
    if (!candidate) throw new MarketDataError('not_found', provider.providerId, 'instrument was not found');
    if (candidate.provider !== provider.providerId || candidate.providerSymbol.toUpperCase() !== request.providerSymbol.toUpperCase()) {
      throw new MarketDataError('schema_invalid', provider.providerId, 'provider returned a different instrument identity');
    }
    const item = toSearchItem(candidate, provider.providerId, this.deps.registry, now);
    if (item === null || item.currency === null || item.timezone === null) {
      throw new MarketDataError('schema_invalid', provider.providerId, 'instrument metadata is incomplete or invalid');
    }
    if (item.instrumentId !== null) return item;

    const instrument = await this.deps.registry.registerWithMapping({
      assetClass: candidate.assetClass!,
      symbol: item.providerSymbol,
      name: item.name,
      currency: item.currency,
      timezone: item.timezone,
      active: true,
      ...(item.exchange !== null ? { exchange: item.exchange } : {}),
      ...(item.mic !== null ? { mic: item.mic } : {}),
    }, {
      provider: provider.providerId,
      providerSymbol: item.providerSymbol,
      validFrom: request.validFrom,
      ...(item.exchange !== null ? { exchange: item.exchange } : {}),
    }, { at: now, by: { kind: 'system', id: 'nexus-runtime' }, reason: 'explicit local runtime instrument registration with provider mapping' });
    return { ...item, instrumentId: instrument.instrumentId };
  }

  async readBars(request: BarsRequest): Promise<unknown> {
    const provider = this.requireProvider();
    const instrument = this.requireInstrument(request.instrumentId);
    const adjustment = adjustmentFor(this.deps.marketDataMode);
    // The ingest path: provider -> validation -> store. The read is point-in-time and carries its quality verdict.
    const backfill = await this.deps.marketData.backfillBars({
      instrumentId: request.instrumentId,
      provider: provider.providerId,
      interval: request.interval,
      adjustment,
      from: request.from,
      to: request.to,
    });
    const read = await this.deps.marketData.readSeries({
      instrumentId: request.instrumentId,
      source: backfill.source,
      interval: request.interval,
      session: sessionFor(instrument),
      adjustment,
      from: request.from,
      to: request.to,
      asOf: this.now(),
    });
    const demo = this.deps.marketDataMode !== 'production';
    return {
      instrumentId: request.instrumentId,
      interval: request.interval,
      source: backfill.source,
      adjustment,
      session: sessionFor(instrument),
      storedThrough: read.storedThrough,
      dataMode: this.deps.marketDataMode,
      usableForTrading: !demo && read.quality.usableForTrading,
      usableForBacktest: read.quality.usableForBacktest,
      quality: {
        valid: read.quality.valid,
        severity: read.quality.severity,
        issues: read.quality.issues.map((issue) => ({ code: issue.code, severity: issue.severity, message: issue.message })),
      },
      bars: read.bars.map(barJson),
    };
  }

  async quote(instrumentId: string): Promise<unknown> {
    const provider = this.requireProvider();
    this.requireInstrument(instrumentId);
    const { quote } = await this.deps.marketData.refreshQuote(instrumentId, provider.providerId);
    if (!quote) throw new MarketDataError('provider_unavailable', provider.providerId, 'no quote could be stored');
    const ageMs = Date.parse(this.now()) - Date.parse(quote.observedAt);
    const freshness = ageMs >= 0 && ageMs <= QUOTE_MAX_AGE_MS ? 'fresh' : 'stale';
    return quoteJson(quote, freshness, this.deps.marketDataMode);
  }

  async runQuant(request: QuantRequest): Promise<unknown> {
    const provider = this.requireProvider();
    if (this.deps.marketDataMode !== 'production') {
      throw new RuntimeApiError('DATA_QUALITY_ERROR');
    }
    const instrument = this.requireInstrument(request.instrumentId);
    const adjustment = adjustmentFor(this.deps.marketDataMode);
    const from = toUtcIso(Date.parse(request.asOf) - lookbackMs(request.interval));
    const backfill = await this.deps.marketData.backfillBars({
      instrumentId: request.instrumentId,
      provider: provider.providerId,
      interval: request.interval,
      adjustment,
      from,
      to: request.asOf,
    });
    const run = await this.deps.quant.run({
      instrumentId: request.instrumentId,
      source: backfill.source,
      interval: request.interval,
      session: sessionFor(instrument),
      adjustment,
      asOf: request.asOf,
    });
    return {
      quantRunId: run.record.result.quantRunId,
      persistence: run.status,
      insufficientData: run.record.result.insufficientData,
      storedThrough: run.record.storedThrough,
      resultHash: run.record.resultHash,
      dataMode: this.deps.marketDataMode,
      result: run.record.result,
    };
  }

  async safetyStatus(): Promise<unknown> {
    await this.deps.killSwitch.sync();
    const state = this.deps.killSwitch.current();
    return {
      portfolioSafety: 'not_connected',
      killSwitch: {
        status: state.status,
        tripId: state.tripId,
        trippedAt: state.trippedAt,
        reasons: [...state.reasons],
      },
      // No portfolio snapshot is connected to this runtime: risk increase is therefore blocked, fail closed.
      canIncreaseRisk: false,
      canReduceRisk: true,
      liveTradingAllowed: false,
      alerts: state.status === 'TRIPPED' ? [{ code: 'KILL_SWITCH_LATCHED', severity: 'trip' }] : [],
    };
  }

  /** eToro status. Without the service, the broker is reported as not configured; no request is sent. */
  async etoroStatus(): Promise<unknown> {
    const etoro = this.deps.etoro ?? null;
    if (etoro === null) {
      return { etoro: { configured: false, tradingMode: 'demo', connection: 'not_connected', access: 'read_only', accountIdentity: 'not_observed', lastSuccessfulSync: null, lastErrorCode: null } };
    }
    return etoro.status();
  }

  async etoroSync(): Promise<unknown> {
    const etoro = this.deps.etoro ?? null;
    if (etoro === null) throw new BrokerError('BROKER_NOT_CONNECTED', 'eToro read-only sync is not enabled');
    return etoro.sync();
  }

  async etoroSnapshot(): Promise<unknown> {
    const etoro = this.deps.etoro ?? null;
    return { snapshot: etoro === null ? null : await etoro.latestSnapshot() };
  }

  async etoroReconciliation(requireFresh: boolean): Promise<unknown> {
    const etoro = this.deps.etoro ?? null;
    return { reconciliation: etoro === null ? null : await etoro.latestReconciliation(requireFresh) };
  }
}

export function createRuntimeServices(deps: RuntimeDeps): RuntimeServices {
  return new RuntimeServiceImpl(deps);
}

export { type RuntimeHealth };
