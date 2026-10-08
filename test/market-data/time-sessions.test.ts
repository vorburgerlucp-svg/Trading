import { describe, expect, it } from 'vitest';
import { CONTINUOUS_24X7, FOREX_24X5, getCalendar, calendarForInstrument } from '../../src/market-data/sessions.js';
import { canonicalUtc, localDateOf, parseUtc, toUtcIso, zonedToUtc } from '../../src/market-data/time.js';
import { AAPL, BTC, EURUSD } from './fixtures.js';

const XNAS = getCalendar('XNAS')!;
const iso = (ms: number | null) => (ms === null ? null : toUtcIso(ms));

describe('Zeit: intern UTC, keine mehrdeutigen Zeitstempel', () => {
  it('nur explizite UTC-Zeitstempel werden akzeptiert', () => {
    expect(canonicalUtc('2026-10-07T13:30:00Z')).toBe('2026-10-07T13:30:00.000Z');
    for (const bad of ['2026-10-07 13:30:00', '2026-10-07T13:30:00', '2026-10-07T13:30:00+02:00', '2026-02-30T00:00:00Z', 'gestern', '1e12']) {
      expect(() => parseUtc(bad), bad).toThrow(/UTC|impossible/);
    }
  });

  it('DST-korrekte Umrechnung (USA und Europa wechseln an verschiedenen Tagen)', () => {
    expect(iso(zonedToUtc('2026-03-06', '09:30', 'America/New_York'))).toBe('2026-03-06T14:30:00.000Z'); // EST
    expect(iso(zonedToUtc('2026-03-09', '09:30', 'America/New_York'))).toBe('2026-03-09T13:30:00.000Z'); // EDT
    expect(iso(zonedToUtc('2026-03-27', '09:00', 'Europe/Zurich'))).toBe('2026-03-27T08:00:00.000Z'); // CET
    expect(iso(zonedToUtc('2026-03-30', '09:00', 'Europe/Zurich'))).toBe('2026-03-30T07:00:00.000Z'); // CEST
    expect(() => zonedToUtc('2026-03-29', '02:30', 'Europe/Zurich')).toThrow(/does not exist/);
    expect(localDateOf(parseUtc('2026-10-08T03:59:00Z'), 'America/New_York')).toBe('2026-10-07');
  });
});

describe('Börsenkalender XNAS', () => {
  it('Regular Session über die Zeitumstellung', () => {
    expect([iso(XNAS.session('2026-03-06')!.open), iso(XNAS.session('2026-03-06')!.close)]).toEqual(['2026-03-06T14:30:00.000Z', '2026-03-06T21:00:00.000Z']);
    expect([iso(XNAS.session('2026-03-09')!.open), iso(XNAS.session('2026-03-09')!.close)]).toEqual(['2026-03-09T13:30:00.000Z', '2026-03-09T20:00:00.000Z']);
    expect(iso(XNAS.session('2026-11-02')!.open)).toBe('2026-11-02T14:30:00.000Z');
  });

  it('Wochenende, Feiertag (Karfreitag) und Early Close aus dem offiziellen Kalender', () => {
    expect(XNAS.session('2026-10-10')).toBeNull(); // Saturday
    expect(XNAS.session('2026-04-03')).toBeNull(); // Good Friday
    expect(XNAS.dayStatus('2026-07-03')).toBe('closed'); // Independence Day observed
    const early = XNAS.session('2026-11-27')!;
    expect(early.earlyClose).toBe(true);
    expect(iso(early.close)).toBe('2026-11-27T18:00:00.000Z'); // 13:00 EST
  });

  it('ausserhalb der verifizierten Abdeckung: "unknown", Session nur angenommen', () => {
    expect(XNAS.dayStatus('2025-12-31')).toBe('unknown');
    expect(XNAS.session('2025-12-31')!.assumed).toBe(true);
    expect(XNAS.dayStatus('2025-12-27')).toBe('closed'); // weekends are structural
    expect(XNAS.session('2026-10-07')!.assumed).toBe(false);
  });

  it('nach Freitagsschluss ist der nächste erwartete Bar Montag 09:30 — keine Wochenend-Lücke', () => {
    const fridayLast = parseUtc('2026-10-02T19:55:00Z');
    expect(iso(XNAS.nextBarStart(fridayLast, '5m'))).toBe('2026-10-05T13:30:00.000Z');
    expect(XNAS.expectedStartsBetween(fridayLast, parseUtc('2026-10-05T13:30:00Z'), '5m').starts).toEqual([]);
    // a missing Monday bar IS a gap
    expect(XNAS.expectedStartsBetween(fridayLast, parseUtc('2026-10-05T13:40:00Z'), '5m').starts.map(iso)).toEqual(['2026-10-05T13:30:00.000Z', '2026-10-05T13:35:00.000Z']);
  });

  it('über die Zeitumstellung hinweg: Freitag letzter Bar (EST) → Montag erster Bar (EDT), keine Scheinlücke', () => {
    const fridayLast = parseUtc('2026-03-06T20:55:00Z'); // 15:55 EST
    expect(iso(XNAS.nextBarStart(fridayLast, '5m'))).toBe('2026-03-09T13:30:00.000Z'); // 09:30 EDT
    expect(XNAS.expectedStartsBetween(fridayLast, parseUtc('2026-03-09T13:30:00Z'), '5m').starts).toEqual([]);
    expect(XNAS.barWindow(parseUtc('2026-03-09T14:30:00Z'), '1h')).toMatchObject({ ok: true }); // 10:30 EDT
    expect(XNAS.barWindow(parseUtc('2026-03-06T14:30:00Z'), '1h')).toMatchObject({ ok: true }); // 09:30 EST
  });

  it('1h-Bars beginnen um 09:30; der letzte endet am Sessionschluss (16:00), nicht 16:30', () => {
    const w = XNAS.barWindow(parseUtc('2026-10-07T19:30:00Z'), '1h');
    expect(w).toMatchObject({ ok: true, sessionKey: '2026-10-07' });
    expect(w.ok && iso(w.end)).toBe('2026-10-07T20:00:00.000Z');
    expect(XNAS.barWindow(parseUtc('2026-10-07T14:00:00Z'), '1h')).toEqual({ ok: false, reason: 'misaligned' });
    expect(XNAS.barWindow(parseUtc('2026-10-07T12:00:00Z'), '5m')).toEqual({ ok: false, reason: 'outside_session' });
  });

  it('Tagesbar = lokales Handelsdatum, abgeschlossen mit dem Sessionschluss', () => {
    const w = XNAS.dailyBarWindow('2026-10-07');
    expect([iso(w.start), iso(w.end)]).toEqual(['2026-10-07T04:00:00.000Z', '2026-10-08T04:00:00.000Z']);
    expect(iso(XNAS.dailyBarCompletion('2026-10-07'))).toBe('2026-10-07T20:00:00.000Z');
    expect(iso(XNAS.latestCompletedBarStart(parseUtc('2026-10-10T12:00:00Z'), '1d'))).toBe('2026-10-09T04:00:00.000Z'); // Saturday → Friday
    expect(iso(XNAS.latestCompletedBarStart(parseUtc('2026-10-07T14:02:00Z'), '5m'))).toBe('2026-10-07T13:55:00.000Z');
    expect(iso(XNAS.latestCompletedBarStart(parseUtc('2026-10-10T12:00:00Z'), '5m'))).toBe('2026-10-09T19:55:00.000Z');
  });
});

describe('Crypto 24/7 und Forex 24/5', () => {
  it('Crypto: Sonntag ist ein normaler Handelstag', () => {
    expect(CONTINUOUS_24X7.isOpen(parseUtc('2026-10-04T12:00:00Z'))).toBe(true);
    expect(CONTINUOUS_24X7.barWindow(parseUtc('2026-10-04T12:00:00Z'), '1h')).toMatchObject({ ok: true });
    expect(CONTINUOUS_24X7.expectedStartsBetween(parseUtc('2026-10-03T23:00:00Z'), parseUtc('2026-10-04T02:00:00Z'), '1h').starts.map(iso)).toEqual([
      '2026-10-04T00:00:00.000Z',
      '2026-10-04T01:00:00.000Z',
    ]);
  });

  it('Forex: Woche öffnet Sonntag 17:00 New York (DST-abhängig in UTC) und schliesst Freitag 17:00', () => {
    expect(FOREX_24X5.isOpen(parseUtc('2026-10-04T20:59:00Z'))).toBe(false);
    expect(FOREX_24X5.sessionAt(parseUtc('2026-10-04T21:00:00Z'))?.key).toBe('2026-10-05');
    expect(FOREX_24X5.isOpen(parseUtc('2026-10-09T21:00:00Z'))).toBe(false);
    expect(FOREX_24X5.isOpen(parseUtc('2026-11-08T21:30:00Z'))).toBe(false); // EST: opens 22:00Z
    expect(FOREX_24X5.isOpen(parseUtc('2026-11-08T22:00:00Z'))).toBe(true);
    // Friday's last hourly bar → Sunday's first bar, no weekend gap
    expect(iso(FOREX_24X5.nextBarStart(parseUtc('2026-10-09T20:00:00Z'), '1h'))).toBe('2026-10-11T21:00:00.000Z');
  });

  it('Kalender wird aus dem Instrument abgeleitet, nie geraten', () => {
    expect(calendarForInstrument(AAPL)?.calendarId).toBe('XNAS');
    expect(calendarForInstrument(BTC)?.calendarId).toBe('24x7');
    expect(calendarForInstrument(EURUSD)?.calendarId).toBe('FX-24x5');
    expect(calendarForInstrument({ assetClass: 'stock', mic: 'XSWX' })).toBeNull();
    // segment MIC (as Twelve Data reports AAPL) → operating venue calendar
    expect(calendarForInstrument({ assetClass: 'stock', mic: 'XNGS' })?.calendarId).toBe('XNAS');
  });
});
