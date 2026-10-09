// Point-in-time market state for scanner/backtest consumers.
//
// Core invariant: a consumer at T may only observe bars whose replay instant is <= T. The replay instant depends on the mode
// (replayInstantMs): the market gate for historical research; for decision-time replay, the later of the gate and the instant
// NEXUS held the revision. Events are ordered by that instant, never by bar start/end. This prevents a later-delivered instrument
// from leaking its close into portfolio valuation at another instrument's decision time.

import { replayInstantMs } from '../market-data/bar-replay.js';
import type { BarReplayMode, MarketBar } from '../market-data/market-data-types.js';
import { parseUtc, toUtcIso } from '../market-data/time.js';

/** The instant from which a replay in the given mode may use this bar (ISO UTC). */
export function usableAtOf(bar: MarketBar, mode: BarReplayMode = 'historical_research'): string {
  return toUtcIso(replayInstantMs(bar, mode));
}

export interface BarAvailabilityEvent {
  kind: 'bar';
  instrumentId: string;
  /** The bar's usable instant (see usableAtOf). */
  availableAt: string;
  bar: MarketBar;
}

export function buildBarAvailabilityQueue(series: Readonly<Record<string, readonly MarketBar[]>>, mode: BarReplayMode = 'historical_research'): BarAvailabilityEvent[] {
  const events: BarAvailabilityEvent[] = [];
  for (const [instrumentId, bars] of Object.entries(series)) {
    for (const bar of bars) {
      if (bar.instrumentId !== instrumentId) throw new Error('series key does not match bar instrumentId');
      events.push({ kind: 'bar', instrumentId, availableAt: usableAtOf(bar, mode), bar });
    }
  }
  return events.sort((a, b) => {
    const byAvailable = parseUtc(a.availableAt) - parseUtc(b.availableAt);
    if (byAvailable !== 0) return byAvailable;
    const byStart = parseUtc(a.bar.startTime) - parseUtc(b.bar.startTime);
    if (byStart !== 0) return byStart;
    return a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0;
  });
}

export class PointInTimeBarState {
  constructor(private readonly mode: BarReplayMode = 'historical_research') {}
  private currentTime = Number.NEGATIVE_INFINITY;
  private readonly historyByInstrument = new Map<string, MarketBar[]>();
  private readonly latestByInstrument = new Map<string, MarketBar>();

  advance(event: BarAvailabilityEvent): void {
    const eventTime = parseUtc(event.availableAt);
    if (eventTime < this.currentTime) throw new Error('point-in-time state cannot move backwards');
    if (replayInstantMs(event.bar, this.mode) !== eventTime) throw new Error('event availability does not match bar availability');
    this.currentTime = eventTime;
    const history = this.historyByInstrument.get(event.instrumentId);
    if (history) {
      history.push(event.bar);
      history.sort((a, b) => parseUtc(a.startTime) - parseUtc(b.startTime));
    } else {
      this.historyByInstrument.set(event.instrumentId, [event.bar]);
    }
    this.latestByInstrument.set(event.instrumentId, event.bar);
  }

  now(): number {
    return this.currentTime;
  }

  latest(instrumentId: string, asOf: string): MarketBar | null {
    const t = parseUtc(asOf);
    if (t > this.currentTime) throw new Error('cannot query point-in-time state beyond the processed event time');
    const history = this.historyAt(instrumentId, asOf);
    return history.at(-1) ?? null;
  }

  historyAt(instrumentId: string, asOf: string): readonly MarketBar[] {
    const t = parseUtc(asOf);
    if (t > this.currentTime) throw new Error('cannot query point-in-time state beyond the processed event time');
    return (this.historyByInstrument.get(instrumentId) ?? []).filter((bar) => replayInstantMs(bar, this.mode) <= t);
  }

  snapshot(asOf: string): ReadonlyMap<string, MarketBar> {
    const t = parseUtc(asOf);
    if (t > this.currentTime) throw new Error('cannot query point-in-time state beyond the processed event time');
    const out = new Map<string, MarketBar>();
    for (const instrumentId of this.historyByInstrument.keys()) {
      const bar = this.historyAt(instrumentId, asOf).at(-1);
      if (bar) out.set(instrumentId, bar);
    }
    return out;
  }
}
