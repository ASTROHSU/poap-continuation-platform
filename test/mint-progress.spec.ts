import { describe, expect, it } from "vitest";
import { mintProgressLabel } from "../frontend-astro/src/lib/mint-progress";

describe("collector-visible mint progress", () => {
  it("uses only the two approved collector-facing states", () => {
    expect(mintProgressLabel("minting")).toBe("正在鑄造");
    expect(mintProgressLabel("minted")).toBe("鑄造完成");
    const visibleCopy = [mintProgressLabel("minting"), mintProgressLabel("minted")].join(" ");
    expect(visibleCopy).not.toMatch(/排隊|nonce|RPC|underpriced|timeout/i);
  });
});
