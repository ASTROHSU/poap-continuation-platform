import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Readable } from "node:stream";

export class ArchiveSourceError extends Error {
  constructor(message, code = "ARCHIVE_SOURCE_ERROR") {
    super(message);
    this.name = "ArchiveSourceError";
    this.code = code;
  }
}

export async function openArchiveSource(
  value,
  { signal, fetchImpl = fetch, retryDelayMs = 1_000, maximumReconnects = 12 } = {},
) {
  const url = parseRemoteUrl(value);
  if (url) return openRemote(url, { signal, fetchImpl, retryDelayMs, maximumReconnects });

  const filePath = resolve(value);
  const fileStat = await stat(filePath).catch((error) => {
    throw new ArchiveSourceError(
      `Cannot open local archive ${JSON.stringify(basename(filePath))}: ${error.code ?? "unknown error"}.`,
    );
  });
  if (!fileStat.isFile())
    throw new ArchiveSourceError("The local archive source must be a regular file.");
  const stream = createReadStream(filePath);
  const abort = () => stream.destroy(abortError());
  signal?.addEventListener("abort", abort, { once: true });
  stream.once("close", () => signal?.removeEventListener("abort", abort));
  return {
    kind: "local",
    label: basename(filePath),
    byteLength: fileStat.size,
    stream,
  };
}

async function openRemote(url, { signal, fetchImpl, retryDelayMs, maximumReconnects }) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: {
      Accept: "application/zip, application/octet-stream;q=0.9",
      "Accept-Encoding": "identity",
      "User-Agent": "poapin-archive-media-uploader/0.1",
    },
    signal,
  });
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:") {
    await response.body?.cancel();
    throw new ArchiveSourceError("The archive redirected away from HTTPS.", "INSECURE_REDIRECT");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ArchiveSourceError(
      `Archive request to ${safeUrl(finalUrl)} failed with HTTP ${response.status}.`,
      "ARCHIVE_HTTP_ERROR",
    );
  }
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    await response.body.cancel();
    throw new ArchiveSourceError(
      `Archive response used unexpected Content-Encoding ${JSON.stringify(contentEncoding)}.`,
      "UNEXPECTED_CONTENT_ENCODING",
    );
  }
  const contentLength = parseContentLength(response.headers.get("content-length"));
  const validator = selectValidator(response.headers);
  return {
    kind: "remote",
    label: safeUrl(finalUrl),
    byteLength: contentLength,
    stream:
      contentLength === null
        ? Readable.fromWeb(response.body)
        : Readable.from(
            resumableResponseBody({
              initialResponse: response,
              url: finalUrl,
              byteLength: contentLength,
              validator,
              signal,
              fetchImpl,
              retryDelayMs,
              maximumReconnects,
            }),
          ),
  };
}

async function* resumableResponseBody({
  initialResponse,
  url,
  byteLength,
  validator,
  signal,
  fetchImpl,
  retryDelayMs,
  maximumReconnects,
}) {
  let response = initialResponse;
  let offset = 0;
  let reconnects = 0;

  while (offset < byteLength) {
    const reader = response.body.getReader();
    let endedNormally = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          endedNormally = true;
          break;
        }
        if (!(value instanceof Uint8Array) || value.byteLength === 0) continue;
        offset += value.byteLength;
        if (offset > byteLength) {
          throw new ArchiveSourceError(
            "Archive response exceeded its advertised byte length.",
            "ARCHIVE_LENGTH_MISMATCH",
          );
        }
        yield value;
      }
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw abortError();
      if (error instanceof ArchiveSourceError) throw error;
    } finally {
      reader.releaseLock();
    }

    if (endedNormally && offset === byteLength) return;
    if (offset === byteLength) return;
    if (reconnects >= maximumReconnects) {
      throw new ArchiveSourceError(
        `Archive download ended at byte ${offset} after ${reconnects} reconnects.`,
        "ARCHIVE_RECONNECT_LIMIT",
      );
    }

    reconnects += 1;
    await abortableDelay(Math.min(retryDelayMs * 2 ** (reconnects - 1), 8_000), signal);
    response = await fetchRange({
      url,
      offset,
      byteLength,
      validator,
      signal,
      fetchImpl,
    });
  }
}

async function fetchRange({ url, offset, byteLength, validator, signal, fetchImpl }) {
  const headers = {
    Accept: "application/zip, application/octet-stream;q=0.9",
    "Accept-Encoding": "identity",
    Range: `bytes=${offset}-`,
    "User-Agent": "poapin-archive-media-uploader/0.1",
  };
  if (validator) headers["If-Range"] = validator;

  const response = await fetchImpl(url, { redirect: "follow", headers, signal });
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:") {
    await response.body?.cancel();
    throw new ArchiveSourceError("The archive redirected away from HTTPS.", "INSECURE_REDIRECT");
  }
  if (response.status !== 206 || !response.body) {
    await response.body?.cancel();
    throw new ArchiveSourceError(
      `Archive range request to ${safeUrl(finalUrl)} failed with HTTP ${response.status}.`,
      "ARCHIVE_RANGE_ERROR",
    );
  }
  validateIdentityEncoding(response);
  const range = parseContentRange(response.headers.get("content-range"));
  if (!range || range.start !== offset || range.total !== byteLength) {
    await response.body.cancel();
    throw new ArchiveSourceError(
      "Archive range response did not match the requested byte offset and total length.",
      "ARCHIVE_RANGE_MISMATCH",
    );
  }
  const expectedLength = range.end - range.start + 1;
  const responseLength = parseContentLength(response.headers.get("content-length"));
  if (responseLength !== null && responseLength !== expectedLength) {
    await response.body.cancel();
    throw new ArchiveSourceError(
      "Archive range response used an inconsistent Content-Length.",
      "ARCHIVE_RANGE_MISMATCH",
    );
  }
  return response;
}

function validateIdentityEncoding(response) {
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new ArchiveSourceError(
      `Archive response used unexpected Content-Encoding ${JSON.stringify(contentEncoding)}.`,
      "UNEXPECTED_CONTENT_ENCODING",
    );
  }
}

function selectValidator(headers) {
  const etag = headers.get("etag");
  if (etag && !etag.startsWith("W/")) return etag;
  return headers.get("last-modified");
}

function parseContentRange(value) {
  const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(value ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) return null;
  return { start, end, total };
}

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectDelay(abortError());
    };
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function parseRemoteUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    throw new ArchiveSourceError("Remote archive URLs must use HTTPS.", "INSECURE_SOURCE_URL");
  }
  if (url.username || url.password) {
    throw new ArchiveSourceError(
      "Archive URLs must not contain embedded credentials.",
      "CREDENTIALS_IN_SOURCE_URL",
    );
  }
  return url;
}

function parseContentLength(value) {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeUrl(url) {
  return `${url.origin}${url.pathname}`;
}

function abortError() {
  const error = new Error("Archive reading was aborted.");
  error.name = "AbortError";
  return error;
}
