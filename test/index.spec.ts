import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { withSnapshotCache } from "../src/worker/cache";
import {
  fetchCollectionItems,
  fetchCollections,
  fetchCollectionsMeta,
  fetchCollectionsReadiness,
} from "../src/worker/collections-repository";
import { csvCell } from "../src/worker/exports";
import { collectionsApiVersion } from "../src/worker/index";
import {
  artworkUrl,
  collectionDropArtworkUrl,
  collectionMediaObjectUrl,
} from "../src/worker/media";
import { fetchDrop, fetchDrops, fetchMeta, fetchOwnerTotal } from "../src/worker/repository";
import type { Bindings } from "../src/worker/types";
import {
  parseCollectionItemsQuery,
  parseCollectionsQuery,
  parseDropsQuery,
} from "../src/worker/validation";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const HOLDING_ARTWORK_SHA = `ab${"c".repeat(62)}`;
const CATALOG_FALLBACK_ARTWORK_SHA = `de${"f".repeat(62)}`;
interface TestBindings extends Bindings {
  TEST_CATALOG_FIXTURE: string;
  TEST_CATALOG_MIGRATIONS: D1Migration[];
  TEST_HOLDINGS_FIXTURE: string;
  TEST_HOLDINGS_MIGRATIONS: D1Migration[];
  TEST_COLLECTIONS_FIXTURE: string;
  TEST_COLLECTIONS_MIGRATIONS: D1Migration[];
}
const bindings = env as unknown as TestBindings;

beforeAll(async () => {
  await applyD1Migrations(bindings.CATALOG_DB, bindings.TEST_CATALOG_MIGRATIONS);
  await applyD1Migrations(bindings.HOLDINGS_DB, bindings.TEST_HOLDINGS_MIGRATIONS);
  await applyD1Migrations(bindings.COLLECTIONS_DB, bindings.TEST_COLLECTIONS_MIGRATIONS);
  await executeSql(bindings.CATALOG_DB, bindings.TEST_CATALOG_FIXTURE);
  await executeSql(bindings.HOLDINGS_DB, bindings.TEST_HOLDINGS_FIXTURE);
  await executeSql(bindings.COLLECTIONS_DB, bindings.TEST_COLLECTIONS_FIXTURE);
  await bindings.HOLDINGS_DB.prepare(
    `
      INSERT INTO tokens (
        source_uid,
        poap_id,
        drop_id,
        minted_on,
        owner_address_norm,
        network,
        transfer_count
      ) VALUES
        ('collector-fixture-200', 200, 2, 1540944000,
          '0x2222222222222222222222222222222222222222', 'xdai', 0),
        ('collector-fixture-199', 199, 2, 1540857600,
          '0x4444444444444444444444444444444444444444', 'xdai', 2)
    `,
  ).run();
  await bindings.CATALOG_DB.prepare(
    "UPDATE drops SET event_url = 'javascript:alert(1)' WHERE drop_id = 2",
  ).run();
  await bindings.HOLDINGS_DB.prepare(
    `
      INSERT INTO holding_drops (
        drop_id, fancy_id, title, description, start_date, end_date,
        expiry_date, city, country, event_url, year, is_virtual, is_private,
        is_hidden, channel, platform, location_type, timezone, integrator_id,
        created_at, image_url, animation_url, token_count, transfer_count
      ) VALUES
        (3, 'updated-drop-3', 'Updated Drop Three', 'Holdings artwork fallback',
          '2015-11-09T00:00:00Z', '2015-11-13T00:00:00Z', NULL, 'London',
          'United Kingdom', NULL, 2015, 0, 0, 0, NULL, NULL,
          'in-person', 'UTC', NULL, '2015-11-01T00:00:00Z',
          'https://assets.poap.xyz/drop-3.png', NULL, 1, 0),
        (2, 'updated-drop-2', 'Updated Drop Two', 'Newer Graph metadata',
          '2018-10-29T00:00:00Z', '2018-10-30T00:00:00Z', NULL, 'Prague',
          'Czechia', 'javascript:alert(1)', 2018, 0, 0, 0, NULL, NULL,
          'in-person', 'UTC', NULL, '2018-10-01T00:00:00Z',
          'https://assets.poap.xyz/drop-2.png', NULL, 3, 3),
        (2001, 'graph-private', 'Graph Private Drop', 'Preserved for its holder',
          '2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z', NULL, 'Cannes',
          'France', 'https://events.example.invalid/private', 2026, 0, 1, 0,
          NULL, NULL, 'in-person', 'Europe/Paris', 'graph-fixture',
          '2026-04-01T00:00:00Z', 'https://assets.poap.xyz/private.png', NULL, 1, 0),
        (2002, 'graph-hidden', 'Graph Hidden Drop', 'Must not be exposed',
          '2026-05-03T00:00:00Z', '2026-05-04T00:00:00Z', NULL, NULL, NULL,
          NULL, 2026, 1, 0, 1, NULL, NULL, 'virtual', 'UTC', NULL,
          '2026-04-02T00:00:00Z', NULL, NULL, 1, 0)
    `,
  ).run();
  await bindings.HOLDINGS_DB.prepare(
    `
      INSERT INTO holding_drop_artwork (
        drop_id, object_key, sha256, byte_length, content_type, source_url, archived_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `,
  )
    .bind(
      2002,
      `snapshots/${bindings.HOLDINGS_SNAPSHOT_ID}/holdings/drop-artwork/sha256/ab/${HOLDING_ARTWORK_SHA}.png`,
      HOLDING_ARTWORK_SHA,
      1234,
      "image/png",
      "https://assets.poap.xyz/hidden.png",
      "2026-07-28T00:00:00.000Z",
    )
    .run();
  await bindings.HOLDINGS_DB.prepare(
    `
      INSERT INTO holding_drop_artwork (
        drop_id, object_key, sha256, byte_length, content_type, source_url, archived_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `,
  )
    .bind(
      3,
      `snapshots/${bindings.HOLDINGS_SNAPSHOT_ID}/holdings/drop-artwork/sha256/de/${CATALOG_FALLBACK_ARTWORK_SHA}.png`,
      CATALOG_FALLBACK_ARTWORK_SHA,
      2345,
      "image/png",
      "https://assets.poap.xyz/drop-3.png",
      "2026-07-28T00:00:00.000Z",
    )
    .run();
  await bindings.HOLDINGS_DB.prepare(
    `
      INSERT INTO tokens (
        source_uid, poap_id, drop_id, minted_on, owner_address_norm, network, transfer_count
      ) VALUES
        ('graph-private-token', 7587009, 2001, 1777593600,
          '0x5555555555555555555555555555555555555555', 'xdai', 0),
        ('graph-hidden-token', 7587008, 2002, 1777593500,
          '0x5555555555555555555555555555555555555555', 'xdai', 0)
    `,
  ).run();
  await bindings.HOLDINGS_DB.prepare(
    `
      INSERT INTO owner_stats (
        owner_address_norm, token_count, unique_drop_count, first_minted_on, last_minted_on
      ) VALUES (
        '0x5555555555555555555555555555555555555555', 2, 2, 1777593500, 1777593600
      )
    `,
  ).run();
});

async function executeSql(db: D1Database, sql: string): Promise<void> {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
}

describe("archive API", () => {
  it("returns precomputed snapshot metadata", async () => {
    const response = await SELF.fetch("https://poap.in/api/meta");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-archive-api-version")).toBe("v1");
    expect(await response.json()).toEqual({
      snapshotId: "2026-07-02-v1",
      snapshotAt: "2026-07-02T14:28:17.259Z",
      holdingsSnapshotId: "2026-07-02-v1",
      holdingsSnapshotAt: "2026-07-02T14:28:17.259Z",
      counts: { drops: 3, tokens: 3, owners: 2, artworks: 2 },
      years: [2018, 2015],
    });
  });

  it("returns precomputed, release-bound Collections metadata", async () => {
    const response = await SELF.fetch("https://poap.in/api/collections/meta");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-archive-api-version")).toBe(
      "v1.collections-v3.collections-2026-07-22-v1-c1f9213b",
    );
    await expect(response.json()).resolves.toEqual({
      snapshotId: "collections-2026-07-22-v1",
      releaseId: "collections-2026-07-22-v1-c1f9213b",
      snapshotAt: "2026-07-22T12:00:00.000Z",
      count: 4,
    });

    await expect(
      fetchCollectionsMeta(
        bindings.COLLECTIONS_DB.withSession("first-primary"),
        "wrong-collections-snapshot",
        "test-release",
      ),
    ).rejects.toMatchObject({ code: "snapshot_mismatch" });
  });

  it("uses keyset cursors and canonical R2 artwork URLs", async () => {
    const first = await SELF.fetch("https://poap.in/api/drops?limit=1");
    const firstPage = await first.json<{
      items: Array<{ dropId: number; imageUrl: string }>;
      nextCursor: string;
    }>();
    expect(firstPage.items[0]).toMatchObject({
      dropId: 2,
      imageUrl: "https://media.poap.in/snapshots/2026-07-02-v1/artwork/2.webp",
    });

    const params = new URLSearchParams({ limit: "1", cursor: firstPage.nextCursor });
    const second = await SELF.fetch(`https://poap.in/api/drops?${params}`);
    const secondPage = await second.json<{
      items: Array<{ dropId: number }>;
      nextCursor: string;
    }>();
    expect(secondPage.items[0]?.dropId).toBe(1);

    const finalParams = new URLSearchParams({ limit: "1", cursor: secondPage.nextCursor });
    const final = await SELF.fetch(`https://poap.in/api/drops?${finalParams}`);
    const finalPage = await final.json<{
      items: Array<{ dropId: number }>;
      nextCursor: null;
    }>();
    expect(finalPage.items[0]?.dropId).toBe(3);
    expect(finalPage.nextCursor).toBeNull();
  });

  it("sanitizes FTS input and filters virtual drops", async () => {
    const response = await SELF.fetch(
      "https://poap.in/api/drops?q=virtual%20OR%20gathering&type=virtual&limit=48",
    );
    expect(response.status).toBe(200);
    const page = await response.json<{ items: Array<{ dropId: number }> }>();
    // OR is searched as an ordinary word joined with AND, never as an FTS operator.
    expect(page.items).toEqual([]);
  });

  it("returns details and removes unsafe event URLs", async () => {
    const response = await SELF.fetch("https://poap.in/api/drops/2");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-archive-api-version")).toBe(
      `v1.collections-v3.${bindings.COLLECTIONS_RELEASE_ID}.drop-detail-v7`,
    );
    expect(await response.json()).toMatchObject({
      dropId: 2,
      eventUrl: null,
      tokenCount: 3,
      reservationsTotal: 2,
      reservationsMinted: 1,
    });
  });

  it("uses bounded Holdings metadata for exact and holder-proven private or hidden Drops", async () => {
    const exact = await SELF.fetch("https://poap.in/api/drops/2001");
    expect(exact.status).toBe(200);
    await expect(exact.json()).resolves.toMatchObject({
      dropId: 2001,
      title: "Graph Private Drop",
      city: "Cannes",
      tokenCount: 1,
      isPrivate: true,
      imageUrl: "",
      hasArtwork: false,
    });

    const hidden = await SELF.fetch("https://poap.in/api/drops/2002");
    expect(hidden.status).toBe(200);
    await expect(hidden.json()).resolves.toMatchObject({
      dropId: 2002,
      title: "Graph Hidden Drop",
      isHidden: true,
      hasArtwork: true,
      imageUrl: `https://media.poap.in/snapshots/${bindings.HOLDINGS_SNAPSHOT_ID}/holdings/drop-artwork/sha256/ab/${HOLDING_ARTWORK_SHA}.png`,
    });

    const owner = await SELF.fetch(
      "https://poap.in/api/owners/0x5555555555555555555555555555555555555555?limit=48",
    );
    expect(owner.status).toBe(200);
    await expect(owner.json()).resolves.toMatchObject({
      total: 2,
      uniqueDrops: 2,
      items: expect.arrayContaining([
        expect.objectContaining({
          poapId: 7587009,
          dropId: 2001,
          title: "Graph Private Drop",
          isPrivate: true,
        }),
        expect.objectContaining({
          poapId: 7587008,
          dropId: 2002,
          title: "Graph Hidden Drop",
          isHidden: true,
        }),
      ]),
    });
  });

  it("fills missing catalog artwork from the holder-bound Holdings archive", async () => {
    const owner = await SELF.fetch(
      "https://poap.in/api/owners/0x3333333333333333333333333333333333333333?limit=48",
    );
    expect(owner.status).toBe(200);
    await expect(owner.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          dropId: 3,
          title: "DevCon1",
          hasArtwork: true,
          imageUrl: `https://media.poap.in/snapshots/${bindings.HOLDINGS_SNAPSHOT_ID}/holdings/drop-artwork/sha256/de/${CATALOG_FALLBACK_ARTWORK_SHA}.png`,
        }),
      ],
    });
  });

  it("returns private or hidden Drops only when an exact ID is requested", async () => {
    const response = await SELF.fetch("https://poap.in/api/drops/1002");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      dropId: 1002,
      fancyId: "synthetic-stream",
      title: "Synthetic Livestream",
      eventUrl: "https://events.example.invalid/stream",
      tokenCount: 12,
      reservationsTotal: 12,
      reservationsMinted: 8,
      reservationsUnminted: 4,
      expiryDate: "2025-04-02T10:30:00.000",
      integratorId: "fixture",
      dropTransferCount: 91,
      featuredOn: "2026-07-11T00:00:00.000Z",
      momentsUploaded: 7,
      imageUrl: "",
      hasArtwork: false,
      isPrivate: true,
    });

    const browse = await SELF.fetch("https://poap.in/api/drops?q=Synthetic%20Livestream");
    await expect(browse.json()).resolves.toMatchObject({ items: [] });

    const hidden = await SELF.fetch("https://poap.in/api/drops/1004");
    expect(hidden.status).toBe(200);
    await expect(hidden.json()).resolves.toMatchObject({ dropId: 1004, isHidden: true });
    const hiddenBrowse = await SELF.fetch("https://poap.in/api/drops?q=Hidden");
    await expect(hiddenBrowse.json()).resolves.toMatchObject({ items: [] });
  });

  it("lists every archived collector record for an exact Drop with an indexed keyset", async () => {
    const first = await SELF.fetch("https://poap.in/api/drops/2/collectors?limit=1");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-archive-api-version")).toBe(
      `v1.drop-collectors-v2.v1.collections-v3.${bindings.COLLECTIONS_RELEASE_ID}`,
    );
    const firstPage = await first.json<{
      snapshotId: string;
      dropId: number;
      items: Array<{
        poapId: number;
        ownerAddress: string;
        mintedOn: number;
        network: string;
        transferCount: number;
      }>;
      nextCursor: string;
    }>();
    expect(firstPage).toMatchObject({
      snapshotId: "2026-07-02-v1",
      dropId: 2,
      items: [
        {
          poapId: 200,
          ownerAddress: "0x2222222222222222222222222222222222222222",
          mintedOn: 1540944000,
          network: "xdai",
          transferCount: 0,
        },
      ],
    });

    const secondSearch = new URLSearchParams({
      cursor: firstPage.nextCursor,
      limit: "1",
    });
    const secondPage = await (
      await SELF.fetch(`https://poap.in/api/drops/2/collectors?${secondSearch}`)
    ).json<{ items: Array<{ poapId: number }>; nextCursor: string }>();
    expect(secondPage.items.map((item) => item.poapId)).toEqual([199]);

    const thirdSearch = new URLSearchParams({
      limit: "1",
      cursor: secondPage.nextCursor,
    });
    const thirdPage = await (
      await SELF.fetch(`https://poap.in/api/drops/2/collectors?${thirdSearch}`)
    ).json<{ items: Array<{ poapId: number }>; nextCursor: null }>();
    expect(thirdPage.items.map((item) => item.poapId)).toEqual([2]);
    expect(thirdPage.nextCursor).toBeNull();

    const plan = await bindings.HOLDINGS_DB.prepare(
      `
        EXPLAIN QUERY PLAN
        SELECT
          r.source_uid,
          r.poap_id,
          t.minted_on,
          r.owner_address_norm,
          t.network,
          t.transfer_count
        FROM drop_collector_refs r
        JOIN tokens t
          ON t.owner_address_norm = r.owner_address_norm
         AND t.poap_id = r.poap_id
         AND t.source_uid = r.source_uid
        WHERE r.drop_id = ?1
        ORDER BY r.poap_id DESC, r.source_uid DESC, r.owner_address_norm DESC
        LIMIT ?2
      `,
    )
      .bind(2, 49)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join("\n");
    expect(details).toContain("SEARCH r USING PRIMARY KEY");
    expect(details).toContain("SEARCH t USING PRIMARY KEY");
    expect(details).not.toContain("SCAN tokens");
    expect(details).not.toContain("SCAN drop_collector_refs");
    expect(details).not.toContain("USE TEMP B-TREE");
  });

  it("serves exact hidden Drop collectors and rejects collector scan amplification", async () => {
    const [hidden, privateDrop, badLimit, unknown, badCursor] = await Promise.all([
      SELF.fetch("https://poap.in/api/drops/1004/collectors?limit=48"),
      SELF.fetch("https://poap.in/api/drops/1002/collectors?limit=48"),
      SELF.fetch("https://poap.in/api/drops/2/collectors?limit=49"),
      SELF.fetch("https://poap.in/api/drops/2/collectors?offset=1"),
      SELF.fetch("https://poap.in/api/drops/2/collectors?cursor=not-a-cursor"),
    ]);
    expect(hidden.status).toBe(200);
    await expect(hidden.json()).resolves.toMatchObject({ dropId: 1004, items: [] });
    expect(privateDrop.status).toBe(200);
    await expect(privateDrop.json()).resolves.toMatchObject({ dropId: 1002, items: [] });
    expect([badLimit.status, unknown.status, badCursor.status]).toEqual([400, 400, 400]);
    for (const response of [badLimit, unknown, badCursor]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("paginates exact owner lookups without exposing address discovery", async () => {
    const first = await SELF.fetch(`https://poap.in/api/owners/${ADDRESS}?limit=1`);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-archive-api-version")).toBe(
      `v1.owner-v6.v1.collections-v3.${bindings.COLLECTIONS_RELEASE_ID}`,
    );
    const page = await first.json<{
      address: string;
      total: number;
      uniqueDrops: number;
      items: Array<{ poapId: number; dropId: number }>;
      nextCursor: string;
    }>();
    expect(page).toMatchObject({
      address: ADDRESS,
      total: 2,
      uniqueDrops: 2,
      items: [{ poapId: 2, dropId: 2 }],
    });

    const params = new URLSearchParams({ limit: "1", cursor: page.nextCursor });
    const second = await SELF.fetch(`https://poap.in/api/owners/${ADDRESS}?${params}`);
    const nextPage = await second.json<{ items: Array<{ poapId: number }>; nextCursor: null }>();
    expect(nextPage.items[0]?.poapId).toBe(1);
    expect(nextPage.nextCursor).toBeNull();
  });

  it("streams a versioned JSON owner export", async () => {
    const response = await SELF.fetch(`https://poap.in/api/owners/${ADDRESS}/export.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(".json");
    const body = await response.json<{
      schema_version: string;
      queried_address: string;
      count: number;
      tokens: Array<{ source_uid: string; artwork_url: string }>;
    }>();
    expect(body.schema_version).toBe("poapin-address-export-v3");
    expect(body.queried_address).toBe(ADDRESS);
    expect(body.count).toBe(2);
    expect(body.tokens).toHaveLength(2);
    expect(body.tokens[0]?.artwork_url).toBe(
      "https://media.poap.in/snapshots/2026-07-02-v1/artwork/2.webp",
    );
  });

  it("rejects invalid and CPU-amplifying parameters", async () => {
    const [badLimit, shortSearch, unknown, badAddress] = await Promise.all([
      SELF.fetch("https://poap.in/api/drops?limit=49"),
      SELF.fetch("https://poap.in/api/drops?q=a"),
      SELF.fetch("https://poap.in/api/drops?offset=100000"),
      SELF.fetch("https://poap.in/api/owners/0x1234"),
    ]);
    expect([badLimit.status, shortSearch.status, unknown.status, badAddress.status]).toEqual([
      400, 400, 400, 400,
    ]);
    for (const response of [badLimit, shortSearch, unknown, badAddress]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("uses a schema-versioned canonical cache key", async () => {
    const first = await SELF.fetch("https://poap.in/api/drops?year=2015&limit=48");
    expect(first.headers.get("x-archive-cache")).toBe("MISS");
    expect(first.headers.get("x-archive-api-version")).toBe("v1");
    await first.arrayBuffer();

    const reordered = await SELF.fetch("https://poap.in/api/drops?limit=48&year=2015");
    expect(reordered.headers.get("x-archive-cache")).toBe("HIT");
  });

  it("uses the popular partial index without a temporary sort", async () => {
    const plan = await bindings.CATALOG_DB.prepare(
      `
      EXPLAIN QUERY PLAN
      SELECT drop_id, token_count
      FROM drops
      WHERE is_private = 0
      ORDER BY token_count DESC, drop_id DESC
      LIMIT 49
    `,
    ).all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join("\n");
    expect(details).toContain("idx_drops_popular");
    expect(details).not.toContain("USE TEMP B-TREE");
  });

  it("fails closed when either D1 snapshot does not match the deployment", async () => {
    const catalogDb = bindings.CATALOG_DB.withSession("first-primary");
    const browseQuery = parseDropsQuery(
      new URL("https://poap.in/api/drops?limit=1"),
      "wrong-snapshot",
    );
    await expect(fetchMeta(catalogDb, "wrong-snapshot")).rejects.toMatchObject({
      code: "snapshot_mismatch",
    });
    await expect(
      fetchDrops(catalogDb, browseQuery, "wrong-snapshot", "https://media.poap.in"),
    ).rejects.toMatchObject({ code: "snapshot_mismatch" });
    await expect(
      fetchDrop(catalogDb, 2, "https://media.poap.in", "wrong-snapshot"),
    ).rejects.toMatchObject({ code: "snapshot_mismatch" });
    await expect(
      fetchOwnerTotal(bindings.HOLDINGS_DB.withSession("first-primary"), ADDRESS, "wrong-snapshot"),
    ).rejects.toMatchObject({ code: "snapshot_mismatch" });
  });

  it("does not advertise a known-missing artwork in exports", async () => {
    const address = "0x3333333333333333333333333333333333333333";
    const response = await SELF.fetch(`https://poap.in/api/owners/${address}/export.json`);
    const body = await response.json<{
      snapshot_id: string;
      tokens: Array<{ artwork_url: string | null }>;
    }>();
    expect(body.snapshot_id).toBe("2026-07-02-v1");
    expect(body.tokens[0]?.artwork_url).toBeNull();
  });
});

describe("collections API", () => {
  it("browses recent public collections with a stable updated-on keyset", async () => {
    const first = await SELF.fetch("https://poap.in/api/collections?limit=1");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-archive-snapshot")).toBe("collections-2026-07-22-v1");
    expect(bindings.COLLECTIONS_RELEASE_ID).toBe("collections-2026-07-22-v1-c1f9213b");
    expect(first.headers.get("x-archive-api-version")).toBe(
      `v1.collections-v3.${bindings.COLLECTIONS_RELEASE_ID}`,
    );
    const firstPage = await first.json<{
      items: Array<{ collectionId: number; slug: string }>;
      nextCursor: string;
    }>();
    expect(firstPage.items).toEqual([
      expect.objectContaining({ collectionId: 101, slug: "shared-history" }),
    ]);

    const mismatchedParams = new URLSearchParams({
      type: "artist",
      limit: "1",
      cursor: firstPage.nextCursor,
    });
    expect((await SELF.fetch(`https://poap.in/api/collections?${mismatchedParams}`)).status).toBe(
      400,
    );

    const secondParams = new URLSearchParams({ limit: "1", cursor: firstPage.nextCursor });
    const secondPage = await (
      await SELF.fetch(`https://poap.in/api/collections?${secondParams}`)
    ).json<{
      items: Array<{ collectionId: number; slug: string }>;
      nextCursor: null;
    }>();
    expect(secondPage.items).toEqual([
      expect.objectContaining({ collectionId: 103, slug: "wallet-memories" }),
    ]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("safely filters collection search, type, and year", async () => {
    const response = await SELF.fetch(
      "https://poap.in/api/collections?q=synthetic%20organization&type=organization&year=2025&limit=24",
    );
    expect(response.status).toBe(200);
    const page = await response.json<{ items: Array<{ collectionId: number }> }>();
    expect(page.items).toEqual([expect.objectContaining({ collectionId: 102 })]);

    const operatorInput = await SELF.fetch(
      "https://poap.in/api/collections?q=synthetic%20OR%20organization&limit=24",
    );
    const operatorPage = await operatorInput.json<{ items: unknown[] }>();
    expect(operatorPage.items).toEqual([]);
  });

  it("propagates both active snapshot IDs into public drop artwork mapping", async () => {
    const dropId = 1001;
    const original = await bindings.COLLECTIONS_DB.prepare(
      "SELECT image_object_key FROM collection_drop_cards WHERE drop_id = ?1",
    )
      .bind(dropId)
      .first<{ image_object_key: string | null }>();
    expect(original).not.toBeNull();

    const setObjectKey = (objectKey: string | null) =>
      bindings.COLLECTIONS_DB.prepare(
        "UPDATE collection_drop_cards SET image_object_key = ?1 WHERE drop_id = ?2",
      )
        .bind(objectKey, dropId)
        .run();
    try {
      const archiveKey = `snapshots/${bindings.SNAPSHOT_ID}/artwork/${dropId}.webp`;
      await setObjectKey(archiveKey);
      const archivePage = await (
        await SELF.fetch("https://poap.in/api/collections/101/items?limit=1")
      ).json<{ items: Array<{ drop: { imageUrl: string | null } | null }> }>();
      expect(archivePage.items[0]?.drop?.imageUrl).toBe(`https://media.poap.in/${archiveKey}`);

      const sha256 = `34${"d".repeat(62)}`;
      const collectionKey =
        `snapshots/${bindings.COLLECTIONS_SNAPSHOT_ID}/collections/drop-artwork/sha256/34/` +
        `${sha256}.png`;
      await setObjectKey(collectionKey);
      const collectionPage = await (
        await SELF.fetch("https://poap.in/api/collections/101/items?limit=2")
      ).json<{ items: Array<{ drop: { imageUrl: string | null } | null }> }>();
      expect(collectionPage.items[0]?.drop?.imageUrl).toBe(
        `https://media.poap.in/${collectionKey}`,
      );
    } finally {
      await setObjectKey(original?.image_object_key ?? null);
    }
  });

  it("returns a bounded collection detail keyed only by collection ID", async () => {
    const response = await SELF.fetch("https://poap.in/api/collections/101");
    expect(response.status).toBe(200);
    const detail = await response.json<{
      snapshotId: string;
      collection: {
        collectionId: number;
        logoUrl: string;
        bannerUrl: string;
        externalUrl: string;
      };
      urls: Array<{ urlId: number; url: string }>;
      uiSettings: { primaryColor: string; togglePoapElements: boolean };
      media: Array<{ role: string; objectUrl: string | null; eligibleForPublish: boolean }>;
      sections: Array<{ sectionId: string; position: number }>;
      artists: Array<{ artistId: string; ens: string | null; name: string | null }>;
      organizations: Array<{ organizationId: number; name: string }>;
      items: {
        total: number;
        items: Array<{
          itemId: number;
          sections: Array<{ sectionId: string; position: number }>;
          drop: { dropId: number; title: string; imageUrl: string | null };
        }>;
        nextCursor: null;
      };
    }>();

    expect(detail.snapshotId).toBe("collections-2026-07-22-v1");
    expect(detail.collection).toMatchObject({
      collectionId: 101,
      logoUrl:
        "https://media.poap.in/snapshots/collections-2026-07-22-v1/collections/media/sha256/11/1111111111111111111111111111111111111111111111111111111111111111.png",
      bannerUrl:
        "https://media.poap.in/snapshots/collections-2026-07-22-v1/collections/media/sha256/22/2222222222222222222222222222222222222222222222222222222222222222.jpg",
      externalUrl: "https://artist.example.invalid/",
    });
    expect(detail.collection).not.toHaveProperty("createdBy");
    expect(detail.urls.map((entry) => entry.urlId)).toEqual([5001, 5002]);
    expect(detail.uiSettings).toMatchObject({
      primaryColor: "#5c5aa0",
      togglePoapElements: true,
    });
    expect(detail.media).toHaveLength(2);
    expect(detail.media[0]).toMatchObject({
      role: "logo",
      eligibleForPublish: true,
    });
    expect(detail.sections).toEqual([
      {
        sectionId: "11111111-1111-4111-8111-111111111111",
        position: 0,
        name: "Highlights",
      },
    ]);
    expect(detail.artists).toEqual([
      expect.objectContaining({
        artistId: "33333333-3333-4333-8333-333333333333",
        ens: "synthetic-artist.eth",
        name: "Synthetic Artist",
      }),
    ]);
    expect(detail.organizations).toEqual([]);
    expect(detail.items.total).toBe(2);
    expect(detail.items.items[0]).toMatchObject({
      itemId: 10001,
      sections: [{ sectionId: "11111111-1111-4111-8111-111111111111", position: 0 }],
      drop: {
        dropId: 1001,
        title: "Synthetic Opening Night",
        // The fixture deliberately carries a legacy non-content-addressed
        // object_key; the public Worker must fail closed instead of mapping it.
        imageUrl: null,
        isPrivate: false,
        tokenCount: 42,
        transferCount: 9,
        emailClaims: { minted: 4, reserved: 2, total: 6 },
        featuredOn: "2026-07-10T00:00:00.000Z",
        momentsUploaded: 3,
      },
    });
    expect(detail.items.items[0]?.drop).not.toHaveProperty("privateValue");
    expect(detail.items.items[0]?.drop).not.toHaveProperty("animationUrl");
    expect(detail.items.nextCursor).toBeNull();

    const unsafeUrlDetail = await (
      await SELF.fetch("https://poap.in/api/collections/102")
    ).json<{
      urls: Array<{ url: string | null }>;
      organizations: Array<{ organizationId: number; name: string }>;
    }>();
    expect(unsafeUrlDetail.urls[0]?.url).toBeNull();
    expect(unsafeUrlDetail.organizations).toEqual([
      expect.objectContaining({ organizationId: 201, name: "Synthetic Organization" }),
    ]);

    const quarantinedMediaDetail = await (
      await SELF.fetch("https://poap.in/api/collections/103")
    ).json<{
      collection: Record<string, unknown>;
      media: Array<{
        role: string;
        objectUrl: string | null;
        status: string;
        eligibleForPublish: boolean;
      }>;
    }>();
    expect(quarantinedMediaDetail.collection).not.toHaveProperty("sourceBannerUrl");
    expect(quarantinedMediaDetail.collection).toHaveProperty(
      "ownerAddress",
      "0x2222222222222222222222222222222222222222",
    );
    expect(quarantinedMediaDetail.media).toEqual([
      expect.objectContaining({
        role: "banner",
        objectUrl: null,
        status: "quarantined",
        eligibleForPublish: false,
      }),
    ]);
    expect(quarantinedMediaDetail.media[0]).not.toHaveProperty("sourceUrl");
    expect(quarantinedMediaDetail.media[0]).not.toHaveProperty("resolvedSourceUrl");
    expect(quarantinedMediaDetail.media[0]).not.toHaveProperty("failureReason");
    const hiddenDrop = (
      quarantinedMediaDetail as unknown as {
        items: { items: Array<{ drop: Record<string, unknown> }> };
      }
    ).items.items[0]?.drop;
    expect(hiddenDrop).toEqual({ dropId: 1004, isHidden: true });
    expect(hiddenDrop).not.toHaveProperty("title");
    expect(hiddenDrop).not.toHaveProperty("imageUrl");
  });

  it("paginates collection items and their drop cards without an unbounded response", async () => {
    const first = await SELF.fetch("https://poap.in/api/collections/101/items?limit=1");
    const firstPage = await first.json<{
      total: number;
      items: Array<{ itemId: number; drop: { dropId: number } }>;
      nextCursor: string;
    }>();
    expect(firstPage).toMatchObject({
      total: 2,
      items: [{ itemId: 10001, drop: { dropId: 1001 } }],
    });

    const params = new URLSearchParams({ limit: "1", cursor: firstPage.nextCursor });
    const secondPage = await (
      await SELF.fetch(`https://poap.in/api/collections/101/items?${params}`)
    ).json<{
      items: Array<{ itemId: number; drop: Record<string, unknown> }>;
      nextCursor: null;
    }>();
    expect(secondPage.items).toEqual([
      {
        itemId: 10002,
        createdOn: "2025-03-03T00:00:00.000Z",
        sections: [{ sectionId: "11111111-1111-4111-8111-111111111111", position: 1 }],
        drop: { dropId: 1002, isPrivate: true },
      },
    ]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("exports a manifest plus independently cacheable metadata and item segments", async () => {
    const manifestResponse = await SELF.fetch("https://poap.in/api/collections/101/export");
    expect(manifestResponse.status).toBe(200);
    const manifest = await manifestResponse.json<{
      schemaVersion: string;
      counts: {
        items: number;
        sections: number;
        urls: number;
        media: number;
        artistDrops: number;
        suggestions: number;
        dropStats: number;
      };
      segments: Array<{ name: string; path: string; pagination: string; count: number }>;
    }>();
    expect(manifest.schemaVersion).toBe("poapin-collection-export-v1");
    expect(manifest.counts).toEqual({
      items: 2,
      sections: 1,
      urls: 2,
      media: 2,
      artistDrops: 2,
      suggestions: 1,
      dropStats: 3,
    });
    expect(manifest.segments).toEqual([
      {
        name: "metadata",
        path: "/api/collections/101/export/metadata",
        pagination: "none",
        count: 1,
      },
      {
        name: "items",
        path: "/api/collections/101/export/items?limit=48",
        pagination: "cursor",
        count: 2,
        pageSize: 48,
      },
      {
        name: "artist-drops",
        path: "/api/collections/101/export/artist-drops?limit=48",
        pagination: "cursor",
        count: 2,
        pageSize: 48,
      },
      {
        name: "suggestions",
        path: "/api/collections/101/export/suggestions?limit=48",
        pagination: "cursor",
        count: 1,
        pageSize: 48,
      },
      {
        name: "drop-stats",
        path: "/api/collections/101/export/drop-stats?limit=48",
        pagination: "cursor",
        count: 3,
        pageSize: 48,
      },
    ]);

    const metadata = await (
      await SELF.fetch("https://poap.in/api/collections/101/export/metadata")
    ).json<{
      schemaVersion: string;
      collection: { collectionId: number };
      sections: unknown[];
      artists: Array<{ artistId: string }>;
    }>();
    expect(metadata).toMatchObject({
      schemaVersion: "poapin-collection-export-v1",
      collection: { collectionId: 101 },
    });
    expect(metadata.collection).toHaveProperty("ownerAddress", null);
    expect(metadata.sections).toHaveLength(1);
    expect(metadata.artists[0]?.artistId).toBe("33333333-3333-4333-8333-333333333333");

    const firstSegment = await (
      await SELF.fetch("https://poap.in/api/collections/101/export/items?limit=1")
    ).json<{
      schemaVersion: string;
      items: unknown[];
      nextPath: string;
    }>();
    expect(firstSegment.schemaVersion).toBe("poapin-collection-export-v1");
    expect(firstSegment.items).toHaveLength(1);
    const finalSegment = await (
      await SELF.fetch(new URL(firstSegment.nextPath, "https://poap.in"))
    ).json<{ items: unknown[]; nextPath: null }>();
    expect(finalSegment.items).toHaveLength(1);
    expect(finalSegment.nextPath).toBeNull();

    const firstArtistDrops = await (
      await SELF.fetch("https://poap.in/api/collections/101/export/artist-drops?limit=1")
    ).json<{
      items: Array<{ artistId: string; dropId: number; drop: { title: string } }>;
      nextPath: string;
    }>();
    expect(firstArtistDrops.items).toEqual([
      expect.objectContaining({
        artistId: "33333333-3333-4333-8333-333333333333",
        dropId: 1001,
        drop: expect.objectContaining({
          title: "Synthetic Opening Night",
          tokenCount: 42,
          transferCount: 9,
          emailClaims: { minted: 4, reserved: 2, total: 6 },
          featuredOn: "2026-07-10T00:00:00.000Z",
          momentsUploaded: 3,
        }),
      }),
    ]);
    const finalArtistDrops = await (
      await SELF.fetch(new URL(firstArtistDrops.nextPath, "https://poap.in"))
    ).json<{ items: Array<{ dropId: number; drop: Record<string, unknown> }>; nextPath: null }>();
    expect(finalArtistDrops.items[0]?.dropId).toBe(1002);
    expect(finalArtistDrops.items[0]?.drop).toEqual({ dropId: 1002, isPrivate: true });
    expect(finalArtistDrops.nextPath).toBeNull();

    const suggestions = await (
      await SELF.fetch("https://poap.in/api/collections/101/export/suggestions?limit=1")
    ).json<{
      items: Array<{
        suggestionId: number;
        dropId: number;
        createdOn: string;
        drop: { title: string; imageUrl: string | null };
      }>;
      nextPath: null;
    }>();
    expect(suggestions.items).toEqual([
      {
        suggestionId: 7002,
        dropId: 1003,
        suggestedBy: "0x5555555555555555555555555555555555555555",
        createdOn: "2026-07-19T00:00:00.000Z",
        drop: expect.objectContaining({
          title: "Synthetic Suggested Drop",
          imageUrl: null,
          tokenCount: 0,
          transferCount: 0,
          emailClaims: null,
          featuredOn: null,
          momentsUploaded: 0,
        }),
      },
    ]);
    expect(suggestions.items[0]).not.toHaveProperty("curationStatus");
    expect(suggestions.items[0]).not.toHaveProperty("reviewedOn");
    expect(suggestions.items[0]?.drop).not.toHaveProperty("animationUrl");
    expect(suggestions.nextPath).toBeNull();

    const unapprovedOnly = await (
      await SELF.fetch("https://poap.in/api/collections/102/export/suggestions?limit=48")
    ).json<{ items: unknown[]; nextPath: null }>();
    expect(unapprovedOnly.items).toEqual([]);
    expect(unapprovedOnly.nextPath).toBeNull();

    const unapprovedManifest = await (
      await SELF.fetch("https://poap.in/api/collections/102/export")
    ).json<{ segments: Array<{ name: string }> }>();
    expect(unapprovedManifest.segments.map((segment) => segment.name)).not.toContain("suggestions");

    const emptyManifest = await (
      await SELF.fetch("https://poap.in/api/collections/104/export")
    ).json<{ segments: Array<{ name: string }> }>();
    expect(emptyManifest.segments.map((segment) => segment.name)).not.toContain("drop-stats");
  });

  it("exports bounded, deduplicated drop statistics without leaking redacted drops", async () => {
    const firstResponse = await SELF.fetch(
      "https://poap.in/api/collections/101/export/drop-stats?limit=2",
    );
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json<{
      schemaVersion: string;
      snapshotId: string;
      collectionId: number;
      items: Array<Record<string, unknown>>;
      nextCursor: string;
      nextPath: string;
    }>();
    expect(first).toMatchObject({
      schemaVersion: "poapin-collection-export-v1",
      snapshotId: "collections-2026-07-22-v1",
      collectionId: 101,
    });
    expect(first.items).toEqual([
      {
        dropId: 1001,
        isPrivate: false,
        isHidden: false,
        tokenCount: 42,
        transferCount: 9,
        emailClaims: { minted: 4, reserved: 2, total: 6 },
        featuredOn: "2026-07-10T00:00:00.000Z",
        momentsUploaded: 3,
        byChain: [
          {
            chain: "ethereum",
            createdOn: 1704067200,
            poapCount: 30,
            transferCount: 7,
          },
          {
            chain: "gnosis",
            createdOn: 1704153600,
            poapCount: 12,
            transferCount: 2,
          },
        ],
      },
      { dropId: 1002, isPrivate: true },
    ]);

    const final = await (
      await SELF.fetch(new URL(first.nextPath, "https://poap.in"))
    ).json<{
      items: Array<Record<string, unknown>>;
      nextCursor: null;
      nextPath: null;
    }>();
    expect(final.items).toEqual([
      {
        dropId: 1003,
        isPrivate: false,
        isHidden: false,
        tokenCount: 0,
        transferCount: 0,
        emailClaims: null,
        featuredOn: null,
        momentsUploaded: 0,
        byChain: [
          {
            chain: "polygon",
            createdOn: 1780272000,
            poapCount: 0,
            transferCount: 0,
          },
        ],
      },
    ]);
    expect(final.nextCursor).toBeNull();
    expect(final.nextPath).toBeNull();

    // Drop 1004 has non-zero statistics but is related to collection 101 only
    // through a pending suggestion, so it cannot enter this public export.
    expect([...first.items, ...final.items].map((item) => item.dropId)).toEqual([1001, 1002, 1003]);

    const hidden = await (
      await SELF.fetch("https://poap.in/api/collections/103/export/drop-stats?limit=48")
    ).json<{ items: Array<Record<string, unknown>> }>();
    expect(hidden.items).toEqual([{ dropId: 1004, isHidden: true }]);

    const collectionTamper = new URL(first.nextPath, "https://poap.in");
    collectionTamper.pathname = "/api/collections/102/export/drop-stats";
    const limitTamper = new URL(first.nextPath, "https://poap.in");
    limitTamper.searchParams.set("limit", "1");
    const segmentTamper = new URL(
      `/api/collections/101/export/suggestions?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
      "https://poap.in",
    );
    const tamperedResponses = await Promise.all([
      SELF.fetch(collectionTamper),
      SELF.fetch(limitTamper),
      SELF.fetch(segmentTamper),
      SELF.fetch("https://poap.in/api/collections/101/export/drop-stats?limit=49"),
    ]);
    expect(tamperedResponses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
  });

  it("rejects slug routes and CPU-amplifying collection parameters", async () => {
    const responses = await Promise.all([
      SELF.fetch("https://poap.in/api/collections/shared-history"),
      SELF.fetch("https://poap.in/api/collections?type=team"),
      SELF.fetch("https://poap.in/api/collections?year=9999"),
      SELF.fetch("https://poap.in/api/collections?q=a"),
      SELF.fetch("https://poap.in/api/collections/101/items?offset=1"),
      SELF.fetch("https://poap.in/api/collections/101?limit=1"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400]);
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("canonicalizes collection filters for Workers Cache", async () => {
    const first = await SELF.fetch(
      "https://poap.in/api/collections?type=artist&year=2024&limit=24",
    );
    expect(first.headers.get("x-archive-cache")).toBe("MISS");
    await first.arrayBuffer();
    const reordered = await SELF.fetch(
      "https://poap.in/api/collections?limit=24&year=2024&type=artist",
    );
    expect(reordered.headers.get("x-archive-cache")).toBe("HIT");
  });

  it("starts a new cache generation when only the Collections release changes", async () => {
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    };
    const requestPath = `/__test__/collections-release-${crypto.randomUUID()}`;
    const canonicalSearch = "limit=24&type=artist&year=2024";
    let loads = 0;
    const load = async () => Response.json({ loads: ++loads });
    const request = (releaseId: string, requestUrl: string) =>
      withSnapshotCache(
        {
          requestUrl,
          canonicalPath: requestPath,
          canonicalSearch,
          snapshotId: "collections-same-snapshot",
          apiVersion: collectionsApiVersion({
            API_CACHE_VERSION: "test-v1",
            COLLECTIONS_RELEASE_ID: releaseId,
          }),
          edgeTtlSeconds: 60,
          executionCtx,
        },
        load,
      );

    const first = await request(
      "collections-release-a",
      `https://poap.in${requestPath}?type=artist&year=2024&limit=24`,
    );
    expect(first.headers.get("x-archive-cache")).toBe("MISS");
    await first.arrayBuffer();
    await Promise.all(pending.splice(0));

    const canonicalHit = await request(
      "collections-release-a",
      `https://poap.in${requestPath}?limit=24&year=2024&type=artist`,
    );
    expect(canonicalHit.headers.get("x-archive-cache")).toBe("HIT");
    await canonicalHit.arrayBuffer();

    const nextRelease = await request(
      "collections-release-b",
      `https://poap.in${requestPath}?limit=24&year=2024&type=artist`,
    );
    expect(nextRelease.headers.get("x-archive-cache")).toBe("MISS");
    expect(nextRelease.headers.get("x-archive-api-version")).toBe(
      "test-v1.collections-v3.collections-release-b",
    );
    expect(loads).toBe(2);
    await nextRelease.arrayBuffer();
    await Promise.all(pending.splice(0));

    expect(() =>
      collectionsApiVersion({ API_CACHE_VERSION: "test-v1", COLLECTIONS_RELEASE_ID: "" }),
    ).toThrowError("release identifier is not configured");
  });

  it("fails closed unless both the Collections snapshot and ready marker match", async () => {
    const db = bindings.COLLECTIONS_DB.withSession("first-primary");
    const browseQuery = parseCollectionsQuery(
      new URL("https://poap.in/api/collections?limit=1"),
      "wrong-collections-snapshot",
    );
    await expect(
      fetchCollections(db, browseQuery, "wrong-collections-snapshot", "https://media.poap.in"),
    ).rejects.toMatchObject({ code: "snapshot_mismatch" });

    const itemsQuery = parseCollectionItemsQuery(
      new URL("https://poap.in/api/collections/101/items?limit=1"),
      "101",
      "wrong-collections-snapshot",
    );
    await expect(
      fetchCollectionItems(
        db,
        itemsQuery,
        "wrong-collections-snapshot",
        "https://media.poap.in",
        bindings.SNAPSHOT_ID,
      ),
    ).rejects.toMatchObject({ code: "snapshot_mismatch" });

    await bindings.COLLECTIONS_DB.prepare(
      "UPDATE collections_meta SET value = '0' WHERE key = 'ready'",
    ).run();
    try {
      await expect(
        fetchCollectionsReadiness(db, "collections-2026-07-22-v1"),
      ).rejects.toMatchObject({ code: "collections_unavailable" });
    } finally {
      await bindings.COLLECTIONS_DB.prepare(
        "UPDATE collections_meta SET value = '1' WHERE key = 'ready'",
      ).run();
    }
  });

  it("uses the recent collection index without a temporary sort", async () => {
    const plan = await bindings.COLLECTIONS_DB.prepare(
      `
      EXPLAIN QUERY PLAN
      SELECT c.collection_id, c.updated_on, logo.object_key, banner.object_key
      FROM collections c
      LEFT JOIN collection_media logo
        ON logo.collection_id = c.collection_id
        AND logo.role = 'logo'
        AND logo.status = 'stored'
        AND logo.eligible_for_publish = 1
      LEFT JOIN collection_media banner
        ON banner.collection_id = c.collection_id
        AND banner.role = 'banner'
        AND banner.status = 'stored'
        AND banner.eligible_for_publish = 1
      WHERE NOT EXISTS (
        SELECT 1
        FROM collection_ui_settings recent_ui
        WHERE recent_ui.collection_id = c.collection_id
          AND recent_ui.is_visible_in_recent_list = 0
      )
      ORDER BY c.updated_on DESC, c.collection_id DESC
      LIMIT 25
    `,
    ).all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join("\n");
    expect(details).toContain("idx_collections_recent");
    expect(details).not.toContain("USE TEMP B-TREE");
  });

  it("uses relation and primary-key indexes for bounded drop statistics", async () => {
    const scopePlan = await bindings.COLLECTIONS_DB.prepare(
      `
      EXPLAIN QUERY PLAN
      WITH scoped_drop_ids(drop_id) AS (
        SELECT item.drop_id
        FROM collection_items item
        WHERE item.collection_id = ?1
        UNION
        SELECT artist_drop.drop_id
        FROM collection_artist_drops artist_drop
        JOIN collection_artists artist ON artist.artist_id = artist_drop.artist_id
        WHERE artist.collection_id = ?1
        UNION
        SELECT suggestion.drop_id
        FROM suggested_drops suggestion
        WHERE suggestion.collection_id = ?1
          AND suggestion.curation_status = 'approved'
      )
      SELECT scoped.drop_id
      FROM scoped_drop_ids scoped
      ORDER BY scoped.drop_id ASC
      LIMIT ?2
    `,
    )
      .bind(101, 49)
      .all<{ detail: string }>();
    const scopeDetails = scopePlan.results.map((row) => row.detail).join("\n");
    expect(scopeDetails).toContain("idx_collection_items_collection");
    expect(scopeDetails).toContain("idx_collection_artists_collection");
    expect(scopeDetails).toMatch(/idx_suggested_drops_(approved|collection)/);

    const chainPlan = await bindings.COLLECTIONS_DB.prepare(
      `
      EXPLAIN QUERY PLAN
      SELECT drop_id, chain, created_on, poap_count, transfer_count
      FROM collection_drop_stats_by_chain
      WHERE drop_id IN (?1, ?2)
      ORDER BY drop_id ASC, chain_key ASC
      LIMIT ?3
    `,
    )
      .bind(1001, 1003, 769)
      .all<{ detail: string }>();
    const chainDetails = chainPlan.results.map((row) => row.detail).join("\n");
    expect(chainDetails).toContain("PRIMARY KEY (drop_id=?)");
    expect(chainDetails).not.toContain("USE TEMP B-TREE");
  });
});

describe("export and media helpers", () => {
  it("neutralizes spreadsheet formulas after RFC 4180 escaping", () => {
    expect(csvCell('=HYPERLINK("https://bad")')).toBe('"\'=HYPERLINK(""https://bad"")"');
  });

  it("normalizes the media base URL", () => {
    expect(artworkUrl("https://media.poap.in///", "2026-07-02-v1", 42)).toBe(
      "https://media.poap.in/snapshots/2026-07-02-v1/artwork/42.webp",
    );
  });

  it("maps only active canonical media keys onto the media origin", () => {
    expect(
      collectionMediaObjectUrl(
        "https://media.poap.in/",
        "snapshots/collections-2026-07-22-v1/collections/media/sha256/ab/abcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.png",
        "collections-2026-07-22-v1",
      ),
    ).toBe(
      "https://media.poap.in/snapshots/collections-2026-07-22-v1/collections/media/sha256/ab/abcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.png",
    );
    expect(
      collectionDropArtworkUrl(
        "https://media.poap.in",
        "snapshots/2026-07-02-v1/artwork/42.webp",
        "2026-07-02-v1",
        "collections-2026-07-22-v1",
        42,
      ),
    ).toBe("https://media.poap.in/snapshots/2026-07-02-v1/artwork/42.webp");
    expect(
      collectionDropArtworkUrl(
        "https://media.poap.in",
        "snapshots/other-release/artwork/42.webp",
        "2026-07-02-v1",
        "collections-2026-07-22-v1",
        42,
      ),
    ).toBeNull();
    expect(
      collectionMediaObjectUrl(
        "https://media.poap.in",
        "private/backup.tar.gz",
        "collections-2026-07-22-v1",
      ),
    ).toBeNull();
  });
});
