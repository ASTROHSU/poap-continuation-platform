-- Keep every known submitted hash, including replacements and failed receipts.
-- Wei values remain decimal strings to avoid SQLite/JS floating-point loss.
CREATE TABLE gas_receipts (
  chain_id INTEGER NOT NULL,
  transaction_hash TEXT NOT NULL,
  payer TEXT,
  block_number INTEGER,
  occurred_at TEXT,
  success INTEGER,
  fee_wei TEXT,
  discovered_at INTEGER NOT NULL DEFAULT 0,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, transaction_hash)
) WITHOUT ROWID;
CREATE INDEX gas_receipts_pending ON gas_receipts(chain_id, next_check_at) WHERE occurred_at IS NULL;

CREATE TABLE gas_monitor_state (
  chain_id INTEGER NOT NULL,
  relayer TEXT NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  notified_level TEXT NOT NULL DEFAULT 'healthy',
  notified_at INTEGER NOT NULL DEFAULT 0,
  report_json TEXT,
  last_error_at INTEGER,
  PRIMARY KEY (chain_id, relayer)
) WITHOUT ROWID;
