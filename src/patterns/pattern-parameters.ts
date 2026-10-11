// Pattern parameters (pattern-engine:v1): every subjective choice is a versioned, documented default (docs/PATTERN_ENGINE_V1.md §18).
// The defaults are policy, not market truth. Every resolved value enters the run fingerprint. Invalid parameters fail closed.

import { Decimal } from '../money/decimal.js';
import { SWING_VERSION } from '../quant/structure/swings.js';
import { ATR_VERSION } from '../quant/indicators/atr.js';

export const PATTERN_ENGINE_VERSION = 'pattern-engine:v1';
export const PATTERN_GEOMETRY_VERSION = 'pattern-geometry:v1';
export const PATTERN_LIFECYCLE_VERSION = 'pattern-lifecycle:v1';
export { SWING_VERSION, ATR_VERSION };

export interface PatternParameters {
  swing: { leftBars: number; rightBars: number };
  tolerance: {
    mode: 'atr' | 'percent';
    atrPeriod: number;
    /** Reserved for the level families of V1B. The V1 geometry uses the family tolerances below. */
    sameLevelAtrMultiple: string;
    /** Used only in percent mode: the scale unit is this fraction of the close at the geometry-known bar. */
    percentOfPrice: string;
  };
  headShoulders: {
    minHeadProminenceAtr: string;
    maxShoulderDifferenceAtr: string;
    maxShoulderDurationRatio: string;
    maxNecklineSlopeAtrPerBar: string;
    minPatternBars: number;
    maxPatternBars: number;
    confirmationWindowBars: number;
    breakoutBufferAtr: string;
  };
  double: {
    maxPeakDifferenceAtr: string;
    minReactionDepthAtr: string;
    minSeparationBars: number;
    maxPatternBars: number;
    confirmationWindowBars: number;
    breakoutBufferAtr: string;
  };
  triangle: {
    minTouchesPerSide: number;
    minPatternBars: number;
    maxPatternBars: number;
    flatSlopeToleranceAtrPerBar: string;
    minTrendSlopeAtrPerBar: string;
    maxResidualAtr: string;
    minConvergence: string;
    maxApexBarsAhead: number;
    maxTriangleSwings: number;
    confirmationWindowBars: number;
    breakoutBufferAtr: string;
  };
  outcome: {
    targetToleranceAtr: string;
    failureBufferAtr: string;
    maxOutcomeBars: number;
  };
}

export const DEFAULT_PATTERN_PARAMETERS = Object.freeze({
  swing: { leftBars: 3, rightBars: 3 },
  tolerance: { mode: 'atr', atrPeriod: 14, sameLevelAtrMultiple: '0.5', percentOfPrice: '0.01' },
  headShoulders: {
    minHeadProminenceAtr: '1.0',
    maxShoulderDifferenceAtr: '1.0',
    maxShoulderDurationRatio: '2.5',
    maxNecklineSlopeAtrPerBar: '0.2',
    minPatternBars: 15,
    maxPatternBars: 120,
    confirmationWindowBars: 20,
    breakoutBufferAtr: '0.1',
  },
  double: {
    maxPeakDifferenceAtr: '1.0',
    minReactionDepthAtr: '1.5',
    minSeparationBars: 8,
    maxPatternBars: 100,
    confirmationWindowBars: 20,
    breakoutBufferAtr: '0.1',
  },
  triangle: {
    minTouchesPerSide: 2,
    minPatternBars: 15,
    maxPatternBars: 100,
    flatSlopeToleranceAtrPerBar: '0.02',
    minTrendSlopeAtrPerBar: '0.03',
    maxResidualAtr: '0.5',
    minConvergence: '0.2',
    maxApexBarsAhead: 60,
    maxTriangleSwings: 6,
    confirmationWindowBars: 30,
    breakoutBufferAtr: '0.1',
  },
  outcome: { targetToleranceAtr: '0', failureBufferAtr: '0.1', maxOutcomeBars: 60 },
} satisfies PatternParameters);

/** Overrides are deep-partial: any value may be set, the rest keeps its default. */
export type PatternParameterOverrides = { [K in keyof PatternParameters]?: Partial<PatternParameters[K]> };

export class PatternParameterError extends Error {
  override readonly name = 'PatternParameterError';
  constructor(message: string) {
    super('PATTERN_PARAMETERS_INVALID: ' + message);
  }
}

const DECIMAL_TEXT = /^\d+(\.\d+)?$/;

function decimalParam(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DECIMAL_TEXT.test(value)) throw new PatternParameterError(field + ' must be a non-negative decimal string');
  return value;
}

function intParam(value: unknown, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) throw new PatternParameterError(field + ' must be an integer of at least ' + min);
  return value;
}

/** Merges overrides into the defaults and validates every value. Returns a plain, canonical parameter object. */
export function resolvePatternParameters(overrides: PatternParameterOverrides = {}): PatternParameters {
  const d = DEFAULT_PATTERN_PARAMETERS;
  const o = (k: keyof PatternParameters) => ({ ...(d[k] as object), ...((overrides[k] ?? {}) as object) }) as Record<string, unknown>;
  const swing = o('swing');
  const tol = o('tolerance');
  const hs = o('headShoulders');
  const dbl = o('double');
  const tri = o('triangle');
  const out = o('outcome');
  if (tol.mode !== 'atr' && tol.mode !== 'percent') throw new PatternParameterError('tolerance.mode must be atr or percent');
  const resolved: PatternParameters = {
    swing: { leftBars: intParam(swing.leftBars, 'swing.leftBars', 1), rightBars: intParam(swing.rightBars, 'swing.rightBars', 1) },
    tolerance: {
      mode: tol.mode,
      atrPeriod: intParam(tol.atrPeriod, 'tolerance.atrPeriod', 1),
      sameLevelAtrMultiple: decimalParam(tol.sameLevelAtrMultiple, 'tolerance.sameLevelAtrMultiple'),
      percentOfPrice: decimalParam(tol.percentOfPrice, 'tolerance.percentOfPrice'),
    },
    headShoulders: {
      minHeadProminenceAtr: decimalParam(hs.minHeadProminenceAtr, 'headShoulders.minHeadProminenceAtr'),
      maxShoulderDifferenceAtr: decimalParam(hs.maxShoulderDifferenceAtr, 'headShoulders.maxShoulderDifferenceAtr'),
      maxShoulderDurationRatio: decimalParam(hs.maxShoulderDurationRatio, 'headShoulders.maxShoulderDurationRatio'),
      maxNecklineSlopeAtrPerBar: decimalParam(hs.maxNecklineSlopeAtrPerBar, 'headShoulders.maxNecklineSlopeAtrPerBar'),
      minPatternBars: intParam(hs.minPatternBars, 'headShoulders.minPatternBars', 1),
      maxPatternBars: intParam(hs.maxPatternBars, 'headShoulders.maxPatternBars', 1),
      confirmationWindowBars: intParam(hs.confirmationWindowBars, 'headShoulders.confirmationWindowBars', 1),
      breakoutBufferAtr: decimalParam(hs.breakoutBufferAtr, 'headShoulders.breakoutBufferAtr'),
    },
    double: {
      maxPeakDifferenceAtr: decimalParam(dbl.maxPeakDifferenceAtr, 'double.maxPeakDifferenceAtr'),
      minReactionDepthAtr: decimalParam(dbl.minReactionDepthAtr, 'double.minReactionDepthAtr'),
      minSeparationBars: intParam(dbl.minSeparationBars, 'double.minSeparationBars', 1),
      maxPatternBars: intParam(dbl.maxPatternBars, 'double.maxPatternBars', 1),
      confirmationWindowBars: intParam(dbl.confirmationWindowBars, 'double.confirmationWindowBars', 1),
      breakoutBufferAtr: decimalParam(dbl.breakoutBufferAtr, 'double.breakoutBufferAtr'),
    },
    triangle: {
      minTouchesPerSide: intParam(tri.minTouchesPerSide, 'triangle.minTouchesPerSide', 2),
      minPatternBars: intParam(tri.minPatternBars, 'triangle.minPatternBars', 1),
      maxPatternBars: intParam(tri.maxPatternBars, 'triangle.maxPatternBars', 1),
      flatSlopeToleranceAtrPerBar: decimalParam(tri.flatSlopeToleranceAtrPerBar, 'triangle.flatSlopeToleranceAtrPerBar'),
      minTrendSlopeAtrPerBar: decimalParam(tri.minTrendSlopeAtrPerBar, 'triangle.minTrendSlopeAtrPerBar'),
      maxResidualAtr: decimalParam(tri.maxResidualAtr, 'triangle.maxResidualAtr'),
      minConvergence: decimalParam(tri.minConvergence, 'triangle.minConvergence'),
      maxApexBarsAhead: intParam(tri.maxApexBarsAhead, 'triangle.maxApexBarsAhead', 1),
      maxTriangleSwings: intParam(tri.maxTriangleSwings, 'triangle.maxTriangleSwings', 4),
      confirmationWindowBars: intParam(tri.confirmationWindowBars, 'triangle.confirmationWindowBars', 1),
      breakoutBufferAtr: decimalParam(tri.breakoutBufferAtr, 'triangle.breakoutBufferAtr'),
    },
    outcome: {
      targetToleranceAtr: decimalParam(out.targetToleranceAtr, 'outcome.targetToleranceAtr'),
      failureBufferAtr: decimalParam(out.failureBufferAtr, 'outcome.failureBufferAtr'),
      maxOutcomeBars: intParam(out.maxOutcomeBars, 'outcome.maxOutcomeBars', 1),
    },
  };
  if (resolved.headShoulders.minPatternBars > resolved.headShoulders.maxPatternBars) throw new PatternParameterError('headShoulders min must not exceed max');
  if (resolved.double.maxPatternBars < resolved.double.minSeparationBars) throw new PatternParameterError('double.maxPatternBars must be at least minSeparationBars');
  if (resolved.triangle.minPatternBars > resolved.triangle.maxPatternBars) throw new PatternParameterError('triangle min must not exceed max');
  if (Decimal.from(resolved.triangle.minConvergence).gt(1)) throw new PatternParameterError('triangle.minConvergence must not exceed 1');
  return resolved;
}
