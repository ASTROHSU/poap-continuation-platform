import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { synchronizeIssuerIssuance, recoverIssuerIssuances } from "../src/worker/issuer-issuance";
import {
  issuancePlan,
  issuerAbi,
  ISSUER_CONTRACT,
  ISSUER_OWNER,
} from "../frontend-astro/src/lib/issuer-issuance";

const bindings = env as any;
const slug = "platform-operations-okx-bybit-2026-11";
const event = {
  slug,
  title: "平台操作課：OKX、Bybit",
  imageUrl: `/media/live/events/${slug}/artwork.png`,
  chainId: 8453,
  maxSupply: 200,
  tokenId: null,
  contractAddress: null,
};
const plan = issuancePlan(event)!;
const hash = `0x${"a".repeat(64)}` as const;
const identity = { address: ISSUER_OWNER, email: "admin@example.test" };
function client() {
  return {
    getChainId: vi.fn(async () => 8453),
    getBlockNumber: vi.fn(async () => 101n),
    getTransaction: vi.fn(async () => ({
      to: ISSUER_CONTRACT,
      from: ISSUER_OWNER,
      value: 0n,
      input: plan.data,
    })),
    getTransactionReceipt: vi.fn(async () => ({
      to: ISSUER_CONTRACT,
      from: ISSUER_OWNER,
      status: "success",
      blockNumber: 100n,
      logs: [
        {
          address: ISSUER_CONTRACT,
          topics: encodeEventTopics({
            abi: issuerAbi,
            eventName: "EventConfigured",
            args: { tokenId: 11n },
          }),
          data: encodeAbiParameters(
            [{ type: "uint256" }, { type: "string" }],
            [200n, plan.metadataUri],
          ),
        },
      ],
    })),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === "owner" ? ISSUER_OWNER : [200n, true, plan.metadataUri],
    ),
  } as any;
}
beforeAll(async () => applyD1Migrations(bindings.LIVE_DB, bindings.TEST_LIVE_MIGRATIONS));
beforeEach(async () => {
  await bindings.LIVE_DB.batch([
    bindings.LIVE_DB.prepare("DELETE FROM live_claim_codes"),
    bindings.LIVE_DB.prepare("DELETE FROM live_event_issuances"),
    bindings.LIVE_DB.prepare("DELETE FROM live_events"),
    bindings.LIVE_DB.prepare(
      `INSERT INTO live_events (event_id,slug,title,image_url,starts_at,claim_opens_at,claim_closes_at,chain_id,max_supply,claim_mode,status) VALUES ('event-issuance',?,?,?,'2026-11-15T12:30:00Z','2026-11-07T16:00:00Z','2026-11-22T16:00:00Z',8453,200,'shared','draft')`,
    ).bind(slug, event.title, event.imageUrl),
  ]);
  await bindings.ARCHIVE_BUCKET.put(
    `live/events/${slug}/metadata.json`,
    JSON.stringify({ name: event.title, image: event.imageUrl }),
  );
});
describe("verified issuer synchronization", () => {
  it("atomically publishes exact coordinates and 200 shared slots, preserving dates; replay returns the same credential", async () => {
    const first = await synchronizeIssuerIssuance(bindings, identity, slug, hash, client());
    expect(first.event).toMatchObject({
      status: "published",
      tokenId: "11",
      contractAddress: ISSUER_CONTRACT,
      claimOpensAt: "2026-11-07T16:00:00Z",
      claimClosesAt: "2026-11-22T16:00:00Z",
    });
    expect(new URL(first.claimUrl).searchParams.get("code")).toBeTruthy();
    const secondClient = client();
    const second = await synchronizeIssuerIssuance(bindings, identity, slug, hash, secondClient);
    expect(second.claimUrl).toBe(first.claimUrl);
    expect(secondClient.getTransactionReceipt).not.toHaveBeenCalled();
    expect(
      await bindings.LIVE_DB.prepare(
        "SELECT COUNT(*) count,COUNT(DISTINCT access_code_hash) pools FROM live_claim_codes",
      ).first(),
    ).toEqual({ count: 200, pools: 1 });
    expect(
      await bindings.LIVE_DB.prepare("SELECT contract_start_block FROM live_events").first(),
    ).toEqual({ contract_start_block: 100 });
    const stored = await bindings.LIVE_DB.prepare("SELECT * FROM live_event_issuances").first();
    expect(JSON.stringify(stored)).not.toContain(new URL(first.claimUrl).searchParams.get("code"));
  });
  it("concurrent synchronization cannot create a second credential or extra slots", async () => {
    const results = await Promise.all(
      [1, 2].map(() => synchronizeIssuerIssuance(bindings, identity, slug, hash, client())),
    );
    expect(results[0].claimUrl).toBe(results[1].claimUrl);
    expect(
      await bindings.LIVE_DB.prepare("SELECT COUNT(*) count FROM live_claim_codes").first(),
    ).toEqual({ count: 200 });
  });
  it("rejects forged calldata, failed receipts, insufficient confirmations, wrong metadata and inactive configuration without writes", async () => {
    const cases = [
      (c: any) =>
        c.getTransaction.mockResolvedValue({
          to: ISSUER_CONTRACT,
          from: ISSUER_OWNER,
          value: 0n,
          input: "0x",
        }),
      (c: any) => c.getTransactionReceipt.mockResolvedValue({ status: "reverted" }),
      (c: any) => c.getBlockNumber.mockResolvedValue(100n),
      (c: any) =>
        c.readContract.mockImplementation(async ({ functionName }: any) =>
          functionName === "owner" ? ISSUER_OWNER : [200n, false, plan.metadataUri],
        ),
    ];
    for (const change of cases) {
      const c = client();
      change(c);
      await expect(synchronizeIssuerIssuance(bindings, identity, slug, hash, c)).rejects.toThrow();
    }
    await bindings.ARCHIVE_BUCKET.put(
      `live/events/${slug}/metadata.json`,
      JSON.stringify({ name: "Other", image: event.imageUrl }),
    );
    await expect(
      synchronizeIssuerIssuance(bindings, identity, slug, hash, client()),
    ).rejects.toMatchObject({ code: "issuer_sync_mismatch" });
    expect(
      await bindings.LIVE_DB.prepare("SELECT status,contract_address FROM live_events").first(),
    ).toEqual({ status: "draft", contract_address: null });
    expect(
      await bindings.LIVE_DB.prepare("SELECT COUNT(*) count FROM live_claim_codes").first(),
    ).toEqual({ count: 0 });
  });
  it("rolls back the receipt, credential and pool together if publication fails", async () => {
    await bindings.LIVE_DB.prepare(
      `CREATE TRIGGER reject_publication BEFORE UPDATE OF status ON live_events WHEN NEW.status='published' BEGIN SELECT RAISE(ABORT,'test publication failed'); END`,
    ).run();
    await expect(
      synchronizeIssuerIssuance(bindings, identity, slug, hash, client()),
    ).rejects.toThrow();
    expect(
      await bindings.LIVE_DB.prepare("SELECT COUNT(*) count FROM live_event_issuances").first(),
    ).toEqual({ count: 0 });
    expect(
      await bindings.LIVE_DB.prepare("SELECT COUNT(*) count FROM live_claim_codes").first(),
    ).toEqual({ count: 0 });
    await bindings.LIVE_DB.prepare("DROP TRIGGER reject_publication").run();
  });
  it("does not reopen closed events or overwrite existing entitlements", async () => {
    await bindings.LIVE_DB.prepare("UPDATE live_events SET status='closed'").run();
    await expect(
      synchronizeIssuerIssuance(bindings, identity, slug, hash, client()),
    ).rejects.toMatchObject({ code: "issuer_sync_status" });
    expect(await recoverIssuerIssuances(bindings)).toEqual({ synchronized: 0 });
    await bindings.LIVE_DB.prepare("UPDATE live_events SET status='draft'").run();
    await bindings.LIVE_DB.prepare(
      "INSERT INTO live_claim_codes (code_hash,event_id,access_code_hash) VALUES (?,'event-issuance',?)",
    )
      .bind("b".repeat(64), "c".repeat(64))
      .run();
    await expect(
      synchronizeIssuerIssuance(bindings, identity, slug, hash, client()),
    ).rejects.toMatchObject({ code: "issuer_sync_existing_pool" });
  });
});
