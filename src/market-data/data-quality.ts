// MarketDataQualityService: grades a bar series (or a quote) for a given point in time and use.
// The result is never just a boolean: every issue carries a code and severity, and the verdicts
// usableForTrading / usableForBacktest are derived from them by fixed rules.
//
// Severity rules:
//   critical – the data is wrong (invalid OHLC/number/time, conflicting duplicates, future timestamps)
//   error    – the series cannot be used as asked (mixed series, look-ahead, misaligned bars, no data)
//   warning  – usable with care (gaps, stale, partial bars, out-of-order input, calendar uncertainty)

import { barContentHash, validateBar, validateQuote } from './bar-validation.js';
import { countBarKnowledge, isContemporaneous } from './bar-replay.js';
import { assessBarFreshness, assessQuoteFreshness, type FreshnessPolicy, type FreshnessUseCase } from './freshness.js';
import { isIntraday, type BarInterval, type BarSession, type DataQualityIssue, type DataQualityResult, type Instrument, type MarketBar, type MarketDataSource, type MarketQuote, type PriceAdjustment, type Severity } from './market-data-types.js';
import type { SessionScope, TradingCalendar } from './sessions.js';
import { parseUtc, toUtcIso } from './time.js';

const RANK: Record<Severity, number> = { ok: 0, warning: 1, error: 2, critical: 3 };
/** Detailed issues reported per code; the rest is summarized (a 100k-bar series must not produce 100k issue objects). */
const MAX_DETAILS_PER_CODE = 20;

export interface BarSeriesContext {
  instrument: Pick<Instrument, 'instrumentId' | 'assetClass' | 'allowsNegativePrices'>;
  calendar: TradingCalendar | null;
  interval: BarInterval;
  session: BarSession;
  adjustment: PriceAdjustment;
  source: string;
  asOf: string;
  useCase: FreshnessUseCase;
  sourceInfo?: MarketDataSource | null;
  /** Requested window: bars expected at the edges count as missing_bars. */
  window?: { from: string; to: string };
  /** In-progress bars are part of the input on purpose (live preview); otherwise they are an issue. */
  includeInProgress?: boolean;
  policy?: FreshnessPolicy;
}

class IssueCollector {
  private readonly details: DataQualityIssue[] = [];
  private readonly hidden = new Map<string, { code: DataQualityIssue['code']; severity: DataQualityIssue['severity']; occurrences: number; count: number }>();
  private readonly shown = new Map<string, number>();

  add(issue: DataQualityIssue): void {
    const key = issue.code + '|' + issue.severity;
    const shown = this.shown.get(key) ?? 0;
    if (shown < MAX_DETAILS_PER_CODE) {
      this.shown.set(key, shown + 1);
      this.details.push(issue);
      return;
    }
    const entry = this.hidden.get(key) ?? { code: issue.code, severity: issue.severity, occurrences: 0, count: 0 };
    entry.occurrences++;
    entry.count += issue.count ?? 1;
    this.hidden.set(key, entry);
  }

  result(derive: (issues: DataQualityIssue[], severity: Severity) => { usableForTrading: boolean; usableForBacktest: boolean }): DataQualityResult {
    const issues = [...this.details];
    for (const h of this.hidden.values()) {
      issues.push({ code: h.code, severity: h.severity, message: h.occurrences + ' more ' + h.code + ' occurrence(s) not listed individually', count: h.count });
    }
    const severity = issues.reduce<Severity>((max, i) => (RANK[i.severity] > RANK[max] ? i.severity : max), 'ok');
    const valid = RANK[severity] < RANK.error;
    return { valid, severity, issues, ...derive(issues, severity) };
  }
}

function scopeOf(session: BarSession): SessionScope {
  return session === 'extended' ? 'extended' : 'regular';
}

export class MarketDataQualityService {
  constructor(private readonly policy?: FreshnessPolicy) {}

  assessBars(bars: readonly MarketBar[], ctx: BarSeriesContext): DataQualityResult {
    const c = new IssueCollector();
    const asOf = parseUtc(ctx.asOf);
    const policy = ctx.policy ?? this.policy;
    const scope = scopeOf(ctx.session);

    if (bars.length === 0) {
      c.add({ code: 'missing_bars', severity: 'error', message: 'no bars for the requested series' });
    }
    if (!ctx.calendar) c.add({ code: 'calendar_unknown', severity: 'warning', message: 'no trading calendar: gaps and freshness cannot be assessed' });
    if (ctx.sourceInfo && ctx.sourceInfo.environment !== 'production') {
      c.add({ code: 'non_production_source', severity: 'warning', message: 'source ' + ctx.sourceInfo.sourceId + ' is ' + ctx.sourceInfo.environment + ' data, never a production source' });
    }

    // 1. Structure, series identity, point in time.
    const usable: MarketBar[] = [];
    let previousStart = -Infinity;
    let outOfOrder = 0;
    for (const bar of bars) {
      const structural = validateBar(bar, { allowsNegativePrices: ctx.instrument.allowsNegativePrices === true });
      for (const issue of structural) c.add(issue);
      if (structural.length > 0) continue;
      if (bar.instrumentId !== ctx.instrument.instrumentId || bar.interval !== ctx.interval || bar.session !== ctx.session || bar.adjustment !== ctx.adjustment || bar.source !== ctx.source) {
        c.add({ code: 'mixed_series', severity: 'error', message: 'bar does not belong to the series (instrument/interval/session/adjustment/source differ)', at: bar.startTime });
        continue;
      }
      const start = parseUtc(bar.startTime);
      if (parseUtc(bar.availableAt) > asOf || start >= asOf) {
        c.add({ code: 'not_yet_available', severity: 'error', message: 'bar was not available at asOf ' + ctx.asOf + ' (look-ahead)', at: bar.startTime });
        continue;
      }
      if (!bar.isFinal) {
        c.add({ code: 'partial_bar', severity: 'warning', message: ctx.includeInProgress ? 'in-progress bar included on purpose' : 'in-progress bar (not final)', at: bar.startTime });
      }
      if (start < previousStart) outOfOrder++;
      previousStart = Math.max(previousStart, start);
      usable.push(bar);
    }
    if (outOfOrder > 0) c.add({ code: 'out_of_order', severity: 'warning', message: outOfOrder + ' bar(s) arrived out of chronological order', count: outOfOrder });

    // 2. Duplicates (after sorting; each start is parsed once, not inside the comparator).
    const sorted = usable
      .map((bar) => ({ bar, start: parseUtc(bar.startTime) }))
      .sort((a, b) => a.start - b.start)
      .map((x) => x.bar);
    const unique: MarketBar[] = [];
    for (const bar of sorted) {
      const last = unique[unique.length - 1];
      if (last && last.startTime === bar.startTime) {
        if (barContentHash(last) === barContentHash(bar)) c.add({ code: 'duplicate', severity: 'warning', message: 'identical duplicate bar', at: bar.startTime });
        else c.add({ code: 'conflicting_duplicate', severity: 'critical', message: 'two different bars for the same start', at: bar.startTime });
        continue;
      }
      unique.push(bar);
    }

    // 3. Calendar: alignment, sessions, gaps.
    if (ctx.calendar && unique.length > 0) {
      const calendar = ctx.calendar;
      const outsideSeverity = calendar.kind === 'exchange' ? 'error' : 'warning';
      // Gaps are measured only between bars that sit correctly on the calendar grid. A bar that starts
      // exactly where the previous one ended leaves no room for a missing bar (O(1) fast path); the
      // calendar is only consulted at session boundaries and real holes.
      let prev: number | null = null;
      let prevEnd: number | null = null;
      for (const bar of unique) {
        const start = parseUtc(bar.startTime);
        const window = calendar.barWindow(start, ctx.interval, scope);
        if (!window.ok) {
          c.add(window.reason === 'misaligned'
            ? { code: 'misaligned_interval', severity: 'error', message: 'bar start is not aligned to the ' + ctx.interval + ' grid of ' + calendar.calendarId, at: bar.startTime }
            : { code: 'outside_session', severity: outsideSeverity, message: 'bar lies outside the ' + scope + ' sessions of ' + calendar.calendarId, at: bar.startTime });
          continue;
        }
        // A FINAL bar cannot have been available before it was complete (daily: session close).
        // Otherwise a replay at noon would already "know" the day's close: a look-ahead hole.
        const completion = isIntraday(ctx.interval) ? window.end : calendar.dailyBarCompletion(window.sessionKey, scope);
        if (bar.isFinal && completion !== null && parseUtc(bar.availableAt) < completion) {
          c.add({ code: 'invalid_time', severity: 'critical', message: 'final bar claims availability ' + bar.availableAt + ' before its completion ' + toUtcIso(completion) + ' (look-ahead)', at: bar.startTime });
        }
        if (window.end !== parseUtc(bar.endTime)) {
          c.add({ code: 'misaligned_interval', severity: 'error', message: 'bar end ' + bar.endTime + ' differs from the calendar window end ' + toUtcIso(window.end), at: bar.startTime });
        } else if (window.assumed) {
          c.add({ code: 'calendar_coverage', severity: 'warning', message: 'session outside the verified calendar coverage (assumed)', at: bar.startTime });
        }
        if (prev !== null && prevEnd !== start) {
          const missing = calendar.expectedStartsBetween(prev, start, ctx.interval, scope, 100_000);
          const certain = missing.starts.length - missing.assumed;
          if (certain > 0) c.add({ code: 'gap', severity: 'warning', message: certain + ' expected bar(s) missing before this bar', at: bar.startTime, count: certain });
          if (missing.assumed > 0) c.add({ code: 'calendar_coverage', severity: 'warning', message: missing.assumed + ' possibly missing bar(s) on dates without verified calendar data', at: bar.startTime, count: missing.assumed });
        }
        prev = start;
        prevEnd = window.end;
      }
      if (ctx.window) {
        const from = parseUtc(ctx.window.from);
        const to = Math.min(parseUtc(ctx.window.to), asOf);
        const first = parseUtc(unique[0]!.startTime);
        const firstExpected = calendar.firstBarStartAtOrAfter(from, ctx.interval, scope);
        const headMissing = firstExpected !== null && firstExpected < first ? 1 + calendar.expectedStartsBetween(firstExpected, first, ctx.interval, scope, 100_000).starts.length : 0;
        if (headMissing > 0) c.add({ code: 'missing_bars', severity: 'warning', message: headMissing + ' expected bar(s) missing at the start of the window', count: headMissing });
        const latest = calendar.latestCompletedBarStart(to, ctx.interval, scope, 0);
        const last = parseUtc(unique[unique.length - 1]!.startTime);
        if (latest !== null && latest > last) {
          const tail = calendar.expectedStartsBetween(last, latest + 1, ctx.interval, scope, 100_000);
          if (tail.starts.length > 0) c.add({ code: 'missing_bars', severity: 'warning', message: tail.starts.length + ' expected bar(s) missing at the end of the window', count: tail.starts.length });
        }
      }
    }

    // 4. Freshness of the latest final bar for live uses.
    const lastFinal = [...unique].reverse().find((b) => b.isFinal);
    let stale = false;
    let freshnessAssumed = false;
    if (ctx.useCase !== 'backtest' && lastFinal) {
      const verdict = assessBarFreshness(lastFinal.startTime, { interval: ctx.interval, calendar: ctx.calendar, asOf: ctx.asOf, useCase: ctx.useCase, scope, ...(policy ? { policy } : {}) });
      freshnessAssumed = verdict.calendarAssumed;
      if (!verdict.fresh) {
        stale = true;
        c.add({ code: 'stale', severity: 'warning', message: verdict.reason, at: lastFinal.startTime });
      }
    }

    // Two questions, reported separately. Decision-time knowledge: was every bar held by NEXUS at asOf? Vintage: which bars are
    // contemporaneous with their market time? Warm-up history may be a reconstruction; the latest final (signal) bar may not.
    const knowledge = countBarKnowledge(unique, asOf);
    if (knowledge.historical > 0) {
      c.add({ code: 'vintage_not_proven', severity: 'warning', message: knowledge.historical + ' bar(s) have a historical reconstruction vintage: their market-time value is not proven', count: knowledge.historical });
    }
    if (knowledge.legacy > 0) {
      c.add({ code: 'legacy_provenance_unproven', severity: 'warning', message: knowledge.legacy + ' bar(s) stored without provenance: their knowledge is unproven', count: knowledge.legacy });
    }
    if (knowledge.total - knowledge.knownAtAsOf > 0) {
      const notHeld = knowledge.total - knowledge.knownAtAsOf;
      c.add({ code: 'decision_knowledge_not_proven', severity: 'warning', message: notHeld + ' bar(s) were not held by NEXUS at asOf (or are legacy): not usable as decision-time knowledge', count: notHeld });
    }
    const signalBar = [...unique].reverse().find((b) => b.isFinal);
    if (signalBar && !isContemporaneous(signalBar)) {
      c.add({ code: 'latest_bar_vintage_not_proven', severity: 'warning', message: 'the latest final bar (the signal bar) is a historical reconstruction: a live signal needs a contemporaneous signal bar', at: signalBar.startTime });
    }

    // Trading needs a known production source; unknown provenance is never tradable.
    const production = ctx.sourceInfo?.environment === 'production';
    return c.result((issues, severity) => {
      const has = (code: DataQualityIssue['code']) => issues.some((i) => i.code === code);
      const valid = RANK[severity] < RANK.error;
      const decisionKnown = !has('decision_knowledge_not_proven') && !has('legacy_provenance_unproven');
      const signalProven = !has('latest_bar_vintage_not_proven');
      return {
        usableForBacktest: valid && !has('partial_bar') && unique.length > 0,
        usableForTrading: valid && !stale && !has('partial_bar') && unique.length > 0 && ctx.calendar !== null && !freshnessAssumed && production && !has('missing_bars') && decisionKnown && signalProven,
      };
    });
  }

  assessQuote(
    quote: MarketQuote,
    ctx: { instrument: Pick<Instrument, 'instrumentId' | 'assetClass' | 'allowsNegativePrices'>; calendar: TradingCalendar | null; asOf: string; useCase: FreshnessUseCase; sourceInfo?: MarketDataSource | null; policy?: FreshnessPolicy },
  ): DataQualityResult {
    const c = new IssueCollector();
    const structural = validateQuote(quote, { allowsNegativePrices: ctx.instrument.allowsNegativePrices === true });
    for (const issue of structural) c.add(issue);
    let stale = false;
    let assumed = false;
    if (structural.length === 0) {
      if (quote.instrumentId !== ctx.instrument.instrumentId) c.add({ code: 'mixed_series', severity: 'error', message: 'quote belongs to another instrument' });
      if (parseUtc(quote.availableAt) > parseUtc(ctx.asOf)) c.add({ code: 'not_yet_available', severity: 'error', message: 'quote was not available at asOf (look-ahead)', at: quote.observedAt });
      else {
        const verdict = assessQuoteFreshness(quote, { assetClass: ctx.instrument.assetClass, calendar: ctx.calendar, asOf: ctx.asOf, useCase: ctx.useCase, ...(ctx.policy ?? this.policy ? { policy: (ctx.policy ?? this.policy)! } : {}) });
        assumed = verdict.calendarAssumed;
        if (!verdict.fresh) {
          stale = true;
          c.add({ code: 'stale', severity: 'warning', message: verdict.reason, at: quote.observedAt });
        }
      }
    }
    if (ctx.sourceInfo && ctx.sourceInfo.environment !== 'production') c.add({ code: 'non_production_source', severity: 'warning', message: 'source is ' + ctx.sourceInfo.environment + ' data' });
    const production = !!ctx.sourceInfo && ctx.sourceInfo.environment === 'production';
    return c.result((_issues, severity) => {
      const valid = RANK[severity] < RANK.error;
      return { usableForBacktest: valid, usableForTrading: valid && !stale && !assumed && production && ctx.calendar !== null };
    });
  }
}
