import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/worker/index";
import type { Bindings, PersonalHoldingsPage } from "../src/worker/types";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const COLLECTION_OWNER = "0x2222222222222222222222222222222222222222";
const PRIVATE_HOLDER = "0x4444444444444444444444444444444444444444";

interface TestBindings extends Bindings {
  TEST_CATALOG_FIXTURE: string;
  TEST_CATALOG_MIGRATIONS: D1Migration[];
  TEST_HOLDINGS_FIXTURE: string;
  TEST_HOLDINGS_MIGRATIONS: D1Migration[];
  TEST_COLLECTIONS_FIXTURE: string;
  TEST_COLLECTIONS_MIGRATIONS: D1Migration[];
  TEST_MOMENTS_FIXTURE: string;
  TEST_MOMENTS_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestBindings;

beforeAll(async () => {
  await applyD1Migrations(bindings.CATALOG_DB, bindings.TEST_CATALOG_MIGRATIONS);
  await applyD1Migrations(bindings.HOLDINGS_DB, bindings.TEST_HOLDINGS_MIGRATIONS);
  await applyD1Migrations(bindings.COLLECTIONS_DB, bindings.TEST_COLLECTIONS_MIGRATIONS);
  await applyD1Migrations(bindings.MOMENTS_DB, bindings.TEST_MOMENTS_MIGRATIONS);
  await executeSql(bindings.CATALOG_DB, bindings.TEST_CATALOG_FIXTURE);
  await executeSql(bindings.HOLDINGS_DB, bindings.TEST_HOLDINGS_FIXTURE);
  await executeSql(bindings.COLLECTIONS_DB, bindings.TEST_COLLECTIONS_FIXTURE);
  await executeSql(bindings.MOMENTS_DB, bindings.TEST_MOMENTS_FIXTURE);
  await seedExportBoundaryRows();
});

describe("personal export manifest", () => {
  it("reports exact counts and versioned segment contracts from every ready snapshot", async () => {
    const response = await SELF.fetch(
      `https://poap.in/api/owners/0x${ADDRESS.slice(2).toUpperCase()}/export/manifest`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-archive-api-version")).toContain("personal-export-v3");
    expect(response.headers.get("cache-control")).toContain("max-age=0");
    await expect(response.json()).resolves.toEqual({
      schemaVersion: "poapin-personal-export-v1",
      address: ADDRESS,
      snapshots: {
        catalog: "2026-07-02-v1",
        holdings: "2026-07-02-v1",
        collections: "collections-2026-07-22-v1",
        moments: "moments-2026-07-23-v1",
      },
      sources: {
        catalog: {
          snapshotId: "2026-07-02-v1",
        },
        holdings: {
          snapshotId: "2026-07-02-v1",
        },
        collections: {
          snapshotId: "collections-2026-07-22-v1",
          releaseId: bindings.COLLECTIONS_RELEASE_ID,
        },
        moments: {
          snapshotId: "moments-2026-07-23-v1",
          releaseId: bindings.MOMENTS_RELEASE_ID,
          sourceDatabaseSha256: bindings.MOMENTS_SOURCE_DATABASE_SHA256,
          buildManifestSha256: bindings.MOMENTS_BUILD_MANIFEST_SHA256,
        },
      },
      counts: {
        holdings: 2,
        authoredMoments: 2,
        taggedMoments: 0,
        ownedCollections: 0,
        ownedCapsules: 1,
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
    });

    const canonicalHit = await SELF.fetch(`https://poap.in/api/owners/${ADDRESS}/export/manifest`);
    expect(canonicalHit.headers.get("x-archive-cache")).toBe("HIT");
    await canonicalHit.arrayBuffer();
  });

  it("fails the complete manifest closed when any source release is not ready", async () => {
    const address = "0x5555555555555555555555555555555555555555";
    const response = await app.request(
      `https://poap.in/api/owners/${address}/export/manifest`,
      undefined,
      { ...bindings, MOMENTS_SNAPSHOT_ID: "wrong-moments-snapshot" },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "archive_unavailable",
    });
  });
});

describe("paginated personal holdings", () => {
  it("returns complete public Drop details with a snapshot and filter-bound keyset", async () => {
    const first = await SELF.fetch(`https://poap.in/api/owners/${ADDRESS}/export/holdings?limit=1`);
    expect(first.status).toBe(200);
    const firstPage = await first.json<PersonalHoldingsPage>();
    expect(firstPage).toMatchObject({
      schemaVersion: "poapin-personal-holdings-page-v2",
      snapshotId: "2026-07-02-v1",
      collectionsSnapshotId: "collections-2026-07-22-v1",
      collectionsReleaseId: bindings.COLLECTIONS_RELEASE_ID,
      address: ADDRESS,
      total: 2,
    });
    expect(firstPage.items[0]).toMatchObject({
      poapId: 2,
      dropId: 2,
      ownerAddress: ADDRESS,
      network: "xdai",
    });
    expect(firstPage.drops[0]).toMatchObject({
      dropId: 2,
      title: "#DeFi Summit",
      description: "A conference about decentralized finance.",
      endDate: "2018-10-29T00:00:00.000Z",
      eventUrl: "https://offdevcon.com/event/defi-summit-prague/",
      reservationsTotal: 2,
      reservationsMinted: 1,
      reservationsUnminted: 1,
    });
    expect(firstPage.unavailableDropIds).toEqual([]);
    expectStrictDropPartition(firstPage);

    const secondParams = new URLSearchParams({
      limit: "1",
      cursor: firstPage.nextCursor,
    });
    const second = await SELF.fetch(
      `https://poap.in/api/owners/${ADDRESS}/export/holdings?${secondParams}`,
    );
    const secondPage = await second.json<PersonalHoldingsPage>();
    expect(secondPage.items).toEqual([expect.objectContaining({ poapId: 1, dropId: 1 })]);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.unavailableDropIds).toEqual([]);
    expectStrictDropPartition(secondPage);

    const wrongLimit = new URLSearchParams({
      limit: "2",
      cursor: firstPage.nextCursor,
    });
    const wrongAddress = new URLSearchParams({
      limit: "1",
      cursor: firstPage.nextCursor,
    });
    const rejected = await Promise.all([
      SELF.fetch(`https://poap.in/api/owners/${ADDRESS}/export/holdings?${wrongLimit}`),
      SELF.fetch(
        `https://poap.in/api/owners/0x3333333333333333333333333333333333333333/export/holdings?${wrongAddress}`,
      ),
    ]);
    expect(rejected.map((response) => response.status)).toEqual([400, 400]);
  });

  it("returns a held private Drop from Collections while missing records stay unavailable", async () => {
    const response = await SELF.fetch(
      `https://poap.in/api/owners/${PRIVATE_HOLDER}/export/holdings?limit=5`,
    );
    expect(response.status).toBe(200);
    const page = await response.json<PersonalHoldingsPage>();
    expect(page.total).toBe(5);
    expect(page.items.map(({ dropId, poapId }) => ({ dropId, poapId }))).toEqual([
      { dropId: 1, poapId: 103 },
      { dropId: 1, poapId: 102 },
      { dropId: 404, poapId: 101 },
      { dropId: 99, poapId: 100 },
      { dropId: 99, poapId: 99 },
    ]);
    expect(page.drops).toEqual([
      expect.objectContaining({ dropId: 1, title: "DappCon" }),
      expect.objectContaining({
        dropId: 99,
        title: "Private address-bound fixture",
        description: "Private metadata preserved in the Collections snapshot.",
        eventUrl: "https://private-holder.example.invalid/event",
        isPrivate: true,
        isHidden: true,
      }),
    ]);
    expect(page.unavailableDropIds).toEqual([404]);
    expectStrictDropPartition(page);
    expect(JSON.stringify(page)).not.toContain("private catalog secret");
    expect(JSON.stringify(page)).not.toContain("private.example.invalid");
    expect(JSON.stringify(page)).not.toContain("/artwork/99.webp");
    expect(JSON.stringify(page)).not.toContain("unavailableReason");

    const first = await SELF.fetch(
      `https://poap.in/api/owners/${PRIVATE_HOLDER}/export/holdings?limit=1`,
    );
    const firstPage = await first.json<PersonalHoldingsPage>();
    const second = await fetchNextHoldingsPage(firstPage, PRIVATE_HOLDER);
    const third = await fetchNextHoldingsPage(second, PRIVATE_HOLDER);
    const fourth = await fetchNextHoldingsPage(third, PRIVATE_HOLDER);
    const fifth = await fetchNextHoldingsPage(fourth, PRIVATE_HOLDER);
    expect(firstPage.items).toEqual([expect.objectContaining({ dropId: 1, poapId: 103 })]);
    expect(second.items).toEqual([expect.objectContaining({ dropId: 1, poapId: 102 })]);
    expect(firstPage.drops).toEqual([expect.objectContaining({ dropId: 1 })]);
    expect(second.drops).toEqual(firstPage.drops);
    expect(firstPage.unavailableDropIds).toEqual([]);
    expect(second.unavailableDropIds).toEqual([]);
    expect(third.items).toEqual([expect.objectContaining({ dropId: 404, poapId: 101 })]);
    expect(third.unavailableDropIds).toEqual([404]);
    expect(fourth.items).toEqual([expect.objectContaining({ dropId: 99, poapId: 100 })]);
    expect(fifth.items).toEqual([expect.objectContaining({ dropId: 99, poapId: 99 })]);
    expect(fourth.drops).toEqual([
      expect.objectContaining({ dropId: 99, isPrivate: true, isHidden: true }),
    ]);
    expect(fifth.drops).toEqual(fourth.drops);
    expect(fourth.unavailableDropIds).toEqual([]);
    expect(fifth.unavailableDropIds).toEqual([]);
    expect(fifth.nextCursor).toBeNull();
    for (const exportedPage of [firstPage, second, third, fourth, fifth]) {
      expectStrictDropPartition(exportedPage);
    }
  });

  it("opens a private Drop by exact ID without adding it to batch enumeration", async () => {
    const [detail, batch, owner] = await Promise.all([
      SELF.fetch("https://poap.in/api/drops/99"),
      SELF.fetch("https://poap.in/api/drops/export/batch?ids=99"),
      SELF.fetch(`https://poap.in/api/owners/${PRIVATE_HOLDER}?limit=5`),
    ]);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      dropId: 99,
      title: "Private address-bound fixture",
      description: "Private metadata preserved in the Collections snapshot.",
      eventUrl: "https://private-holder.example.invalid/event",
      isPrivate: true,
      isHidden: true,
    });
    await expect(batch.json()).resolves.toMatchObject({
      drops: [],
      unavailableDropIds: [99],
    });
    await expect(owner.json()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          dropId: 99,
          title: "Private address-bound fixture",
          isPrivate: true,
          isHidden: true,
        }),
      ]),
    });
  });

  it("includes holder-bound private and hidden metadata in capped JSON and CSV exports", async () => {
    const [jsonResponse, csvResponse] = await Promise.all([
      SELF.fetch(`https://poap.in/api/owners/${PRIVATE_HOLDER}/export.json`),
      SELF.fetch(`https://poap.in/api/owners/${PRIVATE_HOLDER}/export.csv`),
    ]);
    const json = await jsonResponse.json<{
      schema_version: string;
      tokens: Array<{
        drop_id: number;
        title: string;
        is_private: boolean;
        is_hidden: boolean;
      }>;
    }>();
    const csv = await csvResponse.text();

    expect(json.schema_version).toBe("poapin-address-export-v3");
    expect(json.tokens).toContainEqual(
      expect.objectContaining({
        drop_id: 99,
        title: "Private address-bound fixture",
        is_private: true,
        is_hidden: true,
      }),
    );
    expect(JSON.stringify(json)).not.toContain("private catalog secret");
    expect(csv.split("\n")[0]).toContain(",is_private,is_hidden");
    expect(csv).toContain('"Private address-bound fixture"');
    expect(csv).toContain('"true"');
    expect(csv).not.toContain("private catalog secret");
  });

  it("fails address-bound Drop enrichment closed on a Collections snapshot mismatch", async () => {
    const response = await app.request(
      `https://poap.in/api/owners/${PRIVATE_HOLDER}/export/holdings?limit=5`,
      undefined,
      { ...bindings, COLLECTIONS_SNAPSHOT_ID: "wrong-collections-snapshot" },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({ code: "archive_unavailable" });
  });
});

describe("Collection export resolvers", () => {
  it("resolves only formal collection_items memberships and deduplicates relations", async () => {
    const response = await SELF.fetch(
      "https://poap.in/api/collections/resolve?drop_ids=1003,1002,1002",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-archive-cache")).toBe("MISS");
    const body = await response.json<{
      schemaVersion: string;
      snapshotId: string;
      releaseId: string;
      requestedDropIds: number[];
      memberships: Array<{
        collection: { collectionId: number; title: string };
        matchedDropIds: number[];
      }>;
    }>();
    expect(body.schemaVersion).toBe("poapin-collection-memberships-v1");
    expect(body.snapshotId).toBe("collections-2026-07-22-v1");
    expect(body.releaseId).toBe(bindings.COLLECTIONS_RELEASE_ID);
    expect(body.requestedDropIds).toEqual([1002, 1003]);
    expect(body.memberships).toEqual([
      expect.objectContaining({
        collection: expect.objectContaining({ collectionId: 101 }),
        matchedDropIds: [1002],
      }),
      expect.objectContaining({
        collection: expect.objectContaining({ collectionId: 102 }),
        matchedDropIds: [1002],
      }),
    ]);
    expect(body.memberships.some((entry) => entry.matchedDropIds.includes(1003))).toBe(false);

    const canonicalHit = await SELF.fetch(
      "https://poap.in/api/collections/resolve?drop_ids=1002,1003",
    );
    expect(canonicalHit.headers.get("x-archive-cache")).toBe("HIT");
    await canonicalHit.arrayBuffer();
  });

  it("paginates exact owned Collections through the owner lookup index", async () => {
    const first = await SELF.fetch(
      `https://poap.in/api/collections/owners/${COLLECTION_OWNER}/export?limit=1`,
    );
    expect(first.status).toBe(200);
    const page = await first.json<{
      schemaVersion: string;
      releaseId: string;
      address: string;
      items: Array<{ collectionId: number }>;
      nextCursor: string;
    }>();
    expect(page).toMatchObject({
      schemaVersion: "poapin-owned-collections-page-v1",
      releaseId: bindings.COLLECTIONS_RELEASE_ID,
      address: COLLECTION_OWNER,
      items: [{ collectionId: 103 }],
    });

    const params = new URLSearchParams({ limit: "1", cursor: page.nextCursor });
    const second = await SELF.fetch(
      `https://poap.in/api/collections/owners/${COLLECTION_OWNER}/export?${params}`,
    );
    await expect(second.json()).resolves.toMatchObject({
      items: [{ collectionId: 105 }],
      nextCursor: null,
    });

    const plan = await bindings.COLLECTIONS_DB.prepare(
      `
        EXPLAIN QUERY PLAN
        SELECT collection_id, updated_on
        FROM collections INDEXED BY idx_collections_owner_recent
        WHERE owner_address_norm = ?1
        ORDER BY updated_on DESC, collection_id DESC
        LIMIT ?2
      `,
    )
      .bind(COLLECTION_OWNER, 49)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join("\n");
    expect(details).toContain("idx_collections_owner_recent");
    expect(details).not.toContain("USE TEMP B-TREE");
  });

  it("loads up to 16 complete, sanitized profiles in a bounded batch", async () => {
    const response = await SELF.fetch(
      "https://poap.in/api/collections/export/batch?ids=102,101,101",
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      schemaVersion: string;
      snapshotId: string;
      releaseId: string;
      profiles: Array<{
        collection: { collectionId: number };
        urls: Array<{ url: string | null }>;
        media: unknown[];
        sections: unknown[];
      }>;
    }>();
    expect(body.schemaVersion).toBe("poapin-collection-profiles-v1");
    expect(body.snapshotId).toBe("collections-2026-07-22-v1");
    expect(body.releaseId).toBe(bindings.COLLECTIONS_RELEASE_ID);
    expect(body.profiles.map((profile) => profile.collection.collectionId)).toEqual([101, 102]);
    expect(body.profiles[0]).toMatchObject({
      urls: [
        { urlId: 5001, url: "https://artist.example.invalid/profile" },
        { urlId: 5002, url: "https://social.example.invalid/synthetic-artist" },
      ],
    });
    expect(body.profiles[1]?.urls).toEqual([{ urlId: 5003, url: null }]);
    expect(JSON.stringify(body)).not.toContain("createdBy");
    expect(JSON.stringify(body)).not.toContain("javascript:");
  });

  it("strictly rejects malformed, oversized, duplicated, or unknown parameters", async () => {
    const tooManyDrops = Array.from({ length: 97 }, (_, index) => index + 1).join(",");
    const tooManyCollections = Array.from({ length: 17 }, (_, index) => index + 1).join(",");
    const responses = await Promise.all([
      SELF.fetch("https://poap.in/api/collections/resolve?drop_ids=1,,2"),
      SELF.fetch(`https://poap.in/api/collections/resolve?drop_ids=${tooManyDrops}`),
      SELF.fetch(`https://poap.in/api/collections/export/batch?ids=${tooManyCollections}`),
      SELF.fetch("https://poap.in/api/collections/export/batch?ids=1&ids=2"),
      SELF.fetch("https://poap.in/api/collections/resolve?drop_ids=1&extra=2"),
      SELF.fetch(`https://poap.in/api/owners/${ADDRESS}/export/holdings?limit=481`),
    ]);
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400]);
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});

async function fetchNextHoldingsPage(
  page: PersonalHoldingsPage,
  address: string,
): Promise<PersonalHoldingsPage> {
  expect(page.nextCursor).not.toBeNull();
  const params = new URLSearchParams({
    limit: "1",
    cursor: page.nextCursor ?? "",
  });
  const response = await SELF.fetch(
    `https://poap.in/api/owners/${address}/export/holdings?${params}`,
  );
  expect(response.status).toBe(200);
  return response.json<PersonalHoldingsPage>();
}

function expectStrictDropPartition(
  page: Pick<PersonalHoldingsPage, "items" | "drops" | "unavailableDropIds">,
): void {
  const referenced = [...new Set(page.items.map((item) => item.dropId))].sort(
    (left, right) => left - right,
  );
  const available = page.drops.map((drop) => drop.dropId);
  const unavailable = page.unavailableDropIds;
  expect(new Set(available).size).toBe(available.length);
  expect(new Set(unavailable).size).toBe(unavailable.length);
  expect(available.filter((dropId) => unavailable.includes(dropId))).toEqual([]);
  expect([...available, ...unavailable].sort((left, right) => left - right)).toEqual(referenced);
}

async function seedExportBoundaryRows(): Promise<void> {
  await bindings.CATALOG_DB.prepare(
    `
      INSERT INTO drops (
        drop_id,
        fancy_id,
        title,
        description,
        start_date,
        end_date,
        city,
        country,
        event_url,
        year,
        is_virtual,
        is_private,
        channel,
        platform,
        location_type,
        timezone,
        created_at,
        token_count,
        has_artwork
      ) VALUES (
        99,
        'private-fixture',
        'private catalog secret',
        'private catalog secret description',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        'Private City',
        'Private Country',
        'https://private.example.invalid/secret',
        2026,
        0,
        1,
        'private-channel',
        'private-platform',
        'in-person',
        'UTC',
        '2026-01-01T00:00:00.000Z',
        1,
        1
      )
    `,
  ).run();
  await bindings.COLLECTIONS_DB.prepare(
    `
      INSERT INTO collection_drop_cards (
        drop_id,
        fancy_id,
        title,
        description,
        start_date,
        end_date,
        expiry_date,
        year,
        city,
        country,
        event_url,
        image_url,
        animation_url,
        image_object_key,
        is_virtual,
        private_value,
        is_hidden,
        channel,
        platform,
        location_type,
        timezone,
        integrator_id,
        created_date,
        token_count,
        transfer_count,
        email_claims_minted,
        email_claims_reserved,
        email_claims_total,
        featured_on,
        moments_uploaded
      ) VALUES (
        99,
        'private-address-bound-fixture',
        'Private address-bound fixture',
        'Private metadata preserved in the Collections snapshot.',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        NULL,
        2026,
        'Holder City',
        'Holder Country',
        'https://private-holder.example.invalid/event',
        'https://untrusted-private-source.example.invalid/99.png',
        NULL,
        NULL,
        0,
        'true',
        1,
        'holder-channel',
        'holder-platform',
        'in-person',
        'UTC',
        'fixture',
        '2026-01-01T00:00:00.000Z',
        2,
        3,
        8,
        1,
        9,
        NULL,
        0
      )
    `,
  ).run();
  await bindings.CATALOG_DB.prepare(
    `
      INSERT INTO drop_stats (
        drop_id,
        email_reservations_total,
        email_reservations_minted,
        email_reservations_unminted
      ) VALUES (99, 9, 8, 1)
    `,
  ).run();
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
      ) VALUES (
        '00000000000000000000000000000099',
        99,
        99,
        1767225600,
        ?1,
        'mainnet',
        0
      )
    `,
  )
    .bind(PRIVATE_HOLDER)
    .run();
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
      ) VALUES (
        '00000000000000000000000000000102',
        102,
        1,
        1767225603,
        ?1,
        'mainnet',
        0
      )
    `,
  )
    .bind(PRIVATE_HOLDER)
    .run();
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
      ) VALUES (
        '00000000000000000000000000000103',
        103,
        1,
        1767225604,
        ?1,
        'mainnet',
        0
      )
    `,
  )
    .bind(PRIVATE_HOLDER)
    .run();
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
      ) VALUES (
        '00000000000000000000000000000101',
        101,
        404,
        1767225602,
        ?1,
        'mainnet',
        0
      )
    `,
  )
    .bind(PRIVATE_HOLDER)
    .run();
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
      ) VALUES (
        '00000000000000000000000000000100',
        100,
        99,
        1767225601,
        ?1,
        'mainnet',
        0
      )
    `,
  )
    .bind(PRIVATE_HOLDER)
    .run();
  await bindings.HOLDINGS_DB.prepare(
    `
      INSERT INTO owner_stats (
        owner_address_norm,
        token_count,
        unique_drop_count,
        first_minted_on,
        last_minted_on
      ) VALUES (?1, 5, 3, 1767225600, 1767225604)
    `,
  )
    .bind(PRIVATE_HOLDER)
    .run();
  await bindings.COLLECTIONS_DB.prepare(
    `
      INSERT INTO collections (
        collection_id,
        slug,
        title,
        description,
        type,
        type_rank,
        year,
        created_by,
        owner_address,
        owner_address_norm,
        external_url,
        logo_image_url,
        banner_image_url,
        created_on,
        updated_on,
        item_count,
        section_count
      ) VALUES (
        105,
        'second-wallet-memory',
        'A Second Synthetic User Collection',
        NULL,
        'user',
        5,
        2026,
        'fixture-importer',
        ?1,
        ?1,
        NULL,
        NULL,
        NULL,
        '2026-01-17T06:00:00.000Z',
        '2026-07-18T10:45:00.000Z',
        0,
        0
      )
    `,
  )
    .bind(COLLECTION_OWNER)
    .run();
}

async function executeSql(db: D1Database, sql: string): Promise<void> {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
}
