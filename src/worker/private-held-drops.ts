import { collectionDropArtworkUrl } from "./media";
import type { CollectionItemRow, D1ReadClient, DropDetail } from "./types";
import { ApiError } from "./validation";

const LOOKUP_SIZE = 96;
const MAX_LOOKUP_IDS = 480;

const READINESS_SQL = `
  SELECT key, value
  FROM collections_meta
  WHERE key IN ('snapshot_id', 'ready')
  LIMIT 2`;

const DROP_DETAIL_COLUMNS = `
  drop_id,
  fancy_id,
  title AS drop_title,
  description AS drop_description,
  start_date,
  end_date,
  expiry_date,
  year AS drop_year,
  city,
  country,
  event_url,
  image_object_key,
  is_virtual,
  private_value,
  is_hidden,
  channel,
  platform,
  location_type,
  timezone,
  integrator_id,
  created_date,
  token_count,
  transfer_count,
  email_claims_minted,
  email_claims_reserved,
  email_claims_total,
  featured_on AS drop_featured_on,
  moments_uploaded`;

type MetaRow = {
  key: string;
  value: string;
};

type PrivateDropRow = Omit<CollectionItemRow, "item_id" | "created_on"> & {
  drop_id: number;
};

export type ExactCollectionDropLookup =
  { state: "available"; drop: DropDetail } | { state: "missing" };

/**
 * Resolves one explicitly requested Drop ID from the newer Collections
 * snapshot. Exact lookup may return private or hidden metadata, but it never
 * turns either category into a browseable list.
 */
export async function fetchExactCollectionDropDetail(
  db: D1ReadClient,
  dropId: number,
  mediaBaseUrl: string,
  archiveSnapshotId: string,
  collectionsSnapshotId: string,
): Promise<ExactCollectionDropLookup> {
  if (!Number.isSafeInteger(dropId) || dropId <= 0) {
    throw new ApiError(400, "Drop ID must be a positive integer.");
  }

  const [readiness, detail] = await db.batch<MetaRow | PrivateDropRow>([
    db.prepare(READINESS_SQL),
    db
      .prepare(
        `
          SELECT ${DROP_DETAIL_COLUMNS}
          FROM collection_drop_cards
          WHERE drop_id = ?1
          LIMIT 1`,
      )
      .bind(dropId),
  ]);
  assertReadiness(readiness.results as MetaRow[], collectionsSnapshotId);

  const row = detail.results[0] as PrivateDropRow | undefined;
  if (!row) return { state: "missing" };
  return {
    state: "available",
    drop: toCollectionDropDetail(row, mediaBaseUrl, archiveSnapshotId, collectionsSnapshotId),
  };
}

/**
 * Resolves private metadata only for Drop IDs already proven by the caller to
 * belong to the exact queried address. This bounded path remains separate from
 * exact single-ID lookup so address pagination cannot become enumeration.
 */
export async function fetchPrivateHeldDropDetails(
  db: D1ReadClient,
  dropIds: number[],
  mediaBaseUrl: string,
  archiveSnapshotId: string,
  collectionsSnapshotId: string,
): Promise<Map<number, DropDetail>> {
  const uniqueIds = [
    ...new Set(dropIds.filter((dropId) => Number.isSafeInteger(dropId) && dropId > 0)),
  ];
  if (uniqueIds.length === 0) return new Map();
  if (uniqueIds.length > MAX_LOOKUP_IDS) {
    throw new ApiError(400, `Private held-Drop lookups are limited to ${MAX_LOOKUP_IDS} IDs.`);
  }

  const statements: D1PreparedStatement[] = [db.prepare(READINESS_SQL)];
  for (let offset = 0; offset < uniqueIds.length; offset += LOOKUP_SIZE) {
    const chunk = uniqueIds.slice(offset, offset + LOOKUP_SIZE);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(", ");
    statements.push(
      db
        .prepare(
          `
            SELECT ${DROP_DETAIL_COLUMNS}
            FROM collection_drop_cards
            WHERE drop_id IN (${placeholders})
              AND (is_private = 1 OR is_hidden = 1)
            ORDER BY drop_id ASC`,
        )
        .bind(...chunk),
    );
  }

  const [readiness, ...results] = await db.batch<MetaRow | PrivateDropRow>(statements);
  assertReadiness(readiness.results as MetaRow[], collectionsSnapshotId);
  const allowedIds = new Set(uniqueIds);
  const drops = new Map<number, DropDetail>();

  for (const row of results.flatMap((result) => result.results as PrivateDropRow[])) {
    const dropId = numberValue(row.drop_id);
    if (!allowedIds.has(dropId) || drops.has(dropId)) {
      throw new ApiError(503, "Private held-Drop lookup escaped its bounded ID set.");
    }
    drops.set(
      dropId,
      toCollectionDropDetail(row, mediaBaseUrl, archiveSnapshotId, collectionsSnapshotId),
    );
  }
  return drops;
}

function toCollectionDropDetail(
  row: PrivateDropRow,
  mediaBaseUrl: string,
  archiveSnapshotId: string,
  collectionsSnapshotId: string,
): DropDetail {
  const dropId = numberValue(row.drop_id);
  const imageUrl = collectionDropArtworkUrl(
    mediaBaseUrl,
    row.image_object_key,
    archiveSnapshotId,
    collectionsSnapshotId,
    dropId,
  );
  return {
    dropId,
    fancyId: row.fancy_id ?? "",
    title: row.drop_title ?? `Private Drop #${dropId}`,
    description: row.drop_description,
    startDate: row.start_date ?? "",
    endDate: row.end_date ?? "",
    expiryDate: row.expiry_date,
    city: row.city,
    country: row.country,
    year: numberValue(row.drop_year),
    isVirtual: row.is_virtual === null ? null : numberValue(row.is_virtual) === 1,
    eventUrl: safeExternalUrl(row.event_url),
    channel: row.channel,
    platform: row.platform,
    locationType: row.location_type,
    timezone: row.timezone,
    integratorId: row.integrator_id,
    createdAt: row.created_date ?? "",
    imageUrl: imageUrl ?? "",
    hasArtwork: imageUrl !== null,
    tokenCount: numberValue(row.token_count),
    dropTransferCount: numberValue(row.transfer_count),
    reservationsTotal: numberValue(row.email_claims_total),
    reservationsMinted: numberValue(row.email_claims_minted),
    reservationsUnminted: numberValue(row.email_claims_reserved),
    featuredOn: row.drop_featured_on,
    momentsUploaded: row.moments_uploaded === null ? null : numberValue(row.moments_uploaded),
    ...(row.private_value === "false" ? {} : { isPrivate: true as const }),
    ...(numberValue(row.is_hidden) === 1 ? { isHidden: true as const } : {}),
  };
}

function assertReadiness(rows: MetaRow[], expectedSnapshotId: string): void {
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  if (meta.get("snapshot_id") !== expectedSnapshotId) {
    throw new ApiError(
      503,
      "Collections snapshot metadata does not match this deployment.",
      "snapshot_mismatch",
    );
  }
  if (meta.get("ready") !== "1") {
    throw new ApiError(
      503,
      "The Collections snapshot has not been published yet.",
      "collections_unavailable",
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
