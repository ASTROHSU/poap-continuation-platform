import type { OwnedCollectionArchive, PersonalArchiveSnapshot } from "./personal-export";
import type {
  CollectionMedia,
  CollectionProfile,
  MomentCapsule,
  MomentDetail,
  MomentMediaPreview,
} from "./types";

const MEDIA_ORIGIN = "https://media.poap.in";
const SNAPSHOT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const MAX_CLASSIC_ZIP_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_CLASSIC_ZIP_FILES = 65_535;
const METADATA_FILE_COUNT = 2;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 60_000;
const PROGRESS_BYTE_INTERVAL = 1024 * 1024;
const IMAGE_CATEGORIES = ["poaps", "collections", "moments", "capsules"] as const;

export const PERSONAL_IMAGE_ARCHIVE_BLOB_LIMIT_BYTES = 256 * 1024 * 1024;
export const PERSONAL_IMAGE_ARCHIVE_MAX_BYTES = MAX_CLASSIC_ZIP_BYTES;
export const PERSONAL_IMAGE_ARCHIVE_MAX_IMAGES = MAX_CLASSIC_ZIP_FILES - METADATA_FILE_COUNT - 1;

const COLLECTION_IMAGE_EXTENSIONS = new Set(["png", "jpg", "gif", "webp", "avif"]);
const MOMENT_IMAGE_EXTENSIONS = new Set(["png", "jpg", "gif", "webp", "avif", "heic", "dng"]);

export type PersonalImageArchiveCategory = "poaps" | "collections" | "moments" | "capsules";

export type PersonalImageArchiveReferenceKind =
  | "drop-artwork"
  | "collection-logo"
  | "collection-banner"
  | "collection-media"
  | "collection-drop-artwork"
  | "moment-preview"
  | "moment-thumbnail"
  | "moment-media"
  | "moment-link-image"
  | "moment-capsule-image"
  | "owned-capsule-image";

export interface PersonalImageArchiveReference {
  category: PersonalImageArchiveCategory;
  kind: PersonalImageArchiveReferenceKind;
  ownerId: string;
  context?: string;
}

export interface PersonalImageArchiveEntry {
  url: string;
  path: string;
  category: PersonalImageArchiveCategory;
  expectedBytes: number | null;
  expectedContentType: string | null;
  sha256: string | null;
  references: PersonalImageArchiveReference[];
}

export interface PersonalImageArchivePlan {
  schemaVersion: "poapin-personal-image-archive-plan-v1";
  address: string;
  generatedAt: string;
  snapshots: {
    holdings: string;
    collections: string;
    moments: string;
  };
  entries: PersonalImageArchiveEntry[];
  count: number;
  knownBytes: number;
  unknownByteLengthCount: number;
  breakdown: Record<PersonalImageArchiveCategory, number>;
}

export interface PersonalImageArchiveProgress {
  completedFiles: number;
  totalFiles: number;
  downloadedBytes: number;
  currentPath: string | null;
}

export interface PersonalImageArchiveResult {
  blob: Blob | null;
  fileCount: number;
  downloadedBytes: number;
  archiveBytes: number;
}

export interface PersonalImageArchiveRuntime {
  /**
   * When supplied, the stream is closed on success and aborted on every failure.
   * This is intended for a File System Access API writable stream.
   */
  writable?: WritableStream<Uint8Array>;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  maxAttempts?: number;
}

interface ValidatedMediaUrl {
  url: string;
  path: string;
  extension: string;
  sha256: string | null;
}

interface MutableArchiveEntry extends Omit<PersonalImageArchiveEntry, "references"> {
  references: PersonalImageArchiveReference[];
  referenceKeys: Set<string>;
}

interface DownloadedEntry {
  path: string;
  url: string;
  bytes: number;
  contentType: string | null;
  etag: string | null;
  sha256: string;
  expectedSha256: string | null;
  references: PersonalImageArchiveReference[];
}

interface ArchiveByteSink {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(reason: unknown): Promise<void>;
  toBlob(): Blob | null;
}

/**
 * Enumerates only immutable, public image objects tied to the snapshot identities
 * in a completed personal export. Arbitrary external URLs are intentionally ignored.
 */
export function buildMediaArchivePlan(snapshot: PersonalArchiveSnapshot): PersonalImageArchivePlan {
  assertSnapshotIdentity(snapshot);
  const snapshots = { ...snapshot.manifest.snapshots };
  const entries = new Map<string, MutableArchiveEntry>();
  const paths = new Map<string, string>();

  const add = (
    rawUrl: string | null | undefined,
    category: PersonalImageArchiveCategory,
    reference: Omit<PersonalImageArchiveReference, "category">,
    validator: (value: string) => ValidatedMediaUrl | null,
    expectedBytes?: number | null,
    expectedContentType?: string | null,
    expectedSha256?: string | null,
  ): void => {
    if (!rawUrl) return;
    const media = validator(rawUrl);
    if (!media) return;

    const normalizedBytes = normalizeExpectedBytes(expectedBytes);
    const normalizedContentType = normalizeExpectedContentType(
      expectedContentType,
      media.extension,
    );
    if (expectedContentType && !normalizedContentType) {
      throw new Error(`An archived image has an inconsistent content type: ${media.path}`);
    }
    if (expectedSha256 && (!SHA256.test(expectedSha256) || media.sha256 !== expectedSha256)) {
      throw new Error(`An archived image has an inconsistent SHA-256: ${media.path}`);
    }

    const existingPathUrl = paths.get(media.path);
    if (existingPathUrl && existingPathUrl !== media.url) {
      throw new Error(`Two archived images resolved to the same ZIP path: ${media.path}`);
    }
    paths.set(media.path, media.url);

    let entry = entries.get(media.url);
    if (!entry) {
      entry = {
        url: media.url,
        path: media.path,
        category,
        expectedBytes: normalizedBytes,
        expectedContentType: normalizedContentType,
        sha256: media.sha256,
        references: [],
        referenceKeys: new Set<string>(),
      };
      entries.set(media.url, entry);
    } else {
      mergeExpectedMetadata(entry, normalizedBytes, normalizedContentType, media);
    }

    const completeReference: PersonalImageArchiveReference = { category, ...reference };
    const referenceKey = JSON.stringify(completeReference);
    if (!entry.referenceKeys.has(referenceKey)) {
      entry.referenceKeys.add(referenceKey);
      entry.references.push(completeReference);
    }
  };

  for (const drop of snapshot.drops) {
    if (drop.hasArtwork === false) continue;
    add(
      drop.imageUrl,
      "poaps",
      { kind: "drop-artwork", ownerId: String(drop.dropId) },
      (value) =>
        validateDropArtworkUrl(value, snapshots.holdings, drop.dropId) ??
        validateCollectionDropUrl(value, snapshots.holdings, snapshots.collections, drop.dropId),
      null,
      null,
    );
  }

  const addCollectionProfile = (profile: CollectionProfile): void => {
    const collectionId = String(profile.collection.collectionId);
    const collectionValidator = (value: string) =>
      validateCollectionUrl(value, snapshots.collections, "media");
    add(
      profile.collection.logoUrl,
      "collections",
      { kind: "collection-logo", ownerId: collectionId },
      collectionValidator,
    );
    add(
      profile.collection.bannerUrl,
      "collections",
      { kind: "collection-banner", ownerId: collectionId },
      collectionValidator,
    );
    for (const media of profile.media) {
      if (!media.eligibleForPublish || !media.objectUrl) continue;
      addCollectionMedia(add, media, collectionId, collectionValidator);
    }
  };

  for (const profile of snapshot.collectionProfiles) addCollectionProfile(profile);
  for (const owned of snapshot.ownedCollections) {
    addCollectionProfile(owned.profile);
    addOwnedCollectionDropImages(add, owned, snapshots);
  }

  addMomentImages(add, snapshot.authoredMoments, "authored", snapshots.moments);
  addMomentImages(add, snapshot.taggedMoments, "tagged", snapshots.moments);
  for (const capsule of snapshot.ownedCapsules) {
    addCapsuleImage(add, capsule, snapshots.moments, "owned-capsule-image");
  }

  const finalEntries = [...entries.values()]
    .map(({ referenceKeys: _referenceKeys, ...entry }) => entry)
    .sort((left, right) => left.path.localeCompare(right.path));
  const knownBytes = finalEntries.reduce((total, entry) => total + (entry.expectedBytes ?? 0), 0);
  if (!Number.isSafeInteger(knownBytes)) {
    throw new Error("The archived image byte total is outside the safe JavaScript range.");
  }
  if (knownBytes >= MAX_CLASSIC_ZIP_BYTES) {
    throw new Error("The known image data exceeds this browser ZIP format's 4 GiB limit.");
  }
  assertClassicZipFileCount(finalEntries.length);

  const breakdown: Record<PersonalImageArchiveCategory, number> = {
    poaps: 0,
    collections: 0,
    moments: 0,
    capsules: 0,
  };
  for (const entry of finalEntries) breakdown[entry.category] += 1;

  return {
    schemaVersion: "poapin-personal-image-archive-plan-v1",
    address: snapshot.address,
    generatedAt: snapshot.generatedAt,
    snapshots,
    entries: finalEntries,
    count: finalEntries.length,
    knownBytes,
    unknownByteLengthCount: finalEntries.filter((entry) => entry.expectedBytes === null).length,
    breakdown,
  };
}

/**
 * Downloads each image sequentially and writes a STORE-only classic ZIP. No
 * incomplete archive is returned: any fetch, integrity, output, or size failure
 * aborts the optional writable stream and rejects the operation.
 */
export async function createPersonalImageArchiveZip(
  plan: PersonalImageArchivePlan,
  signal: AbortSignal,
  onProgress: (progress: PersonalImageArchiveProgress) => void = () => undefined,
  runtime: PersonalImageArchiveRuntime = {},
): Promise<PersonalImageArchiveResult> {
  assertPlan(plan);
  signal.throwIfAborted();

  const maxAttempts = runtime.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("Image download attempts must be an integer between 1 and 10.");
  }

  if (!runtime.writable && plan.knownBytes >= PERSONAL_IMAGE_ARCHIVE_BLOB_LIMIT_BYTES) {
    throw browserMemoryLimitError();
  }
  const sink: ArchiveByteSink = runtime.writable
    ? writableStreamSink(runtime.writable)
    : blobSink(PERSONAL_IMAGE_ARCHIVE_BLOB_LIMIT_BYTES);
  const fetcher = runtime.fetch ?? globalThis.fetch.bind(globalThis);
  const wait = runtime.wait ?? abortableWait;
  const [{ Zip, ZipPassThrough }, { sha256 }, { bytesToHex }] = await Promise.all([
    import("fflate"),
    import("@noble/hashes/sha2.js"),
    import("@noble/hashes/utils.js"),
  ]);
  const output = new ZipOutput(sink);
  const archive = new Zip((error, data, final) => output.receive(error, data, final));
  const downloadedEntries: DownloadedEntry[] = [];
  const generatedAt = new Date(plan.generatedAt);
  let downloadedBytes = 0;
  let completedFiles = 0;
  let currentPath: string | null = null;
  let lastReportedBytes = -PROGRESS_BYTE_INTERVAL;

  const report = (force = false): void => {
    if (!force && downloadedBytes - lastReportedBytes < PROGRESS_BYTE_INTERVAL) return;
    lastReportedBytes = downloadedBytes;
    onProgress({
      completedFiles,
      totalFiles: plan.count,
      downloadedBytes,
      currentPath,
    });
  };

  try {
    report(true);
    addTextEntry(archive, ZipPassThrough, "README.md", imageArchiveReadme(plan), generatedAt);
    await output.drain();

    for (const entry of plan.entries) {
      signal.throwIfAborted();
      currentPath = entry.path;
      report(true);

      const response = await fetchImageResponse(entry, signal, fetcher, wait, maxAttempts);
      let responseMetadata: ReturnType<typeof validateImageResponse>;
      try {
        responseMetadata = validateImageResponse(response, entry);
      } catch (cause) {
        await response.body?.cancel(cause).catch(() => undefined);
        throw cause;
      }
      const zipEntry = new ZipPassThrough(entry.path);
      zipEntry.mtime = generatedAt;
      archive.add(zipEntry);

      let entryBytes = 0;
      const entryHasher = sha256.create();
      const reader = response.body!.getReader();
      try {
        for (;;) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          if (entryBytes + value.byteLength >= MAX_CLASSIC_ZIP_BYTES) {
            throw new Error(`${entry.path} exceeds this browser ZIP format's 4 GiB file limit.`);
          }
          entryBytes += value.byteLength;
          downloadedBytes += value.byteLength;
          entryHasher.update(value);
          zipEntry.push(value, false);
          await output.drain();
          report();
        }
      } catch (cause) {
        await reader.cancel(cause).catch(() => undefined);
        throw cause;
      } finally {
        reader.releaseLock();
      }

      if (entryBytes === 0) {
        throw new Error(`${entry.path} returned an empty image.`);
      }
      if (
        responseMetadata.contentLength !== null &&
        entryBytes !== responseMetadata.contentLength
      ) {
        throw new Error(`${entry.path} ended before its declared Content-Length.`);
      }
      if (entry.expectedBytes !== null && entryBytes !== entry.expectedBytes) {
        throw new Error(`${entry.path} does not match its archived byte length.`);
      }
      const observedSha256 = bytesToHex(entryHasher.digest());
      if (entry.sha256 !== null && observedSha256 !== entry.sha256) {
        throw new Error(`${entry.path} does not match its content-addressed SHA-256.`);
      }

      zipEntry.push(new Uint8Array(), true);
      await output.drain();
      completedFiles += 1;
      downloadedEntries.push({
        path: entry.path,
        url: entry.url,
        bytes: entryBytes,
        contentType: responseMetadata.contentType,
        etag: response.headers.get("ETag"),
        sha256: observedSha256,
        expectedSha256: entry.sha256,
        references: entry.references,
      });
      report(true);
    }

    currentPath = null;
    addTextEntry(
      archive,
      ZipPassThrough,
      "media-manifest.json",
      `${JSON.stringify(imageArchiveManifest(plan, downloadedEntries), null, 2)}\n`,
      generatedAt,
    );
    archive.end();
    await output.drain();
    if (!output.finalChunkSeen) {
      throw new Error("The image ZIP compressor did not finish the archive.");
    }
    signal.throwIfAborted();
    await sink.close();
    report(true);
    return {
      blob: sink.toBlob(),
      fileCount: plan.count,
      downloadedBytes,
      archiveBytes: output.bytes,
    };
  } catch (cause) {
    archive.terminate();
    await sink.abort(cause).catch(() => undefined);
    throw cause;
  }
}

export function personalImageArchiveFilename(address: string): string {
  const normalized = address.toLowerCase();
  const safeAddress = /^0x[0-9a-f]{40}$/.test(normalized)
    ? `${normalized.slice(0, 8)}-${normalized.slice(-6)}`
    : "public-address";
  return `poapin-all-images-${safeAddress}.zip`;
}

function addCollectionMedia(
  add: (
    rawUrl: string | null | undefined,
    category: PersonalImageArchiveCategory,
    reference: Omit<PersonalImageArchiveReference, "category">,
    validator: (value: string) => ValidatedMediaUrl | null,
    expectedBytes?: number | null,
    expectedContentType?: string | null,
    expectedSha256?: string | null,
  ) => void,
  media: CollectionMedia,
  collectionId: string,
  validator: (value: string) => ValidatedMediaUrl | null,
): void {
  add(
    media.objectUrl,
    "collections",
    {
      kind: "collection-media",
      ownerId: collectionId,
      context: media.role,
    },
    validator,
    media.byteLength,
    media.contentType,
    media.sha256,
  );
}

function addOwnedCollectionDropImages(
  add: (
    rawUrl: string | null | undefined,
    category: PersonalImageArchiveCategory,
    reference: Omit<PersonalImageArchiveReference, "category">,
    validator: (value: string) => ValidatedMediaUrl | null,
  ) => void,
  owned: OwnedCollectionArchive,
  snapshots: PersonalImageArchivePlan["snapshots"],
): void {
  for (const segment of ["items", "artist-drops", "suggestions"] as const) {
    for (const item of owned.segments[segment] ?? []) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const drop = record.drop;
      if (!drop || typeof drop !== "object") continue;
      const dropRecord = drop as Record<string, unknown>;
      if (dropRecord.isHidden === true || dropRecord.isPrivate === true) continue;
      const dropId = dropRecord.dropId;
      const imageUrl = dropRecord.imageUrl;
      if (!Number.isSafeInteger(dropId) || (typeof imageUrl !== "string" && imageUrl !== null)) {
        continue;
      }
      add(
        imageUrl as string | null,
        "collections",
        {
          kind: "collection-drop-artwork",
          ownerId: String(dropId),
          context: `${owned.collectionId}:${segment}`,
        },
        (value) =>
          validateCollectionDropUrl(
            value,
            snapshots.holdings,
            snapshots.collections,
            dropId as number,
          ),
      );
    }
  }
}

function addMomentImages(
  add: (
    rawUrl: string | null | undefined,
    category: PersonalImageArchiveCategory,
    reference: Omit<PersonalImageArchiveReference, "category">,
    validator: (value: string) => ValidatedMediaUrl | null,
    expectedBytes?: number | null,
    expectedContentType?: string | null,
  ) => void,
  moments: MomentDetail[],
  scope: "authored" | "tagged",
  snapshotId: string,
): void {
  const validator = (value: string) => validateMomentImageUrl(value, snapshotId);
  for (const moment of moments) {
    if (moment.previewMedia) {
      if (moment.previewMedia.kind === "image") {
        addMomentPreview(add, moment, moment.previewMedia, scope, validator);
      }
      add(
        moment.previewMedia.thumbnailUrl,
        "moments",
        {
          kind: "moment-thumbnail",
          ownerId: moment.momentId,
          context: `${scope}:${moment.previewMedia.mediaId}`,
        },
        validator,
      );
    }
    for (const media of moment.media) {
      if (media.kind === "image") {
        add(
          media.url,
          "moments",
          {
            kind: "moment-media",
            ownerId: moment.momentId,
            context: `${scope}:${media.mediaId}`,
          },
          validator,
          media.byteLength,
          media.mimeType,
        );
      }
      add(
        media.thumbnailUrl,
        "moments",
        {
          kind: "moment-thumbnail",
          ownerId: moment.momentId,
          context: `${scope}:${media.mediaId}`,
        },
        validator,
      );
    }
    for (const link of moment.links) {
      add(
        link.imageUrl,
        "moments",
        {
          kind: "moment-link-image",
          ownerId: moment.momentId,
          context: `${scope}:${link.linkId}`,
        },
        validator,
      );
    }
    for (const capsule of moment.capsules) {
      add(
        capsule.imageUrl,
        "moments",
        {
          kind: "moment-capsule-image",
          ownerId: moment.momentId,
          context: `${scope}:${capsule.capsuleId}`,
        },
        validator,
      );
    }
  }
}

function addMomentPreview(
  add: (
    rawUrl: string | null | undefined,
    category: PersonalImageArchiveCategory,
    reference: Omit<PersonalImageArchiveReference, "category">,
    validator: (value: string) => ValidatedMediaUrl | null,
    expectedBytes?: number | null,
    expectedContentType?: string | null,
  ) => void,
  moment: MomentDetail,
  preview: MomentMediaPreview,
  scope: "authored" | "tagged",
  validator: (value: string) => ValidatedMediaUrl | null,
): void {
  add(
    preview.url,
    "moments",
    {
      kind: "moment-preview",
      ownerId: moment.momentId,
      context: `${scope}:${preview.mediaId}`,
    },
    validator,
    null,
    preview.mimeType,
  );
}

function addCapsuleImage(
  add: (
    rawUrl: string | null | undefined,
    category: PersonalImageArchiveCategory,
    reference: Omit<PersonalImageArchiveReference, "category">,
    validator: (value: string) => ValidatedMediaUrl | null,
  ) => void,
  capsule: MomentCapsule,
  snapshotId: string,
  kind: "owned-capsule-image",
): void {
  add(capsule.imageUrl, "capsules", { kind, ownerId: String(capsule.capsuleId) }, (value) =>
    validateMomentImageUrl(value, snapshotId),
  );
}

function validateDropArtworkUrl(
  value: string,
  snapshotId: string,
  expectedDropId: number,
): ValidatedMediaUrl | null {
  const url = parseCanonicalMediaUrl(value);
  if (!url) return null;
  const segments = url.pathname.split("/");
  if (
    segments.length !== 5 ||
    segments[1] !== "snapshots" ||
    segments[2] !== snapshotId ||
    segments[3] !== "artwork"
  ) {
    return null;
  }
  const match = /^([1-9][0-9]*)\.webp$/.exec(segments[4] ?? "");
  if (!match || !POSITIVE_INTEGER.test(match[1])) return null;
  const dropId = Number(match[1]);
  if (!Number.isSafeInteger(dropId) || dropId !== expectedDropId) return null;
  return validatedMediaUrl(url, "webp", null);
}

function validateCollectionUrl(
  value: string,
  snapshotId: string,
  family: "media" | "drop-artwork",
): ValidatedMediaUrl | null {
  const url = parseCanonicalMediaUrl(value);
  if (!url) return null;
  const segments = url.pathname.split("/");
  if (
    segments.length !== 8 ||
    segments[1] !== "snapshots" ||
    segments[2] !== snapshotId ||
    segments[3] !== "collections" ||
    segments[4] !== family ||
    segments[5] !== "sha256" ||
    !/^[0-9a-f]{2}$/.test(segments[6] ?? "")
  ) {
    return null;
  }
  const match = /^([0-9a-f]{64})\.([a-z0-9]+)$/.exec(segments[7] ?? "");
  if (
    !match ||
    segments[6] !== match[1].slice(0, 2) ||
    !COLLECTION_IMAGE_EXTENSIONS.has(match[2])
  ) {
    return null;
  }
  return validatedMediaUrl(url, match[2], match[1]);
}

function validateCollectionDropUrl(
  value: string,
  holdingsSnapshotId: string,
  collectionsSnapshotId: string,
  dropId: number,
): ValidatedMediaUrl | null {
  return (
    validateDropArtworkUrl(value, holdingsSnapshotId, dropId) ??
    validateCollectionUrl(value, collectionsSnapshotId, "drop-artwork")
  );
}

function validateMomentImageUrl(value: string, snapshotId: string): ValidatedMediaUrl | null {
  const url = parseCanonicalMediaUrl(value);
  if (!url) return null;
  const segments = url.pathname.split("/");
  if (
    segments.length !== 8 ||
    segments[1] !== "snapshots" ||
    segments[2] !== snapshotId ||
    segments[3] !== "moments" ||
    (segments[4] !== "original" && segments[4] !== "thumbnail") ||
    segments[5] !== "sha256" ||
    !/^[0-9a-f]{2}$/.test(segments[6] ?? "")
  ) {
    return null;
  }
  const match = /^([0-9a-f]{64})\.([a-z0-9]+)$/.exec(segments[7] ?? "");
  if (!match || segments[6] !== match[1].slice(0, 2)) return null;
  if (segments[4] === "thumbnail" ? match[2] !== "webp" : !MOMENT_IMAGE_EXTENSIONS.has(match[2])) {
    return null;
  }
  return validatedMediaUrl(url, match[2], match[1]);
}

function parseCanonicalMediaUrl(value: string): URL | null {
  if (value.length === 0 || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== MEDIA_ORIGIN ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.toString() !== value
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function validatedMediaUrl(url: URL, extension: string, sha256: string | null): ValidatedMediaUrl {
  return {
    url: url.toString(),
    path: `images${url.pathname}`,
    extension,
    sha256,
  };
}

function mergeExpectedMetadata(
  entry: MutableArchiveEntry,
  expectedBytes: number | null,
  expectedContentType: string | null,
  media: ValidatedMediaUrl,
): void {
  if (
    entry.expectedBytes !== null &&
    expectedBytes !== null &&
    entry.expectedBytes !== expectedBytes
  ) {
    throw new Error(`An archived image has conflicting byte lengths: ${media.path}`);
  }
  if (entry.expectedBytes === null) entry.expectedBytes = expectedBytes;
  if (
    entry.expectedContentType !== null &&
    expectedContentType !== null &&
    entry.expectedContentType !== expectedContentType
  ) {
    throw new Error(`An archived image has conflicting content types: ${media.path}`);
  }
  if (entry.expectedContentType === null) entry.expectedContentType = expectedContentType;
  if (entry.sha256 !== media.sha256) {
    throw new Error(`An archived image has conflicting SHA-256 paths: ${media.path}`);
  }
}

function normalizeExpectedBytes(value: number | null | undefined): number | null {
  if (value === null || value === undefined || value === 0) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value >= MAX_CLASSIC_ZIP_BYTES) {
    throw new Error("An archived image has an invalid byte length.");
  }
  return value;
}

function normalizeExpectedContentType(
  value: string | null | undefined,
  extension: string,
): string | null {
  if (!value) return null;
  const contentType = normalizeContentType(value);
  return contentType && contentTypesForExtension(extension).has(contentType) ? contentType : null;
}

function normalizeContentType(value: string): string | null {
  const contentType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType) ? contentType : null;
}

function contentTypesForExtension(extension: string): ReadonlySet<string> {
  switch (extension) {
    case "jpg":
      return new Set(["image/jpeg", "image/jpg"]);
    case "png":
      return new Set(["image/png"]);
    case "gif":
      return new Set(["image/gif"]);
    case "webp":
      return new Set(["image/webp"]);
    case "avif":
      return new Set(["image/avif"]);
    case "heic":
      return new Set(["image/heic", "image/heif"]);
    case "dng":
      return new Set(["image/dng", "image/x-adobe-dng"]);
    default:
      return new Set();
  }
}

function assertSnapshotIdentity(snapshot: PersonalArchiveSnapshot): void {
  if (
    snapshot.schemaVersion !== "poapin-personal-site-source-v1" ||
    snapshot.manifest.schemaVersion !== "poapin-personal-export-v1" ||
    snapshot.address !== snapshot.manifest.address
  ) {
    throw new Error("The personal archive snapshot identity is invalid.");
  }
  const { holdings, collections, moments } = snapshot.manifest.snapshots;
  const catalog = snapshot.manifest.snapshots.catalog ?? holdings;
  const catalogSource = snapshot.manifest.sources.catalog?.snapshotId ?? holdings;
  if (
    !SNAPSHOT_ID.test(catalog) ||
    !SNAPSHOT_ID.test(holdings) ||
    !SNAPSHOT_ID.test(collections) ||
    !SNAPSHOT_ID.test(moments) ||
    catalogSource !== catalog ||
    snapshot.manifest.sources.holdings.snapshotId !== holdings ||
    snapshot.manifest.sources.collections.snapshotId !== collections ||
    snapshot.manifest.sources.moments.snapshotId !== moments ||
    !Number.isFinite(Date.parse(snapshot.generatedAt))
  ) {
    throw new Error("The personal archive uses an invalid or inconsistent release identity.");
  }
}

function assertPlan(plan: PersonalImageArchivePlan): void {
  if (
    plan.schemaVersion !== "poapin-personal-image-archive-plan-v1" ||
    plan.count !== plan.entries.length ||
    !/^0x[0-9a-f]{40}$/.test(plan.address) ||
    !Number.isSafeInteger(plan.knownBytes) ||
    plan.knownBytes < 0 ||
    plan.knownBytes >= MAX_CLASSIC_ZIP_BYTES ||
    !Number.isFinite(Date.parse(plan.generatedAt)) ||
    !SNAPSHOT_ID.test(plan.snapshots.holdings) ||
    !SNAPSHOT_ID.test(plan.snapshots.collections) ||
    !SNAPSHOT_ID.test(plan.snapshots.moments)
  ) {
    throw new Error("The personal image archive plan is invalid.");
  }
  assertClassicZipFileCount(plan.entries.length);
  const paths = new Set<string>();
  const urls = new Set<string>();
  const breakdown: Record<PersonalImageArchiveCategory, number> = {
    poaps: 0,
    collections: 0,
    moments: 0,
    capsules: 0,
  };
  let knownBytes = 0;
  let unknownByteLengthCount = 0;
  for (const entry of plan.entries) {
    const validated = validatePlannedUrl(entry.url, plan.snapshots);
    const normalizedBytes = normalizeExpectedBytes(entry.expectedBytes);
    const normalizedContentType = validated
      ? normalizeExpectedContentType(entry.expectedContentType, validated.extension)
      : null;
    if (
      !validated ||
      paths.has(entry.path) ||
      urls.has(entry.url) ||
      entry.path !== validated.path ||
      entry.sha256 !== validated.sha256 ||
      !entry.path.startsWith("images/snapshots/") ||
      normalizedBytes !== entry.expectedBytes ||
      normalizedContentType !== entry.expectedContentType ||
      !IMAGE_CATEGORIES.includes(entry.category) ||
      entry.references.length === 0 ||
      entry.references.some(
        (reference) =>
          !IMAGE_CATEGORIES.includes(reference.category) ||
          typeof reference.ownerId !== "string" ||
          reference.ownerId.length === 0,
      )
    ) {
      throw new Error("The personal image archive plan contains an unsafe or repeated entry.");
    }
    paths.add(entry.path);
    urls.add(entry.url);
    breakdown[entry.category] += 1;
    if (entry.expectedBytes === null) unknownByteLengthCount += 1;
    else knownBytes += entry.expectedBytes;
  }
  if (
    knownBytes !== plan.knownBytes ||
    unknownByteLengthCount !== plan.unknownByteLengthCount ||
    IMAGE_CATEGORIES.some((category) => breakdown[category] !== plan.breakdown[category])
  ) {
    throw new Error("The personal image archive plan totals are inconsistent.");
  }
}

function validatePlannedUrl(
  value: string,
  snapshots: PersonalImageArchivePlan["snapshots"],
): ValidatedMediaUrl | null {
  const url = parseCanonicalMediaUrl(value);
  if (!url) return null;
  const artworkMatch = /^\/snapshots\/[^/]+\/artwork\/([1-9][0-9]*)\.webp$/.exec(url.pathname);
  if (artworkMatch) {
    const dropId = Number(artworkMatch[1]);
    if (Number.isSafeInteger(dropId)) {
      return validateDropArtworkUrl(value, snapshots.holdings, dropId);
    }
  }
  return (
    validateCollectionUrl(value, snapshots.collections, "media") ??
    validateCollectionUrl(value, snapshots.collections, "drop-artwork") ??
    validateMomentImageUrl(value, snapshots.moments)
  );
}

function assertClassicZipFileCount(imageCount: number): void {
  if (
    !Number.isSafeInteger(imageCount) ||
    imageCount < 0 ||
    imageCount + METADATA_FILE_COUNT >= MAX_CLASSIC_ZIP_FILES
  ) {
    throw new Error("The image set exceeds this browser ZIP format's 65,535-file limit.");
  }
}

async function fetchImageResponse(
  entry: PersonalImageArchiveEntry,
  signal: AbortSignal,
  fetcher: NonNullable<PersonalImageArchiveRuntime["fetch"]>,
  wait: NonNullable<PersonalImageArchiveRuntime["wait"]>,
  maxAttempts: number,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    signal.throwIfAborted();
    try {
      const response = await fetcher(entry.url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        redirect: "error",
        signal,
      });
      if (response.ok) return response;
      if (!isRetryableStatus(response.status) || attempt === maxAttempts) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`${entry.path} returned HTTP ${response.status}.`);
      }
      const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
      await response.body?.cancel().catch(() => undefined);
      await wait(retryAfter ?? retryDelay(attempt), signal);
      continue;
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      lastError = cause;
      if (cause instanceof Error && /returned HTTP \d+\.$/.test(cause.message)) throw cause;
      if (attempt === maxAttempts) break;
      await wait(retryDelay(attempt), signal);
    }
  }
  throw new Error(`${entry.path} could not be downloaded after ${maxAttempts} attempts.`, {
    cause: lastError,
  });
}

function validateImageResponse(
  response: Response,
  entry: PersonalImageArchiveEntry,
): { contentLength: number | null; contentType: string | null } {
  if (
    response.status !== 200 ||
    !response.body ||
    response.redirected ||
    response.type === "opaqueredirect" ||
    (response.url !== "" && response.url !== entry.url)
  ) {
    throw new Error(`${entry.path} did not return the requested archived image directly.`);
  }

  const rawContentLength = response.headers.get("Content-Length");
  if (rawContentLength === null || !/^[1-9][0-9]*$/.test(rawContentLength)) {
    throw new Error(`${entry.path} returned a missing or invalid Content-Length.`);
  }
  const contentLength = Number(rawContentLength);
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength >= MAX_CLASSIC_ZIP_BYTES
  ) {
    throw new Error(`${entry.path} returned an unsupported Content-Length.`);
  }
  if (entry.expectedBytes !== null && contentLength !== entry.expectedBytes) {
    throw new Error(`${entry.path} does not match its archived byte length.`);
  }

  const rawContentType = response.headers.get("Content-Type");
  const contentType = rawContentType ? normalizeContentType(rawContentType) : null;
  const extension = entry.path.split(".").pop() ?? "";
  if (!contentType || !contentTypesForExtension(extension).has(contentType)) {
    throw new Error(`${entry.path} returned a non-image or mismatched Content-Type.`);
  }
  if (
    entry.expectedContentType !== null &&
    contentType !== null &&
    contentType !== entry.expectedContentType &&
    !(
      contentTypesForExtension(extension).has(contentType) &&
      contentTypesForExtension(extension).has(entry.expectedContentType)
    )
  ) {
    throw new Error(`${entry.path} does not match its archived Content-Type.`);
  }
  return { contentLength, contentType };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelay(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 4_000);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1_000), MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS);
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(done, milliseconds);
    signal.addEventListener("abort", abort, { once: true });

    function done(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }

    function abort(): void {
      globalThis.clearTimeout(timeout);
      reject(signal.reason);
    }
  });
}

function addTextEntry(
  archive: InstanceType<(typeof import("fflate"))["Zip"]>,
  ZipPassThrough: (typeof import("fflate"))["ZipPassThrough"],
  path: string,
  content: string,
  mtime: Date,
): void {
  const entry = new ZipPassThrough(path);
  entry.mtime = mtime;
  archive.add(entry);
  entry.push(new TextEncoder().encode(content), true);
}

function imageArchiveReadme(plan: PersonalImageArchivePlan): string {
  return `# POAPin archived images

This ZIP contains ${plan.count.toLocaleString("en-US")} unique public image files referenced by the immutable POAPin archive snapshots for ${plan.address}.

- Generated: ${plan.generatedAt}
- Holdings snapshot: ${plan.snapshots.holdings}
- Collections snapshot: ${plan.snapshots.collections}
- Moments snapshot: ${plan.snapshots.moments}

Images keep their immutable media.poap.in object paths under the images/ directory. media-manifest.json preserves every source reference and the byte count observed during download.

POAPin: https://poap.in
Source: https://github.com/glorylab/poapin-archive
`;
}

function imageArchiveManifest(
  plan: PersonalImageArchivePlan,
  entries: DownloadedEntry[],
): Record<string, unknown> {
  return {
    schemaVersion: "poapin-personal-image-archive-v1",
    address: plan.address,
    generatedAt: plan.generatedAt,
    snapshots: plan.snapshots,
    counts: {
      images: entries.length,
      downloadedBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      breakdown: plan.breakdown,
    },
    policies: {
      publicArchivedImagesOnly: true,
      videosIncluded: false,
      audioIncluded: false,
      compression: "store",
      sha256CalculatedForEveryImage: true,
      contentAddressedSha256Verified: true,
    },
    entries,
  };
}

class ZipOutput {
  readonly sink: ArchiveByteSink;
  bytes = 0;
  finalChunkSeen = false;
  private pending: Promise<void> = Promise.resolve();
  private error: Error | null = null;

  constructor(sink: ArchiveByteSink) {
    this.sink = sink;
  }

  receive(error: Error | null, data: Uint8Array, final: boolean): void {
    if (this.error) return;
    if (error) {
      this.error = error;
      return;
    }
    if (this.bytes + data.byteLength >= MAX_CLASSIC_ZIP_BYTES) {
      this.error = new Error("The image ZIP exceeds this browser ZIP format's 4 GiB limit.");
      return;
    }
    this.bytes += data.byteLength;
    if (final) this.finalChunkSeen = true;
    if (data.byteLength === 0) return;
    const owned = ownBytes(data);
    this.pending = this.pending
      .then(() => this.sink.write(owned))
      .catch((cause) => {
        this.error = toError(cause, "The image ZIP could not be written.");
      });
  }

  async drain(): Promise<void> {
    await this.pending;
    if (this.error) throw this.error;
  }
}

function blobSink(maxBytes: number): ArchiveByteSink {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  return {
    async write(chunk) {
      if (bytes + chunk.byteLength > maxBytes) throw browserMemoryLimitError();
      bytes += chunk.byteLength;
      chunks.push(chunk);
    },
    async close() {
      return undefined;
    },
    async abort() {
      chunks.length = 0;
      bytes = 0;
    },
    toBlob() {
      return new Blob(chunks, { type: "application/zip" });
    },
  };
}

function browserMemoryLimitError(): Error {
  return new Error(
    "This browser cannot safely hold an image ZIP larger than 256 MiB in memory. Use current desktop Chrome or Edge to stream a larger archive directly to disk.",
  );
}

function writableStreamSink(stream: WritableStream<Uint8Array>): ArchiveByteSink {
  const writer = stream.getWriter();
  return {
    async write(chunk) {
      await writer.write(chunk);
    },
    async close() {
      await writer.close();
    },
    async abort(reason) {
      await writer.abort(reason);
    },
    toBlob() {
      return null;
    },
  };
}

function ownBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return data.slice() as Uint8Array<ArrayBuffer>;
}

function toError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}
