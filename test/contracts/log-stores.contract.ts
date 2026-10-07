// Contract suite for the append-only log stores (generic, audit, model registry, champions,
// evidence). Runs unchanged against the in-memory stores and the PostgreSQL stores.

import { afterEach, describe, expect, it } from 'vitest';
import { ChampionBoard, type ChampionEvent } from '../../src/ai/champion-challenger.js';
import { ModelPerformance } from '../../src/ai/model-performance.js';
import { ModelRegistry, type RegistryEvent } from '../../src/ai/model-registry.js';
import { AuditLog, type AuditEvent } from '../../src/audit/audit-log.js';
import { EvidenceStore, type EvidenceRecord } from '../../src/evidence/evidence-store.js';
import type { MemoryRecordInput } from '../../src/memory/memory-types.js';
import { NexusMemory } from '../../src/memory/nexus-memory.js';
import { Decimal } from '../../src/money/decimal.js';
import { chf } from '../../src/money/money.js';
import { AppendOnlyLog, type AppendOnlyStore } from '../../src/persistence/append-only-log.js';
import { fixedClock, sequentialIds, T0 } from '../helpers.js';
import { evidenceRef, HUMAN, MODELS, SYSTEM } from '../nexus/fakes.js';

export interface LogStoresHarness {
  /** Each call returns a handle onto the SAME stored log (a new "server process" for PostgreSQL). */
  generic<T>(name: string): Promise<AppendOnlyStore<T>>;
  audit(): Promise<AppendOnlyStore<AuditEvent>>;
  registry(): Promise<AppendOnlyStore<RegistryEvent>>;
  champions(): Promise<AppendOnlyStore<ChampionEvent>>;
  memory(): Promise<AppendOnlyStore<MemoryRecordInput>>;
  evidence(): Promise<AppendOnlyStore<EvidenceRecord>>;
  cleanup(): Promise<void>;
}

const LATER = '2026-11-01T00:00:00.000Z';

export function logStoresContract(label: string, makeHarness: () => Promise<LogStoresHarness>): void {
  describe('Log store contract: ' + label, () => {
    let harness: LogStoresHarness | null = null;
    const open = async () => (harness = await makeHarness());
    afterEach(async () => {
      await harness?.cleanup();
      harness = null;
    });

    it('verlustfreier Roundtrip (bigint, Decimal, Unicode), Idempotenz und Konflikt', async () => {
      const h = await open();
      const clock = fixedClock();
      const log = await AppendOnlyLog.open<Record<string, unknown>>('contract-generic', await h.generic('contract-generic'), { clock: clock.now });
      const payload = { amountMinor: 9_223_372_036_854_775_807n, qty: Decimal.from('0.000000012345678901'), text: 'Zürich – 東京 – ✓', nested: [{ score: 0.7 }, null, { ok: true }] };
      expect((await log.append('r1', payload)).status).toBe('APPLIED');
      expect((await log.append('r1', payload)).status).toBe('ALREADY_APPLIED');
      await expect(log.append('r1', { ...payload, text: 'changed' })).rejects.toMatchObject({ code: 'idempotency_conflict' });

      const reopened = await AppendOnlyLog.open<Record<string, unknown>>('contract-generic', await h.generic('contract-generic'));
      expect(reopened.verifyIntegrity()).toEqual({ ok: true });
      const stored = reopened.get('r1')?.payload as typeof payload;
      expect(stored.amountMinor).toBe(9_223_372_036_854_775_807n);
      expect(stored.qty.eq(Decimal.from('0.000000012345678901'))).toBe(true);
      expect(stored.text).toBe('Zürich – 東京 – ✓');
      expect(stored.nested).toEqual([{ score: 0.7 }, null, { ok: true }]);
    });

    it('30 parallele Einträge über 3 Server → lückenlose, gültige Kette', async () => {
      const h = await open();
      const logs = await Promise.all([0, 1, 2].map(async () => AppendOnlyLog.open<{ n: number }>('contract-parallel', await h.generic('contract-parallel'))));
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => logs[i % 3]!.append('e' + i, { n: i })));
      expect(results.every((r) => r.status === 'APPLIED')).toBe(true);
      const fresh = await AppendOnlyLog.open<{ n: number }>('contract-parallel', await h.generic('contract-parallel'));
      expect(fresh.all().map((r) => r.sequence)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
      expect(fresh.verifyIntegrity()).toEqual({ ok: true });
    });

    it('Audit-Events bleiben vollständig und in Reihenfolge rekonstruierbar', async () => {
      const h = await open();
      const audit = await AuditLog.open(await h.audit());
      const base = { occurredAt: T0, decisionId: 'decision:x', taskId: 'task-x', actor: { kind: 'system' as const, id: 'nexus-brain' } };
      await audit.record({ ...base, eventId: 'decision:x:001', type: 'TASK_CREATED', payload: { question: 'q', capitalAtRisk: chf('12.34') } });
      await audit.record({ ...base, eventId: 'decision:x:002', type: 'RISK_DECISION', payload: { passed: false, reasons: ['no capital'] } });
      await audit.record({ ...base, eventId: 'decision:x:003', type: 'ORDER_INTENT', payload: { note: 'schema supports it; nothing emits it in this build' } });
      const reopened = await AuditLog.open(await h.audit());
      expect(reopened.byDecision('decision:x').map((e) => e.type)).toEqual(['TASK_CREATED', 'RISK_DECISION', 'ORDER_INTENT']);
      expect((reopened.get<{ capitalAtRisk: bigint }>('decision:x:001')?.payload.capitalAtRisk)).toBe(chf('12.34'));
      expect(reopened.verifyIntegrity()).toEqual({ ok: true });
    });

    it('Model Registry: Zustand wird aus Events rekonstruiert', async () => {
      const h = await open();
      const registry = await ModelRegistry.open(await h.registry(), { newId: sequentialIds('r1-') });
      await registry.registerActive(MODELS.openai, { at: T0, by: HUMAN, reason: 'initial council' });
      await registry.register(MODELS.google, { at: T0, by: SYSTEM, reason: 'new model' });
      await registry.recordSuccess('openai/test-gpt', { at: T0, latencyMs: 800, costMinor: chf('0.25') });
      await registry.recordFailure('openai/test-gpt', { at: T0, kind: 'timeout' });
      await registry.setDomainScores('openai/test-gpt', [{ domain: 'macro', sampleSize: 25, score: 0.61, updatedAt: T0 }], T0);
      await registry.setEnabled('google/test-gemini', false, { at: T0, by: SYSTEM, reason: 'safety stop' });

      const reopened = await ModelRegistry.open(await h.registry(), { newId: sequentialIds('r2-') });
      expect(reopened.list()).toEqual(registry.list());
      expect(reopened.health('openai/test-gpt')).toEqual(registry.health('openai/test-gpt'));
      expect(reopened.changes()).toEqual(registry.changes());
      expect(reopened.get('google/test-gemini')).toMatchObject({ shadowMode: true, enabled: false });
    });

    it('eine direkt geschriebene Aktivierung ohne Mensch/Benchmark gewährt keine Rechte (GOVERNANCE_INTEGRITY_ERROR)', async () => {
      const h = await open();
      const registry = await ModelRegistry.open(await h.registry(), { newId: sequentialIds('r-') });
      await registry.register(MODELS.google, { at: T0, by: SYSTEM, reason: 'new model' });
      // Attacker writes a consistent, hash-chained event directly into storage, bypassing the registry.
      const raw = await AppendOnlyLog.open<RegistryEvent>('model-registry', await h.registry());
      await raw.append('forged-1', { type: 'activated', eventId: 'forged-1', at: T0, modelKey: 'google/test-gemini', by: SYSTEM, reason: 'self-promotion', gate: { passed: true, reasons: [] } });
      await expect(ModelRegistry.open(await h.registry())).rejects.toMatchObject({ code: 'GOVERNANCE_INTEGRITY_ERROR' });
    });

    it('Champion-Wechsel werden beim Laden gegen gemessene Performance verifiziert; gefälschte werden abgelehnt', async () => {
      const h = await open();
      const memory = await NexusMemory.open(await h.memory());
      const performance = new ModelPerformance(memory);
      const registry = await ModelRegistry.open(await h.registry(), { newId: sequentialIds('r-') });
      await registry.registerActive(MODELS.openai, { at: T0, by: HUMAN, reason: 'council' });
      await registry.registerActive(MODELS.anthropic, { at: T0, by: HUMAN, reason: 'council' });
      for (let i = 0; i < 60; i++) {
        await performance.record('obs-' + i, { modelKey: 'anthropic/test-claude', domain: 'macro', subtask: 'macro_analysis', role: 'analyst', decisionId: 'd' + i, score: 0.8, shadow: false, occurredAt: T0, availableAt: '2026-10-15T00:00:00.000Z' });
      }
      const board = await ChampionBoard.open({ performance, initialChampions: { macro: 'openai/test-gpt' }, store: await h.champions(), newId: sequentialIds('c-') });
      await board.apply(board.evaluate('macro', registry, LATER), SYSTEM);
      const reopened = await ChampionBoard.open({ performance, initialChampions: { macro: 'openai/test-gpt' }, store: await h.champions() });
      expect(reopened.champion('macro')).toBe('anthropic/test-claude');

      // A forged promotion for a domain without any measurements is rejected on load.
      const raw = await AppendOnlyLog.open<ChampionEvent>('champions', await h.champions());
      await raw.append('forged-c', { type: 'promoted', eventId: 'forged-c', domain: 'crypto', from: null, to: 'openai/test-gpt', at: LATER, by: HUMAN, reason: 'db edit' });
      await expect(ChampionBoard.open({ performance, store: await h.champions() })).rejects.toMatchObject({ code: 'GOVERNANCE_INTEGRITY_ERROR' });
    });

    it('Evidence bleibt point-in-time und versioniert; geänderter Inhalt braucht eine neue ID', async () => {
      const h = await open();
      const evidence = await EvidenceStore.open(await h.evidence());
      await evidence.register(evidenceRef({ id: 'news-1', type: 'news', trusted: false, freshnessMs: undefined }), 'Original article text');
      await evidence.register(evidenceRef({ id: 'price-1' }));
      await expect(evidence.register(evidenceRef({ id: 'news-1', type: 'news', trusted: false, freshnessMs: undefined }), 'Silently edited text')).rejects.toMatchObject({ code: 'idempotency_conflict' });

      const reopened = await EvidenceStore.open(await h.evidence());
      expect(reopened.content('news-1', T0)).toBe('Original article text');
      expect(reopened.version('news-1')).toBe(evidence.version('news-1'));
      expect(reopened.assess('price-1', T0).status).toBe('fresh');
      expect(reopened.assess('price-1', '2026-10-01T07:00:00.000Z').status).toBe('not_yet_available');
      expect(reopened.get('news-1')?.contentKind).toBe('external_text');
    });
  });
}
