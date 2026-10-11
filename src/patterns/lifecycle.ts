// Lifecycle of one pattern candidate (pattern-lifecycle:v1). It walks the point-in-time view strictly after the bar where the geometry became known,
// on final bars only, and reads the status at the last bar of the view (docs/PATTERN_ENGINE_V1.md §13). It never guesses the order of two
// touches inside one bar.

import type { Decimal } from '../money/decimal.js';
import type { Candidate, Space } from './geometry.js';
import { valueAt } from './line.js';
import type { PatternStatus } from './pattern-types.js';

export const LIFECYCLE_STEP_VERSION = 'pattern-lifecycle:v1';

export interface WalkResult {
  status: PatternStatus;
  /** The view index at which the geometry became known. */
  geometryKnownIndex: number;
  /** The confirming bar, when confirmed. */
  confirmIndex: number | null;
  /** The breakout direction in the candidate's space. */
  confirmDirection: 'up' | 'down' | null;
  /** The boundary value at the confirming bar, in the candidate's space. */
  confirmLevel: Decimal | null;
  invalidatedIndex: number | null;
  resolvedIndex: number | null;
  barsWalked: number;
}

/** Walks one candidate over the space up to the last view index. */
export function walkCandidate(c: Candidate, space: Space, lastIndex: number): WalkResult {
  const b = c.boundaries;
  const base = { geometryKnownIndex: c.geometryKnownIndex, confirmIndex: null, confirmDirection: null, confirmLevel: null, invalidatedIndex: null, resolvedIndex: null };
  let barsWalked = 0;
  for (let t = c.geometryKnownIndex + 1; t <= lastIndex; t++) {
    barsWalked++;
    const close = space.close[t]!;
    const invalidatedUp = b.invalidateUp !== undefined && close.gt(valueAt(b.invalidateUp, t).plus(c.failureBuffer));
    const invalidatedDown = b.invalidateDown !== undefined && close.lt(valueAt(b.invalidateDown, t).minus(c.failureBuffer));
    if (invalidatedUp || invalidatedDown) return { ...base, status: 'invalidated', invalidatedIndex: t, barsWalked };
    const up = b.breakUp !== undefined && close.gt(valueAt(b.breakUp, t).plus(c.breakoutBuffer));
    const down = b.breakDown !== undefined && close.lt(valueAt(b.breakDown, t).minus(c.breakoutBuffer));
    if (up && down) return { ...base, status: 'invalidated', invalidatedIndex: t, barsWalked };
    if (up || down) {
      const direction = up ? 'up' : 'down';
      const boundary = up ? b.breakUp! : b.breakDown!;
      return outcomeWalk(c, space, t, direction, valueAt(boundary, t), lastIndex, barsWalked);
    }
    if (t - c.geometryKnownIndex > c.confirmationWindowBars) return { ...base, status: 'expired', barsWalked };
  }
  return { ...base, status: 'forming', barsWalked };
}

function outcomeWalk(c: Candidate, space: Space, confirmIndex: number, direction: 'up' | 'down', level: Decimal, lastIndex: number, barsWalked: number): WalkResult {
  const target = c.targetAt(direction, confirmIndex);
  const failure = direction === 'down' ? c.boundaries.failUpAfterDown : c.boundaries.failDownAfterUp;
  const base = { geometryKnownIndex: c.geometryKnownIndex, confirmIndex, confirmDirection: direction, confirmLevel: level, invalidatedIndex: null };
  for (let t = confirmIndex + 1; t <= lastIndex; t++) {
    barsWalked++;
    const high = space.high[t]!;
    const low = space.low[t]!;
    const close = space.close[t]!;
    const targetTouched = direction === 'down' ? low.lte(target.plus(c.targetTolerance)) : high.gte(target.minus(c.targetTolerance));
    let failureTouched = false;
    let failureClosed = false;
    if (failure !== undefined) {
      const f = valueAt(failure, t);
      if (direction === 'down') {
        failureTouched = high.gte(f);
        failureClosed = close.gte(f.plus(c.failureBuffer));
      } else {
        failureTouched = low.lte(f);
        failureClosed = close.lte(f.minus(c.failureBuffer));
      }
    }
    // Same bar: the target and the failure boundary are both touched, and OHLC cannot order them. Neither is chosen.
    if (targetTouched && failureTouched) return { ...base, status: 'outcome_ambiguous', resolvedIndex: t, barsWalked };
    if (failureClosed) return { ...base, status: 'failed_breakout', resolvedIndex: t, barsWalked };
    if (targetTouched) return { ...base, status: 'completed', resolvedIndex: t, barsWalked };
    if (t - confirmIndex >= c.maxOutcomeBars) return { ...base, status: 'expired', resolvedIndex: t, barsWalked };
  }
  return { ...base, status: confirmIndex === lastIndex ? 'confirmed' : 'target_active', resolvedIndex: null, barsWalked };
}
