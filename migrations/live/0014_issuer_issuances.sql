-- Verified owner issuance and its reusable shared claim credential.
-- No plaintext claim code is stored; the record and pool commit together.
CREATE TABLE live_event_issuances (
  event_id TEXT PRIMARY KEY REFERENCES live_events(event_id),
  transaction_hash TEXT NOT NULL UNIQUE,
  block_number INTEGER NOT NULL CHECK (block_number >= 0),
  claim_code_ciphertext TEXT NOT NULL,
  claim_code_iv TEXT NOT NULL,
  access_code_hash TEXT NOT NULL CHECK (length(access_code_hash) = 64),
  verified_by_address TEXT NOT NULL,
  verified_at TEXT NOT NULL
) WITHOUT ROWID;
