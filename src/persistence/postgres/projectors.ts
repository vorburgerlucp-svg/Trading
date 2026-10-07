// Projectors: write normalized, queryable rows for a log record inside the same DB transaction.
// They only ever INSERT history rows; the "current state" tables (models, scores) are derived caches
// that are upserted and never read back by NEXUS as truth.

import type { ChampionEvent } from '../../ai/champion-challenger.js';
import type { RegistryEvent } from '../../ai/model-registry.js';
import type { AuditEvent } from '../../audit/audit-log.js';
import type { DecisionRecord } from '../../audit/decision-records.js';
import type { BlackboardEntry } from '../../blackboard/blackboard-types.js';
import type { EvidenceRecord } from '../../evidence/evidence-store.js';
import type { MemoryRecordInput } from '../../memory/memory-types.js';
import type { AttemptRecord } from '../../nexus/nexus-types.js';
import type { LogRecord } from '../append-only-log.js';
import { encodeJson } from '../json-codec.js';
import type { Projector } from './postgres-append-only-store.js';
import type { PgClient } from './pool.js';

export const evidenceProjector: Projector<EvidenceRecord> = async (client, record) => {
  const ref = record.payload.ref;
  const expiresAt = ref.freshnessMs === undefined ? null : new Date(Date.parse(ref.observedAt) + ref.freshnessMs).toISOString();
  await client.query(
    `INSERT INTO evidence (evidence_id, type, source, observed_at, available_at, retrieved_at, freshness_ms, expires_at, trusted, content_kind, content_hash, metadata, record_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
    [
      ref.id,
      ref.type,
      ref.source,
      ref.observedAt,
      ref.availableAt,
      ref.retrievedAt,
      ref.freshnessMs ?? null,
      expiresAt,
      ref.trusted,
      ref.contentKind,
      ref.contentHash ?? null,
      JSON.stringify(encodeJson(ref.metadata ?? {})),
      record.hash,
    ],
  );
};

export const blackboardProjector: Projector<BlackboardEntry> = async (client, record) => {
  const e = record.payload;
  await client.query(
    `INSERT INTO blackboard_entries (entry_id, task_id, author_type, provider, model, role, step_id, shadow, requested_category, category, evidence_status, created_at, record_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [e.id, e.taskId, e.author.type, e.author.provider ?? null, e.author.model ?? null, e.author.role ?? null, e.author.stepId ?? null, e.author.shadow ?? false, e.requestedCategory, e.category, e.evidenceStatus, e.createdAt, record.hash],
  );
};

export const memoryProjector: Projector<MemoryRecordInput> = async (client, record) => {
  const m = record.payload;
  await client.query(
    `INSERT INTO memory_records (record_id, kind, subject, tags, occurred_at, available_at, supersedes, source, record_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [m.id, m.kind, m.subject, m.tags, m.occurredAt, m.availableAt, m.supersedes ?? null, m.source, record.hash],
  );
};

export const auditProjector: Projector<AuditEvent> = async (client, record) => {
  const e = record.payload;
  await client.query(
    `INSERT INTO audit_events (event_id, type, occurred_at, decision_id, task_id, actor_kind, actor_id, record_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.eventId, e.type, e.occurredAt, e.decisionId ?? null, e.taskId ?? null, e.actor.kind, e.actor.id, record.hash],
  );
  if (e.type === 'MODEL_RESPONSE_RECEIVED') await insertModelRun(client, e as AuditEvent<AttemptRecord>);
};

async function insertModelRun(client: PgClient, event: AuditEvent<AttemptRecord>): Promise<void> {
  const run = event.payload;
  await client.query(
    `INSERT INTO model_runs (run_id, decision_id, task_id, step_id, role, provider, model, model_version, prompt_id, prompt_version, request_hash, response_hash,
                             status, error, latency_ms, shadow, fallback_for, confidence_score, calibrated_probability, calibration_method)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
    [
      event.eventId,
      event.decisionId ?? '',
      event.taskId ?? '',
      run.stepId,
      run.role,
      run.provider,
      run.model,
      run.modelVersion ?? null,
      run.promptId,
      run.promptVersion,
      run.requestHash,
      run.responseHash ?? null,
      run.status,
      run.error ?? null,
      Math.max(0, Math.round(run.latencyMs)),
      run.shadow,
      run.fallbackFor ?? null,
      run.confidenceScore ?? null,
      run.calibratedProbability ?? null,
      run.calibrationMethod ?? null,
    ],
  );
}

export const decisionProjector: Projector<DecisionRecord> = async (client, record) => {
  const d = record.payload;
  await client.query(
    `INSERT INTO decision_records (decision_id, task_id, created_at, as_of, input_fingerprint, quant_result_ref, consensus_ref, risk_decision_ref,
                                   capital_state_ref, human_approval_ref, final_action, reason_codes, record_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      d.decisionId,
      d.taskId,
      d.createdAt,
      d.asOf,
      d.inputFingerprint,
      d.quantResultRef ?? null,
      d.consensusRef ?? null,
      d.riskDecisionRef ?? null,
      d.capitalStateRef ?? null,
      d.humanApprovalRef ?? null,
      d.finalAction,
      d.reasonCodes,
      record.hash,
    ],
  );
  for (const evidenceId of new Set(d.evidenceRefs)) await client.query('INSERT INTO decision_evidence (decision_id, evidence_id) VALUES ($1, $2)', [d.decisionId, evidenceId]);
  for (const runId of new Set(d.modelRuns)) await client.query('INSERT INTO decision_model_runs (decision_id, run_id) VALUES ($1, $2)', [d.decisionId, runId]);
};

export const registryProjector: Projector<RegistryEvent> = async (client, record) => {
  const e = record.payload;
  const actor = 'by' in e ? e.by : null;
  await client.query(
    'INSERT INTO model_registry_events (event_id, event_type, model_key, at, actor_kind, actor_id, record_hash) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [e.eventId, e.type, e.modelKey, e.at, actor?.kind ?? null, actor?.id ?? null, record.hash],
  );
  await upsertModelCache(client, record);
};

/** Derived cache of the current model state (NEXUS rebuilds the real state from the events). */
async function upsertModelCache(client: PgClient, record: LogRecord<RegistryEvent>): Promise<void> {
  const e = record.payload;
  const [provider = '', ...rest] = e.modelKey.split('/');
  const model = rest.join('/');
  if (e.type === 'registered') {
    await client.query(
      `INSERT INTO models (provider, model, enabled, shadow_mode, capabilities, latency_ema_ms, cost_ema_minor, last_event_id)
       VALUES ($1, $2, true, $3, $4, $5, $6, $7)`,
      [provider, model, e.shadowMode, e.capabilities, e.latencyEmaMs ?? null, e.costEmaMinor?.toString() ?? null, e.eventId],
    );
    return;
  }
  const set: Record<string, unknown> = { last_event_id: e.eventId };
  if (e.type === 'activated') set.shadow_mode = false;
  if (e.type === 'returned_to_shadow') set.shadow_mode = true;
  if (e.type === 'enabled') set.enabled = true;
  if (e.type === 'disabled') set.enabled = false;
  if (e.type === 'scores_published') set.last_evaluated_at = e.at;
  const columns = Object.keys(set);
  await client.query(
    'UPDATE models SET ' + columns.map((c, i) => c + ' = $' + (i + 3)).join(', ') + ' WHERE provider = $1 AND model = $2',
    [provider, model, ...columns.map((c) => set[c])],
  );
  if (e.type === 'scores_published') {
    for (const s of e.scores) {
      await client.query(
        `INSERT INTO model_domain_scores (provider, model, domain, subtask, sample_size, score, calibration_score, reliability_score, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (provider, model, domain, subtask) DO UPDATE SET sample_size = EXCLUDED.sample_size, score = EXCLUDED.score,
           calibration_score = EXCLUDED.calibration_score, reliability_score = EXCLUDED.reliability_score, updated_at = EXCLUDED.updated_at`,
        [provider, model, s.domain, s.subtask ?? '', s.sampleSize, s.score, s.calibrationScore ?? null, s.reliabilityScore ?? null, s.updatedAt],
      );
    }
  }
}

export const championProjector: Projector<ChampionEvent> = async (client, record) => {
  const e = record.payload;
  await client.query(
    'INSERT INTO champion_changes (event_id, domain, from_model, to_model, at, actor_kind, actor_id, record_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [e.eventId, e.domain, e.from, e.to, e.at, e.by.kind, e.by.id, record.hash],
  );
};
