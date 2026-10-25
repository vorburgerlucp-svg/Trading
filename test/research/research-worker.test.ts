// R1 research worker (in-memory stores, scripted provider, no network).
import { describe, expect, it } from 'vitest';
import { InstrumentRegistry } from '../../src/market-data/instrument-registry.js';
import { RESEARCH_SOURCE_ID } from '../../src/research/research-catalog.js';
import { InMemoryWorkerLock } from '../../src/research/research-lock.js';
import { researchRunLogName, type ResearchRunRecord } from '../../src/research/research-run-log.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore, type LogRecord, type WriteDecision } from '../../src/persistence/append-only-log.js';
import { CreditBudget, guardedFetch } from '../../src/research/research-budget.js';
import { parseUtc } from '../../src/market-data/time.js';
import { AAPL_ENTRY, BTC_ENTRY, MSFT_ENTRY, allRunRecords, catalogOf, harness, memoryStores, FakeClock, ScriptedTwelveData } from './research-fixtures.js';

const TODAY = researchRunLogName(parseUtc('2026-10-07T12:00:00Z'));
const YESTERDAY = researchRunLogName(parseUtc('2026-10-06T12:00:00Z'));
const series = (instrumentId: string, session: 'regular' | 'continuous', asOf = '2026-10-08T00:00:00Z') => ({ instrumentId, source: RESEARCH_SOURCE_ID, interval: '15m' as const, session, adjustment: 'raw' as const, asOf });

describe('R1 worker: collecting completed 15-minute bars', () => {
  it('first run: only completed bars within the catch-up window; late-fetched bars stay historical reconstructions', async () => {
    const h = harness();
    const out = await h.run();
    expect(out).toMatchObject({ kind: 'finished', status: 'completed' });
    if (out.kind !== 'finished') throw new Error();
    const [aapl, btc] = out.instruments;
    // 15:31:30Z: the bar 15:15-15:30 is complete (settle 60 s); the window is 13:31:30 back (2 h): starts 13:45 .. 15:15.
    expect(aapl).toMatchObject({ instrumentId: 'rsx_xnas_aapl', outcome: 'fetched', from: '2026-10-07T13:45:00.000Z', to: '2026-10-07T15:30:00.000Z', finalBars: 7, inserted: 7, droppedInProgress: 0 });
    expect(btc).toMatchObject({ instrumentId: 'rsx_crypto_btcusd', outcome: 'fetched', finalBars: 7, inserted: 7 });
    const bars = await h.stores.marketData.readBars(series('rsx_xnas_aapl', 'regular'));
    expect(bars).toHaveLength(7);
    expect(bars.every((b) => b.isFinal && b.knowledge.knownAt === b.retrievedAt && b.knowledge.knowledgeSource === 'captured_by_nexus')).toBe(true);
    // Only the bar fetched within its 15-minute capture window is a live observation; the backfilled bars are reconstructions.
    expect(bars.map((b) => b.knowledge.vintage)).toEqual([...Array(6).fill('historical_reconstruction'), 'contemporaneous']);
    expect(aapl).toMatchObject({ contemporaneous: 1, historicalReconstruction: 6 });
    expect(out.creditsUsed).toBe(2);
    expect(h.transport.calls).toHaveLength(2);
  });

  it('a bar observed only via a later backfill is never presented as live, also in decision-time replay', async () => {
    const h = harness();
    await h.run();
    const decisionTime = await h.stores.marketData.readBars({ ...series('rsx_xnas_aapl', 'regular', '2026-10-07T14:20:00Z'), replay: 'decision_time' });
    // At 14:20 NEXUS held none of these bars (it fetched them at 15:31:30): a decision at 14:20 sees nothing.
    expect(decisionTime).toEqual([]);
  });

  it('next run 15 minutes later fetches exactly the one new bar, captured live', async () => {
    const h = harness();
    await h.run();
    h.clock.set('2026-10-07T15:46:30Z');
    const out = await h.run();
    if (out.kind !== 'finished') throw new Error();
    expect(out.instruments[0]).toMatchObject({ outcome: 'fetched', from: '2026-10-07T15:30:00.000Z', to: '2026-10-07T15:45:00.000Z', inserted: 1, contemporaneous: 1, historicalReconstruction: 0 });
  });

  it('a repeated run with nothing new is idempotent: no request, no credit, nothing stored twice', async () => {
    const h = harness();
    await h.run();
    const calls = h.transport.calls.length;
    const out = await h.run();
    if (out.kind !== 'finished') throw new Error();
    expect(out.status).toBe('completed');
    expect(out.instruments.map((i) => i.outcome)).toEqual(['up_to_date', 'up_to_date']);
    expect(out.creditsUsed).toBe(0);
    expect(h.transport.calls.length).toBe(calls);
    expect(await h.stores.marketData.readBars(series('rsx_xnas_aapl', 'regular'))).toHaveLength(7);
  });

  it('outside the trading session no stock request is made (no credit spent); crypto continues', async () => {
    const h = harness({ clock: new FakeClock('2026-10-10T15:31:30Z') }); // Saturday
    const out = await h.run();
    if (out.kind !== 'finished') throw new Error();
    expect(out.instruments[0]).toMatchObject({ instrumentId: 'rsx_xnas_aapl', outcome: 'up_to_date', requests: 0 });
    expect(out.instruments[1]).toMatchObject({ instrumentId: 'rsx_crypto_btcusd', outcome: 'fetched' });
    expect(h.transport.calls.map((u) => u.searchParams.get('symbol'))).toEqual(['BTC/USD']);
  });

  it('a gap older than the catch-up window is recorded, not silently filled', async () => {
    const h = harness();
    await h.run();
    h.clock.set('2026-10-08T15:31:30Z'); // a day later, catch-up 2 h
    const out = await h.run();
    if (out.kind !== 'finished') throw new Error();
    expect(out.instruments[1]).toMatchObject({ instrumentId: 'rsx_crypto_btcusd', outcome: 'fetched', gapBefore: '2026-10-08T13:45:00.000Z' });
  });

  it('an invalid provider row is quarantined, never stored as a bar', async () => {
    const h = harness({ catalog: catalogOf([BTC_ENTRY]) });
    h.transport.invalidRow.add('BTC/USD');
    const out = await h.run();
    if (out.kind !== 'finished') throw new Error();
    expect(out.instruments[0]!.quarantined).toBeGreaterThan(0);
    expect(await h.stores.marketData.quarantined('rsx_crypto_btcusd')).not.toHaveLength(0);
    const bars = await h.stores.marketData.readBars(series('rsx_crypto_btcusd', 'continuous'));
    expect(bars.every((b) => b.high.gte(b.low))).toBe(true);
  });
});

describe('R1 worker: fail-closed gates', () => {
  it('without a documented data clearance nothing is fetched or stored', async () => {
    const h = harness({ settings: { dataClearance: null } });
    const out = await h.run();
    expect(out).toMatchObject({ kind: 'finished', status: 'license_not_cleared', creditsUsed: 0 });
    expect(h.transport.calls).toHaveLength(0);
    expect((await InstrumentRegistry.open(h.stores.instruments)).list()).toEqual([]);
  });

  it('low free memory: the run is skipped before the lock, the registry or any request', async () => {
    const lock = new InMemoryWorkerLock();
    const h = harness({ freeMemoryMb: 1500, lock });
    expect(await h.run()).toMatchObject({ kind: 'skipped', reason: 'LOW_MEMORY' });
    expect(h.transport.calls).toHaveLength(0);
    expect(await lock.tryAcquire()).not.toBeNull(); // the lock was never taken
    const records = await allRunRecords(h.stores, [TODAY]);
    expect(records).toEqual([expect.objectContaining({ kind: 'run_skipped', reason: 'LOW_MEMORY' })]);
  });

  it('another worker holds the lock: skipped, nothing fetched', async () => {
    const lock = new InMemoryWorkerLock();
    const held = await lock.tryAcquire();
    const h = harness({ lock });
    expect(await h.run()).toMatchObject({ kind: 'skipped', reason: 'LOCK_HELD' });
    expect(h.transport.calls).toHaveLength(0);
    await held!.release();
    expect(await h.run()).toMatchObject({ kind: 'finished', status: 'completed' });
  });

  it('a registry instrument that differs from the catalog stops the run before any request', async () => {
    const h = harness();
    const registry = await InstrumentRegistry.open(h.stores.instruments);
    await registry.registerWithMapping(
      { assetClass: 'stock', symbol: 'AAPL', name: 'Something else', currency: 'USD', exchange: 'NASDAQ', mic: 'XNAS', timezone: 'America/New_York', tradingCalendar: 'XNAS', active: true, instrumentId: 'rsx_xnas_aapl' },
      { provider: 'twelvedata', providerSymbol: 'AAPL', validFrom: '2026-01-01T00:00:00.000Z' },
      { at: '2026-10-01T00:00:00Z', by: { kind: 'human', id: 'test' }, reason: 'test' },
    );
    const out = await h.run();
    expect(out).toMatchObject({ kind: 'finished', status: 'catalog_mismatch', creditsUsed: 0 });
    expect(h.transport.calls).toHaveLength(0);
  });

  it('a repeated run accepts the instruments it registered itself (catalog = registry)', async () => {
    const h = harness();
    await h.run();
    h.clock.advance(15 * 60_000);
    expect(await h.run()).toMatchObject({ kind: 'finished', status: 'completed' });
    expect((await InstrumentRegistry.open(h.stores.instruments)).list()).toHaveLength(2);
  });
});

describe('R1 worker: credit budget, deadline, failures', () => {
  it('daily budget: the request that would exceed it is not sent; the rest is skipped', async () => {
    const h = harness({ catalog: catalogOf([AAPL_ENTRY, MSFT_ENTRY, BTC_ENTRY]), settings: { budget: { dailyCredits: 1, minuteCredits: 6 } } });
    const out = await h.run();
    if (out.kind !== 'finished') throw new Error();
    expect(out.status).toBe('budget_exhausted');
    expect(out.instruments.map((i) => [i.instrumentId, i.outcome, i.errorCode])).toEqual([
      ['rsx_xnas_aapl', 'fetched', undefined],
      ['rsx_xnas_msft', 'failed', 'DAILY_BUDGET_EXHAUSTED'],
      ['rsx_crypto_btcusd', 'skipped', undefined],
    ]);
    expect(h.transport.calls).toHaveLength(1);
    expect(out.creditsUsed).toBe(1);
  });

  it('the daily budget counts the credits of earlier runs of the same UTC day, also of a crashed run', async () => {
    const h = harness({ catalog: catalogOf([BTC_ENTRY]), settings: { budget: { dailyCredits: 2, minuteCredits: 6 } } });
    await h.run();
    h.clock.advance(15 * 60_000);
    await h.run();
    h.clock.advance(15 * 60_000);
    const out = await h.run();
    expect(out).toMatchObject({ kind: 'finished', status: 'budget_exhausted', creditsUsed: 0 });
    expect(h.transport.calls).toHaveLength(2);
    // The next UTC day has a fresh budget.
    h.clock.set('2026-10-08T00:16:30Z');
    expect(await h.run()).toMatchObject({ kind: 'finished', status: 'completed' });
  });

  it('minute budget: waits for the window when the deadline allows it', async () => {
    const h = harness({ catalog: catalogOf([AAPL_ENTRY, BTC_ENTRY]), settings: { budget: { dailyCredits: 400, minuteCredits: 1 } } });
    const out = await h.run();
    expect(out).toMatchObject({ kind: 'finished', status: 'completed', creditsUsed: 2 });
    expect(h.clock.slept.some((ms) => ms >= 59_000 && ms <= 60_000)).toBe(true);
  });

  it('minute budget: refuses when waiting would pass the run deadline', async () => {
    const h = harness({ catalog: catalogOf([AAPL_ENTRY, BTC_ENTRY]), settings: { budget: { dailyCredits: 400, minuteCredits: 1 }, maxRunMs: 40_000 } });
    const out = await h.run();
    if (out.kind !== 'finished') throw new Error();
    expect(out.status).toBe('budget_exhausted');
    expect(out.instruments[1]).toMatchObject({ outcome: 'failed', errorCode: 'MINUTE_BUDGET_EXHAUSTED' });
    expect(h.transport.calls).toHaveLength(1);
  });

  it('deadline: instruments not reached are skipped and the run says so', async () => {
    const h = harness({ catalog: catalogOf([AAPL_ENTRY, MSFT_ENTRY, BTC_ENTRY]), settings: { maxRunMs: 60_000 } });
    h.transport.beforeAnswer = () => h.clock.advance(55_000);
    const out = await h.run();
    if (out.kind !== 'finished') throw new Error();
    expect(out.status).toBe('deadline_reached');
    expect(out.instruments.map((i) => i.outcome)).toEqual(['fetched', 'skipped', 'skipped']);
  });

  it('a provider failure of one instrument is recorded; the others continue; every attempt costs a reserved credit', async () => {
    const h = harness({ catalog: catalogOf([AAPL_ENTRY, BTC_ENTRY]) });
    const busy = { status: 503, body: 'busy' };
    h.transport.failures.set('AAPL', [busy, busy, busy, busy, busy, busy]);
    const out = await h.run();
    if (out.kind !== 'finished') throw new Error();
    expect(out.status).toBe('completed');
    expect(out.instruments[0]).toMatchObject({ outcome: 'failed', errorCode: 'MARKET_DATA_PROVIDER_UNAVAILABLE' });
    expect(out.instruments[1]).toMatchObject({ outcome: 'fetched' });
    expect(out.creditsUsed).toBe(h.transport.calls.length);
  });
});

describe('R1 worker: crash and restart', () => {
  /** An in-memory log store that fails every write after `after` writes (power loss after N records). */
  class FailingAfter<T> extends InMemoryAppendOnlyStore<T> {
    constructor(public after: number) {
      super();
    }
    override writeExclusive<R>(knownSequence: number, decide: (newer: readonly LogRecord<T>[]) => WriteDecision<T, R>): Promise<R> {
      if (this.after-- <= 0) return Promise.reject(new Error('simulated crash'));
      return super.writeExclusive(knownSequence, decide);
    }
  }

  it('a run that died after storing bars is recorded as abandoned by the next run; the data is not duplicated', async () => {
    const stores = memoryStores();
    // The crashing run: its run log accepts 'started' and one credit reservation, then fails.
    const crashing = new FailingAfter<ResearchRunRecord>(2);
    const crashStores = { ...stores, openRunLog: async (name: string) => (name === TODAY ? AppendOnlyLog.open<ResearchRunRecord>(name, crashing) : stores.openRunLog(name)) };
    const lock = new InMemoryWorkerLock();
    const h1 = harness({ stores: crashStores, lock, catalog: catalogOf([BTC_ENTRY]) });
    await expect(h1.run()).rejects.toThrow('simulated crash');
    expect(await lock.tryAcquire().then((l) => l?.release().then(() => true))).toBe(true); // the lock was released
    // The restarted instance reads the surviving records (copied from the crashed store).
    crashing.after = Number.POSITIVE_INFINITY;
    stores.runStores.set(TODAY, crashing);
    const h2 = harness({ stores, lock, catalog: catalogOf([BTC_ENTRY]) });
    const out = await h2.run();
    expect(out).toMatchObject({ kind: 'finished', status: 'completed', abandonedRuns: [expect.stringMatching(/-run-1$/)] });
    expect(await allRunRecords(stores, [YESTERDAY, TODAY])).toContainEqual(expect.objectContaining({ kind: 'run_abandoned', abandonedRunId: expect.stringMatching(/-run-1$/) }));
    // The crashed run had stored its bars; the restart found them and fetched only what was still missing.
    const bars = await stores.marketData.readBars(series('rsx_crypto_btcusd', 'continuous'));
    expect(new Set(bars.map((b) => b.startTime)).size).toBe(bars.length);
    expect(bars).toHaveLength(7);
    if (out.kind === 'finished') expect(out.instruments[0]!.outcome).toBe('up_to_date');
  });
});

describe('R1 egress and provider surface', () => {
  async function guarded() {
    const clock = new FakeClock('2026-10-07T15:31:30Z');
    const log = await AppendOnlyLog.inMemory<ResearchRunRecord>(TODAY);
    const budget = new CreditBudget({ budget: { dailyCredits: 10, minuteCredits: 6 }, runId: 'run-x', log, records: () => log.all().map((r) => r.payload), clock: clock.now, sleep: clock.sleep, deadlineMs: clock.ms + 60_000 });
    const transport = new ScriptedTwelveData();
    const fetch = guardedFetch(transport.fetch, budget);
    const get = (url: string) => fetch(url, { method: 'GET', headers: {}, signal: new AbortController().signal });
    return { get, transport, log };
  }

  it('the guarded fetch refuses any other origin or endpoint, before reserving a credit and before any request', async () => {
    const { get, transport, log } = await guarded();
    await expect(get('https://api.etoro.com/api/v1/trading/execution/demo/market-open-orders/by-amount')).rejects.toThrow(/only reaches/);
    await expect(get('https://api.twelvedata.com.evil.example/time_series')).rejects.toThrow(/only reaches/);
    await expect(get('http://api.twelvedata.com/time_series')).rejects.toThrow(/only reaches/);
    await expect(get('https://api.twelvedata.com/quote?symbol=AAPL')).rejects.toThrow(/not allowed/);
    await expect(get('https://api.twelvedata.com/constructor')).rejects.toThrow(/not allowed/);
    expect(transport.calls).toHaveLength(0);
    expect(log.size).toBe(0);
  });

  it('an allowed request reserves its credit in the run log before it is sent', async () => {
    const { get, transport, log } = await guarded();
    transport.beforeAnswer = () => {
      expect(log.all().map((r) => r.payload.kind)).toEqual(['credit_reserved']);
    };
    await get('https://api.twelvedata.com/time_series?symbol=BTC/USD&interval=15min&timezone=UTC&adjust=none&start_date=2026-10-07T15:00:00&end_date=2026-10-07T15:30:00');
    expect(transport.calls).toHaveLength(1);
  });
});

describe('R1 worker: unknown request results, stale answers, unavailable database', () => {
  it('a run that dies while a request is outstanding: the reserved credit still counts, the restart re-fetches idempotently', async () => {
    const stores = memoryStores();
    const store = new InMemoryAppendOnlyStore<ResearchRunRecord>();
    stores.runStores.set(TODAY, store);
    const lock = new InMemoryWorkerLock();
    const h1 = harness({ stores, lock, catalog: catalogOf([BTC_ENTRY]), settings: { budget: { dailyCredits: 2, minuteCredits: 6 } } });
    // The process dies during the request: the answer is never processed (the transport rejects with an unclassified error,
    // and the protocol store refuses every later write, as after power loss).
    let crashed = false;
    h1.transport.beforeAnswer = () => {
      crashed = true;
      (store as unknown as { writeExclusive: () => Promise<never> }).writeExclusive = () => Promise.reject(new Error('simulated power loss'));
      throw new Error('simulated power loss');
    };
    await expect(h1.run()).rejects.toThrow('simulated power loss');
    expect(crashed).toBe(true);
    delete (store as unknown as { writeExclusive?: unknown }).writeExclusive; // the prototype method again
    const h2 = harness({ stores, lock, catalog: catalogOf([BTC_ENTRY]), settings: { budget: { dailyCredits: 2, minuteCredits: 6 } } });
    const out = await h2.run();
    // One credit was reserved before the lost request; one is left for the restart.
    expect(out).toMatchObject({ kind: 'finished', status: 'completed', creditsUsed: 1, abandonedRuns: [expect.stringMatching(/-run-1$/)] });
    h2.clock.advance(15 * 60_000);
    expect(await h2.run()).toMatchObject({ kind: 'finished', status: 'budget_exhausted' });
    const bars = await stores.marketData.readBars(series('rsx_crypto_btcusd', 'continuous'));
    expect(new Set(bars.map((b) => b.startTime)).size).toBe(bars.length);
  });

  it('a provider that has no data yet (or only older bars) stores nothing; the next run asks again for the same window', async () => {
    const h = harness({ catalog: catalogOf([BTC_ENTRY]) });
    h.transport.failures.set('BTC/USD', [{ status: 400, body: { code: 400, message: 'No data is available on the specified dates.', status: 'error' } }]);
    const first = await h.run();
    if (first.kind !== 'finished') throw new Error();
    expect(first.instruments[0]).toMatchObject({ outcome: 'fetched', finalBars: 0, inserted: 0 });
    const second = await h.run();
    if (second.kind !== 'finished') throw new Error();
    expect(second.instruments[0]).toMatchObject({ outcome: 'fetched', from: first.instruments[0]!.from, inserted: 7 });
  });

  it('the research database is unavailable: the connection check fails before anything else', async () => {
    const { openResearchPool, assertResearchDatabase } = await import('../../src/research/research-postgres.js');
    const pool = openResearchPool('postgres://nexus_research_app:x@127.0.0.1:1/nexus_research', { readOnly: false, applicationName: 'nexus-research-test' });
    try {
      await expect(assertResearchDatabase(pool, { name: 'nexus_research', user: 'nexus_research_app' })).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });
});

describe('R1 worker: run ids are used once', () => {
  it('a run whose id was already used (another process) stops before fetching; nothing merges into the earlier run', async () => {
    const stores = memoryStores();
    const first = harness({ stores, catalog: catalogOf([BTC_ENTRY]), runIdPrefix: 'same' });
    await first.run();
    const second = harness({ stores, catalog: catalogOf([BTC_ENTRY]), runIdPrefix: 'same' });
    second.clock.advance(15 * 60_000);
    // The reused id collides with the earlier run's records: the run fails (the log refuses a different record under an existing
    // id), and it fails before any request.
    await expect(second.run()).rejects.toThrow(/idempotency|already/i);
    expect(second.transport.calls).toHaveLength(0);
    expect(await second.lock.tryAcquire()).not.toBeNull(); // the lock was released
  });
});

describe('R1 worker: settlement and identical run ids (mutation findings)', () => {
  it('a bar is not requested before its settlement delay has passed (30 s after its end: the previous bar is the latest)', async () => {
    const h = harness({ catalog: catalogOf([BTC_ENTRY]), clock: new FakeClock('2026-10-07T15:30:30Z') });
    const out = await h.run();
    if (out.kind !== 'finished') throw new Error();
    // The bar 15:15-15:30 ended 30 s ago, the provider settles after 60 s: it is not complete yet and is not requested.
    expect(out.instruments[0]).toMatchObject({ outcome: 'fetched', to: '2026-10-07T15:15:00.000Z', droppedInProgress: 0 });
  });

  it('a second process with the same run id and the same clock (identical start record) stops before any request', async () => {
    const stores = memoryStores();
    const crashing = new InMemoryAppendOnlyStore<ResearchRunRecord>();
    stores.runStores.set(TODAY, crashing);
    const first = harness({ stores, catalog: catalogOf([BTC_ENTRY]), runIdPrefix: 'same' });
    first.transport.beforeAnswer = () => {
      throw new Error('simulated crash');
    };
    (crashing as unknown as { writeExclusive: unknown }).writeExclusive = ((orig) =>
      function (this: unknown, ...args: unknown[]) {
        const kind = (args as [number, (n: readonly unknown[]) => { kind: string; record?: { payload: { kind: string } } }])[1]([]);
        if (kind.kind === 'append' && kind.record?.payload.kind === 'run_finished') return Promise.reject(new Error('simulated crash'));
        return (orig as (...a: unknown[]) => Promise<unknown>).apply(crashing, args);
      })(InMemoryAppendOnlyStore.prototype.writeExclusive);
    await expect(first.run()).rejects.toThrow('simulated crash');
    delete (crashing as unknown as { writeExclusive?: unknown }).writeExclusive;
    const second = harness({ stores, catalog: catalogOf([BTC_ENTRY]), runIdPrefix: 'same' });
    await expect(second.run()).rejects.toThrow(/already used/);
    expect(second.transport.calls).toHaveLength(0);
    // Nothing was merged into the first run's protocol: no finish record under its id.
    expect((await crashing.loadAll()).map((r) => r.id).filter((id) => id.startsWith('same-run-1:finished'))).toEqual([]);
  });
});
