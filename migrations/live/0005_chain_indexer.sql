-- Phase 3: finalized Base event projection for current ERC-1155 ownership.
-- The append-only event journal is authoritative; balances are trigger-maintained.

ALTER TABLE live_events ADD COLUMN contract_start_block INTEGER
  CHECK (contract_start_block IS NULL OR contract_start_block >= 0);

CREATE UNIQUE INDEX idx_live_event_chain_token
  ON live_events(chain_id, contract_address, token_id)
  WHERE contract_address IS NOT NULL AND token_id IS NOT NULL;

CREATE TABLE live_chain_cursors (
  chain_id INTEGER NOT NULL CHECK (chain_id IN (8453, 84532)),
  contract_address TEXT NOT NULL CHECK (
    length(contract_address) = 42
    AND substr(contract_address, 1, 2) = '0x'
    AND substr(contract_address, 3) NOT GLOB '*[^0-9a-f]*'
    AND contract_address = lower(contract_address)
  ),
  start_block INTEGER NOT NULL CHECK (start_block >= 0),
  next_block INTEGER NOT NULL CHECK (next_block >= start_block),
  last_finalized_block INTEGER,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, contract_address)
) WITHOUT ROWID;

CREATE TABLE live_chain_events (
  chain_id INTEGER NOT NULL CHECK (chain_id IN (8453, 84532)),
  contract_address TEXT NOT NULL,
  transaction_hash TEXT NOT NULL CHECK (
    length(transaction_hash) = 66
    AND substr(transaction_hash, 1, 2) = '0x'
    AND substr(transaction_hash, 3) NOT GLOB '*[^0-9a-f]*'
    AND transaction_hash = lower(transaction_hash)
  ),
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  sub_index INTEGER NOT NULL DEFAULT 0 CHECK (sub_index >= 0),
  block_number INTEGER NOT NULL CHECK (block_number >= 0),
  token_id TEXT NOT NULL CHECK (length(token_id) BETWEEN 1 AND 78),
  from_address TEXT NOT NULL CHECK (
    length(from_address) = 42
    AND substr(from_address, 1, 2) = '0x'
    AND substr(from_address, 3) NOT GLOB '*[^0-9a-f]*'
    AND from_address = lower(from_address)
  ),
  to_address TEXT NOT NULL CHECK (
    length(to_address) = 42
    AND substr(to_address, 1, 2) = '0x'
    AND substr(to_address, 3) NOT GLOB '*[^0-9a-f]*'
    AND to_address = lower(to_address)
  ),
  value INTEGER NOT NULL CHECK (value > 0),
  indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    chain_id,
    contract_address,
    transaction_hash,
    log_index,
    sub_index
  ),
  FOREIGN KEY (chain_id, contract_address)
    REFERENCES live_chain_cursors(chain_id, contract_address) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_live_chain_events_rebuild
  ON live_chain_events(chain_id, contract_address, block_number, log_index, sub_index);

CREATE TABLE live_token_balances (
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  owner_address TEXT NOT NULL CHECK (
    length(owner_address) = 42
    AND substr(owner_address, 1, 2) = '0x'
    AND substr(owner_address, 3) NOT GLOB '*[^0-9a-f]*'
    AND owner_address = lower(owner_address)
  ),
  balance INTEGER NOT NULL CHECK (balance >= 0),
  first_acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_transaction_hash TEXT NOT NULL,
  last_block_number INTEGER NOT NULL,
  last_log_index INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_id, contract_address, token_id, owner_address),
  FOREIGN KEY (chain_id, contract_address)
    REFERENCES live_chain_cursors(chain_id, contract_address) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_live_token_balances_owner
  ON live_token_balances(owner_address, balance, last_block_number DESC)
  WHERE balance > 0;

CREATE TRIGGER live_chain_events_require_source_balance
BEFORE INSERT ON live_chain_events
WHEN
  NEW.from_address != '0x0000000000000000000000000000000000000000'
  AND NOT EXISTS (
    SELECT 1
    FROM live_chain_events existing
    WHERE existing.chain_id = NEW.chain_id
      AND existing.contract_address = NEW.contract_address
      AND existing.transaction_hash = NEW.transaction_hash
      AND existing.log_index = NEW.log_index
      AND existing.sub_index = NEW.sub_index
  )
  AND COALESCE((
    SELECT balance
    FROM live_token_balances
    WHERE chain_id = NEW.chain_id
      AND contract_address = NEW.contract_address
      AND token_id = NEW.token_id
      AND owner_address = NEW.from_address
  ), 0) < NEW.value
BEGIN
  SELECT RAISE(ABORT, 'chain event source balance is insufficient');
END;

CREATE TRIGGER live_chain_events_debit
AFTER INSERT ON live_chain_events
WHEN NEW.from_address != '0x0000000000000000000000000000000000000000'
BEGIN
  UPDATE live_token_balances
  SET
    balance = balance - NEW.value,
    last_transaction_hash = NEW.transaction_hash,
    last_block_number = NEW.block_number,
    last_log_index = NEW.log_index,
    updated_at = CURRENT_TIMESTAMP
  WHERE chain_id = NEW.chain_id
    AND contract_address = NEW.contract_address
    AND token_id = NEW.token_id
    AND owner_address = NEW.from_address;
END;

CREATE TRIGGER live_chain_events_credit
AFTER INSERT ON live_chain_events
WHEN NEW.to_address != '0x0000000000000000000000000000000000000000'
BEGIN
  INSERT INTO live_token_balances (
    chain_id,
    contract_address,
    token_id,
    owner_address,
    balance,
    first_acquired_at,
    last_transaction_hash,
    last_block_number,
    last_log_index,
    updated_at
  ) VALUES (
    NEW.chain_id,
    NEW.contract_address,
    NEW.token_id,
    NEW.to_address,
    NEW.value,
    CURRENT_TIMESTAMP,
    NEW.transaction_hash,
    NEW.block_number,
    NEW.log_index,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (chain_id, contract_address, token_id, owner_address)
  DO UPDATE SET
    balance = live_token_balances.balance + excluded.balance,
    first_acquired_at = CASE
      WHEN live_token_balances.balance = 0 THEN CURRENT_TIMESTAMP
      ELSE live_token_balances.first_acquired_at
    END,
    last_transaction_hash = excluded.last_transaction_hash,
    last_block_number = excluded.last_block_number,
    last_log_index = excluded.last_log_index,
    updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER live_events_register_chain_cursor_insert
AFTER INSERT ON live_events
WHEN NEW.contract_address IS NOT NULL AND NEW.contract_start_block IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO live_chain_cursors (
    chain_id, contract_address, start_block, next_block
  ) VALUES (
    NEW.chain_id, NEW.contract_address, NEW.contract_start_block, NEW.contract_start_block
  );
END;

CREATE TRIGGER live_events_register_chain_cursor_update
AFTER UPDATE OF chain_id, contract_address, contract_start_block ON live_events
WHEN NEW.contract_address IS NOT NULL AND NEW.contract_start_block IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO live_chain_cursors (
    chain_id, contract_address, start_block, next_block
  ) VALUES (
    NEW.chain_id, NEW.contract_address, NEW.contract_start_block, NEW.contract_start_block
  );
END;
