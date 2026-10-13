import { Decimal } from '../money/decimal.js';
import type { IndicatorValue, QuantResult } from '../quant/quant-types.js';
import type { ScannerFilter, ScannerRankingRule, ScannerSnapshot } from './scanner-types.js';

export interface FilterEvaluation {
  passed: boolean;
  code: string;
  reason: string;
}

function indicatorNumber(value: IndicatorValue<number>): number | null {
  return value.status === 'ok' && typeof value.value === 'number' ? value.value : null;
}

function ema(quant: QuantResult, period: number): number | null {
  const value = quant.indicators.ema[String(period)];
  return value ? indicatorNumber(value) : null;
}

function atrPercent(snapshot: ScannerSnapshot): number | null {
  const atr = indicatorNumber(snapshot.quant.indicators.atr);
  const price = snapshot.lastPrice.toNumber();
  return atr === null || !(price > 0) ? null : (atr / price) * 100;
}

export function evaluateScannerFilter(snapshot: ScannerSnapshot, filter: ScannerFilter): FilterEvaluation {
  switch (filter.type) {
    case 'minimum_price': {
      const threshold = Decimal.from(filter.value);
      const passed = snapshot.lastPrice.gte(threshold);
      return { passed, code: filter.type, reason: passed ? 'price meets minimum' : 'price below minimum' };
    }
    case 'minimum_average_volume': {
      if (snapshot.averageVolume === undefined) return { passed: false, code: filter.type, reason: 'average volume unavailable' };
      const passed = snapshot.averageVolume.gte(Decimal.from(filter.value));
      return { passed, code: filter.type, reason: passed ? 'volume meets minimum' : 'volume below minimum' };
    }
    case 'rsi_range': {
      const rsi = indicatorNumber(snapshot.quant.indicators.rsi);
      if (rsi === null) return { passed: false, code: filter.type, reason: 'RSI unavailable' };
      const passed = rsi >= filter.min && rsi <= filter.max;
      return { passed, code: filter.type, reason: passed ? 'RSI in range' : 'RSI outside range' };
    }
    case 'price_above_ema': {
      const value = ema(snapshot.quant, filter.period);
      if (value === null) return { passed: false, code: filter.type, reason: 'EMA unavailable' };
      const passed = snapshot.lastPrice.gt(Decimal.from(value));
      return { passed, code: filter.type, reason: passed ? 'price above EMA' : 'price not above EMA' };
    }
    case 'ema_alignment': {
      const fast = ema(snapshot.quant, filter.fast);
      const slow = ema(snapshot.quant, filter.slow);
      if (fast === null || slow === null) return { passed: false, code: filter.type, reason: 'EMA unavailable' };
      const passed = fast > slow;
      return { passed, code: filter.type, reason: passed ? 'fast EMA above slow EMA' : 'EMA alignment failed' };
    }
    case 'adx_minimum': {
      const adx = snapshot.quant.indicators.adx.status === 'ok' ? snapshot.quant.indicators.adx.value?.adx ?? null : null;
      if (adx === null) return { passed: false, code: filter.type, reason: 'ADX unavailable' };
      const passed = adx >= filter.value;
      return { passed, code: filter.type, reason: passed ? 'ADX meets minimum' : 'ADX below minimum' };
    }
    case 'atr_percent_range': {
      const value = atrPercent(snapshot);
      if (value === null) return { passed: false, code: filter.type, reason: 'ATR% unavailable' };
      const passed = (filter.min === undefined || value >= filter.min) && (filter.max === undefined || value <= filter.max);
      return { passed, code: filter.type, reason: passed ? 'ATR% in range' : 'ATR% outside range' };
    }
    case 'market_structure': {
      const trend = snapshot.quant.marketStructure.trend;
      const passed = filter.allowed.includes(trend);
      return { passed, code: filter.type, reason: passed ? 'market structure allowed' : 'market structure not allowed' };
    }
  }
}

export function scannerRankingScore(snapshot: ScannerSnapshot, rules: readonly ScannerRankingRule[]): number {
  let score = 0;
  for (const rule of rules) {
    switch (rule.type) {
      case 'adx': {
        const adx = snapshot.quant.indicators.adx.status === 'ok' ? snapshot.quant.indicators.adx.value?.adx ?? 0 : 0;
        score += adx * rule.weight;
        break;
      }
      case 'rsi_momentum': {
        const rsi = indicatorNumber(snapshot.quant.indicators.rsi) ?? 50;
        score += Math.max(0, rsi - 50) * rule.weight;
        break;
      }
      case 'atr_percent': {
        score += (atrPercent(snapshot) ?? 0) * rule.weight;
        break;
      }
    }
  }
  return Math.round(score * 1_000_000) / 1_000_000;
}
