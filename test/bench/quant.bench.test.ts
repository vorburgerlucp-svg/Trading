// Benchmark (measurement only, not part of `npm run check`): `npm run bench`.
// Synthetic 1-minute BTC bars (24/7 calendar) — test data only.

import { describe, expect, it } from 'vitest';
import { MarketDataQualityService } from '../../src/market-data/data-quality.js';
import { CONTINUOUS_24X7 } from '../../src/market-data/sessions.js';
import { adx } from '../../src/quant/indicators/adx.js';
import { atr } from '../../src/quant/indicators/atr.js';
import { bollinger } from '../../src/quant/indicators/bollinger.js';
import { ema } from '../../src/quant/indicators/ema.js';
import { macd } from '../../src/quant/indicators/macd.js';
import { rsi } from '../../src/quant/indicators/rsi.js';
import { sma } from '../../src/quant/indicators/sma.js';
import { computeQuant } from '../../src/quant/quant-engine.js';
import { findSwings } from '../../src/quant/structure/swings.js';
import { BTC, FIXTURE_SOURCE, intradayBars, randomOhlcv } from '../market-data/fixtures.js';

function time<T>(fn: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = fn();
  return { ms: Math.round((performance.now() - t0) * 10) / 10, value };
}

describe('Quant benchmark', () => {
  it('10k und 100k Bars: Laufzeit je Baustein und Skalierung', { timeout: 300_000 }, () => {
    const results: Record<string, Record<string, number>> = {};
    for (const n of [10_000, 100_000]) {
      const bars = intradayBars(CONTINUOUS_24X7, '2026-01-01T00:00:00Z', '1m', randomOhlcv(n, 77, 60_000), { instrument: BTC, session: 'continuous', retrievedAt: '2026-12-31T00:00:00.000Z' });
      const close = bars.map((b) => b.close.toNumber());
      const high = bars.map((b) => b.high.toNumber());
      const low = bars.map((b) => b.low.toNumber());
      const asOf = '2026-12-01T00:00:00Z';
      const r: Record<string, number> = {};
      r.sma200 = time(() => sma(close, 200)).ms;
      r.ema50 = time(() => ema(close, 50)).ms;
      r.rsi14 = time(() => rsi(close, 14)).ms;
      r.macd = time(() => macd(close)).ms;
      r.atr14 = time(() => atr({ high, low, close }, 14)).ms;
      r.adx14 = time(() => adx({ high, low, close }, 14)).ms;
      r.bollinger20 = time(() => bollinger(close, 20, 2)).ms;
      r.swings = time(() => findSwings(high, low, 3, 3)).ms;
      r.dataQuality = time(() => new MarketDataQualityService().assessBars(bars, { instrument: BTC, calendar: CONTINUOUS_24X7, interval: '1m', session: 'continuous', adjustment: 'raw', source: FIXTURE_SOURCE.sourceId, asOf, useCase: 'backtest' })).ms;
      const full = time(() => computeQuant({ instrument: BTC, calendar: CONTINUOUS_24X7, series: { source: FIXTURE_SOURCE.sourceId, interval: '1m', session: 'continuous', adjustment: 'raw' }, bars, asOf, useCase: 'backtest' }, { createdAt: asOf }));
      r.computeQuantTotal = full.ms;
      expect(full.value.barCount).toBe(n);
      results[String(n)] = r;
    }
    console.log('[bench] quant engine (ms)\n' + JSON.stringify(results, null, 2));
    const ratio = results['100000']!.computeQuantTotal! / results['10000']!.computeQuantTotal!;
    console.log('[bench] 100k / 10k total ratio: ' + ratio.toFixed(1) + ' (linear ≈ 10, quadratic ≈ 100)');
    expect(ratio).toBeLessThan(40);
  });
});
