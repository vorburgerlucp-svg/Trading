-- 005_scanner_backtest_core: immutable scanner/backtest audit persistence.
-- Each run stores a lossless JSONB record plus normalized candidates/fills/trades for querying.

CREATE TABLE scanner_runs (
  scanner_run_id TEXT PRIMARY KEY CHECK (scanner_run_id ~ '^scan_[0-9a-f]{40}$'),
  input_fingerprint CHAR(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  definition_id TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  universe_id TEXT NOT NULL,
  universe_fingerprint CHAR(64) NOT NULL CHECK (universe_fingerprint ~ '^[0-9a-f]{64}$'),
  universe_point_in_time_safe BOOLEAN NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  result JSONB NOT NULL,
  result_hash CHAR(64) NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scanner_runs_id_from_fingerprint CHECK (scanner_run_id = 'scan_' || substr(input_fingerprint, 1, 40))
);
CREATE INDEX scanner_runs_as_of ON scanner_runs (as_of, scanner_run_id);

CREATE TABLE scanner_candidates (
  scanner_run_id TEXT NOT NULL REFERENCES scanner_runs (scanner_run_id),
  rank INTEGER NOT NULL CHECK (rank > 0),
  instrument_id TEXT NOT NULL,
  quant_run_id TEXT NOT NULL,
  ranking_score DOUBLE PRECISION NOT NULL CHECK (ranking_score::text NOT IN ('NaN','Infinity','-Infinity')),
  data_quality_status TEXT NOT NULL,
  PRIMARY KEY (scanner_run_id, instrument_id),
  UNIQUE (scanner_run_id, rank)
);

CREATE TABLE backtest_runs (
  backtest_run_id TEXT PRIMARY KEY CHECK (backtest_run_id ~ '^bt_[0-9a-f]{40}$'),
  input_fingerprint CHAR(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  engine_version TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  bars_processed INTEGER NOT NULL CHECK (bars_processed >= 0),
  quality_grade TEXT NOT NULL CHECK (quality_grade IN ('A','B','C','INVALID')),
  result JSONB NOT NULL,
  result_hash CHAR(64) NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT backtest_runs_id_from_fingerprint CHECK (backtest_run_id = 'bt_' || substr(input_fingerprint, 1, 40))
);
CREATE INDEX backtest_runs_instrument ON backtest_runs (instrument_id, strategy_id, strategy_version);

CREATE TABLE backtest_fills (
  backtest_run_id TEXT NOT NULL REFERENCES backtest_runs (backtest_run_id),
  fill_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  reason TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  raw_price NUMERIC NOT NULL,
  execution_price NUMERIC NOT NULL,
  quantity NUMERIC NOT NULL CHECK (quantity >= 0),
  commission NUMERIC NOT NULL CHECK (commission >= 0),
  PRIMARY KEY (backtest_run_id, fill_id)
);

CREATE TABLE backtest_trades (
  backtest_run_id TEXT NOT NULL REFERENCES backtest_runs (backtest_run_id),
  trade_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  entry_fill_id TEXT NOT NULL,
  exit_fill_id TEXT NOT NULL,
  pnl NUMERIC NOT NULL,
  return_pct DOUBLE PRECISION NOT NULL CHECK (return_pct::text NOT IN ('NaN','Infinity','-Infinity')),
  PRIMARY KEY (backtest_run_id, trade_id),
  FOREIGN KEY (backtest_run_id, entry_fill_id) REFERENCES backtest_fills (backtest_run_id, fill_id),
  FOREIGN KEY (backtest_run_id, exit_fill_id) REFERENCES backtest_fills (backtest_run_id, fill_id)
);

CREATE TRIGGER scanner_runs_immutable BEFORE UPDATE OR DELETE ON scanner_runs FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER scanner_candidates_immutable BEFORE UPDATE OR DELETE ON scanner_candidates FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER backtest_runs_immutable BEFORE UPDATE OR DELETE ON backtest_runs FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER backtest_fills_immutable BEFORE UPDATE OR DELETE ON backtest_fills FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER backtest_trades_immutable BEFORE UPDATE OR DELETE ON backtest_trades FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER scanner_runs_no_truncate BEFORE TRUNCATE ON scanner_runs FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER scanner_candidates_no_truncate BEFORE TRUNCATE ON scanner_candidates FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER backtest_runs_no_truncate BEFORE TRUNCATE ON backtest_runs FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER backtest_fills_no_truncate BEFORE TRUNCATE ON backtest_fills FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER backtest_trades_no_truncate BEFORE TRUNCATE ON backtest_trades FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
