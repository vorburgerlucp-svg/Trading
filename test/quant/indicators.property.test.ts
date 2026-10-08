// Property tests: invariants that must hold for ANY input (seeded random series, reproducible).

import { describe, expect, it } from 'vitest';
import { adx } from '../../src/quant/indicators/adx.js';
import { atr } from '../../src/quant/indicators/atr.js';
import { bollinger } from '../../src/quant/indicators/bollinger.js';
import { ema } from '../../src/quant/indicators/ema.js';
import { macd } from '../../src/quant/indicators/macd.js';
import { rsi } from '../../src/quant/indicators/rsi.js';
import { sma } from '../../src/quant/indicators/sma.js';
import { sessionVwap } from '../../src/quant/indicators/vwap.js';
import { findSwings } from '../../src/quant/structure/swings.js';
import { prng, randomOhlcv } from '../market-data/fixtures.js';

const defined = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
const SEEDS = [11, 12, 13, 14, 15, 16, 17, 18];

function series(seed: number, n = 300) {
  const rows = randomOhlcv(n, seed);
  return { close: rows.map((r) => Number(r.close)), high: rows.map((r) => Number(r.high)), low: rows.map((r) => Number(r.low)), volume: rows.map((r) => Number(r.volume)) };
}

describe('konstante Serien (exakt, ohne Toleranz)', () => {
  const c = Array.from({ length: 80 }, () => 100.1);
  it('SMA und EMA einer Konstante sind die Konstante', () => {
    for (const p of [1, 3, 20, 50]) {
      expect(new Set(defined(sma(c, p)))).toEqual(new Set([100.1]));
      expect(new Set(defined(ema(c, p)))).toEqual(new Set([100.1]));
    }
  });
  it('MACD einer Konstante ist 0; RSI ohne Bewegung = 50 (neutral)', () => {
    expect(new Set(defined(macd(c).macd))).toEqual(new Set([0]));
    expect(new Set(defined(macd(c).histogram))).toEqual(new Set([0]));
    expect(new Set(defined(rsi(c, 14)))).toEqual(new Set([50]));
  });
  it('ATR bei konstanter OHLC-Serie = 0; Bollinger: upper = middle = lower', () => {
    expect(new Set(defined(atr({ high: c, low: c, close: c }, 14)))).toEqual(new Set([0]));
    const b = bollinger(c, 20, 2);
    for (let i = 19; i < c.length; i++) {
      expect(b.upper[i]).toBe(b.middle[i]);
      expect(b.lower[i]).toBe(b.middle[i]);
      expect(b.percentB[i]).toBeNull();
    }
  });
  it('ADX ohne Bewegung: DI und DX = 0', () => {
    const r = adx({ high: c, low: c, close: c }, 14);
    expect(new Set([...defined(r.plusDI), ...defined(r.minusDI), ...defined(r.dx), ...defined(r.adx)])).toEqual(new Set([0]));
  });
});

describe('monotone Serien', () => {
  const up = Array.from({ length: 60 }, (_, i) => 100 + i * 0.37);
  const down = up.map((x) => 300 - x);
  it('RSI nur steigend = 100, nur fallend = 0', () => {
    expect(new Set(defined(rsi(up, 14)))).toEqual(new Set([100]));
    expect(new Set(defined(rsi(down, 14)))).toEqual(new Set([0]));
  });
  it('MACD einer steigenden Serie ist positiv, einer fallenden negativ', () => {
    expect(defined(macd(up).macd).every((x) => x > 0)).toBe(true);
    expect(defined(macd(down).macd).every((x) => x < 0)).toBe(true);
  });
});

describe('Wertebereiche auf Zufallsserien', () => {
  for (const seed of SEEDS) {
    it('seed ' + seed, () => {
      const s = series(seed);
      const hlc = { high: s.high, low: s.low, close: s.close };
      for (const v of defined(rsi(s.close, 14))) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
      const a = adx(hlc, 14);
      for (const v of [...defined(a.adx), ...defined(a.plusDI), ...defined(a.minusDI), ...defined(a.dx)]) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
      for (const v of defined(atr(hlc, 14))) expect(v).toBeGreaterThanOrEqual(0);
      const e = ema(s.close, 20);
      for (let i = 19; i < s.close.length; i++) {
        const seen = s.close.slice(0, i + 1);
        expect(e[i]!).toBeGreaterThanOrEqual(Math.min(...seen) - 1e-9);
        expect(e[i]!).toBeLessThanOrEqual(Math.max(...seen) + 1e-9);
      }
      const b = bollinger(s.close, 20, 2);
      for (let i = 19; i < s.close.length; i++) expect(b.lower[i]! <= b.middle[i]! && b.middle[i]! <= b.upper[i]!).toBe(true);
      // VWAP stays between the session's lowest low and highest high
      const keys = s.close.map((_, i) => 'S' + Math.floor(i / 50));
      const v = sessionVwap(s.close.map((c, i) => ({ high: s.high[i]!, low: s.low[i]!, close: c, volume: s.volume[i]!, sessionKey: keys[i]! })));
      v.vwap.forEach((x, i) => {
        const from = Math.floor(i / 50) * 50;
        expect(x!).toBeGreaterThanOrEqual(Math.min(...s.low.slice(from, i + 1)) - 1e-9);
        expect(x!).toBeLessThanOrEqual(Math.max(...s.high.slice(from, i + 1)) + 1e-9);
      });
    });
  }
});

describe('Invarianzen', () => {
  it('Verschiebung aller Preise ändert RSI, ATR, ADX und Bollinger-Breite nicht; Skalierung skaliert ATR', () => {
    const s = series(21, 200);
    const shift = (xs: number[]) => xs.map((x) => x + 1000);
    const scale = (xs: number[]) => xs.map((x) => x * 3);
    const close = (a: (number | null)[], b: (number | null)[], tol: number) => a.forEach((x, i) => (x === null ? expect(b[i]).toBeNull() : expect(Math.abs(x - b[i]!)).toBeLessThan(tol)));
    close(rsi(s.close, 14), rsi(shift(s.close), 14), 1e-7);
    close(atr(s, 14), atr({ high: shift(s.high), low: shift(s.low), close: shift(s.close) }, 14), 1e-8);
    close(adx(s, 14).adx, adx({ high: shift(s.high), low: shift(s.low), close: shift(s.close) }, 14).adx, 1e-7);
    const w1 = bollinger(s.close).stdDev;
    const w2 = bollinger(shift(s.close)).stdDev;
    close(w1, w2, 1e-7);
    const a1 = atr(s, 14);
    const a3 = atr({ high: scale(s.high), low: scale(s.low), close: scale(s.close) }, 14);
    a1.forEach((x, i) => x !== null && expect(Math.abs(a3[i]! - 3 * x)).toBeLessThan(1e-9 * Math.max(1, x)));
  });

  it('Determinismus: zweimal gerechnet = bitgleich', () => {
    const s = series(33, 500);
    expect(JSON.stringify(adx(s, 14))).toBe(JSON.stringify(adx(s, 14)));
    expect(JSON.stringify(macd(s.close))).toBe(JSON.stringify(macd(s.close)));
  });
});

describe('Swings: kein Look-ahead (Präfix-Eigenschaft)', () => {
  it('Swings, die auf den ersten m Bars bestätigt sind, ändern sich durch spätere Bars nie', () => {
    const rnd = prng(99);
    for (let trial = 0; trial < 10; trial++) {
      const s = series(100 + trial, 150);
      const full = findSwings(s.high, s.low, 3, 3);
      const m = 20 + Math.floor(rnd() * 120);
      const prefix = findSwings(s.high.slice(0, m), s.low.slice(0, m), 3, 3);
      expect(prefix).toEqual(full.filter((w) => w.confirmedIndex < m));
    }
  });
});
