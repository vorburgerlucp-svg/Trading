// Wiring: opens every PostgreSQL-backed store NEXUS needs, with its projector.
// The domain classes (CapitalLedger, EvidenceStore, AuditLog, ModelRegistry, ...) are unchanged;
// they receive these stores instead of the in-memory ones.

import type { ChampionEvent } from '../../ai/champion-challenger.js';
import type { RegistryEvent } from '../../ai/model-registry.js';
import type { AuditEvent } from '../../audit/audit-log.js';
import type { DecisionRecord } from '../../audit/decision-records.js';
import type { BlackboardEntry } from '../../blackboard/blackboard-types.js';
import type { LedgerSnapshot, LedgerSnapshotStore } from '../../capital/ledger-reconciliation.js';
import type { EvidenceRecord } from '../../evidence/evidence-store.js';
import type { MemoryRecordInput } from '../../memory/memory-types.js';
import { PostgresAppendOnlyStore } from './postgres-append-only-store.js';
import { PostgresLedgerStore, type PostgresLedgerStoreOptions } from './postgres-ledger-store.js';
import type { PgPool } from './pool.js';
import { auditProjector, blackboardProjector, championProjector, decisionProjector, evidenceProjector, memoryProjector, registryProjector } from './projectors.js';

export class PostgresLedgerSnapshotStore implements LedgerSnapshotStore {
  constructor(private readonly pool: PgPool) {}

  async save(snapshot: LedgerSnapshot): Promise<void> {
    await this.pool.query('INSERT INTO ledger_snapshots (ledger_id, sequence, ledger_hash, taken_at, state, state_hash) VALUES ($1, $2, $3, $4, $5::jsonb, $6)', [
      snapshot.ledgerId,
      snapshot.sequence,
      snapshot.ledgerHash,
      snapshot.takenAt,
      JSON.stringify({ balances: snapshot.balances, totals: snapshot.totals }),
      snapshot.stateHash,
    ]);
  }

  async latest(ledgerId: string): Promise<LedgerSnapshot | null> {
    const row = (
      await this.pool.query<{ sequence_text: string; ledger_hash: string; taken_at: Date; state: Pick<LedgerSnapshot, 'balances' | 'totals'>; state_hash: string }>(
        'SELECT s.sequence::text AS sequence_text, s.ledger_hash, s.taken_at, s.state, s.state_hash FROM ledger_snapshots s WHERE s.ledger_id = $1 ORDER BY s.sequence DESC, s.taken_at DESC LIMIT 1',
        [ledgerId],
      )
    ).rows[0];
    if (!row) return null;
    return { ledgerId, sequence: Number(row.sequence_text), ledgerHash: row.ledger_hash, takenAt: row.taken_at.toISOString(), balances: row.state.balances, totals: row.state.totals, stateHash: row.state_hash };
  }
}

export interface PostgresNexusStores {
  ledger: PostgresLedgerStore;
  evidence: PostgresAppendOnlyStore<EvidenceRecord>;
  blackboard: PostgresAppendOnlyStore<BlackboardEntry>;
  memory: PostgresAppendOnlyStore<MemoryRecordInput>;
  audit: PostgresAppendOnlyStore<AuditEvent>;
  decisions: PostgresAppendOnlyStore<DecisionRecord>;
  registry: PostgresAppendOnlyStore<RegistryEvent>;
  champions: PostgresAppendOnlyStore<ChampionEvent>;
  snapshots: PostgresLedgerSnapshotStore;
}

export async function openPostgresStores(pool: PgPool, options: PostgresLedgerStoreOptions): Promise<PostgresNexusStores> {
  return {
    ledger: await PostgresLedgerStore.open(pool, options),
    evidence: await PostgresAppendOnlyStore.open(pool, 'evidence', { projector: evidenceProjector }),
    blackboard: await PostgresAppendOnlyStore.open(pool, 'blackboard', { projector: blackboardProjector }),
    memory: await PostgresAppendOnlyStore.open(pool, 'memory', { projector: memoryProjector }),
    audit: await PostgresAppendOnlyStore.open(pool, 'audit', { projector: auditProjector }),
    decisions: await PostgresAppendOnlyStore.open(pool, 'decisions', { projector: decisionProjector }),
    registry: await PostgresAppendOnlyStore.open(pool, 'model-registry', { projector: registryProjector }),
    champions: await PostgresAppendOnlyStore.open(pool, 'champions', { projector: championProjector }),
    snapshots: new PostgresLedgerSnapshotStore(pool),
  };
}
