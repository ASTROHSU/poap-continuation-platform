-- Append-only audit log for authenticated issuer changes. The current event
-- stays in live_events; this table preserves who changed what and when.

CREATE TABLE live_event_revisions (
  revision_id TEXT PRIMARY KEY CHECK (
    length(revision_id) = 20
    AND revision_id NOT GLOB '*[^0-9a-f]*'
  ),
  event_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('update', 'close', 'reopen')),
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  created_by_address TEXT NOT NULL CHECK (
    length(created_by_address) = 42
    AND substr(created_by_address, 1, 2) = '0x'
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES live_events(event_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_live_event_revisions_event
  ON live_event_revisions(event_id, created_at DESC);
