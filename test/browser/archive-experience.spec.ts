import { createHash } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

const ADDRESS = "0x17470261d36fd5f3c6d19e750f6f6f7b389df357";
const MOMENT_MEDIA_URL =
  "https://media.poap.in/snapshots/moments-2026-07-23-v1/moments/original/example.mp4";

const archiveMeta = {
  snapshotId: "2026-07-02-v1",
  snapshotAt: "2026-07-02T00:00:00.000Z",
  counts: { drops: 73_876, tokens: 6_218_154, owners: 1_236_466, artworks: 73_795 },
  years: [2026, 2025],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/meta", (route) => route.fulfill({ json: archiveMeta }));
  await page.route("**/api/collections/meta", (route) =>
    route.fulfill({
      json: {
        snapshotId: "collections-2026-07-23-v1",
        releaseId: "collections-2026-07-23-r1",
        snapshotAt: "2026-07-23T00:00:00.000Z",
        count: 2_016,
      },
    }),
  );
  await page.route("**/api/moments/meta", (route) =>
    route.fulfill({
      json: {
        snapshotId: "moments-2026-07-23-v1",
        snapshotAt: "2026-07-23T00:00:00.000Z",
        counts: { sourceMoments: 25_959, publicMoments: 24_459, media: 32_891, capsules: 0 },
      },
    }),
  );
  await page.route("**/api/drops?*", (route) =>
    route.fulfill({ json: { items: [drop(1, "Archive opening")], nextCursor: null } }),
  );
  await page.route("**/api/collections?*", (route) =>
    route.fulfill({
      json: {
        items: [collection(1, "Archive stewards")],
        nextCursor: null,
      },
    }),
  );
  await page.route("**/api/moments?*", (route) =>
    route.fulfill({
      json: {
        snapshotId: "moments-2026-07-23-v1",
        items: [moment("00000000-0000-4000-8000-000000000001")],
        nextCursor: null,
      },
    }),
  );
});

test("homepage leads with address lookup, exact statistics, and small archive previews", async ({
  page,
}) => {
  let requestedName = "";
  const mediaRequests: string[] = [];
  await page.route("**/api/resolve-address?*", async (route) => {
    requestedName = new URL(route.request().url()).searchParams.get("name") ?? "";
    await route.fulfill({ json: { name: "ericmwalk.eth", address: ADDRESS } });
  });
  await page.route("https://media.poap.in/**", async (route) => {
    mediaRequests.push(route.request().url());
    await route.abort();
  });
  await mockOwnerPage(page, {
    items: [holding(3, 1_773_705_600)],
    nextCursor: null,
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Find the POAPs you kept/i })).toBeVisible();
  await expect(page.getByLabel("Look up a collection")).toBeVisible();
  await expect(page.getByText("POAP is dead. Long live POAP!")).toBeVisible();
  await expect(page.getByLabel("Search drops")).toHaveCount(0);
  await expect(page.getByText("Search the archive")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Preserved Drops" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Collections", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Moments", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse all Drops" })).toHaveAttribute(
    "href",
    "/drops",
  );
  await expect(page.getByRole("link", { name: "Explore Collections" })).toHaveAttribute(
    "href",
    "/collections",
  );
  await expect(page.getByRole("link", { name: "Browse public Moments" })).toHaveAttribute(
    "href",
    "/moments",
  );
  await expect(page.locator(".home-preview--drops .drop-card")).toHaveCount(1);
  await expect(page.locator(".home-preview--collections .collection-card")).toHaveCount(1);
  await expect(page.locator(".home-preview--moments .moment-card")).toHaveCount(1);
  await expect(page.locator(".drop-card__id")).toHaveCount(0);
  await expect(page.locator("video, audio")).toHaveCount(0);
  expect(mediaRequests).toEqual([]);

  const statistics = page.getByRole("region", { name: "Archive statistics" });
  await expect(statistics.getByText("73,876", { exact: true })).toBeVisible();
  await expect(statistics.getByText("2,016", { exact: true })).toBeVisible();
  await expect(statistics.getByText("24,459", { exact: true })).toBeVisible();
  await expect(statistics.getByText("6,218,154", { exact: true })).toBeVisible();
  await expect(statistics.getByText("1,236,466", { exact: true })).toBeVisible();
  await expect(statistics.getByText("collectors", { exact: true })).toBeVisible();
  await expect(statistics.getByText("addresses", { exact: true })).toHaveCount(0);
  await expect(statistics.getByText("artworks", { exact: true })).toHaveCount(0);
  await expect(page.getByText("73.9K", { exact: true })).toHaveCount(0);
  await expect(page.getByText("6.2M", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" }).getByText("Lookup", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", {
      name: "Drops",
      exact: true,
    }),
  ).toHaveAttribute("href", "/drops");

  const heroHeading = page.getByRole("heading", { level: 1 });
  const heroFontSize = await heroHeading.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(heroFontSize).toBeLessThanOrEqual(64);

  const addressLookup = page.getByLabel("Look up a collection");
  await addressLookup.focus();
  await expect
    .poll(() =>
      addressLookup.evaluate(
        (input) => getComputedStyle(input.closest(".lookup-input")!).borderColor,
      ),
    )
    .toBe("rgb(224, 199, 47)");
  const lookupFocusStyle = await addressLookup.evaluate((input) => {
    const inputStyle = getComputedStyle(input);
    const wrapperStyle = getComputedStyle(input.closest(".lookup-input")!);
    return {
      inputBoxShadow: inputStyle.boxShadow,
      inputFocusVisible: input.matches(":focus-visible"),
      inputOutlineStyle: inputStyle.outlineStyle,
      inputOutlineWidth: inputStyle.outlineWidth,
      wrapperBorderColor: wrapperStyle.borderColor,
      wrapperBoxShadow: wrapperStyle.boxShadow,
    };
  });
  expect(lookupFocusStyle).toMatchObject({
    inputBoxShadow: "none",
    inputFocusVisible: true,
    inputOutlineStyle: "none",
    inputOutlineWidth: "0px",
    wrapperBorderColor: "rgb(224, 199, 47)",
  });
  expect(lookupFocusStyle.wrapperBoxShadow).not.toBe("none");

  await addressLookup.fill("ericmwalk.eth");
  await page.getByRole("button", { name: "View collection" }).click();
  await expect(page).toHaveURL(`/address/${ADDRESS}`);
  expect(requestedName).toBe("ericmwalk.eth");
});

test("direct ENS address URLs resolve to the canonical collection URL", async ({ page }) => {
  let requestedName = "";
  await page.route("**/api/resolve-address?*", async (route) => {
    requestedName = new URL(route.request().url()).searchParams.get("name") ?? "";
    await route.fulfill({ json: { name: "poap.eth", address: ADDRESS.toUpperCase() } });
  });
  await mockOwnerPage(page, {
    items: [holding(3, 1_773_705_600)],
    nextCursor: null,
  });

  await page.goto("/address/poap.eth");

  await expect(page).toHaveURL(`/address/${ADDRESS}`);
  await expect(page.getByRole("heading", { name: "POAP collection" })).toBeVisible();
  expect(requestedName).toBe("poap.eth");
});

test("ENS names beginning with 0x are resolved as names when they contain a dot", async ({
  page,
}) => {
  let requestedName = "";
  await page.route("**/api/resolve-address?*", async (route) => {
    requestedName = new URL(route.request().url()).searchParams.get("name") ?? "";
    await route.fulfill({ json: { name: "0x1234.eth", address: ADDRESS } });
  });
  await mockOwnerPage(page, {
    items: [holding(3, 1_773_705_600)],
    nextCursor: null,
  });

  await page.goto("/address/0x1234.eth");

  await expect(page).toHaveURL(`/address/${ADDRESS}`);
  expect(requestedName).toBe("0x1234.eth");
});

test("incomplete 0x paths fail locally without calling the ENS resolver", async ({ page }) => {
  let resolverCalls = 0;
  await page.route("**/api/resolve-address?*", async (route) => {
    resolverCalls += 1;
    await route.fulfill({ status: 500, json: { error: "unexpected lookup" } });
  });

  await page.goto("/address/0x1234");

  await expect(page.getByRole("heading", { name: "That address is not valid" })).toBeVisible();
  await expect(page.getByText("Use a complete 0x address or an ENS name")).toBeVisible();
  expect(resolverCalls).toBe(0);
});

test("legacy homepage Drop searches move to the dedicated catalog", async ({ page }) => {
  await page.goto("/?q=archive&year=2026&type=virtual&sort=popular");

  await expect(page).toHaveURL("/drops?q=archive&year=2026&type=virtual&sort=popular");
  await expect(page.getByLabel("Search drops")).toHaveValue("archive");
  await expect(page.getByLabel("Year")).toHaveValue("2026");
  await expect(page.getByLabel("Format")).toHaveValue("virtual");
  await expect(page.getByLabel("Sort")).toHaveValue("popular");
});

test("the complete searchable Drop catalog lives at /drops", async ({ page }) => {
  await page.goto("/drops");

  await expect(page.getByRole("heading", { name: "Browse POAP Drops" })).toBeVisible();
  await expect(page.getByLabel("Search drops")).toBeVisible();
  await expect(page.getByLabel("Year")).toBeVisible();
  await expect(page.getByLabel("Format")).toBeVisible();
  await expect(page.getByLabel("Sort")).toBeVisible();
  await expect(page.locator(".drop-card__id")).toHaveCount(0);

  await page.getByLabel("Search drops").fill("archive");
  await expect(page).toHaveURL("/drops?q=archive");
});

test("address page leads with the collection, exact relationships, and month groups", async ({
  page,
}) => {
  await mockOwnerPage(page, {
    items: [holding(30, 1_770_854_400), holding(29, 1_773_619_200), holding(28, null)],
    nextCursor: null,
  });

  await page.goto(`/address/${ADDRESS.toUpperCase()}/`);
  await expect(page).toHaveURL(`/address/${ADDRESS}`);

  await expect(page.getByRole("heading", { name: "POAP collection" })).toBeVisible();
  await expect(page.getByText("2,477", { exact: true })).toBeVisible();
  await expect(page.getByText("12", { exact: true })).toBeVisible();
  await expect(page.getByText("3,053", { exact: true })).toBeVisible();
  await expect(page.getByText("46", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Minted in March 2026" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Minted in February 2026" })).toBeVisible();
  await expect(page.locator(".owner-month__heading h3")).toHaveText([
    "Minted in March 2026",
    "Minted in February 2026",
    "Mint date unavailable",
  ]);

  const holdingsTop = await page
    .locator(".owner-holdings")
    .evaluate((element) => element.offsetTop);
  const exportTop = await page.locator(".export-panel").evaluate((element) => element.offsetTop);
  expect(holdingsTop).toBeLessThan(exportTop);

  const firstCard = await page.locator(".owner-month .drop-card").first().boundingBox();
  expect(firstCard).not.toBeNull();
  expect(firstCard!.y).toBeLessThan(900);
  await expect(page.locator(".drop-card__id")).toHaveCount(0);
});

test("address pages label held private Drops without linking to the global catalog", async ({
  page,
}) => {
  await mockOwnerPage(page, {
    items: [holding(99, 1_773_705_600, true)],
    nextCursor: null,
  });

  await page.goto(`/address/${ADDRESS}`);

  const card = page.locator(".drop-card").filter({ hasText: "Collected Drop 99" });
  await expect(card.getByText("Private Drop", { exact: true })).toBeVisible();
  await expect(card.locator(".drop-card__link--static")).toHaveCount(1);
  await expect(card.locator('a[href="/drop/99"]')).toHaveCount(0);
  await expect(
    page.getByText("private Drop metadata appears only when this exact address", {
      exact: false,
    }),
  ).toBeVisible();
});

test("personal site exporter uses compact hierarchy and recognizable deployment cards", async ({
  page,
}) => {
  const mediaRequests: string[] = [];
  await page.route("https://media.poap.in/**", async (route) => {
    mediaRequests.push(route.request().url());
    await route.abort();
  });
  await mockOwnerPage(page, {
    items: [holding(30, 1_773_705_600)],
    nextCursor: null,
  });

  await page.goto(`/address/${ADDRESS}/site`);

  const heroHeading = page.getByRole("heading", {
    level: 1,
    name: "Turn this address into a personal POAP site.",
  });
  const packageHeading = page.getByRole("heading", {
    level: 2,
    name: "What goes into the package",
  });
  await expect(heroHeading).toBeVisible();
  await expect(packageHeading).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Download your archived images" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare image archive" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save all images ZIP" })).toHaveCount(0);
  expect(mediaRequests).toEqual([]);
  await expect(page.locator(".personal-site-metric")).toHaveCount(5);
  await expect(page.getByText("2,477", { exact: true })).toBeVisible();
  await expect(page.getByText("3,053", { exact: true })).toBeVisible();
  await expect(page.getByText("46", { exact: true })).toBeVisible();
  await expect(page.getByText("12", { exact: true })).toBeVisible();

  const typeScale = await page.evaluate(() => ({
    hero: Number.parseFloat(
      getComputedStyle(document.querySelector(".personal-site-hero h1")!).fontSize,
    ),
    packageHeading: Number.parseFloat(
      getComputedStyle(document.querySelector(".personal-site-summary h2")!).fontSize,
    ),
    metric: Number.parseFloat(
      getComputedStyle(document.querySelector(".personal-site-metric strong")!).fontSize,
    ),
    cardBody: Number.parseFloat(
      getComputedStyle(document.querySelector(".deployment-card > p")!).fontSize,
    ),
    cardBodyColor: getComputedStyle(document.querySelector(".deployment-card > p")!).color,
  }));
  expect(typeScale.hero).toBeLessThanOrEqual(56);
  expect(typeScale.packageHeading).toBeLessThanOrEqual(34);
  expect(typeScale.metric).toBeLessThanOrEqual(40);
  expect(typeScale.cardBody).toBeGreaterThanOrEqual(13);
  expect(typeScale.cardBodyColor).toBe("rgb(39, 69, 82)");

  for (const brand of ["cloudflare", "vercel", "filebase", "icp"]) {
    await expect(page.locator(`[data-deployment-brand="${brand}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-deployment-brand="${brand}"]`)).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  }
  await expect(page.locator(".deployment-card")).toHaveCount(4);
  await expect(page.getByRole("link", { name: "Open Cloudflare Drop" })).toHaveAttribute(
    "href",
    "https://www.cloudflare.com/drop/",
  );
  await expect(page.getByRole("link", { name: "Open Vercel Drop" })).toHaveAttribute(
    "href",
    "https://vercel.com/drop",
  );
  await expect(
    page.getByRole("button", { name: "Copy Cloudflare Drop prompt for my agent" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy Vercel Drop prompt for my agent" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 320, height: 700 });
  const mobileLayout = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    heroHeight: document.querySelector(".personal-site-hero")!.getBoundingClientRect().height,
  }));
  expect(mobileLayout).toMatchObject({ viewport: 320, content: 320 });
  expect(mobileLayout.heroHeight).toBeLessThan(520);
});

test("image archive preparation stays media-idle and Save builds the complete ZIP", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: undefined,
    });
  });
  const mediaRequests: string[] = [];
  const { imageUrl, imageBytes } = await mockMinimalImageArchive(page);
  await page.route(imageUrl, async (route) => {
    mediaRequests.push(route.request().url());
    await route.fulfill({
      status: 200,
      body: imageBytes,
      headers: {
        "Access-Control-Allow-Origin": "http://127.0.0.1:4173",
        "Content-Length": String(imageBytes.byteLength),
        "Content-Type": "image/png",
        ETag: '"browser-test"',
      },
    });
  });

  await page.goto(`/address/${ADDRESS}/site`);
  await page.getByRole("button", { name: "Prepare image archive" }).click();

  await expect(page.getByText("1 unique images", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Save all images ZIP" })).toBeEnabled();
  await expect(page.getByRole("progressbar", { name: "Image archive progress" })).toHaveAttribute(
    "aria-valuenow",
    "100",
  );
  expect(mediaRequests).toEqual([]);

  await page.getByRole("button", { name: "Save all images ZIP" }).click();

  await expect(page.getByText("Your image ZIP is ready.", { exact: true })).toBeVisible();
  expect(mediaRequests).toEqual([imageUrl]);
  const download = page.getByRole("link", { name: "Download image ZIP" });
  await expect(download).toHaveAttribute("href", /^blob:/);
  await expect(download).toHaveAttribute("download", "poapin-all-images-0x174702-9df357.zip");
});

test("image archive streams to a native file destination when the browser supports it", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const testWindow = window as typeof window & {
      __imageArchiveSave?: { bytes: number; closed: boolean; suggestedName: string };
      showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
        createWritable(): Promise<WritableStream<Uint8Array>>;
      }>;
    };
    testWindow.showSaveFilePicker = async ({ suggestedName }) => ({
      async createWritable() {
        testWindow.__imageArchiveSave = { bytes: 0, closed: false, suggestedName };
        return new WritableStream<Uint8Array>({
          write(chunk) {
            testWindow.__imageArchiveSave!.bytes += chunk.byteLength;
          },
          close() {
            testWindow.__imageArchiveSave!.closed = true;
          },
        });
      },
    });
  });
  const { imageUrl, imageBytes } = await mockMinimalImageArchive(page);
  await page.route(imageUrl, (route) =>
    route.fulfill({
      status: 200,
      body: imageBytes,
      headers: {
        "Access-Control-Allow-Origin": "http://127.0.0.1:4173",
        "Content-Length": String(imageBytes.byteLength),
        "Content-Type": "image/png",
      },
    }),
  );

  await page.goto(`/address/${ADDRESS}/site`);
  await page.getByRole("button", { name: "Prepare image archive" }).click();
  await expect(page.getByText("1 unique images", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Save all images ZIP" }).click();

  await expect(page.getByText("Your image ZIP was saved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download image ZIP" })).toHaveCount(0);
  const saved = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __imageArchiveSave?: { bytes: number; closed: boolean; suggestedName: string };
        }
      ).__imageArchiveSave,
  );
  expect(saved).toEqual({
    bytes: expect.any(Number),
    closed: true,
    suggestedName: "poapin-all-images-0x174702-9df357.zip",
  });
  expect(saved!.bytes).toBeGreaterThan(imageBytes.byteLength);
});

test("loading another page merges holdings into the existing month", async ({ page }) => {
  await mockOwnerPage(page, {
    items: [holding(30, 1_773_705_600), holding(29, 1_773_619_200)],
    nextCursor: "next-page",
    nextItems: [holding(28, 1_773_532_800)],
  });

  await page.goto(`/address/${ADDRESS}`);
  await expect(page.locator(".owner-month")).toHaveCount(1);
  await expect(page.locator(".owner-month__heading")).toContainText("2 loaded");

  await page.getByRole("button", { name: "Load more POAPs" }).click();
  await expect(page.locator(".owner-month")).toHaveCount(1);
  await expect(page.locator(".owner-month__heading")).toContainText("3 loaded");
});

test("the refreshed lookup and address summary do not overflow a phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockOwnerPage(page, {
    items: [holding(30, 1_773_705_600)],
    nextCursor: null,
  });

  await page.goto("/");
  expect(
    await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    })),
  ).toEqual({ viewport: 390, content: 390 });

  await page.goto("/drops");
  expect(
    await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    })),
  ).toEqual({ viewport: 390, content: 390 });

  await page.goto(`/address/${ADDRESS}`);
  expect(
    await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    })),
  ).toEqual({ viewport: 390, content: 390 });
});

test("the homepage lookup remains usable at the minimum supported viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");

  const layout = await page.getByLabel("Look up a collection").evaluate((input) => ({
    inputWidth: input.getBoundingClientRect().width,
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));

  expect(layout.inputWidth).toBeGreaterThanOrEqual(120);
  expect(layout).toMatchObject({ viewport: 320, content: 320 });
  await expect(page.getByRole("button", { name: "View collection" })).toBeVisible();
});

async function mockOwnerPage(
  page: Page,
  {
    items,
    nextCursor,
    nextItems = [],
  }: {
    items: ReturnType<typeof holding>[];
    nextCursor: string | null;
    nextItems?: ReturnType<typeof holding>[];
  },
) {
  await page.route(`**/api/owners/${ADDRESS}?*`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    await route.fulfill({
      json: {
        address: ADDRESS,
        total: 2_477,
        uniqueDrops: 2_400,
        items: cursor ? nextItems : items,
        nextCursor: cursor ? null : nextCursor,
      },
    });
  });
  await page.route(`**/api/owners/${ADDRESS}/export/manifest`, (route) =>
    route.fulfill({
      json: {
        schemaVersion: "poapin-personal-export-v1",
        address: ADDRESS,
        snapshots: {
          holdings: "2026-07-02-v1",
          collections: "collections-2026-07-23-v1",
          moments: "moments-2026-07-23-v1",
        },
        sources: {
          holdings: { snapshotId: "2026-07-02-v1" },
          collections: {
            snapshotId: "collections-2026-07-23-v1",
            releaseId: "collections-2026-07-23-r1",
          },
          moments: {
            snapshotId: "moments-2026-07-23-v1",
            releaseId: "moments-2026-07-23-r1",
            sourceDatabaseSha256: "a".repeat(64),
            buildManifestSha256: "b".repeat(64),
          },
        },
        counts: {
          holdings: 2_477,
          authoredMoments: 3_053,
          taggedMoments: 46,
          ownedCollections: 12,
          ownedCapsules: 0,
        },
        segments: {
          holdings: { path: `/api/owners/${ADDRESS}/export/holdings?limit=480`, pageSize: 480 },
          ownedCollections: {
            path: `/api/collections/owners/${ADDRESS}/export?limit=48`,
            pageSize: 48,
          },
          moments: { path: `/api/moments/authors/${ADDRESS}/export?limit=48`, pageSize: 48 },
          taggedMoments: { path: `/api/moments/tags/${ADDRESS}/export?limit=48`, pageSize: 48 },
          ownedCapsules: { path: `/api/capsules/owners/${ADDRESS}/export?limit=48`, pageSize: 48 },
        },
      },
    }),
  );
}

async function mockMinimalImageArchive(
  page: Page,
): Promise<{ imageUrl: string; imageBytes: Buffer }> {
  const snapshots = {
    holdings: "2026-07-02-v1",
    collections: "collections-2026-07-23-v1",
    moments: "moments-2026-07-23-v1",
  };
  const sourceDatabaseSha256 = "a".repeat(64);
  const buildManifestSha256 = "b".repeat(64);
  const imageBytes = Buffer.from("archived-image");
  const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
  const imageUrl =
    `https://media.poap.in/snapshots/${snapshots.moments}/moments/original/` +
    `sha256/${imageSha256.slice(0, 2)}/${imageSha256}.png`;
  const release = {
    snapshotId: snapshots.moments,
    releaseId: "moments-2026-07-23-r1",
    sourceDatabaseSha256,
    buildManifestSha256,
  };

  await page.route(`**/api/owners/${ADDRESS}/export/manifest`, (route) =>
    route.fulfill({
      json: {
        schemaVersion: "poapin-personal-export-v1",
        address: ADDRESS,
        snapshots,
        sources: {
          holdings: { snapshotId: snapshots.holdings },
          collections: {
            snapshotId: snapshots.collections,
            releaseId: "collections-2026-07-23-r1",
          },
          moments: release,
        },
        counts: {
          holdings: 0,
          authoredMoments: 1,
          taggedMoments: 0,
          ownedCollections: 0,
          ownedCapsules: 0,
        },
        segments: {
          holdings: {
            path: `/api/owners/${ADDRESS}/export/holdings?limit=480`,
            pageSize: 480,
          },
          ownedCollections: {
            path: `/api/collections/owners/${ADDRESS}/export?limit=48`,
            pageSize: 48,
          },
          moments: {
            path: `/api/moments/authors/${ADDRESS}/export?limit=48`,
            pageSize: 48,
          },
          taggedMoments: {
            path: `/api/moments/tags/${ADDRESS}/export?limit=48`,
            pageSize: 48,
          },
          ownedCapsules: {
            path: `/api/capsules/owners/${ADDRESS}/export?limit=48`,
            pageSize: 48,
          },
        },
      },
    }),
  );
  await page.route(`**/api/owners/${ADDRESS}/export/holdings?*`, (route) =>
    route.fulfill({
      json: {
        schemaVersion: "poapin-personal-holdings-page-v2",
        snapshotId: snapshots.holdings,
        collectionsSnapshotId: snapshots.collections,
        collectionsReleaseId: "collections-2026-07-23-r1",
        address: ADDRESS,
        total: 0,
        items: [],
        drops: [],
        unavailableDropIds: [],
        nextCursor: null,
      },
    }),
  );
  await page.route(`**/api/moments/authors/${ADDRESS}/export?*`, (route) =>
    route.fulfill({
      json: {
        schemaVersion: "poapin-moment-author-export-v1",
        ...release,
        author: ADDRESS,
        items: [imageMoment(imageUrl, imageBytes.byteLength)],
        nextCursor: null,
      },
    }),
  );
  await page.route(`**/api/moments/tags/${ADDRESS}/export?*`, (route) =>
    route.fulfill({
      json: {
        schemaVersion: "poapin-moment-tagged-export-v1",
        ...release,
        address: ADDRESS,
        items: [],
        nextCursor: null,
      },
    }),
  );
  await page.route(`**/api/capsules/owners/${ADDRESS}/export?*`, (route) =>
    route.fulfill({
      json: {
        schemaVersion: "poapin-capsule-owner-export-v1",
        ...release,
        address: ADDRESS,
        items: [],
        nextCursor: null,
      },
    }),
  );
  await page.route(`**/api/collections/owners/${ADDRESS}/export?*`, (route) =>
    route.fulfill({
      json: {
        schemaVersion: "poapin-owned-collections-page-v1",
        snapshotId: snapshots.collections,
        releaseId: "collections-2026-07-23-r1",
        address: ADDRESS,
        items: [],
        nextCursor: null,
      },
    }),
  );
  return { imageUrl, imageBytes };
}

function imageMoment(imageUrl: string, byteLength: number) {
  const previewMedia = {
    mediaId: "00000000-0000-4000-8000-000000000201",
    kind: "image",
    mimeType: "image/png",
    url: imageUrl,
    thumbnailUrl: null,
    width: 16,
    height: 16,
  };
  return {
    momentId: "00000000-0000-4000-8000-000000000202",
    displayId: "image-archive-test",
    author: ADDRESS,
    description: "A browser-side image archive fixture.",
    createdOn: "2026-07-23T00:00:00.000Z",
    updatedOn: null,
    isUpdated: false,
    sourceMediaCount: 1,
    mediaCount: 1,
    mediaPreservationState: "complete",
    previewMedia,
    dropIds: [],
    collectionIds: [],
    cid: null,
    tokenId: null,
    media: [
      {
        ...previewMedia,
        byteLength,
        durationMs: null,
        position: 0,
      },
    ],
    links: [],
    userTags: [],
    capsules: [],
  };
}

function holding(dropId: number, mintedOn: number | null, isPrivate = false) {
  return {
    ...drop(dropId, `Collected Drop ${dropId}`),
    sourceUid: `source-${dropId}`,
    poapId: dropId,
    mintedOn,
    ownerAddress: ADDRESS,
    network: "ethereum",
    transferCount: 0,
    ...(isPrivate ? { isPrivate: true as const } : {}),
  };
}

function drop(dropId: number, title: string) {
  return {
    dropId,
    title,
    startDate: "2026-01-01T00:00:00.000Z",
    year: 2026,
    imageUrl: "/brand/logo_poap.svg",
    hasArtwork: true,
    tokenCount: 1,
  };
}

function collection(collectionId: number, title: string) {
  return {
    collectionId,
    slug: `collection-${collectionId}`,
    title,
    description: "A public Collection preserved for the homepage preview.",
    type: "organization",
    year: 2026,
    updatedOn: "2026-07-23T00:00:00.000Z",
    itemCount: 12,
    sectionCount: 2,
    logoUrl: "/brand/logo_poap.svg",
    bannerUrl: null,
    isFeatured: false,
    isVerified: true,
  };
}

function moment(momentId: string) {
  return {
    momentId,
    displayId: "homepage-preview",
    author: ADDRESS,
    description: "A public Moment whose media must remain deferred on the homepage.",
    createdOn: "2026-07-23T00:00:00.000Z",
    updatedOn: null,
    isUpdated: false,
    sourceMediaCount: 1,
    mediaCount: 1,
    mediaPreservationState: "complete",
    previewMedia: {
      mediaId: "00000000-0000-4000-8000-000000000101",
      kind: "video",
      mimeType: "video/mp4",
      url: MOMENT_MEDIA_URL,
      thumbnailUrl: MOMENT_MEDIA_URL,
      width: 1280,
      height: 720,
    },
    dropIds: [1],
    collectionIds: [1],
  };
}
