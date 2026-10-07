-- 002_append_only_logs: generic hash-chained, append-only logs (evidence, blackboard, memory, audit,
-- decisions, model governance). Same chain/lock/idempotency rules as the ledger. Payloads are JSONB
-- with lossless tags for bigint/Decimal; normalized projection tables (003) are written in the same
-- transaction for relational queries.

CREATE TABLE append_only_logs (
  log_name      TEXT PRIMARY KEY CHECK (log_name ~ '^[a-z][a-z0-9_.-]{0,62}$'),
  head_sequence BIGINT NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  head_hash     CHAR(64) NOT NULL DEFAULT repeat('0', 64) CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE append_only_records (
  log_name    TEXT NOT NULL REFERENCES append_only_logs (log_name),
  sequence    BIGINT NOT NULL CHECK (sequence > 0),
  record_id   TEXT NOT NULL CHECK (length(record_id) BETWEEN 1 AND 512),
  recorded_at TIMESTAMPTZ NOT NULL,
  payload     JSONB NOT NULL,
  prev_hash   CHAR(64) NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash        CHAR(64) NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (log_name, sequence),
  CONSTRAINT append_only_records_idempotency UNIQUE (log_name, record_id),
  CONSTRAINT append_only_records_no_fork UNIQUE (log_name, prev_hash)
);

CREATE FUNCTION nexus_log_check_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head_seq BIGINT;
  head_h   CHAR(64);
BEGIN
  SELECT head_sequence, head_hash INTO head_seq, head_h FROM append_only_logs WHERE log_name = NEW.log_name FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEXUS_LOG: unknown log %', NEW.log_name;
  END IF;
  IF NEW.sequence <> head_seq + 1 OR NEW.prev_hash <> head_h THEN
    RAISE EXCEPTION 'NEXUS_LOG: record % does not extend the head of log %', NEW.sequence, NEW.log_name;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER append_only_records_link BEFORE INSERT ON append_only_records FOR EACH ROW EXECUTE FUNCTION nexus_log_check_link();

CREATE FUNCTION nexus_log_advance_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE append_only_logs SET head_sequence = NEW.sequence, head_hash = NEW.hash WHERE log_name = NEW.log_name;
  RETURN NULL;
END $$;
CREATE TRIGGER append_only_records_advance_head AFTER INSERT ON append_only_records FOR EACH ROW EXECUTE FUNCTION nexus_log_advance_head();

CREATE FUNCTION nexus_logs_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.log_name <> OLD.log_name OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'NEXUS_LOG: log identity is immutable';
  END IF;
  IF NEW.head_sequence <> OLD.head_sequence + 1 OR NOT EXISTS (
    SELECT 1 FROM append_only_records r
    WHERE r.log_name = NEW.log_name AND r.sequence = NEW.head_sequence AND r.hash = NEW.head_hash AND r.prev_hash = OLD.head_hash
  ) THEN
    RAISE EXCEPTION 'NEXUS_LOG: the log head can only advance by one recorded entry';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER append_only_logs_guard_update BEFORE UPDATE ON append_only_logs FOR EACH ROW EXECUTE FUNCTION nexus_logs_guard_update();

CREATE TRIGGER append_only_records_immutable BEFORE UPDATE OR DELETE ON append_only_records FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER append_only_records_no_truncate BEFORE TRUNCATE ON append_only_records FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER append_only_logs_no_delete BEFORE DELETE ON append_only_logs FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER append_only_logs_no_truncate BEFORE TRUNCATE ON append_only_logs FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
