import { describe, expect, it } from 'vitest';
import { DeterministicCostModel } from '../../src/backtest/cost-model.js';
import { isEligibleNextBar, protectiveExitForLong } from '../../src/backtest/execution-model.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { Decimal } from '../../src/money/decimal.js';

function bar(values: { start?: string; open: string; high: string; low: string; close: string }): MarketBar {
  const startTime = values.start ?? '2026-10-08T13:30:00.000Z';
  return {
    instrumentId: 'AAPL',
    interval: '5m',
    startTime,
    endTime: new Date(Date.parse(startTime) + 300_000).toISOString(),
    open: Decimal.from(values.open),
    high: Decimal.from(values.high),
    low: Decimal.from(values.low),
    close: Decimal.from(values.close),
    volume: Decimal.from(1000),
    source: 'fixture',
    session: 'regular',
    adjustment: 'raw',
    isFinal: true,
    observedAt: new Date(Date.parse(startTime) + 300_000).toISOString(),
    availableAt: new Date(Date.parse(startTime) + 300_000).toISOString(),
    retrievedAt: new Date(Date.parse(startTime) + 300_000).toISOString(),
  };
}

describe('conservative OHLC execution rules', () => {
  it('fills a gap through a stop at the open, never magically at the stop', () => {
    const exit = protectiveExitForLong(bar({ open: '88', high: '92', low: '85', close: '90' }), Decimal.from(95), Decimal.from(110), 'conservative');
    expect(exit?.kind).toBe('stop');
    expect(exit?.rawFillPrice?.toString()).toBe('88');
  });

  it('chooses the adverse stop when stop and TP are both touched and order is unknown', () => {
    const exit = protectiveExitForLong(bar({ open: '100', high: '112', low: '93', close: '105' }), Decimal.from(95), Decimal.from(110), 'conservative');
    expect(exit).toMatchObject({ kind: 'stop' });
    expect(exit?.rawFillPrice?.toString()).toBe('95');
  });

  it('can mark same-bar stop/TP ordering ambiguous instead of inventing a profitable path', () => {
    const exit = protectiveExitForLong(bar({ open: '100', high: '112', low: '93', close: '105' }), Decimal.from(95), Decimal.from(110), 'mark_ambiguous');
    expect(exit).toMatchObject({ kind: 'ambiguous', rawFillPrice: null });
  });

  it('does not retroactively fill a next bar whose open happened before the delayed decision became available', () => {
    const decision = bar({ start: '2026-10-08T13:30:00.000Z', open: '100', high: '102', low: '99', close: '101' });
    const delayedDecision = { ...decision, availableAt: '2026-10-08T13:41:00.000Z' };
    const alreadyOpened = bar({ start: '2026-10-08T13:35:00.000Z', open: '102', high: '103', low: '101', close: '102' });
    const firstExecutable = bar({ start: '2026-10-08T13:45:00.000Z', open: '104', high: '105', low: '103', close: '104' });
    expect(isEligibleNextBar(delayedDecision, alreadyOpened)).toBe(false);
    expect(isEligibleNextBar(delayedDecision, firstExecutable)).toBe(true);
  });

  it('never lets a decision use the same bar as its next-bar fill', () => {
    const decision = bar({ start: '2026-10-08T13:30:00.000Z', open: '100', high: '102', low: '99', close: '101' });
    const same = { ...decision };
    const next = bar({ start: '2026-10-08T13:35:00.000Z', open: '102', high: '103', low: '101', close: '102' });
    expect(isEligibleNextBar(decision, same)).toBe(false);
    expect(isEligibleNextBar(decision, next)).toBe(true);
  });
});

describe('deterministic cost model', () => {
  it('moves buys up and sells down for spread/slippage and charges commission', () => {
    const model = new DeterministicCostModel({ commissionBps: 10, spreadBps: 20, slippageBps: 5, minCommission: '1' });
    const buy = model.quote(Decimal.from(100), 'buy', Decimal.from(10));
    const sell = model.quote(Decimal.from(100), 'sell', Decimal.from(10));
    expect(buy.executionPrice.gt(100)).toBe(true);
    expect(sell.executionPrice.lt(100)).toBe(true);
    expect(buy.commission.gte(1)).toBe(true);
  });
});
