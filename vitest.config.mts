import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { readFile } from "node:fs/promises";

const catalogMigrations = await readD1Migrations("migrations/catalog");
const holdingsMigrations = await readD1Migrations("migrations/holdings");
const collectionsMigrations = await readD1Migrations("migrations/collections");
const momentsMigrations = await readD1Migrations("migrations/moments");
const liveMigrations = await readD1Migrations("migrations/live");
const catalogFixture = await readFile("fixtures/catalog.sql", "utf8");
const holdingsFixture = await readFile("fixtures/holdings.sql", "utf8");
const collectionsFixture = await readFile("fixtures/collections.sql", "utf8");
const momentsFixture = await readFile("fixtures/moments.sql", "utf8");
const liveFixture = await readFile("fixtures/live.sql", "utf8");

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.spec.ts"],
    exclude: ["test/browser/**", "test/browser-astro/**"],
    poolOptions: {
      workers: {
        miniflare: {
          bindings: {
            APP_MODE: "live-only",
            TEST_CATALOG_FIXTURE: catalogFixture,
            TEST_CATALOG_MIGRATIONS: catalogMigrations,
            TEST_HOLDINGS_FIXTURE: holdingsFixture,
            TEST_HOLDINGS_MIGRATIONS: holdingsMigrations,
            TEST_COLLECTIONS_FIXTURE: collectionsFixture,
            TEST_COLLECTIONS_MIGRATIONS: collectionsMigrations,
            TEST_MOMENTS_FIXTURE: momentsFixture,
            TEST_MOMENTS_MIGRATIONS: momentsMigrations,
            TEST_LIVE_FIXTURE: liveFixture,
            TEST_LIVE_MIGRATIONS: liveMigrations,
            HOLDINGS_SNAPSHOT_ID: "2026-07-02-v1",
            MOMENTS_SNAPSHOT_ID: "moments-2026-07-23-v1",
            MOMENTS_RELEASE_ID: "moments-test-release",
            MOMENTS_SOURCE_DATABASE_SHA256: "a".repeat(64),
            MOMENTS_BUILD_MANIFEST_SHA256: "b".repeat(64),
            ETHEREUM_RPC_URL: "https://ethereum-rpc.publicnode.com",
            BASE_RPC_URL: "https://sepolia.base.org",
            BASE_MAINNET_RPC_URL: "https://mainnet.base.org",
            MINT_SIGNER_PRIVATE_KEY:
              "0x0000000000000000000000000000000000000000000000000000000000000001",
            MINT_RELAYER_PRIVATE_KEY:
              "0x0000000000000000000000000000000000000000000000000000000000000002",
            PUBLIC_APP_URL: "https://example.test",
            EMAIL_PROVIDER: "console",
            EMAIL_FROM: "兆量富足教育協會 <badge@example.test>",
            WALLET_PROVISIONING_MODE: "disabled",
            MAGIC_PUBLISHABLE_API_KEY: "",
            MAGIC_SECRET_KEY: "",
            RESEND_API_KEY: "",
            EMAIL_LOOKUP_SECRET: "test-only-email-lookup-secret-32-bytes-minimum",
            EMAIL_DATA_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          },
        },
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
