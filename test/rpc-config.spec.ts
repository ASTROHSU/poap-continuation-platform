import { describe, expect, it } from "vitest";
import {
  baseMainnetHistoryRpcUrl,
  baseMainnetLiveRpcUrls,
  baseMainnetRpcUrl,
} from "../src/worker/rpc-config";

describe("Base mainnet RPC routing", () => {
  it("keeps live operations on the original RPC", () => {
    expect(
      baseMainnetRpcUrl({
        BASE_MAINNET_RPC_URL: "https://live.example",
      }),
    ).toBe("https://live.example");
  });

  it("keeps the original RPC first and uses an independent live fallback", () => {
    expect(
      baseMainnetLiveRpcUrls({
        BASE_MAINNET_RPC_URL: "https://live.example",
        BASE_MAINNET_FALLBACK_RPC_URL: " https://fallback.example ",
      }),
    ).toEqual(["https://live.example", "https://fallback.example"]);
  });

  it("does not silently use the historical endpoint for live operations", () => {
    expect(
      baseMainnetLiveRpcUrls({
        BASE_MAINNET_RPC_URL: "https://live.example",
      }),
    ).toEqual(["https://live.example"]);
  });

  it("uses the isolated historical RPC only for historical reads", () => {
    expect(
      baseMainnetHistoryRpcUrl({
        BASE_MAINNET_RPC_URL: "https://live.example",
        BASE_MAINNET_INDEXER_RPC_URL: " https://history.example ",
      }),
    ).toBe("https://history.example");
  });

  it("falls back to the original RPC when no historical endpoint is configured", () => {
    expect(
      baseMainnetHistoryRpcUrl({
        BASE_MAINNET_RPC_URL: "https://live.example",
      }),
    ).toBe("https://live.example");
  });
});
