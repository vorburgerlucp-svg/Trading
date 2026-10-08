-- 003_domain_projections: normalized, queryable tables written in the SAME transaction as the
-- hash-chained log record they project (append_only_records). Every row references its source record
-- (log_name, record_id), so nothing exists here that is not in the verified history.
-- History projections are append-only; "current state" projections (models, scores, champions) are
-- derived caches that the application rebuilds from the event log and never trusts on their own.

-- Evidence metadata (point-in-time). Content is kept in the hash-chained payload; a changed external
-- document is a NEW evidence record (new id, new content_hash), never an update.
CREATE TABLE evidence (
  evidence_id  TEXT PRIMARY KEY,
  log_name     TEXT NOT NULL DEFAULT 'evidence' CHECK (log_name = 'evidence'),
  type         TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source <> ''),
  observed_at  TIMESTAMPTZ NOT NULL,
  available_at TIMESTAMPTZ NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL,
  freshness_ms BIGINT NULL CHECK (freshness_ms IS NULL OR freshness_ms > 0),
  expires_at   TIMESTAMPTZ NULL,
  trusted      BOOLEAN NOT NULL,
  content_kind TEXT NOT NULL CHECK (content_kind IN ('structured', 'external_text')),
  content_hash CHAR(64) NULL,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  record_hash  CHAR(64) NOT NULL,
  FOREIGN KEY (log_name, evidence_id) REFERENCES append_only_records (log_name, record_id),
  CHECK (available_at >= observed_at AND retrieved_at >= available_at),
  CHECK ((freshness_ms IS NULL) = (expires_at IS NULL))
);
CREATE INDEX evidence_available_at ON evidence (available_at);

-- Audit events (task → models → blackboard → critic → consensus → quant → risk → capital → approval → action → outcome).
CREATE TABLE audit_events (
  event_id     TEXT PRIMARY KEY,
  log_name     TEXT NOT NULL DEFAULT 'audit' CHECK (log_name = 'audit'),
  type         TEXT NOT NULL CHECK (type IN (
                 'TASK_CREATED', 'MODEL_SELECTED', 'MODEL_RESPONSE_RECEIVED', 'BLACKBOARD_ENTRY', 'CRITIC_STARTED',
                 'CONSENSUS_CREATED', 'QUANT_RESULT', 'RISK_DECISION', 'CAPITAL_PROPOSAL', 'HUMAN_APPROVAL',
                 'BROKER_SNAPSHOT', 'ORDER_INTENT', 'ORDER_EXECUTION', 'OUTCOME_RECORDED', 'DECISION_RECORDED')),
  occurred_at  TIMESTAMPTZ NOT NULL,
  decision_id  TEXT NULL,
  task_id      TEXT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('system', 'human', 'model', 'quant')),
  actor_id     TEXT NOT NULL,
  record_hash  CHAR(64) NOT NULL,
  FOREIGN KEY (log_name, event_id) REFERENCES append_only_records (log_name, record_id)
);
CREATE INDEX audit_events_decision ON audit_events (decision_id, occurred_at);
CREATE INDEX audit_events_type ON audit_events (type, occurred_at);

-- One row per model call. Confidence (uncalibrated score) is stored apart from a calibrated
-- probability, which may only exist together with a documented calibration method.
CREATE TABLE model_runs (
  run_id                 TEXT PRIMARY KEY REFERENCES audit_events (event_id),
  decision_id            TEXT NOT NULL,
  task_id                TEXT NOT NULL,
  step_id                TEXT NOT NULL,
  role                   TEXT NOT NULL CHECK (role IN ('analyst', 'counter_analyst', 'critic')),
  provider               TEXT NOT NULL,
  model                  TEXT NOT NULL,
  model_version          TEXT NULL,
  prompt_id              TEXT NOT NULL,
  prompt_version         TEXT NOT NULL,
  request_hash           CHAR(64) NOT NULL,
  response_hash          CHAR(64) NULL,
  status                 TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'timeout', 'invalid_output', 'not_connected')),
  error                  TEXT NULL,
  latency_ms             INTEGER NOT NULL CHECK (latency_ms >= 0),
  shadow                 BOOLEAN NOT NULL,
  fallback_for           TEXT NULL,
  confidence_score       NUMERIC NULL CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),
  calibrated_probability NUMERIC NULL CHECK (calibrated_probability IS NULL OR (calibrated_probability >= 0 AND calibrated_probability <= 1)),
  calibration_method     TEXT NULL,
  CHECK ((calibrated_probability IS NULL) = (calibration_method IS NULL))
);
CREATE INDEX model_runs_decision ON model_runs (decision_id);
CREATE INDEX model_runs_model ON model_runs (provider, model);

-- Slim, normalized decision record; details live in the referenced audit events.
CREATE TABLE decision_records (
  decision_id        TEXT PRIMARY KEY,
  log_name           TEXT NOT NULL DEFAULT 'decisions' CHECK (log_name = 'decisions'),
  task_id            TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL,
  as_of              TIMESTAMPTZ NOT NULL,
  input_fingerprint  CHAR(64) NOT NULL,
  quant_result_ref   TEXT NULL REFERENCES audit_events (event_id),
  consensus_ref      TEXT NULL REFERENCES audit_events (event_id),
  risk_decision_ref  TEXT NULL REFERENCES audit_events (event_id),
  capital_state_ref  TEXT NULL,
  human_approval_ref TEXT NULL REFERENCES audit_events (event_id),
  final_action       TEXT NOT NULL CHECK (final_action IN ('NO_ACTION', 'WATCH', 'RECOMMEND', 'REJECT')),
  reason_codes       TEXT[] NOT NULL,
  record_hash        CHAR(64) NOT NULL,
  FOREIGN KEY (log_name, decision_id) REFERENCES append_only_records (log_name, record_id)
);
CREATE INDEX decision_records_task ON decision_records (task_id);

CREATE TABLE decision_evidence (
  decision_id TEXT NOT NULL REFERENCES decision_records (decision_id),
  evidence_id TEXT NOT NULL REFERENCES evidence (evidence_id),
  PRIMARY KEY (decision_id, evidence_id)
);

CREATE TABLE decision_model_runs (
  decision_id TEXT NOT NULL REFERENCES decision_records (decision_id),
  run_id      TEXT NOT NULL REFERENCES model_runs (run_id),
  PRIMARY KEY (decision_id, run_id)
);

-- Memory metadata (content in the hash-chained payload).
CREATE TABLE memory_records (
  record_id    TEXT PRIMARY KEY,
  log_name     TEXT NOT NULL DEFAULT 'memory' CHECK (log_name = 'memory'),
  kind         TEXT NOT NULL CHECK (kind IN ('market', 'trade', 'business', 'strategy', 'model_performance', 'failure')),
  subject      TEXT NOT NULL,
  tags         TEXT[] NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL,
  available_at TIMESTAMPTZ NOT NULL,
  supersedes   TEXT NULL REFERENCES memory_records (record_id),
  source       TEXT NOT NULL,
  record_hash  CHAR(64) NOT NULL,
  FOREIGN KEY (log_name, record_id) REFERENCES append_only_records (log_name, record_id),
  CHECK (available_at >= occurred_at)
);
CREATE INDEX memory_records_lookup ON memory_records (kind, subject, available_at);

CREATE TABLE blackboard_entries (
  entry_id           TEXT PRIMARY KEY,
  log_name           TEXT NOT NULL DEFAULT 'blackboard' CHECK (log_name = 'blackboard'),
  task_id            TEXT NOT NULL,
  author_type        TEXT NOT NULL CHECK (author_type IN ('model', 'quant', 'system', 'human')),
  provider           TEXT NULL,
  model              TEXT NULL,
  role               TEXT NULL,
  step_id            TEXT NULL,
  shadow             BOOLEAN NOT NULL,
  requested_category TEXT NOT NULL,
  category           TEXT NOT NULL,
  evidence_status    TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL,
  record_hash        CHAR(64) NOT NULL,
  FOREIGN KEY (log_name, entry_id) REFERENCES append_only_records (log_name, record_id)
);
CREATE INDEX blackboard_entries_task ON blackboard_entries (task_id);

-- Model governance and telemetry events (source of truth = 'model-registry' log).
CREATE TABLE model_registry_events (
  event_id    TEXT PRIMARY KEY,
  log_name    TEXT NOT NULL DEFAULT 'model-registry' CHECK (log_name = 'model-registry'),
  event_type  TEXT NOT NULL,
  model_key   TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL,
  actor_kind  TEXT NULL,
  actor_id    TEXT NULL,
  record_hash CHAR(64) NOT NULL,
  FOREIGN KEY (log_name, event_id) REFERENCES append_only_records (log_name, record_id)
);
CREATE INDEX model_registry_events_model ON model_registry_events (model_key, at);

-- Derived current state (cache, rebuilt from events; editing it has no effect on NEXUS).
CREATE TABLE models (
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  enabled           BOOLEAN NOT NULL,
  shadow_mode       BOOLEAN NOT NULL,
  capabilities      TEXT[] NOT NULL,
  latency_ema_ms    DOUBLE PRECISION NULL,
  cost_ema_minor    BIGINT NULL,
  failure_rate      DOUBLE PRECISION NULL CHECK (failure_rate IS NULL OR (failure_rate >= 0 AND failure_rate <= 1)),
  last_evaluated_at TIMESTAMPTZ NULL,
  last_event_id     TEXT NOT NULL REFERENCES model_registry_events (event_id),
  PRIMARY KEY (provider, model)
);

CREATE TABLE model_domain_scores (
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  domain            TEXT NOT NULL,
  subtask           TEXT NOT NULL DEFAULT '',
  sample_size       INTEGER NOT NULL CHECK (sample_size >= 0),
  score             DOUBLE PRECISION NOT NULL CHECK (score >= 0 AND score <= 1),
  calibration_score DOUBLE PRECISION NULL,
  reliability_score DOUBLE PRECISION NULL,
  updated_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provider, model, domain, subtask),
  FOREIGN KEY (provider, model) REFERENCES models (provider, model)
);

-- Champion promotions (source of truth = 'champions' log; each one is re-verified against the
-- measured performance on load, so writing a row here cannot make a model champion).
CREATE TABLE champion_changes (
  event_id    TEXT PRIMARY KEY,
  log_name    TEXT NOT NULL DEFAULT 'champions' CHECK (log_name = 'champions'),
  domain      TEXT NOT NULL,
  from_model  TEXT NULL,
  to_model    TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL,
  -- Memory position the evaluation saw; verification counts only observations stored up to here.
  performance_position BIGINT NOT NULL CHECK (performance_position >= 0),
  actor_kind  TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  record_hash CHAR(64) NOT NULL,
  FOREIGN KEY (log_name, event_id) REFERENCES append_only_records (log_name, record_id)
);

-- Capital state snapshots: performance cache, never truth. Anchored to an exact ledger position.
CREATE TABLE ledger_snapshots (
  ledger_id   TEXT NOT NULL REFERENCES ledgers (ledger_id),
  sequence    BIGINT NOT NULL CHECK (sequence >= 0),
  ledger_hash CHAR(64) NOT NULL,
  taken_at    TIMESTAMPTZ NOT NULL,
  state       JSONB NOT NULL,
  state_hash  CHAR(64) NOT NULL,
  PRIMARY KEY (ledger_id, sequence, taken_at)
);

CREATE TRIGGER evidence_immutable BEFORE UPDATE OR DELETE ON evidence FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER model_runs_immutable BEFORE UPDATE OR DELETE ON model_runs FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER decision_records_immutable BEFORE UPDATE OR DELETE ON decision_records FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER decision_evidence_immutable BEFORE UPDATE OR DELETE ON decision_evidence FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER decision_model_runs_immutable BEFORE UPDATE OR DELETE ON decision_model_runs FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER memory_records_immutable BEFORE UPDATE OR DELETE ON memory_records FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER blackboard_entries_immutable BEFORE UPDATE OR DELETE ON blackboard_entries FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER model_registry_events_immutable BEFORE UPDATE OR DELETE ON model_registry_events FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER champion_changes_immutable BEFORE UPDATE OR DELETE ON champion_changes FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER ledger_snapshots_immutable BEFORE UPDATE OR DELETE ON ledger_snapshots FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
