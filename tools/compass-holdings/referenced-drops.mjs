import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DROP_SELECTION } from "../collections-backup/lib/config.mjs";
import { GraphqlClient } from "../collections-backup/lib/graphql.mjs";
import {
  exists,
  readJson,
  sha256,
  sha256File,
  writeJsonAtomic,
} from "../collections-backup/lib/files.mjs";
import { invariant } from "../archive-import/lib/util.mjs";
import { DEFAULT_DELAY_MS, DEFAULT_ENDPOINT } from "./config.mjs";

const DATASET = "poapin-compass-referenced-drops";
const FORMAT_VERSION = 1;
const BATCH_SIZE = 100;

export const REFERENCED_DROPS_QUERY = `
query POAPinCompassReferencedDrops($dropIds: [Int!]!) {
  drops(
    where: { id: { _in: $dropIds } }
    order_by: { id: asc }
    limit: 100
  ) {
    ${DROP_SELECTION}
  }
}
`;

const CREATE_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = FILE;

CREATE TABLE snapshot_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- Column-compatible with the POAP Archive source database.
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

CREATE INDEX idx_drops_fancy_id ON drops(fancy_id);

-- Compass-only fields and the complete upstream object are preserved beside
-- the source-compatible table so future importers do not lose information.
CREATE TABLE compass_drop_metadata (
  drop_id INTEGER PRIMARY KEY,
  expiry_date TEXT,
  integrator_id TEXT,
  image_url TEXT,
  animation_url TEXT,
  private_value TEXT,
  is_hidden INTEGER NOT NULL CHECK (is_hidden IN (0, 1)),
  hidden_on TEXT,
  raw_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  FOREIGN KEY (drop_id) REFERENCES drops(drop_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE requested_drops (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 0),
  drop_id INTEGER NOT NULL UNIQUE CHECK (drop_id > 0),
  batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
  captured INTEGER NOT NULL DEFAULT 0 CHECK (captured IN (0, 1))
);

CREATE TABLE capture_batches (
  batch_index INTEGER PRIMARY KEY CHECK (batch_index >= 0),
  first_drop_id INTEGER NOT NULL,
  last_drop_id INTEGER NOT NULL,
  requested_count INTEGER NOT NULL CHECK (requested_count BETWEEN 1 AND 100),
  captured_count INTEGER NOT NULL CHECK (
    captured_count >= 0 AND captured_count <= requested_count
  ),
  missing_drop_ids_json TEXT NOT NULL,
  response_sha256 TEXT NOT NULL CHECK (length(response_sha256) = 64),
  fetched_at TEXT NOT NULL
) WITHOUT ROWID;
`;

export async function captureReferencedDrops(options = {}) {
  const settings = normalizeOptions(options);
  const sourceManifestPath = resolve(settings.input, "manifest.json");
  const sourceDatabasePath = resolve(settings.input, "compass-holdings.sqlite");
  const databasePath = resolve(settings.input, "compass-referenced-drops.sqlite");
  const manifestPath = resolve(settings.input, "referenced-drops-manifest.json");
  const sourceManifest = await readJson(sourceManifestPath);
  validateSourceManifest(sourceManifest);
  const [sourceManifestArtifact, sourceDatabaseArtifact] = await Promise.all([
    sha256File(sourceManifestPath),
    sha256File(sourceDatabasePath),
  ]);
  invariant(
    sourceDatabaseArtifact.sha256 === sourceManifest.database.sha256 &&
      sourceDatabaseArtifact.byteLength === sourceManifest.database.byteLength,
    "Holdings database does not match its manifest.",
  );

  if (await exists(manifestPath)) {
    invariant(
      settings.resume,
      "Referenced Drop capture already exists; pass --resume to verify it.",
    );
    const manifest = await readJson(manifestPath);
    await validateCompletedCapture({
      manifest,
      databasePath,
      sourceManifest,
      sourceManifestArtifact,
      sourceDatabaseArtifact,
    });
    return manifest;
  }
  if ((await exists(databasePath)) && !settings.resume) {
    throw new Error("Referenced Drop database already exists; pass --resume to continue.");
  }

  const database = new DatabaseSync(databasePath);
  try {
    if (!hasTable(database, "requested_drops")) {
      database.exec(CREATE_SCHEMA_SQL);
      initializeRequestedDrops(database, sourceDatabasePath, {
        endpoint: settings.endpoint,
        sourceManifest,
        sourceManifestSha256: sourceManifestArtifact.sha256,
        sourceDatabaseSha256: sourceDatabaseArtifact.sha256,
      });
    } else {
      verifyResumeContext(database, {
        endpoint: settings.endpoint,
        sourceManifest,
        sourceManifestSha256: sourceManifestArtifact.sha256,
        sourceDatabaseSha256: sourceDatabaseArtifact.sha256,
      });
    }

    await capturePendingBatches(database, settings);
    const summary = finalizeCapture(database);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    database.exec("PRAGMA journal_mode = DELETE;");
    database.close();

    const databaseArtifact = await sha256File(databasePath);
    const manifest = {
      version: FORMAT_VERSION,
      dataset: DATASET,
      snapshotId: sourceManifest.snapshotId,
      endpoint: settings.endpoint,
      startedAt: summary.startedAt,
      finishedAt: new Date().toISOString(),
      source: {
        holdingsManifest: {
          path: "manifest.json",
          ...sourceManifestArtifact,
        },
        holdingsDatabase: {
          path: "compass-holdings.sqlite",
          ...sourceDatabaseArtifact,
        },
      },
      query: {
        operationName: "POAPinCompassReferencedDrops",
        sha256: sha256(REFERENCED_DROPS_QUERY),
        batchSize: BATCH_SIZE,
        concurrency: settings.concurrency,
      },
      counts: {
        requested: summary.requested,
        captured: summary.captured,
        missing: summary.missing,
        batches: summary.batches,
      },
      missingDropIds: summary.missingDropIds,
      database: {
        path: "compass-referenced-drops.sqlite",
        ...databaseArtifact,
      },
    };
    await writeJsonAtomic(manifestPath, manifest);
    return manifest;
  } catch (error) {
    try {
      database.close();
    } catch {}
    throw error;
  }
}

function initializeRequestedDrops(database, sourceDatabasePath, context) {
  const source = new DatabaseSync(sourceDatabasePath, { readOnly: true });
  const rows = source
    .prepare(
      `SELECT DISTINCT drop_id
       FROM tokens
       WHERE drop_id IS NOT NULL AND drop_id > 0
       ORDER BY drop_id`,
    )
    .iterate();
  const insert = database.prepare(
    `INSERT INTO requested_drops (ordinal, drop_id, batch_index, captured)
     VALUES (?, ?, ?, 0)`,
  );
  const insertMeta = database.prepare("INSERT INTO snapshot_metadata (key, value) VALUES (?, ?)");
  const startedAt = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE;");
  try {
    let ordinal = 0;
    for (const row of rows) {
      const dropId = positiveInteger(row.drop_id, "tokens.drop_id");
      insert.run(ordinal, dropId, Math.floor(ordinal / BATCH_SIZE));
      ordinal += 1;
    }
    invariant(ordinal > 0, "Holdings snapshot does not reference any Drops.");
    for (const [key, value] of Object.entries({
      version: FORMAT_VERSION,
      dataset: DATASET,
      snapshot_id: context.sourceManifest.snapshotId,
      endpoint: context.endpoint,
      query_sha256: sha256(REFERENCED_DROPS_QUERY),
      source_manifest_sha256: context.sourceManifestSha256,
      source_database_sha256: context.sourceDatabaseSha256,
      requested_count: ordinal,
      started_at: startedAt,
    })) {
      insertMeta.run(key, String(value));
    }
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  } finally {
    source.close();
  }
}

function verifyResumeContext(database, context) {
  const quickCheck = database.prepare("PRAGMA quick_check").get();
  invariant(quickCheck?.quick_check === "ok", "Referenced Drop SQLite quick_check failed.");
  const meta = metadata(database);
  const expected = {
    version: FORMAT_VERSION,
    dataset: DATASET,
    snapshot_id: context.sourceManifest.snapshotId,
    endpoint: context.endpoint,
    query_sha256: sha256(REFERENCED_DROPS_QUERY),
    source_manifest_sha256: context.sourceManifestSha256,
    source_database_sha256: context.sourceDatabaseSha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    invariant(meta[key] === String(value), `Referenced Drop capture ${key} does not match.`);
  }
}

async function capturePendingBatches(database, settings) {
  const pending = database
    .prepare(
      `SELECT DISTINCT batch_index
       FROM requested_drops
       WHERE batch_index NOT IN (SELECT batch_index FROM capture_batches)
       ORDER BY batch_index`,
    )
    .all();
  const insertDrop = database.prepare(
    `INSERT INTO drops (
      drop_id, fancy_id, title, description, start_date, end_date, city,
      country, event_url, year, is_virtual, is_private, channel, platform,
      location_type, timezone, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMetadata = database.prepare(
    `INSERT INTO compass_drop_metadata (
      drop_id, expiry_date, integrator_id, image_url, animation_url,
      private_value, is_hidden, hidden_on, raw_json, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const markCaptured = database.prepare(
    "UPDATE requested_drops SET captured = 1 WHERE drop_id = ?",
  );
  const insertBatch = database.prepare(
    `INSERT INTO capture_batches (
      batch_index, first_drop_id, last_drop_id, requested_count,
      captured_count, missing_drop_ids_json, response_sha256, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const totalBatches = pending.length === 0 ? 0 : Number(pending.at(-1).batch_index) + 1;
  let next = 0;
  const captureBatch = async (batchRow, client) => {
    const batchIndex = Number(batchRow.batch_index);
    const requested = database
      .prepare(
        `SELECT drop_id
         FROM requested_drops
         WHERE batch_index = ?
         ORDER BY ordinal`,
      )
      .all(batchIndex)
      .map((row) => Number(row.drop_id));
    invariant(requested.length > 0 && requested.length <= BATCH_SIZE, "Invalid Drop batch.");
    const response = await client.request({
      query: REFERENCED_DROPS_QUERY,
      variables: { dropIds: requested },
      operationName: "POAPinCompassReferencedDrops",
    });
    const rows = response.body.data.drops;
    invariant(Array.isArray(rows) && rows.length <= requested.length, "Invalid Drop response.");
    const allowed = new Set(requested);
    const normalized = rows.map(normalizeDrop);
    const captured = new Set();
    for (const row of normalized) {
      invariant(allowed.has(row.dropId), `Compass returned unrequested Drop ${row.dropId}.`);
      invariant(!captured.has(row.dropId), `Compass repeated Drop ${row.dropId}.`);
      captured.add(row.dropId);
    }
    const missing = requested.filter((dropId) => !captured.has(dropId));
    const fetchedAt = new Date().toISOString();
    const responseSha256 = createHash("sha256").update(response.bodyText).digest("hex");
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (const row of normalized) {
        insertDrop.run(...row.source);
        insertMetadata.run(
          row.dropId,
          row.expiryDate,
          row.integratorId,
          row.imageUrl,
          row.animationUrl,
          row.privateValue,
          row.isHidden,
          row.hiddenOn,
          row.rawJson,
          fetchedAt,
        );
        markCaptured.run(row.dropId);
      }
      insertBatch.run(
        batchIndex,
        requested[0],
        requested.at(-1),
        requested.length,
        normalized.length,
        JSON.stringify(missing),
        responseSha256,
        fetchedAt,
      );
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
    settings.onProgress({
      phase: "referenced-drops",
      batch: batchIndex + 1,
      batches: totalBatches,
      captured: normalized.length,
      missing: missing.length,
    });
  };
  const workers = Array.from(
    { length: Math.min(settings.concurrency, pending.length) },
    async () => {
      const client = new GraphqlClient({
        endpoint: settings.endpoint,
        delayMs: settings.delayMs,
        retries: settings.retries,
        timeoutMs: settings.timeoutMs,
        onRequest: settings.onRequest,
      });
      while (next < pending.length) {
        const batchRow = pending[next];
        next += 1;
        await captureBatch(batchRow, client);
      }
    },
  );
  await Promise.all(workers);
}

function normalizeDrop(row) {
  const dropId = positiveInteger(row?.id, "drops.id");
  const privacy = normalizePrivate(row.private, dropId);
  const isHidden = row.hidden_drop ? 1 : 0;
  return {
    dropId,
    source: [
      dropId,
      nonNullText(row.fancy_id, `Drop ${dropId} fancy_id`),
      nonNullText(row.name, `Drop ${dropId} name`),
      nullableText(row.description),
      requiredText(row.start_date, `Drop ${dropId} start_date`),
      requiredText(row.end_date, `Drop ${dropId} end_date`),
      nullableText(row.city),
      nullableText(row.country),
      nullableText(row.drop_url),
      integer(row.year, `Drop ${dropId} year`),
      nullableBoolean(row.virtual, `Drop ${dropId} virtual`),
      privacy.isPrivate,
      nullableText(row.channel),
      nullableText(row.platform),
      nullableText(row.location_type),
      nullableText(row.timezone),
      requiredText(row.created_date, `Drop ${dropId} created_date`),
    ],
    expiryDate: nullableText(row.expiry_date),
    integratorId: nullableText(row.integrator_id),
    imageUrl: nullableText(row.image_url),
    animationUrl: nullableText(row.animation_url),
    privateValue: privacy.privateValue,
    isHidden,
    hiddenOn: nullableText(row.hidden_drop?.hidden_on),
    rawJson: JSON.stringify(row),
  };
}

function finalizeCapture(database) {
  const summary = database
    .prepare(
      `SELECT
        COUNT(*) AS requested,
        SUM(captured) AS captured,
        COUNT(DISTINCT batch_index) AS expected_batches,
        (SELECT COUNT(*) FROM capture_batches) AS batches,
        (SELECT COUNT(*) FROM drops) AS drops,
        (SELECT COUNT(*) FROM compass_drop_metadata) AS metadata
       FROM requested_drops`,
    )
    .get();
  const requested = Number(summary.requested);
  const captured = Number(summary.captured);
  const batches = Number(summary.batches);
  invariant(
    batches === Number(summary.expected_batches),
    "Referenced Drop batches are incomplete.",
  );
  invariant(captured === Number(summary.drops), "Referenced Drop source rows differ.");
  invariant(captured === Number(summary.metadata), "Referenced Drop metadata rows differ.");
  const missingDropIds = database
    .prepare("SELECT drop_id FROM requested_drops WHERE captured = 0 ORDER BY drop_id")
    .all()
    .map((row) => Number(row.drop_id));
  invariant(requested - captured === missingDropIds.length, "Missing Drop count differs.");
  const quickCheck = database.prepare("PRAGMA quick_check").get();
  invariant(quickCheck?.quick_check === "ok", "Referenced Drop SQLite quick_check failed.");
  return {
    requested,
    captured,
    missing: missingDropIds.length,
    batches,
    missingDropIds,
    startedAt: metadata(database).started_at,
  };
}

async function validateCompletedCapture({
  manifest,
  databasePath,
  sourceManifest,
  sourceManifestArtifact,
  sourceDatabaseArtifact,
}) {
  invariant(manifest?.version === FORMAT_VERSION, "Unsupported referenced Drop manifest.");
  invariant(manifest.dataset === DATASET, "Referenced Drop manifest dataset is invalid.");
  invariant(manifest.snapshotId === sourceManifest.snapshotId, "Referenced Drop snapshot differs.");
  const artifact = await sha256File(databasePath);
  invariant(
    artifact.sha256 === manifest.database?.sha256 &&
      artifact.byteLength === manifest.database?.byteLength,
    "Referenced Drop database does not match its manifest.",
  );
  invariant(
    manifest.source?.holdingsDatabase?.sha256 === sourceDatabaseArtifact.sha256,
    "Referenced Drop source database binding differs.",
  );
  invariant(
    manifest.source?.holdingsManifest?.sha256 === sourceManifestArtifact.sha256,
    "Referenced Drop source manifest binding differs.",
  );
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const summary = finalizeCapture(database);
    invariant(summary.requested === manifest.counts?.requested, "Requested Drop count differs.");
    invariant(summary.captured === manifest.counts?.captured, "Captured Drop count differs.");
    invariant(summary.missing === manifest.counts?.missing, "Missing Drop count differs.");
  } finally {
    database.close();
  }
}

function validateSourceManifest(manifest) {
  invariant(manifest?.version === 1, "Unsupported Holdings manifest version.");
  invariant(manifest.dataset === "poapin-compass-holdings", "Input is not a Holdings snapshot.");
  invariant(
    manifest.counts?.captured === manifest.counts?.expected && manifest.counts.captured > 0,
    "Holdings snapshot is incomplete.",
  );
}

function metadata(database) {
  return Object.fromEntries(
    database
      .prepare("SELECT key, value FROM snapshot_metadata ORDER BY key")
      .all()
      .map((row) => [row.key, row.value]),
  );
}

function hasTable(database, name) {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name),
  );
}

function normalizeOptions(options) {
  invariant(typeof options.input === "string" && options.input.length > 0, "input is required.");
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const parsedEndpoint = new URL(endpoint);
  invariant(
    parsedEndpoint.protocol === "https:" || parsedEndpoint.hostname === "127.0.0.1",
    "Compass endpoint must use HTTPS.",
  );
  return {
    input: resolve(options.input),
    endpoint,
    concurrency: boundedInteger(options.concurrency ?? 4, 1, 8, "concurrency"),
    delayMs: boundedInteger(options.delayMs ?? DEFAULT_DELAY_MS, 0, 60_000, "delayMs"),
    retries: boundedInteger(options.retries ?? 5, 0, 10, "retries"),
    timeoutMs: boundedInteger(options.timeoutMs ?? 30_000, 1_000, 120_000, "timeoutMs"),
    resume: options.resume === true,
    onProgress: options.onProgress ?? (() => {}),
    onRequest: options.onRequest ?? (() => {}),
  };
}

function normalizePrivate(value, dropId) {
  if (value === false || value === "false") return { privateValue: "false", isPrivate: 0 };
  if (value === true || value === "true") return { privateValue: "true", isPrivate: 1 };
  if (value === null || value === undefined) return { privateValue: null, isPrivate: 1 };
  throw new Error(`Drop ${dropId} private is not a reviewed boolean value.`);
}

function integer(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is invalid.`);
  return parsed;
}

function positiveInteger(value, label) {
  const parsed = integer(value, label);
  if (parsed <= 0) throw new Error(`${label} is invalid.`);
  return parsed;
}

function nullableBoolean(value, label) {
  if (value === null || value === undefined) return null;
  if (value === true) return 1;
  if (value === false) return 0;
  throw new Error(`${label} is not a boolean.`);
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is empty.`);
  return value;
}

function nonNullText(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is not text.`);
  return value;
}

function nullableText(value) {
  return value === null || value === undefined ? null : String(value);
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export const referencedDropsInternals = {
  normalizeDrop,
};
