// Unambiguous time handling for market data.
//
// Internally every instant is a UTC timestamp. Strings must carry an explicit "Z": a local time
// without zone ("2026-10-07 09:30") is ambiguous and rejected. Exchange time zones stay metadata of
// the instrument/calendar and are only used to convert *local session definitions* (09:30 New York)
// into UTC instants, DST-correct via Intl (no hand-written DST rules).

export class TimeError extends Error {
  override readonly name = 'TimeError';
}

const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return DAYS_IN_MONTH[month - 1]!;
}

/** Parses a strict UTC instant ("...Z"). Rejects offsets, local times and impossible dates. */
export function parseUtc(value: string): number {
  if (typeof value !== 'string') throw new TimeError('timestamp must be a string');
  const m = ISO_UTC.exec(value);
  if (!m) throw new TimeError('not an unambiguous UTC timestamp (expected YYYY-MM-DDTHH:mm:ss[.sss]Z): "' + value.slice(0, 40) + '"');
  const [, y, mo, d, h, mi, s, frac = '0'] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (year < MIN_YEAR || year > MAX_YEAR) throw new TimeError('year out of range: ' + year);
  // Date.UTC silently rolls over (Feb 30 → Mar 2): reject impossible fields explicitly.
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) throw new TimeError('impossible date/time: "' + value + '"');
  return Date.UTC(year, month - 1, day, hour, minute, second, Number(frac.padEnd(3, '0')));
}

export function toUtcIso(ms: number): string {
  if (!Number.isFinite(ms)) throw new TimeError('instant is not finite');
  return new Date(ms).toISOString();
}

/** Canonical form "YYYY-MM-DDTHH:mm:ss.sssZ" of a strict UTC timestamp. */
export function canonicalUtc(value: string): string {
  return toUtcIso(parseUtc(value));
}

export function isLocalDate(value: string): boolean {
  const m = LOCAL_DATE.exec(value);
  if (!m) return false;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === value;
}

export function assertLocalDate(value: string): string {
  if (typeof value !== 'string' || !isLocalDate(value)) throw new TimeError('not a calendar date (YYYY-MM-DD): "' + String(value).slice(0, 20) + '"');
  return value;
}

/** Calendar arithmetic on YYYY-MM-DD (time-zone free). */
export function addDays(date: string, days: number): string {
  assertLocalDate(date);
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: string): number {
  assertLocalDate(date);
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))).getUTCDay();
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, number>();
/** Offsets only change at transition instants, which are multiples of 15 minutes UTC for all real zones. */
const OFFSET_BUCKET_MS = 15 * MINUTE_MS;

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      throw new TimeError('unknown IANA time zone "' + String(timeZone).slice(0, 60) + '"');
    }
    formatters.set(timeZone, f);
  }
  return f;
}

export function assertTimeZone(timeZone: string): string {
  formatter(timeZone);
  return timeZone;
}

function computeOffset(ms: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC offset of `timeZone` at instant `ms` (local = utc + offset). */
export function zoneOffsetMs(ms: number, timeZone: string): number {
  const bucket = Math.floor(ms / OFFSET_BUCKET_MS);
  const key = timeZone + '|' + bucket;
  let offset = offsetCache.get(key);
  if (offset === undefined) {
    offset = computeOffset(bucket * OFFSET_BUCKET_MS, timeZone);
    if (offsetCache.size > 200_000) offsetCache.clear();
    offsetCache.set(key, offset);
  }
  return offset;
}

/** Local calendar date (YYYY-MM-DD) of an instant in `timeZone`. */
export function localDateOf(ms: number, timeZone: string): string {
  return new Date(ms + zoneOffsetMs(ms, timeZone)).toISOString().slice(0, 10);
}

/** Local wall-clock "HH:MM" of an instant in `timeZone`. */
export function localTimeOf(ms: number, timeZone: string): string {
  return new Date(ms + zoneOffsetMs(ms, timeZone)).toISOString().slice(11, 16);
}

/**
 * Converts a local wall-clock time on a local date in `timeZone` to a UTC instant, DST-correct.
 * Wall-clock times that do not exist (spring-forward gap) are rejected instead of being shifted.
 */
export function zonedToUtc(date: string, time: string, timeZone: string): number {
  assertLocalDate(date);
  const t = LOCAL_TIME.exec(time);
  if (!t) throw new TimeError('not a local time (HH:MM[:SS]): "' + time + '"');
  const local = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Number(t[1]), Number(t[2]), Number(t[3] ?? 0));
  let utc = local - zoneOffsetMs(local, timeZone);
  const second = zoneOffsetMs(utc, timeZone);
  if (local - second !== utc) utc = local - second;
  if (utc + zoneOffsetMs(utc, timeZone) !== local) throw new TimeError(date + ' ' + time + ' does not exist in ' + timeZone + ' (DST gap)');
  return utc;
}
