// Snapshots and reconciliation.
//
// A snapshot is a performance cache, never the truth: the ledger is the truth. Every snapshot names
// the exact ledger position it was derived from (sequence + hash), so it can be checked:
//   - the ledger entry at that sequence must still have that hash (otherwise history changed)
//   - rebuilding the state from the ledger up to that sequence must give the same numbers
// Differences are reported as RECONCILIATION_FAILURE. Nothing is ever corrected silently.
//
// The rebuild below deliberately does NOT reuse the ledger's incremental projection code, so a bug
// in one path shows up as a difference instead of being reproduced.

import { formatUnits } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import { parseAccountKey } from './accounts.js';
import type { CapitalLedger } from './capital-ledger.js';
import type { AccountKey, JournalEntry } from './capital-types.js';
import { BASE_LEDGER_CURRENCY, FinancialIntegrityError, verifyLedgerEntries } from './ledger-integrity.js';
import type { LedgerStore } from './ledger-store.js';

export interface SnapshotBalance {
  account: AccountKey;
  currency: string;
  /** Minor units as decimal string (bigint-safe). */
  amountMinor: string;
  quantity: string;
}

export interface SnapshotTotals {
  cashMinor: string;
  positionsCostMinor: string;
  inventoryCostMinor: string;
  receivablesMinor: string;
  liabilitiesMinor: string;
  contributionsMinor: string;
}

export interface LedgerSnapshot {
  ledgerId: string;
  sequence: number;
  ledgerHash: string;
  takenAt: string;
  balances: SnapshotBalance[];
  totals: SnapshotTotals;
  /** Hash over everything above; detects a corrupted snapshot record. */
  stateHash: string;
}

export interface LedgerSnapshotStore {
  save(snapshot: LedgerSnapshot): Promise<void>;
  latest(ledgerId: string): Promise<LedgerSnapshot | null>;
}

export class InMemoryLedgerSnapshotStore implements LedgerSnapshotStore {
  private readonly snapshots: LedgerSnapshot[] = [];
  async save(snapshot: LedgerSnapshot): Promise<void> {
    this.snapshots.push(structuredClone(snapshot));
  }
  async latest(ledgerId: string): Promise<LedgerSnapshot | null> {
    const own = this.snapshots.filter((s) => s.ledgerId === ledgerId);
    return own.length === 0 ? null : structuredClone(own.reduce((a, b) => (b.sequence >= a.sequence ? b : a)));
  }
}

/** Independent fold over raw entries (sequence 1..upTo). */
export function rebuildBalances(entries: readonly JournalEntry[], upToSequence: number): Map<string, { account: AccountKey; currency: string; amount: bigint; quantityUnits: bigint; quantityScale: number }> {
  const result = new Map<string, { account: AccountKey; currency: string; amount: bigint; quantityUnits: bigint; quantityScale: number }>();
  for (const entry of entries) {
    if (entry.sequence > upToSequence) break;
    for (const p of entry.postings) {
      const currency = p.currency ?? BASE_LEDGER_CURRENCY;
      const key = p.account + '|' + currency;
      const before = result.get(key) ?? { account: p.account, currency, amount: 0n, quantityUnits: 0n, quantityScale: 0 };
      let units = before.quantityUnits;
      let scale = before.quantityScale;
      if (p.quantity) {
        const q = p.quantity;
        const target = Math.max(scale, q.scale);
        units = units * 10n ** BigInt(target - scale) + q.units * 10n ** BigInt(target - q.scale);
        scale = target;
      }
      result.set(key, { account: p.account, currency, amount: before.amount + p.amount, quantityUnits: units, quantityScale: scale });
    }
  }
  return result;
}

function balancesFromRebuild(rebuilt: ReturnType<typeof rebuildBalances>): SnapshotBalance[] {
  return [...rebuilt.values()]
    .map((b) => ({ account: b.account, currency: b.currency, amountMinor: b.amount.toString(), quantity: normalizeQuantity(formatUnits(b.quantityUnits, b.quantityScale)) }))
    .sort((a, b) => (a.account + a.currency < b.account + b.currency ? -1 : 1));
}

function normalizeQuantity(text: string): string {
  if (!text.includes('.')) return text;
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

export function totalsOf(balances: readonly SnapshotBalance[]): SnapshotTotals {
  const sum = { cash: 0n, positions: 0n, inventory: 0n, receivables: 0n, liabilities: 0n, contributions: 0n };
  for (const b of balances) {
    const amount = BigInt(b.amountMinor);
    const kind = parseAccountKey(b.account).kind;
    if (kind === 'cash' || kind === 'cash_reservation') sum.cash += amount;
    else if (kind === 'position') sum.positions += amount;
    else if (kind === 'inventory') sum.inventory += amount;
    else if (kind === 'receivable') sum.receivables += amount;
    else if (kind === 'payable' || kind === 'tax_payable') sum.liabilities -= amount;
    else if (kind === 'contributions') sum.contributions -= amount;
  }
  return {
    cashMinor: sum.cash.toString(),
    positionsCostMinor: sum.positions.toString(),
    inventoryCostMinor: sum.inventory.toString(),
    receivablesMinor: sum.receivables.toString(),
    liabilitiesMinor: sum.liabilities.toString(),
    contributionsMinor: sum.contributions.toString(),
  };
}

export function snapshotStateHash(s: Omit<LedgerSnapshot, 'stateHash'>): string {
  return hashOf({ ledgerId: s.ledgerId, sequence: s.sequence, ledgerHash: s.ledgerHash, takenAt: s.takenAt, balances: s.balances, totals: s.totals });
}

/** Snapshot of the ledger's current projection. */
export function takeSnapshot(ledger: CapitalLedger, takenAt: string): LedgerSnapshot {
  const head = ledger.head();
  const balances: SnapshotBalance[] = [...ledger.balances().entries()]
    .map(([account, b]) => ({ account, currency: BASE_LEDGER_CURRENCY, amountMinor: (b.amount as bigint).toString(), quantity: b.quantity.toString() }))
    .sort((a, b) => (a.account + a.currency < b.account + b.currency ? -1 : 1));
  const unsigned = { ledgerId: head.ledgerId, sequence: head.sequence, ledgerHash: head.hash, takenAt, balances, totals: totalsOf(balances) };
  return { ...unsigned, stateHash: snapshotStateHash(unsigned) };
}

export type ReconciliationStatus = 'MATCH' | 'RECONCILIATION_FAILURE' | 'SNAPSHOT_INVALID';

export interface ReconciliationResult {
  status: ReconciliationStatus;
  ledgerId: string;
  sequence: number;
  checks: { name: keyof SnapshotTotals; ledger: string; snapshot: string; match: boolean }[];
  differences: { account: AccountKey; currency: string; field: 'amount' | 'quantity' | 'missing_in_snapshot' | 'missing_in_ledger'; ledger: string; snapshot: string }[];
  issues: string[];
}

export class LedgerReconciliationService {
  constructor(private readonly store: LedgerStore) {}

  /** Verifies the stored history, then compares the snapshot with a fresh rebuild at the snapshot's sequence. */
  async reconcileSnapshot(snapshot: LedgerSnapshot): Promise<ReconciliationResult> {
    const entries = await this.store.loadAll();
    const report = verifyLedgerEntries(entries, { allowedCurrencies: this.store.allowedCurrencies });
    if (!report.ok) throw new FinancialIntegrityError(report.issues, 'reconciliation ' + this.store.ledgerId);

    const invalid = (issue: string): ReconciliationResult => ({ status: 'SNAPSHOT_INVALID', ledgerId: snapshot.ledgerId, sequence: snapshot.sequence, checks: [], differences: [], issues: [issue] });
    if (snapshot.ledgerId !== this.store.ledgerId) return invalid('snapshot belongs to ledger ' + snapshot.ledgerId);
    if (snapshotStateHash(snapshot) !== snapshot.stateHash) return invalid('snapshot content does not match its state hash (corrupted cache)');
    if (snapshot.sequence > entries.length) return invalid('snapshot is ahead of the ledger (sequence ' + snapshot.sequence + ' > ' + entries.length + ')');
    const anchor = snapshot.sequence === 0 ? undefined : entries[snapshot.sequence - 1];
    if (snapshot.sequence > 0 && anchor?.hash !== snapshot.ledgerHash) return invalid('ledger hash at sequence ' + snapshot.sequence + ' differs: history changed or snapshot from another history');

    return compare(this.store.ledgerId, snapshot.sequence, balancesFromRebuild(rebuildBalances(entries, snapshot.sequence)), snapshot.balances, snapshot.totals);
  }

  /** Compares a running ledger projection with a rebuild from storage at the same sequence. */
  async reconcileProjection(ledger: CapitalLedger, takenAt: string): Promise<ReconciliationResult> {
    return this.reconcileSnapshot(takeSnapshot(ledger, takenAt));
  }
}

function compare(ledgerId: string, sequence: number, fromLedger: SnapshotBalance[], fromSnapshot: SnapshotBalance[], snapshotTotals: SnapshotTotals): ReconciliationResult {
  const differences: ReconciliationResult['differences'] = [];
  const key = (b: SnapshotBalance) => b.account + '|' + b.currency;
  const nonZero = (b: SnapshotBalance) => b.amountMinor !== '0' || (b.quantity !== '0' && b.quantity !== '');
  const ledgerMap = new Map(fromLedger.filter(nonZero).map((b) => [key(b), b]));
  const snapMap = new Map(fromSnapshot.filter(nonZero).map((b) => [key(b), b]));
  for (const [k, l] of ledgerMap) {
    const s = snapMap.get(k);
    if (!s) differences.push({ account: l.account, currency: l.currency, field: 'missing_in_snapshot', ledger: l.amountMinor, snapshot: '-' });
    else {
      if (s.amountMinor !== l.amountMinor) differences.push({ account: l.account, currency: l.currency, field: 'amount', ledger: l.amountMinor, snapshot: s.amountMinor });
      if (normalizeQuantity(s.quantity) !== normalizeQuantity(l.quantity)) differences.push({ account: l.account, currency: l.currency, field: 'quantity', ledger: l.quantity, snapshot: s.quantity });
    }
  }
  for (const [k, s] of snapMap) if (!ledgerMap.has(k)) differences.push({ account: s.account, currency: s.currency, field: 'missing_in_ledger', ledger: '-', snapshot: s.amountMinor });

  const ledgerTotals = totalsOf(fromLedger);
  const checks = (Object.keys(ledgerTotals) as (keyof SnapshotTotals)[]).map((name) => ({ name, ledger: ledgerTotals[name], snapshot: snapshotTotals[name], match: ledgerTotals[name] === snapshotTotals[name] }));
  const ok = differences.length === 0 && checks.every((c) => c.match);
  return { status: ok ? 'MATCH' : 'RECONCILIATION_FAILURE', ledgerId, sequence, checks, differences, issues: [] };
}

