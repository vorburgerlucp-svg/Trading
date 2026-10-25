// R2 plan simulator: synthetic markets whose result is computed independently by hand (quantity 10 = 1000 / 100; risk 50).
import { describe, expect, it } from 'vitest';
import { simulateTradePlan } from '../../../src/evaluation/v2/plan-simulator.js';
import { AFTER, CAL, XNAS, bar, bars, plan, shortPlan } from './fixtures.js';

const sim = (p: Parameters<typeof simulateTradePlan>[0], b: Parameters<typeof simulateTradePlan>[1], at = AFTER, cal = CAL) => simulateTradePlan(p, b, cal, at);

describe('R2 simulator: long and short, known results', () => {
  it('long reaches the target: +100 net, +2R', () => {
    const r = sim(plan(), bars([['100', '101', '99', '100'], ['100', '111', '99', '109']]));
    expect(r).toMatchObject({ status: 'COMPLETED', quantity: '10', exit: { reason: 'target', fillPrice: '110' }, netPnl: '100', riskAmount: '50', netR: '2', barsHeld: 2 });
  });

  it('long hits the stop: -50 net, -1R', () => {
    const r = sim(plan(), bars([['100', '101', '99', '100'], ['99', '99', '94', '96']]));
    expect(r).toMatchObject({ exit: { reason: 'stop', fillPrice: '95' }, netPnl: '-50', netR: '-1' });
  });

  it('long: the stop first, then the price recovers far above the target: still -1R (no hindsight exit)', () => {
    const r = sim(plan(), bars([['100', '101', '99', '100'], ['99', '99', '94', '96'], ['96', '130', '96', '128']]));
    expect(r).toMatchObject({ exit: { reason: 'stop', barStart: '2026-10-07T10:15:00.000Z' }, netR: '-1', barsHeld: 2 });
  });

  it('short reaches the target: +100 net, +2R', () => {
    const r = sim(shortPlan(), bars([['100', '101', '99', '100'], ['100', '101', '89', '91']]));
    expect(r).toMatchObject({ exit: { reason: 'target', fillPrice: '90' }, netPnl: '100', netR: '2' });
  });

  it('short hits the stop: -50 net, -1R', () => {
    const r = sim(shortPlan(), bars([['100', '101', '99', '100'], ['101', '106', '100', '104']]));
    expect(r).toMatchObject({ exit: { reason: 'stop', fillPrice: '105' }, netPnl: '-50', netR: '-1' });
  });

  it('short: the stop first, then the price falls far below the target: still -1R', () => {
    const r = sim(shortPlan(), bars([['100', '101', '99', '100'], ['101', '106', '100', '104'], ['104', '104', '70', '72']]));
    expect(r).toMatchObject({ exit: { reason: 'stop' }, netR: '-1', barsHeld: 2 });
  });

  it('time exit at the close of the last bar of the holding window', () => {
    const r = sim(plan({ maxHoldingBars: 3 }), bars([['100', '101', '99', '100'], ['100', '102', '98', '101'], ['101', '103', '99', '102'], ['102', '130', '102', '129']]));
    expect(r).toMatchObject({ exit: { reason: 'time', referencePrice: '102', barStart: '2026-10-07T10:30:00.000Z' }, netPnl: '20', netR: '0.4', barsHeld: 3 });
  });

  it('the stop can trigger in the entry bar itself', () => {
    const r = sim(plan(), bars([['100', '100.5', '94', '95']]));
    expect(r).toMatchObject({ exit: { reason: 'stop', barStart: '2026-10-07T10:00:00.000Z' }, netR: '-1', barsHeld: 1 });
  });
});

describe('R2 simulator: gaps and ambiguous bars', () => {
  it('a long gaps through the stop: filled at the open (90), worse than the stop: -2R', () => {
    const r = sim(plan(), bars([['100', '101', '99', '100'], ['90', '92', '88', '91']]));
    expect(r).toMatchObject({ exit: { reason: 'stop_gap', fillPrice: '90' }, netPnl: '-100', netR: '-2' });
  });

  it('a short gaps through the stop: filled at the open (112): -2.4R', () => {
    const r = sim(shortPlan(), bars([['100', '101', '99', '100'], ['112', '113', '110', '111']]));
    expect(r).toMatchObject({ exit: { reason: 'stop_gap', fillPrice: '112' }, netPnl: '-120', netR: '-2.4' });
  });

  it('a favourable gap beyond the target fills AT the target (conservative, never better)', () => {
    const r = sim(plan(), bars([['100', '101', '99', '100'], ['115', '116', '114', '115']]));
    expect(r).toMatchObject({ exit: { reason: 'target_gap', fillPrice: '110' }, netR: '2' });
  });

  it('stop and target in one bar: the conservative policy takes the stop and flags the assumption', () => {
    const r = sim(plan(), bars([['100', '101', '99', '100'], ['100', '111', '94', '100']]));
    expect(r).toMatchObject({ status: 'COMPLETED', exit: { reason: 'stop' }, netR: '-1', ambiguousBars: 1, assumptionUsed: true, reasons: ['CONSERVATIVE_STOP_FIRST'] });
  });

  it('stop and target in one bar with the indeterminate policy: no result', () => {
    const r = sim(plan({ intrabarPolicy: 'indeterminate' }), bars([['100', '101', '99', '100'], ['100', '111', '94', '100']]));
    expect(r).toMatchObject({ status: 'INDETERMINATE', netR: null, exit: null, ambiguousBars: 1 });
  });

  it('a missing bar inside the holding window is a data gap: no invented fill', () => {
    const b = bars([['100', '101', '99', '100'], ['100', '101', '99', '100'], ['100', '101', '99', '100']]);
    const r = sim(plan(), [b[0]!, b[2]!]);
    expect(r).toMatchObject({ status: 'INSUFFICIENT_DATA', reasons: ['DATA_GAP 2026-10-07T10:15:00.000Z'], netR: null });
  });

  it('a bar that is not complete yet makes the result pending', () => {
    const r = sim(plan(), bars([['100', '101', '99', '100']]), '2026-10-07T10:20:00.000Z');
    expect(r).toMatchObject({ status: 'PENDING', netR: null });
  });

  it('an in-progress bar is never used', () => {
    const r = sim(plan(), [bar(0, '100', '101', '99', '100'), bar(1, '100', '111', '99', '109', undefined, { isFinal: false })]);
    expect(r.status).toBe('INSUFFICIENT_DATA');
  });

  it('a bar of another series is refused', () => {
    const r = sim(plan(), [bar(0, '100', '101', '99', '100', undefined, { source: 'other:source' })]);
    expect(r).toMatchObject({ status: 'INSUFFICIENT_DATA', reasons: ['BAR_OF_ANOTHER_SERIES'] });
  });

  it('exchange calendar: the night between two sessions is no data gap', () => {
    // XNAS: last regular 15-minute bar of 2026-10-07 starts 19:45Z, the next session opens 13:30Z on 2026-10-08.
    const p = plan({ entry: { method: 'next_bar_open', earliestEntryAt: '2026-10-07T19:45:00.000Z' }, maxHoldingBars: 2, dataBasis: { asOf: '2026-10-07T19:30:00.000Z', storedThrough: 1, inputFingerprint: 'a'.repeat(64) } });
    const evening = bar(0, '100', '101', '99', '100', '2026-10-07T19:45:00.000Z');
    const morning = bar(0, '100', '103', '99', '102', '2026-10-08T13:30:00.000Z');
    const r = simulateTradePlan(p, [evening, morning], XNAS, '2026-10-09T00:00:00.000Z');
    expect(r).toMatchObject({ status: 'COMPLETED', exit: { reason: 'time', barStart: '2026-10-08T13:30:00.000Z' }, netR: '0.4' });
  });
});

describe('R2 simulator: costs', () => {
  it('commission turns a gross gain into a net loss (entry 100, exit 100.6, 30 bp per side)', () => {
    const p = plan({ maxHoldingBars: 1, costs: { version: 'c1', commissionBps: 30, fixedFeePerSide: '0', feeCurrency: 'USD', spreadBps: 0, spreadSource: 'modeled', slippageBps: 0 } });
    const r = sim(p, bars([['100', '100.7', '99.9', '100.6']]));
    // gross 10 × 0.6 = 6; fees 10 × 100 × 0.003 + 10 × 100.6 × 0.003 = 3 + 3.018 = 6.018; net -0.018.
    expect(r).toMatchObject({ grossPnl: '6', fees: '6.018', netPnl: '-0.018' });
  });

  it('spread and slippage are paid on both fills, against the trade, for long and short', () => {
    const costs = { version: 'c2', commissionBps: 0, fixedFeePerSide: '0', feeCurrency: 'USD', spreadBps: 20, spreadSource: 'modeled' as const, slippageBps: 5 };
    // adverse = 10 + 5 bp = 0.0015. Long: buy 100.15, target 110 sells at 109.835.
    const long = sim(plan({ costs, size: { kind: 'quantity', quantity: '10' } }), bars([['100', '101', '99', '100'], ['100', '111', '99', '109']]));
    expect(long).toMatchObject({ entry: { fillPrice: '100.15' }, exit: { fillPrice: '109.835' }, grossPnl: '96.85', executionCosts: '3.15' });
    // Short: sell 99.85, target 90 buys back at 90.135.
    const short = sim(shortPlan({ costs, size: { kind: 'quantity', quantity: '10' } }), bars([['100', '101', '99', '100'], ['100', '101', '89', '91']]));
    expect(short).toMatchObject({ entry: { fillPrice: '99.85' }, exit: { fillPrice: '90.135' }, grossPnl: '97.15' });
  });

  it('a fixed fee per side is charged twice', () => {
    const p = plan({ maxHoldingBars: 1, costs: { version: 'c3', commissionBps: 0, fixedFeePerSide: '1.5', feeCurrency: 'USD', spreadBps: 0, spreadSource: 'modeled', slippageBps: 0 } });
    expect(sim(p, bars([['100', '101', '99', '100']]))).toMatchObject({ grossPnl: '0', fees: '3', netPnl: '-3' });
  });
});

describe('R2 simulator: data that arrives late', () => {
  it('a bar NEXUS received only after the evaluation time is not used (the evaluation stays reproducible at its time)', () => {
    const late = bar(1, '100', '111', '99', '109', undefined, { knowledge: { knownAt: '2026-10-09T00:00:00.000Z', knowledgeSource: 'captured_by_nexus', vintage: 'historical_reconstruction', vintagePolicy: 'bar-vintage:v1' } });
    const r = sim(plan(), [bar(0, '100', '101', '99', '100'), late], '2026-10-07T11:00:00.000Z');
    expect(r).toMatchObject({ status: 'PENDING', reasons: ['BAR_NOT_YET_RECEIVED 2026-10-07T10:15:00.000Z'] });
    // At a later evaluation time the same bar is known and used.
    expect(sim(plan(), [bar(0, '100', '101', '99', '100'), late], '2026-10-10T00:00:00.000Z')).toMatchObject({ status: 'COMPLETED', netR: '2' });
  });

  it('a missing bar is PENDING during the data grace period and INSUFFICIENT_DATA after it', () => {
    const only = [bar(0, '100', '101', '99', '100')];
    expect(sim(plan(), only, '2026-10-07T12:00:00.000Z').status).toBe('PENDING');
    expect(simulateTradePlan(plan(), only, CAL, '2026-10-07T12:00:00.000Z', { dataGraceMs: 60_000 }).status).toBe('INSUFFICIENT_DATA');
    expect(sim(plan(), only, AFTER).status).toBe('INSUFFICIENT_DATA');
  });
});
