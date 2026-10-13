-- 008_market_bar_provenance: revision knowledge for market bars (additive only; 001-007 are unchanged).
--
-- Before this migration a bar revision had one time, available_at: the provider's claim (the completion) for the first revision,
-- so a bar retrieved years later passed the same gate as one captured live (finding F9). Those rows keep every value. They have
-- no provenance (NULL, read as legacy_unproven) and nothing is backfilled or invented for them.
--
-- From now on each revision states how it is known:
--   captured_by_nexus             NEXUS held this revision from revision_known_at = retrieved_at
--   provider_published_at         the provider stated when this revision was published (never invented)
--   historical_bar_reconstruction a backfill: revision_known_at IS NULL, the vintage is not proven
-- available_at keeps its meaning: the historical replay gate (market observability plus the revision floor). It is not knowledge.
-- observed_at keeps its meaning: market observability (window completion for a final bar).
--
-- The first revision is NOT checked against retrieval: a historical first revision is legitimate. Its knowledge is checked against
-- its provenance instead (the constraints below). Revision 2 and later keep the floor: available_at >= revision_known_at (or
-- retrieved_at), and knowledge never moves backwards between proven revisions.

ALTER TABLE market_bars ADD COLUMN knowledge_provenance TEXT NULL;
ALTER TABLE market_bars ADD COLUMN revision_known_at TIMESTAMPTZ NULL;
ALTER TABLE market_bars ADD COLUMN provenance_hash CHAR(64) NULL;

ALTER TABLE market_bars ADD CONSTRAINT market_bars_knowledge_provenance_values CHECK (
  knowledge_provenance IS NULL OR knowledge_provenance IN ('captured_by_nexus', 'provider_published_at', 'historical_bar_reconstruction'));

-- A proven revision is known no later than its retrieval; a reconstruction has no knowledge time; NULL = legacy (no claim).
ALTER TABLE market_bars ADD CONSTRAINT market_bars_knowledge_shape CHECK (
  (knowledge_provenance IS NULL AND revision_known_at IS NULL)
  OR (knowledge_provenance IN ('captured_by_nexus', 'provider_published_at') AND revision_known_at IS NOT NULL AND revision_known_at <= retrieved_at)
  OR (knowledge_provenance = 'historical_bar_reconstruction' AND revision_known_at IS NULL));

-- NEXUS holds a captured revision exactly from its retrieval.
ALTER TABLE market_bars ADD CONSTRAINT market_bars_captured_is_retrieval CHECK (
  knowledge_provenance IS DISTINCT FROM 'captured_by_nexus' OR revision_known_at = retrieved_at);

-- A final bar cannot be known before it was complete.
ALTER TABLE market_bars ADD CONSTRAINT market_bars_knowledge_not_before_completion CHECK (
  NOT is_final OR revision_known_at IS NULL OR revision_known_at >= observed_at);

ALTER TABLE market_bars ADD CONSTRAINT market_bars_provenance_hash_format CHECK (
  provenance_hash IS NULL OR provenance_hash ~ '^[0-9a-f]{64}$');

-- The replay gate is never earlier than the market observation it derives from (existing rows already satisfy it).
ALTER TABLE market_bars ADD CONSTRAINT market_bars_available_not_before_observed CHECK (available_at >= observed_at) NOT VALID;

-- New rows only: every row written after this migration states its provenance and carries its provenance hash.
ALTER TABLE market_bars ADD CONSTRAINT market_bars_provenance_required CHECK (
  knowledge_provenance IS NOT NULL AND provenance_hash IS NOT NULL) NOT VALID;

CREATE OR REPLACE FUNCTION nexus_market_bar_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev RECORD;
BEGIN
  SELECT revision, is_final, available_at, revision_known_at INTO prev FROM market_bars
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
  END IF;
  RETURN NEW;
END $$;
