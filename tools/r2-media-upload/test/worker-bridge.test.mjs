import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import bridgeWorker, { handleBridgeRequest } from "../bridge/worker.mjs";
import { BRIDGE_STATUS_PATH, createBridgeSignaturePayload } from "../lib/bridge-protocol.mjs";
import { createWorkerBridgeTarget, ImmutableWorkerBridgeUploader } from "../lib/worker-bridge.mjs";

const SNAPSHOT_ID = "2026-07-02-v1";
const BUCKET = "poapin-archive";
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const MAXIMUM_OBJECT_BYTES = 32 * 1024 * 1024;
const ENDPOINT = "https://poapin-r2-ingest.example.workers.dev";
const NOW = 1_767_225_600_000;
const SECRET = Buffer.alloc(32, 0x2a).toString("base64url");

test("bridge signature protocol has a stable canonical test vector", () => {
  const payload = createBridgeSignaturePayload({
    method: "GET",
    path: BRIDGE_STATUS_PATH,
    bucket: BUCKET,
    snapshotId: SNAPSHOT_ID,
    timestamp: NOW / 1000,
  });
  assert.equal(
    payload,
    "POAPIN-R2-UPLOAD/1\nGET\n/v1/status\npoapin-archive\n2026-07-02-v1\n-\n0\n-\n1767225600",
  );
  assert.equal(
    createHmac("sha256", Buffer.from(SECRET, "base64url")).update(payload).digest("base64url"),
    "QaSZMpeKoun8tpmBwK906LT2EYI1M7m9w6gSHPdrp8I",
  );
});

test("signed preflight uploads, reuses, and never transmits the root secret", async () => {
  const bucket = new MemoryR2Bucket();
  const env = bridgeEnv(bucket);
  const authorizations = [];
  const target = createWorkerBridgeTarget({
    bridgeUrl: ENDPOINT,
    bucket: BUCKET,
    secret: SECRET,
    snapshotId: SNAPSHOT_ID,
    cacheControl: CACHE_CONTROL,
    maximumEntryBytes: MAXIMUM_OBJECT_BYTES,
    attempts: 1,
    now: () => NOW,
    fetchImpl: bridgeFetch(env, {
      inspect(request) {
        authorizations.push(request.headers.get("authorization"));
      },
    }),
  });

  await target.uploader.verifyTarget();
  const bytes = webp("bridge upload");
  const sha256 = digest(bytes);
  const key = `snapshots/${SNAPSHOT_ID}/artwork/42.webp`;
  const first = await target.uploader.upload({ key, bytes, sha256 });
  const second = await target.uploader.upload({ key, bytes, sha256 });

  assert.equal(target.protocolVersion, 1);
  assert.deepEqual(first, { disposition: "uploaded", etag: sha256.slice(0, 32) });
  assert.deepEqual(second, { disposition: "reused", etag: sha256.slice(0, 32) });
  assert.equal(bucket.putCalls, 1);
  assert.equal(bucket.headCalls, 2);
  assert.equal(Buffer.compare(bucket.stored.get(key).bytes, bytes), 0);
  assert.equal(bucket.lastPutOptions.sha256, sha256);
  assert.deepEqual(bucket.lastPutOptions.onlyIf, { etagDoesNotMatch: "*" });
  assert.deepEqual(bucket.lastPutOptions.customMetadata, {
    sha256,
    source: "poap-archive",
  });
  assert.equal(
    authorizations.every((value) => !value.includes(SECRET)),
    true,
  );
});

test("the deployed fetch entrypoint ignores the Workers execution context argument", async () => {
  const bucket = new MemoryR2Bucket();
  const env = bridgeEnv(bucket);
  const uploader = new ImmutableWorkerBridgeUploader({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    snapshotId: SNAPSHOT_ID,
    cacheControl: CACHE_CONTROL,
    maximumEntryBytes: MAXIMUM_OBJECT_BYTES,
    secret: SECRET,
    attempts: 1,
    fetchImpl(url, init) {
      return bridgeWorker.fetch(new Request(url, init), env, { waitUntil() {} });
    },
  });
  await uploader.verifyTarget();
});

test("a signed upload never overwrites a conflicting immutable object", async () => {
  const bucket = new MemoryR2Bucket();
  const env = bridgeEnv(bucket);
  const uploader = bridgeUploader(env, { attempts: 4 });
  const key = `snapshots/${SNAPSHOT_ID}/artwork/7.webp`;
  const first = webp("first");
  const second = webp("second");
  await uploader.upload({ key, bytes: first, sha256: digest(first) });

  await assert.rejects(
    uploader.upload({ key, bytes: second, sha256: digest(second) }),
    (error) =>
      error.code === "EXISTING_OBJECT_CONFLICT" && error.httpStatus === 409 && error.attempts === 1,
  );
  assert.equal(Buffer.compare(bucket.stored.get(key).bytes, first), 0);
});

test("a tampered signed header is rejected before R2 access", async () => {
  const bucket = new MemoryR2Bucket();
  const env = bridgeEnv(bucket);
  const uploader = bridgeUploader(env, {
    attempts: 4,
    fetchImpl: bridgeFetch(env, {
      mutate(request) {
        request.headers.set("X-POAPin-SHA256", "0".repeat(64));
      },
    }),
  });
  const bytes = webp("tamper proof");

  await assert.rejects(
    uploader.upload({
      key: `snapshots/${SNAPSHOT_ID}/artwork/81.webp`,
      bytes,
      sha256: digest(bytes),
    }),
    (error) => error.httpStatus === 401 && error.attempts === 1,
  );
  assert.equal(bucket.putCalls, 0);
});

test("a lost success response retries as an exact reuse", async () => {
  const bucket = new MemoryR2Bucket();
  const env = bridgeEnv(bucket);
  let uploadResponses = 0;
  const uploader = bridgeUploader(env, {
    attempts: 2,
    sleep: async () => {},
    fetchImpl: bridgeFetch(env, {
      async replaceResponse(request, response) {
        if (new URL(request.url).pathname !== "/v1/upload") return response;
        uploadResponses += 1;
        if (uploadResponses === 1) {
          return Response.json(
            { error: "The upload request was rejected.", code: "temporary_failure" },
            { status: 503 },
          );
        }
        return response;
      },
    }),
  });
  const bytes = webp("retry safely");
  const result = await uploader.upload({
    key: `snapshots/${SNAPSHOT_ID}/artwork/9001.webp`,
    bytes,
    sha256: digest(bytes),
  });

  assert.deepEqual(result, { disposition: "reused", etag: digest(bytes).slice(0, 32) });
  assert.equal(bucket.putCalls, 1);
  assert.equal(bucket.headCalls, 2);
});

test("bridge accepts R2 checksum objects that expose sha256 without toJSON", async () => {
  const bucket = new MemoryR2Bucket();
  bucket.plainChecksums = true;
  const uploader = bridgeUploader(bridgeEnv(bucket));
  const bytes = webp("plain checksum shape");
  const sha256 = digest(bytes);
  const key = `snapshots/${SNAPSHOT_ID}/artwork/226162.webp`;

  const first = await uploader.upload({ key, bytes, sha256 });
  const second = await uploader.upload({ key, bytes, sha256 });

  assert.equal(first.disposition, "uploaded");
  assert.equal(second.disposition, "reused");
});

test("preflight rejects stale signatures and mismatched target metadata", async () => {
  const bucket = new MemoryR2Bucket();
  const env = bridgeEnv(bucket);
  const stale = bridgeUploader(env, { now: () => NOW - 301_000, attempts: 4 });
  await assert.rejects(
    stale.verifyTarget(),
    (error) => error.httpStatus === 401 && error.attempts === 1,
  );

  const mismatch = new ImmutableWorkerBridgeUploader({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    snapshotId: SNAPSHOT_ID,
    cacheControl: "public, max-age=60",
    maximumEntryBytes: MAXIMUM_OBJECT_BYTES,
    secret: SECRET,
    attempts: 1,
    now: () => NOW,
    fetchImpl: bridgeFetch(env),
  });
  await assert.rejects(
    mismatch.verifyTarget(),
    (error) => error.code === "WORKER_BRIDGE_TARGET_MISMATCH",
  );
});

test("bridge responses are streamed through a strict size bound", async () => {
  let requests = 0;
  const uploader = new ImmutableWorkerBridgeUploader({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    snapshotId: SNAPSHOT_ID,
    cacheControl: CACHE_CONTROL,
    maximumEntryBytes: MAXIMUM_OBJECT_BYTES,
    secret: SECRET,
    attempts: 4,
    now: () => NOW,
    async fetchImpl() {
      requests += 1;
      return new Response("x".repeat(32_769));
    },
  });
  await assert.rejects(
    uploader.verifyTarget(),
    (error) => error.code === "INVALID_WORKER_BRIDGE_RESPONSE" && error.attempts === 1,
  );
  assert.equal(requests, 1);
});

test("a malformed transient 5xx response remains retryable", async () => {
  const bucket = new MemoryR2Bucket();
  const env = bridgeEnv(bucket);
  const actualFetch = bridgeFetch(env);
  let requests = 0;
  const uploader = new ImmutableWorkerBridgeUploader({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    snapshotId: SNAPSHOT_ID,
    cacheControl: CACHE_CONTROL,
    maximumEntryBytes: MAXIMUM_OBJECT_BYTES,
    secret: SECRET,
    attempts: 2,
    now: () => NOW,
    sleep: async () => {},
    async fetchImpl(url, init) {
      requests += 1;
      if (requests === 1) return new Response("temporary gateway failure", { status: 503 });
      return actualFetch(url, init);
    },
  });
  await uploader.verifyTarget();
  assert.equal(requests, 2);
});

test("bridge target rejects unsafe origins, malformed secrets, and ambiguous CLI-style inputs", () => {
  const base = {
    bucket: BUCKET,
    secret: SECRET,
    snapshotId: SNAPSHOT_ID,
    cacheControl: CACHE_CONTROL,
    maximumEntryBytes: MAXIMUM_OBJECT_BYTES,
  };
  assert.throws(
    () => createWorkerBridgeTarget({ ...base, bridgeUrl: "http://example.com" }),
    /HTTPS origin/,
  );
  assert.throws(
    () => createWorkerBridgeTarget({ ...base, bridgeUrl: `${ENDPOINT}/upload` }),
    /HTTPS origin/,
  );
  assert.throws(
    () => createWorkerBridgeTarget({ ...base, bridgeUrl: ENDPOINT, secret: "too-short" }),
    /32-byte secret/,
  );
});

function bridgeUploader(env, overrides = {}) {
  return new ImmutableWorkerBridgeUploader({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    snapshotId: SNAPSHOT_ID,
    cacheControl: CACHE_CONTROL,
    maximumEntryBytes: MAXIMUM_OBJECT_BYTES,
    secret: SECRET,
    attempts: 1,
    now: () => NOW,
    fetchImpl: bridgeFetch(env),
    ...overrides,
  });
}

function bridgeEnv(bucket) {
  return {
    ARCHIVE_BUCKET: bucket,
    BRIDGE_HMAC_SECRET: SECRET,
    BUCKET_NAME: BUCKET,
    SNAPSHOT_ID,
    CACHE_CONTROL,
    MAX_OBJECT_BYTES: String(MAXIMUM_OBJECT_BYTES),
  };
}

function bridgeFetch(env, hooks = {}) {
  return async (url, init) => {
    const request = new Request(url, init);
    hooks.mutate?.(request);
    hooks.inspect?.(request);
    const response = await handleBridgeRequest(request, env, () => NOW);
    return hooks.replaceResponse ? hooks.replaceResponse(request, response) : response;
  };
}

class MemoryR2Bucket {
  constructor() {
    this.stored = new Map();
    this.putCalls = 0;
    this.headCalls = 0;
    this.lastPutOptions = null;
    this.plainChecksums = false;
  }

  async put(key, value, options) {
    this.putCalls += 1;
    this.lastPutOptions = options;
    if (this.stored.has(key) && options.onlyIf?.etagDoesNotMatch === "*") return null;
    const bytes = Buffer.from(await new Response(value).arrayBuffer());
    const sha256 = digest(bytes);
    if (sha256 !== options.sha256) {
      const error = new Error("bad digest");
      error.code = 10037;
      throw error;
    }
    const object = {
      key,
      size: bytes.byteLength,
      etag: sha256.slice(0, 32),
      checksums: this.plainChecksums ? { sha256 } : { toJSON: () => ({ sha256 }) },
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
      bytes,
    };
    this.stored.set(key, object);
    return object;
  }

  async head(key) {
    this.headCalls += 1;
    return this.stored.get(key) ?? null;
  }
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

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
