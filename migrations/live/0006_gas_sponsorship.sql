-- Phase 3: association-sponsored mint transactions.
-- A short lease prevents repeated clicks from spending gas more than once.

ALTER TABLE live_claim_codes ADD COLUMN relay_started_at TEXT;
ALTER TABLE live_claim_codes ADD COLUMN relay_tx_hash TEXT CHECK (
  relay_tx_hash IS NULL OR (
    length(relay_tx_hash) = 66
    AND substr(relay_tx_hash, 1, 2) = '0x'
    AND substr(relay_tx_hash, 3) NOT GLOB '*[^0-9a-f]*'
    AND relay_tx_hash = lower(relay_tx_hash)
  )
);

CREATE INDEX idx_live_claim_relay
  ON live_claim_codes(event_id, access_code_hash, claimed_by, relay_tx_hash);
