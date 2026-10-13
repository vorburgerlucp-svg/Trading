-- 006_evidence_seals: commit-time seals for scanner, backtest and quant runs (additive only).
--
-- A seal binds a stored run to two database clock readings:
--   recorded_at  read BEFORE the run's transaction commits  -> lower bound on the commit time
--   sealed_at    read AFTER the commit, in its own statement -> upper bound on the commit time
-- Availability at asOf is proven only by sealed_at <= asOf. recorded_at > asOf proves non-availability.
-- Runs stored before this migration have no seal. They are not treated as time-proven (no backfill: a
-- backfilled time would be an invented timestamp).
-- seal_hash binds kind, record, result hash and both times. Immutability triggers reject UPDATE, DELETE and TRUNCATE.

CREATE TABLE evidence_seals (
  kind         TEXT NOT NULL CHECK (kind IN ('scanner_run', 'backtest_run', 'quant_run')),
  record_id    TEXT NOT NULL,
  result_hash  CHAR(64) NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  recorded_at  TIMESTAMPTZ NOT NULL,
  sealed_at    TIMESTAMPTZ NOT NULL,
  seal_hash    CHAR(64) NOT NULL CHECK (seal_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (kind, record_id),
  CONSTRAINT evidence_seals_order CHECK (recorded_at <= sealed_at)
);

CREATE TRIGGER evidence_seals_immutable BEFORE UPDATE OR DELETE ON evidence_seals FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER evidence_seals_no_truncate BEFORE TRUNCATE ON evidence_seals FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
