import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importArchive } from "../lib/importer.mjs";
import { artworkEntriesSha256 } from "../lib/archive-inventory.mjs";
import { sqlLiteral } from "../lib/sql-shards.mjs";
import { normalizeAddress } from "../lib/util.mjs";
import { verifyImportOutput } from "../lib/verifier.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MIGRATIONS_ROOT = resolve(PROJECT_ROOT, "migrations");

test("normalizes addresses and safely emits SQL literals", () => {
  assert.equal(
    normalizeAddress("0xAbCdEf0000000000000000000000000000000000"),
    "0xabcdef0000000000000000000000000000000000",
  );
  assert.equal(normalizeAddress("0x1234"), null);
  assert.equal(sqlLiteral("Kira's\nPOAP"), "'Kira''s\nPOAP'");
  assert.match(sqlLiteral("a\u0000b"), /^CAST\(X'[0-9a-f]+' AS TEXT\)$/);
});

test("generates deterministic D1 shards, quality report, and R2 manifest", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "poapin-import-test-"));
  try {
    const sourceDatabase = resolve(temporaryRoot, "poap.sqlite");
    const artworkDirectory = resolve(temporaryRoot, "artwork");
    const outputOne = resolve(temporaryRoot, "output-one");
    const outputTwo = resolve(temporaryRoot, "output-two");
    const outputFromInventory = resolve(temporaryRoot, "output-inventory");
    await mkdir(artworkDirectory);
    execFileSync("sqlite3", [sourceDatabase], { input: SOURCE_FIXTURE_SQL });
    const minimalWebp = Buffer.from("524946460400000057454250", "hex");
    await Promise.all([
      writeFile(resolve(artworkDirectory, "1.webp"), minimalWebp),
      writeFile(resolve(artworkDirectory, "2.webp"), minimalWebp),
    ]);

    const commonOptions = {
      databasePath: sourceDatabase,
      artworkDirectory,
      sourceUrl: "https://poap.in",
      retrievedAt: "2026-07-22T00:00:00.000Z",
      maxShardBytes: 2_048,
      maxStatementBytes: 1_024,
      rowsPerStatement: 2,
    };
    const first = await importArchive({ ...commonOptions, outputDirectory: outputOne });
    const second = await importArchive({ ...commonOptions, outputDirectory: outputTwo });

    assert.deepEqual(first.report, second.report);
    assert.equal(first.report.snapshot.id, "2026-07-02-v1");
    assert.deepEqual(first.report.counts.accepted, {
      drops: 2,
      tokens: 3,
      owners: 2,
      emailReservationStats: 1,
      artworks: 2,
    });
    assert.deepEqual(first.report.quality.blockingIssues, []);
    assert.equal(first.report.quality.drops.emptyFancyIds, 1);
    assert.match(first.report.quality.warnings.join("\n"), /empty source fancy_id/);
    assert.equal(first.report.quality.tokens.normalizedAddressesChanged, 2);
    assert.equal(first.report.quality.tokens.duplicatePoapIds, 1);
    assert.equal(first.report.quality.tokens.duplicatePoapExtraRows, 1);

    const manifestLines = (await readFile(resolve(outputOne, "r2/artwork-manifest.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      manifestLines.map((row) => row.object.key),
      ["snapshots/2026-07-02-v1/artwork/1.webp", "snapshots/2026-07-02-v1/artwork/2.webp"],
    );
    assert.ok(manifestLines.every((row) => row.eligibleForPublish));
    assert.ok(manifestLines.every((row) => row.snapshotId === "2026-07-02-v1"));
    assert.ok(
      manifestLines.every((row) => row.object.publicUrl.startsWith("https://media.poap.in/")),
    );

    const holdingSqlFiles = (await readdir(resolve(outputOne, "holdings"))).filter((name) =>
      name.includes("_tokens.sql"),
    );
    const holdingSql = (
      await Promise.all(
        holdingSqlFiles.map((name) => readFile(resolve(outputOne, "holdings", name), "utf8")),
      )
    ).join("\n");
    assert.match(holdingSql, /"owner_address_norm"/);
    assert.doesNotMatch(holdingSql, /"owner_address",/);
    assert.match(holdingSql, /INSERT INTO "import_shards"/);
    assert.ok(
      first.report.artifacts
        .filter((artifact) => artifact.phase === "load")
        .every((artifact) => /^[0-9a-f]{64}$/.test(artifact.payloadSha256)),
    );
    assert.doesNotMatch(
      await readFile(resolve(outputOne, "holdings/999999_finalize.sql"), "utf8"),
      /COUNT\(\*\)/,
    );

    const verification = await verifyImportOutput({
      inputDirectory: outputOne,
      migrationsRoot: MIGRATIONS_ROOT,
    });
    assert.equal(verification.verified, true);
    assert.equal(verification.catalog.drops, 2);
    assert.equal(verification.holdings.tokens, 3);
    assert.match(verification.ownerLookupPlan.join("\n"), /PRIMARY KEY/);
    assert.match(verification.dropCollectorLookupPlan.join("\n"), /idx_tokens_drop_collectors/);

    const inventoryEntries = [
      {
        dropId: 1,
        path: "artwork/1.webp",
        byteLength: 12,
        compressedByteLength: 10,
        compressionMethod: 8,
        crc32: "11111111",
      },
      {
        dropId: 2,
        path: "artwork/2.webp",
        byteLength: 12,
        compressedByteLength: 10,
        compressionMethod: 8,
        crc32: "22222222",
      },
    ];
    const expectedArchiveSha256 = "a".repeat(64);
    const artworkInventoryPath = resolve(temporaryRoot, "artwork-inventory.json");
    const artworkInventory = makeArtworkInventory(inventoryEntries, expectedArchiveSha256);
    await writeFile(artworkInventoryPath, `${JSON.stringify(artworkInventory)}\n`);
    const importedInventory = await importArchive({
      ...commonOptions,
      artworkDirectory: undefined,
      artworkInventoryPath,
      artworkInventoryPolicy: policyForInventory(artworkInventory),
      expectedArchiveSha256,
      outputDirectory: outputFromInventory,
    });
    assert.equal(importedInventory.report.counts.accepted.artworks, 2);
    assert.deepEqual(importedInventory.report.source.archiveIntegrity, {
      status: "expected-only-not-measured",
      expectedSha256: expectedArchiveSha256,
      measuredSha256: null,
      matchesExpected: null,
    });
    assert.match(
      importedInventory.report.quality.warnings.join("\n"),
      /was not measured by the HTTP Range inventory/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function makeArtworkInventory(entries, expectedArchiveSha256) {
  const centralSha256 = "b".repeat(64);
  return {
    formatVersion: 1,
    kind: "poapin-remote-artwork-inventory",
    policyId: "fixture-v1",
    snapshotId: "2026-07-02-v1",
    source: {
      url: "https://example.invalid/archive.zip",
      byteLength: 123456,
      etag: '"fixture"',
      lastModified: "Thu, 02 Jul 2026 15:28:18 GMT",
    },
    verification: {
      acquisition: { method: "http-range", requestCount: 2, byteLength: 2048 },
      centralDirectory: {
        status: "verified",
        zip64: true,
        offset: 100000,
        byteLength: 2048,
        entryCount: 3,
        expectedSha256: centralSha256,
        measuredSha256: centralSha256,
        matchesExpected: true,
      },
      wholeArchiveSha256: {
        status: "not-measured",
        expectedSha256: expectedArchiveSha256,
        measuredSha256: null,
        matchesExpected: null,
        reason: "fixture",
      },
    },
    artwork: {
      count: entries.length,
      entriesSha256: artworkEntriesSha256(entries),
      entries,
    },
    quality: {
      duplicateDropIds: [],
      encryptedEntries: 0,
      symlinkEntries: 0,
      unsafePaths: [],
      unexpectedEntries: 1,
      invalidWebpSignatures: [],
    },
  };
}

function policyForInventory(inventory) {
  return {
    id: inventory.policyId,
    snapshotId: inventory.snapshotId,
    archiveUrl: inventory.source.url,
    byteLength: inventory.source.byteLength,
    expectedArchiveSha256: inventory.verification.wholeArchiveSha256.expectedSha256,
    expectedEtag: inventory.source.etag,
    centralDirectory: {
      zip64: inventory.verification.centralDirectory.zip64,
      offset: inventory.verification.centralDirectory.offset,
      byteLength: inventory.verification.centralDirectory.byteLength,
      entryCount: inventory.verification.centralDirectory.entryCount,
      sha256: inventory.verification.centralDirectory.expectedSha256,
    },
    artworkCount: inventory.artwork.count,
    unexpectedEntryCount: inventory.quality.unexpectedEntries,
    artworkEntriesSha256: inventory.artwork.entriesSha256,
  };
}

const SOURCE_FIXTURE_SQL = `
CREATE TABLE drops (
  drop_id INTEGER PRIMARY KEY,
  fancy_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  city TEXT,
  country TEXT,
  event_url TEXT,
  year INTEGER NOT NULL,
  is_virtual INTEGER,
  is_private INTEGER NOT NULL,
  channel TEXT,
  platform TEXT,
  location_type TEXT,
  timezone TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE tokens (
  source_uid TEXT PRIMARY KEY,
  poap_id INTEGER NOT NULL,
  drop_id INTEGER,
  minted_on INTEGER,
  owner_address TEXT NOT NULL,
  network TEXT NOT NULL,
  transfer_count INTEGER NOT NULL
);
CREATE TABLE email_reservation_stats (
  drop_id INTEGER PRIMARY KEY,
  email_reservations_total INTEGER NOT NULL,
  email_reservations_minted INTEGER NOT NULL,
  email_reservations_unminted INTEGER NOT NULL
);
CREATE TABLE snapshot_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

INSERT INTO drops VALUES
  (1, '', 'First', 'Kira''s first POAP', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 'Tokyo', 'Japan', 'https://poap.in', 2026, 0, 0, NULL, NULL, NULL, 'Asia/Tokyo', '2026-07-01T00:00:00.000Z'),
  (2, 'second', 'Second', 'Line one\nLine two', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z', NULL, NULL, NULL, 2025, 1, 0, 'community', 'online', 'virtual', 'UTC', '2025-01-01T00:00:00.000Z');
INSERT INTO tokens VALUES
  ('00000000000000000000000000000001', 100, 1, 1751328000, '0xAbCdEf0000000000000000000000000000000000', 'xdai', 1),
  ('00000000000000000000000000000002', 100, 2, 1735689600, '0xABCDEF0000000000000000000000000000000000', 'xdai', 0),
  ('00000000000000000000000000000003', 101, 2, 1735689700, '0x1111111111111111111111111111111111111111', 'mainnet', 2);
INSERT INTO email_reservation_stats VALUES (1, 3, 2, 1);
INSERT INTO snapshot_metadata VALUES
  ('schema_version', '1'),
  ('snapshot_at', '2026-07-02T14:28:17.259Z'),
  ('generated_at', '2026-07-02T14:49:32.049Z'),
  ('drops_count', '2'),
  ('tokens_count', '3'),
  ('email_reservation_stats_count', '1');
`;
