CREATE TABLE IF NOT EXISTS mandates (
  mandate_id             TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL,
  agent_id               TEXT NOT NULL,
  agent_public_key       TEXT NOT NULL,
  category               TEXT NOT NULL,
  max_per_transaction    REAL NOT NULL,
  max_cumulative         REAL NOT NULL,
  rolling_window_seconds INTEGER NOT NULL,
  expires_at             INTEGER NOT NULL,
  created_at             INTEGER NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('active','revoked')) DEFAULT 'active',
  signature              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mandates_user_id ON mandates(user_id);

CREATE TABLE IF NOT EXISTS spend_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mandate_id   TEXT NOT NULL REFERENCES mandates(mandate_id),
  amount       REAL NOT NULL CHECK (amount > 0),
  occurred_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spend_events_mandate_time ON spend_events(mandate_id, occurred_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      INTEGER NOT NULL,
  mandate_id      TEXT,
  agent_id        TEXT,
  request_amount  REAL CHECK (request_amount IS NULL OR request_amount > 0),
  category        TEXT,
  decision        TEXT NOT NULL CHECK (decision IN (
                    'pass','hard_fail','step_up_requested','step_up_approved',
                    'step_up_denied','step_up_timeout','order_created','payment_failed'
                  )),
  reason          TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  order_id        TEXT,
  payment_id      TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_mandate_id ON audit_log(mandate_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_decision ON audit_log(decision);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE is not permitted'); END;

CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: DELETE is not permitted'); END;

CREATE TABLE IF NOT EXISTS pending_approvals (
  id                TEXT PRIMARY KEY,
  mandate_id        TEXT NOT NULL REFERENCES mandates(mandate_id),
  agent_id          TEXT NOT NULL,
  amount            REAL NOT NULL CHECK (amount > 0),
  category          TEXT NOT NULL,
  item_description  TEXT NOT NULL,
  requested_at      INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending','approved','denied')) DEFAULT 'pending',
  resolved_at       INTEGER,
  timed_out         INTEGER NOT NULL CHECK (timed_out IN (0,1)) DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pending_approvals_mandate_id ON pending_approvals(mandate_id);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals(status);
