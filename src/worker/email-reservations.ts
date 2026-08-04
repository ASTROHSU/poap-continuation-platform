import type { Address, Hash } from "viem";
import type { D1ReadClient } from "./types";
import type { LiveClaimRecord, LiveEventRecord } from "./live";

export interface EmailChallengeRecord {
  challengeId: string;
  purpose: "reserve" | "login";
  eventId: string | null;
  accessCodeHash: string | null;
  emailHmac: string;
  emailCiphertext: string;
  emailIv: string;
}

interface EmailChallengeRow {
  challenge_id: string;
  purpose: "reserve" | "login";
  event_id: string | null;
  access_code_hash: string | null;
  email_hmac: string;
  email_ciphertext: string;
  email_iv: string;
}

export interface EmailReservationRecord {
  reservationId: string;
  reservedAt: string;
  boundAddress: Address | null;
  claimedAt: string | null;
  mintNonce: Hash | null;
  mintAuthorizationDeadline: number | null;
  mintedTxHash: Hash | null;
  mintedAt: string | null;
  relayStartedAt: string | null;
  relayTxHash: Hash | null;
  event: LiveEventRecord;
}

interface EmailReservationRow {
  reservation_id: string;
  reserved_at: string;
  claimed_by: Address | null;
  claimed_at: string | null;
  mint_nonce: Hash | null;
  mint_authorization_deadline: number | null;
  minted_tx_hash: Hash | null;
  minted_at: string | null;
  relay_started_at: string | null;
  relay_tx_hash: Hash | null;
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

const EMAIL_RESERVATION_SELECT = `
  SELECT
    codes.reservation_id,
    codes.reserved_at,
    codes.claimed_by,
    codes.claimed_at,
    codes.mint_nonce,
    codes.mint_authorization_deadline,
    codes.minted_tx_hash,
    codes.minted_at,
    codes.relay_started_at,
    codes.relay_tx_hash,
    events.event_id,
    events.slug,
    events.title,
    events.description,
    events.image_url,
    events.event_url,
    events.starts_at,
    events.claim_opens_at,
    events.claim_closes_at,
    events.chain_id,
    events.contract_address,
    events.token_id,
    events.max_supply,
    events.claim_mode,
    events.status,
    (
      SELECT COUNT(*) FROM live_claim_codes count_codes
      WHERE count_codes.event_id = events.event_id
        AND (count_codes.claimed_by IS NOT NULL OR count_codes.reservation_id IS NOT NULL)
    ) AS claimed_count,
    (
      SELECT COUNT(*) FROM live_claim_codes mint_codes
      WHERE mint_codes.event_id = events.event_id
        AND mint_codes.minted_tx_hash IS NOT NULL
    ) AS minted_count
  FROM live_claim_codes codes
  JOIN live_events events ON events.event_id = codes.event_id
`;

export async function hasAvailableEmailClaimSlot(
  db: D1ReadClient,
  eventId: string,
  accessCodeHash: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS available
       FROM live_claim_codes
       WHERE event_id = ?
         AND access_code_hash = ?
         AND claimed_by IS NULL
         AND reservation_id IS NULL
       LIMIT 1`,
    )
    .bind(eventId, accessCodeHash)
    .first<{ available: number }>();
  return row?.available === 1;
}

export async function createEmailChallenge(
  db: D1Database,
  input: {
    challengeId: string;
    purpose: "reserve" | "login";
    eventId: string | null;
    accessCodeHash: string | null;
    emailHmac: string;
    emailCiphertext: string;
    emailIv: string;
    tokenHash: string;
    expiresAt: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO live_email_challenges (
         challenge_id, purpose, event_id, access_code_hash, email_hmac,
         email_ciphertext, email_iv, token_hash, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.challengeId,
      input.purpose,
      input.eventId,
      input.accessCodeHash,
      input.emailHmac,
      input.emailCiphertext,
      input.emailIv,
      input.tokenHash,
      input.expiresAt,
    )
    .run();
}

export async function fetchValidEmailChallenge(
  db: D1ReadClient,
  tokenHash: string,
  now: number,
): Promise<EmailChallengeRecord | null> {
  const row = await db
    .prepare(
      `SELECT challenge_id, purpose, event_id, access_code_hash, email_hmac,
              email_ciphertext, email_iv
       FROM live_email_challenges
       WHERE token_hash = ?
         AND consumed_at IS NULL
         AND expires_at >= ?
       LIMIT 1`,
    )
    .bind(tokenHash, now)
    .first<EmailChallengeRow>();
  return row
    ? {
        challengeId: row.challenge_id,
        purpose: row.purpose,
        eventId: row.event_id,
        accessCodeHash: row.access_code_hash,
        emailHmac: row.email_hmac,
        emailCiphertext: row.email_ciphertext,
        emailIv: row.email_iv,
      }
    : null;
}

export async function reserveClaimForVerifiedEmail(
  db: D1Database,
  challenge: EmailChallengeRecord,
): Promise<EmailReservationRecord | null> {
  if (!challenge.eventId || !challenge.accessCodeHash) return null;
  const reservedAt = new Date().toISOString();
  await db
    .prepare(
      `UPDATE live_claim_codes
       SET reservation_id = ?, reserved_email_hmac = ?, reserved_at = ?
       WHERE code_hash = (
         SELECT available.code_hash
         FROM live_claim_codes available
         JOIN live_events event ON event.event_id = available.event_id
         WHERE available.event_id = ?
           AND available.access_code_hash = ?
           AND available.claimed_by IS NULL
           AND available.reservation_id IS NULL
           AND event.status = 'published'
           AND event.claim_opens_at <= ?
           AND event.claim_closes_at >= ?
         ORDER BY available.code_hash
         LIMIT 1
       )
       AND NOT EXISTS (
         SELECT 1 FROM live_claim_codes existing
         WHERE existing.event_id = ?
           AND existing.reserved_email_hmac = ?
       )`,
    )
    .bind(
      challenge.challengeId,
      challenge.emailHmac,
      reservedAt,
      challenge.eventId,
      challenge.accessCodeHash,
      reservedAt,
      reservedAt,
      challenge.eventId,
      challenge.emailHmac,
    )
    .run();
  return fetchEmailReservationByEvent(db, challenge.eventId, challenge.emailHmac);
}

export async function consumeChallengeAndCreateSession(
  db: D1Database,
  input: {
    challengeId: string;
    tokenHash: string;
    sessionHash: string;
    emailHmac: string;
    sessionExpiresAt: number;
    now: number;
  },
): Promise<boolean> {
  const consumedAt = new Date().toISOString();
  const [sessionResult] = await db.batch([
    db
      .prepare(
        `INSERT INTO live_email_sessions (session_hash, email_hmac, expires_at)
         SELECT ?, email_hmac, ?
         FROM live_email_challenges
         WHERE challenge_id = ?
           AND token_hash = ?
           AND email_hmac = ?
           AND consumed_at IS NULL
           AND expires_at >= ?`,
      )
      .bind(
        input.sessionHash,
        input.sessionExpiresAt,
        input.challengeId,
        input.tokenHash,
        input.emailHmac,
        input.now,
      ),
    db
      .prepare(
        `UPDATE live_email_challenges
         SET consumed_at = ?
         WHERE challenge_id = ?
           AND token_hash = ?
           AND consumed_at IS NULL
           AND expires_at >= ?`,
      )
      .bind(consumedAt, input.challengeId, input.tokenHash, input.now),
  ]);
  return Number(sessionResult.meta.changes) === 1;
}

export async function createEmailSession(
  db: D1Database,
  input: { sessionHash: string; emailHmac: string; expiresAt: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO live_email_sessions (session_hash, email_hmac, expires_at)
       VALUES (?, ?, ?)`,
    )
    .bind(input.sessionHash, input.emailHmac, input.expiresAt)
    .run();
}

export async function fetchSessionEmailHmac(
  db: D1ReadClient,
  sessionHash: string,
  now: number,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT email_hmac
       FROM live_email_sessions
       WHERE session_hash = ?
         AND revoked_at IS NULL
         AND expires_at >= ?
       LIMIT 1`,
    )
    .bind(sessionHash, now)
    .first<{ email_hmac: string }>();
  return row?.email_hmac ?? null;
}

export async function revokeEmailSession(db: D1Database, sessionHash: string): Promise<void> {
  await db
    .prepare(
      `UPDATE live_email_sessions
       SET revoked_at = ?
       WHERE session_hash = ? AND revoked_at IS NULL`,
    )
    .bind(new Date().toISOString(), sessionHash)
    .run();
}

export async function pruneExpiredEmailAuthArtifacts(
  db: D1Database,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<{ challenges: number; sessions: number }> {
  const retainUntil = nowSeconds - 24 * 60 * 60;
  const results = await db.batch([
    db.prepare("DELETE FROM live_email_challenges WHERE expires_at < ?").bind(retainUntil),
    db.prepare("DELETE FROM live_email_sessions WHERE expires_at < ?").bind(retainUntil),
  ]);
  return {
    challenges: Number(results[0]?.meta.changes ?? 0),
    sessions: Number(results[1]?.meta.changes ?? 0),
  };
}

export async function fetchEmailReservations(
  db: D1ReadClient,
  emailHmac: string,
): Promise<EmailReservationRecord[]> {
  const result = await db
    .prepare(
      `${EMAIL_RESERVATION_SELECT}
       WHERE codes.reserved_email_hmac = ?
         AND codes.reservation_id IS NOT NULL
       ORDER BY codes.reserved_at DESC, events.event_id`,
    )
    .bind(emailHmac)
    .all<EmailReservationRow>();
  return result.results.map(mapEmailReservation);
}

export async function fetchEmailReservation(
  db: D1ReadClient,
  reservationId: string,
  emailHmac: string,
): Promise<EmailReservationRecord | null> {
  const row = await db
    .prepare(
      `${EMAIL_RESERVATION_SELECT}
       WHERE codes.reservation_id = ?
         AND codes.reserved_email_hmac = ?
       LIMIT 1`,
    )
    .bind(reservationId, emailHmac)
    .first<EmailReservationRow>();
  return row ? mapEmailReservation(row) : null;
}

export async function bindEmailReservationWallet(
  db: D1Database,
  input: {
    reservationId: string;
    emailHmac: string;
    address: Address;
    mintNonce: Hash;
    deadline: number;
  },
): Promise<EmailReservationRecord | null> {
  const claimedAt = new Date().toISOString();
  await db
    .prepare(
      `UPDATE live_claim_codes
       SET claimed_by = ?, claimed_at = ?, mint_nonce = ?, mint_authorization_deadline = ?
       WHERE reservation_id = ?
         AND reserved_email_hmac = ?
         AND minted_tx_hash IS NULL
         AND (claimed_by IS NULL OR claimed_by = ?)
         AND EXISTS (
           SELECT 1 FROM live_events
           WHERE live_events.event_id = live_claim_codes.event_id
             AND live_events.status IN ('published', 'closed')
         )`,
    )
    .bind(
      input.address,
      claimedAt,
      input.mintNonce,
      input.deadline,
      input.reservationId,
      input.emailHmac,
      input.address,
    )
    .run();
  return fetchEmailReservation(db, input.reservationId, input.emailHmac);
}

export async function refreshEmailReservationAuthorization(
  db: D1Database,
  reservationId: string,
  emailHmac: string,
  deadline: number,
): Promise<EmailReservationRecord | null> {
  await db
    .prepare(
      `UPDATE live_claim_codes
       SET mint_authorization_deadline = ?
       WHERE reservation_id = ?
         AND reserved_email_hmac = ?
         AND mint_nonce IS NOT NULL
         AND minted_tx_hash IS NULL`,
    )
    .bind(deadline, reservationId, emailHmac)
    .run();
  return fetchEmailReservation(db, reservationId, emailHmac);
}

export async function markEmailReservationMinted(
  db: D1Database,
  reservationId: string,
  emailHmac: string,
  address: Address,
  transactionHash: Hash,
): Promise<{ mintedAt: string } | null> {
  const mintedAt = new Date().toISOString();
  const row = await db
    .prepare(
      `UPDATE live_claim_codes
       SET minted_tx_hash = ?, minted_at = ?
       WHERE reservation_id = ?
         AND reserved_email_hmac = ?
         AND claimed_by = ?
         AND (minted_tx_hash IS NULL OR minted_tx_hash = ?)
       RETURNING minted_at`,
    )
    .bind(transactionHash, mintedAt, reservationId, emailHmac, address, transactionHash)
    .first<{ minted_at: string }>();
  return row ? { mintedAt: row.minted_at } : null;
}

export async function beginEmailReservationRelay(
  db: D1Database,
  reservationId: string,
  emailHmac: string,
  address: Address,
  startedAt: string,
  staleBefore: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE live_claim_codes
       SET relay_started_at = ?, relay_tx_hash = NULL
       WHERE reservation_id = ?
         AND reserved_email_hmac = ?
         AND claimed_by = ?
         AND minted_tx_hash IS NULL
         AND relay_tx_hash IS NULL
         AND (relay_started_at IS NULL OR relay_started_at < ?)
       RETURNING code_hash`,
    )
    .bind(startedAt, reservationId, emailHmac, address, staleBefore)
    .first<{ code_hash: string }>();
  return row !== null;
}

export async function recordEmailReservationRelayTransaction(
  db: D1Database,
  reservationId: string,
  emailHmac: string,
  address: Address,
  startedAt: string,
  transactionHash: Hash,
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE live_claim_codes
       SET relay_tx_hash = ?
       WHERE reservation_id = ?
         AND reserved_email_hmac = ?
         AND claimed_by = ?
         AND relay_started_at = ?
         AND minted_tx_hash IS NULL
         AND relay_tx_hash IS NULL
       RETURNING code_hash`,
    )
    .bind(transactionHash, reservationId, emailHmac, address, startedAt)
    .first<{ code_hash: string }>();
  return row !== null;
}

export async function releaseEmailReservationRelay(
  db: D1Database,
  reservationId: string,
  emailHmac: string,
  address: Address,
  startedAt: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE live_claim_codes
       SET relay_started_at = NULL
       WHERE reservation_id = ?
         AND reserved_email_hmac = ?
         AND claimed_by = ?
         AND relay_started_at = ?
         AND relay_tx_hash IS NULL`,
    )
    .bind(reservationId, emailHmac, address, startedAt)
    .run();
}

function fetchEmailReservationByEvent(
  db: D1ReadClient,
  eventId: string,
  emailHmac: string,
): Promise<EmailReservationRecord | null> {
  return db
    .prepare(
      `${EMAIL_RESERVATION_SELECT}
       WHERE codes.event_id = ?
         AND codes.reserved_email_hmac = ?
       LIMIT 1`,
    )
    .bind(eventId, emailHmac)
    .first<EmailReservationRow>()
    .then((row) => (row ? mapEmailReservation(row) : null));
}

function mapEmailReservation(row: EmailReservationRow): EmailReservationRecord {
  return {
    reservationId: row.reservation_id,
    reservedAt: row.reserved_at,
    boundAddress: row.claimed_by,
    claimedAt: row.claimed_at,
    mintNonce: row.mint_nonce,
    mintAuthorizationDeadline: row.mint_authorization_deadline,
    mintedTxHash: row.minted_tx_hash,
    mintedAt: row.minted_at,
    relayStartedAt: row.relay_started_at,
    relayTxHash: row.relay_tx_hash,
    event: {
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
    },
  };
}

export function asLiveClaimRecord(reservation: EmailReservationRecord): LiveClaimRecord | null {
  if (
    !reservation.boundAddress ||
    !reservation.claimedAt ||
    !reservation.mintNonce ||
    !reservation.mintAuthorizationDeadline
  ) {
    return null;
  }
  return {
    claimedAt: reservation.claimedAt,
    claimedBy: reservation.boundAddress,
    mintNonce: reservation.mintNonce,
    mintAuthorizationDeadline: reservation.mintAuthorizationDeadline,
    mintedTxHash: reservation.mintedTxHash,
    relayStartedAt: reservation.relayStartedAt,
    relayTxHash: reservation.relayTxHash,
  };
}
