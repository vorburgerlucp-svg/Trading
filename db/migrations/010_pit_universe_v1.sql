-- 010_pit_universe_v1: the persistent Point-in-Time Universe (universe-engine:v1). Additive only: migrations 001-009 are untouched.
--
-- A universe revision is an immutable, complete constituent snapshot (or an explicitly PARTIAL one). Two axes are kept apart:
--   effective_at   when the constituent set is in force (economic time);
--   known_at       when NEXUS could know exactly this revision (knowledge time). Captured data is known exactly at retrieved_at.
-- vintage: contemporaneous iff known_at <= effective_at (policy universe-vintage:v1). Otherwise a historical reconstruction.
--
-- Tables. All are append-only: UPDATE, DELETE and TRUNCATE are rejected by triggers, as in 001.
--   universe_sources             the source registry: provider, environment (production / demo / test_fixture), license class.
--   universe_definitions         a universe identity and its definition version.
--   universe_snapshot_revisions  one immutable revision per (snapshot_key, revision). result is the canonical payload, result_hash its hash.
--                                The identities (snapshot_key, content_hash, provenance_hash, snapshot_revision_id) are recomputed and
--                                verified by the application on every read: a SQL check cannot reproduce the canonical JSON hash.
--   universe_snapshot_members    the instruments of a revision: NEXUS instrument ids, resolved at ingest, never tickers.
--   universe_unresolved_members  source members with no NEXUS instrument. Only a PARTIAL revision may hold any.
--
-- Database-enforced rules, the same rules the in-memory store applies, so the two stores behave identically:
--   a revision is the next revision of its snapshot key; a revision is never learned before the one it follows;
--   ingest_seq is the next sequence number; the member count matches the member rows at commit; unresolved members only in PARTIAL.

CREATE TABLE universe_sources (
  source_id    TEXT PRIMARY KEY CHECK (btrim(source_id) <> '' AND length(source_id) <= 128),
  provider     TEXT NOT NULL CHECK (btrim(provider) <> '' AND length(provider) <= 64),
  dataset      TEXT NOT NULL CHECK (btrim(dataset) <> '' AND length(dataset) <= 64),
  environment  TEXT NOT NULL CHECK (environment IN ('production', 'demo', 'test_fixture')),
  license      TEXT NOT NULL CHECK (license IN ('internal_use', 'display_allowed', 'redistributable', 'not_redistributable', 'unreviewed')),
  license_note TEXT NULL CHECK (license_note IS NULL OR (btrim(license_note) <> '' AND length(license_note) <= 500)),
  source_hash  CHAR(64) NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE universe_definitions (
  universe_id        TEXT PRIMARY KEY CHECK (btrim(universe_id) <> '' AND length(universe_id) <= 128),
  definition_version TEXT NOT NULL CHECK (btrim(definition_version) <> '' AND length(definition_version) <= 64),
  name               TEXT NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200),
  definition_hash    CHAR(64) NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE universe_snapshot_revisions (
  snapshot_revision_id TEXT PRIMARY KEY CHECK (snapshot_revision_id ~ '^urev_[0-9a-f]{40}$'),
  snapshot_key         TEXT NOT NULL CHECK (snapshot_key ~ '^uk_[0-9a-f]{40}$'),
  universe_id          TEXT NOT NULL REFERENCES universe_definitions (universe_id),
  definition_version   TEXT NOT NULL CHECK (btrim(definition_version) <> ''),
  source_id            TEXT NOT NULL REFERENCES universe_sources (source_id),
  effective_at         TIMESTAMPTZ NOT NULL,
  retrieved_at         TIMESTAMPTZ NOT NULL,
  knowledge_source     TEXT NOT NULL CHECK (knowledge_source IN ('captured_by_nexus', 'provider_published_at')),
  known_at             TIMESTAMPTZ NOT NULL,
  vintage              TEXT NOT NULL CHECK (vintage IN ('contemporaneous', 'historical_reconstruction')),
  vintage_policy       TEXT NOT NULL CHECK (vintage_policy = 'universe-vintage:v1'),
  completeness         TEXT NOT NULL CHECK (completeness IN ('COMPLETE', 'PARTIAL')),
  revision             INTEGER NOT NULL CHECK (revision >= 1),
  content_hash         CHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  provenance_hash      CHAR(64) NOT NULL CHECK (provenance_hash ~ '^[0-9a-f]{64}$'),
  ingest_seq           INTEGER NOT NULL UNIQUE CHECK (ingest_seq >= 1),
  member_count         INTEGER NOT NULL CHECK (member_count >= 0),
  result               JSONB NOT NULL,
  result_hash          CHAR(64) NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (snapshot_key, revision),
  UNIQUE (snapshot_key, content_hash),
  -- Knowledge shape: captured data is known exactly at its retrieval; a provider publication no later than it.
  CONSTRAINT universe_revisions_knowledge_shape CHECK (
    (knowledge_source = 'captured_by_nexus' AND known_at = retrieved_at)
    OR (knowledge_source = 'provider_published_at' AND known_at <= retrieved_at)),
  -- Vintage under universe-vintage:v1: contemporaneous iff NEXUS held the revision no later than its effective instant.
  CONSTRAINT universe_revisions_vintage_shape CHECK (
    vintage = (CASE WHEN known_at <= effective_at THEN 'contemporaneous' ELSE 'historical_reconstruction' END))
);

CREATE TABLE universe_snapshot_members (
  snapshot_revision_id   TEXT NOT NULL REFERENCES universe_snapshot_revisions (snapshot_revision_id),
  instrument_id          TEXT NOT NULL CHECK (btrim(instrument_id) <> '' AND length(instrument_id) <= 128),
  source_member_key      TEXT NOT NULL CHECK (btrim(source_member_key) <> '' AND length(source_member_key) <= 200),
  provider_symbol        TEXT NOT NULL CHECK (btrim(provider_symbol) <> '' AND length(provider_symbol) <= 64),
  provider_instrument_id TEXT NULL,
  PRIMARY KEY (snapshot_revision_id, instrument_id),
  UNIQUE (snapshot_revision_id, source_member_key)
);

CREATE TABLE universe_unresolved_members (
  snapshot_revision_id   TEXT NOT NULL REFERENCES universe_snapshot_revisions (snapshot_revision_id),
  source_member_key      TEXT NOT NULL CHECK (btrim(source_member_key) <> '' AND length(source_member_key) <= 200),
  provider_symbol        TEXT NOT NULL CHECK (btrim(provider_symbol) <> '' AND length(provider_symbol) <= 64),
  provider_instrument_id TEXT NULL,
  exchange               TEXT NULL,
  PRIMARY KEY (snapshot_revision_id, source_member_key)
);

-- Revision order, knowledge order and the ingest sequence, decided by the database for every new revision.
CREATE FUNCTION nexus_universe_revision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev_revision INTEGER;
  prev_known_at TIMESTAMPTZ;
  prev_seq INTEGER;
BEGIN
  SELECT revision, known_at INTO prev_revision, prev_known_at
    FROM universe_snapshot_revisions WHERE snapshot_key = NEW.snapshot_key ORDER BY revision DESC LIMIT 1;
  IF COALESCE(prev_revision, 0) + 1 <> NEW.revision THEN
    RAISE EXCEPTION 'NEXUS_UNIVERSE: revision % of % must be revision % (the next one)', NEW.revision, NEW.snapshot_key, COALESCE(prev_revision, 0) + 1;
  END IF;
  IF prev_known_at IS NOT NULL AND NEW.known_at < prev_known_at THEN
    RAISE EXCEPTION 'NEXUS_UNIVERSE: knowledge regression in % (a revision cannot be learned before the revision it follows)', NEW.snapshot_key;
  END IF;
  SELECT COALESCE(MAX(ingest_seq), 0) INTO prev_seq FROM universe_snapshot_revisions;
  IF NEW.ingest_seq <> prev_seq + 1 THEN
    RAISE EXCEPTION 'NEXUS_UNIVERSE: ingest sequence must be % (got %)', prev_seq + 1, NEW.ingest_seq;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER universe_snapshot_revisions_sequence BEFORE INSERT ON universe_snapshot_revisions
  FOR EACH ROW EXECUTE FUNCTION nexus_universe_revision_insert();

-- The member rows of a revision are written in the same transaction; the count is checked when that transaction commits.
CREATE FUNCTION nexus_universe_revision_members() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stored INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO stored FROM universe_snapshot_members WHERE snapshot_revision_id = NEW.snapshot_revision_id;
  IF stored <> NEW.member_count THEN
    RAISE EXCEPTION 'NEXUS_UNIVERSE: revision % states % members but stores %', NEW.snapshot_revision_id, NEW.member_count, stored;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER universe_snapshot_revisions_members AFTER INSERT ON universe_snapshot_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nexus_universe_revision_members();

-- Unresolved members are stored only for a PARTIAL revision. A COMPLETE snapshot with a gap is refused, never stored with the gap hidden.
CREATE FUNCTION nexus_universe_unresolved_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT completeness FROM universe_snapshot_revisions WHERE snapshot_revision_id = NEW.snapshot_revision_id) IS DISTINCT FROM 'PARTIAL' THEN
    RAISE EXCEPTION 'NEXUS_UNIVERSE: unresolved members are stored only for a PARTIAL revision (a COMPLETE snapshot has none)';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER universe_unresolved_members_partial BEFORE INSERT ON universe_unresolved_members
  FOR EACH ROW EXECUTE FUNCTION nexus_universe_unresolved_insert();

-- Append-only, as in 001: no UPDATE, no DELETE, no TRUNCATE, on any universe table.
CREATE TRIGGER universe_sources_immutable BEFORE UPDATE OR DELETE ON universe_sources FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER universe_sources_no_truncate BEFORE TRUNCATE ON universe_sources FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER universe_definitions_immutable BEFORE UPDATE OR DELETE ON universe_definitions FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER universe_definitions_no_truncate BEFORE TRUNCATE ON universe_definitions FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER universe_snapshot_revisions_immutable BEFORE UPDATE OR DELETE ON universe_snapshot_revisions FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER universe_snapshot_revisions_no_truncate BEFORE TRUNCATE ON universe_snapshot_revisions FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER universe_snapshot_members_immutable BEFORE UPDATE OR DELETE ON universe_snapshot_members FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER universe_snapshot_members_no_truncate BEFORE TRUNCATE ON universe_snapshot_members FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER universe_unresolved_members_immutable BEFORE UPDATE OR DELETE ON universe_unresolved_members FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER universe_unresolved_members_no_truncate BEFORE TRUNCATE ON universe_unresolved_members FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
