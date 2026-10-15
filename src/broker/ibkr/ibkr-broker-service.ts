// IBKR read-only service: sync, append-only persistence, reconciliation against the Capital Ledger, freshness, and the explicit
// IBKR contract -> NEXUS instrument mapping. It never writes to the ledger, never corrects a difference, and never sends a broker
// order. Every record is keyed by a fingerprint of its content, so an identical observation cannot create a conflicting history.

import { derivePositions } from '../../capital/portfolio.js';
import type { AccountBalance, AccountKey } from '../../capital/capital-types.js';
import type { Instrument, ProviderInstrumentMapping } from '../../market-data/market-data-types.js';
import type { AppendOnlyLog } from '../../persistence/append-only-log.js';
import { hashOf } from '../../persistence/canonical-json.js';
import { brokerSnapshotFingerprint, normalizeBrokerSnapshot, type BrokerSnapshotContent } from '../broker-snapshot-model.js';
import { reconcileBrokerSnapshot, type BrokerSnapshot, type BrokerSyncAdapter, type ReconciliationIssue } from '../broker-sync.js';
import { IbkrError } from './ibkr-errors.js';

/** A snapshot older than this is not current broker state. Explicit policy; a stale snapshot stays visible but is flagged. */
export const IBKR_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;
export const IBKR_PROVIDER = 'ibkr' as const;

export interface SnapshotRecord {
  readonly schema: 'broker-snapshot:v1';
  readonly snapshotId: string;
  readonly content: BrokerSnapshotContent;
}

export type SyncRecord =
  | { readonly schema: 'broker-sync:v1'; readonly syncId: string; readonly outcome: 'success'; readonly snapshotId: string; readonly observedAt: string; readonly retrievedAt: string }
  | { readonly schema: 'broker-sync:v1'; readonly syncId: string; readonly outcome: 'failed'; readonly errorCode: string; readonly attemptedAt: string };

export interface ReconciliationRecord {
  readonly schema: 'broker-reconciliation:v1';
  readonly reconciliationId: string;
  readonly snapshotId: string;
  readonly ledgerFingerprint: string;
  readonly matched: boolean;
  readonly issues: readonly ReconciliationIssue[];
}

export interface LedgerView {
  balances(): ReadonlyMap<AccountKey, AccountBalance>;
}

export interface BrokerRegistry {
  get(instrumentId: string): Instrument | undefined;
  resolve(provider: string, providerSymbol: string, at: string, exchange?: string): string | null;
  addMapping(mapping: ProviderInstrumentMapping, change: { at: string; by: { kind: 'human' | 'system'; id: string }; reason: string }): Promise<void>;
}

export interface IbkrServiceDeps {
  adapter: BrokerSyncAdapter;
  /** IBKR_ENABLED. When false, nothing is read and the status says so. */
  enabled: boolean;
  /** The masked configured account, for display only. */
  accountRef: string | null;
  ledger: LedgerView;
  registry: BrokerRegistry;
  snapshots: AppendOnlyLog<SnapshotRecord>;
  syncs: AppendOnlyLog<SyncRecord>;
  reconciliations: AppendOnlyLog<ReconciliationRecord>;
  clock: () => Date;
  maxAgeMs?: number;
}

export type IbkrConnectionState = 'connected' | 'not_connected' | 'error';
export type IbkrFreshness = 'fresh' | 'stale' | 'unknown';

export interface IbkrStatusView {
  readonly ibkr: {
    readonly configured: boolean;
    readonly connection: IbkrConnectionState;
    readonly access: 'read_only';
    readonly lastSuccessfulSync: string | null;
    readonly lastErrorCode: string | null;
    readonly accountRef: string | null;
  };
}

export interface IbkrSnapshotView {
  readonly snapshotId: string;
  readonly observedAt: string;
  readonly retrievedAt: string;
  readonly freshness: IbkrFreshness;
  readonly content: BrokerSnapshotContent;
}

export interface IbkrReconciliationView {
  readonly reconciliationId: string;
  readonly snapshotId: string;
  readonly observedAt: string | null;
  readonly freshness: IbkrFreshness;
  /** True whenever the underlying snapshot is not fresh. A stale reconciliation is shown, but never as current truth. */
  readonly stale: boolean;
  readonly matched: boolean;
  readonly issues: readonly ReconciliationIssue[];
}

export interface IbkrSyncResult {
  readonly snapshot: IbkrSnapshotView;
  readonly reconciliation: IbkrReconciliationView;
}

export interface IbkrMappingRequest {
  conid: string;
  instrumentId: string;
  validFrom: string;
}

export interface IbkrMappingResult {
  readonly status: 'MAPPED' | 'ALREADY_MAPPED';
  readonly instrumentId: string;
  readonly brokerInstrumentId: string;
}

function freshnessOf(observedAt: string | null, nowMs: number, maxAgeMs: number): IbkrFreshness {
  if (observedAt === null) return 'unknown';
  const age = nowMs - Date.parse(observedAt);
  // A snapshot from the future (clock skew) is not trusted as fresh either.
  return age >= 0 && age <= maxAgeMs ? 'fresh' : 'stale';
}

function ledgerFingerprintOf(balances: ReadonlyMap<AccountKey, AccountBalance>): string {
  const state = [...balances.entries()].map(([key, balance]) => [key, balance.amount.toString(), balance.quantity.toString()] as const);
  return hashOf(state.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

export class IbkrBrokerService {
  private lastErrorCode: string | null = null;
  private readonly maxAgeMs: number;

  constructor(private readonly deps: IbkrServiceDeps) {
    this.maxAgeMs = deps.maxAgeMs ?? IBKR_SNAPSHOT_MAX_AGE_MS;
  }

  private now(): Date {
    return this.deps.clock();
  }

  /** Last known state. The live check is the sync itself; a status call never sends a request to IBKR. */
  async status(): Promise<IbkrStatusView> {
    const last = this.lastSuccessfulSync();
    const connection: IbkrConnectionState = !this.deps.enabled ? 'not_connected' : this.lastErrorCode !== null ? 'error' : this.deps.adapter.connection();
    return {
      ibkr: {
        configured: this.deps.enabled,
        connection,
        access: 'read_only',
        lastSuccessfulSync: last?.observedAt ?? null,
        lastErrorCode: this.lastErrorCode,
        accountRef: this.deps.accountRef,
      },
    };
  }

  /**
   * Reads IBKR, validates, stores the snapshot (idempotent by content), records the observation, and reconciles against the
   * ledger. Read-only: nothing is booked, nothing is corrected, no order is sent.
   */
  async sync(): Promise<IbkrSyncResult> {
    if (!this.deps.enabled) throw new IbkrError('BROKER_NOT_CONNECTED', 'IBKR read-only sync is not enabled');
    let snapshot: BrokerSnapshot;
    try {
      snapshot = await this.deps.adapter.fetchSnapshot();
    } catch (error) {
      if (!(error instanceof IbkrError)) throw error;
      this.lastErrorCode = error.code;
      // The audit record of a failed attempt is best effort: a failing audit write must not hide the broker error itself.
      const attemptedAt = this.now().toISOString();
      const syncId = 'bsync_' + hashOf({ failed: error.code, attemptedAt }).slice(0, 40);
      await this.deps.syncs.append(syncId, { schema: 'broker-sync:v1', syncId, outcome: 'failed', errorCode: error.code, attemptedAt }).catch(() => undefined);
      throw error;
    }
    this.lastErrorCode = null;

    const content = normalizeBrokerSnapshot(snapshot);
    const snapshotId = 'bsnap_' + brokerSnapshotFingerprint(content).slice(0, 40);
    await this.deps.snapshots.append(snapshotId, { schema: 'broker-snapshot:v1', snapshotId, content });
    const syncId = 'bsync_' + hashOf({ snapshotId, observedAt: snapshot.observedAt, retrievedAt: snapshot.retrievedAt }).slice(0, 40);
    await this.deps.syncs.append(syncId, { schema: 'broker-sync:v1', syncId, outcome: 'success', snapshotId, observedAt: snapshot.observedAt, retrievedAt: snapshot.retrievedAt });

    const reconciliation = this.reconcile(snapshot, snapshotId);
    await this.deps.reconciliations.append(reconciliation.reconciliationId, {
      schema: 'broker-reconciliation:v1',
      reconciliationId: reconciliation.reconciliationId,
      snapshotId,
      ledgerFingerprint: reconciliation.ledgerFingerprint,
      matched: reconciliation.matched,
      issues: reconciliation.issues,
    });

    const nowMs = this.now().getTime();
    return {
      snapshot: { snapshotId, observedAt: snapshot.observedAt, retrievedAt: snapshot.retrievedAt, freshness: freshnessOf(snapshot.observedAt, nowMs, this.maxAgeMs), content },
      reconciliation: this.reconciliationView(reconciliation.reconciliationId, snapshotId, reconciliation.matched, reconciliation.issues, snapshot.observedAt),
    };
  }

  private reconcile(snapshot: BrokerSnapshot, snapshotId: string): { reconciliationId: string; ledgerFingerprint: string; matched: boolean; issues: ReconciliationIssue[] } {
    try {
      const balances = this.deps.ledger.balances();
      const positions = derivePositions(balances, { asOf: this.now().toISOString(), maxQuoteAgeMs: 0 });
      const report = reconcileBrokerSnapshot(snapshot, { portfolio: { positions }, balances });
      const ledgerFingerprint = ledgerFingerprintOf(balances);
      const reconciliationId = 'brec_' + hashOf({ snapshotId, ledgerFingerprint }).slice(0, 40);
      return { reconciliationId, ledgerFingerprint, matched: report.matched, issues: report.issues };
    } catch {
      throw new IbkrError('BROKER_RECONCILIATION_FAILURE');
    }
  }

  private reconciliationView(reconciliationId: string, snapshotId: string, matched: boolean, issues: readonly ReconciliationIssue[], observedAt: string | null): IbkrReconciliationView {
    const freshness = freshnessOf(observedAt, this.now().getTime(), this.maxAgeMs);
    return { reconciliationId, snapshotId, observedAt, freshness, stale: freshness !== 'fresh', matched, issues };
  }

  /** The newest successful observation, or null before the first one. */
  private lastSuccessfulSync(): { snapshotId: string; observedAt: string; retrievedAt: string } | null {
    let last: { snapshotId: string; observedAt: string; retrievedAt: string } | null = null;
    for (const record of this.deps.syncs.all()) {
      const payload = record.payload;
      if (payload.outcome !== 'success') continue;
      if (last === null || payload.observedAt > last.observedAt) last = { snapshotId: payload.snapshotId, observedAt: payload.observedAt, retrievedAt: payload.retrievedAt };
    }
    return last;
  }

  async latestSnapshot(): Promise<IbkrSnapshotView | null> {
    const last = this.lastSuccessfulSync();
    if (last === null) return null;
    const stored = this.deps.snapshots.get(last.snapshotId);
    if (!stored) return null;
    return {
      snapshotId: last.snapshotId,
      observedAt: last.observedAt,
      retrievedAt: last.retrievedAt,
      freshness: freshnessOf(last.observedAt, this.now().getTime(), this.maxAgeMs),
      content: stored.payload.content,
    };
  }

  async latestReconciliation(): Promise<IbkrReconciliationView | null> {
    const records = this.deps.reconciliations.all();
    const latest = records.length > 0 ? records[records.length - 1]!.payload : null;
    if (latest === null) return null;
    const observedAt = this.observedAtOf(latest.snapshotId);
    return this.reconciliationView(latest.reconciliationId, latest.snapshotId, latest.matched, latest.issues, observedAt);
  }

  private observedAtOf(snapshotId: string): string | null {
    let observedAt: string | null = null;
    for (const record of this.deps.syncs.all()) {
      const payload = record.payload;
      if (payload.outcome === 'success' && payload.snapshotId === snapshotId && (observedAt === null || payload.observedAt > observedAt)) observedAt = payload.observedAt;
    }
    return observedAt;
  }

  /**
   * Links an IBKR contract (conid) to an existing NEXUS instrument. The conid is the identity, never the ticker. The link is only
   * made when the latest broker evidence for that conid matches the instrument's symbol, currency and exchange. Nothing is invented.
   */
  async mapInstrument(request: IbkrMappingRequest): Promise<IbkrMappingResult> {
    const instrument = this.deps.registry.get(request.instrumentId);
    if (!instrument) throw new IbkrError('BROKER_INSTRUMENT_UNMAPPED', 'NEXUS instrument not found');
    const latest = await this.latestSnapshot();
    const evidence = latest?.content.positions.find((p) => p.brokerInstrumentId === request.conid) ?? null;
    if (evidence === null) throw new IbkrError('BROKER_INSTRUMENT_UNMAPPED', 'no broker evidence for this contract in the latest snapshot');
    if (evidence.brokerSymbol.toUpperCase() !== instrument.symbol.toUpperCase()) throw new IbkrError('BROKER_INSTRUMENT_UNMAPPED', 'symbol differs');
    if (evidence.currency !== instrument.currency) throw new IbkrError('BROKER_INSTRUMENT_UNMAPPED', 'currency differs');
    if (evidence.listingExchange === null || instrument.exchange === undefined || evidence.listingExchange.toUpperCase() !== instrument.exchange.toUpperCase()) {
      throw new IbkrError('BROKER_INSTRUMENT_UNMAPPED', 'listing exchange differs or is missing');
    }
    const at = this.now().toISOString();
    if (Date.parse(request.validFrom) > Date.parse(at)) throw new IbkrError('BROKER_INSTRUMENT_UNMAPPED', 'validFrom must not be in the future');
    const existing = this.deps.registry.resolve(IBKR_PROVIDER, request.conid, at);
    if (existing === request.instrumentId) return { status: 'ALREADY_MAPPED', instrumentId: existing, brokerInstrumentId: request.conid };
    if (existing !== null) throw new IbkrError('BROKER_INSTRUMENT_UNMAPPED', 'contract is already linked to another instrument');
    await this.deps.registry.addMapping(
      { instrumentId: request.instrumentId, provider: IBKR_PROVIDER, providerInstrumentId: request.conid, providerSymbol: request.conid, validFrom: request.validFrom },
      { at, by: { kind: 'system', id: 'nexus-runtime:ibkr-mapping' }, reason: 'explicit IBKR contract to NEXUS instrument mapping' },
    );
    return { status: 'MAPPED', instrumentId: request.instrumentId, brokerInstrumentId: request.conid };
  }
}
