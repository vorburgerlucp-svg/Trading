import { describe, expect, it } from 'vitest';
import { warmupPlan } from '../../src/backtest/warmup.js';
import { DEFAULT_QUANT_PARAMETERS } from '../../src/quant/quant-engine.js';

describe('backtest warm-up policy', () => {
  it('is deterministic and never starts before the longest hard indicator requirement', () => {
    const plan = warmupPlan(DEFAULT_QUANT_PARAMETERS);
    expect(plan.requiredBars).toBeGreaterThanOrEqual(200);
    expect(plan.preferredBars).toBeGreaterThanOrEqual(plan.requiredBars);
    expect(plan.algorithmVersion).toBe('warmup:v1');
    expect(warmupPlan(DEFAULT_QUANT_PARAMETERS)).toEqual(plan);
  });
});
