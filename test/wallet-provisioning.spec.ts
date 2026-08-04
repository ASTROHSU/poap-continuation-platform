import { describe, expect, it, vi } from "vitest";
import { createMagicPregenWallet } from "../src/worker/wallet-provisioning";
import { publicMagicEmbeddedWalletConfig } from "../src/worker/magic-auth";

describe("Magic Embedded Wallet configuration", () => {
  it("publishes the client key only when the matching server secret is present", () => {
    expect(
      publicMagicEmbeddedWalletConfig({
        MAGIC_PUBLISHABLE_API_KEY: "pk_live_example",
        MAGIC_SECRET_KEY: "sk_live_example",
        MAGIC_EMAIL_TEMPLATE_NAME: "poap-retention-zh-tw",
      }),
    ).toEqual({
      provider: "magic",
      enabled: true,
      publishableKey: "pk_live_example",
      emailTemplateName: "poap-retention-zh-tw",
    });
    expect(
      publicMagicEmbeddedWalletConfig({
        MAGIC_PUBLISHABLE_API_KEY: "pk_live_example",
        MAGIC_SECRET_KEY: "",
        MAGIC_EMAIL_TEMPLATE_NAME: "poap-retention-zh-tw",
      }),
    ).toEqual({
      provider: "magic",
      enabled: false,
      publishableKey: null,
      emailTemplateName: null,
    });
  });
});

describe("Magic PreGen provider adapter", () => {
  it("sends the Email only to the documented admin endpoint and validates the address", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ public_address: "0x1111111111111111111111111111111111111111" }),
      );
    await expect(
      createMagicPregenWallet("collector@example.com", "sk_test_example", fetchMock),
    ).resolves.toBe("0x1111111111111111111111111111111111111111");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.magic.link/v1/admin/pregen/wallet",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "collector@example.com" }),
        headers: expect.objectContaining({ "X-Magic-Secret-Key": "sk_test_example" }),
      }),
    );
  });

  it("fails closed when Magic returns malformed data or a rate limit", async () => {
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    await expect(
      createMagicPregenWallet("collector@example.com", "sk_test_example", malformed),
    ).rejects.toThrow("magic_invalid_response");

    const limited = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "RATE_LIMIT" }, { status: 429 }));
    await expect(
      createMagicPregenWallet("collector@example.com", "sk_test_example", limited),
    ).rejects.toThrow("magic_rate_limited");
  });
});
