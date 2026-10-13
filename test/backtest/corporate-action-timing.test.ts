import { describe, expect, it } from 'vitest';
import { CorporateActionLedger, CORPORATE_ACTION_ENGINE_VERSION, CORPORATE_ACTION_POLICY_VERSION } from '../../src/backtest/corporate-action-engine.js';
import { hashOf } from '../../src/persistence/canonical-json.js';
import { XNAS, HOLD, K0, SPLIT_4_1, SPLIT_ROWS, ca, intraday, run, series, strategy, withActions, type Row } from './o2-fixtures.js';

// O2 timing hardening. The knowledge boundary of an economic transformation is its effective instant (the regular session open of
// the ex-date), not the event that applies it. See docs/BACKTEST_CORPORATE_ACTIONS_O2.md.

const at = (iso: string) => ({ knowledge: { provenance: 'captured_by_nexus' as const, knowledgeAt: iso }, retrievedAt: iso, storedAvailableAt: iso });
const OPEN_OCT8 = '2026-10-08T13:30:00.000Z';
const DAILY_CLOSE_OCT8 = '2026-10-08T20:00:00.000Z';
const with_ = (k: string) => withActions([{ ...SPLIT_4_1, ...at(k) }]);

describe('O2 timing: daily knowledge boundary (economic transformation at effectiveAt)', () => {
  const holdOneDay = strategy({ enterAt: 1, exitAt: 100 });
  const rows = SPLIT_ROWS.slice(0, 4);

  it('A: knowledge before the ex-date open: applied', () => {
    const r = run(series(rows), holdOneDay, with_('2026-10-07T12:00:00.000Z'));
    expect(r.openPosition!.quantity.toString()).toBe('40');
  });

  it('B: knowledge exactly at the ex-date open: applied', () => {
    const r = run(series(rows), holdOneDay, with_(OPEN_OCT8));
    expect(r.openPosition!.quantity.toString()).toBe('40');
  });

  it('C: knowledge 1 ms after the ex-date open: fails closed', () => {
    expect(() => run(series(rows), holdOneDay, with_('2026-10-08T13:30:00.001Z'))).toThrow(/CORPORATE_ACTION_TIMING_UNPROVEN/);
  });

  it('D: knowledge during the ex-date session: fails closed for the economic open transformation', () => {
    expect(() => run(series(rows), holdOneDay, with_('2026-10-08T16:00:00.000Z'))).toThrow(/CORPORATE_ACTION_TIMING_UNPROVEN/);
  });

  it('E: knowledge at the daily close (the bar event): fails closed', () => {
    expect(() => run(series(rows), holdOneDay, with_(DAILY_CLOSE_OCT8))).toThrow(/CORPORATE_ACTION_TIMING_UNPROVEN/);
  });

  it('F: knowledge the next day: fails closed', () => {
    expect(() => run(series(SPLIT_ROWS.slice(0, 5)), holdOneDay, with_('2026-10-09T20:00:00.000Z'))).toThrow(/CORPORATE_ACTION_TIMING_UNPROVEN/);
  });
});

describe('O2 timing: pending order is never repaired retroactively (§1, §6)', () => {
  const rows = SPLIT_ROWS.slice(0, 4);
  // Decided on 10-07 (history of 3 bars), so the fill is the ex-date open of 10-08, with attached levels 80 / 120 before the split.
  const pendingEntry = strategy({ enterAt: 3, exitAt: 100, stop: '80', target: '120' });

  it('known after the open but before the daily close: the run fails closed; the pending fill is not transformed in hindsight', () => {
    expect(() => run(series(rows), pendingEntry, with_('2026-10-08T16:00:00.000Z'))).toThrow(/CORPORATE_ACTION_TIMING_UNPROVEN/);
  });

  it('known before the open: the attached levels are transformed (80/120 → 20/30) and the fill uses the transformed economics', () => {
    const r = run(series(rows), pendingEntry, with_('2026-10-07T12:00:00.000Z'));
    const buy = r.fills.find((f) => f.side === 'buy')!;
    expect(buy.at.startsWith('2026-10-08')).toBe(true);
    expect(buy.executionPrice.toString()).toBe('25');
    expect(r.openPosition!.quantity.toString()).toBe('40');
    expect(r.openPosition!.stopLoss!.toString()).toBe('20');
    expect(r.openPosition!.takeProfit!.toString()).toBe('30');
  });
});

describe('O2 timing: intraday ex-date (TradingCalendar session open, first bar starts exactly at it)', () => {
  // 5-minute bars: 10-07 13:30, 13:35, 13:40 at 100; then the ex-date 10-08 13:30 (raw open 25 after the 4-for-1 split).
  const bars = () => [
    ...intraday('2026-10-07T13:30:00Z', [['100', '100', '100', '100'], ['100', '100', '100', '100'], ['100', '100', '100', '100']]),
    ...intraday('2026-10-08T13:30:00Z', [['25', '25', '24', '25'], ['25', '26', '24', '25'], ['25', '26', '24', '25']]),
  ];
  // Decision on the third bar of 10-07 (history 3): the fill is the first bar of the ex-date, at its open.
  const pendingEntry = strategy({ enterAt: 3, exitAt: 100, stop: '80', target: '120' });

  it('the first ex-date intraday bar starts exactly at the regular session open', () => {
    expect(bars()[3]!.startTime).toBe(OPEN_OCT8);
    expect(XNAS.session('2026-10-08', 'regular')!.open).toBe(Date.parse(OPEN_OCT8));
  });

  it('knowledge before the open: the split is applied before the market-open fill; levels transformed; applied once', () => {
    const r = run(bars(), pendingEntry, withActions([{ ...SPLIT_4_1, ...at(K0) }]));
    const buy = r.fills.find((f) => f.side === 'buy')!;
    expect(buy.at).toBe(OPEN_OCT8);
    expect(buy.executionPrice.toString()).toBe('25');
    expect(r.openPosition!.quantity.toString()).toBe('40');
    expect(r.openPosition!.stopLoss!.toString()).toBe('20');
    expect(r.openPosition!.takeProfit!.toString()).toBe('30');
    expect(r.corporateActions!.applied).toHaveLength(1);
  });

  it('knowledge exactly at the open: applied', () => {
    const r = run(bars(), pendingEntry, with_(OPEN_OCT8));
    expect(r.openPosition!.quantity.toString()).toBe('40');
  });

  it('knowledge 1 ms after the open: fails closed', () => {
    expect(() => run(bars(), pendingEntry, with_('2026-10-08T13:30:00.001Z'))).toThrow(/CORPORATE_ACTION_TIMING_UNPROVEN/);
  });

  it('knowledge after the open but before the first bar closes: fails closed (intraday first-bar repair is not allowed)', () => {
    expect(() => run(bars(), pendingEntry, with_('2026-10-08T13:32:00.000Z'))).toThrow(/CORPORATE_ACTION_TIMING_UNPROVEN/);
  });

  it('DST: the session open of a winter ex-date is 14:30 UTC, taken from the calendar, not from UTC slicing', () => {
    const winter = [
      ...intraday('2026-03-05T14:30:00Z', [['100', '100', '100', '100'], ['100', '100', '100', '100'], ['100', '100', '100', '100']]),
      ...intraday('2026-03-06T14:30:00Z', [['25', '25', '24', '25'], ['25', '26', '24', '25']]),
    ];
    const split = ca({ key: 'split:2026-03-06', type: 'split', exDate: '2026-03-06', from: '1', to: '4' });
    const r = run(winter, pendingEntry, withActions([{ ...split, ...at('2026-03-01T00:00:00.000Z') }]));
    expect(r.corporateActions!.applied[0]!.effectiveAt).toBe('2026-03-06T14:30:00.000Z');
    expect(r.fills.find((f) => f.side === 'buy')!.at).toBe('2026-03-06T14:30:00.000Z');
  });
});

describe('O2 timing: dividend convention (documented; not changed)', () => {
  it('a sell filled on the ex-date open is still entitled: entitlement is fixed immediately before the open (V1 convention)', () => {
    const rows: Row[] = [...SPLIT_ROWS.slice(0, 3), ['2026-10-08', '100', '100', '100', '100'], ['2026-10-09', '100', '100', '100', '100']];
    const div = ca({ key: 'dividend:2026-10-08', type: 'cash_dividend', exDate: '2026-10-08', cash: '0.5', currency: 'USD' });
    const r = run(series(rows), strategy({ enterAt: 1, exitAt: 3 }), withActions([div]));
    expect(r.corporateActions!.dividendReceivables).toHaveLength(1);
    expect(r.corporateActions!.dividendReceivables[0]!.entitledQuantity.toString()).toBe('10');
    expect(r.trades[0]!.exit.at.startsWith('2026-10-08')).toBe(true);
  });
});

describe('O2 same-instant splits: non-trivial ratios (§9)', () => {
  it('3-for-2 and 5-for-4 on one instant compose exactly: one composite transformation, the same for either input order', () => {
    // Quantity factors: 2/3 (a reverse split 3 → 2) and 5/4 (a split 4 → 5). Composite 5/6 is rounded once, to 0.833333333333.
    // Sequential rounding (2/3 first) gives 0.833333333334, so the economics would depend on the order.
    const a = ca({ key: 'reverse:a', type: 'reverse_split', exDate: '2026-10-08', from: '3', to: '2' });
    const b = ca({ key: 'split:b', type: 'split', exDate: '2026-10-08', from: '4', to: '5' });
    const rows: Row[] = [['2026-10-05', '100', '100', '100', '100'], ['2026-10-06', '100', '100', '100', '100'], ['2026-10-07', '100', '100', '100', '100'], ['2026-10-08', '120', '120', '120', '120']];
    const sizing = { type: 'fixed_cash' as const, amount: '100' };
    const forward = run(series(rows), strategy({ enterAt: 1, exitAt: 100 }), { ...withActions([a, b]), sizing });
    const reversed = run(series(rows), strategy({ enterAt: 1, exitAt: 100 }), { ...withActions([b, a]), sizing });
    expect(forward.openPosition!.quantity.toString()).toBe('0.833333333333');
    expect(reversed.openPosition!.quantity.toString()).toBe(forward.openPosition!.quantity.toString());
    expect(forward.openPosition!.entryPrice.toString()).toBe('120');
  });
});

describe('O2 source identity (§10)', () => {
  it('two records of the same actionKey from different sources are not silently deduplicated: fail closed', () => {
    const fromB = ca({ key: 'split:2026-10-08', type: 'split', exDate: '2026-10-08', from: '1', to: '4', source: 'other:source' });
    expect(() => run(series(SPLIT_ROWS.slice(0, 4)), HOLD, withActions([SPLIT_4_1, fromB]))).toThrow(/CORPORATE_ACTION_SOURCE_CONFLICT/);
  });

  it('one input may not mix sources: fail closed', () => {
    const other = ca({ key: 'dividend:x', type: 'cash_dividend', exDate: '2026-10-09', cash: '0.1', currency: 'USD', source: 'other:source' });
    expect(() => run(series(SPLIT_ROWS.slice(0, 4)), HOLD, withActions([SPLIT_4_1, other]))).toThrow(/CORPORATE_ACTION_SOURCE_CONFLICT/);
  });
});

describe('O2 audit semantics and linkage (§3, §12)', () => {
  it('appliedAt is the simulated transformation instant (the effective instant); processedAt is the event that applied it', () => {
    const r = run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 1, exitAt: 100 }), with_(K0));
    const applied = r.corporateActions!.applied[0]!;
    expect(applied.appliedAt).toBe(OPEN_OCT8);
    expect(applied.effectiveAt).toBe(OPEN_OCT8);
    expect(applied.processedAt).toBe(DAILY_CLOSE_OCT8);
  });

  it('the applied audit names its source, so the original record is recoverable without the actionKey alone', () => {
    const r = run(series(SPLIT_ROWS.slice(0, 4)), strategy({ enterAt: 1, exitAt: 100 }), with_(K0));
    const applied = r.corporateActions!.applied[0]!;
    expect(applied).toMatchObject({ source: SPLIT_4_1.source, actionKey: SPLIT_4_1.actionKey, revision: 1, ingestSeq: 1, contentHash: SPLIT_4_1.contentHash });
  });
});

describe('O2 policy identity (§11)', () => {
  it('a change of the policy version changes the fingerprint of the corporate-action input', () => {
    const input = { calendar: XNAS, actions: [SPLIT_4_1] };
    const first = series(SPLIT_ROWS.slice(0, 4))[0]!;
    const current = new CorporateActionLedger(input, 'USD', first).fingerprintRows();
    const altered = new CorporateActionLedger(input, 'USD', first, { policyVersion: 'corporate-action-policy:v-altered' }).fingerprintRows();
    expect(hashOf(current)).not.toBe(hashOf(altered));
    expect(CORPORATE_ACTION_POLICY_VERSION).toBeTruthy();
    expect(CORPORATE_ACTION_ENGINE_VERSION).toBeTruthy();
  });
});
