import { describe, expect, it } from 'vitest';
import { chf } from '../src/money/money.js';
import {
  createOpportunity,
  estimateForAmount,
  OpportunityError,
  rankOpportunities,
  riskAdjustedProfit,
  scoreOpportunity,
  transitionOpportunity,
} from '../src/opportunities/opportunity-engine.js';
import { appleSwing, batteryTrade, btcTrade, chewingGumResale } from './fixtures/opportunities.js';
import { fmt, T0 } from './helpers.js';

const human = { kind: 'human', id: 'luc' } as const;
const system = { kind: 'system', id: 'allocator' } as const;

describe('Opportunity Engine', () => {
  it('berechnet risikoadjustierten Gewinn: Confidence x Gewinn − (1 − Confidence) x Downside', () => {
    expect(fmt(riskAdjustedProfit(chf(10), chf(10), 0.8))).toBe('6.00');
    expect(fmt(riskAdjustedProfit(chf(15), chf(30), 0.5))).toBe('-7.50');
    expect(fmt(riskAdjustedProfit(chf(8), chf(5), 0.6))).toBe('2.80');
  });

  it('wählt nicht einfach die höchste Prozentzahl', () => {
    const [apple, btc, gum, battery] = [appleSwing, btcTrade, chewingGumResale, batteryTrade].map((o) => createOpportunity(o));
    // BTC promises 15 % (more than Apple's 8 %), but risk-adjusted it is negative → never fundable.
    expect(btc?.scores.expectedReturnBp).toBe(1500);
    expect(btc?.eligibility.eligible).toBe(false);
    expect(btc?.eligibility.reasons).toContain('risk-adjusted profit is not positive');
    expect(apple?.eligibility.eligible).toBe(true);

    const ranked = rankOpportunities([apple!, btc!, gum!, battery!]).map((o) => o.id);
    expect(ranked).toEqual(['kaugummi-resale', 'apple-swing', 'batterie-handel', 'btc-trade']);
  });

  it('ist deterministisch und erklärbar', () => {
    const a = scoreOpportunity(chewingGumResale);
    const b = scoreOpportunity(chewingGumResale);
    expect(a).toEqual(b);
    expect(Object.keys(a.components).sort()).toEqual(['effort', 'liquidity', 'regulatory', 'return', 'risk', 'safety']);
    expect(a.opportunityScore).toBeGreaterThan(0);
    expect(a.opportunityScore).toBeLessThanOrEqual(100);
  });

  it('verlangt These, Exit-Plan und gültige Scores', () => {
    expect(() => createOpportunity({ ...appleSwing, exitPlan: ' ' })).toThrow(/exit plan/);
    expect(() => createOpportunity({ ...appleSwing, thesis: [] })).toThrow(/thesis/);
    expect(() => createOpportunity({ ...appleSwing, confidenceScore: 1.2 })).toThrow(/confidenceScore/);
    expect(() => createOpportunity({ ...appleSwing, requiredCapitalChf: chf(0) })).toThrow(OpportunityError);
  });

  it('blockiert Opportunities ohne verbundene Daten', () => {
    const o = createOpportunity({ ...appleSwing, estimates: { ...appleSwing.estimates, dataStatus: 'not_connected' } });
    expect(o.eligibility.eligible).toBe(false);
    expect(o.eligibility.reasons[0]).toMatch(/^DATA NOT CONNECTED/);
  });

  it('skaliert Schätzungen konservativ', () => {
    const o = createOpportunity(appleSwing);
    const e = estimateForAmount(o, chf('33.33'));
    expect(fmt(e.expectedNetProfitChf)).toBe('2.66'); // 2.6664 → down
    expect(fmt(e.downsideChf)).toBe('1.67'); // 1.6665 → up
  });

  describe('Lebenszyklus', () => {
    it('erlaubt nur gültige Übergänge und protokolliert sie', () => {
      let o = createOpportunity(appleSwing);
      expect(o.status).toBe('discovered');
      expect(() => transitionOpportunity(o, 'funded', { at: T0, by: human, reason: 'skip' })).toThrow(/not allowed/);
      o = transitionOpportunity(o, 'research', { at: T0, by: system, reason: 'scanner hit' });
      o = transitionOpportunity(o, 'approved', { at: T0, by: human, reason: 'reviewed' });
      expect(o.status).toBe('approved');
      expect(o.history.map((h) => h.to)).toEqual(['research', 'approved']);
    });

    it('nur ein Mensch darf freigeben, und nur finanzierbare Opportunities', () => {
      const researched = transitionOpportunity(createOpportunity(appleSwing), 'research', { at: T0, by: system, reason: 'scan' });
      expect(() => transitionOpportunity(researched, 'approved', { at: T0, by: system, reason: 'auto' })).toThrow(/only a human/);

      const btc = transitionOpportunity(createOpportunity(btcTrade), 'research', { at: T0, by: system, reason: 'scan' });
      expect(() => transitionOpportunity(btc, 'approved', { at: T0, by: human, reason: 'yolo' })).toThrow(/ineligible/);
    });
  });
});
