import { describe, expect, it } from 'vitest';
import { dailyBars, intradayBars } from '../market-data/fixtures.js';
import { XNAS, run, strategy, series, type Row } from './o2-fixtures.js';

// Execution clock (execution-clock:v1). A daily bar's startTime is its data window, not the market open. Fills happen at the
// executable open of the session, and a signal may fill there only if it was known at or before that open. See
// docs/BACKTEST_EXECUTION_CLOCK.md.

const OPEN_OCT8 = '2026-10-08T13:30:00.000Z';
const OPEN_OCT9 = '2026-10-09T13:30:00.000Z';
const DAILY_START_OCT8 = '2026-10-08T04:00:00.000Z';

/** A daily bar of the instrument with an explicit retrieval (which is also its knowledge) and its completion as its gate. */
function dailyAt(date: string, row: readonly [string, string, string, string], retrievedAt: string) {
  const [o, h, l, c] = row;
  return dailyBars(XNAS, date, [{ open: o, high: h, low: l, close: c, volume: '1000' }], { retrievedAt })[0]!;
}

/** Oct 7 (decision bar), Oct 8 (candidate, executable open 13:30) and Oct 9. The decision bar is known at `decisionKnownAt`. */
function daily(decisionKnownAt: string, nextOpen = '100') {
  return [
    dailyAt('2026-10-07', ['100', '100', '100', '100'], decisionKnownAt),
    dailyAt('2026-10-08', [nextOpen, nextOpen, nextOpen, nextOpen], '2026-10-08T20:00:00.000Z'),
    dailyAt('2026-10-09', ['100', '100', '100', '100'], '2026-10-09T20:00:00.000Z'),
  ];
}

describe('execution clock: daily next-bar eligibility uses the executable open (decision known before the open)', () => {
  it('a signal known at 10:00 UTC fills at the 13:30 UTC session open, not at the 04:00 UTC bar window start', () => {
    const r = run(daily('2026-10-08T10:00:00.000Z'), strategy({ enterAt: 1, exitAt: 100 }), { replay: 'decision_time' });
    const buy = r.fills.find((f) => f.side === 'buy')!;
    expect(buy.at).toBe(OPEN_OCT8);
    expect(buy.at).not.toBe(DAILY_START_OCT8);
  });

  it('a signal known at 13:29:59 is eligible for the 13:30 open', () => {
    const r = run(daily('2026-10-08T13:29:59.000Z'), strategy({ enterAt: 1, exitAt: 100 }), { replay: 'decision_time' });
    expect(r.fills.find((f) => f.side === 'buy')!.at).toBe(OPEN_OCT8);
  });

  it('a signal known exactly at the 13:30 open is eligible for it (equality is eligible)', () => {
    const r = run(daily(OPEN_OCT8), strategy({ enterAt: 1, exitAt: 100 }), { replay: 'decision_time' });
    expect(r.fills.find((f) => f.side === 'buy')!.at).toBe(OPEN_OCT8);
  });

  it('a signal known 1 ms after the 13:30 open cannot fill at that already-passed open; it fills at the next executable open', () => {
    const r = run(daily('2026-10-08T13:30:00.001Z'), strategy({ enterAt: 1, exitAt: 100 }), { replay: 'decision_time' });
    expect(r.fills.filter((f) => f.side === 'buy')).toHaveLength(1);
    expect(r.fills.find((f) => f.side === 'buy')!.at).toBe(OPEN_OCT9);
  });

  it('the position entryTime is the session open, not the bar window start', () => {
    const r = run(daily('2026-10-08T10:00:00.000Z'), strategy({ enterAt: 1, exitAt: 100 }), { replay: 'decision_time' });
    expect(r.openPosition!.entryTime).toBe(OPEN_OCT8);
  });
});

describe('execution clock: protective exits', () => {
  it('a gap stop fills at the session open, which is its execution timestamp', () => {
    const rows = [
      dailyAt('2026-10-07', ['100', '100', '100', '100'], '2026-10-07T20:00:00.000Z'),
      dailyAt('2026-10-08', ['100', '100', '100', '100'], '2026-10-08T20:00:00.000Z'),
      dailyAt('2026-10-09', ['19', '19', '18', '19'], '2026-10-09T20:00:00.000Z'),
    ];
    const r = run(rows, strategy({ enterAt: 1, exitAt: 100, stop: '80', target: '120' }));
    expect(r.trades[0]!.exit.reason).toBe('stop');
    expect(r.trades[0]!.exit.at).toBe(OPEN_OCT9);
  });

  it('a gap take-profit fills at the session open, which is its execution timestamp', () => {
    const rows = [
      dailyAt('2026-10-07', ['100', '100', '100', '100'], '2026-10-07T20:00:00.000Z'),
      dailyAt('2026-10-08', ['100', '100', '100', '100'], '2026-10-08T20:00:00.000Z'),
      dailyAt('2026-10-09', ['130', '131', '129', '130'], '2026-10-09T20:00:00.000Z'),
    ];
    const r = run(rows, strategy({ enterAt: 1, exitAt: 100, stop: '80', target: '120' }));
    expect(r.trades[0]!.exit.reason).toBe('take_profit');
    expect(r.trades[0]!.exit.at).toBe(OPEN_OCT9);
  });

  it('an intrabar stop touch is marked as intrabar-unknown timing, not presented as an exact open', () => {
    const rows = [
      dailyAt('2026-10-07', ['100', '100', '100', '100'], '2026-10-07T20:00:00.000Z'),
      dailyAt('2026-10-08', ['100', '100', '100', '100'], '2026-10-08T20:00:00.000Z'),
      dailyAt('2026-10-09', ['100', '101', '79', '90'], '2026-10-09T20:00:00.000Z'),
    ];
    const r = run(rows, strategy({ enterAt: 1, exitAt: 100, stop: '80', target: '120' }));
    expect(r.trades[0]!.exit.reason).toBe('stop');
    expect(r.trades[0]!.exit.timing.kind).toBe('INTRABAR_UNKNOWN');
  });
});

describe('execution clock: intraday next-bar eligibility', () => {
  const bar = (start: string, retrievedAt: string) => intradayBars(XNAS, start, '5m', [{ open: '100', high: '100', low: '100', close: '100', volume: '1000' }], { retrievedAt })[0]!;

  it('a signal known after the next intraday open cannot fill at that open; it fills at the next intraday bar', () => {
    // b0 is the last bar of 10-07 (19:55-20:00 UTC), known at 13:31 on 10-08. b1 starts at the 13:30 open, which had already passed.
    const bars = [bar('2026-10-07T19:55:00Z', '2026-10-08T13:31:00.000Z'), bar('2026-10-08T13:30:00Z', '2026-10-08T13:35:00.000Z'), bar('2026-10-08T13:35:00Z', '2026-10-08T13:40:00.000Z')];
    const r = run(bars, strategy({ enterAt: 1, exitAt: 100 }), { replay: 'decision_time' });
    expect(r.fills.find((f) => f.side === 'buy')!.at).toBe('2026-10-08T13:35:00.000Z');
  });

  it('a signal known before the next intraday open fills at that open (unchanged)', () => {
    const bars = [bar('2026-10-07T19:55:00Z', '2026-10-08T13:29:00.000Z'), bar('2026-10-08T13:30:00Z', '2026-10-08T13:35:00.000Z'), bar('2026-10-08T13:35:00Z', '2026-10-08T13:40:00.000Z')];
    const r = run(bars, strategy({ enterAt: 1, exitAt: 100 }), { replay: 'decision_time' });
    expect(r.fills.find((f) => f.side === 'buy')!.at).toBe('2026-10-08T13:30:00.000Z');
  });
});

describe('execution clock: a fill never comes from a daily window start', () => {
  it('for daily bars the fill timestamp is never the bar startTime', () => {
    const rows: Row[] = [['2026-10-07', '100', '100', '100', '100'], ['2026-10-08', '100', '100', '100', '100'], ['2026-10-09', '100', '100', '100', '100']];
    const r = run(series(rows), strategy({ enterAt: 1, exitAt: 2 }));
    for (const f of r.fills) expect(f.at).not.toMatch(/T04:00:00\.000Z$|T05:00:00\.000Z$/);
  });
});
