const TRAILING_SLASHES = /\/+$/;
const SNAPSHOT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTENT_ADDRESSED_FILE = /^([0-9a-f]{64})\.(png|jpg|gif|webp|avif|heic)$/;
const ARCHIVE_ARTWORK_FILE = /^([1-9][0-9]*)\.webp$/;

/** Returns the immutable R2 custom-domain path for an archived original. */
export function artworkUrl(mediaBaseUrl: string, snapshotId: string, dropId: number): string {
  return `${mediaBaseUrl.replace(TRAILING_SLASHES, "")}/snapshots/${encodeURIComponent(snapshotId)}/artwork/${dropId}.webp`;
}

/** Maps only current-snapshot Collection branding keys onto the public media origin. */
export function collectionMediaObjectUrl(
  mediaBaseUrl: string,
  objectKey: string | null,
  collectionsSnapshotId: string,
): string | null {
  if (!isSnapshotId(collectionsSnapshotId) || !objectKey) return null;
  const segments = objectKey.split("/");
  if (!isContentAddressedKey(segments, collectionsSnapshotId, "media")) return null;
  return publicMediaUrl(mediaBaseUrl, segments);
}

/**
 * Maps only artwork from the active fixed archive or active Collections
 * snapshot. Backup/private keys and media from every other release fail closed.
 */
export function collectionDropArtworkUrl(
  mediaBaseUrl: string,
  objectKey: string | null,
  archiveSnapshotId: string,
  collectionsSnapshotId: string,
  dropId: number,
): string | null {
  if (
    !isSnapshotId(archiveSnapshotId) ||
    !isSnapshotId(collectionsSnapshotId) ||
    !Number.isSafeInteger(dropId) ||
    dropId <= 0 ||
    !objectKey
  ) {
    return null;
  }
  const segments = objectKey.split("/");
  if (
    !isArchiveArtworkKey(segments, archiveSnapshotId, dropId) &&
    !isContentAddressedKey(segments, collectionsSnapshotId, "drop-artwork")
  ) {
    return null;
  }
  return publicMediaUrl(mediaBaseUrl, segments);
}

function isSnapshotId(value: string): boolean {
  return SNAPSHOT_ID.test(value);
}

function isArchiveArtworkKey(
  segments: string[],
  snapshotId: string,
  expectedDropId: number,
): boolean {
  if (
    segments.length !== 4 ||
    segments[0] !== "snapshots" ||
    segments[1] !== snapshotId ||
    segments[2] !== "artwork"
  ) {
    return false;
  }
  const match = ARCHIVE_ARTWORK_FILE.exec(segments[3] ?? "");
  if (!match) return false;
  const dropId = Number(match[1]);
  return Number.isSafeInteger(dropId) && dropId === expectedDropId;
}

function isContentAddressedKey(
  segments: string[],
  snapshotId: string,
  family: "media" | "drop-artwork",
): boolean {
  return isNamespacedContentAddressedKey(segments, snapshotId, "collections", family);
}

/** Maps holder-only artwork from the active Holdings media release. */
export function holdingDropArtworkUrl(
  mediaBaseUrl: string,
  objectKey: string | null,
  archiveSnapshotId: string,
  holdingsSnapshotId: string,
  collectionsSnapshotId: string,
  dropId: number,
): string | null {
  if (
    !isSnapshotId(archiveSnapshotId) ||
    !isSnapshotId(holdingsSnapshotId) ||
    !isSnapshotId(collectionsSnapshotId) ||
    !Number.isSafeInteger(dropId) ||
    dropId <= 0 ||
    !objectKey
  ) {
    return null;
  }
  const segments = objectKey.split("/");
  if (
    !isArchiveArtworkKey(segments, archiveSnapshotId, dropId) &&
    !isContentAddressedKey(segments, collectionsSnapshotId, "drop-artwork") &&
    !isNamespacedContentAddressedKey(segments, holdingsSnapshotId, "holdings", "drop-artwork")
  ) {
    return null;
  }
  return publicMediaUrl(mediaBaseUrl, segments);
}

function isNamespacedContentAddressedKey(
  segments: string[],
  snapshotId: string,
  namespace: "collections" | "holdings",
  family: "media" | "drop-artwork",
): boolean {
  if (
    segments.length !== 7 ||
    segments[0] !== "snapshots" ||
    segments[1] !== snapshotId ||
    segments[2] !== namespace ||
    segments[3] !== family ||
    segments[4] !== "sha256" ||
    !/^[0-9a-f]{2}$/.test(segments[5] ?? "")
  ) {
    return false;
  }
  const match = CONTENT_ADDRESSED_FILE.exec(segments[6] ?? "");
  return Boolean(match && segments[5] === match[1].slice(0, 2));
}

function publicMediaUrl(mediaBaseUrl: string, segments: string[]): string {
  const encodedKey = segments.map((segment) => encodeURIComponent(segment)).join("/");
  return `${mediaBaseUrl.replace(TRAILING_SLASHES, "")}/${encodedKey}`;
}
