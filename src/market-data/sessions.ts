// Trading sessions and calendars.
//
// A missing Sunday candle of a stock is not a data gap; a missing Sunday candle of BTC is. The
// calendar answers which bars SHOULD exist, so data quality, freshness, VWAP session resets and
// pivot periods never rely on a global "every N minutes" assumption.
//
// Three kinds:
//   exchange – sessions per trading date in the venue's time zone (weekends, holidays, early closes)
//   24x7     – crypto: one session per UTC day, never closed
//   24x5     – forex: Sunday 17:00 New York → Friday 17:00 New York, one session per trading date
//
// Holiday data is configuration with a stated source and coverage window. Outside the window a
// weekday is "unknown": sessions are then *assumed* and every result built on them is flagged
// (calendar_coverage), never silently treated as certain.

import { DataQualityError, INTERVAL_MS, isIntraday, type BarInterval, type Instrument } from './market-data-types.js';
import { addDays, assertLocalDate, assertTimeZone, isLocalDate, localDateOf, weekdayOf, zonedToUtc } from './time.js';

export type SessionScope = 'regular' | 'extended';
export type CalendarKind = 'exchange' | '24x7' | '24x5';
export type DayStatus = 'trading' | 'closed' | 'unknown';

export interface SessionWindow {
  /** Trading date (YYYY-MM-DD); identifies the session (VWAP reset, pivot period). */
  key: string;
  open: number;
  close: number;
  earlyClose: boolean;
  /** True when the date is outside the calendar's verified coverage and the session is assumed. */
  assumed: boolean;
}

export type BarWindow = { ok: true; start: number; end: number; sessionKey: string; assumed: boolean } | { ok: false; reason: 'outside_session' | 'misaligned' };

export interface TradingCalendar {
  readonly calendarId: string;
  readonly kind: CalendarKind;
  /** Time zone of the session definitions. */
  readonly timezone: string;
  readonly source: string;
  dayStatus(date: string): DayStatus;
  session(date: string, scope?: SessionScope): SessionWindow | null;
  /** Session containing instant `ms`, or null when the market is closed then. */
  sessionAt(ms: number, scope?: SessionScope): SessionWindow | null;
  isOpen(ms: number, scope?: SessionScope): boolean;
  /** Close of the most recent session that ended at or before `ms`. */
  lastCloseAtOrBefore(ms: number, scope?: SessionScope): number | null;
  /** Validates a bar start and returns its window (intraday bars end at the session close at the latest). */
  barWindow(startMs: number, interval: BarInterval, scope?: SessionScope): BarWindow;
  /** Start of the next bar that should exist after a bar starting at `startMs` (an aligned bar start). */
  nextBarStart(startMs: number, interval: BarInterval, scope?: SessionScope): number | null;
  /** First expected bar start at or after an arbitrary instant. */
  firstBarStartAtOrAfter(ms: number, interval: BarInterval, scope?: SessionScope): number | null;
  /** Expected bar starts strictly between two bar starts (bounded by `limit`). */
  expectedStartsBetween(afterStart: number, beforeStart: number, interval: BarInterval, scope?: SessionScope, limit?: number): { starts: number[]; assumed: number; truncated: boolean };
  /** Start of the most recent bar that is complete at `asOfMs - settleMs`. */
  latestCompletedBarStart(asOfMs: number, interval: BarInterval, scope?: SessionScope, settleMs?: number): number | null;
  /** Instant at which a daily bar of trading date `date` is complete (session close, or end of day). */
  dailyBarCompletion(date: string, scope?: SessionScope): number | null;
  /** UTC window of the daily bar of trading date `date`. */
  dailyBarWindow(date: string): { start: number; end: number };
  /** Trading date of a daily bar starting at `startMs`. */
  dailyBarDate(startMs: number): string;
}

interface SessionTimes {
  open: string;
  /** "24:00" means midnight at the end of the date. */
  close: string;
  /** Session opens on the previous calendar date (forex: Sunday 17:00 for Monday's session). */
  openOnPreviousDay?: boolean;
}

export interface SessionCalendarConfig {
  calendarId: string;
  kind: CalendarKind;
  timezone: string;
  /** Weekdays (0 = Sunday) that are never trading dates. */
  closedWeekdays: number[];
  regular: SessionTimes;
  extended?: SessionTimes;
  earlyClose?: { regular: string; extended?: string };
  holidays?: readonly string[];
  earlyCloseDates?: readonly string[];
  /** Verified range of holiday data. Undefined: the calendar has no holidays (24x7, 24x5). */
  coverage?: { from: string; to: string };
  /** exchange bars start at the session open; 24x7/24x5 provider bars are aligned to UTC multiples. */
  intradayAlignment: 'session_open' | 'epoch';
  /** Time zone in which a daily bar spans its date (exchange: venue zone; forex: UTC). */
  dailyBarTimeZone: string;
  /** Daily bar is complete at the session close (exchange, 24x7) or at the end of its day (forex). */
  dailyCompletion: 'session_close' | 'bar_end';
  /** Extended-hours times that are not verified against an official source make those sessions "assumed". */
  extendedHoursVerified?: boolean;
  source: string;
}

const MAX_CALENDAR_SCAN_DAYS = 15;

export class SessionCalendar implements TradingCalendar {
  readonly calendarId: string;
  readonly kind: CalendarKind;
  readonly timezone: string;
  readonly source: string;
  private readonly holidays: ReadonlySet<string>;
  private readonly earlyCloses: ReadonlySet<string>;
  private readonly cache = new Map<string, SessionWindow | null>();

  constructor(private readonly cfg: SessionCalendarConfig) {
    assertTimeZone(cfg.timezone);
    assertTimeZone(cfg.dailyBarTimeZone);
    for (const d of [...(cfg.holidays ?? []), ...(cfg.earlyCloseDates ?? [])]) assertLocalDate(d);
    if (cfg.coverage) {
      assertLocalDate(cfg.coverage.from);
      assertLocalDate(cfg.coverage.to);
    }
    this.calendarId = cfg.calendarId;
    this.kind = cfg.kind;
    this.timezone = cfg.timezone;
    this.source = cfg.source;
    this.holidays = new Set(cfg.holidays ?? []);
    this.earlyCloses = new Set(cfg.earlyCloseDates ?? []);
  }

  dayStatus(date: string): DayStatus {
    assertLocalDate(date);
    if (this.cfg.closedWeekdays.includes(weekdayOf(date))) return 'closed';
    if (this.holidays.has(date)) return 'closed';
    if (this.cfg.coverage && (date < this.cfg.coverage.from || date > this.cfg.coverage.to)) return 'unknown';
    return 'trading';
  }

  session(date: string, scope: SessionScope = 'regular'): SessionWindow | null {
    const cacheKey = date + '|' + scope;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;
    const status = this.dayStatus(date);
    let result: SessionWindow | null = null;
    const times = scope === 'extended' ? this.cfg.extended : this.cfg.regular;
    if (status !== 'closed' && times) {
      const early = this.earlyCloses.has(date);
      const closeTime = early ? (scope === 'extended' ? (this.cfg.earlyClose?.extended ?? times.close) : (this.cfg.earlyClose?.regular ?? times.close)) : times.close;
      const tz = this.cfg.timezone;
      const open = zonedToUtc(times.openOnPreviousDay ? addDays(date, -1) : date, times.open, tz);
      const close = closeTime === '24:00' ? zonedToUtc(addDays(date, 1), '00:00', tz) : zonedToUtc(date, closeTime, tz);
      const unverifiedExtended = scope === 'extended' && this.cfg.extendedHoursVerified !== true;
      result = { key: date, open, close, earlyClose: early, assumed: status === 'unknown' || unverifiedExtended };
    }
    if (this.cache.size > 50_000) this.cache.clear();
    this.cache.set(cacheKey, result);
    return result;
  }

  sessionAt(ms: number, scope: SessionScope = 'regular'): SessionWindow | null {
    const date = localDateOf(ms, this.cfg.timezone);
    for (const d of this.cfg.regular.openOnPreviousDay ? [date, addDays(date, 1)] : [date]) {
      const s = this.session(d, scope);
      if (s && s.open <= ms && ms < s.close) return s;
    }
    return null;
  }

  isOpen(ms: number, scope: SessionScope = 'regular'): boolean {
    return this.sessionAt(ms, scope) !== null;
  }

  lastCloseAtOrBefore(ms: number, scope: SessionScope = 'regular'): number | null {
    let date = addDays(localDateOf(ms, this.cfg.timezone), 1);
    for (let i = 0; i < MAX_CALENDAR_SCAN_DAYS; i++, date = addDays(date, -1)) {
      const s = this.session(date, scope);
      if (s && s.close <= ms) return s.close;
    }
    return null;
  }

  dailyBarWindow(date: string): { start: number; end: number } {
    return { start: zonedToUtc(date, '00:00', this.cfg.dailyBarTimeZone), end: zonedToUtc(addDays(date, 1), '00:00', this.cfg.dailyBarTimeZone) };
  }

  dailyBarDate(startMs: number): string {
    return localDateOf(startMs, this.cfg.dailyBarTimeZone);
  }

  dailyBarCompletion(date: string, scope: SessionScope = 'regular'): number | null {
    const s = this.session(date, scope);
    if (!s) return null;
    return this.cfg.dailyCompletion === 'session_close' ? s.close : this.dailyBarWindow(date).end;
  }

  barWindow(startMs: number, interval: BarInterval, scope: SessionScope = 'regular'): BarWindow {
    if (!isIntraday(interval)) {
      const date = this.dailyBarDate(startMs);
      const window = this.dailyBarWindow(date);
      if (window.start !== startMs) return { ok: false, reason: 'misaligned' };
      const s = this.session(date, scope);
      if (!s) return { ok: false, reason: 'outside_session' };
      return { ok: true, start: window.start, end: window.end, sessionKey: date, assumed: s.assumed };
    }
    const step = INTERVAL_MS[interval];
    if (this.cfg.intradayAlignment === 'epoch') {
      if (startMs % step !== 0) return { ok: false, reason: 'misaligned' };
      const s = this.sessionAt(startMs, scope) ?? this.sessionAt(startMs + step - 1, scope);
      if (!s || s.close <= startMs || s.open >= startMs + step) return { ok: false, reason: 'outside_session' };
      return { ok: true, start: startMs, end: startMs + step, sessionKey: s.key, assumed: s.assumed };
    }
    const s = this.sessionAt(startMs, scope);
    if (!s) return { ok: false, reason: 'outside_session' };
    if ((startMs - s.open) % step !== 0) return { ok: false, reason: 'misaligned' };
    return { ok: true, start: startMs, end: Math.min(startMs + step, s.close), sessionKey: s.key, assumed: s.assumed };
  }

  /** First session (in date order) that ends after `ms`. */
  private sessionEndingAfter(ms: number, scope: SessionScope): SessionWindow | null {
    let date = addDays(localDateOf(ms, this.cfg.timezone), -1);
    for (let i = 0; i < MAX_CALENDAR_SCAN_DAYS; i++, date = addDays(date, 1)) {
      const s = this.session(date, scope);
      if (s && s.close > ms) return s;
    }
    return null;
  }

  nextBarStart(startMs: number, interval: BarInterval, scope: SessionScope = 'regular'): number | null {
    if (!isIntraday(interval)) {
      let date = this.dailyBarDate(startMs);
      for (let i = 0; i < MAX_CALENDAR_SCAN_DAYS; i++) {
        date = addDays(date, 1);
        if (this.session(date, scope)) return this.dailyBarWindow(date).start;
      }
      return null;
    }
    const step = INTERVAL_MS[interval];
    if (this.cfg.intradayAlignment === 'epoch') {
      const candidate = startMs + step;
      const s = this.sessionEndingAfter(candidate, scope);
      if (!s) return null;
      if (s.open <= candidate) return candidate;
      const aligned = Math.floor(s.open / step) * step;
      return aligned > startMs ? aligned : aligned + step;
    }
    const candidate = startMs + step;
    const current = this.sessionAt(startMs, scope);
    if (current && candidate < current.close) return candidate;
    const s = this.sessionEndingAfter(current ? current.close : startMs, scope);
    if (!s) return null;
    return s.open > startMs ? s.open : null;
  }

  firstBarStartAtOrAfter(ms: number, interval: BarInterval, scope: SessionScope = 'regular'): number | null {
    if (!isIntraday(interval)) {
      let date = this.dailyBarDate(ms);
      for (let i = 0; i < MAX_CALENDAR_SCAN_DAYS; i++, date = addDays(date, 1)) {
        if (this.dailyBarWindow(date).start >= ms && this.session(date, scope)) return this.dailyBarWindow(date).start;
      }
      return null;
    }
    const step = INTERVAL_MS[interval];
    if (this.cfg.intradayAlignment === 'epoch') {
      const aligned = Math.ceil(ms / step) * step;
      return this.barWindow(aligned, interval, scope).ok ? aligned : this.nextBarStart(aligned, interval, scope);
    }
    const s = this.sessionAt(ms, scope);
    if (s) {
      const start = s.open + Math.ceil((ms - s.open) / step) * step;
      if (start < s.close) return start;
    }
    const next = this.sessionEndingAfter(s ? s.close : ms, scope);
    return next && next.open >= ms ? next.open : null;
  }

  expectedStartsBetween(afterStart: number, beforeStart: number, interval: BarInterval, scope: SessionScope = 'regular', limit = 10_000): { starts: number[]; assumed: number; truncated: boolean } {
    const starts: number[] = [];
    let assumed = 0;
    let x = this.nextBarStart(afterStart, interval, scope);
    while (x !== null && x < beforeStart) {
      if (starts.length >= limit) return { starts, assumed, truncated: true };
      starts.push(x);
      const w = this.barWindow(x, interval, scope);
      if (w.ok && w.assumed) assumed++;
      x = this.nextBarStart(x, interval, scope);
    }
    return { starts, assumed, truncated: false };
  }

  latestCompletedBarStart(asOfMs: number, interval: BarInterval, scope: SessionScope = 'regular', settleMs = 0): number | null {
    const limit = asOfMs - settleMs;
    if (!isIntraday(interval)) {
      let date = this.dailyBarDate(limit);
      for (let i = 0; i < MAX_CALENDAR_SCAN_DAYS; i++, date = addDays(date, -1)) {
        const completion = this.dailyBarCompletion(date, scope);
        if (completion !== null && completion <= limit) return this.dailyBarWindow(date).start;
      }
      return null;
    }
    const step = INTERVAL_MS[interval];
    let date = addDays(localDateOf(limit, this.cfg.timezone), 1);
    for (let i = 0; i < MAX_CALENDAR_SCAN_DAYS; i++, date = addDays(date, -1)) {
      const s = this.session(date, scope);
      if (!s || s.open >= limit) continue;
      if (this.cfg.intradayAlignment === 'epoch') {
        const first = Math.floor(s.open / step) * step;
        const lastInSession = Math.floor((s.close - 1) / step) * step;
        const candidate = Math.min(Math.floor(limit / step) * step - step, lastInSession);
        if (candidate >= first) return candidate;
        continue;
      }
      const count = Math.ceil((s.close - s.open) / step);
      const lastIndex = limit >= s.close ? count - 1 : Math.floor((limit - s.open) / step) - 1;
      if (lastIndex >= 0) return s.open + lastIndex * step;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Built-in calendars
// ---------------------------------------------------------------------------

/**
 * US equity market holidays and 1:00 p.m. early closes, 2026–2027.
 * Source: NYSE "Holidays & Trading Hours" (nyse.com/markets/hours-calendars), retrieved 2026-10-08;
 * Nasdaq's 2026 schedule was cross-checked (same dates). Extend only from official sources.
 */
export const US_EQUITY_CALENDAR_DATA = Object.freeze({
  coverage: { from: '2026-01-01', to: '2027-12-31' },
  holidays: [
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  ],
  earlyCloseDates: ['2026-11-27', '2026-12-24', '2027-11-26'],
  source: 'NYSE holidays & trading hours (retrieved 2026-10-08), Nasdaq 2026 cross-checked',
});

function usEquityCalendar(calendarId: string): SessionCalendar {
  return new SessionCalendar({
    calendarId,
    kind: 'exchange',
    timezone: 'America/New_York',
    closedWeekdays: [0, 6],
    regular: { open: '09:30', close: '16:00' },
    // Consolidated extended-hours window used by data vendors; NOT verified per venue → sessions are "assumed".
    extended: { open: '04:00', close: '20:00' },
    earlyClose: { regular: '13:00' },
    holidays: US_EQUITY_CALENDAR_DATA.holidays,
    earlyCloseDates: US_EQUITY_CALENDAR_DATA.earlyCloseDates,
    coverage: US_EQUITY_CALENDAR_DATA.coverage,
    intradayAlignment: 'session_open',
    dailyBarTimeZone: 'America/New_York',
    dailyCompletion: 'session_close',
    extendedHoursVerified: false,
    source: US_EQUITY_CALENDAR_DATA.source,
  });
}

export const CONTINUOUS_24X7 = new SessionCalendar({
  calendarId: '24x7',
  kind: '24x7',
  timezone: 'UTC',
  closedWeekdays: [],
  regular: { open: '00:00', close: '24:00' },
  intradayAlignment: 'epoch',
  dailyBarTimeZone: 'UTC',
  dailyCompletion: 'session_close',
  source: 'continuous market (no closures); one session per UTC day',
});

export const FOREX_24X5 = new SessionCalendar({
  calendarId: 'FX-24x5',
  kind: '24x5',
  timezone: 'America/New_York',
  // Trading dates Monday–Friday; Monday's session opens Sunday 17:00 New York.
  closedWeekdays: [0, 6],
  regular: { open: '17:00', close: '17:00', openOnPreviousDay: true },
  intradayAlignment: 'epoch',
  dailyBarTimeZone: 'UTC',
  dailyCompletion: 'bar_end',
  source: 'conventional FX week: Sunday 17:00 to Friday 17:00 America/New_York; no holiday data',
});

const BUILT_IN = new Map<string, TradingCalendar>([
  ['XNYS', usEquityCalendar('XNYS')],
  ['XNAS', usEquityCalendar('XNAS')],
  ['24x7', CONTINUOUS_24X7],
  ['FX-24x5', FOREX_24X5],
]);

export function getCalendar(calendarId: string): TradingCalendar | null {
  return BUILT_IN.get(calendarId) ?? null;
}

/**
 * ISO 10383 segment MIC → operating MIC (only entries verified for V1). Providers report the exact
 * listing segment (Twelve Data: AAPL → XNGS, Nasdaq Global Select), the calendar belongs to the venue.
 */
export const OPERATING_MIC: Readonly<Record<string, string>> = Object.freeze({ XNGS: 'XNAS', XNCM: 'XNAS', XNMS: 'XNAS' });

export function operatingMic(mic: string): string {
  return OPERATING_MIC[mic] ?? mic;
}

export function builtInCalendarIds(): string[] {
  return [...BUILT_IN.keys()];
}

/** Calendar of an instrument: explicit id, else derived from asset class / MIC. Null = unknown (never guessed). */
export function calendarForInstrument(instrument: Pick<Instrument, 'tradingCalendar' | 'assetClass' | 'mic'>): TradingCalendar | null {
  if (instrument.tradingCalendar) return getCalendar(instrument.tradingCalendar);
  if (instrument.assetClass === 'crypto') return CONTINUOUS_24X7;
  if (instrument.assetClass === 'forex') return FOREX_24X5;
  if (instrument.mic && BUILT_IN.has(operatingMic(instrument.mic))) return BUILT_IN.get(operatingMic(instrument.mic))!;
  return null;
}

export function requireCalendar(instrument: Pick<Instrument, 'instrumentId' | 'tradingCalendar' | 'assetClass' | 'mic'>): TradingCalendar {
  const calendar = calendarForInstrument(instrument);
  if (!calendar) {
    throw new DataQualityError('no trading calendar for instrument ' + instrument.instrumentId, [
      { code: 'calendar_unknown', severity: 'error', message: 'no trading calendar known for ' + instrument.instrumentId },
    ]);
  }
  return calendar;
}

export { isLocalDate };
