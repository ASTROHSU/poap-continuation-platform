-- One claim URL may either represent one slot (unique mode)
-- or a pool of slots (shared mode).

ALTER TABLE live_events
  ADD COLUMN claim_mode TEXT NOT NULL DEFAULT 'unique'
  CHECK (claim_mode IN ('unique', 'shared'));

ALTER TABLE live_claim_codes
  ADD COLUMN access_code_hash TEXT CHECK (
    access_code_hash IS NULL OR (
      length(access_code_hash) = 64
      AND access_code_hash NOT GLOB '*[^0-9a-f]*'
    )
  );

UPDATE live_claim_codes
SET access_code_hash = code_hash
WHERE access_code_hash IS NULL;

CREATE TRIGGER live_claim_codes_require_access_on_insert
BEFORE INSERT ON live_claim_codes
WHEN NEW.access_code_hash IS NULL
BEGIN
  SELECT RAISE(ABORT, 'access_code_hash is required');
END;

CREATE TRIGGER live_claim_codes_require_access_on_update
BEFORE UPDATE OF access_code_hash ON live_claim_codes
WHEN NEW.access_code_hash IS NULL
BEGIN
  SELECT RAISE(ABORT, 'access_code_hash is required');
END;

CREATE INDEX idx_live_claim_access_pool
  ON live_claim_codes(event_id, access_code_hash, claimed_by, code_hash);

CREATE UNIQUE INDEX idx_live_claim_one_per_owner
  ON live_claim_codes(event_id, claimed_by)
  WHERE claimed_by IS NOT NULL;
