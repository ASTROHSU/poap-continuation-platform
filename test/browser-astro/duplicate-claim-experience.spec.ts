import { expect, test } from "@playwright/test";

const ADDRESS = "0x8888888888888888888888888888888888888888";
const TRANSACTION_HASH = `0x${"cd".repeat(32)}`;

test("an already claimed ENS shows the existing collectible without relaying again", async ({
  page,
}) => {
  let relayRequests = 0;
  await page.route("**/api/app-config", (route) =>
    route.fulfill({
      json: {
        mode: "live-only",
        walletProvisioning: { mode: "disabled", enabled: false, publishableKey: null },
        embeddedWallet: {
          provider: "magic",
          enabled: false,
          publishableKey: null,
          emailTemplateName: null,
        },
      },
    }),
  );
  await page.route("**/api/live/events/august-book-club-2026", (route) =>
    route.fulfill({
      json: {
        eventId: "event-august-book-club-2026",
        slug: "august-book-club-2026",
        title: "8 月線上讀書會",
        description: "共同紀念",
        imageUrl: "/brand/logo_poap.svg",
        eventUrl: null,
        startsAt: "2026-08-09T06:00:00.000Z",
        claimOpensAt: "2026-08-09T00:00:00.000Z",
        claimClosesAt: "2026-08-31T23:59:59.999Z",
        chainId: 8453,
        contractAddress: "0x09567074611047B24f31bcfc33092fC99B3893e5",
        tokenId: "1",
        maxSupply: 200,
        claimedCount: 92,
        mintedCount: 92,
        claimMode: "shared",
        status: "published",
      },
    }),
  );
  await page.route("**/api/resolve-address?*", (route) =>
    route.fulfill({ json: { name: "collector.eth", address: ADDRESS } }),
  );
  await page.route("**/api/live/events/august-book-club-2026/claims", (route) =>
    route.fulfill({
      json: {
        eventId: "event-august-book-club-2026",
        slug: "august-book-club-2026",
        address: ADDRESS,
        claimedAt: "2026-08-09T06:00:00.000Z",
        mintStatus: "minted",
        mintedTxHash: TRANSACTION_HASH,
        mintedAt: "2026-08-09T06:01:00.000Z",
        explorerUrl: `https://basescan.org/tx/${TRANSACTION_HASH}`,
        alreadyClaimed: true,
      },
    }),
  );
  await page.route("**/api/live/events/august-book-club-2026/relay", (route) => {
    relayRequests += 1;
    return route.abort();
  });

  await page.goto("/claim/august-book-club-2026?code=shared-code");
  await page.getByLabel("收藏這份數位紀念").fill("collector.eth");
  await page.getByRole("button", { name: "領取" }).click();

  await expect(page.getByRole("heading", { name: "已經領過了" })).toBeVisible();
  await expect(page.getByText("你的數位紀念已經在這邊了。")).toBeVisible();
  await expect(page.getByText("你的收藏")).toBeVisible();
  await expect(page.getByText("8 月線上讀書會").last()).toBeVisible();
  await expect(page.getByRole("link", { name: "查看我的收藏" })).toHaveAttribute(
    "href",
    `/address/${ADDRESS}`,
  );
  expect(relayRequests).toBe(0);
});
