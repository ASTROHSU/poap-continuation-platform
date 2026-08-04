-- Optional wallet provisioning for verified Email accounts.
--
-- This table deliberately stores only the keyed Email digest already used by
-- the reservation system. Plaintext Email addresses remain encrypted inside
-- short-lived verification challenges and are never copied here.

CREATE TABLE live_email_wallets (
  email_hmac TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('magic-pregen')),
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'failed')),
  address TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provisioning_started_at TEXT,
  last_error_code TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'ready' AND address IS NOT NULL) OR
    (status <> 'ready' AND address IS NULL)
  )
);

CREATE UNIQUE INDEX idx_live_email_wallets_provider_address
  ON live_email_wallets(provider, address)
  WHERE address IS NOT NULL;

CREATE INDEX idx_live_email_wallets_retry
  ON live_email_wallets(status, updated_at)
  WHERE status <> 'ready';
