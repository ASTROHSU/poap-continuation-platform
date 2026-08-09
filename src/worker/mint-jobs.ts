import { getAddress, type Address, type Hash, type Hex } from "viem";
import type { MintAuthorization } from "./minting";
import type { LiveEventRecord } from "./live";
import type { Bindings } from "./types";

export type MintJobStatus =
  "pending" | "submitting" | "submitted" | "retry" | "confirmed" | "failed";

export interface MintJobRecord {
  jobId: string;
  idempotencyKey: string;
  shardKey: string;
  eventId: string;
  claimCodeHash: string;
  recipient: Address;
  chainId: number;
  relayerAddress: Address;
  contractAddress: Address;
  tokenId: string;
  authorizationDeadline: number;
  authorizationNonce: Hash;
  authorizationSignature: Hex;
  status: MintJobStatus;
  networkNonce: number | null;
  transactionHash: Hash | null;
  attemptCount: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
}

interface MintJobRow {
  job_id: string;
  idempotency_key: string;
  shard_key: string;
  event_id: string;
  claim_code_hash: string;
  recipient: Address;
  chain_id: number;
  relayer_address: Address;
  contract_address: Address;
  token_id: string;
  authorization_deadline: number;
  authorization_nonce: Hash;
  authorization_signature: Hex;
  status: MintJobStatus;
  network_nonce: number | null;
  transaction_hash: Hash | null;
  attempt_count: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  confirmed_at: string | null;
}

const JOB_SELECT = `
  SELECT job_id, idempotency_key, shard_key, event_id, claim_code_hash,
         recipient, chain_id, relayer_address, contract_address, token_id,
         authorization_deadline, authorization_nonce, authorization_signature,
         status, network_nonce, transaction_hash, attempt_count, next_attempt_at,
         last_error, created_at, updated_at, submitted_at, confirmed_at
  FROM live_mint_jobs`;

export async function mintJobIdempotencyKey(input: {
  eventId: string;
  recipient: Address;
  claimCodeHash: string;
  authorizationNonce: Hash;
}): Promise<string> {
  const canonical = [
    input.eventId,
    input.recipient.toLowerCase(),
    input.claimCodeHash,
    input.authorizationNonce.toLowerCase(),
  ].join(":");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function mintRelayShardKey(chainId: number, relayerAddress: Address): string {
  return `${chainId}:${relayerAddress.toLowerCase()}`;
}

export async function createOrReuseMintJob(
  db: D1Database,
  input: {
    event: LiveEventRecord;
    claimCodeHash: string;
    recipient: Address;
    relayerAddress: Address;
    authorization: MintAuthorization;
  },
): Promise<MintJobRecord> {
  if (!input.event.contractAddress || input.event.tokenId === null) {
    throw new Error("Onchain minting is not configured.");
  }
  const idempotencyKey = await mintJobIdempotencyKey({
    eventId: input.event.eventId,
    recipient: input.recipient,
    claimCodeHash: input.claimCodeHash,
    authorizationNonce: input.authorization.nonce,
  });
  const existing = await fetchMintJobByIdempotencyKey(
    db.withSession("first-primary"),
    idempotencyKey,
  );
  if (existing) {
    await refreshMintJobAuthorization(db, existing.jobId, input.authorization);
    if (existing.status === "failed") await reactivateMintJob(db, existing.jobId);
    return (await fetchMintJob(db.withSession("first-primary"), existing.jobId)) ?? existing;
  }

  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const shardKey = mintRelayShardKey(input.event.chainId, input.relayerAddress);
  try {
    await db
      .prepare(
        `INSERT INTO live_mint_jobs (
           job_id, idempotency_key, shard_key, event_id, claim_code_hash, recipient,
           chain_id, relayer_address, contract_address, token_id,
           authorization_deadline, authorization_nonce, authorization_signature,
           status, next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(
        jobId,
        idempotencyKey,
        shardKey,
        input.event.eventId,
        input.claimCodeHash,
        input.recipient.toLowerCase(),
        input.event.chainId,
        input.relayerAddress.toLowerCase(),
        input.event.contractAddress.toLowerCase(),
        input.event.tokenId,
        input.authorization.deadline,
        input.authorization.nonce.toLowerCase(),
        input.authorization.signature,
        Date.now(),
        now,
        now,
      )
      .run();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("UNIQUE")) throw error;
  }
  const created = await fetchMintJobByIdempotencyKey(
    db.withSession("first-primary"),
    idempotencyKey,
  );
  if (!created) throw new Error("Mint job could not be persisted.");
  return created;
}

export async function fetchMintJob(
  db: Pick<D1DatabaseSession, "prepare">,
  jobId: string,
): Promise<MintJobRecord | null> {
  const row = await db
    .prepare(`${JOB_SELECT} WHERE job_id = ? LIMIT 1`)
    .bind(jobId)
    .first<MintJobRow>();
  return row ? mapMintJob(row) : null;
}

async function fetchMintJobByIdempotencyKey(
  db: Pick<D1DatabaseSession, "prepare">,
  key: string,
): Promise<MintJobRecord | null> {
  const row = await db
    .prepare(`${JOB_SELECT} WHERE idempotency_key = ? LIMIT 1`)
    .bind(key)
    .first<MintJobRow>();
  return row ? mapMintJob(row) : null;
}

export async function fetchNextMintJob(
  db: Pick<D1DatabaseSession, "prepare">,
  shardKey: string,
  now = Date.now(),
): Promise<MintJobRecord | null> {
  const row = await db
    .prepare(
      `${JOB_SELECT}
       WHERE shard_key = ?
         AND status IN ('pending', 'submitting', 'submitted', 'retry')
         AND next_attempt_at <= ?
       ORDER BY created_at, job_id
       LIMIT 1`,
    )
    .bind(shardKey, now)
    .first<MintJobRow>();
  return row ? mapMintJob(row) : null;
}

export async function nextMintJobDueAt(
  db: Pick<D1DatabaseSession, "prepare">,
  shardKey: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT MIN(next_attempt_at) AS due_at
       FROM live_mint_jobs
       WHERE shard_key = ? AND status IN ('pending', 'submitting', 'submitted', 'retry')`,
    )
    .bind(shardKey)
    .first<{ due_at: number | null }>();
  return row?.due_at ?? null;
}

export async function markMintJobSubmitting(
  db: D1Database,
  job: MintJobRecord,
  networkNonce: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE live_mint_jobs
       SET status = 'submitting', network_nonce = ?, attempt_count = attempt_count + 1,
           next_attempt_at = ?, updated_at = ?, last_error = NULL
       WHERE job_id = ? AND status IN ('pending', 'retry', 'submitting')`,
    )
    .bind(networkNonce, Date.now() + 30_000, now, job.jobId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function markMintJobSubmitted(
  db: D1Database,
  job: MintJobRecord,
  transactionHash: Hash,
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE live_mint_jobs
         SET status = 'submitted', transaction_hash = ?, submitted_at = COALESCE(submitted_at, ?),
             next_attempt_at = ?, updated_at = ?, last_error = NULL
         WHERE job_id = ?`,
      )
      .bind(transactionHash.toLowerCase(), now, Date.now() + 2_000, now, job.jobId),
    db
      .prepare(
        `UPDATE live_claim_codes
         SET relay_started_at = COALESCE(relay_started_at, ?), relay_tx_hash = ?
         WHERE code_hash = ? AND claimed_by = ? AND minted_tx_hash IS NULL`,
      )
      .bind(now, transactionHash.toLowerCase(), job.claimCodeHash, job.recipient.toLowerCase()),
  ]);
}

export async function markMintJobConfirmed(
  db: D1Database,
  job: MintJobRecord,
  transactionHash: Hash | null,
): Promise<void> {
  const now = new Date().toISOString();
  const statements = [
    db
      .prepare(
        `UPDATE live_mint_jobs
         SET status = 'confirmed', transaction_hash = COALESCE(transaction_hash, ?),
             confirmed_at = ?, next_attempt_at = ?, updated_at = ?, last_error = NULL
         WHERE job_id = ?`,
      )
      .bind(transactionHash, now, Date.now(), now, job.jobId),
  ];
  if (transactionHash) {
    statements.push(
      db
        .prepare(
          `UPDATE live_claim_codes
           SET relay_tx_hash = ?, minted_tx_hash = ?, minted_at = ?, relay_started_at = COALESCE(relay_started_at, ?)
           WHERE code_hash = ? AND claimed_by = ?
             AND (minted_tx_hash IS NULL OR minted_tx_hash = ?)`,
        )
        .bind(
          transactionHash.toLowerCase(),
          transactionHash.toLowerCase(),
          now,
          now,
          job.claimCodeHash,
          job.recipient.toLowerCase(),
          transactionHash.toLowerCase(),
        ),
    );
  }
  await db.batch(statements);
}

export async function markMintJobRetry(
  db: D1Database,
  job: MintJobRecord,
  error: unknown,
): Promise<void> {
  const attempts = job.attemptCount + 1;
  const terminal = attempts >= 8;
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
  const now = new Date().toISOString();
  const errorMessage = internalErrorMessage(error);
  const resetNonce = shouldRefreshNetworkNonce(errorMessage);
  await db
    .prepare(
      `UPDATE live_mint_jobs
       SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ?,
           network_nonce = CASE WHEN ? THEN NULL ELSE network_nonce END
       WHERE job_id = ?`,
    )
    .bind(
      terminal ? "failed" : "retry",
      errorMessage,
      Date.now() + delay,
      now,
      resetNonce ? 1 : 0,
      job.jobId,
    )
    .run();
}

export async function rescheduleMintJob(
  db: D1Database,
  jobId: string,
  delayMs: number,
): Promise<void> {
  await db
    .prepare(`UPDATE live_mint_jobs SET next_attempt_at = ?, updated_at = ? WHERE job_id = ?`)
    .bind(Date.now() + delayMs, new Date().toISOString(), jobId)
    .run();
}

export async function reactivateMintJob(db: D1Database, jobId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE live_mint_jobs
       SET status = 'retry', next_attempt_at = ?, updated_at = ?, last_error = NULL
       WHERE job_id = ? AND status = 'failed'`,
    )
    .bind(Date.now(), new Date().toISOString(), jobId)
    .run();
}

async function refreshMintJobAuthorization(
  db: D1Database,
  jobId: string,
  authorization: MintAuthorization,
): Promise<void> {
  await db
    .prepare(
      `UPDATE live_mint_jobs
       SET authorization_deadline = ?, authorization_signature = ?, updated_at = ?
       WHERE job_id = ? AND status != 'confirmed'`,
    )
    .bind(authorization.deadline, authorization.signature, new Date().toISOString(), jobId)
    .run();
}

export async function activeMintRelayShards(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT shard_key
       FROM live_mint_jobs
       WHERE status IN ('pending', 'submitting', 'submitted', 'retry')`,
    )
    .all<{ shard_key: string }>();
  return rows.results.map((row) => row.shard_key);
}

export async function wakeMintRelay(env: Bindings, shardKey: string): Promise<void> {
  const stub = env.MINT_RELAY_COORDINATOR.getByName(shardKey);
  await stub.wake(shardKey);
}

export function mintJobPublicStatus(job: MintJobRecord): {
  jobId: string;
  mintStatus: "minting" | "minted";
  transactionHash: Hash | null;
} {
  return {
    jobId: job.jobId,
    mintStatus: job.status === "confirmed" ? "minted" : "minting",
    transactionHash: job.status === "confirmed" ? job.transactionHash : null,
  };
}

export function mintJobAuthorization(job: MintJobRecord): MintAuthorization {
  return {
    chainId: job.chainId,
    contractAddress: getAddress(job.contractAddress),
    tokenId: job.tokenId,
    account: getAddress(job.recipient),
    deadline: job.authorizationDeadline,
    nonce: job.authorizationNonce,
    signature: job.authorizationSignature,
  };
}

function mapMintJob(row: MintJobRow): MintJobRecord {
  return {
    jobId: row.job_id,
    idempotencyKey: row.idempotency_key,
    shardKey: row.shard_key,
    eventId: row.event_id,
    claimCodeHash: row.claim_code_hash,
    recipient: getAddress(row.recipient),
    chainId: row.chain_id,
    relayerAddress: getAddress(row.relayer_address),
    contractAddress: getAddress(row.contract_address),
    tokenId: row.token_id,
    authorizationDeadline: row.authorization_deadline,
    authorizationNonce: row.authorization_nonce,
    authorizationSignature: row.authorization_signature,
    status: row.status,
    networkNonce: row.network_nonce,
    transactionHash: row.transaction_hash,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    confirmedAt: row.confirmed_at,
  };
}

function internalErrorMessage(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, 2_000);
}

function shouldRefreshNetworkNonce(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("nonce too low") ||
    normalized.includes("nonce has already been used") ||
    normalized.includes("invalid transaction nonce")
  );
}
