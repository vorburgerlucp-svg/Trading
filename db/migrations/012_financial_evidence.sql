-- 012_financial_evidence: immutable financial evidence records and NEXUS's database-clock knowledge seals (financial-knowledge-seal:v1). Additive only:
-- migrations 001-011 are untouched, and so is the CHECK on evidence_seals.kind in 006. Financial evidence is sealed in its own table.
--
-- proof_kind (the same semantics as 006 and 011):
--   COMMIT_SEAL          the bracket around the commit that stored the record: recorded_at is read before COMMIT (a lower bound on the commit time),
--                        sealed_at after it (an upper bound).
--   PRESENCE_ATTESTATION a later seal that found the record already stored (a crash between the commit and its seal). It proves existence by
--                        sealed_at, and never claims an earlier time.
-- Only a COMMIT_SEAL with recorded_at after asOf proves non-availability. A PRESENCE_ATTESTATION never does.
--
-- Append-only: UPDATE, DELETE and TRUNCATE are rejected on both tables, through nexus_reject_mutation() from 001.

CREATE TABLE financial_evidence (
  evidence_id           TEXT PRIMARY KEY CHECK (evidence_id ~ '^fe_[0-9a-f]{64}$'),
  schema_version        TEXT NOT NULL CHECK (schema_version = 'financial-evidence:v2'),
  connector_id          TEXT NOT NULL CHECK (connector_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  provider              TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  transport             TEXT NOT NULL CHECK (transport IN ('mcp', 'rest', 'internal')),
  capability            TEXT NOT NULL CHECK (capability IN ('fundamentals', 'news', 'portfolio_read')),
  instrument_id         TEXT,
  query_fingerprint     CHAR(64) NOT NULL CHECK (query_fingerprint ~ '^[0-9a-f]{64}$'),
  semantic_hash         CHAR(64) NOT NULL CHECK (semantic_hash ~ '^[0-9a-f]{64}$'),
  record_hash           CHAR(64) NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  effective_at          TIMESTAMPTZ,
  provider_published_at TIMESTAMPTZ,
  retrieved_at          TIMESTAMPTZ NOT NULL,
  nexus_received_at     TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL,
  record                JSONB NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  -- A NULL comparison passes a CHECK, so the presence of the id is stated explicitly.
  CONSTRAINT financial_evidence_record_id CHECK (record->>'evidenceId' IS NOT NULL AND record->>'evidenceId' = evidence_id)
);

-- Indexes for the research reads named in the design. Nothing speculative.
CREATE INDEX financial_evidence_instrument_id ON financial_evidence (instrument_id);
CREATE INDEX financial_evidence_capability ON financial_evidence (capability);
CREATE INDEX financial_evidence_connector_id ON financial_evidence (connector_id);
CREATE INDEX financial_evidence_provider_published_at ON financial_evidence (provider_published_at);
CREATE INDEX financial_evidence_effective_at ON financial_evidence (effective_at);

CREATE TABLE financial_evidence_seals (
  evidence_id TEXT PRIMARY KEY REFERENCES financial_evidence (evidence_id),
  proof_kind  TEXT NOT NULL CHECK (proof_kind IN ('COMMIT_SEAL', 'PRESENCE_ATTESTATION')),
  record_hash CHAR(64) NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL,
  sealed_at   TIMESTAMPTZ NOT NULL,
  seal_hash   CHAR(64) NOT NULL CHECK (seal_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT financial_evidence_seals_bounds CHECK (recorded_at <= sealed_at)
);

-- The strict point-in-time read orders and filters on sealed_at.
CREATE INDEX financial_evidence_seals_sealed_at ON financial_evidence_seals (sealed_at);

-- A seal can only bind the record it names, in exactly the state it was stored in.
CREATE FUNCTION nexus_financial_seal_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stored_hash CHAR(64);
BEGIN
  SELECT record_hash INTO stored_hash FROM financial_evidence WHERE evidence_id = NEW.evidence_id;
  IF stored_hash IS DISTINCT FROM NEW.record_hash THEN
    RAISE EXCEPTION 'NEXUS_FINANCIAL: seal of % does not match the stored record', NEW.evidence_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER financial_evidence_seals_match BEFORE INSERT ON financial_evidence_seals
  FOR EACH ROW EXECUTE FUNCTION nexus_financial_seal_insert();

-- Append-only, as in 001.
CREATE TRIGGER financial_evidence_immutable BEFORE UPDATE OR DELETE ON financial_evidence FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER financial_evidence_no_truncate BEFORE TRUNCATE ON financial_evidence FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER financial_evidence_seals_immutable BEFORE UPDATE OR DELETE ON financial_evidence_seals FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER financial_evidence_seals_no_truncate BEFORE TRUNCATE ON financial_evidence_seals FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
