export const CREATE_CAPTURE_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = FILE;

CREATE TABLE snapshot_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- Column-compatible with the POAP Archive source table. Compass does not
-- expose the Archive's opaque source_uid, so capture uses the documented,
-- deterministic compass-poap:<poap_id>:<chain> namespace. Compass permits one
-- logical POAP id on more than one chain, matching the Archive source.
CREATE TABLE tokens (
  source_uid TEXT PRIMARY KEY,
  poap_id INTEGER NOT NULL,
  drop_id INTEGER,
  minted_on INTEGER,
  owner_address TEXT NOT NULL,
  network TEXT,
  transfer_count INTEGER NOT NULL
);

CREATE INDEX idx_tokens_poap_id ON tokens(poap_id);
CREATE INDEX idx_tokens_drop_id ON tokens(drop_id);

CREATE TABLE compass_token_metadata (
  source_uid TEXT PRIMARY KEY,
  collected_at TEXT,
  captured_at TEXT NOT NULL,
  FOREIGN KEY (source_uid) REFERENCES tokens(source_uid) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE capture_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE capture_shards (
  shard_id INTEGER PRIMARY KEY CHECK (shard_id >= 0),
  lower_exclusive INTEGER NOT NULL CHECK (lower_exclusive >= 0),
  upper_inclusive INTEGER NOT NULL CHECK (upper_inclusive >= lower_exclusive),
  cursor_id INTEGER NOT NULL CHECK (
    cursor_id >= lower_exclusive AND cursor_id <= upper_inclusive
  ),
  cursor_chain TEXT NOT NULL,
  expected_rows INTEGER NOT NULL CHECK (expected_rows >= 0),
  captured_rows INTEGER NOT NULL DEFAULT 0 CHECK (captured_rows >= 0),
  pages INTEGER NOT NULL DEFAULT 0 CHECK (pages >= 0),
  started_at TEXT,
  finished_at TEXT,
  CHECK (
    (finished_at IS NULL)
    OR (captured_rows = expected_rows)
  )
);

CREATE TABLE capture_pages (
  shard_id INTEGER NOT NULL,
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  cursor_before_id INTEGER NOT NULL,
  cursor_before_chain TEXT NOT NULL,
  cursor_after_id INTEGER NOT NULL,
  cursor_after_chain TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count BETWEEN 1 AND 100),
  response_sha256 TEXT NOT NULL CHECK (length(response_sha256) = 64),
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (shard_id, page_number),
  FOREIGN KEY (shard_id) REFERENCES capture_shards(shard_id) ON DELETE CASCADE
) WITHOUT ROWID;

-- A shard is complete only after the exact keyset cursor returns an empty
-- page. The initial aggregate count is evidence, not a transactional boundary.
CREATE TABLE capture_terminal_pages (
  shard_id INTEGER PRIMARY KEY,
  cursor_id INTEGER NOT NULL,
  cursor_chain TEXT NOT NULL,
  response_sha256 TEXT NOT NULL CHECK (length(response_sha256) = 64),
  fetched_at TEXT NOT NULL,
  captured_rows INTEGER NOT NULL CHECK (captured_rows >= 0),
  initial_expected_rows INTEGER NOT NULL CHECK (initial_expected_rows >= 0),
  FOREIGN KEY (shard_id) REFERENCES capture_shards(shard_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE capture_final_counts (
  shard_id INTEGER PRIMARY KEY,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  response_sha256 TEXT NOT NULL CHECK (length(response_sha256) = 64),
  counted_at TEXT NOT NULL,
  FOREIGN KEY (shard_id) REFERENCES capture_shards(shard_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE capture_reconciliations (
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  shard_id INTEGER NOT NULL,
  prior_captured_rows INTEGER NOT NULL CHECK (prior_captured_rows >= 0),
  prior_initial_expected_rows INTEGER NOT NULL CHECK (prior_initial_expected_rows >= 0),
  final_aggregate_rows INTEGER NOT NULL CHECK (final_aggregate_rows >= 0),
  reset_at TEXT NOT NULL,
  PRIMARY KEY (attempt, shard_id),
  FOREIGN KEY (shard_id) REFERENCES capture_shards(shard_id) ON DELETE CASCADE
) WITHOUT ROWID;
`;
