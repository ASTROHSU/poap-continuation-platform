import {
  COLLECTIONS_BRIDGE_AUTH_SCHEME,
  COLLECTIONS_BRIDGE_CLOCK_SKEW_SECONDS,
  COLLECTIONS_BRIDGE_OBJECT_PATH,
  COLLECTIONS_BRIDGE_PROTOCOL_VERSION,
  COLLECTIONS_BRIDGE_STATUS_PATH,
  createCollectionsBridgeSignaturePayload,
} from "../../collections-backup/bridge/protocol.mjs";
import {
  HOLDINGS_MULTIPART_ABORT_PATH,
  HOLDINGS_MULTIPART_AUTH_SCHEME,
  HOLDINGS_MULTIPART_COMPLETE_PATH,
  HOLDINGS_MULTIPART_CREATE_PATH,
  HOLDINGS_MULTIPART_MAXIMUM_PARTS,
  HOLDINGS_MULTIPART_MINIMUM_PART_BYTES,
  HOLDINGS_MULTIPART_PART_PATH,
  createHoldingsMultipartSignaturePayload,
} from "./protocol.mjs";

const SNAPSHOT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAXIMUM_ALLOWED_OBJECT_BYTES = 100_000_000;
const MAXIMUM_ALLOWED_MULTIPART_OBJECT_BYTES = 5_000_000_000;
const MAXIMUM_COMPLETE_BODY_BYTES = 2_000_000;
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9._~+/=-]{1,512}$/;
const ETAG_PATTERN = /^[\x20-\x7e]{1,256}$/;
const MEDIA_TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
});
let cachedHmacSecret = null;
let cachedHmacKey = null;

export default {
  fetch(request, env) {
    return handleHoldingsArtworkBridgeRequest(request, env);
  },
};

/**
 * Temporary, write-only bridge for original Holdings artwork. It deliberately
 * reuses the already-audited Collections HMAC transport while accepting only
 * the active Holdings content-addressed namespace.
 */
export async function handleHoldingsArtworkBridgeRequest(request, env, now = Date.now) {
  const config = readBridgeConfig(env);
  if (!config) return jsonError(503, "bridge_unavailable");

  const url = new URL(request.url);
  if (url.search || url.hash) return jsonError(404, "not_found");

  if (url.pathname === COLLECTIONS_BRIDGE_STATUS_PATH) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const input = {
      method: "GET",
      path: COLLECTIONS_BRIDGE_STATUS_PATH,
      key: "-",
      byteLength: 0,
      sha256: "-",
      contentType: "-",
      mode: "status",
    };
    if (!(await authorize(request, config, input, now))) {
      return jsonError(401, "authorization_failed");
    }
    return jsonResponse(200, {
      protocolVersion: COLLECTIONS_BRIDGE_PROTOCOL_VERSION,
      bucket: config.bucket,
      snapshotId: config.snapshotId,
      archiveSnapshotId: config.archiveSnapshotId,
      objectPrefix: config.objectPrefix,
      cacheControl: config.cacheControl,
      maximumObjectBytes: config.maximumObjectBytes,
      capabilities: ["head", "put-if-absent", "archive-reuse-head"],
    });
  }

  if (
    [
      HOLDINGS_MULTIPART_CREATE_PATH,
      HOLDINGS_MULTIPART_PART_PATH,
      HOLDINGS_MULTIPART_COMPLETE_PATH,
      HOLDINGS_MULTIPART_ABORT_PATH,
    ].includes(url.pathname)
  ) {
    return handleMultipartRequest(request, env.ARTWORK_BUCKET, config, url.pathname, now);
  }

  if (url.pathname !== COLLECTIONS_BRIDGE_OBJECT_PATH) return jsonError(404, "not_found");
  if (!["HEAD", "PUT"].includes(request.method)) return methodNotAllowed("HEAD, PUT");

  const object = readObjectHeaders(
    request,
    config,
    request.method === "HEAD" ? config.maximumMultipartObjectBytes : config.maximumObjectBytes,
  );
  if (!object.ok) return jsonError(object.status, object.code);
  if (
    !(await authorize(
      request,
      config,
      { method: request.method, path: url.pathname, ...object },
      now,
    ))
  ) {
    return jsonError(401, "authorization_failed");
  }

  if (request.method === "HEAD") return headObject(env.ARTWORK_BUCKET, config, object);
  if (object.mode !== "upload") return methodNotAllowed("HEAD");
  if (request.body === null) return jsonError(400, "body_required");
  const contentLength = parsePositiveInteger(request.headers.get("content-length"));
  if (contentLength !== object.byteLength) return jsonError(400, "content_length_mismatch");
  if (request.headers.get("content-type")?.toLowerCase() !== object.contentType) {
    return jsonError(415, "invalid_media_type");
  }
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    return jsonError(415, "content_encoding_not_allowed");
  }
  return putObject(env.ARTWORK_BUCKET, config, object, request.body);
}

async function handleMultipartRequest(request, bucket, config, path, now) {
  const expectedMethod = path === HOLDINGS_MULTIPART_PART_PATH ? "PUT" : "POST";
  if (request.method !== expectedMethod) return methodNotAllowed(expectedMethod);
  const object = readMultipartObjectHeaders(request, config);
  if (!object.ok) return jsonError(object.status, object.code);
  const uploadId = request.headers.get("x-poapin-upload-id") ?? "";
  const partNumber = parseNonnegativeInteger(request.headers.get("x-poapin-part-number"));
  const partByteLength = parseNonnegativeInteger(request.headers.get("x-poapin-part-byte-length"));
  const bodySha256 = request.headers.get("x-poapin-body-sha256") ?? "";
  if (
    (path === HOLDINGS_MULTIPART_CREATE_PATH &&
      (uploadId !== "-" || partNumber !== 0 || partByteLength !== 0 || bodySha256 !== "-")) ||
    (path !== HOLDINGS_MULTIPART_CREATE_PATH &&
      (!UPLOAD_ID_PATTERN.test(uploadId) || partNumber === null || partByteLength === null))
  ) {
    return jsonError(400, "invalid_multipart_headers");
  }
  if (
    !(await authorizeMultipart(
      request,
      config,
      {
        method: request.method,
        path,
        ...object,
        uploadId,
        partNumber,
        partByteLength,
        bodySha256,
      },
      now,
    ))
  ) {
    return jsonError(401, "authorization_failed");
  }

  if (path === HOLDINGS_MULTIPART_CREATE_PATH) {
    if (!hasNormalizedZeroLengthBody(request)) return jsonError(400, "body_not_allowed");
    return createMultipartUpload(bucket, config, object);
  }
  if (path === HOLDINGS_MULTIPART_ABORT_PATH) {
    if (
      partNumber !== 0 ||
      partByteLength !== 0 ||
      bodySha256 !== "-" ||
      !hasNormalizedZeroLengthBody(request)
    ) {
      return jsonError(400, "body_not_allowed");
    }
    return abortMultipartUpload(bucket, object, uploadId);
  }
  if (request.body === null || hasNonIdentityEncoding(request)) {
    return jsonError(400, "invalid_multipart_body");
  }
  const contentLength = parsePositiveInteger(request.headers.get("content-length"));
  if (path === HOLDINGS_MULTIPART_PART_PATH) {
    if (
      partNumber < 1 ||
      partNumber > HOLDINGS_MULTIPART_MAXIMUM_PARTS ||
      partByteLength < 1 ||
      partByteLength > config.maximumMultipartPartBytes ||
      contentLength !== partByteLength ||
      normalizeContentType(request.headers.get("content-type")) !== "application/octet-stream" ||
      !SHA256_PATTERN.test(bodySha256)
    ) {
      return jsonError(400, "multipart_part_body_mismatch");
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== partByteLength || (await sha256Hex(bytes)) !== bodySha256) {
      return jsonError(422, "checksum_mismatch");
    }
    return uploadMultipartPart(bucket, object, uploadId, partNumber, bodySha256, bytes);
  }
  if (
    partNumber !== 0 ||
    partByteLength !== 0 ||
    contentLength === null ||
    contentLength > MAXIMUM_COMPLETE_BODY_BYTES ||
    normalizeContentType(request.headers.get("content-type")) !== "application/json" ||
    !SHA256_PATTERN.test(bodySha256)
  ) {
    return jsonError(400, "invalid_multipart_complete_body");
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength !== contentLength || (await sha256Hex(bytes)) !== bodySha256) {
    return jsonError(422, "checksum_mismatch");
  }
  const parts = parseCompleteParts(bytes, object.byteLength, config.maximumMultipartPartBytes);
  if (!parts) return jsonError(400, "invalid_multipart_complete_parts");
  return completeMultipartUpload(bucket, config, object, uploadId, parts);
}

async function headObject(bucket, config, expected) {
  try {
    const existing = await bucket.head(expected.key);
    if (!existing) return headResponse(404, "object_not_found");
    if (!matchesExistingObject(existing, expected, config)) {
      return headResponse(409, "existing_object_conflict");
    }
    return headResponse(200, null, existing, expected);
  } catch {
    return headResponse(503, "r2_head_failed");
  }
}

async function putObject(bucket, config, expected, body) {
  try {
    const created = await bucket.put(expected.key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: expected.sha256,
      httpMetadata: {
        contentType: expected.contentType,
        cacheControl: config.cacheControl,
      },
      customMetadata: {
        sha256: expected.sha256,
        snapshotId: config.snapshotId,
        source: "poapin-holdings-artwork",
      },
    });
    if (created) {
      if (!matchesExistingObject(created, expected, config)) {
        return jsonError(503, "r2_write_verification_failed");
      }
      return objectResponse(201, "uploaded", created, expected);
    }

    const existing = await bucket.head(expected.key);
    if (!matchesExistingObject(existing, expected, config)) {
      return jsonError(409, "existing_object_conflict");
    }
    return objectResponse(200, "reused", existing, expected);
  } catch (error) {
    if (error?.code === 10037) return jsonError(422, "checksum_mismatch");
    return jsonError(503, "r2_write_failed");
  }
}

async function createMultipartUpload(bucket, config, expected) {
  try {
    const existing = await bucket.head(expected.key);
    if (existing) {
      return matchesExistingObject(existing, expected, config)
        ? objectResponse(200, "reused", existing, expected)
        : jsonError(409, "existing_object_conflict");
    }
    const upload = await bucket.createMultipartUpload(
      expected.key,
      objectMetadata(config, expected),
    );
    if (upload?.key !== expected.key || !UPLOAD_ID_PATTERN.test(upload.uploadId ?? "")) {
      return jsonError(503, "r2_multipart_create_verification_failed");
    }
    return jsonResponse(201, {
      disposition: "created",
      key: expected.key,
      byteLength: expected.byteLength,
      sha256: expected.sha256,
      contentType: expected.contentType,
      uploadId: upload.uploadId,
    });
  } catch {
    return jsonError(503, "r2_multipart_create_failed");
  }
}

async function uploadMultipartPart(bucket, expected, uploadId, partNumber, partSha256, bytes) {
  try {
    const upload = bucket.resumeMultipartUpload(expected.key, uploadId);
    const part = await upload.uploadPart(partNumber, bytes);
    if (part?.partNumber !== partNumber || !ETAG_PATTERN.test(part.etag ?? "")) {
      return jsonError(503, "r2_multipart_part_verification_failed");
    }
    return jsonResponse(200, {
      disposition: "uploaded",
      key: expected.key,
      uploadId,
      partNumber,
      byteLength: bytes.byteLength,
      sha256: partSha256,
      etag: part.etag,
    });
  } catch (error) {
    return isMissingUpload(error)
      ? jsonError(404, "multipart_upload_not_found")
      : jsonError(503, "r2_multipart_part_failed");
  }
}

async function completeMultipartUpload(bucket, config, expected, uploadId, parts) {
  try {
    const existing = await bucket.head(expected.key);
    if (existing) {
      await bestEffortAbort(bucket, expected.key, uploadId);
      return matchesExistingObject(existing, expected, config)
        ? objectResponse(200, "reused", existing, expected)
        : jsonError(409, "existing_object_conflict");
    }
    const upload = bucket.resumeMultipartUpload(expected.key, uploadId);
    await upload.complete(
      parts.map(({ partNumber, etag }) => ({
        partNumber,
        etag,
      })),
    );
    const created = await bucket.head(expected.key);
    if (!matchesExistingObject(created, expected, config)) {
      return jsonError(503, "r2_multipart_complete_verification_failed");
    }
    return objectResponse(201, "uploaded", created, expected);
  } catch (error) {
    return isMissingUpload(error)
      ? jsonError(404, "multipart_upload_not_found")
      : jsonError(503, "r2_multipart_complete_failed");
  }
}

async function abortMultipartUpload(bucket, expected, uploadId) {
  try {
    await bucket.resumeMultipartUpload(expected.key, uploadId).abort();
    return jsonResponse(200, {
      disposition: "aborted",
      key: expected.key,
      uploadId,
    });
  } catch (error) {
    if (!isMissingUpload(error)) return jsonError(503, "r2_multipart_abort_failed");
    return jsonResponse(200, {
      disposition: "already_absent",
      key: expected.key,
      uploadId,
    });
  }
}

function parseCompleteParts(bytes, expectedLength, maximumPartBytes) {
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (
    !body ||
    Object.keys(body).join(",") !== "parts" ||
    !Array.isArray(body.parts) ||
    body.parts.length < 1 ||
    body.parts.length > HOLDINGS_MULTIPART_MAXIMUM_PARTS
  ) {
    return null;
  }
  let total = 0;
  for (let index = 0; index < body.parts.length; index += 1) {
    const part = body.parts[index];
    if (
      !part ||
      Object.keys(part).join(",") !== "partNumber,etag,byteLength,sha256" ||
      part.partNumber !== index + 1 ||
      !ETAG_PATTERN.test(part.etag ?? "") ||
      !Number.isSafeInteger(part.byteLength) ||
      part.byteLength < 1 ||
      part.byteLength > maximumPartBytes ||
      !SHA256_PATTERN.test(part.sha256 ?? "") ||
      (index < body.parts.length - 1 && part.byteLength < HOLDINGS_MULTIPART_MINIMUM_PART_BYTES)
    ) {
      return null;
    }
    total += part.byteLength;
  }
  return total === expectedLength ? body.parts : null;
}

function readObjectHeaders(
  request,
  config,
  maximumBytes = config.maximumObjectBytes,
  modeOverride = null,
) {
  const mode = modeOverride ?? request.headers.get("x-poapin-object-mode") ?? "";
  const key = request.headers.get("x-poapin-object-key") ?? "";
  const sha256 = request.headers.get("x-poapin-sha256") ?? "";
  const contentType = request.headers.get("x-poapin-content-type")?.toLowerCase() ?? "";
  const byteLength = parsePositiveInteger(request.headers.get("x-poapin-object-byte-length"));
  if (byteLength === null || byteLength > maximumBytes) {
    return { ok: false, status: 413, code: "invalid_object_size" };
  }
  if (!SHA256_PATTERN.test(sha256)) {
    return { ok: false, status: 400, code: "invalid_sha256" };
  }
  const match = new RegExp(
    `^snapshots/${escapeRegex(config.snapshotId)}/holdings/drop-artwork/sha256/([0-9a-f]{2})/([0-9a-f]{64})\\.(png|jpg|gif|webp|avif|heic)$`,
  ).exec(key);
  const valid =
    mode === "upload" &&
    match &&
    match[1] === sha256.slice(0, 2) &&
    match[2] === sha256 &&
    MEDIA_TYPES[match[3]] === contentType;
  if (!valid) return { ok: false, status: 400, code: "invalid_object_key_or_type" };
  return { ok: true, key, sha256, contentType, byteLength, mode };
}

function readMultipartObjectHeaders(request, config) {
  const requestBucket = request.headers.get("x-poapin-bucket");
  const requestSnapshot = request.headers.get("x-poapin-snapshot");
  if (requestBucket !== config.bucket || requestSnapshot !== config.snapshotId) {
    return { ok: false, status: 400, code: "invalid_target" };
  }
  return readObjectHeaders(request, config, config.maximumMultipartObjectBytes, "upload");
}

async function authorize(request, config, input, now) {
  const requestBucket = request.headers.get("x-poapin-bucket");
  const requestSnapshot = request.headers.get("x-poapin-snapshot");
  const requestPrefix = request.headers.get("x-poapin-object-prefix");
  const requestMode = request.headers.get("x-poapin-object-mode");
  const timestampText = request.headers.get("x-poapin-timestamp") ?? "";
  if (
    requestBucket !== config.bucket ||
    requestSnapshot !== config.snapshotId ||
    requestPrefix !== config.objectPrefix ||
    requestMode !== input.mode ||
    !/^[0-9]{10}$/.test(timestampText)
  ) {
    return false;
  }
  const timestamp = Number(timestampText);
  if (Math.abs(Math.floor(now() / 1000) - timestamp) > COLLECTIONS_BRIDGE_CLOCK_SKEW_SECONDS) {
    return false;
  }

  const authorization = request.headers.get("authorization") ?? "";
  const prefix = `${COLLECTIONS_BRIDGE_AUTH_SCHEME} `;
  if (!authorization.startsWith(prefix)) return false;
  const signature = authorization.slice(prefix.length);
  if (!SIGNATURE_PATTERN.test(signature)) return false;

  const payload = createCollectionsBridgeSignaturePayload({
    method: input.method,
    path: input.path,
    bucket: requestBucket,
    snapshotId: requestSnapshot,
    objectPrefix: requestPrefix,
    mode: requestMode,
    key: input.key,
    byteLength: input.byteLength,
    sha256: input.sha256,
    contentType: input.contentType,
    timestamp,
  });
  const key = await hmacVerificationKey(config.secret);
  return crypto.subtle.verify(
    "HMAC",
    key,
    decodeBase64Url(signature),
    new TextEncoder().encode(payload),
  );
}

async function authorizeMultipart(request, config, input, now) {
  const timestampText = request.headers.get("x-poapin-timestamp") ?? "";
  if (
    request.headers.get("x-poapin-bucket") !== config.bucket ||
    request.headers.get("x-poapin-snapshot") !== config.snapshotId ||
    !/^[0-9]{10}$/.test(timestampText)
  ) {
    return false;
  }
  const timestamp = Number(timestampText);
  if (Math.abs(Math.floor(now() / 1_000) - timestamp) > COLLECTIONS_BRIDGE_CLOCK_SKEW_SECONDS) {
    return false;
  }
  const authorization = request.headers.get("authorization") ?? "";
  const prefix = `${HOLDINGS_MULTIPART_AUTH_SCHEME} `;
  if (!authorization.startsWith(prefix)) return false;
  const signature = authorization.slice(prefix.length);
  if (!SIGNATURE_PATTERN.test(signature)) return false;
  const payload = createHoldingsMultipartSignaturePayload({
    method: input.method,
    path: input.path,
    bucket: config.bucket,
    snapshotId: config.snapshotId,
    key: input.key,
    byteLength: input.byteLength,
    sha256: input.sha256,
    contentType: input.contentType,
    uploadId: input.uploadId,
    partNumber: input.partNumber,
    partByteLength: input.partByteLength,
    bodySha256: input.bodySha256,
    timestamp,
  });
  const key = await hmacVerificationKey(config.secret);
  return crypto.subtle.verify(
    "HMAC",
    key,
    decodeBase64Url(signature),
    new TextEncoder().encode(payload),
  );
}

function hmacVerificationKey(secret) {
  if (secret !== cachedHmacSecret || !cachedHmacKey) {
    cachedHmacSecret = secret;
    cachedHmacKey = crypto.subtle.importKey(
      "raw",
      decodeBase64Url(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
  return cachedHmacKey;
}

function readBridgeConfig(env) {
  const snapshotId = env.SNAPSHOT_ID ?? "";
  const archiveSnapshotId = env.ARCHIVE_SNAPSHOT_ID ?? "";
  const maximumObjectBytes = Number(env.MAX_OBJECT_BYTES);
  const maximumMultipartObjectBytes = Number(env.MAX_MULTIPART_OBJECT_BYTES);
  const maximumMultipartPartBytes = Number(env.MAX_MULTIPART_PART_BYTES);
  if (
    !env.ARTWORK_BUCKET ||
    !SNAPSHOT_PATTERN.test(snapshotId) ||
    !SNAPSHOT_PATTERN.test(archiveSnapshotId) ||
    !BUCKET_PATTERN.test(env.BUCKET_NAME ?? "") ||
    env.OBJECT_PREFIX !== "snapshots/" ||
    typeof env.CACHE_CONTROL !== "string" ||
    env.CACHE_CONTROL.length === 0 ||
    env.CACHE_CONTROL.length > 256 ||
    !Number.isSafeInteger(maximumObjectBytes) ||
    maximumObjectBytes < 1 ||
    maximumObjectBytes > MAXIMUM_ALLOWED_OBJECT_BYTES ||
    !Number.isSafeInteger(maximumMultipartObjectBytes) ||
    maximumMultipartObjectBytes < maximumObjectBytes ||
    maximumMultipartObjectBytes > MAXIMUM_ALLOWED_MULTIPART_OBJECT_BYTES ||
    !Number.isSafeInteger(maximumMultipartPartBytes) ||
    maximumMultipartPartBytes < HOLDINGS_MULTIPART_MINIMUM_PART_BYTES ||
    maximumMultipartPartBytes > maximumObjectBytes ||
    Math.ceil(maximumMultipartObjectBytes / maximumMultipartPartBytes) >
      HOLDINGS_MULTIPART_MAXIMUM_PARTS ||
    !SECRET_PATTERN.test(env.COLLECTIONS_R2_BRIDGE_SECRET ?? "")
  ) {
    return null;
  }
  return {
    bucket: env.BUCKET_NAME,
    snapshotId,
    archiveSnapshotId,
    objectPrefix: "snapshots/",
    cacheControl: env.CACHE_CONTROL,
    maximumObjectBytes,
    maximumMultipartObjectBytes,
    maximumMultipartPartBytes,
    secret: env.COLLECTIONS_R2_BRIDGE_SECRET,
  };
}

function matchesExistingObject(object, expected, config) {
  const storedSha256 = object?.checksums?.toJSON?.().sha256;
  return Boolean(
    object &&
    object.key === expected.key &&
    object.size === expected.byteLength &&
    object.etag &&
    (storedSha256 === undefined || storedSha256 === expected.sha256) &&
    object.httpMetadata?.contentType === expected.contentType &&
    object.httpMetadata?.cacheControl === config.cacheControl &&
    object.customMetadata?.sha256 === expected.sha256 &&
    object.customMetadata?.snapshotId === config.snapshotId &&
    object.customMetadata?.source === "poapin-holdings-artwork",
  );
}

function objectMetadata(config, expected) {
  return {
    httpMetadata: {
      contentType: expected.contentType,
      cacheControl: config.cacheControl,
    },
    customMetadata: {
      sha256: expected.sha256,
      snapshotId: config.snapshotId,
      source: "poapin-holdings-artwork",
    },
  };
}

async function bestEffortAbort(bucket, key, uploadId) {
  try {
    await bucket.resumeMultipartUpload(key, uploadId).abort();
  } catch {
    // Completion is already terminal; abandoned uploads expire in R2.
  }
}

function isMissingUpload(error) {
  return error?.code === 10024 || /not found|no such upload/i.test(String(error?.message ?? ""));
}

function hasNormalizedZeroLengthBody(request) {
  const contentLength = request.headers.get("content-length");
  return (
    (request.body === null || contentLength === "0") &&
    !request.headers.get("transfer-encoding") &&
    !hasNonIdentityEncoding(request)
  );
}

function hasNonIdentityEncoding(request) {
  const value = request.headers.get("content-encoding");
  return Boolean(value && value.toLowerCase() !== "identity");
}

function normalizeContentType(value) {
  return String(value ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePositiveInteger(value) {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseNonnegativeInteger(value) {
  if (value === "0") return 0;
  return parsePositiveInteger(value);
}

function decodeBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = atob(`${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function objectResponse(status, disposition, object, expected) {
  return jsonResponse(status, {
    disposition,
    key: expected.key,
    byteLength: expected.byteLength,
    sha256: expected.sha256,
    contentType: expected.contentType,
    etag: object.etag,
  });
}

function headResponse(status, code = null, object = null, expected = null) {
  const headers = securityHeaders();
  if (code) headers.set("X-POAPin-Error-Code", code);
  if (object && expected) {
    headers.set("X-POAPin-Object-Key", expected.key);
    headers.set("X-POAPin-Object-Byte-Length", String(expected.byteLength));
    headers.set("X-POAPin-SHA256", expected.sha256);
    headers.set("X-POAPin-Content-Type", expected.contentType);
    headers.set("ETag", object.etag);
  }
  return new Response(null, { status, headers });
}

function methodNotAllowed(method) {
  const response = jsonError(405, "method_not_allowed");
  response.headers.set("Allow", method);
  return response;
}

function jsonError(status, code) {
  return jsonResponse(status, { error: "The upload request was rejected.", code });
}

function jsonResponse(status, payload) {
  const headers = securityHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { status, headers });
}

function securityHeaders() {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

export const holdingsArtworkBridgeInternals = {
  readBridgeConfig,
  readObjectHeaders,
  matchesExistingObject,
};
