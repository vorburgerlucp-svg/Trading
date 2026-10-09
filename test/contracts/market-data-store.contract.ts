// Contract suite for market data persistence (bars, quotes, corporate actions, quarantine,
// quant runs, instrument registry). Runs unchanged against the in-memory stores and PostgreSQL.

import { afterEach, describe, expect, it } from 'vitest';
import { InstrumentRegistry, type InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import type { MarketDataStore } from '../../src/market-data/market-data-store.js';
import type { CorporateAction, MarketBar, MarketQuote } from '../../src/market-data/market-data-types.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { Decimal } from '../../src/money/decimal.js';
import type { AppendOnlyStore } from '../../src/persistence/append-only-log.js';
import { computeQuant } from '../../src/quant/quant-engine.js';
import { toRunRecord, type QuantRunStore } from '../../src/quant/quant-run-store.js';
import { AAPL, FIXTURE_SOURCE, dailyBars, intradayBars, randomOhlcv, retrievedAs } from '../market-data/fixtures.js';
import { sequentialIds } from '../helpers.js';

export interface MarketDataHarness {
  /** Each call returns a handle onto the SAME storage (a separate NEXUS process for PostgreSQL). */
  store(): Promise<MarketDataStore>;
  quantRuns(): Promise<QuantRunStore>;
  instruments(): Promise<AppendOnlyStore<InstrumentEvent>>;
  /** Privileged change of a stored bar behind NEXUS' back (bypassing application and triggers). */
  tamperBar(instrumentId: string, startTime: string, newClose: string): Promise<void>;
  cleanup(): Promise<void>;
}

const XNAS = getCalendar('XNAS')!;
const SERIES = { instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, interval: '5m' as const, session: 'regular' as const, adjustment: 'raw' as const };
const LATE = '2026-12-01T00:00:00Z';
const HUMAN = { kind: 'human' as const, id: 'luc' };

function bars(n: number, seed = 1): MarketBar[] {
  return intradayBars(XNAS, '2026-10-07T13:30:00Z', '5m', randomOhlcv(n, seed), { retrievedAt: '2026-10-08T00:00:00.000Z' });
}

export function marketDataStoreContract(label: string, makeHarness: () => Promise<MarketDataHarness>): void {
  describe('Market data store contract: ' + label, () => {
    let harness: MarketDataHarness | null = null;
    const open = async () => {
      harness = await makeHarness();
      const store = await harness.store();
      await store.registerSource(FIXTURE_SOURCE);
      return { h: harness, store };
    };
    afterEach(async () => {
      await harness?.cleanup();
      harness = null;
    });

    it('Quelle: idempotent registriert, andere Metadaten = Konflikt, Herkunft bleibt erhalten', async () => {
      const { store } = await open();
      expect(await store.registerSource(FIXTURE_SOURCE)).toBe('ALREADY_APPLIED');
      await expect(store.registerSource({ ...FIXTURE_SOURCE, license: 'redistributable' })).rejects.toMatchObject({ code: 'source_conflict' });
      expect(await store.getSource(FIXTURE_SOURCE.sourceId)).toEqual(FIXTURE_SOURCE);
    });

    it('Bar insert, Read range, final vs. in-progress', async () => {
      const { store } = await open();
      const final = bars(10);
      const forming: MarketBar = retrievedAs({ ...bars(11)[10]!, isFinal: false, availableAt: '2026-10-07T14:22:00.000Z', observedAt: '2026-10-07T14:22:00.000Z' }, '2026-10-07T14:22:00.000Z');
      const r = await store.ingestBars(AAPL, [...final, forming], '2026-10-08T00:00:00Z');
      expect(r).toMatchObject({ inserted: 11, unchanged: 0, providerRevisions: 0, quarantined: [], headSeq: 11 });
      expect((await store.readBars({ ...SERIES, asOf: LATE })).length).toBe(10);
      expect((await store.readBars({ ...SERIES, asOf: LATE, finalOnly: false })).length).toBe(11);
      const window = await store.readBars({ ...SERIES, asOf: LATE, from: '2026-10-07T13:40:00Z', to: '2026-10-07T13:55:00Z' });
      expect(window.map((b) => b.startTime)).toEqual(['2026-10-07T13:40:00.000Z', '2026-10-07T13:45:00.000Z', '2026-10-07T13:50:00.000Z']);
      expect(window[0]!.close.eq(final[2]!.close)).toBe(true);
    });

    it('Duplikat (Backfill liefert denselben Bar erneut) erzeugt keine Dublette', async () => {
      const { store } = await open();
      await store.ingestBars(AAPL, bars(10), '2026-10-08T00:00:00Z');
      const again = bars(10).map((b) => retrievedAs(b, '2026-10-09T00:00:00.000Z'));
      expect(await store.ingestBars(AAPL, again, '2026-10-09T00:00:00Z')).toMatchObject({ inserted: 0, unchanged: 10, headSeq: 10 });
      expect(await store.head(AAPL.instrumentId)).toBe(10);
    });

    it('Provider-Revision: nichts überschrieben, frühere Entscheidungen bleiben reproduzierbar', async () => {
      const { store } = await open();
      await store.ingestBars(AAPL, bars(10), '2026-10-08T00:00:00Z');
      const pinned = await store.head(AAPL.instrumentId);
      const original = bars(10)[3]!;
      const corrected = retrievedAs({ ...original, close: original.close.plus('0.05'), high: original.high.plus('0.05') }, '2026-10-20T00:00:00.000Z');
      expect(await store.ingestBars(AAPL, [corrected], '2026-10-20T00:00:00Z')).toMatchObject({ inserted: 1, providerRevisions: 1 });
      const at = (asOf: string, storedThrough?: number) => store.readBars({ ...SERIES, asOf, ...(storedThrough !== undefined ? { storedThrough } : {}) }).then((b) => b[3]!);
      expect((await at('2026-10-10T00:00:00Z')).close.eq(original.close)).toBe(true); // before the revision was known
      const now = await at(LATE);
      expect([now.close.eq(corrected.close), now.revision, now.availableAt]).toEqual([true, 2, '2026-10-20T00:00:00.000Z']);
      expect((await at(LATE, pinned)).close.eq(original.close)).toBe(true); // pinned to the old ingest sequence
    });

    it('Quarantäne statt Reparatur: ungültige OHLC, final → in-progress, widersprüchliche Lieferung; unbekannte Quelle', async () => {
      const { store } = await open();
      await store.ingestBars(AAPL, bars(5), '2026-10-08T00:00:00Z');
      const b = bars(5);
      const broken = { ...b[4]!, startTime: '2026-10-07T13:55:00.000Z', endTime: '2026-10-07T14:00:00.000Z', availableAt: '2026-10-07T14:00:00.000Z', observedAt: '2026-10-07T14:00:00.000Z', high: Decimal.from('1') };
      const regression = { ...b[1]!, isFinal: false, close: b[1]!.close.plus('0.01'), high: b[1]!.high.plus('0.01') };
      const twinA = { ...bars(7)[6]! };
      const twinB = { ...twinA, close: twinA.close.plus('0.01'), high: twinA.high.plus('0.01') };
      const r = await store.ingestBars(AAPL, [broken, regression, twinA, twinB], '2026-10-09T00:00:00Z');
      expect(r.inserted).toBe(0);
      expect(r.quarantined.map((q) => q.reasons[0]!.code).sort()).toEqual(['conflicting_duplicate', 'conflicting_duplicate', 'final_regression', 'invalid_ohlc']);
      const q = await store.quarantined(AAPL.instrumentId);
      expect(q.length).toBe(4);
      expect(q.find((x) => x.reasons[0]!.code === 'invalid_ohlc')?.raw).toMatchObject({ high: '1', startTime: '2026-10-07T13:55:00.000Z' });
      await expect(store.ingestBars(AAPL, [{ ...b[0]!, source: 'unknown:source:x' }], '2026-10-09T00:00:00Z')).rejects.toMatchObject({ code: 'unknown_source' });
      expect(await store.head(AAPL.instrumentId)).toBe(5);
    });

    it('Ingest-Sequenz bleibt lückenlos bei parallelem Schreiben über zwei Instanzen', async () => {
      const { h } = await open();
      const [a, b] = [await h.store(), await h.store()];
      const all = intradayBars(XNAS, '2026-10-07T13:30:00Z', '5m', randomOhlcv(60, 4), { retrievedAt: '2026-10-08T00:00:00.000Z' });
      await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? a : b).ingestBars(AAPL, all.slice(i * 5, i * 5 + 5), '2026-10-08T00:00:00Z')));
      expect(await a.head(AAPL.instrumentId)).toBe(60);
      const read = await b.readBars({ ...SERIES, asOf: LATE });
      expect(read.map((r) => r.ingestSeq).sort((x, y) => x - y)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    });

    it('Restart: ein neuer Handle liest exakt dieselben Daten', async () => {
      const { h, store } = await open();
      await store.ingestBars(AAPL, bars(12), '2026-10-08T00:00:00Z');
      const fresh = await h.store();
      expect(await fresh.readBars({ ...SERIES, asOf: LATE })).toEqual(await store.readBars({ ...SERIES, asOf: LATE }));
    });

    it('Quotes: Point-in-Time, neueste sichtbare Beobachtung', async () => {
      const { store } = await open();
      const q = (observedAt: string, last: string, retrievedAt: string): MarketQuote => ({ instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, last: Decimal.from(last), observedAt, availableAt: retrievedAt, retrievedAt });
      await store.ingestQuotes(AAPL, [q('2026-10-07T14:00:00.000Z', '250.10', '2026-10-07T14:00:01.000Z'), q('2026-10-07T14:01:00.000Z', '250.20', '2026-10-07T14:01:01.000Z')], '2026-10-07T14:01:01Z');
      expect((await store.latestQuote({ instrumentId: AAPL.instrumentId, asOf: '2026-10-07T14:00:30Z' }))?.last.toString()).toBe('250.1');
      expect((await store.latestQuote({ instrumentId: AAPL.instrumentId, asOf: LATE }))?.last.toString()).toBe('250.2');
      expect(await store.latestQuote({ instrumentId: AAPL.instrumentId, asOf: '2026-10-07T13:00:00Z' })).toBeNull();
    });

    it('Corporate Actions: separat gespeichert, revisioniert, Point-in-Time', async () => {
      const { store } = await open();
      const split: CorporateAction = { actionKey: 'split:2026-08-31', instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, type: 'split', exDate: '2026-08-31', ratioFrom: Decimal.from(1), ratioTo: Decimal.from(4), retrievedAt: '2026-07-30T20:00:00.000Z', knowledge: { provenance: 'captured_by_nexus', knowledgeAt: '2026-07-30T20:00:00.000Z' } };
      const dividend: CorporateAction = { actionKey: 'dividend:2026-05-11', instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, type: 'cash_dividend', exDate: '2026-05-11', cashAmount: Decimal.from('0.26'), currency: 'USD', retrievedAt: '2026-05-01T20:00:00.000Z', knowledge: { provenance: 'captured_by_nexus', knowledgeAt: '2026-05-01T20:00:00.000Z' } };
      expect(await store.ingestCorporateActions(AAPL, [split, dividend], '2026-08-01T00:00:00Z')).toMatchObject({ inserted: 2 });
      expect((await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: '2026-06-01T00:00:00Z' })).map((a) => a.actionKey)).toEqual(['dividend:2026-05-11']);
      // A correction is first known when NEXUS retrieves it: its knowledge is that retrieval, not the original capture.
      const corrected: CorporateAction = { ...dividend, cashAmount: Decimal.from('0.27'), retrievedAt: '2026-09-01T00:00:00.000Z', knowledge: { provenance: 'captured_by_nexus', knowledgeAt: '2026-09-01T00:00:00.000Z' } };
      await store.ingestCorporateActions(AAPL, [corrected], '2026-09-01T00:00:00Z');
      const before = await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: '2026-08-15T00:00:00Z', types: ['cash_dividend'] });
      const after = await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: LATE, types: ['cash_dividend'] });
      expect([before[0]!.cashAmount!.toString(), after[0]!.cashAmount!.toString(), after[0]!.revision]).toEqual(['0.26', '0.27', 2]);
      expect((await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: LATE })).map((a) => a.type)).toEqual(['cash_dividend', 'split']);
    });

    it('Manipulierte Daten werden beim Lesen erkannt (fail closed)', async () => {
      const { h, store } = await open();
      await store.ingestBars(AAPL, bars(5), '2026-10-08T00:00:00Z');
      await h.tamperBar(AAPL.instrumentId, '2026-10-07T13:40:00.000Z', '999.99');
      await expect((await h.store()).readBars({ ...SERIES, asOf: LATE })).rejects.toMatchObject({ code: 'MARKET_DATA_INTEGRITY_ERROR' });
    });

    it('QuantRun: speichern, neu laden = identisch, idempotent, Konflikt bei anderem Ergebnis', async () => {
      const { h } = await open();
      const runs = await h.quantRuns();
      const daily = dailyBars(XNAS, '2026-06-01', randomOhlcv(80, 6));
      const result = computeQuant({ instrument: AAPL, calendar: XNAS, series: { source: FIXTURE_SOURCE.sourceId, interval: '1d', session: 'regular', adjustment: 'raw' }, bars: daily, asOf: '2026-10-01T00:00:00Z' }, { createdAt: '2026-10-01T00:00:01.000Z' });
      const record = toRunRecord(result, 42);
      expect(await runs.save(record)).toBe('APPLIED');
      expect(await runs.save(record)).toBe('ALREADY_APPLIED');
      const reloaded = await (await h.quantRuns()).get(result.quantRunId);
      expect(reloaded).toEqual(record);
      const forged = { ...record, result: { ...result, insufficientData: !result.insufficientData } };
      await expect(runs.save(toRunRecord(forged.result, 42))).rejects.toMatchObject({ code: 'QUANT_RUN_CONFLICT' });
      expect((await runs.list({ instrumentId: AAPL.instrumentId })).length).toBe(1);
    });

    it('Instrument Registry: Tickerwechsel überlebt Restart, Historie bleibt', async () => {
      const { h } = await open();
      const reg = await InstrumentRegistry.open(await h.instruments(), { newId: sequentialIds('i-') });
      await reg.register({ ...AAPL, instrumentId: 'ins_fb' , symbol: 'FB', name: 'Facebook' }, { at: '2026-01-01T00:00:00Z', by: HUMAN, reason: 'setup' });
      await reg.addMapping({ instrumentId: 'ins_fb', provider: 'twelvedata', providerSymbol: 'FB', validFrom: '2012-05-18T00:00:00Z' }, { at: '2026-01-01T00:00:00Z', by: HUMAN, reason: 'setup' });
      await reg.changeSymbol({ instrumentId: 'ins_fb', provider: 'twelvedata', newProviderSymbol: 'META', newSymbol: 'META', effectiveFrom: '2022-06-09T00:00:00Z' }, { at: '2026-01-02T00:00:00Z', by: HUMAN, reason: 'ticker change' });
      const reopened = await InstrumentRegistry.open(await h.instruments());
      expect(reopened.get('ins_fb')?.symbol).toBe('META');
      expect(reopened.resolve('twelvedata', 'FB', '2020-01-01T00:00:00Z')).toBe('ins_fb');
      expect(reopened.resolve('twelvedata', 'META', '2024-01-01T00:00:00Z')).toBe('ins_fb');
      expect(reopened.resolve('twelvedata', 'FB', '2024-01-01T00:00:00Z')).toBeNull();
      expect(reopened.mappingsOverlapping('ins_fb', 'twelvedata', '2022-01-01T00:00:00Z', '2023-01-01T00:00:00Z').map((w) => [w.mapping.providerSymbol, w.from, w.to])).toEqual([
        ['FB', '2022-01-01T00:00:00.000Z', '2022-06-09T00:00:00.000Z'],
        ['META', '2022-06-09T00:00:00.000Z', '2023-01-01T00:00:00.000Z'],
      ]);
    });
  });
}
