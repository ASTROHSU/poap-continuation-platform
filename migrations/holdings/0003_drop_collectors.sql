-- A secondary index on tokens would repeat its wide WITHOUT ROWID primary key
-- and requires one unbounded remote sort. Keep a narrow, incrementally
-- backfillable relation clustered in the exact public query order instead.
CREATE TABLE drop_collector_refs (
  drop_id INTEGER NOT NULL CHECK (drop_id > 0),
  poap_id INTEGER NOT NULL CHECK (poap_id > 0),
  source_uid TEXT NOT NULL CHECK (length(source_uid) BETWEEN 1 AND 128),
  owner_address_norm TEXT NOT NULL CHECK (
    length(owner_address_norm) = 42
    AND substr(owner_address_norm, 1, 2) = '0x'
    AND substr(owner_address_norm, 3) NOT GLOB '*[^0-9a-f]*'
    AND owner_address_norm = lower(owner_address_norm)
  ),
  PRIMARY KEY (
    drop_id,
    poap_id DESC,
    source_uid DESC,
    owner_address_norm DESC
  ),
  FOREIGN KEY (
    owner_address_norm,
    poap_id,
    source_uid
  ) REFERENCES tokens (
    owner_address_norm,
    poap_id,
    source_uid
  ) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE drop_collector_backfill (
  range_prefix TEXT PRIMARY KEY CHECK (
    length(range_prefix) BETWEEN 1 AND 4
    AND range_prefix NOT GLOB '*[^0-9a-f]*'
  ),
  inserted_rows INTEGER NOT NULL CHECK (inserted_rows >= 0),
  completed_at TEXT NOT NULL
) WITHOUT ROWID;

-- Fresh snapshot imports populate the Drop order incrementally with each token
-- shard. Existing snapshots use the resumable prefix backfill tool once.
CREATE TRIGGER tokens_drop_collector_ref_after_insert
AFTER INSERT ON tokens
BEGIN
  INSERT INTO drop_collector_refs (
    drop_id,
    poap_id,
    source_uid,
    owner_address_norm
  ) VALUES (
    NEW.drop_id,
    NEW.poap_id,
    NEW.source_uid,
    NEW.owner_address_norm
  );
END;
