import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ETHEREUM_RPC_URL,
  ethereumRpcUrl,
  normalizeEnsName,
  parseEnsNameQuery,
  resolveEnsAddress,
  withEnsCache,
} from "../src/worker/ens";

describe("ENS resolution", () => {
  it("normalizes ENSIP-15 names and accepts exactly one query parameter", () => {
    expect(normalizeEnsName("  EricMWalk.eth  ")).toBe("ericmwalk.eth");
    expect(normalizeEnsName("  Renie.POAP.XYZ  ")).toBe("renie.poap.xyz");
    expect(normalizeEnsName("Clover.ONPOAP.ETH")).toBe("clover.onpoap.eth");
    expect(normalizeEnsName("Name.WITHPOAP.ETH")).toBe("name.withpoap.eth");
    expect(
      parseEnsNameQuery(new URL("https://poap.in/api/resolve-address?name=EricMWalk.eth")),
    ).toBe("ericmwalk.eth");

    for (const url of [
      "https://poap.in/api/resolve-address",
      "https://poap.in/api/resolve-address?name=a.eth&name=b.eth",
      "https://poap.in/api/resolve-address?name=a.eth&extra=1",
      "https://poap.in/api/resolve-address?name=eth",
      "https://poap.in/api/resolve-address?name=.eth",
      `https://poap.in/api/resolve-address?name=${"a".repeat(64)}.eth`,
    ]) {
      expect(() => parseEnsNameQuery(new URL(url))).toThrow();
    }
  });

  it("resolves through an injected lookup without making a network request", async () => {
    const lookup = vi.fn().mockResolvedValue("0x17470261d36fD5f3c6D19E750f6f6F7b389df357");
    await expect(
      resolveEnsAddress("ericmwalk.eth", DEFAULT_ETHEREUM_RPC_URL, lookup),
    ).resolves.toBe("0x17470261d36fd5f3c6d19e750f6f6f7b389df357");
    expect(lookup).toHaveBeenCalledWith("ericmwalk.eth", DEFAULT_ETHEREUM_RPC_URL);

    await expect(
      resolveEnsAddress("missing.eth", DEFAULT_ETHEREUM_RPC_URL, vi.fn().mockResolvedValue(null)),
    ).resolves.toBeNull();
  });

  it("sanitizes upstream failures and validates server-only RPC configuration", async () => {
    expect(ethereumRpcUrl(undefined)).toBe(`${DEFAULT_ETHEREUM_RPC_URL}/`);
    expect(() => ethereumRpcUrl("http://ethereum.example")).toThrow();
    expect(() => ethereumRpcUrl("https://user:secret@ethereum.example")).toThrow();

    await expect(
      resolveEnsAddress(
        "example.eth",
        DEFAULT_ETHEREUM_RPC_URL,
        vi.fn().mockRejectedValue(new Error("provider secret")),
      ),
    ).rejects.toMatchObject({
      message: "ENS lookup is temporarily unavailable.",
      code: "ens_unavailable",
    });
  });

  it("caches unresolved names at the edge without caching upstream errors", async () => {
    const pending: Promise<unknown>[] = [];
    let loads = 0;
    const options = {
      requestUrl: "https://poap.in/api/resolve-address?name=unresolved-cache-test.eth",
      name: "unresolved-cache-test.eth",
      apiVersion: "test-v1",
      executionCtx: {
        waitUntil(promise: Promise<unknown>) {
          pending.push(promise);
        },
      },
    };
    const load = async () => {
      loads += 1;
      return Response.json(
        { error: "ENS name did not resolve to an address.", code: "ens_not_found" },
        { status: 404 },
      );
    };

    const first = await withEnsCache(options, load);
    expect(first.status).toBe(404);
    expect(first.headers.get("x-archive-cache")).toBe("MISS");
    expect(first.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300");
    await first.arrayBuffer();
    await Promise.all(pending);

    const second = await withEnsCache(options, load);
    expect(second.status).toBe(404);
    expect(second.headers.get("x-archive-cache")).toBe("HIT");
    expect(loads).toBe(1);
    await second.arrayBuffer();
  });

  it("caches successful resolutions at the edge for seven days", async () => {
    const pending: Promise<unknown>[] = [];
    let loads = 0;
    const options = {
      requestUrl: "https://poap.in/api/resolve-address?name=resolved-cache-test.eth",
      name: "resolved-cache-test.eth",
      apiVersion: "test-v1",
      executionCtx: {
        waitUntil(promise: Promise<unknown>) {
          pending.push(promise);
        },
      },
    };
    const load = async () => {
      loads += 1;
      return Response.json({
        name: "resolved-cache-test.eth",
        address: "0x17470261d36fd5f3c6d19e750f6f6f7b389df357",
      });
    };

    const first = await withEnsCache(options, load);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=604800");
    await first.arrayBuffer();
    await Promise.all(pending);

    const second = await withEnsCache(options, load);
    expect(second.headers.get("x-archive-cache")).toBe("HIT");
    expect(loads).toBe(1);
    await second.arrayBuffer();
  });

  it("rejects invalid requests before any RPC lookup", async () => {
    const response = await SELF.fetch("https://poap.in/api/resolve-address?name=not-an-ens-name");
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_ens_name" });
  });
});
