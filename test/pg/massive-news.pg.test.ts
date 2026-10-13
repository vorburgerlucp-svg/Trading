import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MassiveNewsRestConnector } from '../../src/financial/massive-news-connector.js';
import { FinancialDataGateway } from '../../src/financial/financial-gateway.js';
import { FinancialEvidenceService } from '../../src/financial/financial-evidence-service.js';
import { FinancialConnectorRegistry } from '../../src/financial/financial-registry.js';
import { financialKnowledgeAt } from '../../src/financial/financial-knowledge.js';
import { verifyFinancialEvidence } from '../../src/financial/financial-evidence.js';
import { PostgresFinancialEvidenceStore } from '../../src/persistence/postgres/postgres-financial-evidence-store.js';
import { ResilientCaller } from '../../src/market-data/providers/resilience.js';
import { change, UNREVIEWED } from '../financial/fixtures.js';
import { ARTICLE_A, ARTICLE_B, ARTICLE_INJECTION, MASSIVE_CONNECTOR, MASSIVE_PROVIDER, MASSIVE_SECRET, NEWS_REQUEST, PAGE, json, massiveInstruments, scriptedFetch, type Answer } from '../financial/massive-fixtures.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// docs/MASSIVE_NEWS_CONNECTOR_V1.md §11, §17–§19. The real pipeline: Massive REST, validation, one evidence per article, a database knowledge seal per
// article, and a strict point-in-time read. The HTTP answers are injected: this file makes no network call.

const noSleep = { now: () => 0, sleep: async () => undefined, random: () => 0.5 };

function pipeline(db: TestDatabase, answers: Answer[]) {
  const http = scriptedFetch(answers);
  const connector = new MassiveNewsRestConnector({
    secrets: { get: (ref: string) => (ref === 'massive-api-key' ? MASSIVE_SECRET : undefined) },
    fetch: http.fetch,
    caller: new ResilientCaller(MASSIVE_PROVIDER, { timeoutMs: 1000, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2, rateLimitFallbackMs: 1 }, noSleep),
    clock: () => new Date(),
  });
  const store = new PostgresFinancialEvidenceStore(db.pool);
  return { http, connector, store, build: async () => {
    const registry = await FinancialConnectorRegistry.open();
    await registry.register({ connectorId: MASSIVE_CONNECTOR, provider: MASSIVE_PROVIDER, transport: 'rest', capabilities: ['news'], license: UNREVIEWED, mode: 'RESEARCH' }, change());
    await registry.enable(MASSIVE_CONNECTOR, change());
    const gateway = new FinancialDataGateway({ registry, instruments: await massiveInstruments(), connectors: [connector], clock: () => new Date() });
    return new FinancialEvidenceService({ gateway, store });
  } };
}

describe.skipIf(!pgAvailable)('Massive news through the persistence path' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db?.drop();
  });

  it('each article is saved and sealed on its own, and reads back verified with its seal', async () => {
    const p = pipeline(db, [json(200, PAGE([ARTICLE_A, ARTICLE_B]))]);
    const service = await p.build();
    const result = await service.fetchAndPersistMany(NEWS_REQUEST());
    expect(result.complete).toBe(true);
    expect(result.items.map((i) => i.status)).toEqual(['APPLIED', 'APPLIED']);
    for (const item of result.items) {
      expect(item.sealed.seal).toMatchObject({ proofKind: 'COMMIT_SEAL', evidenceId: item.sealed.evidence.evidenceId });
      expect(() => verifyFinancialEvidence(item.sealed.evidence)).not.toThrow();
      expect(await p.store.getSealed(item.sealed.evidence.evidenceId)).toEqual(item.sealed);
    }
    const rows = await db.pool.query('SELECT count(*)::text AS n FROM financial_evidence_seals');
    expect(rows.rows[0]).toEqual({ n: '2' });
  });

  it('the injected title is stored quarantined and reads back quarantined, with the original hash kept', async () => {
    const service = await (pipeline(db, [json(200, PAGE([ARTICLE_INJECTION]))])).build();
    const [item] = (await service.fetchAndPersistMany(NEWS_REQUEST())).items;
    const [title] = item!.sealed.evidence.textBlocks!;
    expect(title).toMatchObject({ quarantined: true, text: expect.stringContaining('QUARANTINED') });
    expect(title!.originalHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a later fetch of the same article is ALREADY_APPLIED and keeps the first record and first seal', async () => {
    const first = await (pipeline(db, [json(200, PAGE([ARTICLE_A]))])).build();
    const [a] = (await first.fetchAndPersistMany(NEWS_REQUEST('r-1'))).items;
    const later = await (pipeline(db, [json(200, PAGE([ARTICLE_A]))])).build();
    const [b] = (await later.fetchAndPersistMany(NEWS_REQUEST('r-2'))).items;
    expect(b!.status).toBe('ALREADY_APPLIED');
    expect(b!.sealed.evidence.evidenceId).toBe(a!.sealed.evidence.evidenceId);
    expect(b!.sealed.recordHash).toBe(a!.sealed.recordHash);
    expect(b!.sealed.seal).toEqual(a!.sealed.seal);
    expect((await db.pool.query('SELECT count(*)::text AS n FROM financial_evidence')).rows[0]).toEqual({ n: '1' });
  });

  it('a changed article is a new record: nothing is overwritten', async () => {
    const original = await (pipeline(db, [json(200, PAGE([ARTICLE_A]))])).build();
    await original.fetchAndPersistMany(NEWS_REQUEST('r-1'));
    const changed = await (pipeline(db, [json(200, PAGE([{ ...ARTICLE_A, title: 'Apple revises guidance' }]))])).build();
    const [b] = (await changed.fetchAndPersistMany(NEWS_REQUEST('r-2'))).items;
    expect(b!.status).toBe('APPLIED');
    expect((await db.pool.query('SELECT count(*)::text AS n FROM financial_evidence')).rows[0]).toEqual({ n: '2' });
  });

  it('providerPublishedAt is provenance: an article published in January and stored now is not known in February', async () => {
    const service = await (pipeline(db, [json(200, PAGE([ARTICLE_A]))])).build();
    const [item] = (await service.fetchAndPersistMany(NEWS_REQUEST())).items;
    expect(item!.sealed.evidence.providerPublishedAt).toBe('2026-01-01T12:00:00.000Z');
    expect(financialKnowledgeAt(item!.sealed, '2026-02-01T00:00:00.000Z').result).toBe('PROVEN_NOT_AVAILABLE');
    const store = new PostgresFinancialEvidenceStore(db.pool);
    expect(await store.readAvailable({ asOf: '2026-02-01T00:00:00.000Z' })).toEqual([]);
    expect((await store.readAvailable({ asOf: item!.sealed.seal!.sealedAt })).map((s) => s.evidence.evidenceId)).toEqual([item!.sealed.evidence.evidenceId]);
  });
});
