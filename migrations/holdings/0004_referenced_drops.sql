-- Exact-address and exact-ID fallback metadata for Drops referenced by the
-- Holdings snapshot but absent from the older immutable catalog. This table is
-- never used for unbounded browsing.
CREATE TABLE holding_drops (
  drop_id INTEGER PRIMARY KEY CHECK (drop_id > 0),
  fancy_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  expiry_date TEXT,
  city TEXT,
  country TEXT,
  event_url TEXT,
  year INTEGER NOT NULL,
  is_virtual INTEGER CHECK (is_virtual IN (0, 1) OR is_virtual IS NULL),
  is_private INTEGER NOT NULL CHECK (is_private IN (0, 1)),
  is_hidden INTEGER NOT NULL CHECK (is_hidden IN (0, 1)),
  channel TEXT,
  platform TEXT,
  location_type TEXT,
  timezone TEXT,
  integrator_id TEXT,
  created_at TEXT NOT NULL,
  image_url TEXT,
  animation_url TEXT,
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  transfer_count INTEGER NOT NULL CHECK (transfer_count >= 0)
) WITHOUT ROWID;
