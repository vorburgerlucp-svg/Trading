import type { QuantParameters } from '../quant/quant-types.js';

export const WARMUP_POLICY_VERSION = 'warmup:v1';

export interface WarmupPlan {
  requiredBars: number;
  preferredBars: number;
  algorithmVersion: string;
}

export function warmupPlan(parameters: QuantParameters): WarmupPlan {
  const hardRequirements = [
    ...parameters.sma,
    ...parameters.ema,
    parameters.rsi + 1,
    parameters.macd.slow + parameters.macd.signal - 1,
    parameters.atr + 1,
    2 * parameters.adx,
    parameters.bollinger.period,
    parameters.swings.leftBars + parameters.swings.rightBars + 1,
  ];
  const requiredBars = Math.max(...hardRequirements, 1);

  // Recursive indicators depend on where the series starts. A deterministic preferred history
  // makes scanner and backtest results comparable while keeping requiredBars as the hard minimum.
  const recursiveSeed = Math.max(...parameters.ema, parameters.rsi, parameters.macd.slow, parameters.atr, parameters.adx, 1);
  const preferredBars = Math.max(requiredBars, recursiveSeed * 5);
  return { requiredBars, preferredBars, algorithmVersion: WARMUP_POLICY_VERSION };
}

export function isWarm(parameters: QuantParameters, availableBars: number): boolean {
  return availableBars >= warmupPlan(parameters).requiredBars;
}
