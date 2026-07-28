CREATE INDEX idx_tokens_drop_collectors
ON tokens(drop_id, poap_id DESC, source_uid DESC, owner_address_norm DESC);
