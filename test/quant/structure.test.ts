import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/money/decimal.js';
import { marketStructure, type StructureSwing } from '../../src/quant/structure/market-structure.js';
import { supportResistance, type SwingLevelInput } from '../../src/quant/structure/support-resistance.js';
import { findSwings } from '../../src/quant/structure/swings.js';

describe('Swing High / Low mit Bestätigungszeitpunkt', () => {
  // Bar 10 is a local high; with rightBars = 3 it is confirmed by bar 13 at the earliest.
  const high = [10, 11, 12, 11, 12, 13, 12, 13, 14, 15, 20, 18, 17, 16, 15, 14];
  const low = high.map((h) => h - 2);

  it('vor Bar 13 nicht bestätigt, ab Bar 13 bestätigt', () => {
    for (let last = 10; last <= 12; last++) {
      expect(findSwings(high.slice(0, last + 1), low.slice(0, last + 1), 3, 3).some((s) => s.kind === 'high' && s.index === 10)).toBe(false);
    }
    const confirmed = findSwings(high.slice(0, 14), low.slice(0, 14), 3, 3).find((s) => s.kind === 'high' && s.index === 10);
    expect(confirmed).toEqual({ kind: 'high', index: 10, confirmedIndex: 13 });
  });

  it('Gleichstand: der erste von zwei gleich hohen Hochs ist der Swing (deterministisch)', () => {
    const h = [1, 2, 3, 9, 9, 3, 2, 1, 1];
    const s = findSwings(h, h.map((x) => x - 1), 3, 3).filter((x) => x.kind === 'high');
    expect(s.map((x) => x.index)).toEqual([3]);
  });

  it('ungültige Parameter werden abgewiesen', () => {
    expect(() => findSwings([1], [1], 0, 3)).toThrow(/leftBars/);
    expect(() => findSwings([1, 2], [1], 1, 1)).toThrow(/same length/);
  });
});

const sw = (kind: 'high' | 'low', index: number, price: string, confirmedIndex = index + 3): SwingLevelInput & StructureSwing => ({
  kind,
  index,
  price: Decimal.from(price),
  time: 't' + String(index).padStart(3, '0'),
  confirmedIndex,
  confirmedAt: 'c' + String(confirmedIndex).padStart(3, '0'),
});

describe('Support / Resistance aus bestätigten Swings', () => {
  const swings = [sw('low', 10, '99.90'), sw('high', 20, '110.00'), sw('low', 30, '100.10'), sw('high', 40, '110.20'), sw('low', 50, '100.00'), sw('high', 60, '120.00')];
  const options = { referencePrice: Decimal.from('105'), tolerance: Decimal.from('0.5'), minTouches: 2, lookbackBars: 100, lastIndex: 70, priceScale: 2 };

  it('Cluster, Level-Preis exakt, Berührungen, Zeitpunkte, Art', () => {
    const levels = supportResistance(swings, options);
    expect(levels.map((l) => [l.kind, l.priceLevel.toString(), l.touchCount])).toEqual([
      ['support', '100', 3], // (99.90 + 100.10 + 100.00)/3
      ['resistance', '110.1', 2], // (110.00 + 110.20)/2; 120.00 has only one touch
    ]);
    const support = levels[0]!;
    expect([support.firstSeen, support.lastSeen]).toEqual(['t010', 't050']);
    expect(support.confirmedAt).toBe('c033'); // second touch confirmed at bar 33
    expect(support.strengthScore).toBeGreaterThan(0);
    expect(support.strengthScore).toBeLessThanOrEqual(1);
  });

  it('nur bestätigte Swings zählen; ein noch nicht bestätigter Swing erzeugt kein Level', () => {
    const levels = supportResistance([...swings.slice(0, 4), sw('high', 69, '120.00', 72)], { ...options, minTouches: 2 });
    expect(levels.find((l) => l.priceLevel.eq('120'))).toBeUndefined();
  });

  it('Reihenfolge der Eingabe ändert nichts', () => {
    expect(supportResistance([...swings].reverse(), options)).toEqual(supportResistance(swings, options));
  });
});

describe('Market Structure HH / HL / LH / LL', () => {
  it('bullish, bearish, range, unknown', () => {
    expect(marketStructure([sw('low', 1, '10'), sw('high', 2, '12'), sw('low', 3, '11'), sw('high', 4, '13')])).toMatchObject({ trend: 'bullish', lastHighLabel: 'HH', lastLowLabel: 'HL' });
    expect(marketStructure([sw('high', 1, '13'), sw('low', 2, '11'), sw('high', 3, '12'), sw('low', 4, '10')])).toMatchObject({ trend: 'bearish', lastHighLabel: 'LH', lastLowLabel: 'LL' });
    expect(marketStructure([sw('high', 1, '13'), sw('low', 2, '10'), sw('high', 3, '12'), sw('low', 4, '11')])).toMatchObject({ trend: 'range', lastHighLabel: 'LH', lastLowLabel: 'HL' });
    expect(marketStructure([sw('high', 1, '12'), sw('low', 2, '10'), sw('high', 3, '12'), sw('low', 4, '11')])).toMatchObject({ trend: 'range', lastHighLabel: 'EH' });
    expect(marketStructure([sw('high', 1, '13'), sw('low', 2, '10')])).toMatchObject({ trend: 'unknown' });
  });
});
