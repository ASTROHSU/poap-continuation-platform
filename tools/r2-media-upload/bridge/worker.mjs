import {
  BRIDGE_AUTH_SCHEME,
  BRIDGE_CLOCK_SKEW_SECONDS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_STATUS_PATH,
  BRIDGE_UPLOAD_PATH,
  createBridgeSignaturePayload,
} from "../lib/bridge-protocol.mjs";

const SNAPSHOT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const OBJECT_KEY_PATTERN = /^snapshots\/([a-z0-9][a-z0-9._-]{0,63})\/artwork\/([1-9][0-9]*)\.webp$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export default {
  fetch(request, env) {
    return handleBridgeRequest(request, env);
  },
};

export async function handleBridgeRequest(request, env, now = Date.now) {
  const config = readConfig(env);
  if (!config) return jsonError(503, "bridge_unavailable");

  const url = new URL(request.url);
  if (url.search) return jsonError(404, "not_found");

  if (url.pathname === BRIDGE_STATUS_PATH) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const authorized = await authorize(request, config, {
      method: "GET",
      path: BRIDGE_STATUS_PATH,
      key: "-",
      byteLength: 0,
      sha256: "-",
      now,
    });
    if (!authorized) return jsonError(401, "authorization_failed");
    return jsonResponse(200, {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      bucket: config.bucket,
      snapshotId: config.snapshotId,
      objectPrefix: `snapshots/${config.snapshotId}/artwork/`,
      cacheControl: config.cacheControl,
      maximumObjectBytes: config.maximumObjectBytes,
    });
  }

  if (url.pathname !== BRIDGE_UPLOAD_PATH) return jsonError(404, "not_found");
  if (request.method !== "PUT") return methodNotAllowed("PUT");
  if (request.body === null) return jsonError(400, "body_required");
  if (request.headers.get("content-type")?.toLowerCase() !== "image/webp") {
    return jsonError(415, "invalid_media_type");
  }
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    return jsonError(415, "content_encoding_not_allowed");
  }

  const key = request.headers.get("x-poapin-object-key") ?? "";
  const keyMatch = OBJECT_KEY_PATTERN.exec(key);
  if (!keyMatch || keyMatch[1] !== config.snapshotId) {
    return jsonError(400, "invalid_object_key");
  }
  const sha256 = request.headers.get("x-poapin-sha256") ?? "";
  if (!SHA256_PATTERN.test(sha256)) return jsonError(400, "invalid_sha256");
  const byteLength = parseByteLength(request.headers.get("content-length"));
  if (byteLength === null || byteLength > config.maximumObjectBytes) {
    return jsonError(413, "invalid_object_size");
  }
  const authorized = await authorize(request, config, {
    method: "PUT",
    path: BRIDGE_UPLOAD_PATH,
    key,
    byteLength,
    sha256,
    now,
  });
  if (!authorized) return jsonError(401, "authorization_failed");

  try {
    const existing = await env.ARCHIVE_BUCKET.head(key);
    if (existing) {
      if (
        !matchesExistingObject(existing, { byteLength, sha256, cacheControl: config.cacheControl })
      ) {
        return jsonError(409, "existing_object_conflict");
      }
      return objectResponse(200, "reused", existing, sha256);
    }

    const created = await env.ARCHIVE_BUCKET.put(key, request.body, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256,
      httpMetadata: {
        contentType: "image/webp",
        cacheControl: config.cacheControl,
      },
      customMetadata: {
        sha256,
        source: "poap-archive",
      },
    });
    if (created) {
      const storedSha256 = readStoredSha256(created);
      if (created.size !== byteLength || storedSha256 !== sha256) {
        return jsonError(503, "r2_write_verification_failed");
      }
      return objectResponse(201, "uploaded", created, sha256);
    }

    const racedObject = await env.ARCHIVE_BUCKET.head(key);
    if (
      !matchesExistingObject(racedObject, { byteLength, sha256, cacheControl: config.cacheControl })
    ) {
      return jsonError(409, "existing_object_conflict");
    }
    return objectResponse(200, "reused", racedObject, sha256);
  } catch (error) {
    if (error?.code === 10037) return jsonError(422, "checksum_mismatch");
    return jsonError(503, "r2_write_failed");
  }
}

async function authorize(request, config, input) {
  const requestBucket = request.headers.get("x-poapin-bucket");
  const requestSnapshot = request.headers.get("x-poapin-snapshot");
  const timestampText = request.headers.get("x-poapin-timestamp") ?? "";
  if (requestBucket !== config.bucket || requestSnapshot !== config.snapshotId) return false;
  if (!/^[0-9]{10}$/.test(timestampText)) return false;
  const timestamp = Number(timestampText);
  const currentTimestamp = Math.floor(input.now() / 1000);
  if (Math.abs(currentTimestamp - timestamp) > BRIDGE_CLOCK_SKEW_SECONDS) return false;

  const authorization = request.headers.get("authorization") ?? "";
  const prefix = `${BRIDGE_AUTH_SCHEME} `;
  if (!authorization.startsWith(prefix)) return false;
  const signature = authorization.slice(prefix.length);
  if (!SIGNATURE_PATTERN.test(signature)) return false;

  const payload = createBridgeSignaturePayload({
    method: input.method,
    path: input.path,
    bucket: requestBucket,
    snapshotId: requestSnapshot,
    key: input.key,
    byteLength: input.byteLength,
    sha256: input.sha256,
    timestamp,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase64Url(config.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    decodeBase64Url(signature),
    new TextEncoder().encode(payload),
  );
}

function readConfig(env) {
  const maximumObjectBytes = Number(env.MAX_OBJECT_BYTES);
  if (
    !env.ARCHIVE_BUCKET ||
    !SNAPSHOT_PATTERN.test(env.SNAPSHOT_ID ?? "") ||
    !BUCKET_PATTERN.test(env.BUCKET_NAME ?? "") ||
    typeof env.CACHE_CONTROL !== "string" ||
    env.CACHE_CONTROL.length === 0 ||
    !Number.isSafeInteger(maximumObjectBytes) ||
    maximumObjectBytes < 1 ||
    maximumObjectBytes > 100 * 1024 * 1024 ||
    !SECRET_PATTERN.test(env.BRIDGE_HMAC_SECRET ?? "")
  ) {
    return null;
  }
  return {
    bucket: env.BUCKET_NAME,
    snapshotId: env.SNAPSHOT_ID,
    cacheControl: env.CACHE_CONTROL,
    maximumObjectBytes,
    secret: env.BRIDGE_HMAC_SECRET,
  };
}

function matchesExistingObject(object, expected) {
  const storedSha256 = readStoredSha256(object);
  return Boolean(
    object &&
    object.size === expected.byteLength &&
    (storedSha256 === undefined || storedSha256 === expected.sha256) &&
    object.customMetadata?.sha256 === expected.sha256 &&
    object.customMetadata?.source === "poap-archive" &&
    object.httpMetadata?.contentType === "image/webp" &&
    object.httpMetadata?.cacheControl === expected.cacheControl,
  );
}

function readStoredSha256(object) {
  const checksums = object?.checksums;
  if (!checksums) return undefined;
  if (typeof checksums.toJSON === "function") return checksums.toJSON()?.sha256;
  return typeof checksums.sha256 === "string" ? checksums.sha256 : undefined;
}

function parseByteLength(value) {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function decodeBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = atob(`${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function objectResponse(status, disposition, object, sha256) {
  return jsonResponse(status, {
    disposition,
    key: object.key,
    byteLength: object.size,
    sha256,
    etag: object.etag,
  });
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
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
