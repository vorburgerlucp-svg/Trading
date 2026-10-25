// R1 test fixtures: a scripted Twelve Data transport (no network), a controllable clock, and a worker harness over in-memory or
// PostgreSQL stores. TEST ONLY.
import type { InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import { InMemoryMarketDataStore, type MarketDataStore } from '../../src/market-data/market-data-store.js';
import { TwelveDataMarketDataProvider } from '../../src/market-data/providers/twelve-data.js';
import type { FetchLike, ResilienceDeps } from '../../src/market-data/providers/resilience.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { parseUtc, toUtcIso } from '../../src/market-data/time.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore, type AppendOnlyStore } from '../../src/persistence/append-only-log.js';
import { parseResearchCatalog, RESEARCH_SOURCE_ID, type ResearchCatalog } from '../../src/research/research-catalog.js';
import { DEFAULT_RESEARCH_LIMITS } from '../../src/research/research-config.js';
import { InMemoryWorkerLock, type WorkerLock } from '../../src/research/research-lock.js';
import type { ResearchRunRecord } from '../../src/research/research-run-log.js';
import { runResearchOnce, type ResearchWorkerDeps, type ResearchWorkerSettings } from '../../src/research/research-worker.js';
import { bodyOf, responseWith } from '../financial/http-body-fixtures.js';

export const AAPL_ENTRY = { instrumentId: 'rsx_xnas_aapl', assetClass: 'stock', symbol: 'AAPL', name: 'Apple Inc', currency: 'USD', exchange: 'NASDAQ', mic: 'XNAS', timezone: 'America/New_York', tradingCalendar: 'XNAS', providerSymbol: 'AAPL', mappingValidFrom: '2026-01-01T00:00:00.000Z' };
export const MSFT_ENTRY = { ...AAPL_ENTRY, instrumentId: 'rsx_xnas_msft', symbol: 'MSFT', name: 'Microsoft Corp', providerSymbol: 'MSFT' };
export const BTC_ENTRY = { instrumentId: 'rsx_crypto_btcusd', assetClass: 'crypto', symbol: 'BTC/USD', currency: 'USD', timezone: 'UTC', tradingCalendar: '24x7', providerSymbol: 'BTC/USD', mappingValidFrom: '2026-01-01T00:00:00.000Z' };

export function catalogOf(entries: readonly object[], catalogId = 'test-catalog'): ResearchCatalog {
  return parseResearchCatalog(JSON.stringify({ version: 'research-catalog:v1', catalogId, interval: '15m', instruments: entries }));
}

export const SETTINGS: ResearchWorkerSettings = Object.freeze({
  budget: { dailyCredits: DEFAULT_RESEARCH_LIMITS.dailyCredits, minuteCredits: DEFAULT_RESEARCH_LIMITS.minuteCredits },
  maxRunMs: 240_000,
  minFreeMemoryMb: 2048,
  maxCatchUpMs: 2 * 3_600_000,
  dataClearance: 'TEST clearance: scripted transport, no provider data',
  codeVersion: 'unversioned',
});

const META: Record<string, Record<string, unknown>> = {
  AAPL: { symbol: 'AAPL', interval: '15min', currency: 'USD', exchange_timezone: 'America/New_York', exchange: 'NASDAQ', mic_code: 'XNGS', type: 'Common Stock' },
  MSFT: { symbol: 'MSFT', interval: '15min', currency: 'USD', exchange_timezone: 'America/New_York', exchange: 'NASDAQ', mic_code: 'XNGS', type: 'Common Stock' },
  'BTC/USD': { symbol: 'BTC/USD', interval: '15min', currency: 'USD', exchange_timezone: 'UTC', type: 'Digital Currency' },
};
const CALENDAR: Record<string, string> = { AAPL: 'XNAS', MSFT: 'XNAS', 'BTC/USD': '24x7' };

export type ScriptedFailure = { status: number; body: unknown } | Error;

/** A scripted Twelve Data /time_series: deterministic 15-minute bars for the requested UTC window, on the instrument's calendar. */
export class ScriptedTwelveData {
  readonly calls: URL[] = [];
  /** Per symbol: failures returned (in order) before normal answers. */
  readonly failures = new Map<string, ScriptedFailure[]>();
  /** Per symbol: an invalid row (high below low) appended to every answer. */
  readonly invalidRow = new Set<string>();
  /** Called before each answer (e.g. to advance the clock or to block). */
  beforeAnswer: (url: URL) => Promise<void> | void = () => undefined;

  readonly fetch: FetchLike = async (url) => {
    const u = new URL(url);
    this.calls.push(u);
    await this.beforeAnswer(u);
    const symbol = u.searchParams.get('symbol') ?? '';
    const queued = this.failures.get(symbol);
    if (queued && queued.length > 0) {
      const failure = queued.shift()!;
      if (failure instanceof Error) throw failure;
      return responseWith({ status: failure.status, body: bodyOf(JSON.stringify(failure.body)) });
    }
    if (u.pathname !== '/time_series' || u.searchParams.get('interval') !== '15min' || u.searchParams.get('timezone') !== 'UTC' || u.searchParams.get('adjust') !== 'none') {
      return responseWith({ status: 400, body: bodyOf(JSON.stringify({ code: 400, message: 'unexpected request in test', status: 'error' })) });
    }
    const calendar = getCalendar(CALENDAR[symbol]!)!;
    const from = parseUtc(u.searchParams.get('start_date')! + 'Z');
    const to = parseUtc(u.searchParams.get('end_date')! + 'Z');
    const values: Array<Record<string, string>> = [];
    for (let s = calendar.firstBarStartAtOrAfter(from, '15m', 'regular'); s !== null && s < to; s = calendar.nextBarStart(s, '15m', 'regular')) {
      const price = (100 + ((s / 900_000) % 50)).toFixed(2);
      values.push({ datetime: toUtcIso(s).slice(0, 19).replace('T', ' '), open: price, high: price, low: price, close: price, volume: '1000' });
    }
    if (this.invalidRow.has(symbol) && values.length > 0) values.push({ ...values[values.length - 1]!, high: '1', low: '2' });
    if (values.length === 0) return responseWith({ status: 400, body: bodyOf(JSON.stringify({ code: 400, message: 'No data is available on the specified dates. Try setting different start/end dates.', status: 'error' })) });
    return responseWith({ status: 200, body: bodyOf(JSON.stringify({ meta: META[symbol], values, status: 'ok' })) });
  };
}

export class FakeClock {
  ms: number;
  readonly slept: number[] = [];
  constructor(iso: string) {
    this.ms = parseUtc(iso);
  }
  readonly now = () => new Date(this.ms);
  set(iso: string): void {
    this.ms = parseUtc(iso);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  readonly sleep = async (ms: number) => {
    this.slept.push(ms);
    this.ms += ms;
  };
}

export interface HarnessStores {
  instruments: AppendOnlyStore<InstrumentEvent>;
  marketData: MarketDataStore;
  openRunLog: (name: string) => Promise<AppendOnlyLog<ResearchRunRecord>>;
}

/** In-memory stores whose run logs survive between runs (same underlying store per log name). */
export function memoryStores(): HarnessStores & { runStores: Map<string, InMemoryAppendOnlyStore<ResearchRunRecord>> } {
  const runStores = new Map<string, InMemoryAppendOnlyStore<ResearchRunRecord>>();
  return {
    instruments: new InMemoryAppendOnlyStore<InstrumentEvent>(),
    marketData: new InMemoryMarketDataStore(),
    runStores,
    openRunLog: async (name) => {
      if (!runStores.has(name)) runStores.set(name, new InMemoryAppendOnlyStore<ResearchRunRecord>());
      return AppendOnlyLog.open<ResearchRunRecord>(name, runStores.get(name)!);
    },
  };
}

export interface HarnessOptions {
  catalog?: ResearchCatalog;
  settings?: Partial<ResearchWorkerSettings>;
  stores?: HarnessStores;
  lock?: WorkerLock;
  transport?: ScriptedTwelveData;
  clock?: FakeClock;
  freeMemoryMb?: number;
  /** Prefix of the run ids (default: unique per harness in this process). Separate processes must pass their own. */
  runIdPrefix?: string;
}

let harnesses = 0;

/** A worker harness. Run ids are unique per harness ("h<N>-run-<M>"), as real run ids are unique per process. */
export function harness(options: HarnessOptions = {}) {
  const clock = options.clock ?? new FakeClock('2026-10-07T15:31:30Z');
  const transport = options.transport ?? new ScriptedTwelveData();
  const stores = options.stores ?? memoryStores();
  const lock = options.lock ?? new InMemoryWorkerLock();
  const resilience: ResilienceDeps = { now: () => clock.ms, sleep: clock.sleep, random: () => 0.5 };
  const prefix = (options.runIdPrefix ?? 'h' + ++harnesses) + '-run-';
  let runs = 0;
  const deps = (): ResearchWorkerDeps => ({
    catalog: options.catalog ?? catalogOf([AAPL_ENTRY, BTC_ENTRY]),
    settings: { ...SETTINGS, ...options.settings },
    openRunLog: stores.openRunLog,
    instruments: stores.instruments,
    marketData: stores.marketData,
    lock,
    providerWith: (fetch) =>
      new TwelveDataMarketDataProvider({ apiKey: 'test-key-r1', environment: 'production', fetch, clock: clock.now, deps: resilience, resilience: { timeoutMs: 5_000 }, license: 'internal_use', licenseNote: 'R1 test' }),
    fetch: transport.fetch,
    sourceId: RESEARCH_SOURCE_ID,
    clock: clock.now,
    sleep: clock.sleep,
    freeMemoryMb: () => options.freeMemoryMb ?? 8192,
    newRunId: () => prefix + ++runs,
  });
  return { clock, transport, stores, lock, deps, run: () => runResearchOnce(deps()) };
}

/** Every record of every run log of the stores, in log order. */
export async function allRunRecords(stores: HarnessStores, names: readonly string[]): Promise<ResearchRunRecord[]> {
  const out: ResearchRunRecord[] = [];
  for (const name of names) out.push(...(await stores.openRunLog(name)).all().map((r) => r.payload));
  return out;
}
