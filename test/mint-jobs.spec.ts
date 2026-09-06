import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchLiveEvent } from "../src/worker/live";
import {
  activeMintRelayShards,
  createOrReuseMintJob,
  fetchMintJob,
  fetchNextMintJob,
  markMintJobConfirmed,
  markMintJobRetry,
  markMintJobSubmitting,
  markMintJobSubmitted,
  mintJobPublicStatus,
  mintRelayShardKey,
  renewExpiredMintJobAuthorization,
} from "../src/worker/mint-jobs";
import type { MintAuthorization } from "../src/worker/minting";
import type { Bindings } from "../src/worker/types";

interface TestBindings extends Bindings {
  TEST_LIVE_FIXTURE: string;
  TEST_LIVE_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestBindings;
const recipient = "0x3333333333333333333333333333333333333333" as const;
const relayer = "0x4444444444444444444444444444444444444444" as const;
const signature = `0x${"11".repeat(65)}` as const;

beforeAll(async () => {
  await applyD1Migrations(bindings.LIVE_DB, bindings.TEST_LIVE_MIGRATIONS);
  await executeSql(bindings.LIVE_DB, bindings.TEST_LIVE_FIXTURE);
});

beforeEach(async () => {
  await bindings.LIVE_DB.prepare("DELETE FROM live_mint_jobs").run();
});

describe("durable sponsored mint jobs", () => {
  it("deduplicates simultaneous requests with the event, recipient, claim and authorization", async () => {
    const input = await jobInput(recipient, `0x${"22".repeat(32)}`);
    const jobs = await Promise.all(
      Array.from({ length: 12 }, () => createOrReuseMintJob(bindings.LIVE_DB, input)),
    );
    expect(new Set(jobs.map((job) => job.jobId))).toHaveLength(1);
    const count = await bindings.LIVE_DB.prepare(
      "SELECT COUNT(*) AS count FROM live_mint_jobs",
    ).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("keeps concurrent recipients in deterministic FIFO order within one relayer shard", async () => {
    const first = await createOrReuseMintJob(
      bindings.LIVE_DB,
      await jobInput(recipient, `0x${"33".repeat(32)}`),
    );
    const secondRecipient = "0x5555555555555555555555555555555555555555" as const;
    const second = await createOrReuseMintJob(
      bindings.LIVE_DB,
      await jobInput(secondRecipient, `0x${"44".repeat(32)}`),
    );
    expect(first.shardKey).toBe(second.shardKey);
    const next = await fetchNextMintJob(
      bindings.LIVE_DB.withSession("first-primary"),
      first.shardKey,
    );
    expect(next?.jobId).toBe(first.jobId);
  });

  it("persists retry diagnostics internally and exposes only the minting state", async () => {
    const created = await createOrReuseMintJob(
      bindings.LIVE_DB,
      await jobInput(recipient, `0x${"55".repeat(32)}`),
    );
    expect(await markMintJobSubmitting(bindings.LIVE_DB, created, 71)).toBe(true);
    await markMintJobRetry(
      bindings.LIVE_DB,
      created,
      new Error("nonce too low: private rpc detail"),
    );
    const retried = await fetchMintJob(
      bindings.LIVE_DB.withSession("first-primary"),
      created.jobId,
    );
    expect(retried).toMatchObject({
      status: "retry",
      networkNonce: null,
      attemptCount: 1,
    });
    expect(retried?.lastError).toContain("nonce too low");
    expect(mintJobPublicStatus(retried!)).toEqual({
      jobId: created.jobId,
      mintStatus: "minting",
      transactionHash: null,
    });
    expect(JSON.stringify(mintJobPublicStatus(retried!))).not.toContain("nonce");
  });

  it("exposes terminal failure without leaking its internal diagnostic", async () => {
    const created = await createOrReuseMintJob(
      bindings.LIVE_DB,
      await jobInput(recipient, `0x${"5a".repeat(32)}`),
    );
    await bindings.LIVE_DB.prepare(
      "UPDATE live_mint_jobs SET status = 'failed', last_error = ? WHERE job_id = ?",
    )
      .bind("over rate limit: private rpc detail", created.jobId)
      .run();
    const failed = await fetchMintJob(bindings.LIVE_DB.withSession("first-primary"), created.jobId);
    expect(mintJobPublicStatus(failed!)).toEqual({
      jobId: created.jobId,
      mintStatus: "failed",
      transactionHash: null,
    });
    expect(JSON.stringify(mintJobPublicStatus(failed!))).not.toContain("rate limit");
  });

  it("recovers unfinished work from D1 after the coordinator is recreated", async () => {
    const created = await createOrReuseMintJob(
      bindings.LIVE_DB,
      await jobInput(recipient, `0x${"66".repeat(32)}`),
    );
    const expectedShard = mintRelayShardKey(created.chainId, relayer);
    await expect(activeMintRelayShards(bindings.LIVE_DB)).resolves.toContain(expectedShard);
    const restored = await fetchNextMintJob(
      bindings.LIVE_DB.withSession("first-primary"),
      expectedShard,
    );
    expect(restored?.jobId).toBe(created.jobId);
  });

  it("records a confirmed transaction and completes the original claim atomically", async () => {
    const event = await fetchLiveEvent(bindings.LIVE_DB.withSession("first-primary"), "mint-demo");
    if (!event) throw new Error("mint fixture missing");
    const codeHash = "1851cac87456be2727a62c017e4ae0d7ea21ee05e6a1b26a9d40db3084f9e2ad";
    const authorizationNonce = `0x${"77".repeat(32)}` as const;
    await bindings.LIVE_DB.prepare(
      `UPDATE live_claim_codes
       SET claimed_by = ?, claimed_at = ?, mint_nonce = ?, mint_authorization_deadline = ?
       WHERE code_hash = ?`,
    )
      .bind(recipient, new Date().toISOString(), authorizationNonce, 4_102_444_800, codeHash)
      .run();
    const job = await createOrReuseMintJob(bindings.LIVE_DB, {
      event,
      claimCodeHash: codeHash,
      recipient,
      relayerAddress: relayer,
      authorization: authorization(event, recipient, authorizationNonce),
    });
    const transactionHash = `0x${"88".repeat(32)}` as const;
    await markMintJobConfirmed(bindings.LIVE_DB, job, transactionHash);
    const confirmed = await fetchMintJob(bindings.LIVE_DB.withSession("first-primary"), job.jobId);
    expect(mintJobPublicStatus(confirmed!)).toEqual({
      jobId: job.jobId,
      mintStatus: "minted",
      transactionHash,
    });
    const claim = await bindings.LIVE_DB.prepare(
      "SELECT minted_tx_hash, minted_at FROM live_claim_codes WHERE code_hash = ?",
    )
      .bind(codeHash)
      .first<{ minted_tx_hash: string; minted_at: string }>();
    expect(claim?.minted_tx_hash).toBe(transactionHash);
    expect(claim?.minted_at).toBeTruthy();
  });

  it("retains each submitted transaction hash when a job retries", async () => {
    const created = await createOrReuseMintJob(
      bindings.LIVE_DB,
      await jobInput(recipient, `0x${"ab".repeat(32)}`),
    );
    const first = `0x${"cd".repeat(32)}` as const;
    const second = `0x${"ef".repeat(32)}` as const;
    await markMintJobSubmitted(bindings.LIVE_DB, created, first);
    await markMintJobRetry(bindings.LIVE_DB, created, new Error("retry"));
    await markMintJobSubmitted(bindings.LIVE_DB, created, second);
    await markMintJobSubmitted(bindings.LIVE_DB, created, second);
    const rows = await bindings.LIVE_DB.prepare(
      "SELECT transaction_hash FROM gas_receipts ORDER BY transaction_hash",
    ).all();
    expect(rows.results.map((r) => r.transaction_hash)).toEqual([first, second]);
  });

  it("renews an expired authorization and makes the persisted job immediately retryable", async () => {
    const event = await fetchLiveEvent(bindings.LIVE_DB.withSession("first-primary"), "mint-demo");
    if (!event) throw new Error("mint fixture missing");
    const codeHash = "1851cac87456be2727a62c017e4ae0d7ea21ee05e6a1b26a9d40db3084f9e2ad";
    const nonce = `0x${"99".repeat(32)}` as const;
    await bindings.LIVE_DB.prepare(
      `UPDATE live_claim_codes
       SET claimed_by = ?, claimed_at = ?, mint_nonce = ?, mint_authorization_deadline = ?
       WHERE code_hash = ?`,
    )
      .bind(recipient, new Date().toISOString(), nonce, 1, codeHash)
      .run();
    const created = await createOrReuseMintJob(bindings.LIVE_DB, {
      event,
      claimCodeHash: codeHash,
      recipient,
      relayerAddress: relayer,
      authorization: { ...authorization(event, recipient, nonce), deadline: 1 },
    });
    expect(await markMintJobSubmitting(bindings.LIVE_DB, created, 72)).toBe(true);
    const renewed = { ...authorization(event, recipient, nonce), deadline: 4_102_444_900 };
    await renewExpiredMintJobAuthorization(bindings.LIVE_DB, created, renewed);

    const job = await fetchMintJob(bindings.LIVE_DB.withSession("first-primary"), created.jobId);
    expect(job).toMatchObject({
      status: "retry",
      authorizationDeadline: 4_102_444_900,
      attemptCount: 1,
      lastError: null,
    });
    const claim = await bindings.LIVE_DB.prepare(
      "SELECT mint_authorization_deadline FROM live_claim_codes WHERE code_hash = ?",
    )
      .bind(codeHash)
      .first<{ mint_authorization_deadline: number }>();
    expect(claim?.mint_authorization_deadline).toBe(4_102_444_900);
  });
});

async function jobInput(recipientAddress: typeof recipient | `0x${string}`, nonce: `0x${string}`) {
  const event = await fetchLiveEvent(bindings.LIVE_DB.withSession("first-primary"), "mint-demo");
  if (!event) throw new Error("mint fixture missing");
  return {
    event,
    claimCodeHash: "1851cac87456be2727a62c017e4ae0d7ea21ee05e6a1b26a9d40db3084f9e2ad",
    recipient: recipientAddress,
    relayerAddress: relayer,
    authorization: authorization(event, recipientAddress, nonce),
  };
}

function authorization(
  event: Awaited<ReturnType<typeof fetchLiveEvent>> extends infer T ? Exclude<T, null> : never,
  account: `0x${string}`,
  nonce: `0x${string}`,
): MintAuthorization {
  return {
    chainId: event.chainId,
    contractAddress: event.contractAddress as `0x${string}`,
    tokenId: event.tokenId!,
    account,
    deadline: 4_102_444_800,
    nonce,
    signature,
  };
}

async function executeSql(db: D1Database, sql: string): Promise<void> {
  for (const statement of sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)) {
    await db.prepare(statement).run();
  }
}
