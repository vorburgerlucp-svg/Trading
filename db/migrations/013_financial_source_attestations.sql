-- 013_financial_source_attestations: immutable official-source attestations of financial evidence (financial-source-attestation:v1, policy
-- sec-filing-date-next-ny-day:v1, docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md). Additive only: migrations 001-012 are untouched, and no existing table
-- is altered. An attestation is a sidecar to a stored financial_evidence record. It never changes that record, and it never changes its DB seal.
--
-- Two different facts are stored in two different places:
--   financial_evidence_seals      when NEXUS durably held the record (the database clock, migration 012).
--   financial_source_attestations what an official SEC filing supports about the historical existence of the filing (this migration).
-- attested_at is when NEXUS created the attestation, read from the database clock by the trigger below. It is not historical source availability, and it is
-- never backdated.
--
-- Append-only: UPDATE, DELETE and TRUNCATE are rejected through nexus_reject_mutation() from 001, as in 011 and 012.

CREATE TABLE financial_source_attestations (
  attestation_id       TEXT PRIMARY KEY CHECK (attestation_id ~ '^fsa_[0-9a-f]{64}$'),
  evidence_id          TEXT NOT NULL REFERENCES financial_evidence (evidence_id),
  evidence_record_hash CHAR(64) NOT NULL CHECK (evidence_record_hash ~ '^[0-9a-f]{64}$'),
  provider             TEXT NOT NULL CHECK (provider = 'sec-edgar'),
  connector_id         TEXT NOT NULL CHECK (connector_id = 'sec-edgar-fundamentals-rest'),
  capability           TEXT NOT NULL CHECK (capability = 'fundamentals'),
  instrument_id        TEXT NOT NULL CHECK (length(instrument_id) BETWEEN 1 AND 128),
  cik                  CHAR(10) NOT NULL CHECK (cik ~ '^[0-9]{10}$'),
  source_id            TEXT NOT NULL CHECK (source_id ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  source_form          TEXT NOT NULL CHECK (source_form IN ('10-Q', '10-K')),
  source_filing_date   DATE NOT NULL,
  source_artifact_hash CHAR(64) NOT NULL CHECK (source_artifact_hash ~ '^[0-9a-f]{64}$'),
  selected_facts_hash  CHAR(64) NOT NULL CHECK (selected_facts_hash ~ '^[0-9a-f]{64}$'),
  policy_version       TEXT NOT NULL CHECK (policy_version = 'sec-filing-date-next-ny-day:v1'),
  record_hash          CHAR(64) NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  attested_at          TIMESTAMPTZ NOT NULL,
  record               JSONB NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  -- A NULL comparison passes a CHECK, so the presence of the identifier is stated explicitly.
  CONSTRAINT financial_source_attestations_record_id CHECK (record->>'attestationId' IS NOT NULL AND record->>'attestationId' = attestation_id)
);

-- The reads named in the design: by evidence, by instrument, and by the official filing date that the research policy bounds.
CREATE INDEX financial_source_attestations_evidence_id ON financial_source_attestations (evidence_id);
CREATE INDEX financial_source_attestations_instrument_id ON financial_source_attestations (instrument_id);
CREATE INDEX financial_source_attestations_source_filing_date ON financial_source_attestations (source_filing_date);

-- The creation time comes from the database clock, and nothing else can supply it. A caller can neither set nor backdate it.
CREATE FUNCTION nexus_source_attestation_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.attested_at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER financial_source_attestations_clock BEFORE INSERT ON financial_source_attestations
  FOR EACH ROW EXECUTE FUNCTION nexus_source_attestation_clock();

-- An attestation can only bind the stored evidence record it names, in exactly the state it was stored in. Its indexed columns must also equal the fields of
-- its own record, so the two can never disagree.
CREATE FUNCTION nexus_source_attestation_bind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stored_hash CHAR(64);
BEGIN
  SELECT record_hash INTO stored_hash FROM financial_evidence WHERE evidence_id = NEW.evidence_id;
  IF stored_hash IS DISTINCT FROM NEW.evidence_record_hash THEN
    RAISE EXCEPTION 'NEXUS_FINANCIAL_SOURCE: attestation of % does not bind the stored evidence record', NEW.evidence_id;
  END IF;
  IF NEW.record->>'evidenceId' IS DISTINCT FROM NEW.evidence_id
     OR NEW.record->>'evidenceRecordHash' IS DISTINCT FROM NEW.evidence_record_hash
     OR NEW.record->>'provider' IS DISTINCT FROM NEW.provider
     OR NEW.record->>'connectorId' IS DISTINCT FROM NEW.connector_id
     OR NEW.record->>'capability' IS DISTINCT FROM NEW.capability
     OR NEW.record->>'instrumentId' IS DISTINCT FROM NEW.instrument_id
     OR NEW.record->>'cik' IS DISTINCT FROM NEW.cik
     OR NEW.record->>'sourceId' IS DISTINCT FROM NEW.source_id
     OR NEW.record->>'sourceForm' IS DISTINCT FROM NEW.source_form
     OR NEW.record->>'sourceFilingDate' IS DISTINCT FROM NEW.source_filing_date::text
     OR NEW.record->>'sourceArtifactHash' IS DISTINCT FROM NEW.source_artifact_hash
     OR NEW.record->>'selectedFactsHash' IS DISTINCT FROM NEW.selected_facts_hash
     OR NEW.record->>'policyVersion' IS DISTINCT FROM NEW.policy_version THEN
    RAISE EXCEPTION 'NEXUS_FINANCIAL_SOURCE: the indexed columns of % do not match its record', NEW.attestation_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER financial_source_attestations_bind BEFORE INSERT ON financial_source_attestations
  FOR EACH ROW EXECUTE FUNCTION nexus_source_attestation_bind();

-- Append-only, as in 001, 011 and 012.
CREATE TRIGGER financial_source_attestations_immutable BEFORE UPDATE OR DELETE ON financial_source_attestations FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER financial_source_attestations_no_truncate BEFORE TRUNCATE ON financial_source_attestations FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
