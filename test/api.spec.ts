import { afterEach, describe, expect, it, vi } from "vitest";
import { getOwner } from "../src/react-app/api";

describe("browser API cache policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bypasses a stale browser cache for address-bound holdings", async () => {
    const response = {
      address: "0x1111111111111111111111111111111111111111",
      total: 0,
      uniqueDrops: 0,
      items: [],
      nextCursor: null,
    };
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(getOwner(response.address, null, controller.signal)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/owners/${response.address}?limit=48`,
      expect.objectContaining({
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      }),
    );
  });
});
