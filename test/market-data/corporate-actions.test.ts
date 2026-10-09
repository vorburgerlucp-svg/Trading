import { describe, expect, it } from 'vitest';
import { validateBar } from '../../src/market-data/bar-validation.js';
import { splitAdjustBars, type SplitAdjustmentResult } from '../../src/market-data/corporate-actions.js';
import type { CorporateActionKnowledge, StoredCorporateAction } from '../../src/market-data/market-data-types.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { Decimal } from '../../src/money/decimal.js';
import { AAPL, FIXTURE_SOURCE, dailyBars } from './fixtures.js';

const XNAS = getCalendar('XNAS')!;
const row = (p: string, v = '1000') => ({ open: p, high: p, low: p, close: p, volume: v });
// Aug 27, 28, 31 (ex-date of a 4-for-1 split), Sep 1
const raw = dailyBars(XNAS, '2026-08-27', [row('400.00'), row('404.00'), row('101.00'), row('102.00')], { retrievedAt: '2026-08-02T00:00:00.000Z' }).map((b, i) =>
  i < 2 ? { ...b, retrievedAt: '2026-08-30T00:00:00.000Z' } : { ...b, retrievedAt: '2026-09-05T00:00:00.000Z' },
);
const CAPTURED_AT = '2026-07-30T20:00:00.000Z';
const captured = (at: string = CAPTURED_AT): CorporateActionKnowledge => ({ provenance: 'captured_by_nexus', knowledgeAt: at });
const LEGACY: CorporateActionKnowledge = { provenance: 'legacy_unproven', knowledgeAt: null };

/** A split as the store hands it to the adjustment: the economic fields, its retrieval, its knowledge, and storage facts. */
const split = (over: Partial<StoredCorporateAction> = {}): StoredCorporateAction => ({
  actionKey: 'split:2026-08-31',
  instrumentId: AAPL.instrumentId,
  source: FIXTURE_SOURCE.sourceId,
  type: 'split',
  exDate: '2026-08-31',
  ratioFrom: Decimal.from(1),
  ratioTo: Decimal.from(4),
  retrievedAt: CAPTURED_AT,
  knowledge: captured(),
  revision: 1,
  ingestSeq: 1,
  contentHash: 'not-checked-here',
  storedAvailableAt: CAPTURED_AT,
  provenanceHash: null,
  ...over,
});
const closes = (bars: { close: Decimal }[]) => bars.map((b) => b.close.toString());
/** The bars of an 'ok' result; fails the test (with the status) for any other result. */
function okBars(r: SplitAdjustmentResult) {
  if (r.status !== 'ok') throw new Error('expected ok, got ' + r.status);
  return r.bars;
}
const INFO = { asOf: '2026-09-02T00:00:00Z', calendar: XNAS, purpose: 'information' as const };
const ECON = { ...INFO, purpose: 'economic' as const };

describe('Split-Adjustierung: wirtschaftliche Wirkung am Ex-Datum', () => {
  it('vor dem Ex-Datum: nichts angepasst, der bekannte Split ist nur pending', () => {
    const r = splitAdjustBars(raw.slice(0, 2), [split()], { ...INFO, asOf: '2026-08-29T00:00:00Z' });
    expect(closes(okBars(r))).toEqual(['400', '404']);
    expect(r.pending.map((p) => p.actionKey)).toEqual(['split:2026-08-31']);
    expect(r.applied).toEqual([]);
  });

  it('nach dem Ex-Datum: Preise davor ÷ 4, Volumen × 4, exakt (Information und Wirtschaft)', () => {
    for (const ctx of [INFO, ECON]) {
      const r = splitAdjustBars(raw, [split()], ctx);
      expect(closes(okBars(r))).toEqual(['100', '101', '101', '102']);
      expect(okBars(r).map((b) => b.volume!.toString())).toEqual(['4000', '4000', '1000', '1000']);
      expect(okBars(r).every((b) => b.adjustment === 'split_adjusted')).toBe(true);
      expect(r.applied.map((a) => [a.actionKey, a.provenance, a.knowledgeAt])).toEqual([['split:2026-08-31', 'captured_by_nexus', CAPTURED_AT]]);
    }
  });

  it('wirtschaftlich bleibt ein Split darstellbar, auch wenn sein Wissen erst nach asOf bewiesen ist', () => {
    const late = split({ knowledge: captured('2026-09-10T00:00:00.000Z'), retrievedAt: '2026-09-10T00:00:00.000Z', storedAvailableAt: '2026-09-10T00:00:00.000Z' });
    expect(closes(okBars(splitAdjustBars(raw, [late], ECON)))).toEqual(['100', '101', '101', '102']);
  });

  it('Reverse Split und nicht teilbare Faktoren: half-even mit dokumentierter Zusatzgenauigkeit', () => {
    const reverse = split({ actionKey: 'split:rev', type: 'reverse_split', ratioFrom: Decimal.from(10), ratioTo: Decimal.from(1) });
    expect(closes(okBars(splitAdjustBars(raw.slice(0, 1), [reverse], INFO)))).toEqual(['4000']);
    const three = split({ ratioTo: Decimal.from(3) });
    expect(closes(okBars(splitAdjustBars(raw.slice(0, 1), [three], INFO)))).toEqual(['133.33333333']); // 2 + 6 decimals
  });

  it('abgeleitete Bars sind gültig: verfügbar UND abgerufen erst, wenn auch der Split bekannt war (Regression)', () => {
    const lateSplit = split({ knowledge: captured('2026-09-01T12:00:00.000Z'), retrievedAt: '2026-09-01T12:00:00.000Z', storedAvailableAt: '2026-09-01T12:00:00.000Z' });
    const bars = okBars(splitAdjustBars(raw, [lateSplit], INFO));
    expect(bars[0]!.availableAt).toBe('2026-09-01T12:00:00.000Z');
    expect(bars[0]!.retrievedAt).toBe('2026-09-01T12:00:00.000Z');
    for (const b of bars) expect(validateBar(b)).toEqual([]);
  });

  it('Raw und Adjusted werden nie gemischt', () => {
    expect(() => splitAdjustBars([{ ...raw[0]!, adjustment: 'split_adjusted' }], [split()], INFO)).toThrow(/raw/);
  });
});

describe('Informationszeit: ein Split ohne bewiesene Wissenszeit schlägt fehl (CORPORATE_ACTION_TIMING_UNPROVEN)', () => {
  it.each([
    ['legacy_unproven', LEGACY],
    ['historical_effective_date_inference', { provenance: 'historical_effective_date_inference' as const, knowledgeAt: null }],
  ])('%s, verändert das Fenster: kein Bar, sondern ein strukturierter Status mit der Ursache', (_name, knowledge) => {
    const r = splitAdjustBars(raw, [split({ knowledge })], INFO);
    expect(r).toMatchObject({ status: 'CORPORATE_ACTION_TIMING_UNPROVEN', unproven: [{ actionKey: 'split:2026-08-31', exDate: '2026-08-31', provenance: knowledge.provenance, knowledgeAt: null }] });
    expect(r).not.toHaveProperty('bars');
  });

  it('dieselbe Ursache im Wirtschaftsmodus: angewendet und ausdrücklich als unbewiesen gekennzeichnet', () => {
    const r = splitAdjustBars(raw, [split({ knowledge: LEGACY })], ECON);
    expect(closes(okBars(r))).toEqual(['100', '101', '101', '102']);
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(r.unprovenApplied.map((a) => [a.actionKey, a.provenance, a.knowledgeAt])).toEqual([['split:2026-08-31', 'legacy_unproven', null]]);
  });

  it('ein unbewiesener Split, der das Fenster nicht verändert, blockiert nicht und wird nicht angewendet', () => {
    const r = splitAdjustBars(raw.slice(2), [split({ knowledge: LEGACY })], INFO);
    expect(closes(okBars(r))).toEqual(['101', '102']);
    expect(r.applied).toEqual([]);
  });

  it('ein unbewiesener Split, der nach asOf nicht bekannt war, gehört nicht zum Ergebnis (kein Vorgriff)', () => {
    const r = splitAdjustBars(raw, [split({ knowledge: LEGACY, retrievedAt: '2026-09-05T00:00:00.000Z', storedAvailableAt: '2026-09-05T00:00:00.000Z' })], INFO);
    expect(closes(okBars(r))).toEqual(['400', '404', '101', '102']);
  });
});
