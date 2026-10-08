CREATE TABLE IF NOT EXISTS inventory_state (
  owner_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS owner_sessions (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS unlock_attempts (
  id TEXT PRIMARY KEY,
  slot INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
