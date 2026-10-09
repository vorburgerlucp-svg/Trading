import { describe, expect, it } from 'vitest';
import { InMemoryMarketDataStore, type MarketDataStore } from '../../src/market-data/market-data-store.js';
import { splitAdjustBars, type SplitAdjustmentResult } from '../../src/market-data/corporate-actions.js';
import type { CorporateAction, CorporateActionKnowledge, ProviderInstrumentMapping } from '../../src/market-data/market-data-types.js';
import { TwelveDataMarketDataProvider } from '../../src/market-data/providers/twelve-data.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { Decimal } from '../../src/money/decimal.js';
import { AAPL, FIXTURE_SOURCE, dailyBars } from './fixtures.js';

// Review finding F1 (CRITICAL): the Twelve Data adapter used availableAt = min(retrievedAt, exDate 00:00), so a split that
// NEXUS first retrieved on Wednesday looked known on its Monday ex-date. The first block runs the real adapter on a scripted
// HTTP layer. The rest store records directly and replay point-in-time reads through the same code path quant uses.

const XNAS = getCalendar('XNAS')!;
const DAILY = { instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, interval: '1d' as const, session: 'regular' as const, adjustment: 'raw' as const };

// Week of 2026-09-21 (Mon 28 Sep is the ex-date of a 4-for-1 split). Raw closes: 400, 404, 408 | 101, 102, 103.
const RAW_ROWS = ['400', '404', '408', '101', '102', '103'].map((p) => ({ open: p, high: p, low: p, close: p, volume: '1000' }));
const BARS = dailyBars(XNAS, '2026-09-23', RAW_ROWS);
const ADJUSTED_WEDNESDAY_TO_FRIDAY = ['100', '101', '102'];

const FRI_RETRIEVED = '2026-09-25T10:00:00.000Z';
const MON_NOON = '2026-09-28T12:00:00.000Z';
const TUE_NOON = '2026-09-29T12:00:00.000Z';
const WED_RETRIEVED = '2026-09-30T12:00:00.000Z';
const THU_RETRIEVED = '2026-10-01T10:00:00.000Z';
const SUN_NOON = '2026-09-27T12:00:00.000Z';

const captured = (at: string): CorporateActionKnowledge => ({ provenance: 'captured_by_nexus', knowledgeAt: at });

/** A 4-for-1 split on Monday 2026-09-28, first retrieved (and known) at `retrievedAt`. */
function split(retrievedAt: string, over: Partial<CorporateAction> = {}): CorporateAction {
  return {
    actionKey: 'split:2026-09-28',
    instrumentId: AAPL.instrumentId,
    source: FIXTURE_SOURCE.sourceId,
    type: 'split',
    exDate: '2026-09-28',
    ratioFrom: Decimal.from(1),
    ratioTo: Decimal.from(4),
    retrievedAt,
    knowledge: captured(retrievedAt),
    ...over,
  };
}

async function storeWithBars(): Promise<InMemoryMarketDataStore> {
  const store = new InMemoryMarketDataStore();
  await store.registerSource(FIXTURE_SOURCE);
  await store.ingestBars(AAPL, BARS, '2026-10-01T00:00:00Z');
  return store;
}

/** The split-adjusted information series at asOf, built as the quant service builds it (raw bars + known splits). */
async function informationSeries(store: MarketDataStore, asOf: string, storedThrough?: number): Promise<SplitAdjustmentResult> {
  const actions = await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf, storedThrough, types: ['split', 'reverse_split'], purpose: 'information' });
  const raw = await store.readBars({ ...DAILY, asOf, storedThrough });
  return splitAdjustBars(raw, actions, { asOf, calendar: XNAS, purpose: 'information' });
}

const closesOf = (r: SplitAdjustmentResult) => (r.status === 'ok' ? r.bars.map((b) => b.close.toString()) : r.status);

// ---------------------------------------------------------------------------------------------------------------------------
// F1 with the real Twelve Data adapter
// ---------------------------------------------------------------------------------------------------------------------------

const mapping: ProviderInstrumentMapping = { instrumentId: AAPL.instrumentId, provider: 'twelvedata', providerSymbol: 'AAPL', validFrom: '2000-01-01T00:00:00Z' };
const EX_DATE_MONDAY = '2026-09-28';

function scriptedProvider(retrievedAt: string): TwelveDataMarketDataProvider {
  const now = Date.parse(retrievedAt);
  const fetch = async (url: string) => {
    const path = new URL(url).pathname;
    const body =
      path === '/splits'
        ? { meta: { symbol: 'AAPL', currency: 'USD' }, splits: [{ date: EX_DATE_MONDAY, from_factor: 1, to_factor: 4 }] }
        : { meta: { symbol: 'AAPL', currency: 'USD' }, dividends: [] };
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return new TwelveDataMarketDataProvider({
    apiKey: 'test-key-123',
    environment: 'production',
    fetch,
    clock: () => new Date(now),
    deps: { now: () => now, sleep: async () => undefined, random: () => 0.5 },
    resilience: { timeoutMs: 50 },
  });
}

async function storeFromTwelveData(retrievedAt: string): Promise<InMemoryMarketDataStore> {
  const { source, actions } = await scriptedProvider(retrievedAt).getCorporateActions!({ instrument: AAPL, mapping, from: '2026-09-01T00:00:00Z', to: '2026-10-07T00:00:00Z' });
  const store = new InMemoryMarketDataStore();
  await store.registerSource(source);
  await store.ingestCorporateActions(AAPL, actions, retrievedAt);
  return store;
}

describe('F1: a late-retrieved split is not known at its ex-date (Twelve Data backfill)', () => {
  it('a strict information replay on the Monday ex-date does not see a split that NEXUS first retrieved on Wednesday', async () => {
    const store = await storeFromTwelveData(WED_RETRIEVED);
    expect(await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: MON_NOON })).toEqual([]);
  });

  it('a replay on Wednesday, after the retrieval, sees the split', async () => {
    const store = await storeFromTwelveData(WED_RETRIEVED);
    const visible = await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: '2026-09-30T12:00:00.000Z' });
    expect(visible.map((a) => a.actionKey)).toEqual(['split:2026-09-28']);
  });

  it('the adapter writes no availableAt and states its knowledge as its own capture', async () => {
    const store = await storeFromTwelveData(WED_RETRIEVED);
    const [stored] = await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: '2026-09-30T12:00:00.000Z', purpose: 'economic' });
    expect(stored).not.toHaveProperty('availableAt');
    expect(stored!.knowledge).toEqual(captured(WED_RETRIEVED));
    expect(stored!.exDate).toBe(EX_DATE_MONDAY);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Adversarial point-in-time cases (store + adjustment, the path quant and scanner take)
// ---------------------------------------------------------------------------------------------------------------------------

describe('Late retrieval: Monday replay must not show knowledge NEXUS did not have', () => {
  it('Monday: no split known, the series is raw (honest knowledge state, no hindsight)', async () => {
    const store = await storeWithBars();
    await store.ingestCorporateActions(AAPL, [split(WED_RETRIEVED)], WED_RETRIEVED);
    expect(await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: MON_NOON })).toEqual([]);
    expect(closesOf(await informationSeries(store, MON_NOON))).toEqual(['400', '404', '408']);
  });

  it('Wednesday after the retrieval: the split is known and the bars before the ex-date are adjusted', async () => {
    const store = await storeWithBars();
    await store.ingestCorporateActions(AAPL, [split(WED_RETRIEVED)], WED_RETRIEVED);
    expect(closesOf(await informationSeries(store, WED_RETRIEVED))).toEqual(['100', '101', '102', '101', '102']);
  });

  it('economic replay on Monday applies the split on its ex-date, labelled with the capture it rests on', async () => {
    const store = await storeWithBars();
    await store.ingestCorporateActions(AAPL, [split(WED_RETRIEVED)], WED_RETRIEVED);
    const economic = splitAdjustBars(await store.readBars({ ...DAILY, asOf: MON_NOON }), await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: MON_NOON, purpose: 'economic' }), { asOf: MON_NOON, calendar: XNAS, purpose: 'economic' });
    expect(closesOf(economic)).toEqual(ADJUSTED_WEDNESDAY_TO_FRIDAY);
    expect(economic.status === 'ok' && economic.applied.map((a) => [a.exDate, a.provenance, a.knowledgeAt])).toEqual([['2026-09-28', 'captured_by_nexus', WED_RETRIEVED]]);
  });
});

describe('Early retrieval: known from its capture, pending until its ex-date', () => {
  it('known on Friday, pending through the weekend, applied from the ex-date on', async () => {
    const store = await storeWithBars();
    await store.ingestCorporateActions(AAPL, [split(FRI_RETRIEVED)], FRI_RETRIEVED);

    const friday = await informationSeries(store, '2026-09-25T12:00:00.000Z');
    expect(closesOf(friday)).toEqual(['400', '404']);
    expect(friday.pending.map((p) => p.actionKey)).toEqual(['split:2026-09-28']);

    const sunday = await informationSeries(store, SUN_NOON);
    expect(closesOf(sunday)).toEqual(['400', '404', '408']);
    expect(sunday.pending.map((p) => p.actionKey)).toEqual(['split:2026-09-28']);
    expect(sunday.status === 'ok' && sunday.applied).toEqual([]);

    const monday = await informationSeries(store, MON_NOON);
    expect(closesOf(monday)).toEqual(ADJUSTED_WEDNESDAY_TO_FRIDAY);
    expect(monday.status === 'ok' && monday.applied.map((a) => a.knowledgeAt)).toEqual([FRI_RETRIEVED]);
  });
});

describe('Provider publication time: knowledge may precede the capture, and is only the stated time', () => {
  const PUBLISHED_TUESDAY = '2026-09-29T09:00:00.000Z';

  it('is visible from its publication time, not before, although NEXUS retrieved it on Wednesday', async () => {
    const store = await storeWithBars();
    const published: CorporateAction = split(WED_RETRIEVED, { knowledge: { provenance: 'provider_published_at', knowledgeAt: PUBLISHED_TUESDAY } });
    expect(await store.ingestCorporateActions(AAPL, [published], WED_RETRIEVED)).toMatchObject({ inserted: 1 });
    expect(await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: '2026-09-29T08:00:00.000Z' })).toEqual([]);
    const seen = await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: '2026-09-29T10:00:00.000Z' });
    expect(seen.map((a) => [a.knowledge.provenance, a.knowledge.knowledgeAt])).toEqual([['provider_published_at', PUBLISHED_TUESDAY]]);
  });

  it('a publication time after the retrieval is refused: NEXUS cannot have retrieved what was not yet published', async () => {
    const store = await storeWithBars();
    const future = split(WED_RETRIEVED, { knowledge: { provenance: 'provider_published_at', knowledgeAt: THU_RETRIEVED } });
    const result = await store.ingestCorporateActions(AAPL, [future], WED_RETRIEVED);
    expect(result).toMatchObject({ inserted: 0 });
    expect(result.quarantined.map((q) => q.reasons[0]!.code)).toEqual(['future_timestamp']);
    expect(await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: THU_RETRIEVED })).toEqual([]);
  });
});

describe('Revisions: a revision is visible only from its own knowledge time', () => {
  it('replay before the correction shows revision 1; the correction appears from its retrieval; storedThrough pins the past', async () => {
    const store = await storeWithBars();
    await store.ingestCorporateActions(AAPL, [split(FRI_RETRIEVED)], FRI_RETRIEVED);
    const beforeCorrection = await store.head(AAPL.instrumentId);
    await store.ingestCorporateActions(AAPL, [split(WED_RETRIEVED, { ratioTo: Decimal.from(5) })], WED_RETRIEVED);

    const revisionAt = async (asOf: string, storedThrough?: number) =>
      (await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf, storedThrough, purpose: 'information' })).map((a) => [a.revision, a.ratioTo!.toString()]);
    expect(await revisionAt(TUE_NOON)).toEqual([[1, '4']]);
    expect(await revisionAt(THU_RETRIEVED)).toEqual([[2, '5']]);
    expect(await revisionAt(TUE_NOON, beforeCorrection)).toEqual([[1, '4']]);
    expect(await revisionAt(THU_RETRIEVED, beforeCorrection)).toEqual([[1, '4']]);
  });

  it('the series at a past time does not change when a correction is later stored', async () => {
    const store = await storeWithBars();
    await store.ingestCorporateActions(AAPL, [split(FRI_RETRIEVED)], FRI_RETRIEVED);
    const before = await informationSeries(store, TUE_NOON);
    await store.ingestCorporateActions(AAPL, [split(WED_RETRIEVED, { ratioTo: Decimal.from(5) })], WED_RETRIEVED);
    const after = await informationSeries(store, TUE_NOON);
    expect(closesOf(after)).toEqual(closesOf(before));
    expect(closesOf(after)).toEqual(['100', '101', '102', '101']); // Tuesday's bar completes after noon: not in the series
  });

  it('economic replay is ex-post by design: it uses the newest stored revision, labelled as economic', async () => {
    const store = await storeWithBars();
    await store.ingestCorporateActions(AAPL, [split(FRI_RETRIEVED)], FRI_RETRIEVED);
    await store.ingestCorporateActions(AAPL, [split(WED_RETRIEVED, { ratioTo: Decimal.from(5) })], WED_RETRIEVED);
    const economic = await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: TUE_NOON, purpose: 'economic' });
    expect(economic.map((a) => [a.revision, a.ratioTo!.toString()])).toEqual([[2, '5']]);
  });
});

describe('No look-ahead: what becomes known after T leaves the series at T unchanged', () => {
  it('a later correction and a later new split do not change the series or the actions visible at T', async () => {
    const store = await storeWithBars();
    await store.ingestCorporateActions(AAPL, [split(FRI_RETRIEVED)], FRI_RETRIEVED);
    const headAtT = await store.head(AAPL.instrumentId);
    const atT = await informationSeries(store, TUE_NOON);
    const actionsAtT = await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: TUE_NOON, purpose: 'information' });

    // Learned after T: a correction of the split, and an unrelated reverse split on Friday 2 Oct.
    await store.ingestCorporateActions(
      AAPL,
      [
        split(THU_RETRIEVED, { ratioTo: Decimal.from(5) }),
        { actionKey: 'split:2026-10-02:rev', instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, type: 'reverse_split', exDate: '2026-10-02', ratioFrom: Decimal.from(10), ratioTo: Decimal.from(1), retrievedAt: THU_RETRIEVED, knowledge: captured(THU_RETRIEVED) },
      ],
      THU_RETRIEVED,
    );

    expect(closesOf(await informationSeries(store, TUE_NOON))).toEqual(closesOf(atT));
    expect(closesOf(await informationSeries(store, TUE_NOON, headAtT))).toEqual(closesOf(atT));
    expect(await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: TUE_NOON, purpose: 'information' })).toEqual(actionsAtT);
  });
});

describe('Legacy and malformed knowledge are refused at ingest, not repaired', () => {
  it('a fresh record cannot claim legacy_unproven: it is quarantined', async () => {
    const store = await storeWithBars();
    const result = await store.ingestCorporateActions(AAPL, [split(FRI_RETRIEVED, { knowledge: { provenance: 'legacy_unproven', knowledgeAt: null } })], FRI_RETRIEVED);
    expect(result).toMatchObject({ inserted: 0 });
    expect(result.quarantined.map((q) => q.reasons[0]!.code)).toEqual(['invalid_time']);
  });

  it('a captured record must be known exactly at its own retrieval (no earlier or invented knowledge time)', async () => {
    const store = await storeWithBars();
    const earlier = split(FRI_RETRIEVED, { knowledge: captured('2026-09-20T00:00:00.000Z') });
    const result = await store.ingestCorporateActions(AAPL, [earlier], FRI_RETRIEVED);
    expect(result).toMatchObject({ inserted: 0 });
    expect(result.quarantined).toHaveLength(1);
  });

  it('the ex-date is never a knowledge time: a record claiming the ex-date as knowledge is quarantined', async () => {
    const store = await storeWithBars();
    const hindsight = split(WED_RETRIEVED, { knowledge: captured('2026-09-28T00:00:00.000Z') });
    expect(await store.ingestCorporateActions(AAPL, [hindsight], WED_RETRIEVED)).toMatchObject({ inserted: 0 });
    expect(await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: MON_NOON })).toEqual([]);
  });

  it('a record retrieved after the moment NEXUS stored it is quarantined (a capture cannot be in the future)', async () => {
    const store = await storeWithBars();
    const result = await store.ingestCorporateActions(AAPL, [split(THU_RETRIEVED)], WED_RETRIEVED);
    expect(result).toMatchObject({ inserted: 0 });
    expect(result.quarantined.map((q) => q.reasons[0]!.code)).toEqual(['future_timestamp']);
  });
});
