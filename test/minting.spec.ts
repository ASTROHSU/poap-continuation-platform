import { encodeAbiParameters, encodeEventTopics, zeroAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { associationBadgesAbi } from "../src/shared/association-badges";
import {
  hasMintedBadge,
  isExpiredMintAuthorizationError,
  receiptContainsMint,
} from "../src/worker/minting";

const contract = "0x1111111111111111111111111111111111111111";
const collector = "0x2222222222222222222222222222222222222222";

afterEach(() => vi.unstubAllGlobals());

describe("mint RPC transport", () => {
  it("keeps the original endpoint first and falls back after provider rate limiting", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        const body = url.includes("primary")
          ? { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "over rate limit" } }
          : { jsonrpc: "2.0", id: 1, result: `0x${"0".repeat(63)}1` };
        return new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await expect(
      hasMintedBadge(
        ["https://primary.example", "https://fallback.example"],
        { chainId: 8453, contractAddress: contract, tokenId: "7" },
        collector,
      ),
    ).resolves.toBe(true);
    expect(requestedUrls).toEqual(["https://primary.example/", "https://fallback.example/"]);
  });
});

describe("mint receipt verification", () => {
  it("accepts only the expected ERC-1155 mint log", () => {
    const topics = encodeEventTopics({
      abi: associationBadgesAbi,
      eventName: "TransferSingle",
      args: {
        operator: collector,
        from: zeroAddress,
        to: collector,
      },
    });
    const receipt = {
      logs: [
        {
          address: contract,
          topics,
          data: encodeAbiParameters(
            [
              { name: "id", type: "uint256" },
              { name: "value", type: "uint256" },
            ],
            [7n, 1n],
          ),
        },
      ],
    };

    expect(receiptContainsMint(receipt as never, contract, collector, 7n)).toBe(true);
    expect(receiptContainsMint(receipt as never, contract, collector, 8n)).toBe(false);
    expect(
      receiptContainsMint(
        receipt as never,
        contract,
        "0x3333333333333333333333333333333333333333",
        7n,
      ),
    ).toBe(false);
  });
});

describe("mint authorization errors", () => {
  it("recognizes the AuthorizationExpired selector even when the RPC cannot decode it", () => {
    expect(
      isExpiredMintAuthorizationError(
        new Error('contract reverted with the following signature: "0x3d91b05f"'),
      ),
    ).toBe(true);
    expect(isExpiredMintAuthorizationError(new Error("nonce too low"))).toBe(false);
  });
});
