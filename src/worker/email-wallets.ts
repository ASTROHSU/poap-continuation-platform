import type { Address } from "viem";
import type { D1ReadClient } from "./types";

export type EmailWalletProvider = "magic-pregen";
export type EmailWalletStatus = "provisioning" | "ready" | "failed";

export interface EmailWalletRecord {
  provider: EmailWalletProvider;
  status: EmailWalletStatus;
  address: Address | null;
  attemptCount: number;
  lastErrorCode: string | null;
  updatedAt: string;
}

export interface MagicEmailIdentityRecord {
  emailHmac: string;
  address: Address;
  verifiedAt: string;
  updatedAt: string;
}

interface MagicEmailIdentityRow {
  email_hmac: string;
  address: Address;
  verified_at: string;
  updated_at: string;
}

interface ReservationReconciliationRow {
  reserved_code_hash: string;
  claimed_code_hash: string;
  reservation_id: string;
  reserved_at: string;
}

interface EmailWalletRow {
  provider: EmailWalletProvider;
  status: EmailWalletStatus;
  address: Address | null;
  attempt_count: number;
  last_error_code: string | null;
  updated_at: string;
}

export async function recordMagicEmailIdentity(
  db: D1Database,
  input: { emailHmac: string; address: Address },
): Promise<MagicEmailIdentityRecord | null> {
  const verifiedAt = new Date().toISOString();
  const row = await db
    .prepare(
      `INSERT INTO live_magic_email_identities (
         email_hmac, address, verified_at, updated_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(email_hmac) DO UPDATE SET
         verified_at = excluded.verified_at,
         updated_at = excluded.updated_at
       WHERE live_magic_email_identities.address = excluded.address
       RETURNING email_hmac, address, verified_at, updated_at`,
    )
    .bind(input.emailHmac, input.address, verifiedAt, verifiedAt)
    .first<MagicEmailIdentityRow>();
  return row ? mapMagicEmailIdentity(row) : null;
}

export async function fetchMagicEmailIdentityByAddress(
  db: D1ReadClient,
  address: Address,
): Promise<MagicEmailIdentityRecord | null> {
  const row = await db
    .prepare(
      `SELECT email_hmac, address, verified_at, updated_at
       FROM live_magic_email_identities
       WHERE address = ?
       LIMIT 1`,
    )
    .bind(address)
    .first<MagicEmailIdentityRow>();
  return row ? mapMagicEmailIdentity(row) : null;
}

/**
 * A collector may reserve by Email and later mint the same event through the
 * direct Magic claim flow. Move the Email reservation onto that already-owned
 * claim so the UI has one canonical record and the unused slot returns to the
 * shared pool.
 */
export async function reconcileEmailReservationsForWallet(
  db: D1Database,
  input: { emailHmac: string; address: Address },
): Promise<number> {
  const result = await db
    .prepare(
      `SELECT
         reserved.code_hash AS reserved_code_hash,
         claimed.code_hash AS claimed_code_hash,
         reserved.reservation_id,
         reserved.reserved_at
       FROM live_claim_codes reserved
       JOIN live_claim_codes claimed
         ON claimed.event_id = reserved.event_id
        AND claimed.claimed_by = ?
       WHERE reserved.reserved_email_hmac = ?
         AND reserved.reservation_id IS NOT NULL
         AND reserved.code_hash <> claimed.code_hash
         AND claimed.reservation_id IS NULL
       ORDER BY reserved.reserved_at, reserved.code_hash`,
    )
    .bind(input.address, input.emailHmac)
    .all<ReservationReconciliationRow>();

  if (result.results.length === 0) return 0;
  const statements: D1PreparedStatement[] = [];
  for (const item of result.results) {
    statements.push(
      db
        .prepare(
          `UPDATE live_claim_codes
           SET reservation_id = NULL, reserved_email_hmac = NULL, reserved_at = NULL
           WHERE code_hash = ?
             AND reservation_id = ?
             AND reserved_email_hmac = ?`,
        )
        .bind(item.reserved_code_hash, item.reservation_id, input.emailHmac),
      db
        .prepare(
          `UPDATE live_claim_codes
           SET reservation_id = ?, reserved_email_hmac = ?, reserved_at = ?
           WHERE code_hash = ?
             AND claimed_by = ?
             AND reservation_id IS NULL`,
        )
        .bind(
          item.reservation_id,
          input.emailHmac,
          item.reserved_at,
          item.claimed_code_hash,
          input.address,
        ),
    );
  }
  await db.batch(statements);
  return result.results.length;
}

export async function fetchEmailWallet(
  db: D1ReadClient,
  emailHmac: string,
): Promise<EmailWalletRecord | null> {
  const row = await db
    .prepare(
      `SELECT provider, status, address, attempt_count, last_error_code, updated_at
       FROM live_email_wallets
       WHERE email_hmac = ?
       LIMIT 1`,
    )
    .bind(emailHmac)
    .first<EmailWalletRow>();
  return row ? mapEmailWallet(row) : null;
}

export async function beginEmailWalletProvisioning(
  db: D1Database,
  input: {
    emailHmac: string;
    provider: EmailWalletProvider;
    startedAt: string;
    staleBefore: string;
  },
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO live_email_wallets (
         email_hmac, provider, status, address, attempt_count,
         provisioning_started_at, last_error_code, last_error_at,
         created_at, updated_at
       ) VALUES (?, ?, 'provisioning', NULL, 1, ?, NULL, NULL, ?, ?)
       ON CONFLICT(email_hmac) DO UPDATE SET
         status = 'provisioning',
         attempt_count = live_email_wallets.attempt_count + 1,
         provisioning_started_at = excluded.provisioning_started_at,
         last_error_code = NULL,
         last_error_at = NULL,
         updated_at = excluded.updated_at
       WHERE live_email_wallets.provider = excluded.provider
         AND live_email_wallets.address IS NULL
         AND (
           live_email_wallets.status <> 'provisioning' OR
           live_email_wallets.provisioning_started_at < ?
         )
       RETURNING email_hmac`,
    )
    .bind(
      input.emailHmac,
      input.provider,
      input.startedAt,
      input.startedAt,
      input.startedAt,
      input.staleBefore,
    )
    .first<{ email_hmac: string }>();
  return row !== null;
}

export async function recordEmailWalletReady(
  db: D1Database,
  input: {
    emailHmac: string;
    provider: EmailWalletProvider;
    startedAt: string;
    address: Address;
  },
): Promise<boolean> {
  const updatedAt = new Date().toISOString();
  const row = await db
    .prepare(
      `UPDATE live_email_wallets
       SET status = 'ready', address = ?, provisioning_started_at = NULL,
           last_error_code = NULL, last_error_at = NULL, updated_at = ?
       WHERE email_hmac = ?
         AND provider = ?
         AND status = 'provisioning'
         AND provisioning_started_at = ?
       RETURNING email_hmac`,
    )
    .bind(input.address, updatedAt, input.emailHmac, input.provider, input.startedAt)
    .first<{ email_hmac: string }>();
  return row !== null;
}

export async function recordEmailWalletFailure(
  db: D1Database,
  input: {
    emailHmac: string;
    provider: EmailWalletProvider;
    startedAt: string;
    errorCode: string;
  },
): Promise<void> {
  const failedAt = new Date().toISOString();
  await db
    .prepare(
      `UPDATE live_email_wallets
       SET status = 'failed', provisioning_started_at = NULL,
           last_error_code = ?, last_error_at = ?, updated_at = ?
       WHERE email_hmac = ?
         AND provider = ?
         AND status = 'provisioning'
         AND provisioning_started_at = ?`,
    )
    .bind(input.errorCode, failedAt, failedAt, input.emailHmac, input.provider, input.startedAt)
    .run();
}

function mapEmailWallet(row: EmailWalletRow): EmailWalletRecord {
  return {
    provider: row.provider,
    status: row.status,
    address: row.address,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    updatedAt: row.updated_at,
  };
}

function mapMagicEmailIdentity(row: MagicEmailIdentityRow): MagicEmailIdentityRecord {
  return {
    emailHmac: row.email_hmac,
    address: row.address,
    verifiedAt: row.verified_at,
    updatedAt: row.updated_at,
  };
}
