-- Mutable continuation data lives separately from the immutable POAP snapshot.
-- One live event maps to one future Base token ID.

CREATE TABLE live_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 8 AND 80),
  slug TEXT NOT NULL UNIQUE CHECK (
    length(slug) BETWEEN 3 AND 80
    AND slug = lower(slug)
    AND slug NOT GLOB '*[^a-z0-9-]*'
  ),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL CHECK (length(image_url) BETWEEN 1 AND 2048),
  event_url TEXT,
  starts_at TEXT NOT NULL,
  claim_opens_at TEXT NOT NULL,
  claim_closes_at TEXT NOT NULL,
  chain_id INTEGER NOT NULL DEFAULT 8453 CHECK (chain_id > 0),
  contract_address TEXT CHECK (
    contract_address IS NULL OR (
      length(contract_address) = 42
      AND substr(contract_address, 1, 2) = '0x'
      AND substr(contract_address, 3) NOT GLOB '*[^0-9a-f]*'
      AND contract_address = lower(contract_address)
    )
  ),
  token_id TEXT,
  max_supply INTEGER NOT NULL CHECK (max_supply > 0),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'closed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

CREATE INDEX idx_live_events_status_start
  ON live_events(status, starts_at DESC, event_id);

-- Codes are bearer credentials. Only their SHA-256 digests are stored.
-- A single conditional UPDATE claims a code atomically.
CREATE TABLE live_claim_codes (
  code_hash TEXT PRIMARY KEY CHECK (
    length(code_hash) = 64
    AND code_hash NOT GLOB '*[^0-9a-f]*'
  ),
  event_id TEXT NOT NULL,
  claimed_by TEXT CHECK (
    claimed_by IS NULL OR (
      length(claimed_by) = 42
      AND substr(claimed_by, 1, 2) = '0x'
      AND substr(claimed_by, 3) NOT GLOB '*[^0-9a-f]*'
      AND claimed_by = lower(claimed_by)
    )
  ),
  claimed_at TEXT,
  minted_tx_hash TEXT CHECK (
    minted_tx_hash IS NULL OR (
      length(minted_tx_hash) = 66
      AND substr(minted_tx_hash, 1, 2) = '0x'
      AND substr(minted_tx_hash, 3) NOT GLOB '*[^0-9a-f]*'
      AND minted_tx_hash = lower(minted_tx_hash)
    )
  ),
  minted_at TEXT,
  FOREIGN KEY (event_id) REFERENCES live_events(event_id) ON DELETE CASCADE,
  CHECK (
    (claimed_by IS NULL AND claimed_at IS NULL)
    OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL)
  ),
  CHECK (
    (minted_tx_hash IS NULL AND minted_at IS NULL)
    OR (minted_tx_hash IS NOT NULL AND minted_at IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE INDEX idx_live_claims_owner
  ON live_claim_codes(claimed_by, claimed_at DESC, event_id)
  WHERE claimed_by IS NOT NULL;

CREATE INDEX idx_live_claims_pending_mint
  ON live_claim_codes(event_id, claimed_at, claimed_by)
  WHERE claimed_by IS NOT NULL AND minted_tx_hash IS NULL;
