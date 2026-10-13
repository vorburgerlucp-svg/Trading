import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FinancialEvidenceService } from '../../src/financial/financial-evidence-service.js';
import { FinancialReplayReader } from '../../src/financial/financial-replay-reader.js';
import { buildFinancialSourceAttestation, type FinancialSourceAttestation } from '../../src/financial/financial-source-attestation.js';
import { SecSourceAttestor } from '../../src/financial/sec-source-attestation.js';
import { PostgresFinancialEvidenceStore } from '../../src/persistence/postgres/postgres-financial-evidence-store.js';
import { PostgresFinancialSourceAttestationStore } from '../../src/persistence/postgres/postgres-financial-source-attestation-store.js';
import { AAPL_ID } from '../financial/fixtures.js';
import { archiveHeaderText, CIK_PADDED, FY_ACCESSION, FY_FILING_DATE } from '../financial/sec-attestation-fixtures.js';
import { ALL_FILINGS, baseConcepts, clock, companyFactsText, FUNDAMENTALS_REQUEST, json200, secCaller, secHttp, secGateway, secInstruments, standardAnswers, submissionsText, TEST_USER_AGENT } from '../financial/sec-fixtures.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';
import { sha256Hex } from '../../src/persistence/canonical-json.js';

// docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §20–§27, §31, §47–§49. The core proof, against a real PostgreSQL 17 database. An evidence record is
// sealed by the database clock in 2026, and its source is attested to a 2024 filing. The DB knowledge read ignores the attestation. The research read uses
// it under the New York policy. Tamper attempts, the binding trigger and concurrent saves are proven here too.

describe.skipIf(!pgAvailable)('historical source attestation through PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db?.drop();
  });

  /** A FY2024 evidence record, persisted and sealed by the database clock, and its attestation built by the real attestor from scripted SEC answers. */
  async function persistedWithAttestation() {
    const evidenceStore = new PostgresFinancialEvidenceStore(db.pool);
    const attestationStore = new PostgresFinancialSourceAttestationStore(db.pool);
    const { gateway } = await secGateway(standardAnswers());
    const { sealed } = await new FinancialEvidenceService({ gateway, store: evidenceStore }).fetchAndPersist(FUNDAMENTALS_REQUEST('2024-FY', '2026-06-01T10:00:00.000Z'));
    const http = secHttp([json200(submissionsText(ALL_FILINGS)), json200(companyFactsText(baseConcepts())), { status: 200, body: archiveHeaderText() }]);
    const attestor = new SecSourceAttestor({ userAgent: TEST_USER_AGENT, fetch: http.fetch, caller: secCaller(), clock, instruments: await secInstruments() });
    const attestation = await attestor.attest(sealed);
    return { evidenceStore, attestationStore, sealed, attestation, reader: new FinancialReplayReader({ evidenceStore, attestationStore }) };
  }

  it('the core proof: sealed in 2026, attested to 2024 — readAvailable and decision_time return nothing at asOf 2025, research returns the attested record', async () => {
    const { evidenceStore, attestationStore, sealed, attestation, reader } = await persistedWithAttestation();
    expect(await attestationStore.save(attestation)).toBe('APPLIED');
    expect(await evidenceStore.readAvailable({ asOf: '2025-06-01T00:00:00.000Z' })).toEqual([]);
    expect(await reader.readForReplay({ asOf: '2025-06-01T00:00:00.000Z', useCase: 'decision_time' })).toEqual([]);
    const research = await reader.readForReplay({ asOf: '2025-06-01T00:00:00.000Z', useCase: 'historical_research' });
    expect(research.map((r) => r.basis)).toEqual(['SEC_SOURCE_ATTESTATION']);
    expect(research[0]!.evidence.evidenceId).toBe(sealed.evidence.evidenceId);
  });

  it('after the DB seal, historical research states the DB basis, never mixing the two', async () => {
    const { attestationStore, sealed, attestation, reader } = await persistedWithAttestation();
    await attestationStore.save(attestation);
    const records = await reader.readForReplay({ asOf: sealed.seal!.sealedAt, useCase: 'historical_research' });
    expect(records.map((r) => r.basis)).toEqual(['DB_KNOWLEDGE_SEAL']);
  });

  it('the New York policy holds in the database read: the filing day is unavailable, the next New York day is available', async () => {
    const { attestationStore, attestation, reader } = await persistedWithAttestation();
    await attestationStore.save(attestation);
    expect(await reader.readForReplay({ asOf: '2024-11-01T13:00:00.000Z', useCase: 'historical_research' })).toEqual([]);
    expect((await reader.readForReplay({ asOf: '2024-11-02T04:00:00.000Z', useCase: 'historical_research' })).map((r) => r.basis)).toEqual(['SEC_SOURCE_ATTESTATION']);
  });

  it('a repeated save of the same attestation is ALREADY_APPLIED and keeps one row (brief 28)', async () => {
    const { attestationStore, attestation } = await persistedWithAttestation();
    expect(await attestationStore.save(attestation)).toBe('APPLIED');
    expect(await attestationStore.save(attestation)).toBe('ALREADY_APPLIED');
    expect((await db.pool.query('SELECT count(*)::text AS n FROM financial_source_attestations')).rows[0]).toEqual({ n: '1' });
  });

  it('the attestation is read back verified, and the attested time is the database clock, never earlier than the seal (brief 25)', async () => {
    const { attestationStore, sealed, attestation } = await persistedWithAttestation();
    await attestationStore.save(attestation);
    expect(await attestationStore.get(attestation.attestationId)).toEqual(attestation);
    const row = (await db.pool.query('SELECT attested_at::text AS at FROM financial_source_attestations')).rows[0] as { at: string };
    expect(Date.parse(row.at)).toBeGreaterThanOrEqual(Date.parse(sealed.seal!.sealedAt));
  });

  it('the database refuses UPDATE, DELETE and TRUNCATE on attestations (brief 26)', async () => {
    const { attestationStore, attestation } = await persistedWithAttestation();
    await attestationStore.save(attestation);
    await expect(db.pool.query("UPDATE financial_source_attestations SET source_filing_date = '2024-11-02'")).rejects.toThrow();
    await expect(db.pool.query('DELETE FROM financial_source_attestations')).rejects.toThrow();
    await expect(db.pool.query('TRUNCATE financial_source_attestations')).rejects.toThrow();
  });

  it('the binding trigger refuses an attestation that names a different version of the evidence record (brief 27)', async () => {
    const { attestationStore, sealed } = await persistedWithAttestation();
    const wrong = buildFinancialSourceAttestation({
      evidenceId: sealed.evidence.evidenceId,
      evidenceRecordHash: 'd'.repeat(64),
      evidenceContentHash: sealed.evidence.contentHash,
      provider: 'sec-edgar',
      connectorId: 'sec-edgar-fundamentals-rest',
      capability: 'fundamentals',
      instrumentId: AAPL_ID,
      cik: CIK_PADDED,
      sourceId: FY_ACCESSION,
      sourceForm: '10-K',
      sourceFilingDate: FY_FILING_DATE,
      sourceAcceptanceRaw: '20241101060130',
      sourceArtifactHash: sha256Hex(archiveHeaderText()),
      selectedFactsHash: 'e'.repeat(64),
      policyVersion: 'sec-filing-date-next-ny-day:v1',
    });
    await expect(attestationStore.save(wrong)).rejects.toThrow();
  });

  it('an attestation for an evidence id that is not stored is refused by the foreign key', async () => {
    const { attestationStore, attestation } = await persistedWithAttestation();
    const orphan = buildFinancialSourceAttestation({ ...attestationDraft(attestation), evidenceId: 'fe_' + 'a'.repeat(64) });
    await expect(attestationStore.save(orphan)).rejects.toThrow();
  });

  it('concurrent identical saves: one is applied, the others are already applied, and no conflicting state is written', async () => {
    const { attestationStore, attestation } = await persistedWithAttestation();
    const statuses = await Promise.all([attestationStore.save(attestation), attestationStore.save(attestation), attestationStore.save(attestation)]);
    expect(statuses.sort()).toEqual(['ALREADY_APPLIED', 'ALREADY_APPLIED', 'APPLIED']);
    expect((await db.pool.query('SELECT count(*)::text AS n FROM financial_source_attestations')).rows[0]).toEqual({ n: '1' });
  });

  it('a direct tamper of any attested column is either refused by the database or detected on read (brief 48)', async () => {
    const { attestationStore, attestation } = await persistedWithAttestation();
    await attestationStore.save(attestation);
    const tampers = [
      "source_filing_date = '2024-11-02'",
      "source_id = '0000320193-24-000099'",
      "source_artifact_hash = repeat('9', 64)",
      "selected_facts_hash = repeat('9', 64)",
      "evidence_record_hash = repeat('9', 64)",
      "policy_version = 'sec-filing-date-same-day:v1'",
      "record = jsonb_set(record, '{sourceArtifactHash}', to_jsonb(repeat('9', 64)))",
    ];
    let writes = 0;
    for (const tamper of tampers) {
      const client = await db.pool.connect();
      let written = false;
      try {
        await client.query('SET session_replication_role = replica');
        // A write the database refuses (for example a CHECK) is a valid outcome: nothing changed, so there is nothing to detect.
        await client.query('UPDATE financial_source_attestations SET ' + tamper).then(
          () => (written = true),
          () => undefined,
        );
      } finally {
        await client.query('SET session_replication_role = DEFAULT');
        client.release();
      }
      const detected = await attestationStore.getForEvidence(attestation.evidenceId).then(
        () => false,
        () => true,
      );
      expect(detected || !written, tamper).toBe(true);
      if (written) {
        writes++;
        expect(detected, tamper).toBe(true);
      }
      // Restore the exact stored state, so the next tamper starts from the attested record.
      const restore = await db.pool.connect();
      try {
        await restore.query('SET session_replication_role = replica');
        await restore.query('DELETE FROM financial_source_attestations').catch(() => undefined);
      } finally {
        await restore.query('SET session_replication_role = DEFAULT');
        restore.release();
      }
      await attestationStore.save(attestation);
    }
    // The CHECK on policy_version refuses one tamper. The other tampers must reach the table, or the detection proof above is vacuous.
    expect(writes).toBeGreaterThanOrEqual(6);
  });
});

/** The attestation's own fields, so a test can build a variant of it. */
function attestationDraft(a: FinancialSourceAttestation) {
  return {
    evidenceId: a.evidenceId,
    evidenceRecordHash: a.evidenceRecordHash,
    evidenceContentHash: a.evidenceContentHash,
    provider: a.provider,
    connectorId: a.connectorId,
    capability: a.capability,
    instrumentId: a.instrumentId,
    cik: a.cik,
    sourceId: a.sourceId,
    sourceForm: a.sourceForm,
    sourceFilingDate: a.sourceFilingDate,
    sourceAcceptanceRaw: a.sourceAcceptanceRaw,
    sourceArtifactHash: a.sourceArtifactHash,
    selectedFactsHash: a.selectedFactsHash,
    policyVersion: a.policyVersion,
  };
}
