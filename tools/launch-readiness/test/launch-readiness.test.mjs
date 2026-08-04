import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { inspectLaunchReadiness } from "../lib.mjs";

test("passes a complete Pilot configuration and fails closed on placeholders", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "pilot-readiness-"));
  const configPath = resolve(root, "wrangler.json");
  const eventPath = resolve(root, "event.json");
  const secretsPath = resolve(root, "secrets.json");
  const artworkPath = resolve(root, "artwork.svg");
  const config = {
    vars: {
      APP_MODE: "live-only",
      PUBLIC_APP_URL: "https://badge.association.test",
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: "Association <badge@association.test>",
    },
    d1_databases: [
      {
        binding: "LIVE_DB",
        database_id: "12345678-1234-1234-1234-123456789abc",
      },
    ],
    r2_buckets: [{ binding: "ARCHIVE_BUCKET", bucket_name: "live-media" }],
    secrets: {
      required: [
        "MINT_SIGNER_PRIVATE_KEY",
        "MINT_RELAYER_PRIVATE_KEY",
        "EMAIL_LOOKUP_SECRET",
        "EMAIL_DATA_KEY",
        "RESEND_API_KEY",
      ],
    },
  };
  const event = {
    eventId: "event-first-pilot",
    slug: "first-pilot",
    title: "Pilot",
    description: "Pilot event",
    imageUrl: "/artwork.svg",
    imageFile: "./artwork.svg",
    eventUrl: null,
    startsAt: "2026-08-15T00:00:00Z",
    claimOpensAt: "2026-08-14T00:00:00Z",
    claimClosesAt: "2026-09-15T00:00:00Z",
    maxSupply: 20,
    claimCount: 20,
    claimMode: "unique",
    chainId: 84532,
    publicBaseUrl: "https://badge.association.test",
  };
  const secrets = {
    MINT_SIGNER_PRIVATE_KEY: `0x${"12".repeat(32)}`,
    MINT_RELAYER_PRIVATE_KEY: `0x${"13".repeat(32)}`,
    EMAIL_LOOKUP_SECRET: "34".repeat(32),
    EMAIL_DATA_KEY: Buffer.alloc(32, 5).toString("base64"),
    RESEND_API_KEY: "re_live_realistic_test_value",
  };
  await Promise.all([
    writeFile(configPath, JSON.stringify(config)),
    writeFile(eventPath, JSON.stringify(event)),
    writeFile(secretsPath, JSON.stringify(secrets)),
    writeFile(
      artworkPath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><circle cx="128" cy="128" r="100"/></svg>',
    ),
  ]);

  const good = await inspectLaunchReadiness({ configPath, eventPath, secretsPath });
  assert.equal(good.ready, true);

  config.vars.WALLET_PROVISIONING_MODE = "magic-pregen";
  config.vars.MAGIC_PUBLISHABLE_API_KEY = "pk_test_launch_readiness";
  config.secrets.required.push("MAGIC_SECRET_KEY");
  secrets.MAGIC_SECRET_KEY = "sk_test_launch_readiness";
  await Promise.all([
    writeFile(configPath, JSON.stringify(config)),
    writeFile(secretsPath, JSON.stringify(secrets)),
  ]);
  const magicReady = await inspectLaunchReadiness({ configPath, eventPath, secretsPath });
  assert.equal(magicReady.ready, true);

  delete secrets.MAGIC_SECRET_KEY;
  await writeFile(secretsPath, JSON.stringify(secrets));
  const magicMissingSecret = await inspectLaunchReadiness({
    configPath,
    eventPath,
    secretsPath,
  });
  assert.equal(magicMissingSecret.ready, false);
  assert.ok(
    magicMissingSecret.checks.some(
      (item) => !item.ok && item.label === "Magic secret key is configured",
    ),
  );

  config.d1_databases[0].database_id = "00000000-0000-0000-0000-000000000005";
  secrets.RESEND_API_KEY = "REPLACE_WITH_RESEND_API_KEY";
  await Promise.all([
    writeFile(configPath, JSON.stringify(config)),
    writeFile(secretsPath, JSON.stringify(secrets)),
  ]);
  const bad = await inspectLaunchReadiness({ configPath, eventPath, secretsPath });
  assert.equal(bad.ready, false);
  assert.ok(bad.checks.some((item) => !item.ok && item.label.includes("database ID")));
  assert.ok(bad.checks.some((item) => !item.ok && item.label.includes("RESEND_API_KEY")));
  await rm(root, { recursive: true, force: true });
});
