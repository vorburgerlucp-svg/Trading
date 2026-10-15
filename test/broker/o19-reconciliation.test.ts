// reconcileBrokerSnapshot, the pure comparison: differences are reported, never matched by guess, never corrected.
import { describe, expect, it } from 'vitest';
import type { PositionView } from '../../src/capital/capital-types.js';
import { Decimal } from '../../src/money/decimal.js';
import { currency } from '../../src/money/currency.js';
import { reconcileBrokerSnapshot, type BrokerSnapshot } from '../../src/broker/broker-sync.js';

const T0 = '2026-10-15T09:00:00.000Z';

function snapshot(overrides: Partial<BrokerSnapshot> = {}): BrokerSnapshot {
  return { broker: 'ibkr', accountId: 'U1234567', access: 'read_only', observedAt: T0, retrievedAt: T0, cash: [], positions: [], openOrders: [], ...overrides };
}

function held(instrumentId: string, quantity: number): PositionView {
  return { brokerId: 'ibkr', instrumentId, isOpen: true, quantity: Decimal.from(quantity) } as unknown as PositionView;
}

const usd = currency('USD');
const emptyLedger = { portfolio: { positions: [] as PositionView[] }, balances: new Map() };

describe('O19 reconciliation: differences are reported, never guessed or corrected', () => {
  it('equal positions and no differing cash are a match', () => {
    const report = reconcileBrokerSnapshot(
      snapshot({ positions: [{ instrumentId: 'ins_aapl', brokerSymbol: 'AAPL', quantity: Decimal.from(2), currency: usd, averageCost: null, marketValue: null, unrealizedPnl: null, realizedPnl: null }] }),
      { portfolio: { positions: [held('ins_aapl', 2)] }, balances: new Map() },
    );
    expect(report).toMatchObject({ matched: true, issues: [] });
  });

  it('[10] a position without a NEXUS mapping is an explicit issue and is never matched to a ledger position', () => {
    const report = reconcileBrokerSnapshot(
      snapshot({ positions: [{ instrumentId: null, brokerInstrumentId: '756733', brokerSymbol: 'SPY', quantity: Decimal.from(2), currency: usd, averageCost: null, marketValue: null, unrealizedPnl: null, realizedPnl: null }] }),
      { portfolio: { positions: [held('ins_aapl', 2)] }, balances: new Map() },
    );
    expect(report.matched).toBe(false);
    expect(report.issues).toContainEqual({ kind: 'unmapped_broker_instrument', brokerInstrumentId: '756733', detail: 'position has no NEXUS instrument mapping' });
    expect(report.issues).toContainEqual({ kind: 'missing_at_broker', instrumentId: 'ins_aapl', ledger: '2' });
  });

  it('two broker contracts that map to the same NEXUS instrument are both flagged: no silent double count', () => {
    const line = (conid: string) => ({ instrumentId: 'ins_aapl', brokerInstrumentId: conid, brokerSymbol: 'AAPL', quantity: Decimal.from(1), currency: usd, averageCost: null, marketValue: null, unrealizedPnl: null, realizedPnl: null });
    const report = reconcileBrokerSnapshot(snapshot({ positions: [line('1'), line('2')] }), { portfolio: { positions: [held('ins_aapl', 2)] }, balances: new Map() });
    expect(report.issues).toContainEqual({ kind: 'unmapped_broker_instrument', brokerInstrumentId: '2', detail: 'two broker contracts map to the same NEXUS instrument' });
    expect(report.matched).toBe(false);
  });

  it('open orders that were not read are unknown, and that is reported as a difference, not as "no orders"', () => {
    const report = reconcileBrokerSnapshot(snapshot({ openOrders: null }), emptyLedger);
    expect(report.matched).toBe(false);
    expect(report.issues).toEqual([{ kind: 'open_orders_unknown' }]);
  });

  it('an open order without a NEXUS instrument is an explicit issue', () => {
    const report = reconcileBrokerSnapshot(
      snapshot({ openOrders: [{ externalOrderId: '77', instrumentId: null, brokerInstrumentId: '999', side: 'buy', quantity: Decimal.from(1), limitPrice: null, status: 'Submitted' }] }),
      emptyLedger,
    );
    expect(report.issues).toEqual([{ kind: 'unmapped_broker_instrument', brokerInstrumentId: '999', detail: 'open order has no NEXUS instrument mapping' }]);
  });

  it('a non-CHF cash line is unsupported, and no conversion is attempted', () => {
    const report = reconcileBrokerSnapshot(snapshot({ cash: [{ currency: usd, minor: 100000n }] }), emptyLedger);
    expect(report.issues).toEqual([{ kind: 'unsupported_currency', detail: 'USD 1000.00 cannot be reconciled: ledger is CHF-only' }]);
  });

  it('a quantity that differs is reported with both values, and the report does not change the ledger input', () => {
    const balances = new Map();
    const ledger = { portfolio: { positions: [held('ins_aapl', 1)] }, balances };
    const report = reconcileBrokerSnapshot(
      snapshot({ positions: [{ instrumentId: 'ins_aapl', brokerSymbol: 'AAPL', quantity: Decimal.from(3), currency: usd, averageCost: null, marketValue: null, unrealizedPnl: null, realizedPnl: null }], openOrders: [] }),
      ledger,
    );
    expect(report.issues).toEqual([{ kind: 'quantity_mismatch', instrumentId: 'ins_aapl', broker: '3', ledger: '1' }]);
    expect(balances.size).toBe(0);
  });
});
