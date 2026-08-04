-- Remember the wallet returned by a verified Magic Embedded Wallet session.
-- Only the existing keyed Email digest is stored; raw Email addresses and DID
-- tokens remain ephemeral.

CREATE TABLE live_magic_email_identities (
  email_hmac TEXT PRIMARY KEY CHECK (
    length(email_hmac) = 64
    AND email_hmac NOT GLOB '*[^0-9a-f]*'
  ),
  address TEXT NOT NULL UNIQUE CHECK (
    length(address) = 42
    AND substr(address, 1, 2) = '0x'
    AND substr(address, 3) NOT GLOB '*[^0-9a-f]*'
    AND address = lower(address)
  ),
  verified_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX idx_live_magic_email_identity_address
  ON live_magic_email_identities(address);
