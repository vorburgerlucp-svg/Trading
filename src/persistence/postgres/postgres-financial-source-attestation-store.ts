// PostgreSQL store for official-source attestations (financial-source-attestation:v1, migration 013, docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §20–§21,
// §25). Records are immutable. The creation time is the database clock, set by a trigger. Every read verifies the record it returns, recomputes its hashes,
// and checks its indexed columns against the record. A save verifies before it writes, and it runs in one transaction under a transaction-level advisory
// lock, so two identical saves cannot leave an ambiguous state.

import {
  FinancialSourceAttestationError,
  verifyFinancialSourceAttestation,
  type FinancialSourceAttestation,
} from '../../financial/financial-source-attestation.js';
import type { FinancialSourceAttestationStore, SourceAttestationQuery, SourceSaveStatus } from '../../financial/financial-source-attestation-store.js';
import { newYorkDateOf } from '../../financial/historical-policy.js';
import { decodeJson, encodeJson } from '../json-codec.js';
import type { PgClient, PgPool } from './pool.js';

const COLUMNS = `attestation_id, evidence_id, evidence_record_hash, provider, connector_id, capability, instrument_id, cik, source_id, source_form,
  to_char(source_filing_date, 'YYYY-MM-DD') AS source_filing_date, source_artifact_hash, selected_facts_hash, policy_version, record_hash, record`;

/** One stored row. The record is the complete canonical attestation; the other columns are indexed copies of it. */
interface Row {
  attestation_id: string;
  evidence_id: string;
  evidence_record_hash: string;
  provider: string;
  connector_id: string;
  capability: string;
  instrument_id: string;
  cik: string;
  source_id: string;
  source_form: string;
  source_filing_date: string;
  source_artifact_hash: string;
  selected_facts_hash: string;
  policy_version: string;
  record_hash: string;
  record: unknown;
}

/** A session-independent key for the transaction lock, taken from the identity hash. 60 bits are enough: a collision only serialises two saves. */
function lockKeyOf(attestationId: string): string {
  return BigInt('0x' + attestationId.slice(4, 19)).toString();
}

async function rollbackQuietly(client: PgClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* the connection may already be gone; the transaction is gone with it */
  }
}

function refuse(message: string): never {
  throw new FinancialSourceAttestationError('SOURCE_ATTESTATION_INVALID', message);
}

export class PostgresFinancialSourceAttestationStore implements FinancialSourceAttestationStore {
  constructor(private readonly pool: PgPool) {}

  /** Verifies, then stores in one transaction. The creation time is set by the database, never by this code. */
  async save(attestation: FinancialSourceAttestation): Promise<SourceSaveStatus> {
    const verified = verifyFinancialSourceAttestation(attestation);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKeyOf(verified.attestationId)]);
      const existing = (await client.query<{ record_hash: string }>('SELECT record_hash FROM financial_source_attestations WHERE attestation_id = $1', [verified.attestationId])).rows[0];
      if (existing) {
        await client.query('COMMIT');
        // The same identity with a different record is never resolved by overwriting.
        if (existing.record_hash !== verified.attestationHash) {
          throw new FinancialSourceAttestationError('SOURCE_ATTESTATION_CONFLICT', 'attestation ' + verified.attestationId + ' is stored with a different record');
        }
        return 'ALREADY_APPLIED';
      }
      await client.query(
        `INSERT INTO financial_source_attestations (attestation_id, evidence_id, evidence_record_hash, provider, connector_id, capability, instrument_id, cik,
           source_id, source_form, source_filing_date, source_artifact_hash, selected_facts_hash, policy_version, record_hash, record)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13, $14, $15, $16::jsonb)`,
        [
          verified.attestationId,
          verified.evidenceId,
          verified.evidenceRecordHash,
          verified.provider,
          verified.connectorId,
          verified.capability,
          verified.instrumentId,
          verified.cik,
          verified.sourceId,
          verified.sourceForm,
          verified.sourceFilingDate,
          verified.sourceArtifactHash,
          verified.selectedFactsHash,
          verified.policyVersion,
          verified.attestationHash,
          JSON.stringify(encodeJson(verified)),
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
    const stored = await this.get(verified.attestationId);
    if (stored === null) refuse('the attestation ' + verified.attestationId + ' was saved but cannot be read back');
    return 'APPLIED';
  }

  async get(attestationId: string): Promise<FinancialSourceAttestation | null> {
    const row = (await this.pool.query<Row>(`SELECT ${COLUMNS} FROM financial_source_attestations WHERE attestation_id = $1`, [attestationId])).rows[0];
    return row === undefined ? null : this.open(row);
  }

  async getForEvidence(evidenceId: string): Promise<readonly FinancialSourceAttestation[]> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM financial_source_attestations WHERE evidence_id = $1 ORDER BY attestation_id`, [evidenceId]);
    return rows.map((row) => this.open(row));
  }

  /**
   * The verified attestations whose official filing date is strictly before the New York date of asOf, and that match the filters. The bound is computed by the
   * shared policy helper, and the reader applies the same policy again to every row.
   */
  async readEligible(query: SourceAttestationQuery): Promise<readonly FinancialSourceAttestation[]> {
    const bound = newYorkDateOf(query.asOf);
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM financial_source_attestations
        WHERE source_filing_date < $1::date
          AND ($2::text IS NULL OR instrument_id = $2::text)
          AND ($3::text IS NULL OR connector_id = $3::text)
          AND ($4::text IS NULL OR capability = $4::text)
        ORDER BY source_filing_date, attestation_id`,
      [bound, query.instrumentId ?? null, query.connectorId ?? null, query.capability ?? null],
    );
    return rows.map((row) => this.open(row));
  }

  /** Verifies a stored row completely: the record, its hashes, and every indexed column against the record. Any mismatch throws. */
  private open(row: Row): FinancialSourceAttestation {
    const a = verifyFinancialSourceAttestation(decodeJson(row.record));
    const columns: Array<[string, unknown, unknown]> = [
      ['attestation_id', row.attestation_id, a.attestationId],
      ['evidence_id', row.evidence_id, a.evidenceId],
      ['evidence_record_hash', row.evidence_record_hash, a.evidenceRecordHash],
      ['provider', row.provider, a.provider],
      ['connector_id', row.connector_id, a.connectorId],
      ['capability', row.capability, a.capability],
      ['instrument_id', row.instrument_id, a.instrumentId],
      ['cik', row.cik, a.cik],
      ['source_id', row.source_id, a.sourceId],
      ['source_form', row.source_form, a.sourceForm],
      ['source_filing_date', row.source_filing_date, a.sourceFilingDate],
      ['source_artifact_hash', row.source_artifact_hash, a.sourceArtifactHash],
      ['selected_facts_hash', row.selected_facts_hash, a.selectedFactsHash],
      ['policy_version', row.policy_version, a.policyVersion],
      ['record_hash', row.record_hash, a.attestationHash],
    ];
    for (const [column, stored, expected] of columns) {
      if (stored !== expected) refuse('column ' + column + ' does not match the stored attestation');
    }
    return a;
  }
}
