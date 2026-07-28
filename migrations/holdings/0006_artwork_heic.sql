-- Preserve HEIC originals without mislabeling their bytes as another image type.
CREATE TABLE holding_drop_artwork_next (
  drop_id INTEGER PRIMARY KEY CHECK (drop_id > 0),
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  content_type TEXT NOT NULL CHECK (
    content_type IN (
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/avif',
      'image/heic'
    )
  ),
  source_url TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  FOREIGN KEY (drop_id) REFERENCES holding_drops(drop_id) ON DELETE CASCADE
) WITHOUT ROWID;

INSERT INTO holding_drop_artwork_next (
  drop_id,
  object_key,
  sha256,
  byte_length,
  content_type,
  source_url,
  archived_at
)
SELECT
  drop_id,
  object_key,
  sha256,
  byte_length,
  content_type,
  source_url,
  archived_at
FROM holding_drop_artwork;

DROP TABLE holding_drop_artwork;

ALTER TABLE holding_drop_artwork_next RENAME TO holding_drop_artwork;
