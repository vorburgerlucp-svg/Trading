import { describe, expect, it } from 'vitest';
import { assessBacktestQuality } from '../../src/backtest/quality.js';

describe('BacktestQuality', () => {
  it('grades methodology, never returns, and flags tiny samples', () => {
    const result = assessBacktestQuality(
      { pointInTimeUniverse: false, dataComplete: true, corporateActions: 'modeled', providerProduction: true, minimumTrades: 20 },
      3,
      0,
      false,
      { total: 0, knownBeforeUse: 0, contemporaneousVintage: 0, historicalVintage: 0, legacy: 0 },
    );
    expect(result.grade).toBe('C');
    expect(result.insufficientSample).toBe(true);
    expect(result.reasons.join(' ')).toMatch(/UNIVERSE_EVIDENCE_NOT_PROVIDED/);
    expect(result.reasons.join(' ')).toMatch(/INSUFFICIENT_SAMPLE/);
  });

  it('marks incomplete market data invalid regardless of apparent strategy performance', () => {
    const result = assessBacktestQuality(
      { pointInTimeUniverse: true, dataComplete: false, corporateActions: 'modeled', providerProduction: true, minimumTrades: 1 },
      100,
      0,
      false,
      { total: 0, knownBeforeUse: 0, contemporaneousVintage: 0, historicalVintage: 0, legacy: 0 },
    );
    expect(result.grade).toBe('INVALID');
  });
});
