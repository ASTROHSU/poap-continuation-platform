import { createHash, createHmac } from "node:crypto";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

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

const UPLOAD_ID_PATTERN = /^[A-Za-z0-9._~+/=-]{1,512}$/;
const ETAG_PATTERN = /^[\x20-\x7e]{1,256}$/;

export class HoldingsMultipartUploader {
  constructor({
    endpoint,
    bucket,
    snapshotId,
    maximumObjectBytes,
    partBytes,
    secret,
    fetchImpl = fetch,
    now = Date.now,
  }) {
    this.endpoint = endpoint;
    this.bucket = bucket;
    this.snapshotId = snapshotId;
    this.maximumObjectBytes = maximumObjectBytes;
    this.partBytes = partBytes;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async uploadFile(object, path) {
    validateObject(object, this.maximumObjectBytes);
    const partCount = Math.ceil(object.byteLength / this.partBytes);
    if (partCount > HOLDINGS_MULTIPART_MAXIMUM_PARTS) {
      throw bridgeError("Artwork requires too many multipart parts.", "MULTIPART_TOO_MANY_PARTS");
    }
    let created = await this.#request({
      method: "POST",
      path: HOLDINGS_MULTIPART_CREATE_PATH,
      object,
    });
    if (created.disposition === "reused") return created;
    if (
      created.disposition !== "created" ||
      created.key !== object.key ||
      !UPLOAD_ID_PATTERN.test(created.uploadId ?? "")
    ) {
      throw bridgeError(
        "Holdings bridge returned an invalid multipart-create response.",
        "INVALID_MULTIPART_CREATE_RESPONSE",
      );
    }

    const handle = await open(path, "r");
    const parts = [];
    const fullHash = createHash("sha256");
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size !== object.byteLength) {
        throw bridgeError(
          "Local multipart file does not match its declared length.",
          "LOCAL_MULTIPART_SIZE_MISMATCH",
        );
      }
      for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
        const offset = (partNumber - 1) * this.partBytes;
        const byteLength = Math.min(this.partBytes, object.byteLength - offset);
        const bytes = Buffer.allocUnsafe(byteLength);
        const result = await handle.read(bytes, 0, byteLength, offset);
        if (result.bytesRead !== byteLength) {
          throw bridgeError("Local multipart file ended early.", "LOCAL_MULTIPART_TRUNCATED");
        }
        fullHash.update(bytes);
        const partSha256 = createHash("sha256").update(bytes).digest("hex");
        const uploaded = await this.#request({
          method: "PUT",
          path: HOLDINGS_MULTIPART_PART_PATH,
          object,
          uploadId: created.uploadId,
          partNumber,
          partByteLength: byteLength,
          bodySha256: partSha256,
          bytes,
          contentType: "application/octet-stream",
        });
        if (
          uploaded.disposition !== "uploaded" ||
          uploaded.partNumber !== partNumber ||
          uploaded.byteLength !== byteLength ||
          uploaded.sha256 !== partSha256 ||
          !ETAG_PATTERN.test(uploaded.etag ?? "")
        ) {
          throw bridgeError(
            "Holdings bridge returned an invalid multipart-part response.",
            "INVALID_MULTIPART_PART_RESPONSE",
          );
        }
        parts.push({
          partNumber,
          etag: uploaded.etag,
          byteLength,
          sha256: partSha256,
        });
      }
      if (fullHash.digest("hex") !== object.sha256) {
        throw bridgeError(
          "Local multipart bytes changed after source verification.",
          "LOCAL_MULTIPART_TAMPERED",
        );
      }
    } catch (error) {
      await this.#abortBestEffort(object, created.uploadId);
      throw error;
    } finally {
      await handle.close();
    }

    const bytes = Buffer.from(JSON.stringify({ parts }));
    const completed = await this.#request({
      method: "POST",
      path: HOLDINGS_MULTIPART_COMPLETE_PATH,
      object,
      uploadId: created.uploadId,
      bodySha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
      contentType: "application/json",
    });
    validateObjectResponse(completed, object);
    return completed;
  }

  async #abortBestEffort(object, uploadId) {
    try {
      await this.#request({
        method: "POST",
        path: HOLDINGS_MULTIPART_ABORT_PATH,
        object,
        uploadId,
      });
    } catch {
      // R2 expires unfinished multipart uploads after seven days.
    }
  }

  async #request({
    method,
    path,
    object,
    uploadId = "-",
    partNumber = 0,
    partByteLength = 0,
    bodySha256 = "-",
    bytes,
    contentType,
  }) {
    let latestError;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        return await this.#requestOnce({
          method,
          path,
          object,
          uploadId,
          partNumber,
          partByteLength,
          bodySha256,
          bytes,
          contentType,
        });
      } catch (error) {
        latestError = error;
        if (![401, 404, 429, 503].includes(error?.httpStatus) || attempt === 6) throw error;
        await delay(500 * attempt);
      }
    }
    throw latestError;
  }

  async #requestOnce({
    method,
    path,
    object,
    uploadId,
    partNumber,
    partByteLength,
    bodySha256,
    bytes,
    contentType,
  }) {
    const timestamp = Math.floor(this.now() / 1_000);
    const signature = createHmac("sha256", this.secret)
      .update(
        createHoldingsMultipartSignaturePayload({
          method,
          path,
          bucket: this.bucket,
          snapshotId: this.snapshotId,
          key: object.key,
          byteLength: object.byteLength,
          sha256: object.sha256,
          contentType: object.contentType,
          uploadId,
          partNumber,
          partByteLength,
          bodySha256,
          timestamp,
        }),
      )
      .digest("base64url");
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `${HOLDINGS_MULTIPART_AUTH_SCHEME} ${signature}`,
      "X-POAPin-Bucket": this.bucket,
      "X-POAPin-Snapshot": this.snapshotId,
      "X-POAPin-Object-Key": object.key,
      "X-POAPin-Object-Byte-Length": String(object.byteLength),
      "X-POAPin-SHA256": object.sha256,
      "X-POAPin-Content-Type": object.contentType,
      "X-POAPin-Upload-Id": uploadId,
      "X-POAPin-Part-Number": String(partNumber),
      "X-POAPin-Part-Byte-Length": String(partByteLength),
      "X-POAPin-Body-SHA256": bodySha256,
      "X-POAPin-Timestamp": String(timestamp),
    });
    if (bytes) {
      headers.set("Content-Length", String(bytes.byteLength));
      headers.set("Content-Type", contentType);
    } else {
      headers.set("Content-Length", "0");
    }
    const response = await this.fetchImpl(new URL(path, this.endpoint), {
      method,
      headers,
      ...(bytes ? { body: bytes } : {}),
      redirect: "error",
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      const error = bridgeError(
        `Holdings bridge returned HTTP ${response.status} with an invalid response.`,
        "INVALID_MULTIPART_RESPONSE",
      );
      error.httpStatus = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = bridgeError(
        `Holdings bridge returned HTTP ${response.status} (${payload?.code ?? "request_failed"}).`,
        payload?.code ?? "MULTIPART_REQUEST_FAILED",
      );
      error.httpStatus = response.status;
      throw error;
    }
    return payload;
  }
}

function validateObject(object, maximumBytes) {
  if (
    typeof object?.key !== "string" ||
    !Number.isSafeInteger(object.byteLength) ||
    object.byteLength < 1 ||
    object.byteLength > maximumBytes ||
    !/^[0-9a-f]{64}$/.test(object.sha256 ?? "") ||
    !["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/heic"].includes(
      object.contentType,
    )
  ) {
    throw bridgeError("Multipart artwork metadata is invalid.", "INVALID_MULTIPART_OBJECT");
  }
}

function validateObjectResponse(response, expected) {
  if (
    !["uploaded", "reused"].includes(response?.disposition) ||
    response.key !== expected.key ||
    response.byteLength !== expected.byteLength ||
    response.sha256 !== expected.sha256 ||
    response.contentType !== expected.contentType ||
    !ETAG_PATTERN.test(response.etag ?? "")
  ) {
    throw bridgeError(
      "Holdings bridge returned an invalid multipart completion.",
      "INVALID_MULTIPART_COMPLETE_RESPONSE",
    );
  }
}

function bridgeError(message, code) {
  return Object.assign(new Error(message), { code });
}
