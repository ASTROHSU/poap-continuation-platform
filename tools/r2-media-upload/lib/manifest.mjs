import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;
const OBJECT_KEY_PATTERN = /^snapshots\/([^/]+)\/artwork\/([1-9][0-9]*)\.webp$/;

export class ArtworkManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArtworkManifestError";
    this.code = "INVALID_ARTWORK_MANIFEST";
  }
}

export async function loadArtworkManifest(
  filePath,
  { snapshotId, cacheControl, mediaBaseUrl = "https://media.poap.in" },
) {
  const absolutePath = resolve(filePath);
  const fileStat = await stat(absolutePath).catch((error) => {
    throw new ArtworkManifestError(
      `Cannot open artwork manifest ${JSON.stringify(basename(absolutePath))}: ${error.code ?? "unknown error"}.`,
    );
  });
  if (!fileStat.isFile())
    throw new ArtworkManifestError("Artwork manifest must be a regular file.");
  if (fileStat.size <= 0 || fileStat.size > MAX_MANIFEST_BYTES) {
    throw new ArtworkManifestError(
      `Artwork manifest must be between 1 byte and ${MAX_MANIFEST_BYTES} bytes.`,
    );
  }

  const bytes = await readFile(absolutePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const entries = new Map();
  let rowCount = 0;
  let eligibleCount = 0;
  let ineligibleCount = 0;

  for (const [index, line] of bytes.toString("utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    rowCount += 1;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new ArtworkManifestError(`Artwork manifest line ${index + 1} is not valid JSON.`);
    }
    const normalized = validateRow(row, index + 1, { snapshotId, cacheControl, mediaBaseUrl });
    if (entries.has(normalized.sourcePath)) {
      throw new ArtworkManifestError(`Artwork manifest repeats drop ${normalized.dropId}.`);
    }
    entries.set(normalized.sourcePath, normalized);
    if (normalized.eligibleForPublish) eligibleCount += 1;
    else ineligibleCount += 1;
  }
  if (rowCount === 0) throw new ArtworkManifestError("Artwork manifest has no object rows.");

  return Object.freeze({
    label: basename(absolutePath),
    byteLength: bytes.byteLength,
    sha256,
    rowCount,
    eligibleCount,
    ineligibleCount,
    entries,
    get(sourcePath) {
      return entries.get(sourcePath) ?? null;
    },
  });
}

export function createMemoryManifest(rows, { label = "fixture-manifest.ndjson" } = {}) {
  const entries = new Map(rows.map((row) => [row.sourcePath, row]));
  return {
    label,
    byteLength: null,
    sha256: "0".repeat(64),
    rowCount: rows.length,
    eligibleCount: rows.filter((row) => row.eligibleForPublish).length,
    ineligibleCount: rows.filter((row) => !row.eligibleForPublish).length,
    entries,
    get: (sourcePath) => entries.get(sourcePath) ?? null,
  };
}

function validateRow(row, lineNumber, { snapshotId, cacheControl, mediaBaseUrl }) {
  const prefix = `Artwork manifest line ${lineNumber}`;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new ArtworkManifestError(`${prefix} must be an object.`);
  }
  if (!Number.isSafeInteger(row.dropId) || row.dropId <= 0) {
    throw new ArtworkManifestError(`${prefix} has an invalid dropId.`);
  }
  if (row.snapshotId !== snapshotId) {
    throw new ArtworkManifestError(`${prefix} does not belong to snapshot ${snapshotId}.`);
  }
  if (typeof row.eligibleForPublish !== "boolean") {
    throw new ArtworkManifestError(`${prefix} must declare eligibleForPublish.`);
  }
  const key = row.object?.key;
  const keyMatch = typeof key === "string" ? OBJECT_KEY_PATTERN.exec(key) : null;
  if (!keyMatch || keyMatch[1] !== snapshotId || keyMatch[2] !== String(row.dropId)) {
    throw new ArtworkManifestError(`${prefix} has an object.key outside snapshot ${snapshotId}.`);
  }
  if (row.object.contentType !== "image/webp") {
    throw new ArtworkManifestError(`${prefix} must use image/webp.`);
  }
  if (row.object.cacheControl !== cacheControl) {
    throw new ArtworkManifestError(`${prefix} has unexpected Cache-Control metadata.`);
  }
  const expectedPublicUrl = `${mediaBaseUrl}/${key}`;
  if (row.object.publicUrl !== expectedPublicUrl) {
    throw new ArtworkManifestError(`${prefix} has an unexpected publicUrl.`);
  }

  const sourceByteLength = row.source?.byteLength;
  if (
    sourceByteLength !== undefined &&
    (!Number.isSafeInteger(sourceByteLength) || sourceByteLength < 0)
  ) {
    throw new ArtworkManifestError(`${prefix} has an invalid source byte length.`);
  }
  const sourceCrc32 = row.source?.crc32;
  if (sourceCrc32 !== undefined && !/^[0-9a-f]{8}$/.test(sourceCrc32)) {
    throw new ArtworkManifestError(`${prefix} has an invalid source CRC-32.`);
  }
  return Object.freeze({
    dropId: row.dropId,
    sourcePath: `artwork/${row.dropId}.webp`,
    key,
    contentType: row.object.contentType,
    cacheControl: row.object.cacheControl,
    publicUrl: row.object.publicUrl,
    eligibleForPublish: row.eligibleForPublish,
    sourceByteLength: sourceByteLength ?? null,
    sourceCrc32: sourceCrc32 ?? null,
  });
}
