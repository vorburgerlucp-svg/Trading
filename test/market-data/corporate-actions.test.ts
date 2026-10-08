import { describe, expect, it } from 'vitest';
import { validateBar } from '../../src/market-data/bar-validation.js';
import { splitAdjustBars } from '../../src/market-data/corporate-actions.js';
import type { CorporateAction } from '../../src/market-data/market-data-types.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { Decimal } from '../../src/money/decimal.js';
import { AAPL, FIXTURE_SOURCE, dailyBars } from './fixtures.js';

const XNAS = getCalendar('XNAS')!;
const row = (p: string, v = '1000') => ({ open: p, high: p, low: p, close: p, volume: v });
// Aug 27, 28, 31 (ex-date of a 4-for-1 split), Sep 1
const raw = dailyBars(XNAS, '2026-08-27', [row('400.00'), row('404.00'), row('101.00'), row('102.00')], { retrievedAt: '2026-08-02T00:00:00.000Z' }).map((b, i) =>
  i < 2 ? { ...b, retrievedAt: '2026-08-30T00:00:00.000Z' } : { ...b, retrievedAt: '2026-09-05T00:00:00.000Z' },
);
const split = (over: Partial<CorporateAction> = {}): CorporateAction => ({
  actionKey: 'split:2026-08-31',
  instrumentId: AAPL.instrumentId,
  source: FIXTURE_SOURCE.sourceId,
  type: 'split',
  exDate: '2026-08-31',
  ratioFrom: Decimal.from(1),
  ratioTo: Decimal.from(4),
  availableAt: '2026-07-30T20:00:00.000Z',
  retrievedAt: '2026-07-30T20:00:00.000Z',
  ...over,
});
const closes = (bars: { close: Decimal }[]) => bars.map((b) => b.close.toString());

describe('Corporate Actions: Split-Adjustierung point-in-time', () => {
  it('vor dem Ex-Datum: nichts angepasst (der Split ist bekannt, aber noch nicht wirksam)', () => {
    const r = splitAdjustBars(raw.slice(0, 2), [split()], { asOf: '2026-08-29T00:00:00Z', calendar: XNAS });
    expect(closes(r.bars)).toEqual(['400', '404']);
    expect(r.pending.map((p) => p.actionKey)).toEqual(['split:2026-08-31']);
    expect(r.applied).toEqual([]);
  });

  it('nach dem Ex-Datum: Preise davor ÷ 4, Volumen × 4, exakt', () => {
    const r = splitAdjustBars(raw, [split()], { asOf: '2026-09-02T00:00:00Z', calendar: XNAS });
    expect(closes(r.bars)).toEqual(['100', '101', '101', '102']);
    expect(r.bars.map((b) => b.volume!.toString())).toEqual(['4000', '4000', '1000', '1000']);
    expect(r.bars.every((b) => b.adjustment === 'split_adjusted')).toBe(true);
    expect(r.applied.map((a) => a.actionKey)).toEqual(['split:2026-08-31']);
  });

  it('ein Split, der zum Zeitpunkt asOf noch nicht bekannt war, wird nicht angewendet', () => {
    const late = split({ availableAt: '2026-09-10T00:00:00.000Z', retrievedAt: '2026-09-10T00:00:00.000Z' });
    expect(closes(splitAdjustBars(raw, [late], { asOf: '2026-09-02T00:00:00Z', calendar: XNAS }).bars)).toEqual(['400', '404', '101', '102']);
  });

  it('Reverse Split und nicht teilbare Faktoren: half-even mit dokumentierter Zusatzgenauigkeit', () => {
    const reverse = split({ actionKey: 'split:rev', type: 'reverse_split', ratioFrom: Decimal.from(10), ratioTo: Decimal.from(1) });
    expect(closes(splitAdjustBars(raw.slice(0, 1), [reverse], { asOf: '2026-09-02T00:00:00Z', calendar: XNAS }).bars)).toEqual(['4000']);
    const three = split({ ratioTo: Decimal.from(3) });
    expect(closes(splitAdjustBars(raw.slice(0, 1), [three], { asOf: '2026-09-02T00:00:00Z', calendar: XNAS }).bars)).toEqual(['133.33333333']); // 2 + 6 decimals
  });

  it('abgeleitete Bars sind gültig: verfügbar UND abgerufen erst, wenn auch der Split bekannt war (Regression)', () => {
    const lateSplit = split({ availableAt: '2026-09-01T12:00:00.000Z', retrievedAt: '2026-09-01T12:00:00.000Z' });
    const r = splitAdjustBars(raw, [lateSplit], { asOf: '2026-09-02T00:00:00Z', calendar: XNAS });
    expect(r.bars[0]!.availableAt).toBe('2026-09-01T12:00:00.000Z');
    expect(r.bars[0]!.retrievedAt).toBe('2026-09-01T12:00:00.000Z');
    for (const b of r.bars) expect(validateBar(b)).toEqual([]);
  });

  it('Raw und Adjusted werden nie gemischt', () => {
    expect(() => splitAdjustBars([{ ...raw[0]!, adjustment: 'split_adjusted' }], [split()], { asOf: '2026-09-02T00:00:00Z', calendar: XNAS })).toThrow(/raw/);
  });
});
