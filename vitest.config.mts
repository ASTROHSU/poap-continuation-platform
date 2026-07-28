import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { readFile } from "node:fs/promises";

const catalogMigrations = await readD1Migrations("migrations/catalog");
const holdingsMigrations = await readD1Migrations("migrations/holdings");
const collectionsMigrations = await readD1Migrations("migrations/collections");
const momentsMigrations = await readD1Migrations("migrations/moments");
const catalogFixture = await readFile("fixtures/catalog.sql", "utf8");
const holdingsFixture = await readFile("fixtures/holdings.sql", "utf8");
const collectionsFixture = await readFile("fixtures/collections.sql", "utf8");
const momentsFixture = await readFile("fixtures/moments.sql", "utf8");

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.spec.ts"],
    exclude: ["test/browser/**"],
    poolOptions: {
      workers: {
        miniflare: {
          bindings: {
            TEST_CATALOG_FIXTURE: catalogFixture,
            TEST_CATALOG_MIGRATIONS: catalogMigrations,
            TEST_HOLDINGS_FIXTURE: holdingsFixture,
            TEST_HOLDINGS_MIGRATIONS: holdingsMigrations,
            TEST_COLLECTIONS_FIXTURE: collectionsFixture,
            TEST_COLLECTIONS_MIGRATIONS: collectionsMigrations,
            TEST_MOMENTS_FIXTURE: momentsFixture,
            TEST_MOMENTS_MIGRATIONS: momentsMigrations,
            HOLDINGS_SNAPSHOT_ID: "2026-07-02-v1",
            MOMENTS_SNAPSHOT_ID: "moments-2026-07-23-v1",
            MOMENTS_RELEASE_ID: "moments-test-release",
            MOMENTS_SOURCE_DATABASE_SHA256: "a".repeat(64),
            MOMENTS_BUILD_MANIFEST_SHA256: "b".repeat(64),
            ETHEREUM_RPC_URL: "https://ethereum-rpc.publicnode.com",
          },
        },
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
