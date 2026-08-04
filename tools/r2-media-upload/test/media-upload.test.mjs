import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { parseCliOptions } from "../cli.mjs";
import { JsonlCheckpoint, createMemoryCheckpoint } from "../lib/checkpoint.mjs";
import { createMemoryManifest, loadArtworkManifest } from "../lib/manifest.mjs";
import { openArchiveSource } from "../lib/source.mjs";
import { uploadArtworkArchive } from "../lib/pipeline.mjs";
import {
  createR2Target,
  ExistingObjectConflictError,
  ImmutableR2Uploader,
  redactErrorMessage,
} from "../lib/r2.mjs";
import { crc32 } from "../lib/zip-stream.mjs";

const CACHE_CONTROL = "public, max-age=31536000, immutable";
const SNAPSHOT_ID = "2026-07-02-v1";

test("streams a synthetic ZIP64 entry, validates WebP, and never materializes the archive", async () => {
  const first = webp("first");
  const second = webp("second");
  const archive = makeZip([
    { path: "poap.sqlite", bytes: Buffer.from("tiny synthetic database"), method: 8 },
    { path: "artwork/", bytes: Buffer.alloc(0), method: 0 },
    { path: "artwork/42.webp", bytes: first, method: 8, zip64LocalSizes: true },
    { path: "artwork/9001.webp", bytes: second, method: 0 },
    { path: "notes.txt", bytes: Buffer.from("ignored"), method: 0 },
  ]);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const report = await uploadArtworkArchive({
    source: sourceFromBuffer(archive, 7),
    manifest: manifestFor([42, 9001]),
    options: options({
      dryRun: true,
      expectedSourceBytes: archive.byteLength,
      expectedSourceSha256: sha256,
      expectedArtworkCount: 2,
    }),
  });

  assert.equal(report.ok, true);
  assert.equal(report.complete, true);
  assert.equal(report.publishable, false);
  assert.equal(report.counts.artworkEntries, 2);
  assert.equal(report.counts.dryRunValidated, 2);
  assert.equal(report.counts.ignoredEntries, 1);
  assert.equal(report.bytes.artworkDecoded, first.byteLength + second.byteLength);
  assert.equal(report.source.actualByteLength, archive.byteLength);
  assert.equal(report.validations.sourceSha256.matches, true);
});

test("uploads to the immutable snapshot namespace and records a resumable checkpoint", async () => {
  const artwork = webp("upload me");
  const archive = makeZip([{ path: "artwork/7.webp", bytes: artwork, method: 8 }]);
  const uploaded = [];
  const checkpoint = createMemoryCheckpoint();
  const report = await uploadArtworkArchive({
    source: sourceFromBuffer(archive),
    manifest: manifestFor([7]),
    checkpoint,
    uploader: {
      async upload(input) {
        uploaded.push(input);
        return { disposition: "uploaded", etag: "test-etag" };
      },
    },
    options: options({ dryRun: false }),
  });

  const key = `snapshots/${SNAPSHOT_ID}/artwork/7.webp`;
  assert.equal(report.ok, true);
  assert.equal(report.counts.uploaded, 1);
  assert.equal(report.target.transport, "s3");
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].key, key);
  assert.equal(uploaded[0].bytes.compare(artwork), 0);
  assert.equal(checkpoint.has(key), true);
});

test("a matching checkpoint drains the source entry without invoking R2", async () => {
  const artwork = webp("already complete");
  const archive = makeZip([{ path: "artwork/81.webp", bytes: artwork, method: 8 }]);
  const key = `snapshots/${SNAPSHOT_ID}/artwork/81.webp`;
  const checkpoint = createMemoryCheckpoint([
    {
      key,
      byteLength: artwork.byteLength,
      sha256: "a".repeat(64),
      disposition: "uploaded",
    },
  ]);
  const report = await uploadArtworkArchive({
    source: sourceFromBuffer(archive, 5),
    manifest: manifestFor([81]),
    checkpoint,
    uploader: { upload: () => assert.fail("R2 must not be called for a checkpointed key") },
    options: options({ dryRun: false }),
  });

  assert.equal(report.ok, true);
  assert.equal(report.counts.checkpointSkipped, 1);
  assert.equal(report.bytes.artworkDecoded, 0);
});

test("invalid image content is reported without an upload", async () => {
  const archive = makeZip([
    { path: "artwork/13.webp", bytes: Buffer.from("not a webp"), method: 0 },
  ]);
  const report = await uploadArtworkArchive({
    source: sourceFromBuffer(archive),
    manifest: manifestFor([13]),
    checkpoint: createMemoryCheckpoint(),
    uploader: { upload: () => assert.fail("invalid content must not be uploaded") },
    options: options({ dryRun: false }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.counts.failed, 1);
  assert.equal(report.failures[0].code, "INVALID_WEBP");
});

test("an intentional limit is successful but explicitly partial and never publishable", async () => {
  const archive = makeZip([
    { path: "artwork/1.webp", bytes: webp("one"), method: 8 },
    { path: "artwork/2.webp", bytes: webp("two"), method: 8 },
  ]);
  const report = await uploadArtworkArchive({
    source: sourceFromBuffer(archive, 9),
    manifest: manifestFor([1, 2]),
    options: options({ dryRun: true, limit: 1 }),
  });

  assert.equal(report.ok, true);
  assert.equal(report.complete, false);
  assert.equal(report.publishable, false);
  assert.equal(report.stopReason, "limit");
  assert.equal(report.counts.dryRunValidated, 1);
  assert.equal(report.source.sha256, null);
});

test("R2 precondition failures reuse only byte-identical immutable objects", async () => {
  const calls = [];
  const client = {
    async send(command) {
      calls.push(command);
      if (calls.length === 1) {
        const error = new Error("already exists");
        error.name = "PreconditionFailed";
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      return {
        ContentLength: 12,
        ContentType: "image/webp",
        CacheControl: CACHE_CONTROL,
        Metadata: { sha256: "b".repeat(64) },
        ETag: '"same"',
      };
    },
  };
  const uploader = new ImmutableR2Uploader({
    client,
    bucket: "poapin-archive",
    cacheControl: CACHE_CONTROL,
    attempts: 1,
  });
  const result = await uploader.upload({
    key: `snapshots/${SNAPSHOT_ID}/artwork/1.webp`,
    bytes: Buffer.alloc(12),
    sha256: "b".repeat(64),
    contentMd5: "dGVzdA==",
  });

  assert.deepEqual(result, { disposition: "reused", etag: "same" });
  assert.equal(calls[0].input.IfNoneMatch, "*");
  assert.equal(calls[0].input.CacheControl, CACHE_CONTROL);
  assert.equal(calls.length, 2);
});

test("R2 refuses an existing object whose digest does not match", async () => {
  const client = {
    call: 0,
    async send() {
      this.call += 1;
      if (this.call === 1) {
        const error = new Error("already exists");
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      return {
        ContentLength: 12,
        ContentType: "image/webp",
        CacheControl: CACHE_CONTROL,
        Metadata: { sha256: "c".repeat(64) },
      };
    },
  };
  const uploader = new ImmutableR2Uploader({
    client,
    bucket: "poapin-archive",
    cacheControl: CACHE_CONTROL,
    attempts: 1,
  });

  await assert.rejects(
    uploader.upload({
      key: `snapshots/${SNAPSHOT_ID}/artwork/1.webp`,
      bytes: Buffer.alloc(12),
      sha256: "b".repeat(64),
      contentMd5: "dGVzdA==",
    }),
    (error) => error.code === "EXISTING_OBJECT_CONFLICT",
  );
});

test("error messages redact credentials and signed query values", () => {
  const secret = "super-secret-value";
  const sessionToken = "temporary-session-token";
  const error = new Error(`request failed for ${secret}/${sessionToken}?token=visible`);
  const message = redactErrorMessage(error, [secret, sessionToken]);
  assert.equal(message.includes(secret), false);
  assert.equal(message.includes(sessionToken), false);
  assert.match(message, /token=\[redacted\]/);
});

test("R2 target reads a session token from the environment, passes it to the SDK, and redacts it", async () => {
  const sessionToken = "temporary-session-token-value";
  const previousSessionToken = process.env.R2_SESSION_TOKEN;
  process.env.R2_SESSION_TOKEN = sessionToken;
  let target;
  try {
    target = createR2Target({
      endpoint: "https://example.r2.cloudflarestorage.com",
      bucket: "poapin-archive",
      accessKeyId: "temporary-access-key",
      secretAccessKey: "temporary-secret-key",
    });
    const credentials = await target.client.config.credentials();
    assert.equal(credentials.accessKeyId, "temporary-access-key");
    assert.equal(credentials.secretAccessKey, "temporary-secret-key");
    assert.equal(credentials.sessionToken, sessionToken);
    assert.equal(target.secrets.includes(sessionToken), true);
    assert.equal(redactErrorMessage(new Error(sessionToken), target.secrets), "[redacted]");
  } finally {
    target?.client.destroy();
    if (previousSessionToken === undefined) delete process.env.R2_SESSION_TOKEN;
    else process.env.R2_SESSION_TOKEN = previousSessionToken;
  }
});

test("R2 target remains compatible with long-lived credentials", async () => {
  const target = createR2Target({
    endpoint: "https://example.r2.cloudflarestorage.com",
    bucket: "poapin-archive",
    accessKeyId: "long-lived-access-key",
    secretAccessKey: "long-lived-secret-key",
    sessionToken: undefined,
  });
  try {
    const credentials = await target.client.config.credentials();
    assert.equal(credentials.accessKeyId, "long-lived-access-key");
    assert.equal(credentials.secretAccessKey, "long-lived-secret-key");
    assert.equal(credentials.sessionToken, undefined);
    assert.deepEqual(target.secrets, ["long-lived-access-key", "long-lived-secret-key"]);
  } finally {
    target.client.destroy();
  }
});

test("CLI rejects session tokens as arguments", () => {
  assert.throws(
    () =>
      parseCliOptions([
        "--snapshot-id",
        SNAPSHOT_ID,
        "--manifest",
        "artwork-manifest.ndjson",
        "--session-token",
        "must-not-be-accepted",
      ]),
    /Unknown option '--session-token'/,
  );
});

test("CLI selects the Worker bridge explicitly and rejects ambiguous target options", () => {
  const options = parseCliOptions([
    "--snapshot-id",
    SNAPSHOT_ID,
    "--manifest",
    "artwork-manifest.ndjson",
    "--bridge-url",
    "https://bridge.example.workers.dev",
  ]);
  assert.equal(options.bridgeUrlValue, "https://bridge.example.workers.dev");

  assert.throws(
    () =>
      parseCliOptions([
        "--snapshot-id",
        SNAPSHOT_ID,
        "--manifest",
        "artwork-manifest.ndjson",
        "--bridge-url",
        "https://bridge.example.workers.dev",
        "--endpoint",
        "https://example.r2.cloudflarestorage.com",
      ]),
    /cannot be combined/,
  );
  assert.throws(
    () =>
      parseCliOptions([
        "--snapshot-id",
        SNAPSHOT_ID,
        "--manifest",
        "artwork-manifest.ndjson",
        "--bridge-secret",
        "must-not-be-accepted",
      ]),
    /Unknown option '--bridge-secret'/,
  );
});

test("manifest loading preserves the reviewed object key and rejects an old unscoped key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poapin-media-manifest-"));
  try {
    const manifestPath = join(directory, "artwork-manifest.ndjson");
    const row = {
      snapshotId: SNAPSHOT_ID,
      dropId: 42,
      object: {
        key: `snapshots/${SNAPSHOT_ID}/artwork/42.webp`,
        contentType: "image/webp",
        cacheControl: CACHE_CONTROL,
        publicUrl: `https://media.poap.in/snapshots/${SNAPSHOT_ID}/artwork/42.webp`,
      },
      source: { kind: "zip", path: "artwork/42.webp", byteLength: 19, crc32: "deadbeef" },
      eligibleForPublish: true,
    };
    await writeFile(manifestPath, `${JSON.stringify(row)}\n`);
    const manifest = await loadArtworkManifest(manifestPath, {
      snapshotId: SNAPSHOT_ID,
      cacheControl: CACHE_CONTROL,
    });
    assert.equal(manifest.get("artwork/42.webp").key, row.object.key);

    row.object.key = "artwork/42.webp";
    await writeFile(manifestPath, `${JSON.stringify(row)}\n`);
    await assert.rejects(
      loadArtworkManifest(manifestPath, {
        snapshotId: SNAPSHOT_ID,
        cacheControl: CACHE_CONTROL,
      }),
      (error) => error.code === "INVALID_ARTWORK_MANIFEST",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manifest loading accepts an explicitly reviewed custom media origin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poapin-media-custom-origin-"));
  try {
    const manifestPath = join(directory, "artwork-manifest.ndjson");
    const key = `snapshots/${SNAPSHOT_ID}/artwork/42.webp`;
    const row = {
      snapshotId: SNAPSHOT_ID,
      dropId: 42,
      object: {
        key,
        contentType: "image/webp",
        cacheControl: CACHE_CONTROL,
        publicUrl: `https://archive-media.stevechoice.org/${key}`,
      },
      source: { kind: "zip", path: "artwork/42.webp", byteLength: 19, crc32: "deadbeef" },
      eligibleForPublish: true,
    };
    await writeFile(manifestPath, `${JSON.stringify(row)}\n`);
    const manifest = await loadArtworkManifest(manifestPath, {
      snapshotId: SNAPSHOT_ID,
      cacheControl: CACHE_CONTROL,
      mediaBaseUrl: "https://archive-media.stevechoice.org",
    });
    assert.equal(manifest.get("artwork/42.webp").publicUrl, row.object.publicUrl);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote archive source resumes an interrupted response at the exact byte offset", async () => {
  const expected = Buffer.from("0123456789abcdef");
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options.headers);
    if (calls.length === 1) {
      let pullCount = 0;
      const body = new ReadableStream({
        pull(controller) {
          pullCount += 1;
          if (pullCount === 1) controller.enqueue(expected.subarray(0, 6));
          else controller.error(new TypeError("terminated"));
        },
      });
      const response = new Response(body, {
        status: 200,
        headers: {
          "content-length": String(expected.byteLength),
          etag: '"stable-archive"',
        },
      });
      Object.defineProperty(response, "url", { value: "https://example.com/archive.zip" });
      return response;
    }
    assert.equal(options.headers.Range, "bytes=6-");
    assert.equal(options.headers["If-Range"], '"stable-archive"');
    const response = new Response(expected.subarray(6), {
      status: 206,
      headers: {
        "content-length": String(expected.byteLength - 6),
        "content-range": `bytes 6-${expected.byteLength - 1}/${expected.byteLength}`,
      },
    });
    Object.defineProperty(response, "url", { value: "https://example.com/archive.zip" });
    return response;
  };
  const source = await openArchiveSource("https://example.com/archive.zip", {
    fetchImpl,
    retryDelayMs: 0,
  });
  const chunks = [];
  for await (const chunk of source.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), expected);
  assert.equal(calls.length, 2);
});

test("checkpoint repair keeps completed keys after a truncated final write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poapin-media-checkpoint-"));
  try {
    const checkpointPath = join(directory, "checkpoint.jsonl");
    const context = {
      snapshotId: SNAPSHOT_ID,
      archiveSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      endpoint: "https://example.r2.cloudflarestorage.com",
      bucket: "poapin-archive",
      cacheControl: CACHE_CONTROL,
      objectPrefix: `snapshots/${SNAPSHOT_ID}/artwork/`,
    };
    const key = `snapshots/${SNAPSHOT_ID}/artwork/42.webp`;
    const initial = await new JsonlCheckpoint(checkpointPath, { syncEvery: 1 }).open(context);
    await initial.record({
      key,
      byteLength: 19,
      sha256: "c".repeat(64),
      disposition: "uploaded",
      etag: "fixture",
    });
    await initial.close();
    await appendFile(checkpointPath, '{"kind":"object"');

    const resumed = await new JsonlCheckpoint(checkpointPath).open(context);
    assert.match(resumed.warning, /truncated final checkpoint line/);
    assert.equal(resumed.has(key), true);
    await resumed.close();
    const lines = (await readFile(checkpointPath, "utf8")).trim().split("\n");
    assert.doesNotThrow(() => lines.map(JSON.parse));

    await assert.rejects(
      new JsonlCheckpoint(checkpointPath).open({
        ...context,
        endpoint: "https://another-account.r2.cloudflarestorage.com",
      }),
      (error) => error.code === "INVALID_CHECKPOINT" && /endpoint/.test(error.message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function options(overrides = {}) {
  return {
    snapshotId: SNAPSHOT_ID,
    concurrency: 2,
    maxFailures: 25,
    maximumEntryBytes: 1024 * 1024,
    maximumCompressionRatio: 32,
    progressEvery: 250,
    limit: null,
    dryRun: true,
    bucket: "poapin-archive",
    endpoint: "https://example.r2.cloudflarestorage.com",
    cacheControl: CACHE_CONTROL,
    expectedSourceBytes: null,
    expectedSourceSha256: null,
    expectedArtworkCount: null,
    ...overrides,
  };
}

function manifestFor(dropIds) {
  return createMemoryManifest(
    dropIds.map((dropId) => ({
      dropId,
      sourcePath: `artwork/${dropId}.webp`,
      key: `snapshots/${SNAPSHOT_ID}/artwork/${dropId}.webp`,
      contentType: "image/webp",
      cacheControl: CACHE_CONTROL,
      publicUrl: `https://media.poap.in/snapshots/${SNAPSHOT_ID}/artwork/${dropId}.webp`,
      eligibleForPublish: true,
      sourceByteLength: null,
      sourceCrc32: null,
    })),
  );
}

function sourceFromBuffer(buffer, chunkSize = buffer.byteLength) {
  async function* chunks() {
    for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
      yield buffer.subarray(offset, Math.min(offset + chunkSize, buffer.byteLength));
    }
  }
  return {
    kind: "synthetic",
    label: "fixture.zip",
    byteLength: buffer.byteLength,
    stream: Readable.from(chunks()),
  };
}

function webp(label) {
  const payload = Buffer.from(label);
  const bytes = Buffer.alloc(12 + payload.byteLength);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(payload.byteLength + 4, 4);
  bytes.write("WEBP", 8, "ascii");
  payload.copy(bytes, 12);
  return bytes;
}

function makeZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const compressed = entry.method === 8 ? deflateRawSync(entry.bytes) : entry.bytes;
    const checksum = crc32(entry.bytes);
    const zip64Extra = entry.zip64LocalSizes
      ? makeZip64SizeExtra(entry.bytes.byteLength, compressed.byteLength)
      : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.zip64LocalSizes ? 45 : 20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.zip64LocalSizes ? 0xffffffff : compressed.byteLength, 18);
    local.writeUInt32LE(entry.zip64LocalSizes ? 0xffffffff : entry.bytes.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(zip64Extra.byteLength, 28);
    const localRecord = Buffer.concat([local, name, zip64Extra, compressed]);
    localRecords.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(45, 4);
    central.writeUInt16LE(entry.zip64LocalSizes ? 45 : 20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(entry.bytes.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(entry.path.endsWith("/") ? 0x10 : 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralRecords.push(Buffer.concat([central, name]));
    localOffset += localRecord.byteLength;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

function makeZip64SizeExtra(uncompressedSize, compressedSize) {
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(BigInt(uncompressedSize), 4);
  extra.writeBigUInt64LE(BigInt(compressedSize), 12);
  return extra;
}
