// Bar vintage policy (versioned). It answers one question only: was this revision already the market's value at its
// observation time? It never decides when NEXUS held a revision: that is `knownAt` (= retrievedAt for everything NEXUS received).
// See docs/BAR_KNOWLEDGE_EVIDENCE.md.

import type { BarInterval, BarVintage } from './market-data-types.js';
import { parseUtc } from './time.js';

/** Version of the vintage rule below. Stored per bar, part of the bar provenance hash and of the quant input fingerprint. */
export const BAR_VINTAGE_POLICY_VERSION = 'bar-vintage:v1';

/**
 * The window after a final bar's completion within which a fetch counts as contemporaneous. Explicit policy, reviewed in code;
 * the owner confirms the values. A different window only changes vintages, never knowledge.
 */
export const DEFAULT_CAPTURE_WINDOW_MS: Readonly<{ intraday: number; daily: number }> = Object.freeze({ intraday: 15 * 60_000, daily: 2 * 3_600_000 });

export interface VintageInput {
  observedAt: string;
  retrievedAt: string;
  isFinal: boolean;
  interval: BarInterval;
}

/**
 * contemporaneous: an in-progress bar (the current bar, fetched now), or a final bar fetched no later than the window after its
 * completion (the boundary is inclusive). historical_reconstruction: any later fetch, whose market-time value is not proven.
 */
export function barVintageOf(input: VintageInput, window: { intraday: number; daily: number } = DEFAULT_CAPTURE_WINDOW_MS): BarVintage {
  if (!input.isFinal) return 'contemporaneous';
  const limit = input.interval === '1d' ? window.daily : window.intraday;
  return parseUtc(input.retrievedAt) - parseUtc(input.observedAt) <= limit ? 'contemporaneous' : 'historical_reconstruction';
}
