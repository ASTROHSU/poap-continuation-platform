-- Phase 2: a reserved claim can be exchanged repeatedly for the same
-- short-lived EIP-712 mint authorization until the onchain mint succeeds.

ALTER TABLE live_claim_codes
  ADD COLUMN mint_nonce TEXT CHECK (
    mint_nonce IS NULL OR (
      length(mint_nonce) = 66
      AND substr(mint_nonce, 1, 2) = '0x'
      AND substr(mint_nonce, 3) NOT GLOB '*[^0-9a-f]*'
      AND mint_nonce = lower(mint_nonce)
    )
  );

ALTER TABLE live_claim_codes
  ADD COLUMN mint_authorization_deadline INTEGER CHECK (
    mint_authorization_deadline IS NULL OR mint_authorization_deadline > 0
  );

CREATE UNIQUE INDEX idx_live_claim_mint_nonce
  ON live_claim_codes(mint_nonce)
  WHERE mint_nonce IS NOT NULL;

CREATE INDEX idx_live_claim_receipt
  ON live_claim_codes(event_id, access_code_hash, claimed_by, minted_tx_hash);
