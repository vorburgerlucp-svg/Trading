// The eToro demo read-only service (O20): one sync reads the demo portfolio, reconciles it against the ledger, and only then stores
// the snapshot, the reconciliation and the sync record. Every write is append-only. Nothing is booked, nothing is corrected, and no
// instrument is mapped. A failed attempt leaves a failed sync record and stores no snapshot.

import type { AccountBalance, AccountKey } from '../../capital/capital-types.js';
import { derivePositions } from '../../capital/portfolio.js';
import type { AppendOnlyLog } from '../../persistence/append-only-log.js';
import { hashOf } from '../../persistence/canonical-json.js';
import { BrokerError, type BrokerErrorCode } from '../broker-errors.js';
import { reconcilePositionQuantities, type ReconciliationIssue } from '../broker-sync.js';
import { Decimal } from '../../money/decimal.js';
import type { EtoroPendingOrder, EtoroPosition } from './etoro-validation.js';
import type { EtoroBrokerSyncAdapter, EtoroCoverage, EtoroSnapshot } from './etoro-sync-adapter.js';

/** A snapshot older than this is stale: it is not current broker state. */
export const ETORO_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

/** The ledger view this service reads. It exposes balances only: the service has no way to write to the ledger. */
export interface EtoroLedgerView {
  balances(): ReadonlyMap<AccountKey, AccountBalance>;
}

/** The provider name of the human-governed eToro instrument mapping in the instrument registry. */
export const ETORO_INSTRUMENT_PROVIDER = 'etoro';

/**
 * How the service finds the NEXUS instrument of an eToro instrument id: the human-governed mapping (provider etoro, provider symbol
 * = the eToro instrument id) valid at the observation time. There is no ticker fallback and nothing is registered automatically.
 */
export interface EtoroInstrumentResolver {
  resolve(provider: string, providerSymbol: string, at: string): string | null;
}

/** A stored position: the validated eToro fields and the NEXUS instrument of the mapping, or null when there is none. */
export interface EtoroPositionRecord extends EtoroPosition {
  readonly instrumentId: string | null;
}

export interface EtoroOrderRecord extends EtoroPendingOrder {
  readonly instrumentId: string | null;
}

/**
 * What is persisted of a snapshot. It has no timestamps, so identical content keeps one snapshot id. positions and orders are present
 * only when the portfolio has entries: the content of an empty portfolio is exactly the O20 content.
 */
export interface EtoroSnapshotContent {
  readonly broker: 'etoro';
  readonly accountId: null;
  readonly access: 'read_only';
  readonly coverage: EtoroCoverage;
  readonly positionCount: number;
  readonly openOrderCount: number;
  readonly positions?: readonly EtoroPositionRecord[];
  readonly orders?: readonly EtoroOrderRecord[];
}

export interface EtoroSnapshotRecord {
  readonly schema: 'etoro-snapshot:v1';
  readonly snapshotId: string;
  readonly content: EtoroSnapshotContent;
}

export interface EtoroReconciliationRecord {
  readonly schema: 'etoro-reconciliation:v1';
  readonly reconciliationId: string;
  readonly snapshotId: string;
  readonly observedAt: string;
  readonly ledgerFingerprint: string;
  readonly matched: boolean;
  readonly issues: readonly ReconciliationIssue[];
  readonly coverage: EtoroCoverage;
}

export type EtoroSyncRecord =
  | {
      readonly schema: 'etoro-sync:v1';
      readonly syncId: string;
      readonly outcome: 'success';
      readonly snapshotId: string;
      readonly reconciliationId: string;
      readonly observedAt: string;
      readonly retrievedAt: string;
    }
  | {
      readonly schema: 'etoro-sync:v1';
      readonly syncId: string;
      readonly outcome: 'failed';
      readonly errorCode: BrokerErrorCode;
      readonly attemptedAt: string;
    };

export interface EtoroServiceDeps {
  adapter: EtoroBrokerSyncAdapter;
  ledger: EtoroLedgerView;
  snapshots: AppendOnlyLog<EtoroSnapshotRecord>;
  reconciliations: AppendOnlyLog<EtoroReconciliationRecord>;
  syncs: AppendOnlyLog<EtoroSyncRecord>;
  clock: () => Date;
  maxAgeMs?: number;
  /** The instrument registry. Without it every eToro instrument is unmapped, so a non-empty portfolio never matches. */
  instruments?: EtoroInstrumentResolver | null;
}

export interface EtoroSnapshotView {
  snapshotId: string;
  observedAt: string;
  retrievedAt: string;
  freshness: 'fresh' | 'stale';
  content: EtoroSnapshotContent;
}

export interface EtoroReconciliationView {
  reconciliationId: string;
  snapshotId: string;
  observedAt: string;
  freshness: 'fresh' | 'stale';
  stale: boolean;
  matched: boolean;
  issues: readonly ReconciliationIssue[];
  coverage: EtoroCoverage;
}

interface SuccessfulSync {
  snapshotId: string;
  reconciliationId: string;
  observedAt: string;
  retrievedAt: string;
  sequence: number;
}

/**
 * O22: one stored successful observation, as the demo cycle test verdict reads it. `storedAt` is when its sync record was stored
 * (the log's time); `sequence` is that record's position in the sync log, the tie-break between equal `observedAt`. No freshness:
 * a historical observation is judged by its own times, never against the time of reading.
 */
export interface EtoroSnapshotObservation {
  readonly snapshotId: string;
  readonly observedAt: string;
  readonly retrievedAt: string;
  readonly storedAt: string;
  readonly sequence: number;
  readonly content: EtoroSnapshotContent;
}

/** O22: the stored history; `missingSnapshotRecords` counts successful syncs whose snapshot record could not be read. */
export interface EtoroSnapshotHistory {
  readonly observations: readonly EtoroSnapshotObservation[];
  readonly missingSnapshotRecords: number;
}

/** O22 D4: the newest stored observation as latestStoredSnapshot() reads it, or why there is none that can be used. */
export type EtoroStoredSnapshot =
  | { readonly kind: 'snapshot'; readonly snapshot: EtoroSnapshotView }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'ambiguous' }
  /** O22 Plan B review R2: the stored content contradicts itself or its id (snapshotContentProblems). */
  | { readonly kind: 'inconsistent' };

/**
 * O22 Plan B review R2: what is wrong with a stored snapshot's content, as fixed codes (empty: consistent). The stated counts must
 * equal the stored lists, the coverage must agree with them (verified_empty exactly when a list is empty), no position or order may
 * appear twice, and the snapshot id must be the hash of the content (as sync() derives it). Pure.
 */
export function snapshotContentProblems(snapshotId: string, content: EtoroSnapshotContent): string[] {
  const problems: string[] = [];
  const positions = content.positions ?? [];
  const orders = content.orders ?? [];
  if (!Number.isSafeInteger(content.positionCount) || content.positionCount !== positions.length) problems.push('POSITION_COUNT_MISMATCH');
  if (!Number.isSafeInteger(content.openOrderCount) || content.openOrderCount !== orders.length) problems.push('ORDER_COUNT_MISMATCH');
  if ((positions.length === 0) !== (content.coverage?.positions === 'verified_empty')) problems.push('POSITION_COVERAGE_CONTRADICTED');
  if ((orders.length === 0) !== (content.coverage?.openOrders === 'verified_empty')) problems.push('ORDER_COVERAGE_CONTRADICTED');
  if (new Set(positions.map((p) => p.positionId)).size !== positions.length) problems.push('DUPLICATE_POSITION');
  if (new Set(orders.map((o) => o.orderId)).size !== orders.length) problems.push('DUPLICATE_ORDER');
  if (snapshotId !== 'esnap_' + hashOf(content).slice(0, 40)) problems.push('CONTENT_HASH_MISMATCH');
  return problems;
}

/**
 * The one order of observations: by `observedAt`, then by sync log sequence (the later stored record is the later observation).
 * Used for the history and for the latest snapshot, so both name the same newest observation.
 */
export function compareObservations(a: { readonly observedAt: string; readonly sequence: number }, b: { readonly observedAt: string; readonly sequence: number }): number {
  return Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.sequence - b.sequence;
}

function ledgerFingerprintOf(balances: ReadonlyMap<AccountKey, AccountBalance>): string {
  const state = [...balances.entries()].map(([key, balance]) => [key, balance.amount.toString(), balance.quantity.toString()] as const);
  return hashOf(state.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/**
 * The persisted content. Generic cash, positions and open orders must be empty (they are not used for eToro); the eToro entries are
 * stored with their mapping. The content of an empty portfolio has no positions or orders field, exactly as in O20.
 */
function contentOf(snapshot: EtoroSnapshot, instruments: EtoroInstrumentResolver | null): EtoroSnapshotContent {
  if (snapshot.cash.length !== 0 || snapshot.positions.length !== 0 || snapshot.openOrders.length !== 0) {
    throw new BrokerError('BROKER_RESPONSE_INVALID', 'the snapshot carries generic entries that this build does not persist');
  }
  const map = (etoroInstrumentId: number): string | null => instruments?.resolve(ETORO_INSTRUMENT_PROVIDER, String(etoroInstrumentId), snapshot.observedAt) ?? null;
  const positions = snapshot.etoro.positions.map((p) => ({ ...p, instrumentId: map(p.etoroInstrumentId) }));
  const orders = snapshot.etoro.orders.map((o) => ({ ...o, instrumentId: map(o.etoroInstrumentId) }));
  const base = { broker: 'etoro' as const, accountId: null, access: 'read_only' as const, coverage: snapshot.coverage, positionCount: positions.length, openOrderCount: orders.length };
  return {
    ...base,
    ...(positions.length > 0 ? { positions } : {}),
    ...(orders.length > 0 ? { orders } : {}),
  };
}

/**
 * The broker side of the reconciliation: the net quantity per NEXUS instrument (buy units minus sell units of its mapped positions),
 * and one unmapped_broker_instrument issue per eToro instrument without a mapping. Pending orders do not change positions.
 */
function brokerSide(content: EtoroSnapshotContent): { quantities: Map<string, Decimal>; unmapped: ReconciliationIssue[] } {
  const quantities = new Map<string, Decimal>();
  const unmapped = new Map<number, Decimal>();
  for (const p of content.positions ?? []) {
    const signed = p.direction === 'buy' ? Decimal.from(p.units) : Decimal.from(p.units).negated();
    if (p.instrumentId === null) unmapped.set(p.etoroInstrumentId, (unmapped.get(p.etoroInstrumentId) ?? Decimal.from(0)).plus(signed));
    else quantities.set(p.instrumentId, (quantities.get(p.instrumentId) ?? Decimal.from(0)).plus(signed));
  }
  const issues: ReconciliationIssue[] = [...unmapped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, quantity]) => ({ kind: 'unmapped_broker_instrument' as const, brokerInstrumentId: String(id), broker: quantity.toString() }));
  return { quantities, unmapped: issues };
}

function freshnessOf(observedAt: string, nowMs: number, maxAgeMs: number): 'fresh' | 'stale' {
  const ageMs = nowMs - Date.parse(observedAt);
  return ageMs >= 0 && ageMs <= maxAgeMs ? 'fresh' : 'stale';
}

export class EtoroBrokerService {
  private lastErrorCode: BrokerErrorCode | null = null;
  private readonly maxAgeMs: number;

  constructor(private readonly deps: EtoroServiceDeps) {
    this.maxAgeMs = deps.maxAgeMs ?? ETORO_SNAPSHOT_MAX_AGE_MS;
  }

  private now(): string {
    return this.deps.clock().toISOString();
  }

  /** Last known state. A status call sends no request to eToro. */
  status() {
    const last = this.lastSuccessfulSync();
    const connection = this.lastErrorCode !== null ? 'error' : this.deps.adapter.connection();
    return {
      etoro: {
        configured: true,
        tradingMode: 'demo' as const,
        connection,
        access: 'read_only' as const,
        accountIdentity: 'not_observed' as const,
        lastSuccessfulSync: last?.observedAt ?? null,
        lastErrorCode: this.lastErrorCode,
      },
    };
  }

  /**
   * Reads the demo portfolio, reconciles it against the ledger, and only then stores the snapshot, the reconciliation and the sync
   * record. A failure at any step before those writes records a failed sync and stores no snapshot.
   */
  async sync(): Promise<{ snapshot: EtoroSnapshotView; reconciliation: EtoroReconciliationView }> {
    let snapshot: EtoroSnapshot;
    try {
      snapshot = await this.deps.adapter.fetchSnapshot();
    } catch (error) {
      if (!(error instanceof BrokerError)) throw error;
      await this.recordFailure(error.code);
      throw error;
    }

    let content: EtoroSnapshotContent;
    let reconciled: { ledgerFingerprint: string; matched: boolean; issues: readonly ReconciliationIssue[] };
    try {
      content = contentOf(snapshot, this.deps.instruments ?? null);
    } catch (error) {
      if (error instanceof BrokerError) await this.recordFailure(error.code);
      throw error;
    }
    try {
      const balances = this.deps.ledger.balances();
      const positions = derivePositions(balances, { asOf: snapshot.observedAt, maxQuoteAgeMs: 0 });
      const side = brokerSide(content);
      const issues = [...side.unmapped, ...reconcilePositionQuantities('etoro', side.quantities, positions)];
      reconciled = { ledgerFingerprint: ledgerFingerprintOf(balances), matched: issues.length === 0, issues };
    } catch {
      await this.recordFailure('BROKER_RECONCILIATION_FAILURE');
      throw new BrokerError('BROKER_RECONCILIATION_FAILURE');
    }

    const snapshotId = 'esnap_' + hashOf(content).slice(0, 40);
    const reconciliationId = 'erec_' + hashOf({ snapshotId, observedAt: snapshot.observedAt, ledgerFingerprint: reconciled.ledgerFingerprint }).slice(0, 40);
    const syncId = 'esync_' + hashOf({ snapshotId, reconciliationId, observedAt: snapshot.observedAt, retrievedAt: snapshot.retrievedAt }).slice(0, 40);

    await this.deps.snapshots.append(snapshotId, { schema: 'etoro-snapshot:v1', snapshotId, content });
    await this.deps.reconciliations.append(reconciliationId, {
      schema: 'etoro-reconciliation:v1',
      reconciliationId,
      snapshotId,
      observedAt: snapshot.observedAt,
      ledgerFingerprint: reconciled.ledgerFingerprint,
      matched: reconciled.matched,
      issues: reconciled.issues,
      coverage: snapshot.coverage,
    });
    await this.deps.syncs.append(syncId, {
      schema: 'etoro-sync:v1',
      syncId,
      outcome: 'success',
      snapshotId,
      reconciliationId,
      observedAt: snapshot.observedAt,
      retrievedAt: snapshot.retrievedAt,
    });
    this.lastErrorCode = null;

    const freshness = freshnessOf(snapshot.observedAt, this.deps.clock().getTime(), this.maxAgeMs);
    return {
      snapshot: { snapshotId, observedAt: snapshot.observedAt, retrievedAt: snapshot.retrievedAt, freshness, content },
      reconciliation: {
        reconciliationId,
        snapshotId,
        observedAt: snapshot.observedAt,
        freshness,
        stale: freshness !== 'fresh',
        matched: reconciled.matched,
        issues: reconciled.issues,
        coverage: snapshot.coverage,
      },
    };
  }

  /** Keeps the code as the last error and records the failed attempt. The audit write is best effort: it must not hide the error. */
  private async recordFailure(code: BrokerErrorCode): Promise<void> {
    this.lastErrorCode = code;
    const attemptedAt = this.now();
    const syncId = 'esync_' + hashOf({ failed: code, attemptedAt }).slice(0, 40);
    await this.deps.syncs.append(syncId, { schema: 'etoro-sync:v1', syncId, outcome: 'failed', errorCode: code, attemptedAt }).catch(() => undefined);
  }

  /** The newest successful observation (compareObservations: observedAt, then the later stored record), or null before the first one. */
  private lastSuccessfulSync(): SuccessfulSync | null {
    let last: SuccessfulSync | null = null;
    for (const record of this.deps.syncs.all()) {
      const payload = record.payload;
      if (payload.outcome !== 'success') continue;
      const candidate = { snapshotId: payload.snapshotId, reconciliationId: payload.reconciliationId, observedAt: payload.observedAt, retrievedAt: payload.retrievedAt, sequence: record.sequence };
      if (last === null || compareObservations(candidate, last) > 0) last = candidate;
    }
    return last;
  }

  async latestSnapshot(): Promise<EtoroSnapshotView | null> {
    const last = this.lastSuccessfulSync();
    if (last === null) return null;
    const stored = this.deps.snapshots.get(last.snapshotId);
    if (!stored) return null;
    return {
      snapshotId: last.snapshotId,
      observedAt: last.observedAt,
      retrievedAt: last.retrievedAt,
      freshness: freshnessOf(last.observedAt, this.deps.clock().getTime(), this.maxAgeMs),
      content: stored.payload.content,
    };
  }

  /**
   * O22: every successful observation with its stored content, in compareObservations order (the record of the demo cycle test
   * verdict). Read only: stored state, no broker request. The sync log is read first and the snapshot log after it: sync() appends
   * the snapshot before its sync record, so every sync seen here has its snapshot visible. A snapshot record that still cannot be
   * read is counted in `missingSnapshotRecords`, never skipped silently and never invented.
   */
  async snapshotHistory(): Promise<EtoroSnapshotHistory> {
    await this.deps.syncs.sync();
    await this.deps.snapshots.sync();
    const observations: EtoroSnapshotObservation[] = [];
    let missingSnapshotRecords = 0;
    for (const record of this.deps.syncs.all()) {
      const payload = record.payload;
      if (payload.outcome !== 'success') continue;
      const stored = this.deps.snapshots.get(payload.snapshotId);
      if (!stored) {
        missingSnapshotRecords += 1;
        continue;
      }
      observations.push({ snapshotId: payload.snapshotId, observedAt: payload.observedAt, retrievedAt: payload.retrievedAt, storedAt: record.recordedAt, sequence: record.sequence, content: stored.payload.content });
    }
    return { observations: observations.sort(compareObservations), missingSnapshotRecords };
  }

  /**
   * O22 D4 (R1): the newest stored successful observation after catching up with the records of every process sharing the store
   * (PostgreSQL), never only this process's own copy. Read only: no broker request. Same order as snapshotHistory(): the sync log
   * first, then the snapshot log, so every sync seen has its snapshot visible. Names no snapshot when the newest successful sync's
   * snapshot cannot be read ('unreadable'), or when another successful sync has the same observedAt with a different snapshot
   * ('ambiguous': the storage order between them does not say which portfolio is current).
   */
  async latestStoredSnapshot(): Promise<EtoroStoredSnapshot> {
    await this.deps.syncs.sync();
    await this.deps.snapshots.sync();
    const last = this.lastSuccessfulSync();
    if (last === null) return { kind: 'none' };
    const observedAt = Date.parse(last.observedAt);
    for (const record of this.deps.syncs.all()) {
      const payload = record.payload;
      if (payload.outcome === 'success' && Date.parse(payload.observedAt) === observedAt && payload.snapshotId !== last.snapshotId) return { kind: 'ambiguous' };
    }
    const stored = this.deps.snapshots.get(last.snapshotId);
    if (!stored) return { kind: 'unreadable' };
    if (snapshotContentProblems(last.snapshotId, stored.payload.content).length > 0) return { kind: 'inconsistent' };
    return {
      kind: 'snapshot',
      snapshot: {
        snapshotId: last.snapshotId,
        observedAt: last.observedAt,
        retrievedAt: last.retrievedAt,
        freshness: freshnessOf(last.observedAt, this.deps.clock().getTime(), this.maxAgeMs),
        content: stored.payload.content,
      },
    };
  }

  /** The reconciliation of the newest successful sync. With requireFresh, a stale one is refused (BROKER_SNAPSHOT_STALE). */
  async latestReconciliation(requireFresh: boolean): Promise<EtoroReconciliationView | null> {
    const last = this.lastSuccessfulSync();
    if (last === null) return null;
    const stored = this.deps.reconciliations.get(last.reconciliationId);
    if (!stored) return null;
    const record = stored.payload;
    const freshness = freshnessOf(record.observedAt, this.deps.clock().getTime(), this.maxAgeMs);
    if (requireFresh && freshness !== 'fresh') throw new BrokerError('BROKER_SNAPSHOT_STALE');
    return {
      reconciliationId: record.reconciliationId,
      snapshotId: record.snapshotId,
      observedAt: record.observedAt,
      freshness,
      stale: freshness !== 'fresh',
      matched: record.matched,
      issues: record.issues,
      coverage: record.coverage,
    };
  }
}
