-- 009_market_bar_knowledge_v2: decision-time knowledge and market vintage of a bar revision, as two separate fields (additive only).
--
-- Migrations 001-008 are immutable. Migration 008 keeps its meaning: knowledge_provenance says how a revision is known,
-- revision_known_at when, provenance_hash protects those with the rule of its own release. Nothing here changes or drops them.
--
-- This migration adds the model with its two questions, each proven on its own:
--   knowledge_source_v2 + known_at_v2   decision-time knowledge: when NEXUS held exactly this revision.
--                                       captured_by_nexus: known_at_v2 = retrieved_at (also for a backfill, held from its retrieval).
--                                       provider_published_at: known_at_v2 = the provider's publication time, never after retrieved_at.
--   vintage_v2 + vintage_policy_v2      vintage: was it already the market's value at its observation time, under a versioned policy.
--                                       contemporaneous | historical_reconstruction. Policy bar-vintage:v1 classifies a final bar
--                                       by its capture window after its completion (intraday 15 minutes, daily 2 hours, boundary inclusive).
--                                       That window decides the vintage only. It never decides knowledge.
--   knowledge_vintage_hash              integrity of the V2 fields, verified on every read.
--
-- Rows written before this migration have NULL V2 fields. Nothing is backfilled or inferred for them: they are V2 unproven,
-- and decision-time replay refuses them. Rows written after it state both models: the 008 columns are the compatibility mirror
-- of the V2 values, written by the persistence layer.

ALTER TABLE market_bars ADD COLUMN knowledge_source_v2 TEXT NULL;
ALTER TABLE market_bars ADD COLUMN known_at_v2 TIMESTAMPTZ NULL;
ALTER TABLE market_bars ADD COLUMN vintage_v2 TEXT NULL;
ALTER TABLE market_bars ADD COLUMN vintage_policy_v2 TEXT NULL;
ALTER TABLE market_bars ADD COLUMN knowledge_vintage_hash CHAR(64) NULL;

-- The V2 fields are all present or all absent (a legacy row has none).
ALTER TABLE market_bars ADD CONSTRAINT market_bars_v2_complete CHECK (
  num_nonnulls(knowledge_source_v2, known_at_v2, vintage_v2, vintage_policy_v2, knowledge_vintage_hash) IN (0, 5));

ALTER TABLE market_bars ADD CONSTRAINT market_bars_knowledge_source_v2_values CHECK (
  knowledge_source_v2 IS NULL OR knowledge_source_v2 IN ('captured_by_nexus', 'provider_published_at'));

ALTER TABLE market_bars ADD CONSTRAINT market_bars_vintage_v2_values CHECK (
  vintage_v2 IS NULL OR vintage_v2 IN ('contemporaneous', 'historical_reconstruction'));

ALTER TABLE market_bars ADD CONSTRAINT market_bars_vintage_policy_v2_format CHECK (
  vintage_policy_v2 IS NULL OR vintage_policy_v2 ~ '^[a-z][a-z0-9-]*:v[0-9]+$');

ALTER TABLE market_bars ADD CONSTRAINT market_bars_knowledge_vintage_hash_format CHECK (
  knowledge_vintage_hash IS NULL OR knowledge_vintage_hash ~ '^[0-9a-f]{64}$');

-- Decision-time knowledge: a captured revision is known exactly at its retrieval; a provider publication no later than it.
ALTER TABLE market_bars ADD CONSTRAINT market_bars_known_at_v2_shape CHECK (
  knowledge_source_v2 IS NULL OR (known_at_v2 IS NOT NULL AND (
    (knowledge_source_v2 = 'captured_by_nexus' AND known_at_v2 = retrieved_at)
    OR (knowledge_source_v2 = 'provider_published_at' AND known_at_v2 <= retrieved_at))));

-- A final bar cannot be known before it was complete (strict, as in 008).
ALTER TABLE market_bars ADD CONSTRAINT market_bars_known_at_v2_not_before_completion CHECK (
  NOT is_final OR known_at_v2 IS NULL OR known_at_v2 >= observed_at);

-- Vintage under policy bar-vintage:v1. An in-progress bar is contemporaneous. A final bar is contemporaneous exactly when it was
-- retrieved no later than the window after its completion (observed_at); the boundary is inclusive.
ALTER TABLE market_bars ADD CONSTRAINT market_bars_vintage_v2_window CHECK (
  vintage_v2 IS NULL
  OR vintage_policy_v2 IS DISTINCT FROM 'bar-vintage:v1'
  OR (NOT is_final AND vintage_v2 = 'contemporaneous')
  OR (is_final AND (vintage_v2 = 'contemporaneous') = (retrieved_at - observed_at <= CASE WHEN bar_interval = '1d' THEN INTERVAL '2 hours' ELSE INTERVAL '15 minutes' END)));

-- The 008 columns are the compatibility mirror of the V2 knowledge: the persistence layer writes them, the database checks them.
-- A captured revision is 008 captured_by_nexus when contemporaneous, else a reconstruction; a provider publication stays provider_published_at.
ALTER TABLE market_bars ADD CONSTRAINT market_bars_v1_mirrors_v2 CHECK (
  knowledge_source_v2 IS NULL OR (
    knowledge_provenance IS NOT DISTINCT FROM (CASE WHEN knowledge_source_v2 = 'provider_published_at' THEN 'provider_published_at'
                                                   WHEN vintage_v2 = 'contemporaneous' THEN 'captured_by_nexus'
                                                   ELSE 'historical_bar_reconstruction' END)
    AND revision_known_at IS NOT DISTINCT FROM (CASE WHEN knowledge_source_v2 = 'provider_published_at' OR vintage_v2 = 'contemporaneous' THEN known_at_v2 END)));

-- New rows only: every row written after this migration states both models and carries its V2 hash.
ALTER TABLE market_bars ADD CONSTRAINT market_bars_v2_required CHECK (
  knowledge_source_v2 IS NOT NULL AND vintage_v2 IS NOT NULL AND knowledge_vintage_hash IS NOT NULL) NOT VALID;

-- Trigger rules of 008 are kept as they were. Added here, for the V2 fields:
--   a later revision cannot be known before the knowledge floor of the earlier one (its V2 knowledge; for a row without V2,
--   its retrieval: a V2 proof is never inferred from the 008 columns of an older row);
--   a revision is not visible before NEXUS knew it.
CREATE OR REPLACE FUNCTION nexus_market_bar_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev RECORD;
BEGIN
  SELECT revision, is_final, available_at, revision_known_at, known_at_v2, retrieved_at INTO prev FROM market_bars
   WHERE instrument_id = NEW.instrument_id AND source_id = NEW.source_id AND bar_interval = NEW.bar_interval
     AND session = NEW.session AND adjustment = NEW.adjustment AND start_time = NEW.start_time
   ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.revision <> 1 THEN RAISE EXCEPTION 'NEXUS_MARKET_DATA: first revision of a bar must be 1'; END IF;
  ELSE
    IF NEW.revision <> prev.revision + 1 THEN RAISE EXCEPTION 'NEXUS_MARKET_DATA: bar revision must be % (got %)', prev.revision + 1, NEW.revision; END IF;
    IF prev.is_final AND NOT NEW.is_final THEN RAISE EXCEPTION 'NEXUS_MARKET_DATA: a final bar cannot be replaced by an in-progress bar'; END IF;
    IF NEW.available_at < prev.available_at OR NEW.available_at < COALESCE(NEW.revision_known_at, NEW.retrieved_at) THEN
      RAISE EXCEPTION 'NEXUS_MARKET_DATA: a bar revision cannot become available before it was retrieved or known';
    END IF;
    IF NEW.revision_known_at IS NOT NULL AND prev.revision_known_at IS NOT NULL AND NEW.revision_known_at < prev.revision_known_at THEN
      RAISE EXCEPTION 'NEXUS_MARKET_DATA: a later revision cannot be known before an earlier revision';
    END IF;
    IF NEW.known_at_v2 IS NOT NULL AND NEW.known_at_v2 < COALESCE(prev.known_at_v2, prev.retrieved_at) THEN
      RAISE EXCEPTION 'NEXUS_MARKET_DATA: a later revision cannot be known before an earlier revision (knowledge moves forward only)';
    END IF;
    IF NEW.available_at < COALESCE(NEW.known_at_v2, NEW.retrieved_at) THEN
      RAISE EXCEPTION 'NEXUS_MARKET_DATA: a bar revision cannot become visible before NEXUS knew it';
    END IF;
  END IF;
  RETURN NEW;
END $$;
