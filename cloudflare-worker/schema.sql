CREATE TABLE IF NOT EXISTS sync_docs (
  space_id TEXT PRIMARY KEY,
  auth_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_docs_updated_at
ON sync_docs (updated_at);
