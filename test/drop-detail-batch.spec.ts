import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { DropDetailBatch } from "../src/worker/types";

interface TestBindings {
  CATALOG_DB: D1Database;
  TEST_CATALOG_FIXTURE: string;
  TEST_CATALOG_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestBindings;

beforeAll(async () => {
  await applyD1Migrations(bindings.CATALOG_DB, bindings.TEST_CATALOG_MIGRATIONS);
  await executeSql(bindings.CATALOG_DB, bindings.TEST_CATALOG_FIXTURE);
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
        90,
        'private-batch-secret',
        'Private batch secret',
        'This text must never leave D1.',
        '2025-01-01T00:00:00.000Z',
        '2025-01-01T01:00:00.000Z',
        'Secret City',
        'Secret Country',
        'https://private.example.invalid/secret',
        2025,
        1,
        1,
        'secret-channel',
        'secret-platform',
        'virtual',
        'UTC',
        '2025-01-01T00:00:00.000Z',
        1,
        1
      )
    `,
  ).run();
});

describe("Drop detail batch export", () => {
  it("returns complete public details while collapsing private and missing IDs", async () => {
    const response = await SELF.fetch("https://poap.in/api/drops/export/batch?ids=999,90,1");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-archive-api-version")).toBe("v1.drop-detail-batch-v1");

    const body = await response.json<DropDetailBatch>();
    expect(body).toEqual({
      schemaVersion: "poapin-drop-detail-batch-v1",
      snapshotId: "2026-07-02-v1",
      requestedDropIds: [1, 90, 999],
      drops: [
        {
          dropId: 1,
          fancyId: "dappcon-18",
          title: "DappCon",
          description: "A global conference for Ethereum application developers.",
          startDate: "2018-07-19T00:00:00.000Z",
          endDate: "2018-07-20T00:00:00.000Z",
          city: "Berlin",
          country: "Germany",
          year: 2018,
          isVirtual: false,
          imageUrl: "https://media.example.invalid/snapshots/2026-07-02-v1/artwork/1.webp",
          hasArtwork: true,
          tokenCount: 1,
          eventUrl: "https://www.dappcon.io/",
          channel: null,
          platform: null,
          locationType: "in-person",
          timezone: "Europe/Berlin",
          createdAt: "2019-05-28T06:40:54.242Z",
          reservationsTotal: 0,
          reservationsMinted: 0,
          reservationsUnminted: 0,
        },
      ],
      unavailableDropIds: [90, 999],
    });
    expect(JSON.stringify(body)).not.toContain("Private batch secret");
    expect(JSON.stringify(body)).not.toContain("private.example.invalid");
    expect(JSON.stringify(body)).not.toContain("/artwork/90.webp");
  });

  it("canonicalizes order and duplicate IDs into one snapshot cache key", async () => {
    const first = await SELF.fetch("https://poap.in/api/drops/export/batch?ids=3,1,1,2");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-archive-cache")).toBe("MISS");
    const firstBody = await first.json<DropDetailBatch>();
    expect(firstBody.requestedDropIds).toEqual([1, 2, 3]);

    const canonicalHit = await SELF.fetch("https://poap.in/api/drops/export/batch?ids=2,3,1");
    expect(canonicalHit.headers.get("x-archive-cache")).toBe("HIT");
    expect(await canonicalHit.json<DropDetailBatch>()).toEqual(firstBody);
  });

  it("accepts exactly 96 IDs and rejects every unbounded or ambiguous shape", async () => {
    const maximum = Array.from({ length: 96 }, (_, index) => index + 1).join(",");
    const maximumResponse = await SELF.fetch(
      `https://poap.in/api/drops/export/batch?ids=${maximum}`,
    );
    expect(maximumResponse.status).toBe(200);
    const maximumBody = await maximumResponse.json<DropDetailBatch>();
    expect(maximumBody.requestedDropIds).toHaveLength(96);
    expect(maximumBody.drops.map((drop) => drop.dropId)).toEqual([1, 2, 3]);
    expect(maximumBody.unavailableDropIds).toContain(90);

    const overMaximum = Array.from({ length: 97 }, (_, index) => index + 1).join(",");
    const invalidResponses = await Promise.all([
      SELF.fetch("https://poap.in/api/drops/export/batch"),
      SELF.fetch("https://poap.in/api/drops/export/batch?ids="),
      SELF.fetch("https://poap.in/api/drops/export/batch?ids=0"),
      SELF.fetch("https://poap.in/api/drops/export/batch?ids=01"),
      SELF.fetch("https://poap.in/api/drops/export/batch?ids=1,"),
      SELF.fetch("https://poap.in/api/drops/export/batch?ids=1&ids=2"),
      SELF.fetch("https://poap.in/api/drops/export/batch?ids=1&offset=1"),
      SELF.fetch(`https://poap.in/api/drops/export/batch?ids=${overMaximum}`),
    ]);
    expect(invalidResponses.map((response) => response.status)).toEqual(
      Array(invalidResponses.length).fill(400),
    );
    for (const response of invalidResponses) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});

async function executeSql(db: D1Database, sql: string): Promise<void> {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
}
