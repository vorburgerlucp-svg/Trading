import { describe, expect, it } from 'vitest';
import { assessBacktestQuality } from '../../src/backtest/quality.js';

describe('BacktestQuality', () => {
  it('grades methodology, never returns, and flags tiny samples', () => {
    const result = assessBacktestQuality(
      { pointInTimeUniverse: false, dataComplete: true, corporateActions: 'modeled', providerProduction: true, minimumTrades: 20 },
      3,
      0,
      false,
    );
    expect(result.grade).toBe('C');
    expect(result.insufficientSample).toBe(true);
    expect(result.reasons.join(' ')).toMatch(/point-in-time/);
    expect(result.reasons.join(' ')).toMatch(/INSUFFICIENT_SAMPLE/);
  });

  it('marks incomplete market data invalid regardless of apparent strategy performance', () => {
    const result = assessBacktestQuality(
      { pointInTimeUniverse: true, dataComplete: false, corporateActions: 'modeled', providerProduction: true, minimumTrades: 1 },
      100,
      0,
      false,
    );
    expect(result.grade).toBe('INVALID');
  });
});
