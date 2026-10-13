import { describe, expect, it } from 'vitest';
import { accounts } from '../src/capital/accounts.js';
import { proposeAllocation, type AllocationPolicy } from '../src/capital/capital-allocator.js';
import type { InstrumentInfo } from '../src/capital/capital-types.js';
import { chf } from '../src/money/money.js';
import { createOpportunity, transitionOpportunity } from '../src/opportunities/opportunity-engine.js';
import type { OpportunityInput } from '../src/opportunities/opportunity-types.js';
import { assessAllocationProposal } from '../src/risk-engine.js';
import { appleSwing, batteryTrade, btcTrade, chewingGumResale } from './fixtures/opportunities.js';
import { fmt, newEngine, policy, T0 } from './helpers.js';

const bank = accounts.bank('ubs');

const allocationPolicy: AllocationPolicy = {
  maxDeploymentBpOfAvailable: 9000,
  maxPerOpportunityChf: chf(150),
  maxPerOpportunityBpOfNetWorth: 3000,
  maxBucketExposureBpOfNetWorth: { equities: 5000, physical_trade: 3000, crypto: 2000 },
  maxNewDownsideBpOfNetWorth: 1000,
  minOpportunityScore: 0,
  minConfidenceScore: 0.5,
  maxRiskScore: 0.7,
  humanApproval: { thresholdChf: chf(100), thresholdBpOfNetWorth: 2000 },
};

async function setup(depositChf = '500') {
  const ctx = await newEngine(policy({ safetyReserve: { minimumChf: chf(100), percentOfNetWorthBp: 0 } }));
  await ctx.engine.deposit({ to: bank, amountChf: chf(depositChf) });
  return ctx;
}

const all = (inputs: OpportunityInput[] = [appleSwing, btcTrade, chewingGumResale, batteryTrade]) => inputs.map((o) => createOpportunity(o));

describe('CapitalAllocator', () => {
  it('verteilt verfügbares Kapital unter Kapazität, Limits und Risiko – als Vorschlag', async () => {
    const { engine } = await setup();
    const proposal = proposeAllocation({ id: 'p1', at: T0, snapshot: engine.snapshot(), opportunities: all(), policy: allocationPolicy });

    expect(proposal.status).toBe('proposed');
    expect(fmt(proposal.basis.availableCapitalChf)).toBe('400.00');
    expect(fmt(proposal.budgetChf)).toBe('360.00');
    expect(proposal.allocations.map((a) => [a.opportunityId, fmt(a.amountChf)])).toEqual([
      ['kaugummi-resale', '20.00'], // fully funded, limited by its own capacity
      ['apple-swing', '150.00'], // limited by the per-opportunity cap
    ]);
    expect(fmt(proposal.allocatedChf)).toBe('170.00');
    expect(fmt(proposal.cashKeptChf)).toBe('230.00');
    expect(proposal.allocations[1]?.rationale).toContain('Sized by per-opportunity cap');

    const skipped = Object.fromEntries(proposal.skipped.map((s) => [s.opportunityId, s.reasons.join(' | ')]));
    // Tightest limit wins: downside room 32.50 CHF allows only 81.25 CHF of a 200 CHF / 80 CHF-downside lot.
    expect(skipped['batterie-handel']).toMatch(/fixed ticket of 20000 Rappen exceeds downside budget/);
    expect(skipped['btc-trade']).toMatch(/risk-adjusted profit is not positive/);
    expect(skipped['btc-trade']).toMatch(/risk score 0.8 above maximum 0.7/);
  });

  it('markiert grosse Allokationen für menschliche Freigabe', async () => {
    const { engine } = await setup();
    const proposal = proposeAllocation({ id: 'p1', at: T0, snapshot: engine.snapshot(), opportunities: all(), policy: allocationPolicy });
    expect(proposal.allocations.find((a) => a.opportunityId === 'kaugummi-resale')?.requiresHumanApproval).toBe(false);
    expect(proposal.allocations.find((a) => a.opportunityId === 'apple-swing')?.requiresHumanApproval).toBe(true);
    expect(proposal.requiresHumanApproval).toBe(true);
  });

  it('hält das Downside-Budget für neue Allokationen ein', async () => {
    const { engine } = await setup();
    const tight = { ...allocationPolicy, maxNewDownsideBpOfNetWorth: 100 }; // 5 CHF total downside
    const proposal = proposeAllocation({ id: 'p1', at: T0, snapshot: engine.snapshot(), opportunities: all(), policy: tight });
    expect(proposal.allocations.map((a) => [a.opportunityId, fmt(a.amountChf), fmt(a.downsideChf)])).toEqual([['apple-swing', '100.00', '5.00']]);
    expect(proposal.skipped.find((s) => s.opportunityId === 'kaugummi-resale')?.reasons[0]).toMatch(/below minimum ticket after applying downside budget/);
  });

  it('berücksichtigt bestehende Positionen im Konzentrationslimit', async () => {
    const { engine } = await setup('700');
    await engine.transfer({ from: bank, to: accounts.brokerCash('ibkr'), amountChf: chf(300) });
    await engine.recordTradeBuy({ brokerId: 'ibkr', instrumentId: 'MSFT', quantity: 1, grossAmountChf: chf(300) });
    const msft: InstrumentInfo = { instrumentId: 'MSFT', symbol: 'MSFT', assetClass: 'stock', currency: 'USD', settlementDays: 1 };
    const proposal = proposeAllocation({
      id: 'p1',
      at: T0,
      snapshot: engine.snapshot({ instruments: [msft] }),
      opportunities: all([appleSwing]),
      policy: allocationPolicy,
    });
    // equities limit 50 % of 700 = 350, minus 300 already held (at cost, no quote) = 50
    expect(fmt(proposal.exposureBeforeChf.equities)).toBe('300.00');
    expect(proposal.allocations.map((a) => fmt(a.amountChf))).toEqual(['50.00']);
    expect(proposal.warnings.join(' ')).toMatch(/Financial market data not_connected/);
  });

  it('finanziert nichts ohne verbundene Daten, in falschem Status, in gesperrtem Bucket oder doppelt', async () => {
    const { engine } = await setup();
    const noData = createOpportunity({ ...appleSwing, id: 'no-data', estimates: { ...appleSwing.estimates, dataStatus: 'not_connected' } });
    const active = transitionOpportunity(
      transitionOpportunity(
        transitionOpportunity(createOpportunity({ ...appleSwing, id: 'running' }), 'research', { at: T0, by: { kind: 'system', id: 's' }, reason: 'r' }),
        'approved',
        { at: T0, by: { kind: 'human', id: 'luc' }, reason: 'ok' },
      ),
      'funded',
      { at: T0, by: { kind: 'system', id: 's' }, reason: 'paid' },
    );
    const forex = createOpportunity({ ...appleSwing, id: 'eurchf', type: 'forex' });
    const apple = createOpportunity(appleSwing);
    const proposal = proposeAllocation({
      id: 'p1',
      at: T0,
      snapshot: engine.snapshot(),
      opportunities: [noData, active, forex, apple, apple],
      policy: allocationPolicy,
    });
    const skipped = Object.fromEntries(proposal.skipped.map((s) => [s.opportunityId, s.reasons.join(' | ')]));
    expect(skipped['no-data']).toMatch(/DATA NOT CONNECTED/);
    expect(skipped['running']).toMatch(/status "funded" is not fundable/);
    expect(skipped['eurchf']).toMatch(/bucket "forex" is not enabled/);
    expect(proposal.skipped.filter((s) => s.opportunityId === 'apple-swing').map((s) => s.reasons[0])).toEqual(['duplicate opportunity id']);
    expect(proposal.allocations.map((a) => a.opportunityId)).toEqual(['apple-swing']);
  });

  it('verteilt nichts bei Reserve-Unterdeckung', async () => {
    const { engine } = await setup('80');
    const proposal = proposeAllocation({ id: 'p1', at: T0, snapshot: engine.snapshot(), opportunities: all(), policy: allocationPolicy });
    expect(proposal.allocations).toEqual([]);
    expect(proposal.warnings[0]).toMatch(/Safety reserve shortfall/);
  });

  it('ist deterministisch', async () => {
    const { engine } = await setup();
    const snapshot = engine.snapshot();
    const a = proposeAllocation({ id: 'p1', at: T0, snapshot, opportunities: all(), policy: allocationPolicy });
    const b = proposeAllocation({ id: 'p1', at: T0, snapshot, opportunities: all().reverse(), policy: allocationPolicy });
    expect(b).toEqual(a);
  });
});

describe('Capital Risk Gate', () => {
  it('prüft Vorschläge unabhängig gegen den aktuellen Zustand', async () => {
    const { engine } = await setup();
    const proposal = proposeAllocation({ id: 'p1', at: T0, snapshot: engine.snapshot(), opportunities: all(), policy: allocationPolicy });
    expect(assessAllocationProposal(proposal, engine.capitalState())).toEqual({ passed: true, requiresHumanApproval: true, reasons: [] });

    await engine.recordExpense({ category: 'fee', feeKind: 'bank', amountChf: chf(300), paidFrom: bank });
    const stale = assessAllocationProposal(proposal, engine.capitalState());
    expect(stale.passed).toBe(false);
    expect(stale.reasons).toContain('capital state changed since the proposal was made; re-run the allocator');
    expect(stale.reasons).toContain('allocations exceed available capital');
  });

  it('erkennt manipulierte Vorschläge', async () => {
    const { engine } = await setup();
    const proposal = proposeAllocation({ id: 'p1', at: T0, snapshot: engine.snapshot(), opportunities: all(), policy: allocationPolicy });
    const tampered = { ...proposal, allocations: [...proposal.allocations, { ...proposal.allocations[0]!, amountChf: chf(5000) }] };
    const decision = assessAllocationProposal(tampered, engine.capitalState());
    expect(decision.passed).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining(['duplicate allocation for kaugummi-resale', 'allocation total does not match allocatedChf', 'allocations exceed available capital']),
    );
  });
});
