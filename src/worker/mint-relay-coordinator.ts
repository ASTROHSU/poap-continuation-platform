import { DurableObject } from "cloudflare:workers";
import {
  fetchNextMintJob,
  markMintJobConfirmed,
  markMintJobRetry,
  markMintJobSubmitted,
  markMintJobSubmitting,
  mintJobAuthorization,
  nextMintJobDueAt,
  rescheduleMintJob,
} from "./mint-jobs";
import {
  hasMintedBadge,
  pendingTransactionNonce,
  relayMintAuthorization,
  verifyMintTransaction,
} from "./minting";
import type { Bindings } from "./types";

const RECEIPT_POLL_MS = 2_000;
const RECEIPT_TIMEOUT_MS = 120_000;

export class MintRelayCoordinator extends DurableObject<Bindings> {
  async wake(shardKey: string): Promise<void> {
    const stored = await this.ctx.storage.get<string>("shardKey");
    if (stored && stored !== shardKey) throw new Error("Mint relay shard identity mismatch.");
    if (!stored) await this.ctx.storage.put("shardKey", shardKey);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > Date.now()) await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const shardKey = await this.ctx.storage.get<string>("shardKey");
    if (!shardKey) return;
    try {
      await this.processOne(shardKey);
    } catch (error) {
      console.error("Mint relay coordinator cycle failed", {
        shardKey,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await this.scheduleNext(shardKey);
    }
  }

  private async processOne(shardKey: string): Promise<void> {
    const job = await fetchNextMintJob(this.env.LIVE_DB.withSession("first-primary"), shardKey);
    if (!job) return;
    const rpcUrl = liveRpcUrl(this.env, job.chainId);
    const event = {
      chainId: job.chainId,
      contractAddress: job.contractAddress,
      tokenId: job.tokenId,
    };

    if (job.status === "submitted" && job.transactionHash) {
      const verification = await verifyMintTransaction(
        rpcUrl,
        job.transactionHash,
        event,
        job.recipient,
      );
      if (verification === "confirmed") {
        await markMintJobConfirmed(this.env.LIVE_DB, job, job.transactionHash);
        return;
      }
      if (verification === "pending" && !receiptTimedOut(job.submittedAt)) {
        await rescheduleMintJob(this.env.LIVE_DB, job.jobId, RECEIPT_POLL_MS);
        return;
      }
      if (await hasMintedBadge(rpcUrl, event, job.recipient)) {
        await markMintJobConfirmed(this.env.LIVE_DB, job, job.transactionHash);
        return;
      }
      await markMintJobRetry(
        this.env.LIVE_DB,
        job,
        new Error("Mint receipt timed out or reverted."),
      );
      return;
    }

    try {
      if (await hasMintedBadge(rpcUrl, event, job.recipient)) {
        await markMintJobConfirmed(this.env.LIVE_DB, job, job.transactionHash);
        return;
      }
      const nonce =
        job.networkNonce ??
        (await pendingTransactionNonce(rpcUrl, job.chainId, job.relayerAddress));
      const acquired = await markMintJobSubmitting(this.env.LIVE_DB, job, nonce);
      if (!acquired) return;
      const transactionHash = await relayMintAuthorization(
        rpcUrl,
        event,
        mintJobAuthorization(job),
        this.env.MINT_RELAYER_PRIVATE_KEY,
        nonce,
        Math.min(job.attemptCount * 1_250, 10_000),
      );
      await markMintJobSubmitted(this.env.LIVE_DB, job, transactionHash);
      console.log("Sponsored mint submitted", {
        jobId: job.jobId,
        shardKey,
        transactionHash,
        attempt: job.attemptCount + 1,
      });
    } catch (error) {
      try {
        if (await hasMintedBadge(rpcUrl, event, job.recipient)) {
          await markMintJobConfirmed(this.env.LIVE_DB, job, job.transactionHash);
          return;
        }
      } catch {
        // The original error remains the actionable internal diagnostic.
      }
      await markMintJobRetry(this.env.LIVE_DB, job, error);
      console.warn("Sponsored mint will be retried", {
        jobId: job.jobId,
        shardKey,
        attempt: job.attemptCount + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async scheduleNext(shardKey: string): Promise<void> {
    const dueAt = await nextMintJobDueAt(this.env.LIVE_DB.withSession("first-primary"), shardKey);
    if (dueAt !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, dueAt));
  }
}

function receiptTimedOut(submittedAt: string | null): boolean {
  if (!submittedAt) return true;
  return Date.now() - Date.parse(submittedAt) >= RECEIPT_TIMEOUT_MS;
}

function liveRpcUrl(env: Pick<Bindings, "BASE_RPC_URL" | "BASE_MAINNET_RPC_URL">, chainId: number) {
  if (chainId === 84532) return env.BASE_RPC_URL;
  if (chainId === 8453) return env.BASE_MAINNET_RPC_URL;
  throw new Error(`Unsupported live chain: ${chainId}`);
}
