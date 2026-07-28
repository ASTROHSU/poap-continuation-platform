import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  COLLECTIONS_BRIDGE_AUTH_SCHEME,
  COLLECTIONS_BRIDGE_OBJECT_PATH,
  createCollectionsBridgeSignaturePayload,
} from "../../collections-backup/bridge/protocol.mjs";
import {
  buildHoldingsArtworkPlan,
  finalizeHoldingsArtwork,
  holdingsArtworkInternals,
  reviewUnavailableHoldingsArtwork,
} from "../artwork.mjs";
import { HoldingsMultipartUploader } from "../artwork-bridge/client.mjs";
import { handleHoldingsArtworkBridgeRequest } from "../artwork-bridge/worker.mjs";

const HOLDINGS_SNAPSHOT = "compass-holdings-2026-07-28-v1";
const ARCHIVE_SNAPSHOT = "2026-07-02-v1";
const COLLECTIONS_SNAPSHOT = "collections-2026-07-22-v1";
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const SECRET = Buffer.alloc(32, 7).toString("base64url");

test("full plan partitions Archive, Collections, seed, and source captures exactly once", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-holdings-artwork-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = resolve(root, "snapshot");
  const collections = resolve(root, "collections");
  const releases = resolve(root, "releases");
  await Promise.all([
    mkdir(snapshot, { recursive: true }),
    mkdir(resolve(collections, "drop-supplement/artwork"), { recursive: true }),
    mkdir(resolve(collections, "media"), { recursive: true }),
    mkdir(releases, { recursive: true }),
  ]);

  const databasePath = resolve(snapshot, "compass-referenced-drops.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE compass_drop_metadata (
      drop_id INTEGER PRIMARY KEY,
      image_url TEXT
    ) WITHOUT ROWID;
    INSERT INTO compass_drop_metadata VALUES
      (1, 'https://assets.poap.xyz/1.png'),
      (2, 'https://assets.poap.xyz/2.png'),
      (3, 'https://assets.poap.xyz/3.png'),
      (4, 'https://assets.poap.xyz/4.png');
  `);
  database.close();
  await writeJson(resolve(snapshot, "referenced-drops-manifest.json"), {
    snapshotId: HOLDINGS_SNAPSHOT,
    counts: { requested: 4, captured: 4, missing: 0 },
  });
  await writeJson(resolve(snapshot, "archive-index.json"), {
    schemaVersion: "poapin-archive-artwork-index-v1",
    snapshotId: ARCHIVE_SNAPSHOT,
    count: 1,
    artworkIds: [1],
  });

  const collectionSha = createHash("sha256").update("collection").digest("hex");
  const collectionKey = `snapshots/${COLLECTIONS_SNAPSHOT}/collections/drop-artwork/sha256/${collectionSha.slice(0, 2)}/${collectionSha}.png`;
  await writeFile(
    resolve(collections, "drop-supplement/artwork/references.ndjson"),
    `${JSON.stringify({
      kind: "reference",
      version: 1,
      dropId: 2,
      status: "stored",
      eligibleForPublish: true,
      sha256: collectionSha,
      byteLength: 10,
      contentType: "image/png",
      extension: "png",
    })}\n`,
  );
  await writeFile(
    resolve(collections, "media/publish-checkpoint.ndjson"),
    `${JSON.stringify({ kind: "header", snapshotId: COLLECTIONS_SNAPSHOT })}\n${JSON.stringify({
      kind: "object",
      key: collectionKey,
      sha256: collectionSha,
      byteLength: 10,
      contentType: "image/png",
      etag: "collection-etag",
      completedAt: "2026-07-22T00:00:00.000Z",
    })}\n`,
  );
  await writeJson(resolve(collections, "media/publish-verify-report.json"), {
    publishable: true,
    counts: { failed: 0, checkpointVerified: 1 },
  });

  const seedSha = createHash("sha256").update("seed").digest("hex");
  await writeJson(resolve(releases, "seed.json"), {
    schemaVersion: "poapin-holdings-artwork-release-v1",
    snapshotId: HOLDINGS_SNAPSHOT,
    releaseId: `${HOLDINGS_SNAPSHOT}-artwork-seed`,
    archivedAt: "2026-07-28T00:00:00.000Z",
    objects: [
      {
        dropId: 3,
        objectKey: `snapshots/${HOLDINGS_SNAPSHOT}/holdings/drop-artwork/sha256/${seedSha.slice(0, 2)}/${seedSha}.png`,
        sha256: seedSha,
        byteLength: 20,
        contentType: "image/png",
        sourceUrl: "https://assets.poap.xyz/3.png",
      },
    ],
  });

  const result = await buildHoldingsArtworkPlan({
    input: snapshot,
    archiveArtworkIndex: resolve(snapshot, "archive-index.json"),
    collectionsInput: collections,
    releaseRoot: releases,
  });
  assert.deepEqual(result.report.counts, {
    archive: 1,
    collections: 1,
    seed: 1,
    capture: 1,
  });
  assert.deepEqual(
    result.plan.map(({ dropId, action }) => ({ dropId, action })),
    [
      { dropId: 2, action: "collection-reuse" },
      { dropId: 3, action: "seed" },
      { dropId: 4, action: "capture" },
    ],
  );

  // The first production plan predates per-object archivedAt hydration. Its
  // bound seed release still supplies the exact timestamp at finalization.
  const legacyPlan = result.plan.map((row) =>
    row.action === "seed"
      ? {
          ...row,
          object: Object.fromEntries(
            Object.entries(row.object).filter(([key]) => key !== "archivedAt"),
          ),
        }
      : row,
  );
  const legacyPlanSource = `${legacyPlan.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(resolve(result.artworkRoot, "plan.ndjson"), legacyPlanSource);
  const legacyPlanMeta = await fileMeta(resolve(result.artworkRoot, "plan.ndjson"));
  const legacyPlanReport = JSON.parse(
    await readFile(resolve(result.artworkRoot, "plan-report.json"), "utf8"),
  );
  legacyPlanReport.plan = { path: "plan.ndjson", ...legacyPlanMeta, rows: legacyPlan.length };
  await writeJson(resolve(result.artworkRoot, "plan-report.json"), legacyPlanReport);
  result.report.plan = legacyPlanReport.plan;

  const bridgeOrigin = "https://holdings-bridge.example.invalid";
  const cacheControl = "public, max-age=31536000, immutable";
  const maximumBytes = 99_614_720;
  const captureSha = createHash("sha256").update("capture").digest("hex");
  const captureKey = `snapshots/${HOLDINGS_SNAPSHOT}/holdings/drop-artwork/sha256/${captureSha.slice(0, 2)}/${captureSha}.png`;
  const checkpointPath = resolve(result.artworkRoot, "capture-checkpoint.ndjson");
  await writeFile(
    checkpointPath,
    `${JSON.stringify({
      kind: "header",
      version: 1,
      dataset: "poapin-holdings-original-artwork",
      snapshotId: HOLDINGS_SNAPSHOT,
      planSha256: result.report.plan.sha256,
      bridgeOrigin,
      bucket: "poapin-archive",
      cacheControl,
      maximumBytes,
    })}\n${JSON.stringify({
      kind: "capture",
      version: 1,
      dropId: 4,
      sourceUrl: "https://assets.poap.xyz/4.png",
      status: "stored",
      objectKey: captureKey,
      sha256: captureSha,
      byteLength: 30,
      contentType: "image/png",
      disposition: "uploaded",
      etag: "capture-etag",
      archivedAt: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );
  await writeJson(resolve(result.artworkRoot, "capture-report.json"), {
    schemaVersion: "poapin-holdings-artwork-capture-v1",
    snapshotId: HOLDINGS_SNAPSHOT,
    complete: true,
    counts: { completed: 1 },
    target: { bridgeOrigin, bucket: "poapin-archive", cacheControl, maximumBytes },
  });
  const finalized = await finalizeHoldingsArtwork({
    input: result.artworkRoot,
    releaseId: `${HOLDINGS_SNAPSHOT}-artwork-full`,
    shardRows: 3,
    rowsPerStatement: 1,
  });
  assert.deepEqual(finalized.release.coverage, {
    referencedDrops: 4,
    archiveDirect: 1,
    activatedRows: 3,
    collectionReuse: 1,
    seedHoldings: 1,
    capturedHoldings: 1,
    terminalUnavailable: 0,
    complete: true,
  });
  assert.equal(finalized.d1Report.expectedRows, 3);
  assert.equal(finalized.d1Report.shards.length, 1);
});

test("source policy accepts only the exact canonical POAP asset host", () => {
  assert.equal(
    holdingsArtworkInternals.parseSourceUrl("https://assets.poap.xyz/example.png").hostname,
    "assets.poap.xyz",
  );
  assert.equal(
    holdingsArtworkInternals.parseSourceUrl("https://storage.googleapis.com/poapmedia/example.png")
      .hostname,
    "storage.googleapis.com",
  );
  for (const source of [
    "http://assets.poap.xyz/example.png",
    "https://assets.poap.xyz.evil.invalid/example.png",
    "https://user@assets.poap.xyz/example.png",
    "https://assets.poap.xyz/example.png#fragment",
    "https://assets.poap.xyz/example.png?mutable=true",
    "https://storage.googleapis.com/other-bucket/example.png",
  ]) {
    assert.throws(() => holdingsArtworkInternals.parseSourceUrl(source), /source/i);
  }

  assert.deepEqual(
    holdingsArtworkInternals.officialSourceCandidates(
      JSON.stringify({
        drop_image: {
          gateways: [
            {
              type: "ORIGINAL",
              url: "https://assets.poap.xyz/original.png",
            },
            {
              type: "THUMBNAIL",
              url: "https://assets.poap.xyz/thumbnail.png",
            },
            {
              type: "ORIGINAL",
              url: "https://example.invalid/untrusted.png",
            },
          ],
        },
      }),
      "https://assets.poap.xyz/legacy.png",
    ),
    [
      "https://assets.poap.xyz/original.png",
      "https://storage.googleapis.com/poapmedia/original.png",
      "https://storage.googleapis.com/poapmedia/legacy.png",
      "https://assets.poap.xyz/legacy.png",
    ],
  );

  const heic = Buffer.concat([
    Buffer.from([0, 0, 0, 32]),
    Buffer.from("ftypheic\0\0\0\0mif1miafMiHBheic", "ascii"),
  ]);
  assert.deepEqual(holdingsArtworkInternals.detectOriginalMedia(heic), {
    contentType: "image/heic",
    extension: "heic",
  });
});

test("terminal evidence never describes an unavailable original as archived", async (t) => {
  const snapshot = await mkdtemp(resolve(tmpdir(), "poapin-holdings-unavailable-"));
  t.after(() => rm(snapshot, { recursive: true, force: true }));
  const artworkRoot = resolve(snapshot, "artwork-archive");
  await mkdir(artworkRoot, { recursive: true });
  const sourceUrl = "https://assets.poap.xyz/missing.png";
  const legacyUrl = "https://storage.googleapis.com/poapmedia/missing.png";
  const databasePath = resolve(snapshot, "compass-referenced-drops.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE compass_drop_metadata (
      drop_id INTEGER PRIMARY KEY,
      image_url TEXT NOT NULL,
      raw_json TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
  database
    .prepare("INSERT INTO compass_drop_metadata VALUES (?1, ?2, ?3)")
    .run(5, sourceUrl, JSON.stringify({ drop_image: null }));
  database.close();
  const databaseMeta = await fileMeta(databasePath);
  const planSource = `${JSON.stringify({ dropId: 5, action: "capture", sourceUrl })}\n`;
  const planPath = resolve(artworkRoot, "plan.ndjson");
  await writeFile(planPath, planSource);
  const planMeta = await fileMeta(planPath);
  await writeJson(resolve(artworkRoot, "plan-report.json"), {
    schemaVersion: "poapin-holdings-artwork-plan-v1",
    snapshotId: HOLDINGS_SNAPSHOT,
    archiveSnapshotId: ARCHIVE_SNAPSHOT,
    collectionsSnapshotId: COLLECTIONS_SNAPSHOT,
    sourceDrops: 1,
    counts: { archive: 0, collections: 0, seed: 0, capture: 1 },
    inputs: {
      referencedDropsDatabase: {
        path: "compass-referenced-drops.sqlite",
        ...databaseMeta,
      },
    },
    plan: { path: "plan.ndjson", ...planMeta, rows: 1 },
  });
  const bridgeOrigin = "https://holdings-bridge.example.invalid";
  const maximumBytes = 99_614_720;
  const checkpointPath = resolve(artworkRoot, "capture-checkpoint.ndjson");
  const attempts = [
    {
      sourceUrl: legacyUrl,
      failureCode: "SOURCE_HTTP_ERROR",
      failureReason: "Source returned HTTP 403.",
      httpStatus: 403,
    },
    {
      sourceUrl,
      failureCode: "EMPTY_SOURCE",
      failureReason: "Source returned an empty object.",
      httpStatus: null,
    },
  ];
  await writeFile(
    checkpointPath,
    `${JSON.stringify({
      kind: "header",
      version: 1,
      dataset: "poapin-holdings-original-artwork",
      snapshotId: HOLDINGS_SNAPSHOT,
      planSha256: planMeta.sha256,
      bridgeOrigin,
      bucket: "poapin-archive",
      cacheControl: CACHE_CONTROL,
      maximumBytes,
    })}\n${JSON.stringify({
      kind: "capture",
      version: 1,
      dropId: 5,
      sourceUrl,
      attempts,
      status: "failed",
      failureCode: "EMPTY_SOURCE",
      failureReason: "Source returned an empty object.",
      completedAt: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );
  const checkpointMeta = await fileMeta(checkpointPath);
  await writeJson(resolve(artworkRoot, "capture-report.json"), {
    schemaVersion: "poapin-holdings-artwork-capture-v1",
    snapshotId: HOLDINGS_SNAPSHOT,
    complete: false,
    counts: { required: 1, completed: 0, failed: 1, pending: 1 },
    checkpoint: { path: "capture-checkpoint.ndjson", ...checkpointMeta },
    plan: { path: "plan.ndjson", ...planMeta, rows: 1 },
    target: {
      bridgeOrigin,
      bucket: "poapin-archive",
      cacheControl: CACHE_CONTROL,
      maximumBytes,
    },
  });

  const reviewed = await reviewUnavailableHoldingsArtwork({ input: artworkRoot });
  assert.equal(reviewed.report.count, 1);
  const finalized = await finalizeHoldingsArtwork({
    input: artworkRoot,
    releaseId: `${HOLDINGS_SNAPSHOT}-artwork-terminal-test`,
  });
  assert.equal(finalized.release.objects.length, 0);
  assert.equal(finalized.release.coverage.capturedHoldings, 0);
  assert.equal(finalized.release.coverage.terminalUnavailable, 1);
  assert.equal(finalized.release.coverage.complete, true);
});

test("temporary bridge writes only the signed active Holdings namespace", async () => {
  const bytes = Buffer.from("fixture");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const validKey = `snapshots/${HOLDINGS_SNAPSHOT}/holdings/drop-artwork/sha256/${digest.slice(0, 2)}/${digest}.png`;
  const bucket = new MemoryBucket();
  const env = {
    ARTWORK_BUCKET: bucket,
    BUCKET_NAME: "poapin-archive",
    SNAPSHOT_ID: HOLDINGS_SNAPSHOT,
    ARCHIVE_SNAPSHOT_ID: ARCHIVE_SNAPSHOT,
    OBJECT_PREFIX: "snapshots/",
    CACHE_CONTROL,
    MAX_OBJECT_BYTES: "100000000",
    MAX_MULTIPART_OBJECT_BYTES: "5000000000",
    MAX_MULTIPART_PART_BYTES: "16777216",
    COLLECTIONS_R2_BRIDGE_SECRET: SECRET,
  };
  const upload = signedRequest({
    method: "PUT",
    key: validKey,
    digest,
    byteLength: bytes.byteLength,
    contentType: "image/png",
    bytes,
  });
  const response = await handleHoldingsArtworkBridgeRequest(upload, env, () => 1_800_000_000_000);
  assert.equal(response.status, 201);
  assert.equal(bucket.puts, 1);

  const rejected = signedRequest({
    method: "PUT",
    key: `snapshots/${COLLECTIONS_SNAPSHOT}/collections/drop-artwork/sha256/${digest.slice(0, 2)}/${digest}.png`,
    digest,
    byteLength: bytes.byteLength,
    contentType: "image/png",
    bytes,
  });
  assert.equal(
    (await handleHoldingsArtworkBridgeRequest(rejected, env, () => 1_800_000_000_000)).status,
    400,
  );
  assert.equal(bucket.puts, 1);
});

test("oversized originals use authenticated bounded multipart parts", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-holdings-multipart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(6_000_000, 23);
  const path = resolve(root, "oversized.gif");
  await writeFile(path, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const key = `snapshots/${HOLDINGS_SNAPSHOT}/holdings/drop-artwork/sha256/${digest.slice(0, 2)}/${digest}.gif`;
  const bucket = new MemoryBucket();
  const env = {
    ARTWORK_BUCKET: bucket,
    BUCKET_NAME: "poapin-archive",
    SNAPSHOT_ID: HOLDINGS_SNAPSHOT,
    ARCHIVE_SNAPSHOT_ID: ARCHIVE_SNAPSHOT,
    OBJECT_PREFIX: "snapshots/",
    CACHE_CONTROL,
    MAX_OBJECT_BYTES: "5242880",
    MAX_MULTIPART_OBJECT_BYTES: "5000000000",
    MAX_MULTIPART_PART_BYTES: "5242880",
    COLLECTIONS_R2_BRIDGE_SECRET: SECRET,
  };
  const uploader = new HoldingsMultipartUploader({
    endpoint: "https://bridge.invalid",
    bucket: "poapin-archive",
    snapshotId: HOLDINGS_SNAPSHOT,
    maximumObjectBytes: 5_000_000_000,
    partBytes: 5_242_880,
    secret: Buffer.from(SECRET, "base64url"),
    fetchImpl: (url, init) =>
      handleHoldingsArtworkBridgeRequest(new Request(url, init), env, () => 1_800_000_000_000),
    now: () => 1_800_000_000_000,
  });
  const result = await uploader.uploadFile(
    {
      key,
      byteLength: bytes.byteLength,
      sha256: digest,
      contentType: "image/gif",
    },
    path,
  );
  assert.equal(result.disposition, "uploaded");
  assert.equal(bucket.multipartParts, 2);
  assert.equal(bucket.objects.get(key)?.size, bytes.byteLength);
  assert.equal(bucket.objects.get(key)?.customMetadata?.sha256, digest);
});

test("transient single-request R2 failures fall back to multipart", async () => {
  const expected = {
    key: `snapshots/${HOLDINGS_SNAPSHOT}/holdings/drop-artwork/sha256/${"a".repeat(2)}/${"a".repeat(64)}.png`,
    byteLength: 2_214_272,
    sha256: "a".repeat(64),
    contentType: "image/png",
    mode: "upload",
  };
  let multipartCalls = 0;
  const result = await holdingsArtworkInternals.uploadDownloadedObject({
    expected,
    path: "/tmp/unused-by-mock.png",
    bytes: Buffer.alloc(1),
    maximumBytes: 99_614_720,
    uploader: {},
    multipartUploader: {
      async uploadFile(object, path) {
        multipartCalls += 1;
        assert.equal(object, expected);
        assert.equal(path, "/tmp/unused-by-mock.png");
        return { disposition: "uploaded" };
      },
    },
    async uploadSingle() {
      throw Object.assign(new Error("R2 PUT remained unavailable."), { httpStatus: 503 });
    },
  });
  assert.equal(result.disposition, "uploaded");
  assert.equal(multipartCalls, 1);
});

function signedRequest({ method, key, digest, byteLength, contentType, bytes }) {
  const timestamp = 1_800_000_000;
  const payload = createCollectionsBridgeSignaturePayload({
    method,
    path: COLLECTIONS_BRIDGE_OBJECT_PATH,
    bucket: "poapin-archive",
    snapshotId: HOLDINGS_SNAPSHOT,
    objectPrefix: "snapshots/",
    mode: "upload",
    key,
    byteLength,
    sha256: digest,
    contentType,
    timestamp,
  });
  const signature = createHmac("sha256", Buffer.from(SECRET, "base64url"))
    .update(payload)
    .digest("base64url");
  return new Request(`https://bridge.invalid${COLLECTIONS_BRIDGE_OBJECT_PATH}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `${COLLECTIONS_BRIDGE_AUTH_SCHEME} ${signature}`,
      "Content-Length": String(byteLength),
      "Content-Type": contentType,
      "X-POAPin-Bucket": "poapin-archive",
      "X-POAPin-Snapshot": HOLDINGS_SNAPSHOT,
      "X-POAPin-Object-Prefix": "snapshots/",
      "X-POAPin-Object-Mode": "upload",
      "X-POAPin-Object-Key": key,
      "X-POAPin-Object-Byte-Length": String(byteLength),
      "X-POAPin-SHA256": digest,
      "X-POAPin-Content-Type": contentType,
      "X-POAPin-Timestamp": String(timestamp),
    },
    body: bytes,
  });
}

class MemoryBucket {
  constructor() {
    this.objects = new Map();
    this.uploads = new Map();
    this.puts = 0;
    this.multipartParts = 0;
  }

  async head(key) {
    return this.objects.get(key) ?? null;
  }

  async put(key, body, options) {
    this.puts += 1;
    const bytes = Buffer.from(await new Response(body).arrayBuffer());
    const object = {
      key,
      size: bytes.byteLength,
      etag: createHash("md5").update(bytes).digest("hex"),
      checksums: { toJSON: () => ({ sha256: options.sha256 }) },
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, object);
    return object;
  }

  async createMultipartUpload(key, options) {
    const uploadId = `upload-${this.uploads.size + 1}`;
    this.uploads.set(uploadId, { key, options, parts: new Map() });
    return { key, uploadId };
  }

  resumeMultipartUpload(key, uploadId) {
    const bucket = this;
    return {
      async uploadPart(partNumber, bytes) {
        const upload = bucket.uploads.get(uploadId);
        if (!upload || upload.key !== key) throw new Error("No such upload.");
        const body = Buffer.from(bytes);
        upload.parts.set(partNumber, body);
        bucket.multipartParts += 1;
        return {
          partNumber,
          etag: createHash("md5").update(body).digest("hex"),
        };
      },
      async complete(parts) {
        const upload = bucket.uploads.get(uploadId);
        if (!upload || upload.key !== key) throw new Error("No such upload.");
        const bytes = Buffer.concat(parts.map(({ partNumber }) => upload.parts.get(partNumber)));
        const object = {
          key,
          size: bytes.byteLength,
          etag: createHash("md5").update(bytes).digest("hex"),
          checksums: { toJSON: () => ({}) },
          httpMetadata: upload.options.httpMetadata,
          customMetadata: upload.options.customMetadata,
        };
        bucket.objects.set(key, object);
        bucket.uploads.delete(uploadId);
        return object;
      },
      async abort() {
        bucket.uploads.delete(uploadId);
      },
    };
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fileMeta(path) {
  const bytes = await readFile(path);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}
