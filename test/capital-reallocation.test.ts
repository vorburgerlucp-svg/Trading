import { describe, expect, it } from 'vitest';
import { accounts } from '../src/capital/accounts.js';
import { proposeReallocations, type ExitCostModel, type HoldingForecast, type ReallocationPolicy } from '../src/capital/capital-reallocation.js';
import type { InstrumentInfo, MarketDataSnapshot } from '../src/capital/capital-types.js';
import { Decimal } from '../src/money/decimal.js';
import { chf } from '../src/money/money.js';
import { createOpportunity } from '../src/opportunities/opportunity-engine.js';
import type { OpportunityInput } from '../src/opportunities/opportunity-types.js';
import { assessReallocationProposal } from '../src/risk-engine.js';
import { fmt, newEngine, sequentialIds, T0 } from './helpers.js';

const ACME: InstrumentInfo = { instrumentId: 'ACME', symbol: 'ACME', assetClass: 'stock', currency: 'CHF', settlementDays: 2 };

const product: OpportunityInput = {
  id: 'opp-akku',
  type: 'physical_product',
  name: 'Akku-Handel',
  requiredCapitalChf: chf(100),
  sizing: { kind: 'scalable', minTicketChf: chf(10), maxCapitalChf: chf(100), lotSizeChf: chf(10) },
  expectedNetProfitChf: chf(25),
  downsideChf: chf(30),
  expectedHoldingDays: 14,
  liquidityScore: 0.4,
  confidenceScore: 0.8,
  riskScore: 0.45,
  effortScore: 0.3,
  regulatoryRiskScore: 0.05,
  thesis: ['25 % in 14 Tagen'],
  risks: ['Absatz'],
  exitPlan: 'Abverkauf, Rest zum Restwert',
  estimates: { source: 'manual', dataStatus: 'connected', asOf: T0, calibrated: false },
};

const forecast: HoldingForecast = {
  brokerId: 'ibkr',
  instrumentId: 'ACME',
  expectedReturnBp: 300,
  horizonDays: 30,
  riskScore: 0.3,
  source: 'quant',
  dataStatus: 'connected',
  asOf: T0,
};

const reallocationPolicy: ReallocationPolicy = {
  maxReductionBpOfPosition: 3000,
  maxReallocationBpOfNetWorth: 5000,
  minNetAdvantageChf: chf(1),
  minNetAdvantageBpOfAmount: 300,
  minOpportunityConfidence: 0.6,
  minOpportunityScore: 0,
  maxAdditionalRiskScore: 0.3,
  assumedSettlementDaysIfUnknown: 2,
};

const noCosts: ExitCostModel = { commissionChf: chf(0), spreadBp: 0, taxOnGainBp: 0 };

/** 10 ACME bought for `costChf`, quoted at `priceChf` (test fixture quote). */
async function holding(options: { costChf?: string; priceChf?: string | null } = {}) {
  const { engine } = await newEngine();
  await engine.deposit({ to: accounts.brokerCash('ibkr'), amountChf: chf(options.costChf ?? '100') });
  await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'ACME', quantity: 10, grossAmountChf: chf(options.costChf ?? '100') });
  const price = options.priceChf === undefined ? '10' : options.priceChf;
  const market: MarketDataSnapshot = {
    quotes: price === null ? [] : [{ instrumentId: 'ACME', price: Decimal.from(price), currency: 'CHF', asOf: T0, source: 'test-fixture' }],
  };
  return engine.snapshot({ market, instruments: [ACME] });
}

function run(snapshot: Awaited<ReturnType<typeof holding>>, overrides: Partial<Parameters<typeof proposeReallocations>[0]> = {}) {
  return proposeReallocations({
    at: T0,
    newId: sequentialIds('r'),
    snapshot,
    opportunities: [createOpportunity(product)],
    forecasts: [forecast],
    exitCosts: noCosts,
    policy: reallocationPolicy,
    ...overrides,
  });
}

describe('Capital Reallocation', () => {
  it('Spezifikationsbeispiel: Aktie A teilweise reduzieren (30 CHF) → Produkt kaufen (30 CHF)', async () => {
    const { proposals, rejected } = run(await holding());
    expect(rejected).toEqual([]);
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(fmt(p.from.reduceByChf)).toBe('30.00');
    expect(fmt(p.to.amountChf)).toBe('30.00');
    expect(p.from.settlementDays).toBe(2);
    expect(p.economics.horizonDays).toBe(16);
    expect(fmt(p.economics.netAdvantageChf)).toBe('3.72');
    expect(p.requiresHumanApproval).toBe(true);
    expect(p.status).toBe('proposed');
  });

  it('ist selbstfinanzierend: Verkauf deckt Investition plus Ausstiegskosten', async () => {
    const snapshot = await holding();
    const { proposals } = run(snapshot, { exitCosts: { commissionChf: chf(1), spreadBp: 10, taxOnGainBp: 0 } });
    const p = proposals[0]!;
    expect(fmt(p.to.amountChf)).toBe('20.00'); // 30 cap - 1.03 costs = 28.97 → 20 (lot 10)
    expect(fmt(p.from.reduceByChf)).toBe('21.03');
    expect(fmt(p.economics.exitCosts.totalChf)).toBe('1.03');
    expect(p.from.reduceByChf - p.economics.exitCosts.totalChf).toBeGreaterThanOrEqual(p.to.amountChf);
    expect(assessReallocationProposal(p, snapshot).passed).toBe(true);
  });

  it('liquidiert nie allein wegen höherer prognostizierter Rendite: niedrige Confidence blockiert', async () => {
    const { proposals, rejected } = run(await holding(), {
      opportunities: [createOpportunity({ ...product, confidenceScore: 0.55, expectedNetProfitChf: chf(60) })],
    });
    expect(proposals).toEqual([]);
    expect(rejected[0]?.reasons[0]).toMatch(/a higher predicted return alone is not enough/);
  });

  it('keine Umschichtung, wenn Kosten den Vorteil auffressen', async () => {
    const { proposals, rejected } = run(await holding(), { exitCosts: { commissionChf: chf(3), spreadBp: 50, taxOnGainBp: 0 } });
    expect(proposals).toEqual([]);
    expect(rejected[0]?.reasons[0]).toMatch(/net advantage .* below the required/);
  });

  it('keine Umschichtung ohne Prognose für die bestehende Position', async () => {
    const { proposals, rejected } = run(await holding(), { forecasts: [] });
    expect(proposals).toEqual([]);
    expect(rejected[0]?.reasons).toContain('no forward forecast for the holding; NEXUS does not assume a holding is worse');
  });

  it('keine Umschichtung ohne aktuellen Kurs (DATA NOT CONNECTED)', async () => {
    const { proposals, rejected } = run(await holding({ priceChf: null }));
    expect(proposals).toEqual([]);
    expect(rejected[0]?.reasons[0]).toMatch(/^DATA NOT CONNECTED/);
  });

  it('keine Umschichtung bei zu hohem Zusatzrisiko', async () => {
    const { proposals, rejected } = run(await holding(), { opportunities: [createOpportunity({ ...product, riskScore: 0.7 })] });
    expect(proposals).toEqual([]);
    expect(rejected[0]?.reasons[0]).toMatch(/additional risk 0.40 exceeds 0.3/);
  });

  it('weist auf realisierte Verluste und Steuern hin', async () => {
    const loss = run(await holding({ costChf: '120' }));
    expect(loss.proposals[0]?.warnings.join(' ')).toMatch(/Realizes a loss of -6.00 CHF/);

    // Cost 50, value 100: half of every franc sold is gain. Tax 20 % on gains.
    const taxed = { exitCosts: { commissionChf: chf(0), spreadBp: 0, taxOnGainBp: 2000 } };
    const snapshot = await holding({ costChf: '50' });
    expect(run(snapshot, taxed).proposals).toEqual([]); // tax eats the advantage of the 25 % product

    const better = run(snapshot, { ...taxed, opportunities: [createOpportunity({ ...product, expectedNetProfitChf: chf(40) })] });
    const p = better.proposals[0]!;
    expect(fmt(p.to.amountChf)).toBe('20.00'); // cap 30 - 3.00 tax = 27 → 20 (lot 10)
    expect(fmt(p.from.reduceByChf)).toBe('23.00');
    expect(fmt(p.economics.realizedPnlChf)).toBe('11.50');
    expect(fmt(p.economics.exitCosts.taxChf)).toBe('2.30');
  });

  it('Risk Gate lehnt manipulierte oder veraltete Vorschläge ab', async () => {
    const snapshot = await holding();
    const p = run(snapshot).proposals[0]!;
    expect(assessReallocationProposal({ ...p, to: { ...p.to, amountChf: chf(31) } }, snapshot).reasons).toContain(
      'target amount exceeds net proceeds after exit costs',
    );
    const unpriced = await holding({ priceChf: null });
    expect(assessReallocationProposal(p, unpriced).reasons[0]).toMatch(/^DATA NOT CONNECTED/);
  });
});
