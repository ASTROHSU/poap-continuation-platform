-- Actor-bound idempotency for draft creation. No claim credentials or chain state.
CREATE TABLE live_event_draft_requests (
  request_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  created_by_address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES live_events(event_id) ON DELETE CASCADE
) WITHOUT ROWID;
