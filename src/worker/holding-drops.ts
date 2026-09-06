import type { D1ReadClient, DropDetail, HoldingDropRow } from "./types";
import { holdingDropArtworkUrl } from "./media";
import { ApiError } from "./validation";

const LOOKUP_SIZE = 96;
const MAX_LOOKUP_IDS = 480;
const SNAPSHOT_ID_SQL = `
  SELECT value
  FROM archive_meta
  WHERE key = 'snapshot_id'`;
const ARTWORK_RELEASE_SQL = `
  SELECT key, value
  FROM archive_meta
  WHERE key IN (
    'artwork_release_id',
    'artwork_release_collections_snapshot_id',
    'artwork_release_sha256',
    'artwork_release_complete',
    'artwork_release_referenced_drops',
    'artwork_release_archive_direct',
    'artwork_release_activated_rows',
    'artwork_release_terminal_unavailable'
  )`;
const ARTWORK_COUNT_SQL = `
  SELECT COUNT(*) AS artwork_rows
  FROM holding_drop_artwork`;
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

type ArtworkReleaseRow = {
  key: string;
  value: string;
};

type ArtworkCountRow = {
  artwork_rows: number;
};

export interface HoldingsArtworkReadiness {
  ready: boolean;
  snapshotId: string;
  configuredReleaseId: string;
  configuredCollectionsSnapshotId: string;
  activeReleaseId: string | null;
  activeCollectionsSnapshotId: string | null;
  releaseSha256: string | null;
  referencedDrops: number | null;
  archiveDirect: number | null;
  activatedRows: number | null;
  terminalUnavailable: number | null;
  storedRows: number;
}

export type ExactHoldingDropLookup =
  { state: "available"; drop: DropDetail } | { state: "missing" };

export async function fetchHoldingsArtworkReadiness(
  db: D1ReadClient,
  snapshotId: string,
  configuredReleaseId: string,
  configuredCollectionsSnapshotId: string,
): Promise<HoldingsArtworkReadiness> {
  const [snapshot, release, count] = await db.batch<
    SnapshotIdRow | ArtworkReleaseRow | ArtworkCountRow
  >([db.prepare(SNAPSHOT_ID_SQL), db.prepare(ARTWORK_RELEASE_SQL), db.prepare(ARTWORK_COUNT_SQL)]);
  assertSnapshot(snapshot.results[0] as SnapshotIdRow | undefined, snapshotId);
  const rows = release.results as ArtworkReleaseRow[];
  const values = artworkReleaseValues(rows);
  const storedRows = numberValue((count.results[0] as ArtworkCountRow | undefined)?.artwork_rows);
  const activatedRows = nonNegativeInteger(values.get("artwork_release_activated_rows"));
  return {
    ready:
      isArtworkReleaseActive(rows, configuredReleaseId, configuredCollectionsSnapshotId) &&
      activatedRows !== null &&
      storedRows === activatedRows,
    snapshotId,
    configuredReleaseId,
    configuredCollectionsSnapshotId,
    activeReleaseId: values.get("artwork_release_id") ?? null,
    activeCollectionsSnapshotId: values.get("artwork_release_collections_snapshot_id") ?? null,
    releaseSha256: values.get("artwork_release_sha256") ?? null,
    referencedDrops: positiveInteger(values.get("artwork_release_referenced_drops")),
    archiveDirect: nonNegativeInteger(values.get("artwork_release_archive_direct")),
    activatedRows,
    terminalUnavailable: nonNegativeInteger(values.get("artwork_release_terminal_unavailable")),
    storedRows,
  };
}

/**
 * Resolves one explicitly requested ID. Private and hidden metadata is
 * available because the caller already supplied the exact Drop ID. Neither
 * category is added to public browse enumeration.
 */
export async function fetchExactHoldingDropDetail(
  db: D1ReadClient,
  dropId: number,
  snapshotId: string,
  artworkReleaseId: string,
  mediaBaseUrl: string,
  archiveSnapshotId: string,
  artworkCollectionsSnapshotId: string,
): Promise<ExactHoldingDropLookup> {
  if (!Number.isSafeInteger(dropId) || dropId <= 0) {
    throw new ApiError(400, "Drop ID must be a positive integer.");
  }
  const [snapshot, artworkRelease, detail] = await db.batch<
    SnapshotIdRow | ArtworkReleaseRow | HoldingDropRow
  >([
    db.prepare(SNAPSHOT_ID_SQL),
    db.prepare(ARTWORK_RELEASE_SQL),
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
      artworkCollectionsSnapshotId,
      isArtworkReleaseActive(
        artworkRelease.results as ArtworkReleaseRow[],
        artworkReleaseId,
        artworkCollectionsSnapshotId,
      ),
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
  artworkReleaseId: string,
  mediaBaseUrl: string,
  archiveSnapshotId: string,
  artworkCollectionsSnapshotId: string,
): Promise<Map<number, DropDetail>> {
  const uniqueIds = [
    ...new Set(dropIds.filter((dropId) => Number.isSafeInteger(dropId) && dropId > 0)),
  ];
  if (uniqueIds.length === 0) return new Map();
  if (uniqueIds.length > MAX_LOOKUP_IDS) {
    throw new ApiError(400, `Held-Drop lookups are limited to ${MAX_LOOKUP_IDS} IDs.`);
  }
  const statements: D1PreparedStatement[] = [
    db.prepare(SNAPSHOT_ID_SQL),
    db.prepare(ARTWORK_RELEASE_SQL),
  ];
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
  const [snapshot, artworkRelease, ...results] = await db.batch<
    SnapshotIdRow | ArtworkReleaseRow | HoldingDropRow
  >(statements);
  assertSnapshot(snapshot.results[0] as SnapshotIdRow | undefined, snapshotId);
  const artworkEnabled = isArtworkReleaseActive(
    artworkRelease.results as ArtworkReleaseRow[],
    artworkReleaseId,
    artworkCollectionsSnapshotId,
  );
  const allowed = new Set(uniqueIds);
  const drops = new Map<number, DropDetail>();
  for (const row of results.flatMap((result) => result.results as HoldingDropRow[])) {
    const dropId = numberValue(row.drop_id);
    if (!allowed.has(dropId) || drops.has(dropId)) {
      throw new ApiError(503, "Held-Drop lookup escaped its bounded ID set.");
    }
    drops.set(
      dropId,
      toHoldingDropDetail(
        row,
        mediaBaseUrl,
        archiveSnapshotId,
        snapshotId,
        artworkCollectionsSnapshotId,
        artworkEnabled,
      ),
    );
  }
  return drops;
}

/**
 * Keeps the richer address-bound presentation metadata while allowing a
 * verified Holdings object to fill an otherwise missing artwork reference.
 */
export function withFallbackArtwork<T extends Pick<DropDetail, "hasArtwork" | "imageUrl">>(
  presentation: T,
  holding: Pick<DropDetail, "hasArtwork" | "imageUrl"> | undefined,
): T {
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
  artworkEnabled: boolean,
): DropDetail {
  const dropId = numberValue(row.drop_id);
  const imageUrl = holdingDropArtworkUrl(
    mediaBaseUrl,
    artworkEnabled ? row.image_object_key : null,
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
    imageUrl,
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

function isArtworkReleaseActive(
  rows: ArtworkReleaseRow[],
  expectedReleaseId: string,
  expectedCollectionsSnapshotId: string,
): boolean {
  if (!expectedReleaseId || !expectedCollectionsSnapshotId) return false;
  const values = artworkReleaseValues(rows);
  const referencedDrops = positiveInteger(values.get("artwork_release_referenced_drops"));
  const archiveDirect = nonNegativeInteger(values.get("artwork_release_archive_direct"));
  const activatedRows = nonNegativeInteger(values.get("artwork_release_activated_rows"));
  const terminalUnavailable = nonNegativeInteger(
    values.get("artwork_release_terminal_unavailable"),
  );
  return (
    values.get("artwork_release_id") === expectedReleaseId &&
    values.get("artwork_release_collections_snapshot_id") === expectedCollectionsSnapshotId &&
    /^[0-9a-f]{64}$/.test(values.get("artwork_release_sha256") ?? "") &&
    values.get("artwork_release_complete") === "1" &&
    referencedDrops !== null &&
    archiveDirect !== null &&
    activatedRows !== null &&
    terminalUnavailable !== null &&
    archiveDirect + activatedRows + terminalUnavailable === referencedDrops
  );
}

function artworkReleaseValues(rows: ArtworkReleaseRow[]): Map<string, string> {
  return new Map(rows.map((row) => [row.key, row.value]));
}

function nonNegativeInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function positiveInteger(value: string | undefined): number | null {
  const parsed = nonNegativeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
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
