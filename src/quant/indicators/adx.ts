import { assertPeriod, type Series } from './common.js';
import { assertHlc, type Hlc } from './atr.js';

export const ADX_VERSION = 'adx:wilder-sum-seed:v1';

export interface AdxSeries {
  plusDI: Series;
  minusDI: Series;
  dx: Series;
  adx: Series;
}

/**
 * ADX after Wilder (default 14), textbook form:
 *   up = high_t − high_{t−1}; down = low_{t−1} − low_t                                    (t ≥ 1)
 *   +DM = up if up > down and up > 0, else 0;  −DM = down if down > up and down > 0, else 0
 *   TR as in atr.ts
 *   Wilder sums: first at t = period = Σ_{1..period}; then S_t = S_{t−1} − S_{t−1}/period + x_t
 *   +DI = 100·S(+DM)/S(TR); −DI = 100·S(−DM)/S(TR)  (0 when S(TR) = 0)
 *   DX = 100·|+DI − −DI| / (+DI + −DI)              (0 when both DI are 0)
 *   ADX first at t = 2·period − 1 = mean(DX_period … DX_{2·period−1}); then Wilder smoothing of DX.
 * Note: TA-Lib seeds the sums with period − 1 values plus one smoothing step; values converge but
 * differ during the first bars — this module follows Wilder's original (sum of the first `period`).
 */
export function adx(input: Hlc, period = 14): AdxSeries {
  assertPeriod(period);
  assertHlc(input);
  const n = input.close.length;
  const plusDI: Series = new Array<number | null>(n).fill(null);
  const minusDI: Series = new Array<number | null>(n).fill(null);
  const dx: Series = new Array<number | null>(n).fill(null);
  const adxOut: Series = new Array<number | null>(n).fill(null);
  if (n <= period) return { plusDI, minusDI, dx, adx: adxOut };

  const tr: number[] = new Array<number>(n).fill(0);
  const pdm: number[] = new Array<number>(n).fill(0);
  const mdm: number[] = new Array<number>(n).fill(0);
  for (let t = 1; t < n; t++) {
    const h = input.high[t]!;
    const l = input.low[t]!;
    const pc = input.close[t - 1]!;
    tr[t] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const up = h - input.high[t - 1]!;
    const down = input.low[t - 1]! - l;
    pdm[t] = up > down && up > 0 ? up : 0;
    mdm[t] = down > up && down > 0 ? down : 0;
  }

  let sTr = 0;
  let sP = 0;
  let sM = 0;
  for (let t = 1; t <= period; t++) {
    sTr += tr[t]!;
    sP += pdm[t]!;
    sM += mdm[t]!;
  }
  let dxSum = 0;
  let a = 0;
  for (let t = period; t < n; t++) {
    if (t > period) {
      sTr = sTr - sTr / period + tr[t]!;
      sP = sP - sP / period + pdm[t]!;
      sM = sM - sM / period + mdm[t]!;
    }
    const p = sTr === 0 ? 0 : (100 * sP) / sTr;
    const m = sTr === 0 ? 0 : (100 * sM) / sTr;
    plusDI[t] = p;
    minusDI[t] = m;
    const d = p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m);
    dx[t] = d;
    if (t < 2 * period - 1) dxSum += d;
    else if (t === 2 * period - 1) {
      a = (dxSum + d) / period;
      adxOut[t] = a;
    } else {
      a = (a * (period - 1) + d) / period;
      adxOut[t] = a;
    }
  }
  return { plusDI, minusDI, dx, adx: adxOut };
}
