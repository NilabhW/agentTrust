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
