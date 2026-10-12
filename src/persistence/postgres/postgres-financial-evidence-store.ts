// PostgreSQL financial evidence store (financial-evidence-store:v1, migration 012). Records are immutable. Each record is sealed by NEXUS's database clock:
// recorded_at is read before the commit and sealed_at after it, both in the database, never in the application. Every read verifies the record it
// returns, recomputes its hashes, checks its indexed columns against the record, and verifies the seal when present. Any mismatch fails closed.
// Docs: docs/FINANCIAL_EVIDENCE_PERSISTENCE_V1.md.

import { verifyFinancialEvidence, FinancialEvidenceIntegrityError, type FinancialEvidence } from '../../financial/financial-evidence.js';
import { FinancialEvidenceConflictError, type FinancialEvidencePitQuery, type FinancialEvidenceStore, type SaveStatus } from '../../financial/financial-evidence-store.js';
import { financialSealFor, verifyFinancialSeal, type FinancialEvidenceSeal, type FinancialProofKind, type SealedFinancialEvidence } from '../../financial/financial-knowledge.js';
import { hashOf } from '../canonical-json.js';
import { decodeJson, encodeJson } from '../json-codec.js';
import { databaseClock, type Queryable } from './postgres-scanner-backtest-store.js';
import type { PgClient, PgPool } from './pool.js';

/** Canonical ISO UTC with milliseconds, exactly as the evidence and its seals are written and verified. */
const ISO_MS_SQL = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** A stored record and its seal, read in one statement. The seal columns are null when no seal exists. */
interface JoinedRow {
  evidence_id: string;
  schema_version: string;
  connector_id: string;
  provider: string;
  transport: string;
  capability: string;
  instrument_id: string | null;
  query_fingerprint: string;
  semantic_hash: string;
  record_hash: string;
  effective_at: string | null;
  provider_published_at: string | null;
  retrieved_at: string;
  nexus_received_at: string;
  created_at: string;
  record: unknown;
  seal_evidence_id: string | null;
  proof_kind: FinancialProofKind | null;
  seal_record_hash: string | null;
  seal_recorded_at: string | null;
  seal_sealed_at: string | null;
  seal_hash: string | null;
}

const JOINED_COLUMNS = `e.evidence_id, e.schema_version, e.connector_id, e.provider, e.transport, e.capability, e.instrument_id, e.query_fingerprint,
  e.semantic_hash, e.record_hash, e.record,
  to_char(e.effective_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS effective_at,
  to_char(e.provider_published_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS provider_published_at,
  to_char(e.retrieved_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS retrieved_at,
  to_char(e.nexus_received_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS nexus_received_at,
  to_char(e.created_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS created_at,
  s.evidence_id AS seal_evidence_id, s.proof_kind, s.record_hash AS seal_record_hash,
  to_char(s.recorded_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS seal_recorded_at,
  to_char(s.sealed_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS seal_sealed_at, s.seal_hash`;

const FROM_JOINED = 'FROM financial_evidence e LEFT JOIN financial_evidence_seals s ON s.evidence_id = e.evidence_id';

export interface PostgresFinancialEvidenceStoreOptions {
  /** Test seam only. Runs after the record's commit and before its seal, to model a crash in that gap. */
  afterCommit?: () => Promise<void>;
}

async function rollbackQuietly(client: { query(sql: string): Promise<unknown> }): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* the connection may already be gone; the transaction is gone with it */
  }
}

/** A session-level advisory lock is keyed by the semantic identity. 60 bits of the hash are enough: a collision only serialises two saves. */
function lockKeyOf(semanticHash: string): string {
  return BigInt('0x' + semanticHash.slice(0, 15)).toString();
}

function integrity(message: string): FinancialEvidenceIntegrityError {
  return new FinancialEvidenceIntegrityError(message);
}

export class PostgresFinancialEvidenceStore implements FinancialEvidenceStore {
  constructor(
    private readonly pool: PgPool,
    private readonly options: PostgresFinancialEvidenceStoreOptions = {},
  ) {}

  /**
   * Verifies, then stores. The whole save runs under a session lock keyed by the semantic identity, from the existence check through the commit seal.
   * A concurrent saver therefore waits until the seal exists, and never attests a record whose committer is still sealing it.
   */
  async save(evidence: FinancialEvidence): Promise<SaveStatus> {
    // A caller-built record is refused before the database sees it, whatever its TypeScript type says.
    const verified = verifyFinancialEvidence(evidence);
    const recordHash = hashOf(verified);
    const semanticHash = verified.evidenceId.slice(3);
    const key = lockKeyOf(semanticHash);
    const client = await this.pool.connect();
    let unlockFailure: Error | undefined;
    try {
      await client.query('SELECT pg_advisory_lock($1::bigint)', [key]);
      return await this.saveLocked(client, verified, recordHash, semanticHash);
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
      } catch (error) {
        unlockFailure = error instanceof Error ? error : new Error(String(error));
      }
      client.release(unlockFailure);
    }
  }

  async get(evidenceId: string): Promise<FinancialEvidence | null> {
    const row = await this.loadOne(this.pool, evidenceId);
    return row === null ? null : this.open(row).evidence;
  }

  async getSealed(evidenceId: string): Promise<SealedFinancialEvidence | null> {
    const row = await this.loadOne(this.pool, evidenceId);
    return row === null ? null : this.open(row);
  }

  /** Records whose seal proves NEXUS knew them by asOf. Ordered by sealed_at, then evidence_id. Every returned record is verified. */
  async readAvailable(query: FinancialEvidencePitQuery): Promise<readonly SealedFinancialEvidence[]> {
    const { rows } = await this.pool.query<JoinedRow>(
      `SELECT ${JOINED_COLUMNS} ${FROM_JOINED}
        WHERE s.sealed_at <= $1::timestamptz
          AND ($2::text IS NULL OR e.instrument_id = $2::text)
          AND ($3::text IS NULL OR e.connector_id = $3::text)
          AND ($4::text IS NULL OR e.capability = $4::text)
        ORDER BY s.sealed_at, e.evidence_id`,
      [query.asOf, query.instrumentId ?? null, query.connectorId ?? null, query.capability ?? null],
    );
    return rows.map((row) => this.open(row));
  }

  private async saveLocked(client: PgClient, evidence: FinancialEvidence, recordHash: string, semanticHash: string): Promise<SaveStatus> {
    const stored = (await client.query<{ record_hash: string; semantic_hash: string }>('SELECT record_hash, semantic_hash FROM financial_evidence WHERE evidence_id = $1', [evidence.evidenceId])).rows[0];
    if (stored) {
      // The same id with a different identity is never resolved by overwriting. Equivalent evidence is already stored: it keeps its first record and seal.
      if (stored.semantic_hash !== semanticHash) throw new FinancialEvidenceConflictError('evidence ' + evidence.evidenceId + ' is stored with a different identity; refusing to overwrite');
      const existing = (await client.query('SELECT 1 FROM financial_evidence_seals WHERE evidence_id = $1', [evidence.evidenceId])).rows[0];
      if (!existing) await this.attest(client, evidence.evidenceId, stored.record_hash);
      return 'ALREADY_APPLIED';
    }
    const recordedAt = await this.insertCommitted(client, evidence, recordHash, semanticHash);
    // The record is durable. A crash from here leaves a committed record with no seal: a later save attests its presence, and never invents this time.
    if (this.options.afterCommit) await this.options.afterCommit();
    await this.seal(client, evidence.evidenceId, recordHash, 'COMMIT_SEAL', recordedAt);
    return 'APPLIED';
  }

  /** Inserts the record in its own transaction. recordedAt is read inside the transaction, before COMMIT: a lower bound on the commit time. */
  private async insertCommitted(client: PgClient, e: FinancialEvidence, recordHash: string, semanticHash: string): Promise<string> {
    await client.query('BEGIN');
    try {
      const recordedAt = await databaseClock(client);
      await client.query(
        `INSERT INTO financial_evidence (evidence_id, schema_version, connector_id, provider, transport, capability, instrument_id, query_fingerprint,
           semantic_hash, record_hash, effective_at, provider_published_at, retrieved_at, nexus_received_at, created_at, recorded_at, record)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::timestamptz, $13::timestamptz, $14::timestamptz, $15::timestamptz, $16::timestamptz, $17::jsonb)`,
        [
          e.evidenceId,
          e.schemaVersion,
          e.connectorId,
          e.provider,
          e.transport,
          e.capability,
          e.instrumentId,
          e.queryFingerprint,
          semanticHash,
          recordHash,
          e.effectiveAt,
          e.providerPublishedAt,
          e.retrievedAt,
          e.nexusReceivedAt,
          e.createdAt,
          recordedAt,
          JSON.stringify(encodeJson(e)),
        ],
      );
      await client.query('COMMIT');
      return recordedAt;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    }
  }

  /** Writes a seal in its own statement after the commit. sealedAt is an upper bound on the commit time, read from the database clock. */
  private async seal(client: PgClient, evidenceId: string, recordHash: string, proofKind: FinancialProofKind, recordedAt: string): Promise<FinancialEvidenceSeal> {
    const sealedAt = await databaseClock(client);
    const seal = financialSealFor({ evidenceId, proofKind, recordHash, recordedAt, sealedAt });
    await client.query(
      `INSERT INTO financial_evidence_seals (evidence_id, proof_kind, record_hash, recorded_at, sealed_at, seal_hash)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6) ON CONFLICT (evidence_id) DO NOTHING`,
      [seal.evidenceId, seal.proofKind, seal.recordHash, seal.recordedAt, seal.sealedAt, seal.sealHash],
    );
    const stored = (await client.query<JoinedRow>(`SELECT ${JOINED_COLUMNS} ${FROM_JOINED} WHERE e.evidence_id = $1`, [evidenceId])).rows[0];
    if (!stored || stored.seal_evidence_id === null) throw integrity('the seal of ' + evidenceId + ' could not be read back');
    return this.open(stored).seal!;
  }

  /** A presence attestation for a record that has no seal. It proves the record existed by its sealedAt, and never an earlier time. */
  private async attest(client: PgClient, evidenceId: string, recordHash: string): Promise<void> {
    const recordedAt = await databaseClock(client);
    await this.seal(client, evidenceId, recordHash, 'PRESENCE_ATTESTATION', recordedAt);
  }

  private async loadOne(db: Queryable, evidenceId: string): Promise<JoinedRow | null> {
    return ((await db.query(`SELECT ${JOINED_COLUMNS} ${FROM_JOINED} WHERE e.evidence_id = $1`, [evidenceId])).rows[0] as JoinedRow | undefined) ?? null;
  }

  /** Verifies a stored row completely: the record, its hashes, its columns and its seal. Any mismatch throws. */
  private open(row: JoinedRow): SealedFinancialEvidence {
    const evidence = verifyFinancialEvidence(decodeJson(row.record));
    const recordHash = hashOf(evidence);
    const semanticHash = evidence.evidenceId.slice(3);
    if (row.evidence_id !== evidence.evidenceId) throw integrity('the stored id does not match the record');
    if (recordHash !== row.record_hash) throw integrity('record hash mismatch: the stored record was altered');
    if (semanticHash !== row.semantic_hash) throw integrity('semantic hash mismatch: the stored identity was altered');
    const columns: Array<[string, unknown, unknown]> = [
      ['schema_version', row.schema_version, evidence.schemaVersion],
      ['connector_id', row.connector_id, evidence.connectorId],
      ['provider', row.provider, evidence.provider],
      ['transport', row.transport, evidence.transport],
      ['capability', row.capability, evidence.capability],
      ['instrument_id', row.instrument_id, evidence.instrumentId],
      ['query_fingerprint', row.query_fingerprint, evidence.queryFingerprint],
      ['effective_at', row.effective_at, evidence.effectiveAt],
      ['provider_published_at', row.provider_published_at, evidence.providerPublishedAt],
      ['retrieved_at', row.retrieved_at, evidence.retrievedAt],
      ['nexus_received_at', row.nexus_received_at, evidence.nexusReceivedAt],
      ['created_at', row.created_at, evidence.createdAt],
    ];
    for (const [column, stored, expected] of columns) {
      if (stored !== expected) throw integrity('column ' + column + ' does not match the stored record');
    }
    if (row.seal_evidence_id === null) return { evidence, recordHash, semanticHash, seal: null };
    const seal = verifyFinancialSeal(
      {
        evidenceId: row.seal_evidence_id,
        proofKind: row.proof_kind as FinancialProofKind,
        recordHash: row.seal_record_hash as string,
        recordedAt: row.seal_recorded_at as string,
        sealedAt: row.seal_sealed_at as string,
        sealHash: row.seal_hash as string,
      },
      { evidenceId: evidence.evidenceId, recordHash: row.record_hash },
    );
    return { evidence, recordHash, semanticHash, seal };
  }
}
