import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { financialKnowledgeAt } from '../../src/financial/financial-knowledge.js';
import { verifyFinancialEvidence } from '../../src/financial/financial-evidence.js';
import { FinancialEvidenceService } from '../../src/financial/financial-evidence-service.js';
import { PostgresFinancialEvidenceStore } from '../../src/persistence/postgres/postgres-financial-evidence-store.js';
import { ALL_FILINGS, baseConcepts, companyFactsText, FUNDAMENTALS_REQUEST, json200, reversedConcepts, secGateway, standardAnswers, submissionsText, type SecAnswer } from '../financial/sec-fixtures.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// docs/SEC_EDGAR_FUNDAMENTALS_V1.md §13, §21–§23. The real pipeline: SEC connector (scripted HTTP), gateway, evidence v2, the PostgreSQL store with its
// COMMIT_SEAL, and the strict point-in-time read. No network: every HTTP answer is injected.

describe.skipIf(!pgAvailable)('SEC EDGAR fundamentals through the persistence path' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db?.drop();
  });

  async function persistence(answers: readonly SecAnswer[]) {
    const { gateway } = await secGateway(answers);
    const store = new PostgresFinancialEvidenceStore(db.pool);
    return { service: new FinancialEvidenceService({ gateway, store }), store };
  }

  it('fixture path: connector, gateway, evidence v2, PostgreSQL, COMMIT_SEAL, getSealed and verification all agree', async () => {
    const { service, store } = await persistence(standardAnswers());
    const result = await service.fetchAndPersist(FUNDAMENTALS_REQUEST());
    expect(result.status).toBe('APPLIED');
    expect(result.sealed.seal).toMatchObject({ proofKind: 'COMMIT_SEAL', evidenceId: result.sealed.evidence.evidenceId });
    expect(() => verifyFinancialEvidence(result.sealed.evidence)).not.toThrow();
    expect(await store.getSealed(result.sealed.evidence.evidenceId)).toEqual(result.sealed);
  });

  it('mandatory point-in-time regression: a FY2024 filing fetched and persisted now is not known at an as-of in 2025', async () => {
    const { service, store } = await persistence(standardAnswers());
    const result = await service.fetchAndPersist(FUNDAMENTALS_REQUEST('2024-FY', '2026-06-01T10:00:00.000Z'));
    const sealedAt = result.sealed.seal!.sealedAt;
    expect(financialKnowledgeAt(result.sealed, '2025-06-01T00:00:00.000Z').result).toBe('PROVEN_NOT_AVAILABLE');
    expect(await store.readAvailable({ asOf: '2025-06-01T00:00:00.000Z' })).toEqual([]);
    expect((await store.readAvailable({ asOf: sealedAt })).map((s) => s.evidence.evidenceId)).toEqual([result.sealed.evidence.evidenceId]);
  });

  it('a repeated fetch of the same filing is ALREADY_APPLIED and keeps the first record and seal', async () => {
    const first = await persistence(standardAnswers());
    const a = await first.service.fetchAndPersist(FUNDAMENTALS_REQUEST('2024-FY', '2026-06-01T10:00:00.000Z', 'USD', 'r-1'));
    const later = await persistence(standardAnswers());
    const b = await later.service.fetchAndPersist(FUNDAMENTALS_REQUEST('2024-FY', '2026-06-01T10:00:00.000Z', 'USD', 'r-2'));
    expect(b.status).toBe('ALREADY_APPLIED');
    expect(b.sealed.evidence.evidenceId).toBe(a.sealed.evidence.evidenceId);
    expect(b.sealed.seal).toEqual(a.sealed.seal);
    expect((await db.pool.query('SELECT count(*)::text AS n FROM financial_evidence')).rows[0]).toEqual({ n: '1' });
  });

  it('a reordered companyfacts response is the same record identity, so it is ALREADY_APPLIED and not a second row', async () => {
    const first = await persistence(standardAnswers());
    await first.service.fetchAndPersist(FUNDAMENTALS_REQUEST());
    const reordered = await persistence(standardAnswers(ALL_FILINGS, reversedConcepts(baseConcepts())));
    expect((await reordered.service.fetchAndPersist(FUNDAMENTALS_REQUEST())).status).toBe('ALREADY_APPLIED');
    expect((await db.pool.query('SELECT count(*)::text AS n FROM financial_evidence')).rows[0]).toEqual({ n: '1' });
  });

  it('a changed selected fact is a new record: nothing is overwritten', async () => {
    const first = await persistence(standardAnswers());
    await first.service.fetchAndPersist(FUNDAMENTALS_REQUEST());
    const concepts = baseConcepts();
    concepts.GrossProfit = { USD: [{ start: '2023-10-01', end: '2024-09-28', val: '180683000001', accn: '0000320193-24-000081', fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01' }] };
    const changed = await persistence([json200(submissionsText(ALL_FILINGS)), json200(companyFactsText(concepts))]);
    expect((await changed.service.fetchAndPersist(FUNDAMENTALS_REQUEST())).status).toBe('APPLIED');
    expect((await db.pool.query('SELECT count(*)::text AS n FROM financial_evidence')).rows[0]).toEqual({ n: '2' });
  });
});
