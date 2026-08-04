-- Reserve a claim by verified email, then bind an existing wallet later.
-- Raw email addresses, magic-link tokens, and session tokens are never stored.

ALTER TABLE live_claim_codes ADD COLUMN reservation_id TEXT;
ALTER TABLE live_claim_codes ADD COLUMN reserved_email_hmac TEXT;
ALTER TABLE live_claim_codes ADD COLUMN reserved_at TEXT;

CREATE UNIQUE INDEX idx_live_claim_reservation_id
  ON live_claim_codes(reservation_id)
  WHERE reservation_id IS NOT NULL;

CREATE UNIQUE INDEX idx_live_claim_one_per_email
  ON live_claim_codes(event_id, reserved_email_hmac)
  WHERE reserved_email_hmac IS NOT NULL;

CREATE INDEX idx_live_claim_email_collection
  ON live_claim_codes(reserved_email_hmac, reserved_at DESC, event_id)
  WHERE reserved_email_hmac IS NOT NULL;

CREATE TRIGGER live_claim_codes_validate_email_reservation_insert
BEFORE INSERT ON live_claim_codes
WHEN
  (NEW.reservation_id IS NULL) != (NEW.reserved_email_hmac IS NULL)
  OR (NEW.reservation_id IS NULL) != (NEW.reserved_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'email reservation fields must be set together');
END;

CREATE TRIGGER live_claim_codes_validate_email_reservation_update
BEFORE UPDATE OF reservation_id, reserved_email_hmac, reserved_at ON live_claim_codes
WHEN
  (NEW.reservation_id IS NULL) != (NEW.reserved_email_hmac IS NULL)
  OR (NEW.reservation_id IS NULL) != (NEW.reserved_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'email reservation fields must be set together');
END;

CREATE TABLE live_email_challenges (
  challenge_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('reserve', 'login')),
  event_id TEXT,
  access_code_hash TEXT,
  email_hmac TEXT NOT NULL CHECK (length(email_hmac) = 64),
  email_ciphertext TEXT NOT NULL,
  email_iv TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  expires_at INTEGER NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES live_events(event_id) ON DELETE CASCADE,
  CHECK (
    (purpose = 'reserve' AND event_id IS NOT NULL AND access_code_hash IS NOT NULL)
    OR (purpose = 'login' AND event_id IS NULL AND access_code_hash IS NULL)
  )
) WITHOUT ROWID;

CREATE INDEX idx_live_email_challenge_lookup
  ON live_email_challenges(token_hash, expires_at, consumed_at);

CREATE TABLE live_email_sessions (
  session_hash TEXT PRIMARY KEY CHECK (length(session_hash) = 64),
  email_hmac TEXT NOT NULL CHECK (length(email_hmac) = 64),
  expires_at INTEGER NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

CREATE INDEX idx_live_email_session_identity
  ON live_email_sessions(email_hmac, expires_at)
  WHERE revoked_at IS NULL;
