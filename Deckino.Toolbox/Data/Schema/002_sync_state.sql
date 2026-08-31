CREATE TABLE IF NOT EXISTS sync_state (
  bulk_type  TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  synced_at  TEXT NOT NULL
);
