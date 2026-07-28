import type { D1ReadClient, DropDetail, HoldingDropRow } from "./types";
import { holdingDropArtworkUrl } from "./media";
import { ApiError } from "./validation";

const LOOKUP_SIZE = 96;
const MAX_LOOKUP_IDS = 480;
const SNAPSHOT_ID_SQL = `
  SELECT value
  FROM archive_meta
  WHERE key = 'snapshot_id'`;
const DROP_COLUMNS = `
  d.drop_id,
  d.fancy_id,
  d.title,
  d.description,
  d.start_date,
  d.end_date,
  d.expiry_date,
  d.city,
  d.country,
  d.event_url,
  d.year,
  d.is_virtual,
  d.is_private,
  d.is_hidden,
  d.channel,
  d.platform,
  d.location_type,
  d.timezone,
  d.integrator_id,
  d.created_at,
  d.token_count,
  d.transfer_count,
  a.object_key AS image_object_key`;

type SnapshotIdRow = {
  value: string;
};

export type ExactHoldingDropLookup =
  { state: "available"; drop: DropDetail } | { state: "missing" };

/**
 * Resolves one explicitly requested ID. Private and hidden metadata is
 * available because the caller already supplied the exact Drop ID. Neither
 * category is added to public browse enumeration.
 */
export async function fetchExactHoldingDropDetail(
  db: D1ReadClient,
  dropId: number,
  snapshotId: string,
  mediaBaseUrl: string,
  archiveSnapshotId: string,
  collectionsSnapshotId: string,
): Promise<ExactHoldingDropLookup> {
  if (!Number.isSafeInteger(dropId) || dropId <= 0) {
    throw new ApiError(400, "Drop ID must be a positive integer.");
  }
  const [snapshot, detail] = await db.batch<SnapshotIdRow | HoldingDropRow>([
    db.prepare(SNAPSHOT_ID_SQL),
    db
      .prepare(
        `SELECT ${DROP_COLUMNS}
         FROM holding_drops d
         LEFT JOIN holding_drop_artwork a ON a.drop_id = d.drop_id
         WHERE d.drop_id = ?1
         LIMIT 1`,
      )
      .bind(dropId),
  ]);
  assertSnapshot(snapshot.results[0] as SnapshotIdRow | undefined, snapshotId);
  const row = detail.results[0] as HoldingDropRow | undefined;
  if (!row) return { state: "missing" };
  return {
    state: "available",
    drop: toHoldingDropDetail(
      row,
      mediaBaseUrl,
      archiveSnapshotId,
      snapshotId,
      collectionsSnapshotId,
    ),
  };
}

/**
 * Resolves only IDs already proven by the caller to belong to the requested
 * address. It is deliberately bounded and never used for public enumeration.
 */
export async function fetchHeldDropDetails(
  db: D1ReadClient,
  dropIds: number[],
  snapshotId: string,
  mediaBaseUrl: string,
  archiveSnapshotId: string,
  collectionsSnapshotId: string,
): Promise<Map<number, DropDetail>> {
  const uniqueIds = [
    ...new Set(dropIds.filter((dropId) => Number.isSafeInteger(dropId) && dropId > 0)),
  ];
  if (uniqueIds.length === 0) return new Map();
  if (uniqueIds.length > MAX_LOOKUP_IDS) {
    throw new ApiError(400, `Held-Drop lookups are limited to ${MAX_LOOKUP_IDS} IDs.`);
  }
  const statements: D1PreparedStatement[] = [db.prepare(SNAPSHOT_ID_SQL)];
  for (let offset = 0; offset < uniqueIds.length; offset += LOOKUP_SIZE) {
    const chunk = uniqueIds.slice(offset, offset + LOOKUP_SIZE);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(", ");
    statements.push(
      db
        .prepare(
          `SELECT ${DROP_COLUMNS}
           FROM holding_drops d
           LEFT JOIN holding_drop_artwork a ON a.drop_id = d.drop_id
           WHERE d.drop_id IN (${placeholders})
           ORDER BY d.drop_id`,
        )
        .bind(...chunk),
    );
  }
  const [snapshot, ...results] = await db.batch<SnapshotIdRow | HoldingDropRow>(statements);
  assertSnapshot(snapshot.results[0] as SnapshotIdRow | undefined, snapshotId);
  const allowed = new Set(uniqueIds);
  const drops = new Map<number, DropDetail>();
  for (const row of results.flatMap((result) => result.results as HoldingDropRow[])) {
    const dropId = numberValue(row.drop_id);
    if (!allowed.has(dropId) || drops.has(dropId)) {
      throw new ApiError(503, "Held-Drop lookup escaped its bounded ID set.");
    }
    drops.set(
      dropId,
      toHoldingDropDetail(row, mediaBaseUrl, archiveSnapshotId, snapshotId, collectionsSnapshotId),
    );
  }
  return drops;
}

/**
 * Keeps the richer address-bound presentation metadata while allowing a
 * verified Holdings object to fill an otherwise missing artwork reference.
 */
export function withFallbackArtwork(
  presentation: DropDetail,
  holding: DropDetail | undefined,
): DropDetail {
  if (presentation.hasArtwork || !holding?.hasArtwork) return presentation;
  return {
    ...presentation,
    imageUrl: holding.imageUrl,
    hasArtwork: true,
  };
}

function toHoldingDropDetail(
  row: HoldingDropRow,
  mediaBaseUrl: string,
  archiveSnapshotId: string,
  holdingsSnapshotId: string,
  collectionsSnapshotId: string,
): DropDetail {
  const dropId = numberValue(row.drop_id);
  const imageUrl = holdingDropArtworkUrl(
    mediaBaseUrl,
    row.image_object_key,
    archiveSnapshotId,
    holdingsSnapshotId,
    collectionsSnapshotId,
    dropId,
  );
  return {
    dropId,
    fancyId: row.fancy_id ?? "",
    title: row.title ?? `Archived Drop #${dropId}`,
    description: row.description,
    startDate: row.start_date ?? "",
    endDate: row.end_date ?? "",
    expiryDate: row.expiry_date,
    city: row.city,
    country: row.country,
    year: numberValue(row.year),
    isVirtual: row.is_virtual === null ? null : numberValue(row.is_virtual) === 1,
    eventUrl: safeExternalUrl(row.event_url),
    channel: row.channel,
    platform: row.platform,
    locationType: row.location_type,
    timezone: row.timezone,
    integratorId: row.integrator_id,
    createdAt: row.created_at ?? "",
    // Source media URLs remain preserved in the private backup/D1. Responses
    // expose only a verified immutable R2 object from an active snapshot.
    imageUrl: imageUrl ?? "",
    hasArtwork: imageUrl !== null,
    tokenCount: numberValue(row.token_count),
    dropTransferCount: numberValue(row.transfer_count),
    reservationsTotal: 0,
    reservationsMinted: 0,
    reservationsUnminted: 0,
    featuredOn: null,
    momentsUploaded: null,
    ...(numberValue(row.is_private) === 1 ? { isPrivate: true as const } : {}),
    ...(numberValue(row.is_hidden) === 1 ? { isHidden: true as const } : {}),
  };
}

function assertSnapshot(row: SnapshotIdRow | undefined, expected: string): void {
  if (!row?.value || row.value !== expected) {
    throw new ApiError(
      503,
      "Holdings snapshot metadata does not match this deployment.",
      "snapshot_mismatch",
    );
  }
}

function safeExternalUrl(value: string | null): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function numberValue(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
