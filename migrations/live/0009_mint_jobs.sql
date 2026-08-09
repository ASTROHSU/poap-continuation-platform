-- Durable, idempotent sponsored mint jobs. D1 is the source of truth while
-- one Durable Object per chain + relayer serializes transaction submission.

CREATE TABLE live_mint_jobs (
  job_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) = 64),
  shard_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  claim_code_hash TEXT NOT NULL,
  recipient TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  relayer_address TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  authorization_deadline INTEGER NOT NULL,
  authorization_nonce TEXT NOT NULL,
  authorization_signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitting', 'submitted', 'retry', 'confirmed', 'failed')),
  network_nonce INTEGER,
  transaction_hash TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  confirmed_at TEXT,
  FOREIGN KEY (event_id) REFERENCES live_events(event_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_live_mint_jobs_shard_work
  ON live_mint_jobs(shard_key, status, next_attempt_at, created_at);

CREATE INDEX idx_live_mint_jobs_claim
  ON live_mint_jobs(event_id, claim_code_hash, recipient, created_at DESC);
