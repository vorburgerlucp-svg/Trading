// The point-in-time view of a bar series for one asOf and one replay mode. The engine never trusts the array it was given: it builds this view
// itself, bar by bar (docs/PATTERN_ENGINE_V1.md §3).

import { countBarKnowledge, isContemporaneous, replayInstantMs } from '../market-data/bar-replay.js';
import type { BarReplayMode, MarketBar } from '../market-data/market-data-types.js';
import { parseUtc, toUtcIso } from '../market-data/time.js';
import { Decimal } from '../money/decimal.js';
import type { ReplayMode } from './pattern-types.js';

export interface PitBar {
  /** Index in the view (bars sorted by start time, after the cut). */
  index: number;
  bar: MarketBar;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  startTime: string;
  /** The replay instant (ISO UTC) at which NEXUS could use this bar in the chosen mode. */
  instant: string;
}

export interface PitView {
  bars: PitBar[];
  asOfMs: number;
  /**
   * Bars that were not used. The view is a prefix: it ends at the first bar that is not final or not held at asOf, because bars after a hole
   * would be joined across the hole as if the series were complete. afterGap counts the bars after that point.
   */
  excluded: { notFinal: number; afterAsOf: number; notHeldAtAsOf: number; afterGap: number };
  /** Prices that do not survive a round trip through a double at their own decimal digits. */
  unrepresentable: number;
}

/** A decimal that a double reproduces exactly. Needed because the swing detector compares doubles; see docs/PATTERN_ENGINE_V1.md §5. */
export function representableAsDouble(d: Decimal): boolean {
  const text = d.toString();
  const back = Number(text);
  if (!Number.isFinite(back)) return false;
  try {
    return Decimal.from(String(back)).eq(d);
  } catch {
    return false;
  }
}

/**
 * Builds the view. Replay gating: historical_research uses a bar when its market gate (availableAt) is at or before asOf; decision_time uses
 * a bar only when NEXUS held exactly its revision by asOf. A legacy bar without a knowledge proof throws in decision_time (fail closed).
 */
export function buildPitView(bars: readonly MarketBar[], asOf: string, replay: ReplayMode): PitView {
  const asOfMs = parseUtc(asOf);
  const sorted = [...bars].sort((a, b) => parseUtc(a.startTime) - parseUtc(b.startTime));
  const excluded = { notFinal: 0, afterAsOf: 0, notHeldAtAsOf: 0, afterGap: 0 };
  const kept: PitBar[] = [];
  let unrepresentable = 0;
  let ended = false;
  for (const bar of sorted) {
    if (parseUtc(bar.startTime) >= asOfMs) {
      excluded.afterAsOf++;
      continue;
    }
    if (ended) {
      excluded.afterGap++;
      continue;
    }
    if (!bar.isFinal) {
      excluded.notFinal++;
      ended = true;
      continue;
    }
    const instantMs = replayInstantMs(bar, replay as BarReplayMode);
    if (instantMs > asOfMs) {
      excluded.notHeldAtAsOf++;
      ended = true;
      continue;
    }
    if (!representableAsDouble(bar.high) || !representableAsDouble(bar.low)) unrepresentable++;
    kept.push({ index: kept.length, bar, open: bar.open, high: bar.high, low: bar.low, close: bar.close, startTime: bar.startTime, instant: toUtcIso(instantMs) });
  }
  return { bars: kept, asOfMs, excluded, unrepresentable };
}

/** Provenance of the selected bars, answered as the bar layer answers it. */
export function provenanceOf(view: PitView): { decisionTimeKnowledgeProven: boolean; historicalReconstruction: boolean; legacyUnproven: boolean; latestBarContemporaneous: boolean } {
  const bars = view.bars.map((p) => p.bar);
  if (bars.length === 0) return { decisionTimeKnowledgeProven: false, historicalReconstruction: false, legacyUnproven: false, latestBarContemporaneous: false };
  const counts = countBarKnowledge(bars, view.asOfMs);
  const last = bars[bars.length - 1]!;
  return {
    decisionTimeKnowledgeProven: counts.knownAtAsOf === counts.total,
    historicalReconstruction: counts.historical > 0,
    legacyUnproven: counts.legacy > 0,
    latestBarContemporaneous: isContemporaneous(last),
  };
}
