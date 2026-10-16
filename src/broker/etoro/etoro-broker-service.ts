// The eToro demo read-only service (O20): one sync reads the demo portfolio, reconciles it against the ledger, and only then stores
// the snapshot, the reconciliation and the sync record. Every write is append-only. Nothing is booked, nothing is corrected, and no
// instrument is mapped. A failed attempt leaves a failed sync record and stores no snapshot.

import type { AccountBalance, AccountKey } from '../../capital/capital-types.js';
import { derivePositions } from '../../capital/portfolio.js';
import type { AppendOnlyLog } from '../../persistence/append-only-log.js';
import { hashOf } from '../../persistence/canonical-json.js';
import { BrokerError, type BrokerErrorCode } from '../broker-errors.js';
import { reconcileBrokerSnapshot, type ReconciliationIssue } from '../broker-sync.js';
import type { EtoroBrokerSyncAdapter, EtoroCoverage, EtoroSnapshot } from './etoro-sync-adapter.js';

/** A snapshot older than this is stale: it is not current broker state. */
export const ETORO_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

/** The ledger view this service reads. It exposes balances only: the service has no way to write to the ledger. */
export interface EtoroLedgerView {
  balances(): ReadonlyMap<AccountKey, AccountBalance>;
}

/** What is persisted of a snapshot. It has no timestamps, so identical content keeps one snapshot id. */
export interface EtoroSnapshotContent {
  readonly broker: 'etoro';
  readonly accountId: null;
  readonly access: 'read_only';
  readonly coverage: EtoroCoverage;
  readonly positionCount: 0;
  readonly openOrderCount: 0;
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
}

function ledgerFingerprintOf(balances: ReadonlyMap<AccountKey, AccountBalance>): string {
  const state = [...balances.entries()].map(([key, balance]) => [key, balance.amount.toString(), balance.quantity.toString()] as const);
  return hashOf(state.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/**
 * Only the verified empty state is persistable in O20. A snapshot that carries entries is refused, so the stored content can never
 * claim an empty state for data that was not read.
 */
function contentOf(snapshot: EtoroSnapshot): EtoroSnapshotContent {
  if (snapshot.cash.length !== 0 || snapshot.positions.length !== 0 || snapshot.openOrders.length !== 0) {
    throw new BrokerError('BROKER_RESPONSE_INVALID', 'the snapshot carries entries that this build does not persist');
  }
  return { broker: 'etoro', accountId: null, access: 'read_only', coverage: snapshot.coverage, positionCount: 0, openOrderCount: 0 };
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
      content = contentOf(snapshot);
    } catch (error) {
      if (error instanceof BrokerError) await this.recordFailure(error.code);
      throw error;
    }
    try {
      const balances = this.deps.ledger.balances();
      const positions = derivePositions(balances, { asOf: snapshot.observedAt, maxQuoteAgeMs: 0 });
      const report = reconcileBrokerSnapshot(snapshot, { portfolio: { positions }, balances });
      reconciled = { ledgerFingerprint: ledgerFingerprintOf(balances), matched: report.matched, issues: report.issues };
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

  /** The newest successful observation, or null before the first one. */
  private lastSuccessfulSync(): SuccessfulSync | null {
    let last: SuccessfulSync | null = null;
    for (const record of this.deps.syncs.all()) {
      const payload = record.payload;
      if (payload.outcome !== 'success') continue;
      if (last === null || payload.observedAt > last.observedAt) {
        last = { snapshotId: payload.snapshotId, reconciliationId: payload.reconciliationId, observedAt: payload.observedAt, retrievedAt: payload.retrievedAt };
      }
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
