export function buildEventAuditSql(slug) {
  return `WITH selected_event AS (
    SELECT * FROM live_events WHERE slug = ${sqlText(slug)}
  ),
  claim_stats AS (
    SELECT
      COUNT(c.code_hash) AS slots,
      COALESCE(SUM(c.reservation_id IS NOT NULL), 0) AS email_reserved,
      COALESCE(SUM(c.reservation_id IS NOT NULL AND c.claimed_by IS NULL), 0) AS waiting_for_wallet,
      COALESCE(SUM(c.claimed_by IS NOT NULL), 0) AS wallet_bound,
      COALESCE(SUM(c.claimed_by IS NOT NULL AND c.minted_tx_hash IS NULL), 0) AS pending_mint,
      COALESCE(SUM(c.minted_tx_hash IS NOT NULL), 0) AS minted_claims,
      COALESCE(SUM(
        c.minted_tx_hash IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM live_chain_events ce
          JOIN selected_event se
            ON se.chain_id = ce.chain_id
           AND se.contract_address = ce.contract_address
           AND se.token_id = ce.token_id
          WHERE ce.transaction_hash = c.minted_tx_hash
            AND ce.to_address = c.claimed_by
        )
      ), 0) AS minted_waiting_for_index
    FROM live_claim_codes c
    JOIN selected_event se ON se.event_id = c.event_id
  ),
  chain_stats AS (
    SELECT
      COUNT(*) AS current_holders,
      COALESCE(SUM(b.balance), 0) AS current_supply
    FROM live_token_balances b
    JOIN selected_event se
      ON se.chain_id = b.chain_id
     AND se.contract_address = b.contract_address
     AND se.token_id = b.token_id
    WHERE b.balance > 0
  ),
  indexed_stats AS (
    SELECT COUNT(*) AS indexed_transfers
    FROM live_chain_events ce
    JOIN selected_event se
      ON se.chain_id = ce.chain_id
     AND se.contract_address = ce.contract_address
     AND se.token_id = ce.token_id
  )
  SELECT
    se.slug,
    se.status,
    se.chain_id,
    se.contract_address,
    se.token_id,
    se.max_supply,
    cs.slots,
    cs.email_reserved,
    cs.waiting_for_wallet,
    cs.wallet_bound,
    cs.pending_mint,
    cs.minted_claims,
    cs.minted_waiting_for_index,
    ch.current_holders,
    ch.current_supply,
    ix.indexed_transfers,
    cursor.last_finalized_block,
    cursor.next_block,
    CASE
      WHEN cursor.last_finalized_block IS NULL THEN NULL
      ELSE MAX(0, cursor.last_finalized_block - cursor.next_block + 1)
    END AS indexer_lag_blocks,
    cursor.last_synced_at
  FROM selected_event se
  CROSS JOIN claim_stats cs
  CROSS JOIN chain_stats ch
  CROSS JOIN indexed_stats ix
  LEFT JOIN live_chain_cursors cursor
    ON cursor.chain_id = se.chain_id
   AND cursor.contract_address = se.contract_address;`;
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
