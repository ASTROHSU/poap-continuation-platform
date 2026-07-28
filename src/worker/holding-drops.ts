import type { D1ReadClient, DropDetail, HoldingDropRow } from "./types";
import { ApiError } from "./validation";

const LOOKUP_SIZE = 96;
const MAX_LOOKUP_IDS = 480;
const SNAPSHOT_ID_SQL = `
  SELECT value
  FROM archive_meta
  WHERE key = 'snapshot_id'`;
const DROP_COLUMNS = `
  drop_id,
  fancy_id,
  title,
  description,
  start_date,
  end_date,
  expiry_date,
  city,
  country,
  event_url,
  year,
  is_virtual,
  is_private,
  is_hidden,
  channel,
  platform,
  location_type,
  timezone,
  integrator_id,
  created_at,
  token_count,
  transfer_count`;

type SnapshotIdRow = {
  value: string;
};

export type ExactHoldingDropLookup =
  { state: "available"; drop: DropDetail } | { state: "hidden" } | { state: "missing" };

/**
 * Resolves one explicitly requested ID. Private metadata is available because
 * the caller already supplied the exact Drop ID; hidden metadata stays closed.
 */
export async function fetchExactHoldingDropDetail(
  db: D1ReadClient,
  dropId: number,
  snapshotId: string,
): Promise<ExactHoldingDropLookup> {
  if (!Number.isSafeInteger(dropId) || dropId <= 0) {
    throw new ApiError(400, "Drop ID must be a positive integer.");
  }
  const [snapshot, detail] = await db.batch<SnapshotIdRow | HoldingDropRow>([
    db.prepare(SNAPSHOT_ID_SQL),
    db
      .prepare(
        `SELECT ${DROP_COLUMNS}
         FROM holding_drops
         WHERE drop_id = ?1
         LIMIT 1`,
      )
      .bind(dropId),
  ]);
  assertSnapshot(snapshot.results[0] as SnapshotIdRow | undefined, snapshotId);
  const row = detail.results[0] as HoldingDropRow | undefined;
  if (!row) return { state: "missing" };
  if (numberValue(row.is_hidden) === 1) return { state: "hidden" };
  return { state: "available", drop: toHoldingDropDetail(row) };
}

/**
 * Resolves only IDs already proven by the caller to belong to the requested
 * address. It is deliberately bounded and never used for public enumeration.
 */
export async function fetchHeldDropDetails(
  db: D1ReadClient,
  dropIds: number[],
  snapshotId: string,
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
           FROM holding_drops
           WHERE drop_id IN (${placeholders})
             AND is_hidden = 0
           ORDER BY drop_id`,
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
    drops.set(dropId, toHoldingDropDetail(row));
  }
  return drops;
}

function toHoldingDropDetail(row: HoldingDropRow): DropDetail {
  const dropId = numberValue(row.drop_id);
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
    // Source media URLs remain preserved in the private backup/D1. Public
    // responses switch to the immutable R2 copy only after media ingestion.
    imageUrl: "",
    hasArtwork: false,
    tokenCount: numberValue(row.token_count),
    dropTransferCount: numberValue(row.transfer_count),
    reservationsTotal: 0,
    reservationsMinted: 0,
    reservationsUnminted: 0,
    featuredOn: null,
    momentsUploaded: null,
    ...(numberValue(row.is_private) === 1 ? { isPrivate: true as const } : {}),
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
