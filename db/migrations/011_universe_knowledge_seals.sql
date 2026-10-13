-- 011_universe_knowledge_seals: NEXUS's own timing proof for universe revisions (universe-timing:v1). Additive only: migrations 001-010 are
-- untouched, and so is the CHECK on evidence_seals.kind in 006 (universe revisions are sealed in their own table).
--
-- A universe revision's knownAt and retrievedAt are a source / ingest claim (migration 010). They are kept as provenance. NEXUS's knowledge
-- of a revision is this seal: the database clock read before the revision's commit (recorded_at, a lower bound on the commit time) and
-- after it (sealed_at, an upper bound). Decision-time knowledge needs sealed_at <= asOf. recorded_at alone proves nothing.
--
-- proof_kind:
--   COMMIT_SEAL          the bracket around the commit that stored the revision.
--   PRESENCE_ATTESTATION a later seal that found the revision already stored (a commit whose seal was never written, then a retry).
--                        It proves the revision existed by sealed_at. It never claims the original commit time.
--
-- Append-only: UPDATE, DELETE and TRUNCATE are rejected, as in 001. The seal must bind the stored revision it seals (result_hash).

CREATE TABLE universe_revision_seals (
  snapshot_revision_id TEXT PRIMARY KEY REFERENCES universe_snapshot_revisions (snapshot_revision_id),
  proof_kind           TEXT NOT NULL CHECK (proof_kind IN ('COMMIT_SEAL', 'PRESENCE_ATTESTATION')),
  result_hash          CHAR(64) NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  recorded_at          TIMESTAMPTZ NOT NULL,
  sealed_at            TIMESTAMPTZ NOT NULL,
  seal_hash            CHAR(64) NOT NULL CHECK (seal_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT universe_revision_seals_bounds CHECK (recorded_at <= sealed_at)
);

-- A seal can only bind the revision it names, in exactly the state it was stored in.
CREATE FUNCTION nexus_universe_seal_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stored_hash CHAR(64);
BEGIN
  SELECT result_hash INTO stored_hash FROM universe_snapshot_revisions WHERE snapshot_revision_id = NEW.snapshot_revision_id;
  IF stored_hash IS DISTINCT FROM NEW.result_hash THEN
    RAISE EXCEPTION 'NEXUS_UNIVERSE: seal of % does not match the stored revision', NEW.snapshot_revision_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER universe_revision_seals_match BEFORE INSERT ON universe_revision_seals
  FOR EACH ROW EXECUTE FUNCTION nexus_universe_seal_insert();

-- Append-only, as in 001.
CREATE TRIGGER universe_revision_seals_immutable BEFORE UPDATE OR DELETE ON universe_revision_seals FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER universe_revision_seals_no_truncate BEFORE TRUNCATE ON universe_revision_seals FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
