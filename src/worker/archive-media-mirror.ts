import { ApiError } from "./validation";

export const PUBLIC_ARCHIVE_MEDIA_ORIGIN = "https://media.poap.in";

const MAX_BATCH_SIZE = 18;
// Cloudflare Workers Paid permits six simultaneous outgoing connections per
// request. Each transfer streams source-to-R2 without buffering, so six
// parallel objects gives the migration useful throughput while staying inside
// that documented limit.
const COPY_CONCURRENCY = 6;
const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
};

export type ArchiveMediaMirrorRow = {
  drop_id: number;
  object_key: string;
  sha256: string;
  byte_length: number;
  content_type: string;
};

export type ArchiveMediaMirrorResult = {
  afterDropId: number;
  nextAfterDropId: number;
  complete: boolean;
  scanned: number;
  copied: number;
  skipped: number;
  bytesCopied: number;
};

type MirrorBindings = {
  HOLDINGS_DB: D1Database;
  ARCHIVE_MEDIA_BUCKET: R2Bucket;
  HOLDINGS_SNAPSHOT_ID: string;
  COLLECTIONS_SNAPSHOT_ID: string;
};

type ScheduledMirrorBindings = MirrorBindings & {
  ARCHIVE_BUCKET: R2Bucket;
  ARCHIVE_MEDIA_MIRROR_ENABLED?: string;
};

const SCHEDULED_MIRROR_STATE_KEY = "maintenance/archive-media-mirror-v1.json";

type ScheduledMirrorState = {
  schemaVersion: 1;
  afterDropId: number;
  complete: boolean;
  copied: number;
  skipped: number;
  bytesCopied: number;
  batches: number;
  updatedAt: string;
};

/**
 * Copies one bounded page of content-addressed, public supplemental artwork
 * from the release origin into the project's R2 bucket. Bodies are streamed
 * directly between Cloudflare services; they are never buffered in the Worker
 * or written to the operator's computer.
 */
export async function mirrorArchiveMediaBatch(
  env: MirrorBindings,
  afterDropId: number,
  requestedLimit: number | undefined,
  untilDropId: number | undefined,
): Promise<ArchiveMediaMirrorResult> {
  const limit = normalizeLimit(requestedLimit);
  const statement = untilDropId
    ? env.HOLDINGS_DB.prepare(
        `SELECT drop_id, object_key, sha256, byte_length, content_type
         FROM holding_drop_artwork
         WHERE drop_id > ?1 AND drop_id <= ?2
         ORDER BY drop_id
         LIMIT ?3`,
      ).bind(afterDropId, untilDropId, limit)
    : env.HOLDINGS_DB.prepare(
        `SELECT drop_id, object_key, sha256, byte_length, content_type
         FROM holding_drop_artwork
         WHERE drop_id > ?1
         ORDER BY drop_id
         LIMIT ?2`,
      ).bind(afterDropId, limit);
  const rows = await statement.all<ArchiveMediaMirrorRow>();
  const items = rows.results ?? [];

  const outcomes = await mapWithConcurrency(items, COPY_CONCURRENCY, async (row) =>
    mirrorOneArchiveMediaObject(env, row),
  );
  const failures = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (failures.length > 0) {
    console.error("Archive media mirror batch failed", {
      afterDropId,
      failed: failures.length,
      message: failureMessage(failures[0]?.reason),
    });
    throw new ApiError(
      502,
      "Archive media mirror batch did not complete. Retry the same cursor.",
      "archive_media_mirror_incomplete",
    );
  }

  const complete =
    items.length < limit ||
    (untilDropId !== undefined && (items.at(-1)?.drop_id ?? afterDropId) >= untilDropId);
  const copied = outcomes.filter(
    (outcome) => outcome.status === "fulfilled" && outcome.value === "copied",
  ).length;
  const skipped = outcomes.filter(
    (outcome) => outcome.status === "fulfilled" && outcome.value === "skipped",
  ).length;
  const bytesCopied = items
    .filter((_, index) => outcomes[index]?.status === "fulfilled" && outcomes[index].value === "copied")
    .reduce((sum, row) => sum + row.byte_length, 0);

  return {
    afterDropId,
    nextAfterDropId: items.at(-1)?.drop_id ?? afterDropId,
    complete,
    scanned: items.length,
    copied,
    skipped,
    bytesCopied,
  };
}

/**
 * Durable fallback for the one-time transfer. It advances a persisted cursor
 * every minute, so an interrupted local runner never leaves the project
 * dependent on the external media host. It is opt-in through a Worker var and
 * stops itself permanently once the final cursor is reached.
 */
export async function runScheduledArchiveMediaMirror(
  env: ScheduledMirrorBindings,
): Promise<{ enabled: boolean; complete: boolean; copied: number; skipped: number }> {
  if (env.ARCHIVE_MEDIA_MIRROR_ENABLED !== "true") {
    return { enabled: false, complete: false, copied: 0, skipped: 0 };
  }
  const state = await readScheduledMirrorState(env.ARCHIVE_BUCKET);
  if (state.complete) {
    return { enabled: true, complete: true, copied: 0, skipped: 0 };
  }
  const result = await mirrorArchiveMediaBatch(env, state.afterDropId, 18, undefined);
  const nextState: ScheduledMirrorState = {
    ...state,
    afterDropId: result.nextAfterDropId,
    complete: result.complete,
    copied: state.copied + result.copied,
    skipped: state.skipped + result.skipped,
    bytesCopied: state.bytesCopied + result.bytesCopied,
    batches: state.batches + 1,
    updatedAt: new Date().toISOString(),
  };
  await env.ARCHIVE_BUCKET.put(SCHEDULED_MIRROR_STATE_KEY, JSON.stringify(nextState), {
    httpMetadata: { contentType: "application/json", cacheControl: "private, no-store" },
  });
  return {
    enabled: true,
    complete: nextState.complete,
    copied: result.copied,
    skipped: result.skipped,
  };
}

async function mirrorOneArchiveMediaObject(
  env: MirrorBindings,
  row: ArchiveMediaMirrorRow,
): Promise<"copied" | "skipped"> {
  const expectedContentType = validateMirrorRow(
    row,
    env.HOLDINGS_SNAPSHOT_ID,
    env.COLLECTIONS_SNAPSHOT_ID,
  );
  const existing = await env.ARCHIVE_MEDIA_BUCKET.head(row.object_key);
  if (
    existing &&
    existing.size === row.byte_length &&
    existing.customMetadata?.sha256 === row.sha256 &&
    existing.httpMetadata?.contentType === expectedContentType
  ) {
    return "skipped";
  }

  const source = await fetch(`${PUBLIC_ARCHIVE_MEDIA_ORIGIN}/${encodeObjectKey(row.object_key)}`);
  if (!source.ok || !source.body) {
    throw new Error(`Source object ${row.drop_id} returned ${source.status}.`);
  }
  const sourceLength = source.headers.get("Content-Length");
  if (!sourceLength || !/^\d+$/.test(sourceLength) || Number(sourceLength) !== row.byte_length) {
    throw new Error(`Source object ${row.drop_id} did not match its recorded byte length.`);
  }
  if (source.headers.get("Content-Type")?.split(";", 1)[0] !== expectedContentType) {
    throw new Error(`Source object ${row.drop_id} did not match its recorded content type.`);
  }

  const uploaded = await env.ARCHIVE_MEDIA_BUCKET.put(row.object_key, source.body, {
    httpMetadata: {
      contentType: expectedContentType,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      sha256: row.sha256,
      source: "poapin-archive",
    },
  });
  if (!uploaded || uploaded.size !== row.byte_length || uploaded.customMetadata?.sha256 !== row.sha256) {
    throw new Error(`R2 rejected or truncated source object ${row.drop_id}.`);
  }
  return "copied";
}

export function validateMirrorRow(
  row: ArchiveMediaMirrorRow,
  holdingsSnapshotId: string,
  collectionsSnapshotId: string,
): string {
  if (
    !Number.isSafeInteger(row.drop_id) ||
    row.drop_id <= 0 ||
    !Number.isSafeInteger(row.byte_length) ||
    row.byte_length <= 0 ||
    !/^[0-9a-f]{64}$/.test(row.sha256)
  ) {
    throw new Error("Archive media mirror row is malformed.");
  }
  const segments = row.object_key.split("/");
  const isCollectionArtwork =
    segments.length === 7 &&
    segments[0] === "snapshots" &&
    segments[1] === collectionsSnapshotId &&
    segments[2] === "collections" &&
    segments[3] === "drop-artwork" &&
    segments[4] === "sha256";
  const isHoldingArtwork =
    segments.length === 7 &&
    segments[0] === "snapshots" &&
    segments[1] === holdingsSnapshotId &&
    segments[2] === "holdings" &&
    segments[3] === "drop-artwork" &&
    segments[4] === "sha256";
  const filename = segments[6] ?? "";
  const match = /^([0-9a-f]{64})\.(png|jpg|gif|webp|avif|heic)$/.exec(filename);
  if (
    (!isCollectionArtwork && !isHoldingArtwork) ||
    !match ||
    segments[5] !== row.sha256.slice(0, 2) ||
    match[1] !== row.sha256
  ) {
    throw new Error("Archive media mirror key is outside the active release.");
  }
  const expectedContentType = CONTENT_TYPES[match[2]];
  if (!expectedContentType || row.content_type !== expectedContentType) {
    throw new Error("Archive media mirror content type is invalid.");
  }
  return expectedContentType;
}

export function parseArchiveMediaMirrorRequest(value: unknown): {
  afterDropId: number;
  limit: number | undefined;
  untilDropId: number | undefined;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "Archive media mirror request is invalid.", "invalid_mirror_request");
  }
  const input = value as Record<string, unknown>;
  const afterDropId = input.afterDropId ?? 0;
  if (typeof afterDropId !== "number" || !Number.isSafeInteger(afterDropId) || afterDropId < 0) {
    throw new ApiError(400, "Archive media mirror cursor is invalid.", "invalid_mirror_cursor");
  }
  const rawLimit = input.limit;
  if (
    rawLimit !== undefined &&
    (typeof rawLimit !== "number" || !Number.isSafeInteger(rawLimit) || rawLimit < 1)
  ) {
    throw new ApiError(400, "Archive media mirror limit is invalid.", "invalid_mirror_limit");
  }
  const untilDropId = input.untilDropId;
  if (
    untilDropId !== undefined &&
    (typeof untilDropId !== "number" ||
      !Number.isSafeInteger(untilDropId) ||
      untilDropId <= afterDropId)
  ) {
    throw new ApiError(400, "Archive media mirror stop cursor is invalid.", "invalid_mirror_stop");
  }
  return {
    afterDropId,
    limit: rawLimit as number | undefined,
    untilDropId: untilDropId as number | undefined,
  };
}

function normalizeLimit(value: number | undefined): number {
  return Math.min(value ?? 12, MAX_BATCH_SIZE);
}

function encodeObjectKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function mapWithConcurrency<T, U>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<U>,
): Promise<PromiseSettledResult<U>[]> {
  const results: PromiseSettledResult<U>[] = new Array(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await operation(values[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function failureMessage(value: unknown): string {
  return value instanceof Error ? value.message : "unknown error";
}

async function readScheduledMirrorState(bucket: R2Bucket): Promise<ScheduledMirrorState> {
  const object = await bucket.get(SCHEDULED_MIRROR_STATE_KEY);
  if (!object) return emptyScheduledMirrorState();
  try {
    const state = await object.json<ScheduledMirrorState>();
    if (
      state.schemaVersion !== 1 ||
      !Number.isSafeInteger(state.afterDropId) ||
      state.afterDropId < 0 ||
      typeof state.complete !== "boolean" ||
      !Number.isSafeInteger(state.copied) ||
      !Number.isSafeInteger(state.skipped) ||
      !Number.isSafeInteger(state.bytesCopied) ||
      !Number.isSafeInteger(state.batches)
    ) {
      throw new Error("invalid state");
    }
    return state;
  } catch {
    throw new Error("Scheduled archive media mirror state is invalid.");
  }
}

function emptyScheduledMirrorState(): ScheduledMirrorState {
  return {
    schemaVersion: 1,
    afterDropId: 0,
    complete: false,
    copied: 0,
    skipped: 0,
    bytesCopied: 0,
    batches: 0,
    updatedAt: new Date(0).toISOString(),
  };
}
