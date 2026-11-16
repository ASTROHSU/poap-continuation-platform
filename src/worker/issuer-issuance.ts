import { createPublicClient, http, type Hash } from "viem";
import { base } from "viem/chains";
import {
  issuancePlan,
  issuerAbi,
  ISSUER_CONTRACT,
  ISSUER_OWNER,
  verifyIssuanceReceipt,
} from "../../frontend-astro/src/lib/issuer-issuance";
import { encryptEmail, decryptEmail, randomToken, sha256Hex } from "./email-auth";
import { loadIssuerEvent, type IssuerAdminIdentity } from "./issuer-admin";
import type { Bindings } from "./types";
import { ApiError } from "./validation";

type IssuanceEnv = Pick<
  Bindings,
  "LIVE_DB" | "ARCHIVE_BUCKET" | "BASE_MAINNET_RPC_URL" | "EMAIL_DATA_KEY"
>;
interface IssuanceRow {
  event_id: string;
  transaction_hash: Hash;
  block_number: number;
  claim_code_ciphertext: string;
  claim_code_iv: string;
  access_code_hash: string;
}
const clientFor = (env: IssuanceEnv) =>
  createPublicClient({
    chain: base,
    transport: http(env.BASE_MAINNET_RPC_URL, { timeout: 15_000, retryCount: 0 }),
  });

// One-time recovery of the three owner-signed transactions from 2026-11-11.
// These are evidence candidates only: the same full verification runs before any write.
const recoveryTransactions: Record<string, Hash> = {
  "platform-operations-okx-bybit-2026-11":
    "0xbf162328c05cae24268dba307f7fa7e72a15663fc3dab5a6a6a4495c7b30e1e2",
  "december-book-club-2026": "0x1f6ae79f2ca32be4acaf5e408295a50d0183e6415d6cae0cb4fa3d6bedf3fc64",
  "platform-operations-firstrade-etoro-2026-12":
    "0x50855fb70b3f90e71e6f13464747990b9eb00d8113b74f5b8d76efa1f2f5b137",
};

export async function synchronizeIssuerIssuance(
  env: IssuanceEnv,
  identity: IssuerAdminIdentity,
  slug: string,
  hashInput?: unknown,
  client = clientFor(env),
) {
  const current = await loadIssuerEvent(env, slug);
  if (!current) throw new ApiError(404, "找不到活動。", "issuer_event_not_found");
  const plan = issuancePlan(current);
  if (!plan || plan.tokenId === 10 || current.claimMode !== "shared")
    throw new ApiError(409, "此活動不在本次發行同步範圍。", "issuer_sync_unsupported");
  const existing = await env.LIVE_DB.prepare(
    "SELECT * FROM live_event_issuances WHERE event_id = ?",
  )
    .bind(current.eventId)
    .first<IssuanceRow>();
  if (existing) {
    if (
      hashInput &&
      (typeof hashInput !== "string" || hashInput.toLowerCase() !== existing.transaction_hash)
    )
      throw new ApiError(409, "已有不同的發行回執，請重新載入。", "issuer_sync_conflict");
    return result(existing);
  }
  const hash = hashInput ?? recoveryTransactions[slug];
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new ApiError(400, "請提供發行交易 hash。", "issuer_sync_hash_required");
  const verified = await verifyIssuanceReceipt(client, plan, hash as Hash);
  const [owner, config, metadataObject] = await Promise.all([
    client.readContract({ address: ISSUER_CONTRACT, abi: issuerAbi, functionName: "owner" }),
    client.readContract({
      address: ISSUER_CONTRACT,
      abi: issuerAbi,
      functionName: "eventConfig",
      args: [BigInt(plan.tokenId)],
    }),
    env.ARCHIVE_BUCKET.get(`live/events/${slug}/metadata.json`),
  ]);
  const metadata = await metadataObject?.json<{ name: string; image: string }>();
  if (
    owner.toLowerCase() !== ISSUER_OWNER ||
    config[0] !== 200n ||
    !config[1] ||
    config[2] !== plan.metadataUri ||
    metadata?.name !== current.title ||
    !metadata.image ||
    new URL(metadata.image, "https://poap.blocktrend.today").href !==
      new URL(current.imageUrl, "https://poap.blocktrend.today").href
  )
    throw new ApiError(409, "鏈上設定或正式 metadata 不符，已停止同步。", "issuer_sync_mismatch");
  if (current.status !== "draft")
    throw new ApiError(
      409,
      "僅能同步尚未發布的活動，不會自動重開已關閉活動。",
      "issuer_sync_status",
    );
  const pool = await env.LIVE_DB.prepare(
    "SELECT COUNT(*) AS count FROM live_claim_codes WHERE event_id = ?",
  )
    .bind(current.eventId)
    .first<{ count: number }>();
  if (pool?.count)
    throw new ApiError(409, "活動已有領取資格，請先核對既有設定。", "issuer_sync_existing_pool");
  const code = randomToken();
  const encrypted = await encryptEmail(code, env.EMAIL_DATA_KEY);
  const accessHash = await sha256Hex(code);
  const slotHashes = await Promise.all(
    Array.from({ length: 200 }, (_, i) => sha256Hex(`${code}:slot:${i + 1}`)),
  );
  const now = new Date().toISOString();
  // First writer owns the credential. All pool inserts and publication are conditional
  // on that same credential and event version; D1 rolls the entire batch back on failure.
  const statements = [
    env.LIVE_DB.prepare(
      `INSERT OR IGNORE INTO live_event_issuances
    (event_id,transaction_hash,block_number,claim_code_ciphertext,claim_code_iv,access_code_hash,verified_by_address,verified_at)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM live_events WHERE event_id=? AND updated_at=? AND status='draft')
    AND NOT EXISTS (SELECT 1 FROM live_claim_codes WHERE event_id=?)`,
    ).bind(
      current.eventId,
      hash.toLowerCase(),
      Number(verified.blockNumber),
      encrypted.ciphertext,
      encrypted.iv,
      accessHash,
      identity.address,
      now,
      current.eventId,
      current.updatedAt,
      current.eventId,
    ),
  ];
  // 25 rows per statement stays below D1's bound-parameter limit.
  for (let i = 0; i < 200; i += 25) {
    const slots = slotHashes.slice(i, i + 25);
    statements.push(
      env.LIVE_DB.prepare(
        `WITH slots(code_hash) AS (VALUES ${slots.map(() => "(?)").join(",")})
      INSERT OR IGNORE INTO live_claim_codes (code_hash,event_id,access_code_hash)
      SELECT slots.code_hash, ?, ? FROM slots
      WHERE EXISTS (SELECT 1 FROM live_event_issuances WHERE event_id=? AND access_code_hash=?)`,
      ).bind(...slots, current.eventId, accessHash, current.eventId, accessHash),
    );
  }
  statements.push(
    env.LIVE_DB.prepare(
      `UPDATE live_events SET contract_address=?,token_id=?,contract_start_block=?,status='published',updated_at=?
    WHERE event_id=? AND updated_at=? AND status='draft'
    AND EXISTS (SELECT 1 FROM live_event_issuances WHERE event_id=? AND access_code_hash=?)
    AND (SELECT COUNT(*) FROM live_claim_codes WHERE event_id=? AND access_code_hash=?)=200`,
    ).bind(
      ISSUER_CONTRACT,
      String(plan.tokenId),
      Number(verified.blockNumber),
      now,
      current.eventId,
      current.updatedAt,
      current.eventId,
      accessHash,
      current.eventId,
      accessHash,
    ),
  );
  await env.LIVE_DB.batch(statements);
  const recorded = await env.LIVE_DB.prepare(
    "SELECT * FROM live_event_issuances WHERE event_id = ?",
  )
    .bind(current.eventId)
    .first<IssuanceRow>();
  if (!recorded) throw new ApiError(409, "活動版本已變更，請重新同步。", "issuer_sync_conflict");
  return result(recorded);

  async function result(row: IssuanceRow) {
    const event = await loadIssuerEvent(env, slug);
    if (
      !event ||
      event.contractAddress !== ISSUER_CONTRACT ||
      event.tokenId !== String(plan!.tokenId)
    )
      throw new ApiError(409, "平台發行設定尚未完成，請重新同步。", "issuer_sync_incomplete");
    const claimCode = await decryptEmail(
      row.claim_code_ciphertext,
      row.claim_code_iv,
      env.EMAIL_DATA_KEY,
    );
    return {
      event,
      transactionHash: row.transaction_hash,
      blockNumber: row.block_number,
      claimUrl: `https://poap.blocktrend.today/claim/${slug}?code=${encodeURIComponent(claimCode)}`,
    };
  }
}

export async function recoverIssuerIssuances(env: IssuanceEnv) {
  let synchronized = 0;
  for (const [slug, hash] of Object.entries(recoveryTransactions)) {
    const row = await env.LIVE_DB.prepare(
      `SELECT e.event_id FROM live_events e LEFT JOIN live_event_issuances i ON i.event_id=e.event_id
      WHERE e.slug=? AND e.status='draft' AND i.event_id IS NULL`,
    )
      .bind(slug)
      .first();
    if (!row) continue;
    try {
      await synchronizeIssuerIssuance(env, { email: "", address: ISSUER_OWNER }, slug, hash);
      synchronized++;
    } catch {
      console.error("Owner issuance recovery will retry", { slug });
    }
  }
  return { synchronized };
}
