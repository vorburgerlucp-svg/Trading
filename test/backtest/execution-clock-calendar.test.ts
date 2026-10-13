import { describe, expect, it } from 'vitest';
import { executionClockIdentity, executionOpenOf, executionOpenMs, isEligibleAtOpen, EXECUTION_CLOCK_VERSION, ExecutionClockError } from '../../src/backtest/execution-clock.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { toUtcIso } from '../../src/market-data/time.js';
import type { BarInterval, MarketBar } from '../../src/market-data/market-data-types.js';
import { XNAS, run, series, strategy, withActions, ca, SPLIT_ROWS, SPLIT_4_1, K0, type Row } from './o2-fixtures.js';
import { intradayBars } from '../market-data/fixtures.js';

// Execution clock calendar contract (execution-clock:v1): standard and daylight time, the DST boundary, early closes, holidays, weekends,
// unproven coverage, and identity. The calendar is the only source of an executable open; there are no UTC offsets in production logic.

const XNYS = getCalendar('XNYS')!;

/** A daily bar as the data layer stores it: its start is the local midnight of the trading date (the window start). */
function dailyBar(date: string, calendar = XNAS): Pick<MarketBar, 'interval' | 'startTime' | 'session'> {
  return { interval: '1d', startTime: toUtcIso(calendar.dailyBarWindow(date).start), session: 'regular' };
}

describe('execution clock: daily executable open from the calendar', () => {
  it('standard time (January): the regular session opens at 14:30 UTC, not at the 05:00 UTC window start', () => {
    const bar = dailyBar('2026-01-12');
    expect(bar.startTime).toBe('2026-01-12T05:00:00.000Z');
    expect(executionOpenMs(bar, XNAS)).toBe(Date.parse('2026-01-12T14:30:00.000Z'));
  });

  it('daylight time (October): the regular session opens at 13:30 UTC, not at the 04:00 UTC window start', () => {
    const bar = dailyBar('2026-10-08');
    expect(bar.startTime).toBe('2026-10-08T04:00:00.000Z');
    expect(executionOpenMs(bar, XNAS)).toBe(Date.parse('2026-10-08T13:30:00.000Z'));
  });

  it('the DST boundary: Friday 6 March (standard) opens at 14:30, Monday 9 March (daylight) at 13:30; the Sunday between is not a session', () => {
    expect(executionOpenMs(dailyBar('2026-03-06'), XNAS)).toBe(Date.parse('2026-03-06T14:30:00.000Z'));
    expect(executionOpenMs(dailyBar('2026-03-09'), XNAS)).toBe(Date.parse('2026-03-09T13:30:00.000Z'));
    expect(() => executionOpenMs(dailyBar('2026-03-08'), XNAS)).toThrow(ExecutionClockError);
  });

  it('an early-close day still has the normal session open: the early close moves only the close', () => {
    const session = XNAS.session('2026-11-27', 'regular')!;
    expect(session.earlyClose).toBe(true);
    expect(executionOpenMs(dailyBar('2026-11-27'), XNAS)).toBe(Date.parse('2026-11-27T14:30:00.000Z'));
  });

  it('a holiday has no regular session: it fails closed', () => {
    expect(() => executionOpenMs(dailyBar('2026-11-26'), XNAS)).toThrow(/EXECUTION_CALENDAR_UNPROVEN/);
  });

  it('a weekend has no regular session: it fails closed', () => {
    expect(() => executionOpenMs(dailyBar('2026-10-10'), XNAS)).toThrow(/EXECUTION_CALENDAR_UNPROVEN/);
  });

  it('a session the calendar only assumes (outside its verified coverage) is not proven: it fails closed', () => {
    expect(() => executionOpenMs(dailyBar('2028-03-06'), XNAS)).toThrow(/outside the verified coverage/);
  });
});

describe('execution clock: intraday bar start is the executable open, proven by the calendar', () => {
  it('a regular-session 5-minute bar start is its open', () => {
    const bar = intradayBars(XNAS, '2026-10-08T13:30:00Z', '5m' as BarInterval, [{ open: '1', high: '1', low: '1', close: '1', volume: '1' }])[0]!;
    expect(executionOpenOf(bar, XNAS)).toEqual({ openMs: Date.parse('2026-10-08T13:30:00.000Z'), source: 'intraday_bar_start' });
  });

  it('a bar start outside the regular session is not an executable open: it fails closed', () => {
    const outside = { interval: '5m' as const, startTime: '2026-10-08T22:00:00.000Z', session: 'regular' as const };
    expect(() => executionOpenOf(outside, XNAS)).toThrow(/EXECUTION_CALENDAR_UNPROVEN/);
  });
});

describe('execution clock: eligibility at the open', () => {
  it('equality is eligible; one millisecond later is not', () => {
    const open = Date.parse('2026-10-08T13:30:00.000Z');
    expect(isEligibleAtOpen(open, open)).toBe(true);
    expect(isEligibleAtOpen(open + 1, open)).toBe(false);
    expect(isEligibleAtOpen(open - 1, open)).toBe(true);
  });
});

describe('execution clock: identity enters the fingerprint', () => {
  it('the identity records the version and the calendar identity, never the runtime object', () => {
    expect(executionClockIdentity(XNAS)).toEqual({ version: EXECUTION_CLOCK_VERSION, calendarId: 'XNAS', timezone: XNAS.timezone, source: XNAS.source, kind: XNAS.kind });
    expect(EXECUTION_CLOCK_VERSION).toBe('execution-clock:v1');
  });

  it('a different execution calendar changes the run identity, even with identical bars', () => {
    const bars = series([['2026-10-05', '100', '100', '100', '100'], ['2026-10-06', '100', '100', '100', '100'], ['2026-10-07', '100', '100', '100', '100']]);
    const onXnas = run(bars, strategy({ enterAt: 1, exitAt: 100 }));
    const onXnys = run(bars, strategy({ enterAt: 1, exitAt: 100 }), { executionCalendar: XNYS });
    expect(onXnas.backtestRunId).not.toBe(onXnys.backtestRunId);
    expect(onXnys.executionClock).toMatchObject({ calendarId: 'XNYS', version: 'execution-clock:v1' });
  });
});

describe('execution clock: corporate actions and fills at the same instant', () => {
  it('an action effective at 13:30 and a pending fill at 13:30: both are 13:30, and the engine order (action then fill) is explicit', () => {
    const r = run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 3, exitAt: 100 }), withActions([{ ...SPLIT_4_1, knowledge: { provenance: 'captured_by_nexus', knowledgeAt: K0 }, retrievedAt: K0, storedAvailableAt: K0 }]));
    const applied = r.corporateActions!.applied[0]!;
    const buy = r.fills.find((f) => f.side === 'buy')!;
    expect(applied.effectiveAt).toBe('2026-10-08T13:30:00.000Z');
    expect(applied.appliedAt).toBe('2026-10-08T13:30:00.000Z');
    expect(buy.at).toBe('2026-10-08T13:30:00.000Z');
    expect(buy.executionPrice.toString()).toBe('25');
    expect(r.openPosition!.quantity.toString()).toBe('40');
    expect(applied.processedAt > buy.at).toBe(true);
  });

  it('the dividend convention is unchanged: a sell filled at the ex-date open is still entitled (fixed before the open)', () => {
    const rows: Row[] = [...SPLIT_ROWS.slice(0, 3), ['2026-10-08', '100', '100', '100', '100'], ['2026-10-09', '100', '100', '100', '100']];
    const div = ca({ key: 'dividend:2026-10-08', type: 'cash_dividend', exDate: '2026-10-08', cash: '0.5', currency: 'USD' });
    const r = run(series(rows), strategy({ enterAt: 1, exitAt: 3 }), withActions([div]));
    expect(r.corporateActions!.dividendReceivables[0]!.entitledQuantity.toString()).toBe('10');
    expect(r.trades[0]!.exit.at).toBe('2026-10-08T13:30:00.000Z');
  });
});

describe('execution clock: timing semantics of fills', () => {
  it('a market entry on an intraday bar is an exact open', () => {
    const bars = intradayBars(XNAS, '2026-10-08T13:30:00Z', '5m' as BarInterval, [
      { open: '100', high: '100', low: '100', close: '100', volume: '1000' },
      { open: '100', high: '100', low: '100', close: '100', volume: '1000' },
      { open: '100', high: '100', low: '100', close: '100', volume: '1000' },
    ]);
    const r = run(bars, strategy({ enterAt: 1, exitAt: 100 }));
    expect(r.fills[0]!.timing).toEqual({ kind: 'OPEN_EXACT', executionAt: '2026-10-08T13:35:00.000Z', barStart: '2026-10-08T13:35:00.000Z', openSource: 'intraday_bar_start' });
  });

  it('a daily market entry records the regular session open as its exact time and the window start as its bar', () => {
    // Decided on 10-05, so the fill is the 10-06 open.
    const r = run(series(SPLIT_ROWS.slice(0, 3)), strategy({ enterAt: 1, exitAt: 100 }));
    expect(r.fills[0]!.timing).toEqual({ kind: 'OPEN_EXACT', executionAt: '2026-10-06T13:30:00.000Z', barStart: '2026-10-06T04:00:00.000Z', openSource: 'regular_session_open' });
    expect(r.fills[0]!.at).toBe('2026-10-06T13:30:00.000Z');
  });
});

