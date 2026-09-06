import { describe, expect, it } from "vitest";
import { baseMainnetRpcUrl } from "../src/worker/rpc-config";

describe("baseMainnetRpcUrl", () => {
  it("prefers the dedicated secret endpoint", () => {
    expect(
      baseMainnetRpcUrl({
        BASE_MAINNET_RPC_URL: "https://fallback.example",
        BASE_MAINNET_ALCHEMY_RPC_URL: " https://dedicated.example ",
      }),
    ).toBe("https://dedicated.example");
  });

  it("keeps the public endpoint as a zero-downtime fallback", () => {
    expect(
      baseMainnetRpcUrl({
        BASE_MAINNET_RPC_URL: "https://fallback.example",
      }),
    ).toBe("https://fallback.example");
  });
});
