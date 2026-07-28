-- Immutable artwork preserved for exact-ID and exact-address Holdings fallback.
-- Object keys are populated only after the corresponding R2 object has been
-- uploaded and verified.
CREATE TABLE holding_drop_artwork (
  drop_id INTEGER PRIMARY KEY CHECK (drop_id > 0),
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  content_type TEXT NOT NULL CHECK (
    content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif')
  ),
  source_url TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  FOREIGN KEY (drop_id) REFERENCES holding_drops(drop_id) ON DELETE CASCADE
) WITHOUT ROWID;
