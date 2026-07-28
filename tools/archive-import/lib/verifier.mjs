import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { queryJsonRows, querySmallJsonDocument } from "./sqlite.mjs";
import { invariant, sha256File, writeWithBackpressure } from "./util.mjs";

const SQLITE_BINARY = process.env.POAP_SQLITE3 || "sqlite3";

export async function verifyImportOutput({ inputDirectory, migrationsRoot }) {
  const inputRoot = resolve(inputDirectory);
  const report = JSON.parse(await readFile(resolve(inputRoot, "report.json"), "utf8"));
  invariant(report.formatVersion === 2, `Unsupported report format: ${report.formatVersion}`);

  for (const artifact of report.artifacts) {
    const actual = await sha256File(resolve(inputRoot, artifact.path));
    invariant(actual === artifact.sha256, `Artifact checksum mismatch: ${artifact.path}`);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "poapin-import-verify-"));
  const catalogDatabase = resolve(temporaryRoot, "catalog.sqlite");
  const holdingsDatabase = resolve(temporaryRoot, "holdings.sqlite");
  try {
    const catalogSql = await sqlFiles(resolve(inputRoot, "catalog"));
    const holdingsSql = await sqlFiles(resolve(inputRoot, "holdings"));
    const catalogMigrations = await sqlFiles(resolve(migrationsRoot, "catalog"));
    const holdingsMigrations = await sqlFiles(resolve(migrationsRoot, "holdings"));
    await applySqlFiles(catalogDatabase, [...catalogMigrations, ...catalogSql]);
    await applySqlFiles(holdingsDatabase, [...holdingsMigrations, ...holdingsSql]);

    const [catalog] = await queryJsonRows(
      catalogDatabase,
      `SELECT json_object(
      'drops', (SELECT COUNT(*) FROM drops),
      'dropStats', (SELECT COUNT(*) FROM drop_stats),
      'ftsRows', (SELECT COUNT(*) FROM drops_fts),
      'tokenCountFromDrops', (SELECT COALESCE(SUM(token_count), 0) FROM drops),
      'integrity', (SELECT integrity_check FROM pragma_integrity_check)
    )`,
      { maximumRows: 1 },
    );
    const [holdings] = await queryJsonRows(
      holdingsDatabase,
      `SELECT json_object(
      'tokens', (SELECT COUNT(*) FROM tokens),
      'owners', (SELECT COUNT(*) FROM owner_stats),
      'dropCollectorRefs', (SELECT COUNT(*) FROM drop_collector_refs),
      'tokenCountFromOwnerStats', (SELECT COALESCE(SUM(token_count), 0) FROM owner_stats),
      'integrity', (SELECT integrity_check FROM pragma_integrity_check)
    )`,
      { maximumRows: 1 },
    );
    const catalogMetadataRows = await queryJsonRows(
      catalogDatabase,
      "SELECT json_object('key', key, 'value', value) FROM archive_meta ORDER BY key",
      { maximumRows: 100 },
    );
    const holdingsMetadataRows = await queryJsonRows(
      holdingsDatabase,
      "SELECT json_object('key', key, 'value', value) FROM archive_meta ORDER BY key",
      { maximumRows: 100 },
    );
    const catalogMetadata = Object.fromEntries(
      catalogMetadataRows.map((row) => [row.key, row.value]),
    );
    const holdingsMetadata = Object.fromEntries(
      holdingsMetadataRows.map((row) => [row.key, row.value]),
    );
    const plan = await querySmallJsonDocument(
      holdingsDatabase,
      `EXPLAIN QUERY PLAN
      SELECT source_uid, poap_id
      FROM tokens
      WHERE owner_address_norm = '0x0000000000000000000000000000000000000000'
      ORDER BY poap_id DESC, source_uid DESC
      LIMIT 48`,
    );
    const dropCollectorPlan = await querySmallJsonDocument(
      holdingsDatabase,
      `EXPLAIN QUERY PLAN
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
      WHERE r.drop_id = 0
      ORDER BY r.poap_id DESC, r.source_uid DESC, r.owner_address_norm DESC
      LIMIT 49`,
    );

    invariant(catalog.integrity === "ok", `Catalog integrity check failed: ${catalog.integrity}`);
    invariant(
      holdings.integrity === "ok",
      `Holdings integrity check failed: ${holdings.integrity}`,
    );
    invariant(
      catalog.drops === report.counts.accepted.drops,
      "Catalog drop count differs from report.json.",
    );
    invariant(
      catalog.dropStats === catalog.drops,
      "Every accepted drop must have one drop_stats row.",
    );
    invariant(catalog.ftsRows === catalog.drops, "FTS row count differs from catalog drop count.");
    invariant(
      holdings.tokens === report.counts.accepted.tokens,
      "Holdings token count differs from report.json.",
    );
    invariant(
      holdings.dropCollectorRefs === holdings.tokens,
      "Drop collector references do not cover every accepted token.",
    );
    invariant(
      holdings.owners === report.counts.accepted.owners,
      "Owner count differs from report.json.",
    );
    invariant(
      holdings.tokenCountFromOwnerStats === holdings.tokens,
      "owner_stats token counts do not add up to the token table.",
    );
    invariant(
      catalog.tokenCountFromDrops === holdings.tokens,
      "drops.token_count values do not add up to the token table.",
    );
    invariant(
      Number(catalogMetadata.drops_count) === catalog.drops,
      "Catalog archive_meta drops_count is incorrect.",
    );
    invariant(
      Number(catalogMetadata.tokens_count) === holdings.tokens,
      "Catalog archive_meta tokens_count is incorrect.",
    );
    invariant(
      Number(catalogMetadata.owners_count) === holdings.owners,
      "Catalog archive_meta owners_count is incorrect.",
    );
    invariant(
      Number(holdingsMetadata.tokens_count) === holdings.tokens,
      "Holdings archive_meta tokens_count is incorrect.",
    );
    invariant(
      Number(holdingsMetadata.owners_count) === holdings.owners,
      "Holdings archive_meta owners_count is incorrect.",
    );
    invariant(
      catalogMetadata.snapshot_id === report.snapshot.id,
      "Catalog snapshot_id differs from report.json.",
    );
    invariant(
      holdingsMetadata.snapshot_id === report.snapshot.id,
      "Holdings snapshot_id differs from report.json.",
    );
    invariant(
      catalogMetadata.snapshot_id === holdingsMetadata.snapshot_id,
      "D1 snapshot identifiers do not match.",
    );
    for (const key of [
      "snapshot_at",
      "schema_version",
      "importer_version",
      "source_database_sha256",
      "source_archive_sha256_status",
      "source_archive_expected_sha256",
      "source_archive_sha256",
    ]) {
      invariant(
        catalogMetadata[key] === holdingsMetadata[key],
        `D1 archive_meta ${key} values do not match.`,
      );
    }
    invariant(
      plan.some((row) => String(row.detail).includes("PRIMARY KEY")),
      "Owner lookup does not use the clustered tokens primary key.",
    );
    invariant(
      dropCollectorPlan.filter((row) => String(row.detail).includes("USING PRIMARY KEY")).length >=
        2 &&
        !dropCollectorPlan.some((row) => String(row.detail).includes("SCAN tokens")) &&
        !dropCollectorPlan.some((row) => String(row.detail).includes("SCAN drop_collector_refs")) &&
        !dropCollectorPlan.some((row) => String(row.detail).includes("USE TEMP B-TREE")),
      "Drop collector lookup does not use both clustered primary-key paths.",
    );

    return {
      verified: true,
      snapshotId: report.snapshot.id,
      artifactCount: report.artifacts.length,
      catalog,
      holdings,
      ownerLookupPlan: plan.map((row) => row.detail),
      dropCollectorLookupPlan: dropCollectorPlan.map((row) => row.detail),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function sqlFiles(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => resolve(directory, entry.name))
    .sort((left, right) => basename(left).localeCompare(basename(right), "en"));
}

async function applySqlFiles(databasePath, filePaths) {
  const child = spawn(SQLITE_BINARY, ["-batch", databasePath], { stdio: ["pipe", "pipe", "pipe"] });
  const closePromise = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 128 * 1024) stderr += chunk;
  });
  child.stdout.resume();
  await writeWithBackpressure(child.stdin, ".bail on\nPRAGMA foreign_keys = ON;\n");
  for (const filePath of filePaths) {
    for await (const chunk of createReadStream(filePath)) {
      await writeWithBackpressure(child.stdin, chunk);
    }
    await writeWithBackpressure(child.stdin, "\n");
  }
  child.stdin.end();
  const [code] = await closePromise;
  invariant(
    code === 0,
    `sqlite3 failed while applying ${basename(filePaths.at(-1))}: ${stderr.trim() || `exit ${code}`}`,
  );
}
