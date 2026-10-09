-- 008_market_bar_provenance: decision-time knowledge and market vintage of market bars (001-007 are unchanged).
--
-- Two independent questions per bar revision (docs/BAR_KNOWLEDGE_EVIDENCE.md):
--   known_at / knowledge_source  did NEXUS hold exactly this revision at a decision time?
--                                captured_by_nexus: known_at = retrieved_at (also for a backfill: NEXUS holds the response from then)
--                                provider_published_at: known_at = the provider's publish time, at or before retrieved_at
--   vintage / vintage_policy     was this revision already the market's value at its observation time? (versioned policy)
--
-- NULL knowledge_source = a row stored before this model (legacy). Nothing is backfilled or invented for such rows; they are read as
-- legacy_unproven. observed_at keeps its meaning (market observability), available_at its meaning (the historical market gate).
--
-- This migration was first written as a different model and is rewritten in place: it was never applied outside the test databases,
-- which are rebuilt on every run. The migrator refuses DROP, so the earlier constraints could not be removed by a later migration.
-- Any database that applied an earlier version of this file fails the checksum verification and must be recreated.

ALTER TABLE market_bars ADD COLUMN knowledge_source TEXT NULL;
ALTER TABLE market_bars ADD COLUMN known_at TIMESTAMPTZ NULL;
ALTER TABLE market_bars ADD COLUMN vintage TEXT NULL;
ALTER TABLE market_bars ADD COLUMN vintage_policy TEXT NULL;
ALTER TABLE market_bars ADD COLUMN provenance_hash CHAR(64) NULL;

ALTER TABLE market_bars ADD CONSTRAINT market_bars_knowledge_source_values CHECK (
  knowledge_source IS NULL OR knowledge_source IN ('captured_by_nexus', 'provider_published_at'));

ALTER TABLE market_bars ADD CONSTRAINT market_bars_vintage_values CHECK (
  vintage IS NULL OR vintage IN ('contemporaneous', 'historical_reconstruction'));

-- The two questions are kept apart: a known source needs a known time, a vintage and the policy that classified it; legacy has none
-- of these. A known time is never later than the retrieval that delivered it.
ALTER TABLE market_bars ADD CONSTRAINT market_bars_knowledge_shape CHECK (
  (knowledge_source IS NULL AND known_at IS NULL AND vintage IS NULL AND vintage_policy IS NULL)
  OR (knowledge_source IN ('captured_by_nexus', 'provider_published_at') AND known_at IS NOT NULL AND known_at <= retrieved_at
      AND vintage IS NOT NULL AND vintage_policy IS NOT NULL));

-- NEXUS holds a captured response exactly from its retrieval.
ALTER TABLE market_bars ADD CONSTRAINT market_bars_captured_is_retrieval CHECK (
  knowledge_source IS DISTINCT FROM 'captured_by_nexus' OR known_at = retrieved_at);

-- Nothing can be known before a final bar was complete, beyond the 5 minutes of retrieval clock skew the application tolerates (CLOCK_SKEW_MS).
ALTER TABLE market_bars ADD CONSTRAINT market_bars_knowledge_not_before_completion CHECK (
  NOT is_final OR known_at IS NULL OR known_at + INTERVAL '5 minutes' >= observed_at);

ALTER TABLE market_bars ADD CONSTRAINT market_bars_provenance_hash_format CHECK (
  provenance_hash IS NULL OR provenance_hash ~ '^[0-9a-f]{64}$');

-- The market gate is never earlier than the observation it derives from (existing rows already satisfy it).
ALTER TABLE market_bars ADD CONSTRAINT market_bars_available_not_before_observed CHECK (available_at >= observed_at) NOT VALID;

-- New rows only: every row written after this migration states both questions and carries its provenance hash.
ALTER TABLE market_bars ADD CONSTRAINT market_bars_provenance_required CHECK (
  knowledge_source IS NOT NULL AND vintage IS NOT NULL AND provenance_hash IS NOT NULL) NOT VALID;

CREATE OR REPLACE FUNCTION nexus_market_bar_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev RECORD;
BEGIN
  SELECT revision, is_final, available_at, known_at INTO prev FROM market_bars
   WHERE instrument_id = NEW.instrument_id AND source_id = NEW.source_id AND bar_interval = NEW.bar_interval
     AND session = NEW.session AND adjustment = NEW.adjustment AND start_time = NEW.start_time
   ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.revision <> 1 THEN RAISE EXCEPTION 'NEXUS_MARKET_DATA: first revision of a bar must be 1'; END IF;
  ELSE
    IF NEW.revision <> prev.revision + 1 THEN RAISE EXCEPTION 'NEXUS_MARKET_DATA: bar revision must be % (got %)', prev.revision + 1, NEW.revision; END IF;
    IF prev.is_final AND NOT NEW.is_final THEN RAISE EXCEPTION 'NEXUS_MARKET_DATA: a final bar cannot be replaced by an in-progress bar'; END IF;
    -- A later revision enters the market gate only once NEXUS held it (or, for legacy rows, once it was retrieved).
    IF NEW.available_at < prev.available_at OR NEW.available_at < COALESCE(NEW.known_at, NEW.retrieved_at) THEN
      RAISE EXCEPTION 'NEXUS_MARKET_DATA: a bar revision cannot become available before it was retrieved or known';
    END IF;
    IF NEW.known_at IS NOT NULL AND prev.known_at IS NOT NULL AND NEW.known_at < prev.known_at THEN
      RAISE EXCEPTION 'NEXUS_MARKET_DATA: a later revision cannot be known before an earlier revision';
    END IF;
  END IF;
  RETURN NEW;
END $$;
