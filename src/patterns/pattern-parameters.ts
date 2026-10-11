// Pattern parameters (pattern-engine:v1b): every subjective choice is a versioned, documented default (docs/PATTERN_ENGINE_V1.md §18 and
// docs/PATTERN_ENGINE_V1B.md §17). The defaults are policy, not market truth. Every resolved value enters the run fingerprint. Invalid parameters
// fail closed.

import { Decimal } from '../money/decimal.js';
import { SUPPORT_RESISTANCE_VERSION } from '../quant/structure/support-resistance.js';
import { SWING_VERSION } from '../quant/structure/swings.js';
import { ATR_VERSION } from '../quant/indicators/atr.js';

/** The run engine version. V1B bumped it explicitly: the run now produces price-action structures. */
export const PATTERN_ENGINE_VERSION = 'pattern-engine:v1b';
export const PATTERN_GEOMETRY_VERSION = 'pattern-geometry:v1b';
export const PATTERN_LIFECYCLE_VERSION = 'pattern-lifecycle:v1';
export const PRICE_ACTION_LIFECYCLE_VERSION = 'price-action-lifecycle:v1';
/** The policy that defines a level's structural lineage (docs/PATTERN_ENGINE_V1B.md §25.3). Hashed into every lineage id and the run fingerprint. */
export const LEVEL_LINEAGE_VERSION = 'level-lineage:v1';
export { SWING_VERSION, ATR_VERSION, SUPPORT_RESISTANCE_VERSION };

/**
 * Identity tags of the V1 structures. V1 instance ids were derived from these tags, and they stay frozen: a version bump of the run engine must not
 * silently change the id of an existing V1 structure (docs/PATTERN_ENGINE_V1B.md §2).
 */
export const V1_IDENTITY = Object.freeze({ engine: 'pattern-engine:v1', geometry: 'pattern-geometry:v1' });
/**
 * Identity tags of the V1B price-action structures. Literals, not the run constants: a later run-version bump must never change a V1B instance id
 * (docs/PATTERN_ENGINE_V1C.md §1.1). The golden test v1c-regression.test.ts enforces it.
 */
export const V1B_IDENTITY = Object.freeze({ engine: 'pattern-engine:v1b', geometry: 'pattern-geometry:v1b', lifecycle: 'price-action-lifecycle:v1' });

export interface PatternParameters {
  swing: { leftBars: number; rightBars: number };
  tolerance: {
    mode: 'atr' | 'percent';
    atrPeriod: number;
    /** The level tolerance of the V1B level family, in ATR units at the bar before the decision. V1 never reads it. */
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
  /** Support/resistance levels and the breakout family: breakout, retest and false break. */
  priceAction: {
    levelMinTouches: number;
    levelLookbackBars: number;
    levelPriceScale: number;
    breakoutBufferAtr: string;
    retestToleranceAtr: string;
    retestHoldBufferAtr: string;
    retestWindowBars: number;
    failureWindowBars: number;
    failureBufferAtr: string;
  };
  rectangle: {
    minTouchesPerSide: number;
    minDurationBars: number;
    maxDurationBars: number;
    flatSlopeToleranceAtrPerBar: string;
    minHeightAtr: string;
    maxResidualAtr: string;
    confirmationWindowBars: number;
  };
  channel: {
    minTouchesPerSide: number;
    minDurationBars: number;
    maxDurationBars: number;
    maxResidualAtr: string;
    minSlopeAtrPerBar: string;
    maxSlopeDifferenceAtrPerBar: string;
    /** |width_end / width_start − 1| must not exceed this. */
    maxWidthChangeRatio: string;
    maxSwings: number;
    confirmationWindowBars: number;
  };
  wedge: {
    minTouchesPerSide: number;
    minDurationBars: number;
    maxDurationBars: number;
    maxResidualAtr: string;
    minSlopeAtrPerBar: string;
    minConvergence: string;
    maxApexBarsAhead: number;
    maxSwings: number;
    confirmationWindowBars: number;
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
  priceAction: {
    levelMinTouches: 2,
    levelLookbackBars: 120,
    levelPriceScale: 6,
    breakoutBufferAtr: '0.1',
    retestToleranceAtr: '0.3',
    retestHoldBufferAtr: '0',
    retestWindowBars: 20,
    failureWindowBars: 10,
    failureBufferAtr: '0.1',
  },
  rectangle: {
    minTouchesPerSide: 2,
    minDurationBars: 15,
    maxDurationBars: 100,
    flatSlopeToleranceAtrPerBar: '0.02',
    minHeightAtr: '1.5',
    maxResidualAtr: '0.5',
    confirmationWindowBars: 30,
  },
  channel: {
    minTouchesPerSide: 2,
    minDurationBars: 15,
    maxDurationBars: 100,
    maxResidualAtr: '0.5',
    minSlopeAtrPerBar: '0.03',
    maxSlopeDifferenceAtrPerBar: '0.02',
    maxWidthChangeRatio: '0.15',
    maxSwings: 6,
    confirmationWindowBars: 30,
  },
  wedge: {
    minTouchesPerSide: 2,
    minDurationBars: 15,
    maxDurationBars: 100,
    maxResidualAtr: '0.5',
    minSlopeAtrPerBar: '0.03',
    minConvergence: '0.2',
    maxApexBarsAhead: 60,
    maxSwings: 6,
    confirmationWindowBars: 30,
  },
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
  const pa = o('priceAction');
  const rect = o('rectangle');
  const chan = o('channel');
  const wedge = o('wedge');
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
    priceAction: {
      levelMinTouches: intParam(pa.levelMinTouches, 'priceAction.levelMinTouches', 2),
      levelLookbackBars: intParam(pa.levelLookbackBars, 'priceAction.levelLookbackBars', 1),
      levelPriceScale: intParam(pa.levelPriceScale, 'priceAction.levelPriceScale', 0),
      breakoutBufferAtr: decimalParam(pa.breakoutBufferAtr, 'priceAction.breakoutBufferAtr'),
      retestToleranceAtr: decimalParam(pa.retestToleranceAtr, 'priceAction.retestToleranceAtr'),
      retestHoldBufferAtr: decimalParam(pa.retestHoldBufferAtr, 'priceAction.retestHoldBufferAtr'),
      retestWindowBars: intParam(pa.retestWindowBars, 'priceAction.retestWindowBars', 1),
      failureWindowBars: intParam(pa.failureWindowBars, 'priceAction.failureWindowBars', 1),
      failureBufferAtr: decimalParam(pa.failureBufferAtr, 'priceAction.failureBufferAtr'),
    },
    rectangle: {
      minTouchesPerSide: intParam(rect.minTouchesPerSide, 'rectangle.minTouchesPerSide', 2),
      minDurationBars: intParam(rect.minDurationBars, 'rectangle.minDurationBars', 1),
      maxDurationBars: intParam(rect.maxDurationBars, 'rectangle.maxDurationBars', 1),
      flatSlopeToleranceAtrPerBar: decimalParam(rect.flatSlopeToleranceAtrPerBar, 'rectangle.flatSlopeToleranceAtrPerBar'),
      minHeightAtr: decimalParam(rect.minHeightAtr, 'rectangle.minHeightAtr'),
      maxResidualAtr: decimalParam(rect.maxResidualAtr, 'rectangle.maxResidualAtr'),
      confirmationWindowBars: intParam(rect.confirmationWindowBars, 'rectangle.confirmationWindowBars', 1),
    },
    channel: {
      minTouchesPerSide: intParam(chan.minTouchesPerSide, 'channel.minTouchesPerSide', 2),
      minDurationBars: intParam(chan.minDurationBars, 'channel.minDurationBars', 1),
      maxDurationBars: intParam(chan.maxDurationBars, 'channel.maxDurationBars', 1),
      maxResidualAtr: decimalParam(chan.maxResidualAtr, 'channel.maxResidualAtr'),
      minSlopeAtrPerBar: decimalParam(chan.minSlopeAtrPerBar, 'channel.minSlopeAtrPerBar'),
      maxSlopeDifferenceAtrPerBar: decimalParam(chan.maxSlopeDifferenceAtrPerBar, 'channel.maxSlopeDifferenceAtrPerBar'),
      maxWidthChangeRatio: decimalParam(chan.maxWidthChangeRatio, 'channel.maxWidthChangeRatio'),
      maxSwings: intParam(chan.maxSwings, 'channel.maxSwings', 4),
      confirmationWindowBars: intParam(chan.confirmationWindowBars, 'channel.confirmationWindowBars', 1),
    },
    wedge: {
      minTouchesPerSide: intParam(wedge.minTouchesPerSide, 'wedge.minTouchesPerSide', 2),
      minDurationBars: intParam(wedge.minDurationBars, 'wedge.minDurationBars', 1),
      maxDurationBars: intParam(wedge.maxDurationBars, 'wedge.maxDurationBars', 1),
      maxResidualAtr: decimalParam(wedge.maxResidualAtr, 'wedge.maxResidualAtr'),
      minSlopeAtrPerBar: decimalParam(wedge.minSlopeAtrPerBar, 'wedge.minSlopeAtrPerBar'),
      minConvergence: decimalParam(wedge.minConvergence, 'wedge.minConvergence'),
      maxApexBarsAhead: intParam(wedge.maxApexBarsAhead, 'wedge.maxApexBarsAhead', 1),
      maxSwings: intParam(wedge.maxSwings, 'wedge.maxSwings', 4),
      confirmationWindowBars: intParam(wedge.confirmationWindowBars, 'wedge.confirmationWindowBars', 1),
    },
  };
  if (resolved.headShoulders.minPatternBars > resolved.headShoulders.maxPatternBars) throw new PatternParameterError('headShoulders min must not exceed max');
  if (resolved.double.maxPatternBars < resolved.double.minSeparationBars) throw new PatternParameterError('double.maxPatternBars must be at least minSeparationBars');
  if (resolved.triangle.minPatternBars > resolved.triangle.maxPatternBars) throw new PatternParameterError('triangle min must not exceed max');
  if (Decimal.from(resolved.triangle.minConvergence).gt(1)) throw new PatternParameterError('triangle.minConvergence must not exceed 1');
  if (resolved.rectangle.minDurationBars > resolved.rectangle.maxDurationBars) throw new PatternParameterError('rectangle min duration must not exceed max');
  if (resolved.channel.minDurationBars > resolved.channel.maxDurationBars) throw new PatternParameterError('channel min duration must not exceed max');
  if (resolved.wedge.minDurationBars > resolved.wedge.maxDurationBars) throw new PatternParameterError('wedge min duration must not exceed max');
  // The categories are disjoint by construction only if these relations hold (docs/PATTERN_ENGINE_V1B.md §13).
  if (Decimal.from(resolved.wedge.minSlopeAtrPerBar).lte(resolved.triangle.flatSlopeToleranceAtrPerBar))
    throw new PatternParameterError('wedge.minSlopeAtrPerBar must exceed triangle.flatSlopeToleranceAtrPerBar, so a wedge never has a flat side');
  if (Decimal.from(resolved.channel.maxWidthChangeRatio).gte(resolved.wedge.minConvergence))
    throw new PatternParameterError('channel.maxWidthChangeRatio must be below wedge.minConvergence, so a channel never converges enough to be a wedge');
  return resolved;
}
