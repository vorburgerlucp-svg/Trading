// Execution clock (execution-clock:v1): when a market order can execute, and when a signal is usable for it.
//
// A daily bar's startTime is its data window (local midnight for the trading date). It is NOT the market open. A market order executes
// at the executable open of the session: the regular-session open of the trading date, from the instrument's TradingCalendar. An intraday
// bar's start is its own open, because the bar is a session bar that begins when the market opens for it. Nothing here approximates an
// open from UTC string slicing or hard-coded offsets: the calendar is the only source. If the calendar cannot prove the session, the
// helper throws EXECUTION_CALENDAR_UNPROVEN, and the run fails closed.
//
// Eligibility is decided at the executable open against the instant the signal was usable (its decision instant). Equality is eligible:
// a signal known exactly at the open may fill at that open. A signal known after the open cannot fill at it; it waits for the next
// executable open. See docs/BACKTEST_EXECUTION_CLOCK.md.

import type { BarInterval, MarketBar } from '../market-data/market-data-types.js';
import type { TradingCalendar } from '../market-data/sessions.js';
import { parseUtc } from '../market-data/time.js';

export const EXECUTION_CLOCK_VERSION = 'execution-clock:v1';

export class ExecutionClockError extends Error {
  override readonly name = 'ExecutionClockError';
  readonly code = 'EXECUTION_CALENDAR_UNPROVEN' as const;
  constructor(message: string) {
    super('EXECUTION_CALENDAR_UNPROVEN: ' + message);
  }
}

/** Calendar identity that enters the fingerprint. The runtime calendar object is never serialised. */
export interface ExecutionClockIdentity {
  version: string;
  calendarId: string;
  timezone: string;
  source: string;
  kind: string;
}

/** Where the executable open of a bar came from. */
export type OpenSource = 'regular_session_open' | 'intraday_bar_start';

/**
 * The executable market open of a bar, in ms. Daily: the regular session open of the bar's trading date, which the calendar must prove
 * (no session, or an assumed session, throws). Intraday: the bar's start, after the calendar proves the bar is a regular-session bar.
 */
export function executionOpenOf(bar: Pick<MarketBar, 'interval' | 'startTime' | 'session'>, calendar: TradingCalendar): { openMs: number; source: OpenSource } {
  const start = parseUtc(bar.startTime);
  if (bar.interval === '1d') {
    const date = calendar.dailyBarDate(start);
    const session = calendar.session(date, 'regular');
    if (!session) throw new ExecutionClockError(bar.startTime + ' trades on ' + date + ', which has no regular session in ' + calendar.calendarId);
    if (session.assumed) throw new ExecutionClockError(date + ' is outside the verified coverage of ' + calendar.calendarId + '; its open is not proven');
    return { openMs: session.open, source: 'regular_session_open' };
  }
  const window = calendar.barWindow(start, bar.interval as BarInterval, bar.session === 'extended' ? 'extended' : 'regular');
  if (!window.ok) throw new ExecutionClockError(bar.startTime + ' is not a ' + bar.interval + ' bar start in ' + calendar.calendarId + ' (' + window.reason + ')');
  if (window.assumed) throw new ExecutionClockError(bar.startTime + ' is outside the verified coverage of ' + calendar.calendarId + '; its open is not proven');
  return { openMs: start, source: 'intraday_bar_start' };
}

/** The executable open in ms (see executionOpenOf). */
export function executionOpenMs(bar: Pick<MarketBar, 'interval' | 'startTime' | 'session'>, calendar: TradingCalendar): number {
  return executionOpenOf(bar, calendar).openMs;
}

/**
 * A signal is eligible for an executable open when the open is at or after the instant the signal became usable. Equality is eligible.
 * A signal usable only after the open is not, and it may not fill retroactively at an open that had already passed.
 */
export function isEligibleAtOpen(decisionUsableMs: number, executionOpenMsOfCandidate: number): boolean {
  return executionOpenMsOfCandidate >= decisionUsableMs;
}

export function executionClockIdentity(calendar: TradingCalendar): ExecutionClockIdentity {
  return { version: EXECUTION_CLOCK_VERSION, calendarId: calendar.calendarId, timezone: calendar.timezone, source: calendar.source, kind: calendar.kind };
}
