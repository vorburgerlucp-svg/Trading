-- 001_ledger: NEXUS financial core (double-entry capital ledger).
--
-- Invariants enforced by the database (second line of defense behind the application):
--   * every transaction balances per currency (sum of amount_minor = 0)        -> deferred constraint trigger
--   * a transaction has exactly line_count lines, numbered 1..line_count       -> deferred constraint trigger
--   * only currencies enabled for the ledger are booked (no implicit FX)       -> deferred constraint trigger
--   * one linear history: sequence = head + 1, prev_hash = head hash, no forks -> trigger + UNIQUE constraints
--   * idempotency: an entry_id is booked at most once per ledger               -> UNIQUE (ledger_id, entry_id)
--   * an entry is reversed at most once, and only an existing entry            -> partial UNIQUE index + FK
--   * history is append-only: UPDATE / DELETE / TRUNCATE are rejected          -> triggers
-- Money is BIGINT minor units + CHAR(3) currency; quantities are exact NUMERIC. No floating point.
-- The content hash itself is verified by the application on load (canonical JSON is not computed in SQL).

CREATE TABLE ledgers (
  ledger_id          TEXT PRIMARY KEY CHECK (ledger_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  base_currency      CHAR(3) NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  allowed_currencies CHAR(3)[] NOT NULL CHECK (cardinality(allowed_currencies) >= 1 AND base_currency = ANY (allowed_currencies)),
  head_sequence      BIGINT NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  head_hash          CHAR(64) NOT NULL DEFAULT repeat('0', 64) CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_transactions (
  ledger_id           TEXT NOT NULL REFERENCES ledgers (ledger_id),
  sequence            BIGINT NOT NULL CHECK (sequence > 0),
  entry_id            TEXT NOT NULL CHECK (length(entry_id) BETWEEN 1 AND 512),
  request_fingerprint CHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  occurred_at         TIMESTAMPTZ NOT NULL,
  recorded_at         TIMESTAMPTZ NOT NULL,
  type                TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'trade_buy', 'trade_sell', 'inventory_buy', 'inventory_sale', 'fee', 'shipping', 'tax', 'expense', 'transfer', 'liability_payment', 'reserve', 'release_reserve', 'reversal')),
  description         TEXT NOT NULL CHECK (description <> ''),
  refs                JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(refs) = 'object'),
  source              TEXT NOT NULL CHECK (source IN ('engine', 'manual', 'broker_sync', 'import')),
  reverses_entry_id   TEXT NULL,
  line_count          INTEGER NOT NULL CHECK (line_count >= 2),
  prev_hash           CHAR(64) NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash                CHAR(64) NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (ledger_id, sequence),
  CONSTRAINT ledger_transactions_idempotency UNIQUE (ledger_id, entry_id),
  CONSTRAINT ledger_transactions_no_fork UNIQUE (ledger_id, prev_hash),
  CONSTRAINT ledger_transactions_unique_hash UNIQUE (ledger_id, hash),
  CONSTRAINT ledger_transactions_reversal_shape CHECK ((type = 'reversal') = (reverses_entry_id IS NOT NULL)),
  CONSTRAINT ledger_transactions_reversal_target FOREIGN KEY (ledger_id, reverses_entry_id) REFERENCES ledger_transactions (ledger_id, entry_id)
);
CREATE UNIQUE INDEX ledger_transactions_single_reversal ON ledger_transactions (ledger_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX ledger_transactions_occurred_at ON ledger_transactions (ledger_id, occurred_at);

CREATE TABLE ledger_lines (
  ledger_id    TEXT NOT NULL,
  sequence     BIGINT NOT NULL,
  line_no      INTEGER NOT NULL CHECK (line_no >= 1),
  account      TEXT NOT NULL CHECK (account ~ '^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)+$'),
  amount_minor BIGINT NOT NULL,
  currency     CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  quantity     NUMERIC NULL,
  PRIMARY KEY (ledger_id, sequence, line_no),
  FOREIGN KEY (ledger_id, sequence) REFERENCES ledger_transactions (ledger_id, sequence),
  CHECK (amount_minor <> 0 OR (quantity IS NOT NULL AND quantity <> 0))
);
CREATE INDEX ledger_lines_account ON ledger_lines (ledger_id, account);

-- Chain link: the new transaction must extend the current head (the writer holds the head row lock).
CREATE FUNCTION nexus_ledger_check_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head_seq BIGINT;
  head_h   CHAR(64);
BEGIN
  SELECT head_sequence, head_hash INTO head_seq, head_h FROM ledgers WHERE ledger_id = NEW.ledger_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEXUS_LEDGER: unknown ledger %', NEW.ledger_id;
  END IF;
  IF NEW.sequence <> head_seq + 1 THEN
    RAISE EXCEPTION 'NEXUS_LEDGER: sequence % does not follow head %', NEW.sequence, head_seq;
  END IF;
  IF NEW.prev_hash <> head_h THEN
    RAISE EXCEPTION 'NEXUS_LEDGER: prev_hash of sequence % does not match the ledger head', NEW.sequence;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_transactions_link BEFORE INSERT ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION nexus_ledger_check_link();

CREATE FUNCTION nexus_ledger_advance_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ledgers SET head_sequence = NEW.sequence, head_hash = NEW.hash WHERE ledger_id = NEW.ledger_id;
  RETURN NULL;
END $$;
CREATE TRIGGER ledger_transactions_advance_head AFTER INSERT ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION nexus_ledger_advance_head();

-- The head can only move by exactly one recorded transaction; configuration may only ADD currencies.
CREATE FUNCTION nexus_ledgers_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ledger_id <> OLD.ledger_id OR NEW.base_currency <> OLD.base_currency OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'NEXUS_LEDGER: ledger identity is immutable';
  END IF;
  IF NOT (NEW.allowed_currencies @> OLD.allowed_currencies) THEN
    RAISE EXCEPTION 'NEXUS_LEDGER: currencies can be enabled but never removed';
  END IF;
  IF NEW.head_sequence = OLD.head_sequence AND NEW.head_hash = OLD.head_hash THEN
    RETURN NEW;
  END IF;
  IF NEW.head_sequence <> OLD.head_sequence + 1 OR NOT EXISTS (
    SELECT 1 FROM ledger_transactions t
    WHERE t.ledger_id = NEW.ledger_id AND t.sequence = NEW.head_sequence AND t.hash = NEW.head_hash AND t.prev_hash = OLD.head_hash
  ) THEN
    RAISE EXCEPTION 'NEXUS_LEDGER: the ledger head can only advance by one recorded transaction';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledgers_guard_update BEFORE UPDATE ON ledgers FOR EACH ROW EXECUTE FUNCTION nexus_ledgers_guard_update();

-- Completeness, balance and currency of one transaction (checked at COMMIT).
CREATE FUNCTION nexus_ledger_assert_complete(p_ledger TEXT, p_sequence BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  expected INTEGER;
  n        INTEGER;
  max_no   INTEGER;
  allowed  CHAR(3)[];
  bad_cur  CHAR(3);
  bad_sum  NUMERIC;
BEGIN
  SELECT line_count INTO expected FROM ledger_transactions WHERE ledger_id = p_ledger AND sequence = p_sequence;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEXUS_LEDGER: lines without transaction (sequence %)', p_sequence;
  END IF;
  SELECT count(*), coalesce(max(line_no), 0) INTO n, max_no FROM ledger_lines WHERE ledger_id = p_ledger AND sequence = p_sequence;
  IF n <> expected OR max_no <> expected THEN
    RAISE EXCEPTION 'NEXUS_LEDGER: transaction % has % lines, expected %', p_sequence, n, expected;
  END IF;
  SELECT allowed_currencies INTO allowed FROM ledgers WHERE ledger_id = p_ledger;
  IF EXISTS (SELECT 1 FROM ledger_lines WHERE ledger_id = p_ledger AND sequence = p_sequence AND NOT (currency = ANY (allowed))) THEN
    RAISE EXCEPTION 'NEXUS_LEDGER: transaction % books a currency that is not enabled for ledger %', p_sequence, p_ledger;
  END IF;
  SELECT currency, sum(amount_minor) INTO bad_cur, bad_sum
    FROM ledger_lines WHERE ledger_id = p_ledger AND sequence = p_sequence
    GROUP BY currency HAVING sum(amount_minor) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'NEXUS_LEDGER: transaction % is unbalanced by % minor units of %', p_sequence, bad_sum, bad_cur;
  END IF;
END $$;

CREATE FUNCTION nexus_ledger_complete_tx() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nexus_ledger_assert_complete(NEW.ledger_id, NEW.sequence);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_transactions_complete AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nexus_ledger_complete_tx();
-- A line added later to an existing transaction breaks its line count / balance and fails here too.
CREATE CONSTRAINT TRIGGER ledger_lines_complete AFTER INSERT ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nexus_ledger_complete_tx();

-- Append-only history.
CREATE FUNCTION nexus_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NEXUS_APPEND_ONLY: % on % is not allowed (history is immutable; book a reversal instead)', TG_OP, TG_TABLE_NAME;
END $$;
CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON ledger_transactions FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER ledger_lines_immutable BEFORE UPDATE OR DELETE ON ledger_lines FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER ledger_lines_no_truncate BEFORE TRUNCATE ON ledger_lines FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER ledgers_no_delete BEFORE DELETE ON ledgers FOR EACH ROW EXECUTE FUNCTION nexus_reject_mutation();
CREATE TRIGGER ledgers_no_truncate BEFORE TRUNCATE ON ledgers FOR EACH STATEMENT EXECUTE FUNCTION nexus_reject_mutation();

-- Reservations are ledger sub-accounts (asset:cash:<type>:<id>:reserved:<purpose>:<reservationId>);
-- this view derives them from the lines instead of storing a second, divergent copy.
CREATE VIEW ledger_reservations AS
SELECT l.ledger_id,
       split_part(l.account, ':', 7) AS reservation_id,
       split_part(l.account, ':', 6) AS purpose,
       array_to_string((string_to_array(l.account, ':'))[1:4], ':') AS cash_account,
       l.currency,
       sum(l.amount_minor) AS balance_minor
FROM ledger_lines l
WHERE split_part(l.account, ':', 5) = 'reserved'
GROUP BY l.ledger_id, l.account, l.currency;

-- Account balances derived from the lines (the truth), for SQL reporting and reconciliation.
CREATE VIEW ledger_account_balances AS
SELECT ledger_id, account, currency, sum(amount_minor) AS balance_minor, sum(coalesce(quantity, 0)) AS quantity
FROM ledger_lines
GROUP BY ledger_id, account, currency;
