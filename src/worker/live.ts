import type { D1ReadClient } from "./types";
import type { Address, Hash } from "viem";

export interface LiveEventRecord {
  eventId: string;
  slug: string;
  title: string;
  description: string;
  imageUrl: string;
  eventUrl: string | null;
  startsAt: string;
  claimOpensAt: string;
  claimClosesAt: string;
  chainId: number;
  contractAddress: string | null;
  tokenId: string | null;
  maxSupply: number;
  claimedCount: number;
  mintedCount: number;
  claimMode: "unique" | "shared";
  status: "draft" | "published" | "closed";
}

interface LiveEventRow {
  event_id: string;
  slug: string;
  title: string;
  description: string;
  image_url: string;
  event_url: string | null;
  starts_at: string;
  claim_opens_at: string;
  claim_closes_at: string;
  chain_id: number;
  contract_address: string | null;
  token_id: string | null;
  max_supply: number;
  claimed_count: number;
  minted_count: number;
  claim_mode: "unique" | "shared";
  status: "draft" | "published" | "closed";
}

interface LiveHoldingRow extends LiveEventRow {
  claimed_at: string;
  minted_tx_hash: string | null;
  minted_at: string | null;
  ownership_source: "claim-record" | "chain-index";
  chain_synced_at: string | null;
  chain_finalized_block: number | null;
}

export interface LiveHoldingRecord extends LiveEventRecord {
  claimedAt: string;
  mintStatus: "reserved" | "minted";
  mintedTxHash: string | null;
  mintedAt: string | null;
  ownershipSource: "claim-record" | "chain-index";
  chainSyncedAt: string | null;
  chainFinalizedBlock: number | null;
}

export interface LiveCollectorRecord {
  ownerAddress: string;
  acquiredAt: string;
}

export interface LiveCollectorsRecord {
  eventId: string;
  slug: string;
  chainId: number;
  collectorCount: number;
  items: LiveCollectorRecord[];
}

export interface LiveClaimRecord {
  codeHash: string;
  claimedAt: string;
  claimedBy: Address;
  mintNonce: Hash;
  mintAuthorizationDeadline: number;
  mintedTxHash: Hash | null;
  relayStartedAt: string | null;
  relayTxHash: Hash | null;
}

interface LiveClaimRow {
  code_hash: string;
  claimed_at: string;
  claimed_by: Address;
  mint_nonce: Hash;
  mint_authorization_deadline: number;
  minted_tx_hash: Hash | null;
  relay_started_at: string | null;
  relay_tx_hash: Hash | null;
}

const EVENT_SELECT = `
  SELECT
    live_events.event_id,
    live_events.slug,
    live_events.title,
    live_events.description,
    live_events.image_url,
    live_events.event_url,
    live_events.starts_at,
    live_events.claim_opens_at,
    live_events.claim_closes_at,
    live_events.chain_id,
    live_events.contract_address,
    live_events.token_id,
    live_events.max_supply,
    live_events.claim_mode,
    live_events.status,
    (
      SELECT COUNT(*)
      FROM live_claim_codes count_codes
      WHERE count_codes.event_id = live_events.event_id
        AND (
          count_codes.claimed_by IS NOT NULL
          OR count_codes.reservation_id IS NOT NULL
        )
    ) AS claimed_count,
    (
      SELECT COUNT(*)
      FROM live_claim_codes mint_codes
      WHERE mint_codes.event_id = live_events.event_id
        AND mint_codes.minted_tx_hash IS NOT NULL
    ) AS minted_count
  FROM live_events
`;

export async function fetchLiveEvent(
  db: D1ReadClient,
  slug: string,
): Promise<LiveEventRecord | null> {
  const row = await db
    .prepare(
      `${EVENT_SELECT}
       WHERE live_events.slug = ?
         AND live_events.status IN ('published', 'closed')
       LIMIT 1`,
    )
    .bind(slug)
    .first<LiveEventRow>();
  return row ? mapEvent(row) : null;
}

export async function fetchLiveClaim(
  db: D1ReadClient,
  eventId: string,
  accessCodeHash: string,
  address: Address,
): Promise<LiveClaimRecord | null> {
  const row = await db
    .prepare(
      `SELECT
         code_hash,
         claimed_at,
         claimed_by,
         mint_nonce,
         mint_authorization_deadline,
         minted_tx_hash,
         relay_started_at,
         relay_tx_hash
       FROM live_claim_codes
       WHERE event_id = ?
         AND access_code_hash = ?
         AND claimed_by = ?
       LIMIT 1`,
    )
    .bind(eventId, accessCodeHash, address)
    .first<LiveClaimRow>();
  return row?.mint_nonce && row.mint_authorization_deadline ? mapClaim(row) : null;
}

export async function reserveLiveClaim(
  db: D1Database,
  eventId: string,
  accessCodeHash: string,
  address: Address,
  mintNonce: Hash,
  mintAuthorizationDeadline: number,
): Promise<LiveClaimRecord | null> {
  const claimedAt = new Date().toISOString();
  const row = await db
    .prepare(
      `UPDATE live_claim_codes
       SET
         claimed_by = ?,
         claimed_at = ?,
         mint_nonce = ?,
         mint_authorization_deadline = ?
       WHERE code_hash = (
           SELECT available.code_hash
           FROM live_claim_codes available
           WHERE available.event_id = ?
             AND available.access_code_hash = ?
             AND available.claimed_by IS NULL
             AND available.reservation_id IS NULL
           ORDER BY available.code_hash
           LIMIT 1
         )
         AND NOT EXISTS (
           SELECT 1
           FROM live_claim_codes existing
           WHERE existing.event_id = ?
             AND existing.claimed_by = ?
         )
         AND EXISTS (
           SELECT 1
           FROM live_events
           WHERE live_events.event_id = live_claim_codes.event_id
             AND status = 'published'
             AND claim_opens_at <= ?
             AND claim_closes_at >= ?
         )
       RETURNING
         code_hash,
         claimed_at,
         claimed_by,
         mint_nonce,
         mint_authorization_deadline,
         minted_tx_hash,
         relay_started_at,
         relay_tx_hash`,
    )
    .bind(
      address,
      claimedAt,
      mintNonce,
      mintAuthorizationDeadline,
      eventId,
      accessCodeHash,
      eventId,
      address,
      claimedAt,
      claimedAt,
    )
    .first<LiveClaimRow>();
  return row ? mapClaim(row) : null;
}

export async function refreshLiveClaimAuthorization(
  db: D1Database,
  eventId: string,
  accessCodeHash: string,
  address: Address,
  deadline: number,
): Promise<LiveClaimRecord | null> {
  const row = await db
    .prepare(
      `UPDATE live_claim_codes
       SET mint_authorization_deadline = ?
       WHERE event_id = ?
         AND access_code_hash = ?
         AND claimed_by = ?
         AND mint_nonce IS NOT NULL
         AND minted_tx_hash IS NULL
       RETURNING
         code_hash,
         claimed_at,
         claimed_by,
         mint_nonce,
         mint_authorization_deadline,
         minted_tx_hash,
         relay_started_at,
         relay_tx_hash`,
    )
    .bind(deadline, eventId, accessCodeHash, address)
    .first<LiveClaimRow>();
  return row ? mapClaim(row) : null;
}

export async function markLiveClaimMinted(
  db: D1Database,
  eventId: string,
  accessCodeHash: string,
  address: Address,
  transactionHash: Hash,
): Promise<{ mintedAt: string } | null> {
  const mintedAt = new Date().toISOString();
  const row = await db
    .prepare(
      `UPDATE live_claim_codes
       SET minted_tx_hash = ?, minted_at = ?
       WHERE event_id = ?
         AND access_code_hash = ?
         AND claimed_by = ?
         AND (minted_tx_hash IS NULL OR minted_tx_hash = ?)
       RETURNING minted_at`,
    )
    .bind(transactionHash, mintedAt, eventId, accessCodeHash, address, transactionHash)
    .first<{ minted_at: string }>();
  return row ? { mintedAt: row.minted_at } : null;
}

export async function beginLiveClaimRelay(
  db: D1Database,
  eventId: string,
  accessCodeHash: string,
  address: Address,
  startedAt: string,
  staleBefore: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE live_claim_codes
       SET relay_started_at = ?, relay_tx_hash = NULL
       WHERE event_id = ?
         AND access_code_hash = ?
         AND claimed_by = ?
         AND minted_tx_hash IS NULL
         AND relay_tx_hash IS NULL
         AND (relay_started_at IS NULL OR relay_started_at < ?)
       RETURNING code_hash`,
    )
    .bind(startedAt, eventId, accessCodeHash, address, staleBefore)
    .first<{ code_hash: string }>();
  return row !== null;
}

export async function recordLiveClaimRelayTransaction(
  db: D1Database,
  eventId: string,
  accessCodeHash: string,
  address: Address,
  startedAt: string,
  transactionHash: Hash,
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE live_claim_codes
       SET relay_tx_hash = ?
       WHERE event_id = ?
         AND access_code_hash = ?
         AND claimed_by = ?
         AND relay_started_at = ?
         AND minted_tx_hash IS NULL
         AND relay_tx_hash IS NULL
       RETURNING code_hash`,
    )
    .bind(transactionHash, eventId, accessCodeHash, address, startedAt)
    .first<{ code_hash: string }>();
  return row !== null;
}

export async function releaseLiveClaimRelay(
  db: D1Database,
  eventId: string,
  accessCodeHash: string,
  address: Address,
  startedAt: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE live_claim_codes
       SET relay_started_at = NULL
       WHERE event_id = ?
         AND access_code_hash = ?
         AND claimed_by = ?
         AND relay_started_at = ?
         AND relay_tx_hash IS NULL`,
    )
    .bind(eventId, accessCodeHash, address, startedAt)
    .run();
}

export async function fetchLiveHoldings(
  db: D1ReadClient,
  address: string,
): Promise<LiveHoldingRecord[]> {
  const result = await db
    .prepare(
      `WITH
       events AS (${EVENT_SELECT}),
       claim_holdings AS (
         SELECT
           events.*,
           codes.claimed_at,
           COALESCE(codes.minted_tx_hash, codes.relay_tx_hash) AS minted_tx_hash,
           COALESCE(codes.minted_at, codes.relay_started_at) AS minted_at,
           'claim-record' AS ownership_source,
           NULL AS chain_synced_at,
           NULL AS chain_finalized_block
         FROM events
         JOIN live_claim_codes codes ON codes.event_id = events.event_id
         WHERE codes.claimed_by = ?
           AND (codes.minted_tx_hash IS NOT NULL OR codes.relay_tx_hash IS NOT NULL)
           AND NOT EXISTS (
             SELECT 1
             FROM live_chain_events indexed_mint
             WHERE indexed_mint.chain_id = events.chain_id
               AND indexed_mint.contract_address = events.contract_address
               AND indexed_mint.transaction_hash = COALESCE(
                 codes.minted_tx_hash,
                 codes.relay_tx_hash
               )
           )
       ),
       indexed_holdings AS (
         SELECT
           events.*,
           balances.first_acquired_at AS claimed_at,
           balances.last_transaction_hash AS minted_tx_hash,
           balances.updated_at AS minted_at,
           'chain-index' AS ownership_source,
           cursor.last_synced_at AS chain_synced_at,
           cursor.last_finalized_block AS chain_finalized_block
         FROM events
         JOIN live_token_balances balances
           ON balances.chain_id = events.chain_id
          AND balances.contract_address = events.contract_address
          AND balances.token_id = events.token_id
         JOIN live_chain_cursors cursor
           ON cursor.chain_id = balances.chain_id
          AND cursor.contract_address = balances.contract_address
         WHERE balances.owner_address = ?
           AND balances.balance > 0
           AND cursor.last_synced_at IS NOT NULL
           AND cursor.last_finalized_block IS NOT NULL
           AND cursor.next_block > cursor.last_finalized_block
       )
       SELECT
         * FROM claim_holdings
       UNION ALL
       SELECT
         * FROM indexed_holdings
       ORDER BY claimed_at DESC, event_id`,
    )
    .bind(address, address)
    .all<LiveHoldingRow>();
  return result.results.map((row) => ({
    ...mapEvent(row),
    claimedAt: row.claimed_at,
    mintStatus: row.minted_tx_hash ? "minted" : "reserved",
    mintedTxHash: row.minted_tx_hash,
    mintedAt: row.minted_at,
    ownershipSource: row.ownership_source,
    chainSyncedAt: row.chain_synced_at,
    chainFinalizedBlock: row.chain_finalized_block,
  }));
}

export async function fetchLiveCollectors(
  db: D1ReadClient,
  slug: string,
): Promise<LiveCollectorsRecord | null> {
  const event = await fetchLiveEvent(db, slug);
  if (!event) return null;

  const result = await db
    .prepare(
      `WITH
       claim_collectors AS (
         SELECT
           lower(codes.claimed_by) AS owner_address,
           COALESCE(codes.minted_at, codes.relay_started_at, codes.claimed_at) AS acquired_at
         FROM live_claim_codes codes
         WHERE codes.event_id = ?
           AND codes.claimed_by IS NOT NULL
           AND (codes.minted_tx_hash IS NOT NULL OR codes.relay_tx_hash IS NOT NULL)
           AND NOT EXISTS (
             SELECT 1
             FROM live_chain_events indexed_mint
             WHERE indexed_mint.chain_id = ?
               AND indexed_mint.contract_address = ?
               AND indexed_mint.transaction_hash = COALESCE(
                 codes.minted_tx_hash,
                 codes.relay_tx_hash
               )
           )
       ),
       indexed_collectors AS (
         SELECT
           lower(balances.owner_address) AS owner_address,
           balances.first_acquired_at AS acquired_at
         FROM live_token_balances balances
         JOIN live_chain_cursors cursor
           ON cursor.chain_id = balances.chain_id
          AND cursor.contract_address = balances.contract_address
         WHERE balances.chain_id = ?
           AND balances.contract_address = ?
           AND balances.token_id = ?
           AND balances.balance > 0
           AND cursor.last_synced_at IS NOT NULL
           AND cursor.last_finalized_block IS NOT NULL
           AND cursor.next_block > cursor.last_finalized_block
       ),
       collectors AS (
         SELECT owner_address, acquired_at FROM claim_collectors
         UNION ALL
         SELECT owner_address, acquired_at FROM indexed_collectors
       )
       SELECT owner_address, MIN(acquired_at) AS acquired_at
       FROM collectors
       GROUP BY owner_address
       ORDER BY acquired_at ASC, owner_address ASC
       LIMIT 1000`,
    )
    .bind(
      event.eventId,
      event.chainId,
      event.contractAddress,
      event.chainId,
      event.contractAddress,
      event.tokenId,
    )
    .all<{ owner_address: string; acquired_at: string }>();

  const items = result.results.map((row) => ({
    ownerAddress: row.owner_address,
    acquiredAt: row.acquired_at,
  }));
  return {
    eventId: event.eventId,
    slug: event.slug,
    chainId: event.chainId,
    collectorCount: items.length,
    items,
  };
}

function mapEvent(row: LiveEventRow): LiveEventRecord {
  return {
    eventId: row.event_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    eventUrl: row.event_url,
    startsAt: row.starts_at,
    claimOpensAt: row.claim_opens_at,
    claimClosesAt: row.claim_closes_at,
    chainId: row.chain_id,
    contractAddress: row.contract_address,
    tokenId: row.token_id,
    maxSupply: row.max_supply,
    claimedCount: row.claimed_count,
    mintedCount: row.minted_count,
    claimMode: row.claim_mode,
    status: row.status,
  };
}

function mapClaim(row: LiveClaimRow): LiveClaimRecord {
  return {
    codeHash: row.code_hash,
    claimedAt: row.claimed_at,
    claimedBy: row.claimed_by,
    mintNonce: row.mint_nonce,
    mintAuthorizationDeadline: row.mint_authorization_deadline,
    mintedTxHash: row.minted_tx_hash,
    relayStartedAt: row.relay_started_at,
    relayTxHash: row.relay_tx_hash,
  };
}
