-- 007_corporate_action_provenance: knowledge provenance for corporate actions (additive only; 004 is unchanged).
--
-- Before this migration, a corporate action's visibility time (available_at) was a provider claim, min(retrievedAt, exDate).
-- Those rows keep their values. They have no provenance (NULL): their knowledge is unproven, and nothing is inferred for them.
-- Rows written from now on must state their provenance and carry a provenance hash. NOT VALID: existing rows are not re-checked.
--
-- Trigger correction: 004's revision trigger checked available_at >= retrieved_at only for revisions >= 2, although its
-- comment says no revision is ever visible before retrieval. This migration replaces the function body, so the first revision
-- is checked too. The trigger itself is unchanged (the function is looked up by name).

ALTER TABLE corporate_actions ADD COLUMN knowledge_provenance TEXT NULL;
ALTER TABLE corporate_actions ADD COLUMN knowledge_at TIMESTAMPTZ NULL;
ALTER TABLE corporate_actions ADD COLUMN provenance_hash CHAR(64) NULL;

ALTER TABLE corporate_actions ADD CONSTRAINT corporate_actions_knowledge_provenance_values CHECK (
  knowledge_provenance IS NULL OR knowledge_provenance IN ('provider_published_at', 'provider_announced_at', 'captured_by_nexus', 'historical_effective_date_inference'));

-- A proven knowledge time is never later than the retrieval that delivered it. An inferred record has no knowledge time.
ALTER TABLE corporate_actions ADD CONSTRAINT corporate_actions_knowledge_shape CHECK (
  (knowledge_provenance IS NULL AND knowledge_at IS NULL)
  OR (knowledge_provenance IN ('provider_published_at', 'provider_announced_at', 'captured_by_nexus') AND knowledge_at IS NOT NULL AND knowledge_at <= retrieved_at)
  OR (knowledge_provenance = 'historical_effective_date_inference' AND knowledge_at IS NULL));

-- NEXUS knows a record it captured exactly at its retrieval.
ALTER TABLE corporate_actions ADD CONSTRAINT corporate_actions_captured_is_retrieval CHECK (
  knowledge_provenance IS DISTINCT FROM 'captured_by_nexus' OR knowledge_at = retrieved_at);

ALTER TABLE corporate_actions ADD CONSTRAINT corporate_actions_provenance_hash_format CHECK (
  provenance_hash IS NULL OR provenance_hash ~ '^[0-9a-f]{64}$');

-- New rows only: every row written after this migration states its provenance and carries its provenance hash.
ALTER TABLE corporate_actions ADD CONSTRAINT corporate_actions_provenance_required CHECK (
  knowledge_provenance IS NOT NULL AND provenance_hash IS NOT NULL) NOT VALID;

CREATE OR REPLACE FUNCTION nexus_corporate_action_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev RECORD;
BEGIN
  IF NEW.available_at < NEW.retrieved_at THEN
    RAISE EXCEPTION 'NEXUS_MARKET_DATA: a corporate action revision cannot be available before it was retrieved';
  END IF;
  SELECT revision, available_at INTO prev FROM corporate_actions
   WHERE instrument_id = NEW.instrument_id AND source_id = NEW.source_id AND action_key = NEW.action_key
   ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.revision <> 1 THEN RAISE EXCEPTION 'NEXUS_MARKET_DATA: first revision of a corporate action must be 1'; END IF;
  ELSIF NEW.revision <> prev.revision + 1 OR NEW.available_at < prev.available_at THEN
    RAISE EXCEPTION 'NEXUS_MARKET_DATA: invalid corporate action revision';
  END IF;
  RETURN NEW;
END $$;
