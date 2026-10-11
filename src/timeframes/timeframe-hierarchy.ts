// Timeframe hierarchy (timeframe-hierarchy:v1): which native interval belongs to which layer of the market view.
// The mapping follows the brief of the multi-timeframe V1 (docs/MULTITIMEFRAME_CHART_CONTEXT_V1.md §7). Each native interval sits in
// exactly one layer, and a daily bar is never duplicated into another layer. STRATEGIC is unavailable in V1: it has no native interval.

import { BAR_INTERVALS, type BarInterval } from '../market-data/market-data-types.js';

export const TIMEFRAME_HIERARCHY_VERSION = 'timeframe-hierarchy:v1';

export type HierarchyLayer = 'MICRO' | 'INTRADAY' | 'SWING' | 'POSITION' | 'STRATEGIC';
export const HIERARCHY_LAYERS: readonly HierarchyLayer[] = Object.freeze(['MICRO', 'INTRADAY', 'SWING', 'POSITION', 'STRATEGIC']);

export type HierarchyMap = Readonly<Record<HierarchyLayer, readonly BarInterval[]>>;

export const DEFAULT_HIERARCHY: HierarchyMap = Object.freeze({
  MICRO: Object.freeze(['1m', '5m'] as const),
  INTRADAY: Object.freeze(['15m', '1h'] as const),
  SWING: Object.freeze(['4h'] as const),
  POSITION: Object.freeze(['1d'] as const),
  STRATEGIC: Object.freeze([] as const),
});

export class TimeframeHierarchyError extends Error {
  override readonly name = 'TimeframeHierarchyError';
  constructor(message: string) {
    super('CHART_POLICY_INVALID: ' + message);
  }
}

/** Every native interval must sit in exactly one layer. A policy that loses or duplicates an interval is refused. */
export function assertHierarchy(h: HierarchyMap): void {
  for (const layer of HIERARCHY_LAYERS) if (!Array.isArray(h[layer])) throw new TimeframeHierarchyError('layer ' + layer + ' is missing');
  const seen = new Map<BarInterval, HierarchyLayer>();
  for (const layer of HIERARCHY_LAYERS) {
    for (const interval of h[layer]) {
      if (!BAR_INTERVALS.includes(interval)) throw new TimeframeHierarchyError(interval + ' is not a native interval');
      const earlier = seen.get(interval);
      if (earlier) throw new TimeframeHierarchyError(interval + ' is in both ' + earlier + ' and ' + layer);
      seen.set(interval, layer);
    }
  }
  for (const interval of BAR_INTERVALS) if (!seen.has(interval)) throw new TimeframeHierarchyError(interval + ' is in no layer');
}

export function layerOf(h: HierarchyMap, interval: BarInterval): HierarchyLayer | null {
  for (const layer of HIERARCHY_LAYERS) if (h[layer].includes(interval)) return layer;
  return null;
}
