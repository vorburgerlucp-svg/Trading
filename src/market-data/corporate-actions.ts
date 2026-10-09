// Corporate actions: economic effect and information knowledge are two different questions. This module answers both,
// explicitly and with different time gates (see docs/CORPORATE_ACTION_PROVENANCE.md):
//
//   economic     what happened to positions and prices. A split changes them on its ex-date (exDate), whatever NEXUS knew.
//                Used for accounting. The result labels every adjustment whose knowledge is not proven.
//   information  what NEXUS, or a provider that proves it, knew at asOf. A split is applied only when its knowledge time is
//                proven and <= asOf. If an effective split changes the window but its knowledge cannot be proven, the result
//                is CORPORATE_ACTION_TIMING_UNPROVEN instead of a silent repair or an unlabelled series.
//
// NEXUS keeps RAW bars as the canonical source. The split-adjusted view is derived for a given asOf. Derived bars are never
// stored and carry availableAt = max(bar, knowledge of the splits applied): an adjusted price is only knowable once the split is.

import { Decimal, type RoundingMode } from '../money/decimal.js';
import {
  DataQualityError,
  PROVEN_KNOWLEDGE_PROVENANCE,
  type CorporateActionKnowledge,
  type CorporateActionKnowledgeProvenance,
  type MarketBar,
  type StoredCorporateAction,
} from './market-data-types.js';
import type { TradingCalendar } from './sessions.js';
import { localDateOf, parseUtc, toUtcIso } from './time.js';

export const SPLIT_ADJUSTMENT_VERSION = 'split-adjust:pit:v2';
/** Extra decimal places kept when a price is divided by a split ratio; rounding is half-even. */
export const SPLIT_PRICE_EXTRA_SCALE = 6;
const ROUNDING: RoundingMode = 'half_even';

export type ReplayPurpose = 'information' | 'economic';

export function isProvenKnowledge(knowledge: CorporateActionKnowledge): boolean {
  return (PROVEN_KNOWLEDGE_PROVENANCE as readonly CorporateActionKnowledgeProvenance[]).includes(knowledge.provenance) && knowledge.knowledgeAt !== null;
}

/**
 * The record one replay sees for one key (highest revision among the candidates).
 *   information: candidates are revisions whose knowledge is provably <= asOf, and, when the knowledge is not provable,
 *                revisions NEXUS held by asOf. The newest candidate wins, so a provable newer revision that is not yet known
 *                at asOf stays invisible (revision replay), and an unprovable newest revision is reported as unproven.
 *   economic:    the newest stored revision, ex-post. Only for accounting of what happened, never for information.
 */
export function selectReplayRevision<T extends StoredCorporateAction>(revisions: readonly T[], query: { asOf: string; storedThrough: number; purpose: ReplayPurpose }): T | undefined {
  const asOfMs = parseUtc(query.asOf);
  const stored = revisions.filter((r) => r.ingestSeq <= query.storedThrough);
  const candidates =
    query.purpose === 'economic'
      ? stored
      : stored.filter((r) => (isProvenKnowledge(r.knowledge) ? parseUtc(r.knowledge.knowledgeAt!) <= asOfMs : parseUtc(r.retrievedAt) <= asOfMs));
  let best: T | undefined;
  for (const r of candidates) if (best === undefined || r.revision > best.revision) best = r;
  return best;
}

/** One split as it entered the adjustment, with the provenance that justifies it. */
export interface SplitApplication {
  actionKey: string;
  exDate: string;
  ratioFrom: string;
  ratioTo: string;
  provenance: CorporateActionKnowledgeProvenance;
  /** Proven knowledge time; null when the provenance proves none. */
  knowledgeAt: string | null;
  retrievedAt: string;
}

export interface SplitAdjustedSeries {
  status: 'ok';
  bars: MarketBar[];
  applied: SplitApplication[];
  /** Known at asOf but not yet effective (ex-date after asOf): informational only. */
  pending: SplitApplication[];
  /** Economic replay only: effective splits applied for accounting whose knowledge is not proven. */
  unprovenApplied: SplitApplication[];
  version: string;
}

/** Information replay that cannot be shown: no bars are returned, so no caller can use a silently wrong series. */
export interface SplitAdjustmentUnproven {
  status: 'CORPORATE_ACTION_TIMING_UNPROVEN';
  /** Effective splits that change bars in this window while their knowledge cannot be proven at asOf. */
  unproven: SplitApplication[];
  applied: SplitApplication[];
  pending: SplitApplication[];
  version: string;
}

export type SplitAdjustmentResult = SplitAdjustedSeries | SplitAdjustmentUnproven;

/** Typed refusal for callers that must not continue without the series. Carries the structured reasons. */
export class CorporateActionTimingError extends Error {
  override readonly name = 'CorporateActionTimingError';
  readonly code = 'CORPORATE_ACTION_TIMING_UNPROVEN' as const;

  constructor(readonly unproven: SplitApplication[]) {
    super('split(s) cannot be shown known at asOf (CORPORATE_ACTION_TIMING_UNPROVEN): ' + unproven.map((a) => a.actionKey).join(', '));
  }
}

function toApplication(a: StoredCorporateAction): SplitApplication {
  const proven = isProvenKnowledge(a.knowledge);
  return {
    actionKey: a.actionKey,
    exDate: a.exDate,
    ratioFrom: a.ratioFrom!.toString(),
    ratioTo: a.ratioTo!.toString(),
    provenance: a.knowledge.provenance,
    knowledgeAt: proven ? a.knowledge.knowledgeAt : null,
    retrievedAt: a.retrievedAt,
  };
}

/** Trading date of a bar for split purposes (a split takes effect at the start of its ex-date session). */
function barTradingDate(bar: MarketBar, calendar: TradingCalendar): string {
  const start = parseUtc(bar.startTime);
  return bar.interval === '1d' ? calendar.dailyBarDate(start) : localDateOf(start, calendar.timezone);
}

export function splitAdjustBars(rawBars: readonly MarketBar[], actions: readonly StoredCorporateAction[], ctx: { asOf: string; calendar: TradingCalendar; purpose: ReplayPurpose }): SplitAdjustmentResult {
  const asOfMs = parseUtc(ctx.asOf);
  const asOfDate = localDateOf(asOfMs, ctx.calendar.timezone);
  for (const bar of rawBars) {
    if (bar.adjustment !== 'raw') {
      throw new DataQualityError('split adjustment needs raw bars; got ' + bar.adjustment, [{ code: 'mixed_series', severity: 'error', message: 'raw and adjusted bars must never be mixed', at: bar.startTime }]);
    }
  }
  // Defence in depth: the caller's read is already point-in-time, but a split that was not known at asOf is never used here,
  // whatever the caller passed. Same rule as selectReplayRevision: proven knowledge <= asOf, or (unproven) retrieved <= asOf.
  const knownAtAsOf = (a: StoredCorporateAction) =>
    ctx.purpose === 'economic' || (isProvenKnowledge(a.knowledge) ? parseUtc(a.knowledge.knowledgeAt!) <= asOfMs : parseUtc(a.retrievedAt) <= asOfMs);
  const splits = actions
    .filter((a) => a.type === 'split' || a.type === 'reverse_split')
    .filter(knownAtAsOf)
    .sort((a, b) => (a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : a.actionKey < b.actionKey ? -1 : 1));
  const effective = splits.filter((a) => a.exDate <= asOfDate);
  const pending = splits.filter((a) => a.exDate > asOfDate).map(toApplication);
  const changesWindow = (a: StoredCorporateAction) => rawBars.some((bar) => barTradingDate(bar, ctx.calendar) < a.exDate);

  // Information: an effective split enters only with proven knowledge. Otherwise it is a refusal when it changes the window.
  const usable: StoredCorporateAction[] = [];
  const unproven: SplitApplication[] = [];
  for (const a of effective) {
    if (ctx.purpose === 'information' && !isProvenKnowledge(a.knowledge)) {
      if (changesWindow(a)) unproven.push(toApplication(a));
      continue;
    }
    usable.push(a);
  }
  if (unproven.length > 0) {
    return { status: 'CORPORATE_ACTION_TIMING_UNPROVEN', unproven, applied: usable.map(toApplication), pending, version: SPLIT_ADJUSTMENT_VERSION };
  }

  const bars = rawBars.map((bar) => {
    const date = barTradingDate(bar, ctx.calendar);
    const later = usable.filter((a) => a.exDate > date);
    if (later.length === 0) return { ...bar, adjustment: 'split_adjusted' as const };
    // Price factor = Π from/to; volume factor = Π to/from. Exact numerator/denominator, one rounding per price.
    let num = Decimal.ONE;
    let den = Decimal.ONE;
    // The derived value exists only once the bar AND every split applied to it are known.
    let availableAt = parseUtc(bar.availableAt);
    let retrievedAt = parseUtc(bar.retrievedAt);
    for (const a of later) {
      num = num.times(a.ratioFrom!);
      den = den.times(a.ratioTo!);
      const knownMs = isProvenKnowledge(a.knowledge) ? parseUtc(a.knowledge.knowledgeAt!) : parseUtc(a.retrievedAt);
      availableAt = Math.max(availableAt, knownMs);
      retrievedAt = Math.max(retrievedAt, parseUtc(a.retrievedAt));
    }
    const adjust = (p: Decimal) => p.times(num).dividedBy(den, Math.max(p.scale, 2) + SPLIT_PRICE_EXTRA_SCALE, ROUNDING);
    const adjusted: MarketBar = {
      ...bar,
      open: adjust(bar.open),
      high: adjust(bar.high),
      low: adjust(bar.low),
      close: adjust(bar.close),
      adjustment: 'split_adjusted',
      availableAt: toUtcIso(availableAt),
      retrievedAt: toUtcIso(retrievedAt),
    };
    if (bar.volume !== undefined) adjusted.volume = bar.volume.times(den).dividedBy(num, bar.volume.scale + SPLIT_PRICE_EXTRA_SCALE, ROUNDING);
    else delete adjusted.volume;
    return adjusted;
  });
  return {
    status: 'ok',
    bars,
    applied: usable.map(toApplication),
    pending,
    unprovenApplied: usable.filter((a) => !isProvenKnowledge(a.knowledge)).map(toApplication),
    version: SPLIT_ADJUSTMENT_VERSION,
  };
}
