import { describe, expect, it } from 'vitest';
import { Decimal, divRound } from '../src/money/decimal.js';
import { applyBp, chf, chfRounded, displayChf, formatChf, MoneyError, prorateChf, ratioBp, splitChf, sumChf } from '../src/money/money.js';

describe('Decimal', () => {
  it('rechnet exakt, wo Float versagt', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(Decimal.from('0.1').plus('0.2').toString()).toBe('0.3');
    expect(Decimal.from('1.10').times('3').toString()).toBe('3.3');
    expect(Decimal.from('0.00012345').times('68000.5').toString()).toBe('8.394661725');
  });

  it('parst Strings, Zahlen, Exponenten und normalisiert', () => {
    expect(Decimal.from('1.50').toString()).toBe('1.5');
    expect(Decimal.from(1e-7).toString()).toBe('0.0000001');
    expect(Decimal.from('-2.5e3').toString()).toBe('-2500');
    expect(Decimal.from(42n).toString()).toBe('42');
    expect(() => Decimal.from('1,5')).toThrow();
    expect(() => Decimal.from(Number.NaN)).toThrow();
  });

  it('dividiert nur mit expliziter Rundung', () => {
    expect(Decimal.from(1).dividedBy(3, 4, 'half_even').toString()).toBe('0.3333');
    expect(Decimal.from(2).dividedBy(3, 2, 'down').toString()).toBe('0.66');
    expect(Decimal.from(2).dividedBy(3, 2, 'half_up').toString()).toBe('0.67');
    expect(() => Decimal.from(1).dividedBy(0, 2, 'half_even')).toThrow();
  });

  it.each([
    ['half_even', 5n, 2n, 2n],
    ['half_even', 7n, 2n, 4n],
    ['half_even', -5n, 2n, -2n],
    ['half_up', 5n, 2n, 3n],
    ['half_up', -5n, 2n, -3n],
    ['down', -7n, 2n, -3n],
    ['up', 7n, 3n, 3n],
    ['floor', -7n, 2n, -4n],
    ['ceil', -7n, 2n, -3n],
    ['ceil', 7n, 2n, 4n],
  ] as const)('divRound %s: %d / %d = %d', (mode, n, d, expected) => {
    expect(divRound(n, d, mode)).toBe(expected);
  });
});

describe('Money (Rappen)', () => {
  it('akzeptiert nur exakte CHF-Beträge', () => {
    expect(chf('35.50')).toBe(3550n);
    expect(chf(20)).toBe(2000n);
    expect(chf(0.1)).toBe(10n);
    expect(() => chf(0.1 + 0.2)).toThrow(MoneyError);
    expect(() => chf('1.005')).toThrow(MoneyError);
    expect(chfRounded('1.005', 'half_even')).toBe(100n);
    expect(chfRounded('1.015', 'half_even')).toBe(102n);
    expect(chfRounded('1.005', 'half_up')).toBe(101n);
  });

  it('summiert tausende kleine Beträge ohne Drift', () => {
    const amounts = Array.from({ length: 10_000 }, () => chf('0.10'));
    expect(formatChf(sumChf(amounts))).toBe('1000.00');
  });

  it('Basispunkte, Pro-rata und Verhältnisse', () => {
    expect(applyBp(chf(35), 1000, 'ceil')).toBe(chf('3.50'));
    expect(applyBp(chf('0.99'), 150, 'ceil')).toBe(chf('0.02'));
    expect(prorateChf(chf(100), 1, 3, 'half_even')).toBe(chf('33.33'));
    expect(ratioBp(chf(10), chf(20))).toBe(5000);
    expect(() => applyBp(chf(1), 1.5, 'ceil')).toThrow(MoneyError);
  });

  it('teilt Beträge ohne verlorene Rappen (Largest Remainder)', () => {
    const parts = splitChf(chf(100), [1n, 1n, 1n]);
    expect(parts.map(formatChf)).toEqual(['33.34', '33.33', '33.33']);
    expect(sumChf(parts)).toBe(chf(100));
    expect(splitChf(chf('0.05'), [3n, 1n]).map(formatChf)).toEqual(['0.04', '0.01']);
  });

  it('formatiert im Schweizer Format', () => {
    expect(displayChf(chf('527.43'))).toBe('CHF 527.43');
    expect(displayChf(chf('1234567.5'))).toBe("CHF 1'234'567.50");
    expect(displayChf(chf('-5'))).toBe('CHF -5.00');
  });
});
