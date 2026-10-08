import { IndicatorError, type Series } from './common.js';

export const VWAP_VERSION = 'vwap:session-typical-price:v1';

export interface VwapBar {
  high: number;
  low: number;
  close: number;
  /** null = the source has no (reliable) volume for this bar. */
  volume: number | null;
  /** Session the bar belongs to; the VWAP restarts whenever it changes. */
  sessionKey: string;
}

export interface VwapSeries {
  vwap: Series;
  /** Why the last value is missing, if it is. */
  unavailableReason: string | null;
}

/**
 * Session VWAP: Σ(typical·volume) / Σ volume, typical = (high + low + close) / 3, restarted at every
 * new session. It is never computed without volume: if any bar of the session so far has no volume,
 * the VWAP is unavailable for the rest of that session; with zero cumulative volume it is undefined.
 */
export function sessionVwap(bars: readonly VwapBar[]): VwapSeries {
  const vwap: Series = new Array<number | null>(bars.length).fill(null);
  let session: string | null = null;
  let pv = 0;
  let vol = 0;
  let missingVolume = false;
  let reason: string | null = bars.length === 0 ? 'no bars' : null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.sessionKey !== session) {
      session = b.sessionKey;
      pv = 0;
      vol = 0;
      missingVolume = false;
    }
    if (b.volume === null) missingVolume = true;
    else {
      if (!Number.isFinite(b.volume) || b.volume < 0) throw new IndicatorError('volume must be a non-negative number');
      const typical = (b.high + b.low + b.close) / 3;
      pv += typical * b.volume;
      vol += b.volume;
    }
    if (missingVolume) {
      reason = 'volume unavailable in this session';
      continue;
    }
    if (vol === 0) {
      reason = 'no volume traded yet in this session';
      continue;
    }
    vwap[i] = pv / vol;
    reason = null;
  }
  return { vwap, unavailableReason: reason };
}
