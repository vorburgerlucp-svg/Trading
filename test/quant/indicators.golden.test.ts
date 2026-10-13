// Golden vectors for every indicator.
// Part 1: literal values derived by hand from the documented formulas (fractions shown in comments).
// Part 2: cross-check against the independent exact-rational reference (test/quant/reference.ts)
//         on random series, with an explicit tolerance.

import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/money/decimal.js';
import { adx } from '../../src/quant/indicators/adx.js';
import { atr } from '../../src/quant/indicators/atr.js';
import { bollinger } from '../../src/quant/indicators/bollinger.js';
import { ema } from '../../src/quant/indicators/ema.js';
import { macd } from '../../src/quant/indicators/macd.js';
import { classicPivots, fibonacciPivots } from '../../src/quant/indicators/pivots.js';
import { rsi } from '../../src/quant/indicators/rsi.js';
import { sma } from '../../src/quant/indicators/sma.js';
import { sessionVwap } from '../../src/quant/indicators/vwap.js';
import { randomOhlcv } from '../market-data/fixtures.js';
import { Frac, refAdx, refAtr, refBollingerVariance, refEma, refRsi, refSma, refVwap } from './reference.js';

const TOL = 1e-9;

function expectSeries(actual: (number | null)[], expected: (number | null)[], tol = 1e-12): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((a, i) => {
    const e = expected[i];
    if (e === null || e === undefined) expect(a, 'index ' + i).toBeNull();
    else {
      expect(a, 'index ' + i).not.toBeNull();
      expect(Math.abs(a! - e), 'index ' + i + ': ' + a + ' vs ' + e).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(e)));
    }
  });
}

function expectReference(actual: (number | null)[], reference: (Frac | null)[], tol = TOL): void {
  expectSeries(actual, reference.map((r) => (r === null ? null : r.toNumber())), tol);
}

describe('Golden vectors (von Hand aus den Formeln hergeleitet)', () => {
  it('SMA', () => {
    expectSeries(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  });

  it('EMA mit SMA-Seed', () => {
    // period 3: α = 0.5, seed = mean(1,2,3) = 2 at index 2, then e + 0.5(x − e) → x − 1
    expectSeries(ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3), [null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
    // period 2: α = 2/3, seed = 3 at index 1; 3 + 2/3(6 − 3) = 5; then 7, 9, 11
    expectSeries(ema([2, 4, 6, 8, 10, 12], 2), [null, 3, 5, 7, 9, 11]);
  });

  it('RSI (Wilder, period 3)', () => {
    // changes +1 +1 −1 +2 −1 0
    // t3: g = 2/3, l = 1/3 → RS 2 → 200/3; t4: g = 10/9, l = 2/9 → RS 5 → 250/3;
    // t5: g = 20/27, l = 13/27 → 2000/33; t6: g = 40/81, l = 26/81 → RS 20/13 → 2000/33
    expectSeries(rsi([10, 11, 12, 11, 13, 12, 12], 3), [null, null, null, 200 / 3, 250 / 3, 2000 / 33, 2000 / 33]);
  });

  it('MACD (2/3/2) — fast, slow, signal, histogram', () => {
    // EMA2: 3/2, 19/6, 103/18, 499/54, 2227/162; EMA3: 7/3, 14/3, 47/6, 143/12
    // MACD: 5/6, 19/18, 38/27, 593/324; signal: 17/18, 203/162, 398/243; histogram t5 = 187/972
    const m = macd([1, 2, 4, 7, 11, 16], 2, 3, 2);
    expectSeries(m.macd, [null, null, 5 / 6, 19 / 18, 38 / 27, 593 / 324]);
    expectSeries(m.signal, [null, null, null, 17 / 18, 203 / 162, 398 / 243]);
    expectSeries(m.histogram, [null, null, null, 19 / 18 - 17 / 18, 38 / 27 - 203 / 162, 187 / 972]);
  });

  it('ATR (Wilder, period 3)', () => {
    // TR1..TR4 = 2, 2, 2, 3 → ATR t3 = 2, t4 = (2·2 + 3)/3 = 7/3
    const h = [10, 11, 12, 11, 10];
    const l = [8, 9, 10, 9, 7];
    const c = [9, 10, 11, 9, 8];
    expectSeries(atr({ high: h, low: l, close: c }, 3), [null, null, null, 2, 7 / 3]);
  });

  it('ADX (+DI, −DI, DX, ADX; Wilder, period 2)', () => {
    // t2: S(TR)=5, S(+DM)=3, S(−DM)=0 → +DI 60, −DI 0, DX 100
    // t3: S = 4.5 / 1.5 / 1 → +DI 100/3, −DI 200/9, DX 20; ADX t3 = (100 + 20)/2 = 60
    // t4: S = 5.25 / 0.75 / 2.5 → DX 17500/325; ADX = (60 + 700/13)/2
    // t5: S = 5.625 / 1.375 / 1.25 → DX 100/21; ADX = (ADX4 + 100/21)/2
    const h = [10, 12, 13, 12, 11, 12];
    const l = [8, 9, 11, 10, 8, 9];
    const c = [9, 11, 12, 11, 9, 10];
    const r = adx({ high: h, low: l, close: c }, 2);
    expectSeries(r.plusDI, [null, null, 60, 100 / 3, 0.75 / 5.25 * 100, 1.375 / 5.625 * 100]);
    expectSeries(r.minusDI, [null, null, 0, 200 / 9, 2.5 / 5.25 * 100, 1.25 / 5.625 * 100]);
    expectSeries(r.dx, [null, null, 100, 20, 700 / 13, 100 / 21]);
    const adx4 = (60 + 700 / 13) / 2;
    expectSeries(r.adx, [null, null, null, 60, adx4, (adx4 + 100 / 21) / 2]);
  });

  it('Bollinger (Population-σ): Lehrbuchbeispiel 2,4,4,4,5,5,7,9 → μ 5, σ 2', () => {
    const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    expect([b.middle[7], b.stdDev[7], b.upper[7], b.lower[7]]).toEqual([5, 2, 9, 1]);
    expect(b.percentB[7]).toBe((9 - 1) / 8);
    expect(b.middle[6]).toBeNull();
  });

  it('VWAP pro Session, Reset bei neuer Session', () => {
    const v = sessionVwap([
      { high: 10, low: 8, close: 9, volume: 100, sessionKey: 'A' }, // tp 9
      { high: 12, low: 10, close: 11, volume: 300, sessionKey: 'A' }, // tp 11 → (900 + 3300)/400 = 10.5
      { high: 20, low: 18, close: 19, volume: 50, sessionKey: 'B' }, // new session → 19
    ]);
    expect(v.vwap).toEqual([9, 10.5, 19]);
  });

  it('Pivot Points classic und Fibonacci (exakt mit Decimal)', () => {
    const basis = { high: Decimal.from('110'), low: Decimal.from('100'), close: Decimal.from('105') };
    const c = classicPivots(basis);
    expect(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.toString()]))).toEqual({ p: '105', r1: '110', s1: '100', r2: '115', s2: '95', r3: '120', s3: '90' });
    const f = fibonacciPivots(basis);
    expect(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.toString()]))).toEqual({ p: '105', r1: '108.82', r2: '111.18', r3: '115', s1: '101.18', s2: '98.82', s3: '95' });
    // P with a repeating decimal: (10 + 9 + 9.6)/3 = 9.5333… → half-even at input scale 1 + 4 = 5 decimals
    expect(classicPivots({ high: Decimal.from('10'), low: Decimal.from('9'), close: Decimal.from('9.6') }).p.toString()).toBe('9.53333');
    // tiny prices keep their precision: (3 × 0.00001)/3 = 0.00001 exactly
    expect(classicPivots({ high: Decimal.from('0.00001'), low: Decimal.from('0.00001'), close: Decimal.from('0.00001') }).p.toString()).toBe('0.00001');
  });
});

describe('Querprüfung gegen die unabhängige Referenzimplementierung (exakte Brüche)', () => {
  for (const seed of [1, 2, 3]) {
    const rows = randomOhlcv(120, seed);
    const close = rows.map((r) => Number(r.close));
    const high = rows.map((r) => Number(r.high));
    const low = rows.map((r) => Number(r.low));
    const fc = rows.map((r) => Frac.of(r.close));
    const fh = rows.map((r) => Frac.of(r.high));
    const fl = rows.map((r) => Frac.of(r.low));

    it('seed ' + seed + ': SMA, EMA, RSI', () => {
      for (const p of [5, 20, 50]) expectReference(sma(close, p), refSma(fc, p));
      for (const p of [3, 12, 26]) expectReference(ema(close, p), refEma(fc, p));
      expectReference(rsi(close, 14), refRsi(fc, 14));
    });

    it('seed ' + seed + ': MACD 12/26/9', () => {
      const m = macd(close, 12, 26, 9);
      const fast = refEma(fc, 12);
      const slow = refEma(fc, 26);
      const line = fc.map((_, i) => (fast[i] && slow[i] ? fast[i]!.sub(slow[i]!) : null));
      const signal = refEma(line, 9);
      expectReference(m.macd, line, 1e-8);
      expectReference(m.signal, signal, 1e-8);
      expectReference(m.histogram, line.map((x, i) => (x && signal[i] ? x.sub(signal[i]!) : null)), 1e-7);
    });

    // Exact Wilder sums have denominators growing like 14^n: the rational reference runs on the first 70 bars.
    it('seed ' + seed + ': ATR und ADX (inkl. +DI, −DI, DX)', { timeout: 30_000 }, () => {
      const n = 70;
      const hlc = { high: high.slice(0, n), low: low.slice(0, n), close: close.slice(0, n) };
      expectReference(atr(hlc, 14), refAtr(fh.slice(0, n), fl.slice(0, n), fc.slice(0, n), 14));
      const a = adx(hlc, 14);
      const r = refAdx(fh.slice(0, n), fl.slice(0, n), fc.slice(0, n), 14);
      expectReference(a.plusDI, r.plus);
      expectReference(a.minusDI, r.minus);
      expectReference(a.dx, r.dx, 1e-8);
      expectReference(a.adx, r.adx, 1e-8);
    });

    it('seed ' + seed + ': Bollinger (Mittelwert exakt, Varianz exakt)', () => {
      const b = bollinger(close, 20, 2);
      const ref = refBollingerVariance(fc, 20);
      ref.forEach((r, i) => {
        if (!r) return expect(b.middle[i]).toBeNull();
        expect(Math.abs(b.middle[i]! - r.mean.toNumber())).toBeLessThan(1e-9);
        expect(Math.abs(b.stdDev[i]! ** 2 - r.variance.toNumber())).toBeLessThan(1e-7 * Math.max(1, r.variance.toNumber()));
        expect(Math.abs(b.upper[i]! - (r.mean.toNumber() + 2 * Math.sqrt(r.variance.toNumber())))).toBeLessThan(1e-9);
      });
    });

    it('seed ' + seed + ': Session-VWAP', () => {
      const sessions = rows.map((_, i) => 'S' + Math.floor(i / 30));
      const v = sessionVwap(rows.map((r, i) => ({ high: high[i]!, low: low[i]!, close: close[i]!, volume: Number(r.volume), sessionKey: sessions[i]! })));
      expectReference(v.vwap, refVwap(rows.map((r, i) => ({ h: fh[i]!, l: fl[i]!, c: fc[i]!, v: Frac.of(r.volume!), session: sessions[i]! }))));
    });
  }
});

describe('Zu wenig Historie: keine erfundenen Werte', () => {
  it('jede Kennzahl bleibt null bis zur dokumentierten Warm-up-Länge', () => {
    const c = [1, 2, 3, 4, 5];
    expect(sma(c, 6).every((v) => v === null)).toBe(true);
    expect(ema(c, 6).every((v) => v === null)).toBe(true);
    expect(rsi(c, 5).every((v) => v === null)).toBe(true); // needs 6 closes
    expect(rsi([...c, 6], 5)[5]).toBe(100);
    const m = macd(Array.from({ length: 33 }, (_, i) => i + 1), 12, 26, 9);
    expect(m.signal.every((v) => v === null)).toBe(true); // first signal at index 33
    expect(macd(Array.from({ length: 34 }, (_, i) => i + 1), 12, 26, 9).signal[33]).not.toBeNull();
    const hlc = { high: [2, 3, 4], low: [1, 2, 3], close: [1.5, 2.5, 3.5] };
    expect(atr(hlc, 3).every((v) => v === null)).toBe(true);
    expect(adx({ high: [...hlc.high, 5, 6], low: [...hlc.low, 4, 5], close: [...hlc.close, 4.5, 5.5] }, 3).adx.every((v) => v === null)).toBe(true); // needs 2·3 bars
    expect(bollinger([1, 2, 3], 4).middle.every((v) => v === null)).toBe(true);
    expect(sessionVwap([]).unavailableReason).toBe('no bars');
  });

  it('VWAP ohne Volumen: unavailable, nie künstlich berechnet', () => {
    const v = sessionVwap([
      { high: 10, low: 8, close: 9, volume: null, sessionKey: 'A' },
      { high: 12, low: 10, close: 11, volume: 300, sessionKey: 'A' },
    ]);
    expect(v.vwap).toEqual([null, null]);
    expect(v.unavailableReason).toBe('volume unavailable in this session');
    expect(sessionVwap([{ high: 10, low: 8, close: 9, volume: 0, sessionKey: 'A' }]).unavailableReason).toBe('no volume traded yet in this session');
  });
});
