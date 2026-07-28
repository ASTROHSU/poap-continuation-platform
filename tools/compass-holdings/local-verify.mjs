import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describeFile, invariant } from "../archive-import/lib/util.mjs";
import { loadContext } from "./d1-loader.mjs";

export async function verifyCompassHoldingsD1Locally(options = {}) {
  const settings = normalizeOptions(options);
  try {
    await stat(settings.output);
    throw new Error(`Refusing to overwrite local verification database: ${settings.output}.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const context = await loadContext({
    input: settings.input,
    target: {
      name: "local-verification-only",
      id: "00000000-0000-4000-8000-000000000000",
    },
    projectConfig: resolve(settings.input, "unused-wrangler.jsonc"),
  });
  const database = new DatabaseSync(settings.output);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = FILE;
    `);
    const plan = [...context.prepare, ...context.data, context.finalize];
    for (const [index, artifact] of plan.entries()) {
      settings.onProgress({ index, total: plan.length, artifact });
      database.exec("BEGIN IMMEDIATE;");
      try {
        database.exec(await readFile(artifact.absolutePath, "utf8"));
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    }
    const counts = {
      tokens: count(database, "tokens"),
      owners: count(database, "owner_stats"),
      collectors: count(database, "drop_collector_refs"),
      holdingDrops: count(database, "holding_drops"),
      importShards: count(database, "import_shards"),
    };
    invariant(counts.tokens === context.report.tables.tokens, "Local token count differs.");
    invariant(counts.owners === context.report.tables.owner_stats, "Local owner count differs.");
    invariant(
      counts.holdingDrops === context.report.tables.holding_drops,
      "Local referenced Drop count differs.",
    );
    invariant(
      counts.collectors === context.report.tables.drop_collector_refs,
      "Local Drop collector reference count differs.",
    );
    invariant(counts.importShards === context.data.length, "Local import journal count differs.");
    const meta = Object.fromEntries(
      database
        .prepare("SELECT key, value FROM archive_meta ORDER BY key")
        .all()
        .map((row) => [row.key, row.value]),
    );
    invariant(meta.snapshot_id === context.snapshotId, "Local snapshot metadata differs.");
    invariant(
      meta.source_database_sha256 === context.sourceDatabaseSha256,
      "Local source database digest differs.",
    );
    invariant(
      meta.referenced_drops_database_sha256 ===
        context.report.source.referencedDrops.database.sha256,
      "Local referenced Drop database digest differs.",
    );
    const quickCheck = database.prepare("PRAGMA quick_check").get();
    invariant(quickCheck?.quick_check === "ok", "Local D1-shaped SQLite quick_check failed.");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    database.exec("PRAGMA journal_mode = DELETE;");
    database.close();

    const report = {
      version: 1,
      dataset: "poapin-compass-holdings-local-d1-verification",
      snapshotId: context.snapshotId,
      verifiedAt: new Date().toISOString(),
      sourceD1ReportSha256: context.reportSha256,
      counts,
      metadata: meta,
      database: {
        path: settings.output,
        ...(await describeFile(settings.output)),
      },
    };
    const reportPath = `${settings.output}.report.json`;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return { report, reportPath };
  } catch (error) {
    try {
      database.close();
    } catch {}
    throw error;
  }
}

function count(database, table) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count);
}

function normalizeOptions(options) {
  invariant(typeof options.input === "string" && options.input.length > 0, "input is required.");
  invariant(typeof options.output === "string" && options.output.length > 0, "output is required.");
  return {
    input: resolve(options.input),
    output: resolve(options.output),
    onProgress: options.onProgress ?? (() => {}),
  };
}
