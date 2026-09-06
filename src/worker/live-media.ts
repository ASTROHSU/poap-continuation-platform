import type { D1ReadClient } from "./types";

interface LiveMediaRow {
  slug: string;
  image_url: string;
}

export interface LiveMediaReadiness {
  ready: boolean;
  publishedEvents: number;
  managedArtwork: number;
  unmanagedArtwork: number;
  unavailable: Array<{
    slug: string;
    imageUrl: string;
    reason: "invalid_reference" | "missing_object" | "invalid_content_type";
  }>;
}

const LIVE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;
const LIVE_ARTWORK_PATTERN = /^artwork(?:-[a-z0-9][a-z0-9-]{0,63})?\.(?:png|jpe?g|webp|gif|svg)$/;

export function normalizeLiveMediaFilename(value: string): string | null {
  return value === "metadata.json" || LIVE_ARTWORK_PATTERN.test(value) ? value : null;
}

export function liveArtworkObjectKey(slug: string, imageUrl: string): string | null {
  if (!LIVE_SLUG_PATTERN.test(slug)) return null;
  const prefix = `/media/live/events/${slug}/`;
  if (!imageUrl.startsWith(prefix)) return null;
  const filename = imageUrl.slice(prefix.length);
  if (!normalizeLiveMediaFilename(filename) || filename === "metadata.json") return null;
  return `live/events/${slug}/${filename}`;
}

export async function fetchLiveMediaReadiness(
  db: D1ReadClient,
  bucket: R2Bucket,
): Promise<LiveMediaReadiness> {
  const result = await db
    .prepare(
      `SELECT slug, image_url
       FROM live_events
       WHERE status IN ('published', 'closed')
       ORDER BY slug`,
    )
    .all<LiveMediaRow>();
  const rows = result.results ?? [];
  let unmanagedArtwork = 0;
  const managed: Array<{ row: LiveMediaRow; objectKey: string | null }> = [];
  for (const row of rows) {
    const objectKey = liveArtworkObjectKey(row.slug, row.image_url);
    if (!objectKey) {
      if (!row.image_url.startsWith("/media/live/")) unmanagedArtwork += 1;
      if (row.image_url.startsWith("/media/live/")) managed.push({ row, objectKey: null });
      continue;
    }
    managed.push({ row, objectKey });
  }
  const unavailable = (
    await Promise.all(
      managed.map(async ({ row, objectKey }) => {
        if (!objectKey) {
          return { slug: row.slug, imageUrl: row.image_url, reason: "invalid_reference" as const };
        }
        const object = await bucket.head(objectKey);
        if (!object) {
          return { slug: row.slug, imageUrl: row.image_url, reason: "missing_object" as const };
        }
        if (!object.httpMetadata?.contentType?.startsWith("image/")) {
          return {
            slug: row.slug,
            imageUrl: row.image_url,
            reason: "invalid_content_type" as const,
          };
        }
        return null;
      }),
    )
  ).filter((item): item is NonNullable<typeof item> => item !== null);
  return {
    ready: unavailable.length === 0,
    publishedEvents: rows.length,
    managedArtwork: managed.length,
    unmanagedArtwork,
    unavailable,
  };
}
