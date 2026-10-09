// QuantService: reads a point-in-time series from the market data store (pinned to the ingest
// sequence it saw), runs the engine, stores the run for audit, and can REPLAY a stored run to prove
// that the same inputs still give the same result. LIVE and BACKTEST use this same path and the
// same mathematics; only asOf differs.

import { CorporateActionTimingError, SPLIT_ADJUSTMENT_VERSION, splitAdjustBars } from '../market-data/corporate-actions.js';
import type { FreshnessUseCase } from '../market-data/freshness.js';
import type { InstrumentRegistry } from '../market-data/instrument-registry.js';
import type { MarketDataStore } from '../market-data/market-data-store.js';
import type { BarInterval, BarReplayMode, BarSession, MarketBar, PriceAdjustment } from '../market-data/market-data-types.js';
import { calendarForInstrument } from '../market-data/sessions.js';
import { canonicalUtc, toUtcIso } from '../market-data/time.js';
import { computeQuant, quantResultHash } from './quant-engine.js';
import { toRunRecord, type QuantRunStore } from './quant-run-store.js';
import type { QuantParameters, QuantRunRecord } from './quant-types.js';

/**
 * The corporate-action derivation a split-adjusted series depends on. It is part of the run's input fingerprint and its
 * algorithm versions, so a run computed under an older derivation policy is identifiable (and cannot pass as current).
 */
function derivationOf(adjustment: PriceAdjustment): Readonly<Record<string, string>> | undefined {
  return adjustment === 'split_adjusted' ? { 'split-adjust': SPLIT_ADJUSTMENT_VERSION } : undefined;
}

export interface QuantRunRequest {
  instrumentId: string;
  source: string;
  interval: BarInterval;
  session: BarSession;
  /** 'split_adjusted' from raw storage = point-in-time split adjustment (see corporate-actions.ts). */
  adjustment: PriceAdjustment;
  asOf: string;
  /** Bar start window; default: everything stored before asOf. */
  from?: string;
  parameters?: Partial<QuantParameters>;
  /** Pin to an earlier ingest sequence (replay); default: the current head. */
  storedThrough?: number;
  useCase?: FreshnessUseCase;
  /**
   * historical_reconstruction (default): unproven bars are used from their historical gate and the run says so (barDataProvenance).
   * strict_point_in_time: a bar whose revision is not proven makes the read fail closed (BarVintageNotProvenError).
   */
  replay?: BarReplayMode;
}

export class QuantService {
  private readonly clock: () => Date;

  constructor(private readonly deps: { registry: InstrumentRegistry; store: MarketDataStore; runs: QuantRunStore; clock?: () => Date }) {
    this.clock = deps.clock ?? (() => new Date());
  }

  private async inputs(request: QuantRunRequest, storedThrough: number): Promise<MarketBar[]> {
    const instrument = this.deps.registry.get(request.instrumentId);
    if (!instrument) throw new Error('unknown instrument ' + request.instrumentId);
    const asOf = canonicalUtc(request.asOf);
    const replay = request.replay ?? 'historical_reconstruction';
    if (request.adjustment !== 'split_adjusted') {
      return this.deps.store.readBars({ instrumentId: request.instrumentId, source: request.source, interval: request.interval, session: request.session, adjustment: request.adjustment, asOf, storedThrough, replay, ...(request.from ? { from: request.from } : {}) });
    }
    // Derived adjustment from raw bars + corporate actions known at asOf (never provider-adjusted data mixed in).
    const raw = await this.deps.store.readBars({ instrumentId: request.instrumentId, source: request.source, interval: request.interval, session: request.session, adjustment: 'raw', asOf, storedThrough, replay, ...(request.from ? { from: request.from } : {}) });
    const calendar = calendarForInstrument(instrument);
    if (!calendar) throw new Error('split adjustment needs a trading calendar for ' + request.instrumentId);
    // Information replay: only splits whose knowledge is provable at asOf may shape a quant series. An effective split that
    // changes this window and cannot be shown known refuses the run (typed, with its reasons); nothing is silently repaired.
    const actions = await this.deps.store.readCorporateActions({ instrumentId: request.instrumentId, asOf, storedThrough, types: ['split', 'reverse_split'], purpose: 'information' });
    const adjusted = splitAdjustBars(raw, actions, { asOf, calendar, purpose: 'information' });
    if (adjusted.status !== 'ok') throw new CorporateActionTimingError(adjusted.unproven);
    return adjusted.bars;
  }

  async run(request: QuantRunRequest): Promise<{ record: QuantRunRecord; status: 'APPLIED' | 'ALREADY_APPLIED' }> {
    const instrument = this.deps.registry.get(request.instrumentId);
    if (!instrument) throw new Error('unknown instrument ' + request.instrumentId);
    const storedThrough = request.storedThrough ?? (await this.deps.store.head(request.instrumentId));
    const bars = await this.inputs(request, storedThrough);
    const result = computeQuant(
      {
        instrument,
        calendar: calendarForInstrument(instrument),
        series: { source: request.source, interval: request.interval, session: request.session, adjustment: request.adjustment },
        bars,
        asOf: request.asOf,
        derivation: derivationOf(request.adjustment),
        sourceInfo: await this.deps.store.getSource(request.source),
        ...(request.parameters ? { parameters: request.parameters } : {}),
        ...(request.useCase ? { useCase: request.useCase } : {}),
      },
      { createdAt: toUtcIso(this.clock().getTime()) },
    );
    const record = toRunRecord(result, storedThrough);
    const status = await this.deps.runs.save(record);
    return { record, status };
  }

  /** Recomputes a stored run from the same point in time and ingest sequence. */
  async replay(quantRunId: string): Promise<{ identical: boolean; stored: QuantRunRecord; recomputedHash: string }> {
    const stored = await this.deps.runs.get(quantRunId);
    if (!stored) throw new Error('unknown quant run ' + quantRunId);
    if (stored.storedThrough === null) throw new Error('quant run ' + quantRunId + ' was computed from bars passed in directly; it cannot be replayed from storage');
    const r = stored.result;
    const instrument = this.deps.registry.get(r.instrumentId);
    if (!instrument) throw new Error('unknown instrument ' + r.instrumentId);
    const request: QuantRunRequest = { instrumentId: r.instrumentId, source: r.series.source, interval: r.series.interval, session: r.series.session, adjustment: r.series.adjustment, asOf: r.asOf, parameters: r.parameters, storedThrough: stored.storedThrough };
    const bars = await this.inputs(request, stored.storedThrough);
    const recomputed = computeQuant(
      { instrument, calendar: calendarForInstrument(instrument), series: r.series, bars, asOf: r.asOf, parameters: r.parameters, useCase: r.useCase, ...(r.mode === 'include_in_progress' ? { includeInProgress: true } : {}), derivation: derivationOf(r.series.adjustment), sourceInfo: await this.deps.store.getSource(r.series.source) },
      { createdAt: r.createdAt },
    );
    const recomputedHash = quantResultHash(recomputed);
    return { identical: recomputedHash === stored.resultHash, stored, recomputedHash };
  }
}
