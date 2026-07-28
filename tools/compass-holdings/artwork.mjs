import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

import { ImmutableCollectionsBridgeUploader } from "../collections-backup/bridge/client.mjs";
import { detectMediaType } from "../moments-media/lib/sniff.mjs";
import { HoldingsMultipartUploader } from "./artwork-bridge/client.mjs";
import {
  appendJsonLine,
  exists,
  readJson,
  sha256,
  sha256File,
  writeJsonAtomic,
} from "../collections-backup/lib/files.mjs";
import { mediaInternals } from "../collections-backup/lib/media.mjs";

const execFile = promisify(execFileCallback);
const FORMAT_VERSION = 1;
const SNAPSHOT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_HOSTS = Object.freeze(["assets.poap.xyz", "storage.googleapis.com"]);
const ARCHIVE_BATCH_SIZE = 20_000;
const DEFAULT_MAXIMUM_BYTES = 100_000_000;
const MAXIMUM_ORIGINAL_BYTES = 5_000_000_000;
const MULTIPART_PART_BYTES = 16_777_216;
const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";
const MEDIA_TYPE_BY_EXTENSION = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["heic", "image/heic"],
]);

export async function captureArchiveArtworkIndex({
  output,
  snapshotId,
  database = "CATALOG_DB",
  config = "wrangler.jsonc",
  cwd = process.cwd(),
  query = defaultD1Query,
  onProgress = () => {},
}) {
  if (!SNAPSHOT_PATTERN.test(snapshotId ?? "")) {
    throw new Error("Archive snapshot ID is invalid.");
  }
  const target = resolve(output);
  const ids = [];
  let after = 0;
  while (true) {
    const rows = await query({
      database,
      config,
      cwd,
      sql: `SELECT drop_id FROM drops WHERE has_artwork = 1 AND drop_id > ${after} ORDER BY drop_id LIMIT ${ARCHIVE_BATCH_SIZE};`,
    });
    if (!Array.isArray(rows) || rows.length > ARCHIVE_BATCH_SIZE) {
      throw new Error("Archive D1 returned an invalid artwork page.");
    }
    for (const row of rows) {
      const dropId = Number(row.drop_id);
      if (!Number.isSafeInteger(dropId) || dropId <= after) {
        throw new Error("Archive D1 artwork IDs are not strictly increasing.");
      }
      ids.push(dropId);
      after = dropId;
    }
    onProgress({ rows: ids.length, after });
    if (rows.length < ARCHIVE_BATCH_SIZE) break;
  }
  if (ids.length === 0) throw new Error("Archive D1 did not return any artwork IDs.");

  const value = {
    schemaVersion: "poapin-archive-artwork-index-v1",
    snapshotId,
    capturedAt: new Date().toISOString(),
    database,
    query: "drops.has_artwork = 1 ordered by drop_id",
    count: ids.length,
    artworkIds: ids,
  };
  await writeImmutableJson(target, value, ["capturedAt"]);
  return { path: target, index: value, ...(await sha256File(target)) };
}

export async function buildHoldingsArtworkPlan({
  input,
  archiveArtworkIndex,
  collectionsInput,
  releaseRoot = new URL("./artwork-releases/", import.meta.url),
  output,
}) {
  const snapshotRoot = resolve(input);
  const artworkRoot = resolve(output ?? snapshotRoot, output ? "" : "artwork-archive");
  const sourceDatabase = resolve(snapshotRoot, "compass-referenced-drops.sqlite");
  const sourceManifestPath = resolve(snapshotRoot, "referenced-drops-manifest.json");
  const [sourceStat, sourceManifest, archiveIndex] = await Promise.all([
    regularFile(sourceDatabase, "referenced Drop database"),
    readJson(sourceManifestPath),
    readJson(resolve(archiveArtworkIndex)),
  ]);
  if (
    !SNAPSHOT_PATTERN.test(sourceManifest.snapshotId ?? "") ||
    sourceManifest.counts?.captured !== sourceManifest.counts?.requested ||
    sourceManifest.counts?.missing !== 0
  ) {
    throw new Error("Referenced Drop snapshot is incomplete.");
  }
  if (
    archiveIndex.schemaVersion !== "poapin-archive-artwork-index-v1" ||
    !SNAPSHOT_PATTERN.test(archiveIndex.snapshotId ?? "") ||
    archiveIndex.count !== archiveIndex.artworkIds?.length
  ) {
    throw new Error("Archive artwork index is invalid.");
  }
  const archiveIds = new Set();
  for (const value of archiveIndex.artworkIds) {
    if (!Number.isSafeInteger(value) || value <= 0 || archiveIds.has(value)) {
      throw new Error("Archive artwork index contains an invalid or duplicate ID.");
    }
    archiveIds.add(value);
  }

  const collections = await loadCollectionsArtworkProof(resolve(collectionsInput));
  const seed = await loadSeedReleases(releaseRoot, sourceManifest.snapshotId);
  const sourceRows = readHoldingDropSources(sourceDatabase);
  if (sourceRows.length !== sourceManifest.counts.requested) {
    throw new Error("Referenced Drop database count differs from its manifest.");
  }

  const plan = [];
  const counts = { archive: 0, collections: 0, seed: 0, capture: 0 };
  for (const row of sourceRows) {
    if (archiveIds.has(row.dropId)) {
      counts.archive += 1;
      continue;
    }
    const seedObject = seed.objects.get(row.dropId);
    if (seedObject) {
      plan.push({
        dropId: row.dropId,
        action: "seed",
        sourceUrl: row.sourceUrl,
        object: seedObject,
        releaseId: seedObject.releaseId,
      });
      counts.seed += 1;
      continue;
    }
    const collectionObject = collections.objects.get(row.dropId);
    if (collectionObject) {
      plan.push({
        dropId: row.dropId,
        action: "collection-reuse",
        sourceUrl: row.sourceUrl,
        object: collectionObject,
      });
      counts.collections += 1;
      continue;
    }
    plan.push({ dropId: row.dropId, action: "capture", sourceUrl: row.sourceUrl });
    counts.capture += 1;
  }

  const planPath = resolve(artworkRoot, "plan.ndjson");
  const planSource = canonicalNdjson(plan);
  await writeImmutableText(planPath, planSource);
  const inputArtifacts = {
    referencedDropsDatabase: {
      path: relative(snapshotRoot, sourceDatabase).replaceAll("\\", "/"),
      ...sourceStat,
    },
    referencedDropsManifest: await artifact(snapshotRoot, sourceManifestPath),
    archiveArtworkIndex: await artifact(snapshotRoot, resolve(archiveArtworkIndex), {
      external: true,
    }),
    collectionsReferences: collections.artifacts.references,
    collectionsPublishCheckpoint: collections.artifacts.checkpoint,
    collectionsVerifyReport: collections.artifacts.report,
    seedReleases: seed.artifacts,
  };
  const report = {
    schemaVersion: "poapin-holdings-artwork-plan-v1",
    snapshotId: sourceManifest.snapshotId,
    archiveSnapshotId: archiveIndex.snapshotId,
    collectionsSnapshotId: collections.snapshotId,
    generatedAt: new Date().toISOString(),
    sourceDrops: sourceRows.length,
    plannedRows: plan.length,
    counts,
    inputs: inputArtifacts,
    plan: {
      path: relative(artworkRoot, planPath).replaceAll("\\", "/"),
      sha256: sha256(planSource),
      byteLength: Buffer.byteLength(planSource),
      rows: plan.length,
    },
  };
  await writeJsonAtomic(resolve(artworkRoot, "plan-report.json"), report);
  return { artworkRoot, report, plan };
}

export async function archiveHoldingsArtwork({
  input,
  bridgeUrl,
  bucket,
  archiveSnapshotId,
  concurrency = 4,
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
  cacheControl = DEFAULT_CACHE_CONTROL,
  retryFailures = true,
  secret = process.env.COLLECTIONS_R2_BRIDGE_SECRET,
  fetchImpl = fetch,
  lookup = dnsLookup,
  onProgress = () => {},
  limit = null,
}) {
  validateConcurrency(concurrency);
  const artworkRoot = resolve(input);
  const { plan, report: planReport, source: planSource } = await readBoundPlan(artworkRoot);
  const uploader = new ImmutableCollectionsBridgeUploader({
    endpoint: parseHttpsOrigin(bridgeUrl),
    bucket,
    snapshotId: planReport.snapshotId,
    archiveSnapshotId,
    objectPrefix: "snapshots/",
    cacheControl,
    maximumObjectBytes: maximumBytes,
    secret: Buffer.from(validateSecret(secret), "base64url"),
    attempts: 4,
    fetchImpl,
    now: Date.now,
  });
  const multipartUploader = new HoldingsMultipartUploader({
    endpoint: parseHttpsOrigin(bridgeUrl),
    bucket,
    snapshotId: planReport.snapshotId,
    maximumObjectBytes: MAXIMUM_ORIGINAL_BYTES,
    partBytes: MULTIPART_PART_BYTES,
    secret: Buffer.from(validateSecret(secret), "base64url"),
    fetchImpl,
    now: Date.now,
  });
  await verifyBridgeTarget(uploader);
  await validateSourceHosts(lookup);

  const checkpointPath = resolve(artworkRoot, "capture-checkpoint.ndjson");
  const checkpoint = await readCaptureCheckpoint(checkpointPath, {
    snapshotId: planReport.snapshotId,
    planSha256: sha256(planSource),
    bridgeOrigin: parseHttpsOrigin(bridgeUrl),
    bucket,
    cacheControl,
    maximumBytes,
  });
  if (!checkpoint.header) {
    await appendJsonLine(checkpointPath, {
      kind: "header",
      version: FORMAT_VERSION,
      dataset: "poapin-holdings-original-artwork",
      snapshotId: planReport.snapshotId,
      planSha256: sha256(planSource),
      bridgeOrigin: parseHttpsOrigin(bridgeUrl),
      bucket,
      cacheControl,
      maximumBytes,
      createdAt: new Date().toISOString(),
    });
  }

  let pending = plan.filter((row) => {
    if (row.action !== "capture") return false;
    const prior = checkpoint.records.get(row.dropId);
    if (!prior) return true;
    return retryFailures && prior.status === "failed";
  });
  pending = await attachOfficialSourceCandidates(artworkRoot, planReport, pending);
  if (limit !== null) pending = pending.slice(0, limit);
  const writer = new SerializedWriter(checkpointPath);
  let handled = 0;
  await runPool(pending, concurrency, async (row) => {
    let record;
    try {
      record = await captureOne({
        artworkRoot,
        row,
        snapshotId: planReport.snapshotId,
        maximumBytes,
        uploader,
        multipartUploader,
        fetchImpl,
      });
    } catch (error) {
      record = {
        kind: "capture",
        version: FORMAT_VERSION,
        dropId: row.dropId,
        sourceUrl: row.sourceUrl,
        attempts: Array.isArray(error?.attempts) ? error.attempts : [],
        status: "failed",
        failureCode: String(error?.code ?? error?.name ?? "ARTWORK_CAPTURE_FAILED").slice(0, 100),
        failureReason: safeError(error),
        completedAt: new Date().toISOString(),
      };
    }
    await writer.record(record);
    checkpoint.records.set(row.dropId, record);
    handled += 1;
    onProgress({
      completed: handled,
      scheduled: pending.length,
      total: planReport.counts.capture,
      dropId: row.dropId,
      status: record.status,
    });
  });
  await writer.close();

  const captureRows = plan.filter((row) => row.action === "capture");
  const records = captureRows.map((row) => checkpoint.records.get(row.dropId)).filter(Boolean);
  const counts = {
    required: captureRows.length,
    completed: records.filter((row) => row.status === "stored").length,
    uploaded: records.filter((row) => row.status === "stored" && row.disposition === "uploaded")
      .length,
    reused: records.filter((row) => row.status === "stored" && row.disposition === "reused").length,
    failed: records.filter((row) => row.status === "failed").length,
    pending: captureRows.length - records.filter((row) => row.status === "stored").length,
    bytes: records
      .filter((row) => row.status === "stored")
      .reduce((sum, row) => sum + row.byteLength, 0),
  };
  const captureReport = {
    schemaVersion: "poapin-holdings-artwork-capture-v1",
    snapshotId: planReport.snapshotId,
    generatedAt: new Date().toISOString(),
    complete: counts.completed === counts.required && counts.failed === 0,
    counts,
    checkpoint: await artifact(artworkRoot, checkpointPath),
    plan: planReport.plan,
    target: {
      bridgeOrigin: parseHttpsOrigin(bridgeUrl),
      bucket,
      cacheControl,
      maximumBytes,
    },
  };
  await writeJsonAtomic(resolve(artworkRoot, "capture-report.json"), captureReport);
  return captureReport;
}

export async function reviewUnavailableHoldingsArtwork({ input, output }) {
  const artworkRoot = resolve(input);
  const { plan, report: planReport, source: planSource } = await readBoundPlan(artworkRoot);
  const captureReportPath = resolve(artworkRoot, "capture-report.json");
  const captureReport = await readJson(captureReportPath);
  const captureReportArtifact = await artifact(artworkRoot, captureReportPath);
  const checkpointPath = resolve(artworkRoot, "capture-checkpoint.ndjson");
  const checkpointArtifact = await artifact(artworkRoot, checkpointPath);
  if (
    captureReport.schemaVersion !== "poapin-holdings-artwork-capture-v1" ||
    captureReport.snapshotId !== planReport.snapshotId ||
    captureReport.plan?.sha256 !== planReport.plan.sha256 ||
    captureReport.checkpoint?.sha256 !== checkpointArtifact.sha256 ||
    captureReport.checkpoint?.byteLength !== checkpointArtifact.byteLength
  ) {
    throw new Error("Artwork capture report is not bound to the current checkpoint.");
  }
  const checkpoint = await readCaptureCheckpoint(checkpointPath, {
    snapshotId: planReport.snapshotId,
    planSha256: sha256(planSource),
    bridgeOrigin: captureReport.target.bridgeOrigin,
    bucket: captureReport.target.bucket,
    cacheControl: captureReport.target.cacheControl,
    maximumBytes: captureReport.target.maximumBytes,
  });
  const failedPlanRows = plan.filter(
    (row) => row.action === "capture" && checkpoint.records.get(row.dropId)?.status === "failed",
  );
  const rowsWithCandidates = await attachOfficialSourceCandidates(
    artworkRoot,
    planReport,
    failedPlanRows,
  );
  const terminal = rowsWithCandidates.map((row) => {
    const record = checkpoint.records.get(row.dropId);
    validateTerminalUnavailableRecord(row, record);
    return {
      dropId: row.dropId,
      sourceCandidates: row.sourceCandidates,
      attempts: record.attempts,
      failureCode: record.failureCode,
      failureReason: record.failureReason,
      completedAt: record.completedAt,
    };
  });
  if (
    captureReport.counts?.failed !== terminal.length ||
    captureReport.counts?.pending !== terminal.length ||
    captureReport.counts?.completed + terminal.length !== planReport.counts.capture
  ) {
    throw new Error("Capture counts do not isolate the terminal-unavailable rows.");
  }
  const report = {
    schemaVersion: "poapin-holdings-artwork-unavailable-v1",
    snapshotId: planReport.snapshotId,
    generatedAt: new Date().toISOString(),
    count: terminal.length,
    plan: planReport.plan,
    checkpoint: checkpointArtifact,
    captureReport: captureReportArtifact,
    policy:
      "Every approved source candidate was attempted; only deterministic empty, unsupported, access-denied, missing, or gone source results are terminal.",
    rows: terminal,
  };
  const target = resolve(output ?? resolve(artworkRoot, "terminal-unavailable.json"));
  await writeJsonAtomic(target, report);
  return { report, path: target };
}

export async function finalizeHoldingsArtwork({
  input,
  releaseId,
  output,
  shardRows = 1_000,
  rowsPerStatement = 100,
}) {
  const artworkRoot = resolve(input);
  const { plan, report: planReport, source: planSource } = await readBoundPlan(artworkRoot);
  if (typeof releaseId !== "string" || !releaseId.startsWith(`${planReport.snapshotId}-artwork-`)) {
    throw new Error("Artwork release ID must be namespaced under the Holdings snapshot.");
  }
  if (
    !Number.isSafeInteger(shardRows) ||
    shardRows < 1 ||
    !Number.isSafeInteger(rowsPerStatement) ||
    rowsPerStatement < 1 ||
    rowsPerStatement > 100 ||
    shardRows % rowsPerStatement !== 0
  ) {
    throw new Error("Artwork D1 shard sizing is invalid.");
  }
  const captureReportPath = resolve(artworkRoot, "capture-report.json");
  const captureReport = await readJson(captureReportPath);
  const captureReportArtifact = await artifact(artworkRoot, captureReportPath);
  const checkpointPath = resolve(artworkRoot, "capture-checkpoint.ndjson");
  const checkpointArtifact = await artifact(artworkRoot, checkpointPath);
  const checkpoint = await readCaptureCheckpoint(checkpointPath, {
    snapshotId: planReport.snapshotId,
    planSha256: sha256(planSource),
    bridgeOrigin: captureReport.target.bridgeOrigin,
    bucket: captureReport.target.bucket,
    cacheControl: captureReport.target.cacheControl,
    maximumBytes: captureReport.target.maximumBytes,
  });
  const unavailablePath = resolve(artworkRoot, "terminal-unavailable.json");
  const unavailableReport =
    captureReport.complete === true ? null : await readJson(unavailablePath);
  const unavailable = validateUnavailableReport(
    unavailableReport,
    planReport,
    captureReport,
    checkpointArtifact,
    captureReportArtifact,
    plan,
    checkpoint,
  );
  const seedArchivedAt = await loadBoundSeedArchiveTimes(
    planReport.inputs?.seedReleases,
    planReport.snapshotId,
  );
  if (
    captureReport.schemaVersion !== "poapin-holdings-artwork-capture-v1" ||
    captureReport.snapshotId !== planReport.snapshotId ||
    captureReport.counts?.completed + unavailable.size !== planReport.counts.capture
  ) {
    throw new Error("Holdings artwork capture is not complete or explicitly unavailable.");
  }
  const objects = [];
  for (const row of plan) {
    if (row.action === "capture" && unavailable.has(row.dropId)) continue;
    let object;
    let proof;
    if (row.action === "capture") {
      object = checkpoint.records.get(row.dropId);
      proof = "holdings-bridge-readback";
      if (object?.status !== "stored") {
        throw new Error(`Holdings artwork capture is missing Drop ${row.dropId}.`);
      }
    } else {
      object = row.object;
      proof = row.action === "seed" ? "seed-release-readback" : "collections-publish-verify";
    }
    const archivedAt =
      object.archivedAt ??
      object.completedAt ??
      (row.action === "seed" ? seedArchivedAt.get(row.releaseId) : null);
    const sourceUrl = row.action === "capture" ? object.sourceUrl : row.sourceUrl;
    validateReleaseObject(
      {
        dropId: row.dropId,
        objectKey: object.objectKey,
        sha256: object.sha256,
        byteLength: object.byteLength,
        contentType: object.contentType,
        sourceUrl,
        archivedAt,
      },
      planReport,
    );
    objects.push({
      dropId: row.dropId,
      objectKey: object.objectKey,
      sha256: object.sha256,
      byteLength: object.byteLength,
      contentType: object.contentType,
      sourceUrl,
      archivedAt,
      proof,
      etag: object.etag ?? null,
    });
  }
  if (objects.length + unavailable.size !== planReport.plan.rows) {
    throw new Error("Artwork coverage release row count differs from its plan.");
  }

  const release = {
    schemaVersion: "poapin-holdings-artwork-coverage-v1",
    snapshotId: planReport.snapshotId,
    archiveSnapshotId: planReport.archiveSnapshotId,
    collectionsSnapshotId: planReport.collectionsSnapshotId,
    releaseId,
    generatedAt: new Date().toISOString(),
    coverage: {
      referencedDrops: planReport.sourceDrops,
      archiveDirect: planReport.counts.archive,
      activatedRows: objects.length,
      collectionReuse: planReport.counts.collections,
      seedHoldings: planReport.counts.seed,
      capturedHoldings: planReport.counts.capture - unavailable.size,
      terminalUnavailable: unavailable.size,
      complete:
        planReport.counts.archive + objects.length + unavailable.size === planReport.sourceDrops &&
        objects.length + unavailable.size ===
          planReport.counts.collections + planReport.counts.seed + planReport.counts.capture,
    },
    verification: {
      plan: planReport.plan,
      captureCheckpoint: checkpointArtifact,
      captureReport: captureReportArtifact,
      terminalUnavailable:
        unavailable.size > 0 ? await artifact(artworkRoot, unavailablePath) : null,
      policy:
        "Existing releases remain bound to their prior readback proof; every new Holdings object was conditionally uploaded and verified by exact authenticated R2 HEAD.",
    },
    objects,
  };
  if (!release.coverage.complete) throw new Error("Artwork coverage arithmetic is incomplete.");
  const releasePath = resolve(output ?? resolve(artworkRoot, `${releaseId}.json`));
  await writeJsonAtomic(releasePath, release);

  const d1Root = resolve(artworkRoot, "d1-artwork");
  await mkdir(d1Root, { recursive: true });
  const shards = [];
  for (let offset = 0; offset < objects.length; offset += shardRows) {
    const rows = objects.slice(offset, offset + shardRows);
    const index = shards.length + 1;
    const path = resolve(d1Root, `${String(index).padStart(4, "0")}.sql`);
    const statements = [];
    for (let rowOffset = 0; rowOffset < rows.length; rowOffset += rowsPerStatement) {
      statements.push(artworkInsertSql(rows.slice(rowOffset, rowOffset + rowsPerStatement)));
    }
    const source = `${statements.join("\n")}\n`;
    await writeImmutableText(path, source);
    shards.push({
      path: relative(artworkRoot, path).replaceAll("\\", "/"),
      rows: rows.length,
      statements: statements.length,
      sha256: sha256(source),
      byteLength: Buffer.byteLength(source),
      firstDropId: rows[0].dropId,
      lastDropId: rows.at(-1).dropId,
    });
  }
  const d1Report = {
    schemaVersion: "poapin-holdings-artwork-d1-v1",
    snapshotId: planReport.snapshotId,
    releaseId,
    generatedAt: new Date().toISOString(),
    release: await artifact(artworkRoot, releasePath, { external: true }),
    expectedRows: objects.length,
    shards,
  };
  await writeJsonAtomic(resolve(d1Root, "report.json"), d1Report);
  return { release, releasePath, d1Report, d1Root };
}

export async function loadHoldingsArtworkD1({
  input,
  database = "HOLDINGS_DB",
  config = "wrangler.jsonc",
  cwd = process.cwd(),
  executeFile = defaultD1File,
  query = defaultD1Query,
  onProgress = () => {},
}) {
  const d1Root = resolve(input);
  const report = await readJson(resolve(d1Root, "report.json"));
  const release = await readJson(resolve(d1Root, report.release.path));
  if (
    report.schemaVersion !== "poapin-holdings-artwork-d1-v1" ||
    release.schemaVersion !== "poapin-holdings-artwork-coverage-v1" ||
    release.releaseId !== report.releaseId ||
    release.objects.length !== report.expectedRows
  ) {
    throw new Error("Holdings artwork D1 report is invalid.");
  }
  for (let index = 0; index < report.shards.length; index += 1) {
    const shard = report.shards[index];
    const path = resolve(dirname(d1Root), shard.path);
    const metadata = await sha256File(path);
    if (metadata.sha256 !== shard.sha256 || metadata.byteLength !== shard.byteLength) {
      throw new Error(`Artwork D1 shard ${shard.path} changed.`);
    }
    await executeFile({ database, config, cwd, path });
    onProgress({ phase: "load", index, total: report.shards.length, shard });
  }

  const remote = [];
  let after = 0;
  while (true) {
    const rows = await query({
      database,
      config,
      cwd,
      sql: `SELECT drop_id, object_key, sha256, byte_length, content_type, source_url, archived_at FROM holding_drop_artwork WHERE drop_id > ${after} ORDER BY drop_id LIMIT 2000;`,
    });
    for (const row of rows) {
      const dropId = numberValue(row.drop_id, "remote artwork Drop ID");
      if (dropId <= after) throw new Error("Remote artwork rows are not strictly increasing.");
      remote.push({
        dropId,
        objectKey: row.object_key,
        sha256: row.sha256,
        byteLength: Number(row.byte_length),
        contentType: row.content_type,
        sourceUrl: row.source_url,
        archivedAt: row.archived_at,
      });
      after = dropId;
    }
    onProgress({ phase: "verify", rows: remote.length, expected: report.expectedRows });
    if (rows.length < 2_000) break;
  }
  const expected = release.objects.map(
    ({ dropId, objectKey, sha256: digest, byteLength, contentType, sourceUrl, archivedAt }) => ({
      dropId,
      objectKey,
      sha256: digest,
      byteLength,
      contentType,
      sourceUrl,
      archivedAt,
    }),
  );
  if (JSON.stringify(remote) !== JSON.stringify(expected)) {
    throw new Error("Remote Holdings artwork rows differ from the immutable coverage release.");
  }
  const remoteReport = {
    schemaVersion: "poapin-holdings-artwork-d1-remote-v1",
    snapshotId: report.snapshotId,
    releaseId: report.releaseId,
    verifiedAt: new Date().toISOString(),
    database,
    rows: remote.length,
    releaseSha256: report.release.sha256,
  };
  await writeJsonAtomic(resolve(d1Root, "remote-report.json"), remoteReport);
  return remoteReport;
}

async function captureOne({
  artworkRoot,
  row,
  snapshotId,
  maximumBytes,
  uploader,
  multipartUploader,
  fetchImpl,
}) {
  const attempts = [];
  let downloaded;
  for (const sourceUrl of row.sourceCandidates ?? [row.sourceUrl]) {
    try {
      downloaded = await downloadOriginal({
        artworkRoot,
        dropId: row.dropId,
        sourceUrl,
        maximumBytes: MAXIMUM_ORIGINAL_BYTES,
        fetchImpl,
      });
      break;
    } catch (error) {
      attempts.push({
        sourceUrl,
        failureCode: String(error?.code ?? error?.name ?? "DOWNLOAD_FAILED").slice(0, 100),
        failureReason: safeError(error),
        httpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : null,
      });
      if (!isSourceCaptureError(error)) {
        error.attempts = attempts;
        throw error;
      }
    }
  }
  if (!downloaded) {
    const error = mediaError(
      attempts.at(-1)?.failureReason ?? "No canonical artwork source was available.",
      attempts.at(-1)?.failureCode ?? "SOURCE_UNAVAILABLE",
    );
    error.attempts = attempts;
    throw error;
  }
  const key = `snapshots/${snapshotId}/holdings/drop-artwork/sha256/${downloaded.sha256.slice(
    0,
    2,
  )}/${downloaded.sha256}.${downloaded.extension}`;
  const expected = {
    key,
    byteLength: downloaded.byteLength,
    sha256: downloaded.sha256,
    contentType: downloaded.contentType,
    mode: "upload",
  };
  try {
    const existing = await headBeforeUpload(uploader, expected);
    const result =
      existing ??
      (await uploadDownloadedObject({
        expected,
        path: downloaded.path,
        bytes:
          downloaded.byteLength <= maximumBytes
            ? await readVerifiedBytes(downloaded.path, downloaded)
            : null,
        maximumBytes,
        uploader,
        multipartUploader,
      }));
    const proof = await verifyUploadedObject(uploader, expected);
    return {
      kind: "capture",
      version: FORMAT_VERSION,
      dropId: row.dropId,
      sourceUrl: downloaded.requestedSourceUrl,
      resolvedSourceUrl: downloaded.resolvedSourceUrl,
      status: "stored",
      objectKey: key,
      sha256: downloaded.sha256,
      byteLength: downloaded.byteLength,
      contentType: downloaded.contentType,
      disposition: existing ? "reused" : result.disposition,
      etag: proof.etag,
      archivedAt: new Date().toISOString(),
      sourceEtag: downloaded.sourceEtag,
      sourceLastModified: downloaded.sourceLastModified,
    };
  } finally {
    await rm(downloaded.path, { force: true });
  }
}

async function uploadDownloadedObject({
  expected,
  path,
  bytes,
  maximumBytes,
  uploader,
  multipartUploader,
  uploadSingle = uploadWithTransientRetries,
}) {
  if (expected.byteLength > maximumBytes) {
    return multipartUploader.uploadFile(expected, path);
  }
  try {
    return await uploadSingle(uploader, { ...expected, bytes });
  } catch (error) {
    if (!isTransientBridgeStatus(error?.httpStatus)) throw error;
    return multipartUploader.uploadFile(expected, path);
  }
}

async function headBeforeUpload(uploader, expected) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      return await uploader.head(expected);
    } catch (error) {
      // Workers may omit custom response headers from a bodyless HEAD 404.
      // This exception is safe only before an immutable conditional PUT: the
      // PUT and required post-write HEAD remain strict and cannot be bypassed.
      if (error?.httpStatus === 404) return null;
      if (!isTransientBridgeStatus(error?.httpStatus) || attempt === 6) throw error;
      await delay(500 * attempt);
    }
  }
}

async function uploadWithTransientRetries(uploader, object) {
  let latestError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return await uploader.upload(object);
    } catch (error) {
      latestError = error;
      if (!isTransientBridgeStatus(error?.httpStatus) || attempt === 8) break;
      await delay(500 * attempt);
    }
  }
  throw latestError;
}

async function verifyUploadedObject(uploader, expected) {
  let latestError;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const proof = await uploader.head(expected);
      if (proof) return proof;
      latestError = mediaError("Uploaded R2 object was not readable.", "REMOTE_VERIFY_FAILED");
    } catch (error) {
      latestError = error;
      if (!isTransientBridgeStatus(error?.httpStatus)) throw error;
    }
    await delay(500 * attempt);
  }
  throw latestError;
}

function isTransientBridgeStatus(status) {
  return status === 401 || status === 404 || status === 429 || (status >= 500 && status <= 504);
}

async function downloadOriginal({ artworkRoot, dropId, sourceUrl, maximumBytes, fetchImpl }) {
  const source = parseSourceUrl(sourceUrl);
  let latestError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await downloadAttempt({
        artworkRoot,
        dropId,
        source,
        maximumBytes,
        fetchImpl,
      });
    } catch (error) {
      latestError = error;
      if (!isRetryableDownload(error) || attempt === 4) break;
      await delay(250 * 2 ** (attempt - 1));
    }
  }
  const wrapped = mediaError(safeError(latestError), latestError?.code ?? "DOWNLOAD_FAILED");
  if (Number.isSafeInteger(latestError?.httpStatus)) {
    wrapped.httpStatus = latestError.httpStatus;
  }
  throw wrapped;
}

async function downloadAttempt({ artworkRoot, dropId, source, maximumBytes, fetchImpl }) {
  let current = source;
  let response;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    response = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "image/*",
        "User-Agent": "POAPin-Holdings-Archive/0.1 (+https://poap.in)",
      },
      signal: AbortSignal.timeout(120_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw mediaError("Redirect omitted Location.", "INVALID_REDIRECT");
    current = parseSourceUrl(new URL(location, current).toString());
    if (redirect === 5) throw mediaError("Source exceeded redirect limit.", "TOO_MANY_REDIRECTS");
  }
  if (!response.ok || !response.body) {
    const error = mediaError(`Source returned HTTP ${response.status}.`, "SOURCE_HTTP_ERROR");
    error.httpStatus = response.status;
    throw error;
  }
  const advertised = parseContentLength(response.headers.get("content-length"));
  if (advertised !== null && advertised > maximumBytes) {
    throw mediaError("Source object exceeds the configured byte limit.", "SOURCE_TOO_LARGE");
  }

  const temporary = resolve(
    artworkRoot,
    `tmp/${dropId}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.part`,
  );
  await mkdir(dirname(temporary), { recursive: true });
  const handle = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  let byteLength = 0;
  let prefix = Buffer.alloc(0);
  try {
    for await (const chunk of response.body) {
      byteLength += chunk.byteLength;
      if (byteLength > maximumBytes) {
        throw mediaError("Source object exceeded the configured byte limit.", "SOURCE_TOO_LARGE");
      }
      if (prefix.byteLength < 512) {
        prefix = Buffer.concat([prefix, Buffer.from(chunk)]).subarray(0, 512);
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  if (byteLength === 0) {
    await rm(temporary, { force: true });
    throw mediaError("Source returned an empty object.", "EMPTY_SOURCE");
  }
  const detected = detectOriginalMedia(prefix);
  if (!detected) {
    await rm(temporary, { force: true });
    throw mediaError("Source bytes are not a supported image.", "UNSUPPORTED_MEDIA");
  }
  return {
    path: temporary,
    requestedSourceUrl: source.toString(),
    resolvedSourceUrl: current.toString(),
    sha256: hash.digest("hex"),
    byteLength,
    contentType: detected.contentType,
    extension: detected.extension,
    sourceEtag: response.headers.get("etag"),
    sourceLastModified: response.headers.get("last-modified"),
  };
}

function detectOriginalMedia(prefix) {
  const detected = mediaInternals.detectImage(prefix) ?? detectMediaType(prefix, "image/heic");
  return detected && MEDIA_TYPE_BY_EXTENSION.has(detected.extension) ? detected : null;
}

async function readVerifiedBytes(path, expected) {
  const bytes = await readFile(path);
  if (
    bytes.byteLength !== expected.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  ) {
    throw mediaError("Temporary source bytes changed before upload.", "LOCAL_OBJECT_TAMPERED");
  }
  return bytes;
}

async function loadCollectionsArtworkProof(root) {
  const referencesPath = resolve(root, "drop-supplement/artwork/references.ndjson");
  const checkpointPath = resolve(root, "media/publish-checkpoint.ndjson");
  const reportPath = resolve(root, "media/publish-verify-report.json");
  const [report, referencesMeta, checkpointMeta, reportMeta] = await Promise.all([
    readJson(reportPath),
    sha256File(referencesPath),
    sha256File(checkpointPath),
    sha256File(reportPath),
  ]);
  if (report.publishable !== true || report.counts?.failed !== 0) {
    throw new Error("Collections media verification report is not publishable.");
  }
  const proofs = new Map();
  let header = null;
  for await (const row of readNdjson(checkpointPath)) {
    if (!header) {
      header = row;
      continue;
    }
    if (row.kind !== "object" || proofs.has(row.key)) {
      throw new Error("Collections publication checkpoint is invalid.");
    }
    proofs.set(row.key, row);
  }
  if (!header || proofs.size !== report.counts.checkpointVerified) {
    throw new Error("Collections publication checkpoint count differs from its verification.");
  }

  const objects = new Map();
  for await (const row of readNdjson(referencesPath)) {
    if (row.status !== "stored" || row.eligibleForPublish !== true) continue;
    const extension = String(row.extension ?? "");
    const contentType = MEDIA_TYPE_BY_EXTENSION.get(extension);
    if (!SHA256_PATTERN.test(row.sha256 ?? "") || contentType !== row.contentType) {
      throw new Error("Collections Drop artwork reference is invalid.");
    }
    const objectKey = `snapshots/${header.snapshotId}/collections/drop-artwork/sha256/${row.sha256.slice(
      0,
      2,
    )}/${row.sha256}.${extension}`;
    const proof = proofs.get(objectKey);
    if (
      !proof ||
      proof.sha256 !== row.sha256 ||
      proof.byteLength !== row.byteLength ||
      proof.contentType !== row.contentType
    ) {
      throw new Error(`Collections R2 proof is missing for Drop ${row.dropId}.`);
    }
    objects.set(row.dropId, {
      objectKey,
      sha256: row.sha256,
      byteLength: row.byteLength,
      contentType: row.contentType,
      etag: proof.etag,
      archivedAt: proof.completedAt,
      proof: "collections-publish-verify",
    });
  }
  return {
    snapshotId: header.snapshotId,
    objects,
    artifacts: {
      references: { path: referencesPath, ...referencesMeta },
      checkpoint: { path: checkpointPath, ...checkpointMeta },
      report: { path: reportPath, ...reportMeta },
    },
  };
}

async function loadSeedReleases(rootLike, snapshotId) {
  const root = rootLike instanceof URL ? rootLike : resolve(rootLike);
  const names = (await readdir(root)).filter((name) => name.endsWith(".json")).sort();
  const objects = new Map();
  const artifacts = [];
  for (const name of names) {
    const path = root instanceof URL ? new URL(name, root) : resolve(root, name);
    const release = await readJson(path);
    if (
      release.schemaVersion !== "poapin-holdings-artwork-release-v1" ||
      release.snapshotId !== snapshotId
    ) {
      continue;
    }
    for (const object of release.objects ?? []) {
      if (objects.has(object.dropId)) throw new Error("Seed release Drop IDs overlap.");
      objects.set(object.dropId, {
        ...object,
        archivedAt: object.archivedAt ?? release.archivedAt,
        releaseId: release.releaseId,
      });
    }
    artifacts.push({
      path: String(path),
      ...(await sha256File(path)),
      releaseId: release.releaseId,
    });
  }
  return { objects, artifacts };
}

async function loadBoundSeedArchiveTimes(artifacts, snapshotId) {
  const archivedAt = new Map();
  for (const artifact of artifacts ?? []) {
    const path =
      typeof artifact.path === "string" && artifact.path.startsWith("file:")
        ? new URL(artifact.path)
        : resolve(artifact.path ?? "");
    const [release, observed] = await Promise.all([readJson(path), sha256File(path)]);
    if (
      release.schemaVersion !== "poapin-holdings-artwork-release-v1" ||
      release.snapshotId !== snapshotId ||
      release.releaseId !== artifact.releaseId ||
      release.releaseId === undefined ||
      observed.sha256 !== artifact.sha256 ||
      observed.byteLength !== artifact.byteLength ||
      !Number.isFinite(Date.parse(release.archivedAt ?? "")) ||
      archivedAt.has(release.releaseId)
    ) {
      throw new Error("Seed artwork release changed after the Holdings artwork plan.");
    }
    archivedAt.set(release.releaseId, release.archivedAt);
  }
  return archivedAt;
}

function readHoldingDropSources(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT drop_id, image_url
         FROM compass_drop_metadata
         ORDER BY drop_id`,
      )
      .all();
    return rows.map((row) => ({
      dropId: numberValue(row.drop_id, "Drop ID"),
      sourceUrl: parseSourceUrl(row.image_url).toString(),
    }));
  } finally {
    db.close();
  }
}

async function attachOfficialSourceCandidates(artworkRoot, planReport, rows) {
  if (rows.length === 0) return rows;
  const binding = planReport.inputs?.referencedDropsDatabase;
  if (
    typeof binding?.path !== "string" ||
    !SHA256_PATTERN.test(binding.sha256 ?? "") ||
    !Number.isSafeInteger(binding.byteLength)
  ) {
    throw new Error("Referenced Drop database binding is invalid.");
  }
  const sourceDatabase = resolve(artworkRoot, "..", binding.path);
  const proof = await regularFile(sourceDatabase, "referenced Drop database");
  if (proof.sha256 !== binding.sha256 || proof.byteLength !== binding.byteLength) {
    throw new Error("Referenced Drop database differs from the artwork plan binding.");
  }

  const database = new DatabaseSync(sourceDatabase, { readOnly: true });
  try {
    const statement = database.prepare(
      `SELECT raw_json
       FROM compass_drop_metadata
       WHERE drop_id = ?1
       LIMIT 1`,
    );
    return rows.map((row) => {
      const rawJson = statement.get(row.dropId)?.raw_json;
      const sourceCandidates = officialSourceCandidates(rawJson, row.sourceUrl);
      return { ...row, sourceCandidates };
    });
  } finally {
    database.close();
  }
}

function officialSourceCandidates(rawJson, sourceUrl) {
  const candidates = [];
  if (typeof rawJson === "string") {
    let raw;
    try {
      raw = JSON.parse(rawJson);
    } catch {
      raw = null;
    }
    for (const gateway of raw?.drop_image?.gateways ?? []) {
      if (gateway?.type === "ORIGINAL") {
        candidates.push(gateway.url, legacyPoapMediaUrl(gateway.url));
      }
    }
  }
  candidates.push(legacyPoapMediaUrl(sourceUrl), sourceUrl);
  const canonical = [];
  for (const candidate of candidates) {
    try {
      const source = parseSourceUrl(candidate).toString();
      if (!canonical.includes(source)) canonical.push(source);
    } catch {
      // The snapshot preserves non-canonical URLs as evidence, but this
      // privileged capture path intentionally never fetches them.
    }
  }
  return canonical;
}

function validateTerminalUnavailableRecord(planRow, record) {
  if (
    record?.status !== "failed" ||
    !Array.isArray(record.attempts) ||
    record.attempts.length !== planRow.sourceCandidates.length ||
    record.attempts.some(
      (attempt, index) =>
        attempt.sourceUrl !== planRow.sourceCandidates[index] || !isTerminalSourceAttempt(attempt),
    )
  ) {
    throw new Error(
      `Drop ${planRow.dropId} has not exhausted every approved source with terminal evidence.`,
    );
  }
}

function isTerminalSourceAttempt(attempt) {
  if (["EMPTY_SOURCE", "UNSUPPORTED_MEDIA"].includes(attempt?.failureCode)) return true;
  return (
    attempt?.failureCode === "SOURCE_HTTP_ERROR" &&
    [401, 403, 404, 410].includes(attempt.httpStatus)
  );
}

function validateUnavailableReport(
  report,
  planReport,
  captureReport,
  checkpointArtifact,
  captureReportArtifact,
  plan,
  checkpoint,
) {
  if (captureReport.complete === true) return new Map();
  if (
    report?.schemaVersion !== "poapin-holdings-artwork-unavailable-v1" ||
    report.snapshotId !== planReport.snapshotId ||
    report.plan?.sha256 !== planReport.plan.sha256 ||
    report.checkpoint?.sha256 !== checkpointArtifact.sha256 ||
    report.checkpoint?.byteLength !== checkpointArtifact.byteLength ||
    report.captureReport?.sha256 !== captureReportArtifact.sha256 ||
    report.captureReport?.byteLength !== captureReportArtifact.byteLength ||
    report.count !== report.rows?.length
  ) {
    throw new Error("Terminal-unavailable artwork report is not bound to this capture.");
  }
  const unavailable = new Map();
  const capturePlanIds = new Set(
    plan.filter((row) => row.action === "capture").map((row) => row.dropId),
  );
  for (const row of report.rows) {
    const record = checkpoint.records.get(row?.dropId);
    if (
      !Number.isSafeInteger(row?.dropId) ||
      !capturePlanIds.has(row.dropId) ||
      unavailable.has(row.dropId) ||
      !Array.isArray(row.sourceCandidates) ||
      !Array.isArray(row.attempts) ||
      row.sourceCandidates.length !== row.attempts.length ||
      record?.status !== "failed" ||
      JSON.stringify(row.attempts) !== JSON.stringify(record.attempts) ||
      row.failureCode !== record.failureCode ||
      row.failureReason !== record.failureReason ||
      row.completedAt !== record.completedAt
    ) {
      throw new Error("Terminal-unavailable artwork rows are invalid.");
    }
    validateTerminalUnavailableRecord(row, {
      status: "failed",
      attempts: row.attempts,
    });
    unavailable.set(row.dropId, row);
  }
  if (
    captureReport.counts?.failed !== unavailable.size ||
    captureReport.counts?.pending !== unavailable.size
  ) {
    throw new Error("Terminal-unavailable count differs from the capture report.");
  }
  return unavailable;
}

function legacyPoapMediaUrl(sourceUrl) {
  let source;
  try {
    source = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (
    source.protocol !== "https:" ||
    source.hostname !== "assets.poap.xyz" ||
    source.username ||
    source.password ||
    source.search ||
    source.hash
  ) {
    return null;
  }
  return `https://storage.googleapis.com/poapmedia${source.pathname}`;
}

async function readBoundPlan(artworkRoot) {
  const report = await readJson(resolve(artworkRoot, "plan-report.json"));
  const source = await readFile(resolve(artworkRoot, report.plan.path), "utf8");
  if (
    report.schemaVersion !== "poapin-holdings-artwork-plan-v1" ||
    sha256(source) !== report.plan.sha256 ||
    Buffer.byteLength(source) !== report.plan.byteLength
  ) {
    throw new Error("Holdings artwork plan does not match its report.");
  }
  const plan = source
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (plan.length !== report.plan.rows) throw new Error("Holdings artwork plan row count changed.");
  return { plan, report, source };
}

async function readCaptureCheckpoint(path, expected) {
  if (!(await exists(path))) return { header: null, records: new Map() };
  let header = null;
  const records = new Map();
  for await (const row of readNdjson(path)) {
    if (!header) {
      header = row;
      if (
        row.kind !== "header" ||
        row.version !== FORMAT_VERSION ||
        row.dataset !== "poapin-holdings-original-artwork"
      ) {
        throw new Error("Holdings artwork checkpoint header is invalid.");
      }
      for (const [key, value] of Object.entries(expected)) {
        if (row[key] !== value) throw new Error(`Holdings checkpoint ${key} does not match.`);
      }
      continue;
    }
    if (
      row.kind !== "capture" ||
      row.version !== FORMAT_VERSION ||
      !Number.isSafeInteger(row.dropId)
    ) {
      throw new Error("Holdings artwork checkpoint row is invalid.");
    }
    records.set(row.dropId, row);
  }
  return { header, records };
}

class SerializedWriter {
  constructor(path) {
    this.path = path;
    this.chain = Promise.resolve();
  }

  async record(value) {
    this.chain = this.chain.then(() => appendJsonLine(this.path, value));
    await this.chain;
  }

  async close() {
    await this.chain;
  }
}

async function defaultD1Query({ database, config, cwd, sql }) {
  const { stdout } = await execFile(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      database,
      "--remote",
      "--json",
      "--config",
      config,
      "--command",
      sql,
    ],
    { cwd, maxBuffer: 16 * 1024 * 1024 },
  );
  const payload = JSON.parse(stdout.slice(stdout.indexOf("[")));
  if (!Array.isArray(payload) || payload.some((part) => part.success !== true)) {
    throw new Error("Wrangler D1 query did not succeed.");
  }
  return payload.flatMap((part) => part.results ?? []);
}

async function defaultD1File({ database, config, cwd, path }) {
  const { stdout } = await execFile(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      database,
      "--remote",
      "--json",
      "--config",
      config,
      "--file",
      path,
    ],
    { cwd, maxBuffer: 16 * 1024 * 1024 },
  );
  const start = stdout.indexOf("[");
  const payload = JSON.parse(stdout.slice(start));
  if (!Array.isArray(payload) || payload.some((part) => part.success !== true)) {
    throw new Error(`Wrangler did not import artwork shard ${basename(path)}.`);
  }
  return payload;
}

async function runPool(values, concurrency, task) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await task(values[index]);
    }
  });
  await Promise.all(workers);
}

async function verifyBridgeTarget(uploader) {
  let latestError;
  let consecutiveSuccesses = 0;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      await uploader.verifyTarget();
      consecutiveSuccesses += 1;
      if (consecutiveSuccesses === 5) return;
    } catch (error) {
      latestError = error;
      consecutiveSuccesses = 0;
      if (![401, 404, 503].includes(error?.httpStatus) || attempt === 60) break;
    }
    await delay(1_000);
  }
  throw latestError;
}

async function* readNdjson(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    yield JSON.parse(line);
  }
}

async function writeImmutableJson(path, value, ignoredKeys = []) {
  if (await exists(path)) {
    const existing = await readJson(path);
    const clean = (input) =>
      Object.fromEntries(Object.entries(input).filter(([key]) => !ignoredKeys.includes(key)));
    if (JSON.stringify(clean(existing)) !== JSON.stringify(clean(value))) {
      throw new Error(`Existing ${basename(path)} differs from the requested immutable value.`);
    }
    return;
  }
  await writeJsonAtomic(path, value);
}

async function writeImmutableText(path, source) {
  await mkdir(dirname(path), { recursive: true });
  if (await exists(path)) {
    if ((await readFile(path, "utf8")) !== source) {
      throw new Error(`Existing ${basename(path)} differs from the requested immutable plan.`);
    }
    return;
  }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.write(source);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function artifact(root, path, extra = {}) {
  return {
    path: extra.external
      ? resolve(path)
      : relative(resolve(root), resolve(path)).replaceAll("\\", "/"),
    ...(await sha256File(path)),
    ...extra,
  };
}

async function regularFile(path, label) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error(`${label} is not a regular file.`);
  return sha256File(path);
}

function canonicalNdjson(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function validateReleaseObject(object, planReport) {
  if (
    !Number.isSafeInteger(object.dropId) ||
    object.dropId <= 0 ||
    !SHA256_PATTERN.test(object.sha256 ?? "") ||
    !Number.isSafeInteger(object.byteLength) ||
    object.byteLength <= 0 ||
    ![...MEDIA_TYPE_BY_EXTENSION.values()].includes(object.contentType) ||
    !Number.isFinite(Date.parse(object.archivedAt ?? ""))
  ) {
    throw new Error(`Artwork release object for Drop ${object.dropId} is invalid.`);
  }
  parseSourceUrl(object.sourceUrl);
  const extension = [...MEDIA_TYPE_BY_EXTENSION].find(
    ([, contentType]) => contentType === object.contentType,
  )?.[0];
  const holdingsKey = `snapshots/${planReport.snapshotId}/holdings/drop-artwork/sha256/${object.sha256.slice(
    0,
    2,
  )}/${object.sha256}.${extension}`;
  const collectionsKey = `snapshots/${planReport.collectionsSnapshotId}/collections/drop-artwork/sha256/${object.sha256.slice(
    0,
    2,
  )}/${object.sha256}.${extension}`;
  if (![holdingsKey, collectionsKey].includes(object.objectKey)) {
    throw new Error(`Artwork release key for Drop ${object.dropId} is outside active snapshots.`);
  }
}

function artworkInsertSql(rows) {
  const values = rows
    .map(
      (row) =>
        `(${row.dropId}, ${sqlText(row.objectKey)}, ${sqlText(row.sha256)}, ${row.byteLength}, ${sqlText(row.contentType)}, ${sqlText(row.sourceUrl)}, ${sqlText(row.archivedAt)})`,
    )
    .join(",\n  ");
  return `INSERT OR IGNORE INTO holding_drop_artwork (
  drop_id, object_key, sha256, byte_length, content_type, source_url, archived_at
) VALUES
  ${values};`;
}

function sqlText(value) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Artwork D1 text value is invalid.");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function parseSourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw mediaError("Artwork source URL is invalid.", "INVALID_SOURCE_URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw mediaError(
      "Artwork source URL is not the canonical POAP asset host.",
      "SOURCE_NOT_ALLOWED",
    );
  }
  const canonicalAsset = url.hostname === "assets.poap.xyz";
  const legacyPoapMedia =
    url.hostname === "storage.googleapis.com" && url.pathname.startsWith("/poapmedia/");
  if (!canonicalAsset && !legacyPoapMedia) {
    throw mediaError(
      "Artwork source URL is not an approved POAP asset origin.",
      "SOURCE_NOT_ALLOWED",
    );
  }
  return url;
}

async function validateSourceHosts(lookup) {
  for (const host of SOURCE_HOSTS) {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (
      !Array.isArray(addresses) ||
      addresses.length === 0 ||
      addresses.some((entry) => mediaInternals.isPrivateAddress(entry.address))
    ) {
      throw mediaError(
        "A POAP asset host resolved to a private or invalid address.",
        "PRIVATE_TARGET",
      );
    }
  }
}

function parseHttpsOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Bridge URL must be a valid HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Bridge URL must be an HTTPS origin without a path.");
  }
  return url.origin;
}

function validateSecret(value) {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(value ?? "") ||
    Buffer.from(value, "base64url").byteLength !== 32
  ) {
    throw new Error("COLLECTIONS_R2_BRIDGE_SECRET must encode exactly 32 bytes.");
  }
  return value;
}

function validateConcurrency(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16) {
    throw new Error("Artwork concurrency must be an integer from 1 to 16.");
  }
}

function numberValue(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} is invalid.`);
  return number;
}

function parseContentLength(value) {
  if (!value || !/^[0-9]+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function isRetryableDownload(error) {
  const status = error?.httpStatus;
  return (
    error?.name === "TimeoutError" ||
    error?.name === "TypeError" ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function isSourceCaptureError(error) {
  return (
    String(error?.code ?? "").startsWith("SOURCE_") ||
    [
      "EMPTY_SOURCE",
      "INVALID_REDIRECT",
      "INVALID_SOURCE_URL",
      "TOO_MANY_REDIRECTS",
      "UNSUPPORTED_MEDIA",
    ].includes(error?.code)
  );
}

function mediaError(message, code) {
  return Object.assign(new Error(message), { code });
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error ?? "Unknown failure")).slice(
    0,
    600,
  );
}

export const holdingsArtworkInternals = {
  attachOfficialSourceCandidates,
  detectOriginalMedia,
  loadCollectionsArtworkProof,
  officialSourceCandidates,
  parseSourceUrl,
  readCaptureCheckpoint,
  readHoldingDropSources,
  uploadDownloadedObject,
};
