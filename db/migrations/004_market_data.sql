-- 004_market_data: instruments, canonical market data and quant runs.
--
-- Table layout (why more than the minimum list):
--   market_data_sources            provenance + license class of every dataset (provider identity is never lost)
--   instruments, provider_instrument_mappings   projections of the hash-chained 'instruments' log (derived caches)
--   instrument_events              immutable history projection of that log
--   market_data_heads              gapless per-instrument ingest sequence (reproducibility anchor "storedThrough")
--   market_bars, market_quotes, corporate_actions   append-only, one row per REVISION (nothing is overwritten)
--   market_data_quarantine         refused records, kept for investigation, never used as data
--   quant_runs                     immutable audit of every quant computation
--
-- Invariants enforced here (second line of defense behind the application):
--   * prices exact NUMERIC (no float); OHLC consistency; non-negative volume
--   * ingest_seq = head + 1 per instrument (one writer at a time, gapless, commit-ordered)
--   * revision = previous + 1 per key; a final bar never regresses to in-progress;
--     a new revision is never visible before it was retrieved (available_at >= retrieved_at)
--   * UPDATE / DELETE / TRUNCATE rejected on all history tables

CREATE TABLE market_data_sources (
  source_id     TEXT PRIMARY KEY CHECK (source_id ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'),
  provider      TEXT NOT NULL CHECK (provider <> ''),
  dataset       TEXT NOT NULL CHECK (dataset <> ''),
  environment   TEXT NOT NULL CHECK (environment IN ('production', 'demo', 'test_fixture')),
  license_class TEXT NOT NULL CHECK (license_class IN ('internal_use', 'display_allowed', 'redistributable', 'not_redistributable', 'unreviewed')),
  license_note  TEXT NULL,
  source_hash   CHAR(64) NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Instruments: derived from the 'instruments' append-only log (truth), rebuilt by the projector.
CREATE TABLE instruments (
  instrument_id          TEXT PRIMARY KEY,
  asset_class            TEXT NOT NULL CHECK (asset_class IN ('stock', 'etf', 'crypto', 'forex', 'commodity', 'future', 'index')),
  symbol                 TEXT NOT NULL,
  name                   TEXT NULL,
  currency               TEXT NOT NULL,
  exchange               TEXT NULL,
  mic                    TEXT NULL,
  timezone               TEXT NOT NULL,
  tick_size              NUMERIC NULL CHECK (tick_size > 0),
  lot_size               NUMERIC NULL CHECK (lot_size > 0),
  trading_calendar       TEXT NULL,
  active                 BOOLEAN NOT NULL,
  allows_negative_prices BOOLEAN NOT NULL DEFAULT false,
  last_event_id          TEXT NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL
);

CREATE TABLE provider_instrument_mappings (
  instrument_id          TEXT NOT NULL REFERENCES instruments (instrument_id),
  provider               TEXT NOT NULL,
  provider_symbol        TEXT NOT NULL,
  provider_instrument_id TEXT NULL,
  exchange               TEXT NULL,
  valid_from             TIMESTAMPTZ NOT NULL,
  valid_to               TIMESTAMPTZ NULL CHECK (valid_to IS NULL OR valid_to > valid_from),
  PRIMARY KEY (instrument_id, provider, provider_symbol, valid_from)
);
CREATE INDEX provider_instrument_mappings_lookup ON provider_instrument_mappings (provider, upper(provider_symbol), valid_from);

CREATE TABLE instrument_events (
  event_id      TEXT PRIMARY KEY,
  log_name      TEXT NOT NULL DEFAULT 'instruments' CHECK (log_name = 'instruments'),
  type          TEXT NOT NULL CHECK (type IN ('instrument_registered', 'instrument_updated', 'mapping_added', 'mapping_closed', 'symbol_changed')),
  instrument_id TEXT NOT NULL,
  at            TIMESTAMPTZ NOT NULL,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  actor_id      TEXT NOT NULL,
  reason        TEXT NOT NULL,
  record_hash   CHAR(64) NOT NULL,
  FOREIGN KEY (log_name, event_id) REFERENCES append_only_records (log_name, record_id)
);

-- Per-instrument ingest sequence shared by bars, quotes and corporate actions.
CREATE TABLE market_data_heads (
  instrument_id TEXT PRIMARY KEY,
  head_seq      BIGINT NOT NULL DEFAULT 0 CHECK (head_seq >= 0)
);

CREATE FUNCTION nexus_market_data_heads_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.instrument_id <> OLD.instrument_id OR NEW.head_seq <> OLD.head_seq + 1 THEN
    RAISE EXCEPTION 'NEXUS_MARKET_DATA: the ingest head of % can only advance by one', OLD.instrument_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER market_data_heads_guard BEFORE UPDATE ON market_data_heads FOR EACH ROW EXECUTE FUNCTION nexus_market_data_heads_guard();

-- Checks and advances the head for every inserted row (bars, quotes, corporate actions).
-- Earlier rows of the same multi-row INSERT are visible to this BEFORE trigger, so a batch advances 1, 2, 3, ...
CREATE FUNCTION nexus_market_data_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head BIGINT;
BEGIN
  INSERT INTO market_data_heads (instrument_id) VALUES (NEW.instrument_id) ON CONFLICT (instrument_id) DO NOTHING;
  SELECT head_seq INTO head FROM market_data_heads WHERE instrument_id = NEW.instrument_id FOR UPDATE;
  IF NEW.ingest_seq <> head + 1 THEN
    RAISE EXCEPTION 'NEXUS_MARKET_DATA: ingest_seq % of % does not follow head %', NEW.ingest_seq, NEW.instrument_id, head;
  END IF;
  UPDATE market_data_heads SET head_seq = NEW.ingest_seq WHERE instrument_id = NEW.instrument_id;
  RETURN NEW;
END $$;

CREATE TABLE market_bars (
  instrument_id TEXT NOT NULL CHECK (instrument_id <> ''),
  source_id     TEXT NOT NULL REFERENCES market_data_sources (source_id),
  bar_interval  TEXT NOT NULL CHECK (bar_interval IN ('1m', '5m', '15m', '1h', '4h', '1d')),
  session       TEXT NOT NULL CHECK (session IN ('regular', 'extended', 'continuous')),
  adjustment    TEXT NOT NULL CHECK (adjustment IN ('raw', 'split_adjusted', 'total_return_adjusted')),
  start_time    TIMESTAMPTZ NOT NULL,
  end_time      TIMESTAMPTZ NOT NULL,
  revision      INTEGER NOT NULL CHECK (revision >= 1),
  open          NUMERIC NOT NULL,
  high          NUMERIC NOT NULL,
  low           NUMERIC NOT NULL,
  close         NUMERIC NOT NULL,
  volume        NUMERIC NULL CHECK (volume IS NULL OR volume >= 0),
  is_final      BOOLEAN NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL,
  available_at  TIMESTAMPTZ NOT NULL,
  retrieved_at  TIMESTAMPTZ NOT NULL,
  ingest_seq    BIGINT NOT NULL CHECK (ingest_seq > 0),
  content_hash  CHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, source_id, bar_interval, session, adjustment, start_time, revision),
  CONSTRAINT market_bars_ingest_seq UNIQUE (instrument_id, ingest_seq),
  CONSTRAINT market_bars_window CHECK (end_time > start_time),
  CONSTRAINT market_bars_ohlc CHECK (high >= open AND high >= close AND high >= low AND low <= open AND low <= close),
  CONSTRAINT market_bars_not_before_start CHECK (available_at >= start_time),
  CONSTRAINT market_bars_final_intraday CHECK (NOT is_final OR bar_interval = '1d' OR available_at >= end_time)
);

CREATE FUNCTION nexus_market_bar_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev RECORD;
BEGIN
  SELECT revision, is_final, available_at INTO prev FROM market_bars
   WHERE instrument_id = NEW.instrument_id AND source_id = NEW.source_id AND bar_interval = NEW.bar_interval
     AND session = NEW.session AND adjustment = NEW.adjustment AND start_time = NEW.start_time
   ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.revision <> 1 THEN RAISE EXCEPTION 'NEXUS_MARKET_DATA: first revision of a bar must be 1'; END IF;
  ELSE
    IF NEW.revision <> prev.revision + 1 THEN RAISE EXCEPTION 'NEXUS_MARKET_DATA: bar revision must be % (got %)', prev.revision + 1, NEW.revision; END IF;
    IF prev.is_final AND NOT NEW.is_final THEN RAISE EXCEPTION 'NEXUS_MARKET_DATA: a final bar cannot be replaced by an in-progress bar'; END IF;
    IF NEW.available_at < prev.available_at OR NEW.available_at < NEW.retrieved_at THEN
      RAISE EXCEPTION 'NEXUS_MARKET_DATA: a bar revision cannot become available before it was retrieved';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER market_bars_revision BEFORE INSERT ON market_bars FOR EACH ROW EXECUTE FUNCTION nexus_market_bar_revision();
CREATE TRIGGER market_bars_sequence BEFORE INSERT ON market_bars FOR EACH ROW EXECUTE FUNCTION nexus_market_data_sequence();

CREATE TABLE market_quotes (
  instrument_id  TEXT NOT NULL CHECK (instrument_id <> ''),
  source_id      TEXT NOT NULL REFERENCES market_data_sources (source_id),
  observed_at    TIMESTAMPTZ NOT NULL,
  revision       INTEGER NOT NULL CHECK (revision >= 1),
  last_price     NUMERIC NOT NULL,
  bid            NUMERIC NULL,
  ask            NUMERIC NULL,
  open           NUMERIC NULL,
  high           NUMERIC NULL,
  low            NUMERIC NULL,
  previous_close NUMERIC NULL,
  volume         NUMERIC NULL CHECK (volume IS NULL OR volume >= 0),
  currency       TEXT NULL CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  market_open    BOOLEAN NULL,
  available_at   TIMESTAMPTZ NOT NULL,
  retrieved_at   TIMESTAMPTZ NOT NULL,
  ingest_seq     BIGINT NOT NULL CHECK (ingest_seq > 0),
  content_hash   CHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, source_id, observed_at, revision),
  CONSTRAINT market_quotes_ingest_seq UNIQUE (instrument_id, ingest_seq),
  CONSTRAINT market_quotes_spread CHECK (bid IS NULL OR ask IS NULL OR bid <= ask),
  CONSTRAINT market_quotes_range CHECK (high IS NULL OR low IS NULL OR high >= low),
  CONSTRAINT market_quotes_observed CHECK (available_at >= observed_at)
);

CREATE FUNCTION nexus_market_quote_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev RECORD;
BEGIN
  SELECT revision, available_at INTO prev FROM market_quotes
   WHERE instrument_id = NEW.instrument_id AND source_id = NEW.source_id AND observed_at = NEW.observed_at
   ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.revision <> 1 THEN RAISE EXCEPTION 'NEXUS_MARKET_DATA: first revision of a quote must be 1'; END IF;
  ELSIF NEW.revision <> prev.revision + 1 OR NEW.available_at < prev.available_at OR NEW.available_at < NEW.retrieved_at THEN
    RAISE EXCEPTION 'NEXUS_MARKET_DATA: invalid quote revision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER market_quotes_revision BEFORE INSERT ON market_quotes FOR EACH ROW EXECUTE FUNCTION nexus_market_quote_revision();
CREATE TRIGGER market_quotes_sequence BEFORE INSERT ON market_quotes FOR EACH ROW EXECUTE FUNCTION nexus_market_data_sequence();

CREATE TABLE corporate_actions (
  instrument_id TEXT NOT NULL CHECK (instrument_id <> ''),
  source_id     TEXT NOT NULL REFERENCES market_data_sources (source_id),
  action_key    TEXT NOT NULL CHECK (action_key <> ''),
  revision      INTEGER NOT NULL CHECK (revision >= 1),
  type          TEXT NOT NULL CHECK (type IN ('split', 'reverse_split', 'cash_dividend', 'symbol_change')),
  ex_date       DATE NOT NULL,
  ratio_from    NUMERIC NULL CHECK (ratio_from IS NULL OR ratio_from > 0),
  ratio_to      NUMERIC NULL CHECK (ratio_to IS NULL OR ratio_to > 0),
  cash_amount   NUMERIC NULL CHECK (cash_amount IS NULL OR cash_amount >= 0),
  currency      TEXT NULL CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  old_symbol    TEXT NULL,
  new_symbol    TEXT NULL,
  announced_at  TIMESTAMPTZ NULL,
  available_at  TIMESTAMPTZ NOT NULL,
  retrieved_at  TIMESTAMPTZ NOT NULL,
  ingest_seq    BIGINT NOT NULL CHECK (ingest_seq > 0),
  content_hash  CHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, source_id, action_key, revision),
  CONSTRAINT corporate_actions_ingest_seq UNIQUE (instrument_id, ingest_seq),
  CONSTRAINT corporate_actions_split_shape CHECK (type NOT IN ('split', 'reverse_split') OR (ratio_from IS NOT NULL AND ratio_to IS NOT NULL)),
  CONSTRAINT corporate_actions_split_direction CHECK ((type <> 'split' OR ratio_to > ratio_from) AND (type <> 'reverse_split' OR ratio_to < ratio_from))
);

CREATE FUNCTION nexus_corporate_action_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev RECORD;
BEGIN
  SELECT revision, available_at INTO prev FROM corporate_actions
   WHERE instrument_id = NEW.instrument_id AND source_id = NEW.source_id AND action_key = NEW.action_key
   ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.revision <> 1 THEN RAISE EXCEPTION 'NEXUS_MARKET_DATA: first revision of a corporate action must be 1'; END IF;
  ELSIF NEW.revision <> prev.revision + 1 OR NEW.available_at < prev.available_at OR NEW.available_at < NEW.retrieved_at THEN
    RAISE EXCEPTION 'NEXUS_MARKET_DATA: invalid corporate action revision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER corporate_actions_revision BEFORE INSERT ON corporate_actions FOR EACH ROW EXECUTE FUNCTION nexus_corporate_action_revision();
CREATE TRIGGER corporate_actions_sequence BEFORE INSERT ON corporate_actions FOR EACH ROW EXECUTE FUNCTION nexus_market_data_sequence();

CREATE TABLE market_data_quarantine (
  quarantine_id BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('bar', 'quote', 'corporate_action')),
  instrument_id TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL,
  reasons       JSONB NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  raw           JSONB NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX market_data_quarantine_instrument ON market_data_quarantine (instrument_id, quarantine_id);

CREATE TABLE quant_runs (
  quant_run_id      TEXT PRIMARY KEY CHECK (quant_run_id ~ '^qr_[0-9a-f]{40}$'),
  instrument_id     TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  bar_interval      TEXT NOT NULL CHECK (bar_interval IN ('1m', '5m', '15m', '1h', '4h', '1d')),
  session           TEXT NOT NULL CHECK (session IN ('regular', 'extended', 'continuous')),
  adjustment        TEXT NOT NULL CHECK (adjustment IN ('raw', 'split_adjusted', 'total_return_adjusted')),
  as_of             TIMESTAMPTZ NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('final_only', 'include_in_progress')),
  use_case          TEXT NOT NULL CHECK (use_case IN ('trading', 'analysis', 'backtest')),
  stored_through    BIGINT NULL CHECK (stored_through IS NULL OR stored_through >= 0),
  input_start       TIMESTAMPTZ NULL,
  input_end         TIMESTAMPTZ NULL,
  bar_count         INTEGER NOT NULL CHECK (bar_count >= 0),
  input_fingerprint CHAR(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  engine_version    TEXT NOT NULL,
  algorithm_versions JSONB NOT NULL CHECK (jsonb_typeof(algorithm_versions) = 'object'),
  quality_severity  TEXT NOT NULL CHECK (quality_severity IN ('ok', 'warning', 'error', 'critical')),
  insufficient_data BOOLEAN NOT NULL,
  result            JSONB NOT NULL,
  result_hash       CHAR(64) NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  created_at        TIMESTAMPTZ NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quant_runs_id_from_fingerprint CHECK (quant_run_id = 'qr_' || substr(input_fingerprint, 1, 40))
);
CREATE INDEX quant_runs_instrument ON quant_runs (instrument_id, as_of);

CREATE TRIGGER market_data_sources_immutable BEFORE UPDATE OR DELETE ON market_data_sources FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER market_data_heads_no_delete BEFORE DELETE ON market_data_heads FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER instrument_events_immutable BEFORE UPDATE OR DELETE ON instrument_events FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER market_bars_immutable BEFORE UPDATE OR DELETE ON market_bars FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER market_quotes_immutable BEFORE UPDATE OR DELETE ON market_quotes FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER corporate_actions_immutable BEFORE UPDATE OR DELETE ON corporate_actions FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER market_data_quarantine_immutable BEFORE UPDATE OR DELETE ON market_data_quarantine FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER quant_runs_immutable BEFORE UPDATE OR DELETE ON quant_runs FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER market_bars_no_truncate BEFORE TRUNCATE ON market_bars FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER market_quotes_no_truncate BEFORE TRUNCATE ON market_quotes FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER corporate_actions_no_truncate BEFORE TRUNCATE ON corporate_actions FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER quant_runs_no_truncate BEFORE TRUNCATE ON quant_runs FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
