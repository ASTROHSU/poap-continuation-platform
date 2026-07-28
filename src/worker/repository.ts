import { artworkUrl } from "./media";
import { fetchHeldDropDetails } from "./holding-drops";
import { fetchPrivateHeldDropDetails } from "./private-held-drops";
import type {
  ArchiveMeta,
  CatalogDetailRow,
  CatalogSummaryRow,
  D1ReadClient,
  DropCollectorRow,
  DropCollectorsPage,
  DropCollectorsQuery,
  DropDetail,
  DropDetailBatch,
  DropSummary,
  DropsQuery,
  ExportCatalogRow,
  HoldingRow,
  OwnerQuery,
  OwnerToken,
  PersonalHoldingReference,
  PersonalHoldingsPage,
  PersonalHoldingsQuery,
} from "./types";
import { ApiError, encodeCursor } from "./validation";

const SUMMARY_COLUMNS = `
  d.drop_id,
  d.fancy_id,
  d.title,
  d.start_date,
  d.city,
  d.country,
  d.year,
  d.is_virtual,
  d.token_count,
  d.has_artwork`;

const DETAIL_COLUMNS = `
  ${SUMMARY_COLUMNS},
  d.description,
  d.end_date,
  d.event_url,
  d.channel,
  d.platform,
  d.location_type,
  d.timezone,
  d.created_at,
  s.email_reservations_total,
  s.email_reservations_minted,
  s.email_reservations_unminted`;

const HOLDING_COLUMNS = `
  source_uid,
  poap_id,
  drop_id,
  minted_on,
  network,
  transfer_count`;

const EXPORT_COLUMNS = `
  d.drop_id,
  d.title,
  d.start_date,
  d.end_date,
  d.city,
  d.country,
  d.event_url,
  d.has_artwork`;

const META_SQL = `
  SELECT key, value
  FROM archive_meta
  WHERE key IN (
    'snapshot_id',
    'snapshot_at',
    'drops_count',
    'tokens_count',
    'owners_count',
    'artworks_count',
    'years'
  )`;

const SNAPSHOT_META_SQL = `
  SELECT key, value
  FROM archive_meta
  WHERE key IN ('snapshot_id', 'snapshot_at')`;

const HOLDINGS_META_SQL = `
  SELECT key, value
  FROM archive_meta
  WHERE key IN ('snapshot_id', 'snapshot_at', 'tokens_count', 'owners_count')`;

const SNAPSHOT_ID_SQL = `
  SELECT value
  FROM archive_meta
  WHERE key = 'snapshot_id'`;

const DROP_DETAIL_SQL = `
  SELECT ${DETAIL_COLUMNS}, d.is_private
  FROM drops d
  LEFT JOIN drop_stats s ON s.drop_id = d.drop_id
  WHERE d.drop_id = ?1`;

const OWNER_STATS_SQL = `
  SELECT token_count, unique_drop_count
  FROM owner_stats
  WHERE owner_address_norm = ?1`;

const OWNER_FIRST_PAGE_SQL = `
  SELECT ${HOLDING_COLUMNS}
  FROM tokens
  WHERE owner_address_norm = ?1
  ORDER BY poap_id DESC, source_uid DESC
  LIMIT ?2`;

const OWNER_NEXT_PAGE_SQL = `
  SELECT ${HOLDING_COLUMNS}
  FROM tokens
  WHERE owner_address_norm = ?1
    AND (poap_id, source_uid) < (?2, ?3)
  ORDER BY poap_id DESC, source_uid DESC
  LIMIT ?4`;

const DROP_COLLECTORS_FIRST_PAGE_SQL = `
  SELECT
    r.source_uid,
    r.poap_id,
    t.minted_on,
    r.owner_address_norm,
    t.network,
    t.transfer_count
  FROM drop_collector_refs r
  JOIN tokens t
    ON t.owner_address_norm = r.owner_address_norm
   AND t.poap_id = r.poap_id
   AND t.source_uid = r.source_uid
  WHERE r.drop_id = ?1
  ORDER BY r.poap_id DESC, r.source_uid DESC, r.owner_address_norm DESC
  LIMIT ?2`;

const DROP_COLLECTORS_NEXT_PAGE_SQL = `
  SELECT
    r.source_uid,
    r.poap_id,
    t.minted_on,
    r.owner_address_norm,
    t.network,
    t.transfer_count
  FROM drop_collector_refs r
  JOIN tokens t
    ON t.owner_address_norm = r.owner_address_norm
   AND t.poap_id = r.poap_id
   AND t.source_uid = r.source_uid
  WHERE r.drop_id = ?1
    AND (r.poap_id, r.source_uid, r.owner_address_norm) < (?2, ?3, ?4)
  ORDER BY r.poap_id DESC, r.source_uid DESC, r.owner_address_norm DESC
  LIMIT ?5`;

const PERSONAL_HOLDINGS_FIRST_PAGE_SQL = `
  SELECT ${HOLDING_COLUMNS}
  FROM tokens
  WHERE owner_address_norm = ?1
  ORDER BY poap_id DESC, source_uid DESC
  LIMIT ?2`;

const PERSONAL_HOLDINGS_NEXT_PAGE_SQL = `
  SELECT ${HOLDING_COLUMNS}
  FROM tokens
  WHERE owner_address_norm = ?1
    AND (poap_id, source_uid) < (?2, ?3)
  ORDER BY poap_id DESC, source_uid DESC
  LIMIT ?4`;

export const EXPORT_BATCH_SIZE = 480;

const EXPORT_FIRST_PAGE_SQL = `
  SELECT ${HOLDING_COLUMNS}
  FROM tokens
  WHERE owner_address_norm = ?1
  ORDER BY poap_id DESC, source_uid DESC
  LIMIT ${EXPORT_BATCH_SIZE}`;

const EXPORT_NEXT_PAGE_SQL = `
  SELECT ${HOLDING_COLUMNS}
  FROM tokens
  WHERE owner_address_norm = ?1
    AND (poap_id, source_uid) < (?2, ?3)
  ORDER BY poap_id DESC, source_uid DESC
  LIMIT ${EXPORT_BATCH_SIZE}`;

const OWNER_LOOKUP_SIZE = 48;
const EXPORT_LOOKUP_SIZE = 96;
export const DROP_DETAIL_BATCH_SIZE = EXPORT_LOOKUP_SIZE;
const OWNER_CATALOG_SQL = makeIdLookupSql(SUMMARY_COLUMNS, OWNER_LOOKUP_SIZE, false);
const EXPORT_CATALOG_SQL = makeIdLookupSql(EXPORT_COLUMNS, EXPORT_LOOKUP_SIZE, false);
const DROP_DETAIL_BATCH_SQL = makeIdLookupSql(DETAIL_COLUMNS, DROP_DETAIL_BATCH_SIZE, true);
const PERSONAL_HOLDINGS_CATALOG_SQL = DROP_DETAIL_BATCH_SQL;

interface MetaRow {
  key: string;
  value: string;
}

interface OwnerStatsRow {
  token_count: number;
  unique_drop_count: number;
}

interface SnapshotIdRow {
  value: string;
}

export async function fetchMeta(db: D1ReadClient, snapshotId: string): Promise<ArchiveMeta> {
  const result = await db.prepare(META_SQL).all<MetaRow>();
  const values = new Map(result.results.map((row) => [row.key, row.value]));
  assertSnapshotId(values.get("snapshot_id"), snapshotId);
  const snapshotAt = values.get("snapshot_at");
  const drops = parseStoredCount(values.get("drops_count"));
  const tokens = parseStoredCount(values.get("tokens_count"));
  const owners = parseStoredCount(values.get("owners_count"));
  const artworks = parseStoredCount(values.get("artworks_count"));
  const years = parseStoredYears(values.get("years"));

  if (!snapshotAt)
    throw new ApiError(503, "Archive metadata is not available.", "archive_unavailable");
  return { snapshotId, snapshotAt, counts: { drops, tokens, owners, artworks }, years };
}

export async function fetchSnapshotAt(db: D1ReadClient, snapshotId: string): Promise<string> {
  const result = await db.prepare(SNAPSHOT_META_SQL).all<MetaRow>();
  const values = new Map(result.results.map((row) => [row.key, row.value]));
  assertSnapshotId(values.get("snapshot_id"), snapshotId);
  const snapshotAt = values.get("snapshot_at");
  if (!snapshotAt) {
    throw new ApiError(503, "Archive metadata is not available.", "archive_unavailable");
  }
  return snapshotAt;
}

export async function fetchHoldingsMeta(
  db: D1ReadClient,
  snapshotId: string,
): Promise<{ snapshotId: string; snapshotAt: string; tokens: number; owners: number }> {
  const result = await db.prepare(HOLDINGS_META_SQL).all<MetaRow>();
  const values = new Map(result.results.map((row) => [row.key, row.value]));
  assertSnapshotId(values.get("snapshot_id"), snapshotId);
  const snapshotAt = values.get("snapshot_at");
  if (!snapshotAt) {
    throw new ApiError(503, "Holdings metadata is not available.", "archive_unavailable");
  }
  return {
    snapshotId,
    snapshotAt,
    tokens: parseStoredCount(values.get("tokens_count")),
    owners: parseStoredCount(values.get("owners_count")),
  };
}

export async function fetchDrops(
  db: D1ReadClient,
  query: DropsQuery,
  snapshotId: string,
  mediaBaseUrl: string,
): Promise<{ items: DropSummary[]; nextCursor: string | null }> {
  const { sql, values } = makeDropBrowseStatement(query);
  const [snapshotResult, browseResult] = await db.batch<SnapshotIdRow | CatalogSummaryRow>([
    db.prepare(SNAPSHOT_ID_SQL),
    db.prepare(sql).bind(...values),
  ]);
  assertSnapshotId((snapshotResult.results[0] as SnapshotIdRow | undefined)?.value, snapshotId);
  const result = browseResult as D1Result<CatalogSummaryRow>;
  const hasNext = result.results.length > query.limit;
  const pageRows = result.results.slice(0, query.limit);
  const items = pageRows.map((row) => toDropSummary(row, mediaBaseUrl, snapshotId));

  const currentPage = query.cursor?.p ?? 1;
  const searchPageAllowed = query.ftsQuery === null || currentPage < 10;
  const last = pageRows.at(-1);
  const nextCursor =
    hasNext && searchPageAllowed && last
      ? encodeCursor({
          v: 1,
          s: snapshotId,
          f: query.filterKey,
          p: currentPage + 1,
          k: query.sort === "popular" ? numeric(last.token_count) : last.start_date,
          i: numeric(last.drop_id),
        })
      : null;

  return { items, nextCursor };
}

export async function fetchDrop(
  db: D1ReadClient,
  dropId: number,
  mediaBaseUrl: string,
  snapshotId: string,
): Promise<DropDetail | null> {
  const [snapshotResult, detailResult] = await db.batch<SnapshotIdRow | CatalogDetailRow>([
    db.prepare(SNAPSHOT_ID_SQL),
    db.prepare(DROP_DETAIL_SQL).bind(dropId),
  ]);
  assertSnapshotId((snapshotResult.results[0] as SnapshotIdRow | undefined)?.value, snapshotId);
  const row = detailResult.results[0] as CatalogDetailRow | undefined;
  return row ? toDropDetail(row, mediaBaseUrl, snapshotId) : null;
}

export async function fetchDropDetailBatch(
  db: D1ReadClient,
  dropIds: number[],
  mediaBaseUrl: string,
  snapshotId: string,
): Promise<DropDetailBatch> {
  if (
    dropIds.length < 1 ||
    dropIds.length > DROP_DETAIL_BATCH_SIZE ||
    dropIds.some((dropId) => !Number.isSafeInteger(dropId) || dropId <= 0)
  ) {
    throw new ApiError(
      400,
      `Drop detail batches must contain between 1 and ${DROP_DETAIL_BATCH_SIZE} positive IDs.`,
    );
  }

  const requestedDropIds = [...new Set(dropIds)].sort((left, right) => left - right);
  const paddedIds = [
    ...requestedDropIds,
    ...Array(DROP_DETAIL_BATCH_SIZE - requestedDropIds.length).fill(0),
  ];
  const [snapshotResult, detailResult] = await db.batch<SnapshotIdRow | CatalogDetailRow>([
    db.prepare(SNAPSHOT_ID_SQL),
    db.prepare(DROP_DETAIL_BATCH_SQL).bind(...paddedIds),
  ]);
  assertSnapshotId((snapshotResult.results[0] as SnapshotIdRow | undefined)?.value, snapshotId);
  const catalog = new Map(
    (detailResult.results as CatalogDetailRow[]).map((row) => [
      numeric(row.drop_id),
      toDropDetail(row, mediaBaseUrl, snapshotId),
    ]),
  );
  const drops = requestedDropIds.flatMap((dropId) => {
    const drop = catalog.get(dropId);
    return drop ? [drop] : [];
  });

  return {
    schemaVersion: "poapin-drop-detail-batch-v1",
    snapshotId,
    requestedDropIds,
    drops,
    unavailableDropIds: requestedDropIds.filter((dropId) => !catalog.has(dropId)),
  };
}

export async function fetchOwner(
  holdingsDb: D1ReadClient,
  catalogDb: D1ReadClient,
  collectionsDb: D1ReadClient,
  query: OwnerQuery,
  holdingsSnapshotId: string,
  catalogSnapshotId: string,
  collectionsSnapshotId: string,
  mediaBaseUrl: string,
): Promise<{
  address: string;
  total: number;
  uniqueDrops: number;
  items: OwnerToken[];
  nextCursor: string | null;
}> {
  const tokenStatement = query.cursor
    ? holdingsDb
        .prepare(OWNER_NEXT_PAGE_SQL)
        .bind(query.address, query.cursor.p, query.cursor.u, query.limit + 1)
    : holdingsDb.prepare(OWNER_FIRST_PAGE_SQL).bind(query.address, query.limit + 1);

  const [snapshotResult, statsResult, tokenResult] = await holdingsDb.batch<
    SnapshotIdRow | OwnerStatsRow | HoldingRow
  >([
    holdingsDb.prepare(SNAPSHOT_ID_SQL),
    holdingsDb.prepare(OWNER_STATS_SQL).bind(query.address),
    tokenStatement,
  ]);
  assertSnapshotId(
    (snapshotResult.results[0] as SnapshotIdRow | undefined)?.value,
    holdingsSnapshotId,
  );
  const stats = statsResult.results[0] as OwnerStatsRow | undefined;
  const total = numeric(stats?.token_count);
  const uniqueDrops = numeric(stats?.unique_drop_count);
  const allRows = tokenResult.results as HoldingRow[];
  const hasNext = allRows.length > query.limit;
  const rows = allRows.slice(0, query.limit);
  const catalog = await fetchCatalogSummaries(
    catalogDb,
    rows.map((row) => row.drop_id),
    mediaBaseUrl,
    catalogSnapshotId,
  );
  const privateCandidateIds = rows
    .map((row) => row.drop_id)
    .filter((dropId) => !catalog.has(dropId));
  const privateDrops =
    privateCandidateIds.length > 0
      ? await fetchPrivateHeldDropDetails(
          collectionsDb,
          privateCandidateIds,
          mediaBaseUrl,
          catalogSnapshotId,
          collectionsSnapshotId,
        )
      : new Map<number, DropDetail>();
  const holdingCandidateIds = privateCandidateIds.filter((dropId) => !privateDrops.has(dropId));
  const holdingDrops =
    holdingCandidateIds.length > 0
      ? await fetchHeldDropDetails(holdingsDb, holdingCandidateIds, holdingsSnapshotId)
      : new Map<number, DropDetail>();
  const items = rows.map((row) => {
    const drop =
      catalog.get(row.drop_id) ??
      privateDrops.get(row.drop_id) ??
      holdingDrops.get(row.drop_id) ??
      fallbackDrop(row, mediaBaseUrl, catalogSnapshotId);
    return {
      ...drop,
      sourceUid: row.source_uid,
      poapId: numeric(row.poap_id),
      mintedOn: nullableNumber(row.minted_on),
      ownerAddress: query.address,
      network: row.network,
      transferCount: numeric(row.transfer_count),
    };
  });

  const last = rows.at(-1);
  const nextCursor =
    hasNext && last
      ? encodeCursor({
          v: 1,
          s: holdingsSnapshotId,
          f: query.filterKey,
          p: numeric(last.poap_id),
          u: last.source_uid,
        })
      : null;
  return { address: query.address, total, uniqueDrops, items, nextCursor };
}

export async function fetchDropCollectors(
  db: D1ReadClient,
  query: DropCollectorsQuery,
  snapshotId: string,
): Promise<DropCollectorsPage> {
  const collectorStatement = query.cursor
    ? db
        .prepare(DROP_COLLECTORS_NEXT_PAGE_SQL)
        .bind(query.dropId, query.cursor.i, query.cursor.u, query.cursor.a, query.limit + 1)
    : db.prepare(DROP_COLLECTORS_FIRST_PAGE_SQL).bind(query.dropId, query.limit + 1);
  const [snapshotResult, collectorResult] = await db.batch<SnapshotIdRow | DropCollectorRow>([
    db.prepare(SNAPSHOT_ID_SQL),
    collectorStatement,
  ]);
  assertSnapshotId((snapshotResult.results[0] as SnapshotIdRow | undefined)?.value, snapshotId);

  const allRows = collectorResult.results as DropCollectorRow[];
  const hasNext = allRows.length > query.limit;
  const rows = allRows.slice(0, query.limit);
  const items = rows.map((row) => ({
    poapId: numeric(row.poap_id),
    ownerAddress: row.owner_address_norm,
    mintedOn: nullableNumber(row.minted_on),
    network: row.network,
    transferCount: numeric(row.transfer_count),
  }));
  const last = rows.at(-1);
  const currentPage = query.cursor?.p ?? 1;
  const nextCursor =
    hasNext && last
      ? encodeCursor({
          v: 1,
          c: "drop-collectors",
          s: snapshotId,
          f: query.filterKey,
          p: currentPage + 1,
          i: numeric(last.poap_id),
          u: last.source_uid,
          a: last.owner_address_norm,
        })
      : null;

  return {
    snapshotId,
    dropId: query.dropId,
    items,
    nextCursor,
  };
}

export async function fetchPersonalHoldingsPage(
  holdingsDb: D1ReadClient,
  catalogDb: D1ReadClient,
  collectionsDb: D1ReadClient,
  query: PersonalHoldingsQuery,
  holdingsSnapshotId: string,
  catalogSnapshotId: string,
  collectionsSnapshotId: string,
  collectionsReleaseId: string,
  mediaBaseUrl: string,
): Promise<PersonalHoldingsPage> {
  const tokenStatement = query.cursor
    ? holdingsDb
        .prepare(PERSONAL_HOLDINGS_NEXT_PAGE_SQL)
        .bind(query.address, query.cursor.p, query.cursor.u, query.limit + 1)
    : holdingsDb.prepare(PERSONAL_HOLDINGS_FIRST_PAGE_SQL).bind(query.address, query.limit + 1);
  const [snapshotResult, statsResult, tokenResult] = await holdingsDb.batch<
    SnapshotIdRow | OwnerStatsRow | HoldingRow
  >([
    holdingsDb.prepare(SNAPSHOT_ID_SQL),
    holdingsDb.prepare(OWNER_STATS_SQL).bind(query.address),
    tokenStatement,
  ]);
  assertSnapshotId(
    (snapshotResult.results[0] as SnapshotIdRow | undefined)?.value,
    holdingsSnapshotId,
  );

  const total = numeric((statsResult.results[0] as OwnerStatsRow | undefined)?.token_count);
  const allRows = tokenResult.results as HoldingRow[];
  const hasNext = allRows.length > query.limit;
  const rows = allRows.slice(0, query.limit);
  const catalog = await fetchCatalogDetails(
    catalogDb,
    rows.map((row) => row.drop_id),
    mediaBaseUrl,
    catalogSnapshotId,
  );
  const privateCandidateIds = rows
    .map((row) => row.drop_id)
    .filter((dropId) => !catalog.has(dropId));
  const privateDrops =
    privateCandidateIds.length > 0
      ? await fetchPrivateHeldDropDetails(
          collectionsDb,
          privateCandidateIds,
          mediaBaseUrl,
          catalogSnapshotId,
          collectionsSnapshotId,
        )
      : new Map<number, DropDetail>();
  const holdingCandidateIds = privateCandidateIds.filter((dropId) => !privateDrops.has(dropId));
  const holdingDrops =
    holdingCandidateIds.length > 0
      ? await fetchHeldDropDetails(holdingsDb, holdingCandidateIds, holdingsSnapshotId)
      : new Map<number, DropDetail>();
  const items = rows.map((row): PersonalHoldingReference => {
    const dropId = numeric(row.drop_id);
    return {
      sourceUid: row.source_uid,
      poapId: numeric(row.poap_id),
      dropId,
      mintedOn: nullableNumber(row.minted_on),
      ownerAddress: query.address,
      network: row.network,
      transferCount: numeric(row.transfer_count),
    };
  });
  const referencedDropIds = [...new Set(items.map((item) => item.dropId))].sort(
    (left, right) => left - right,
  );
  const drops = referencedDropIds.flatMap((dropId) => {
    const drop = catalog.get(dropId) ?? privateDrops.get(dropId) ?? holdingDrops.get(dropId);
    return drop ? [drop] : [];
  });
  const unavailableDropIds = referencedDropIds.filter(
    (dropId) => !catalog.has(dropId) && !privateDrops.has(dropId) && !holdingDrops.has(dropId),
  );
  const last = rows.at(-1);
  const nextCursor =
    hasNext && last
      ? encodeCursor({
          v: 1,
          c: "personal-holdings",
          s: holdingsSnapshotId,
          f: query.filterKey,
          p: numeric(last.poap_id),
          u: last.source_uid,
        })
      : null;

  return {
    schemaVersion: "poapin-personal-holdings-page-v2",
    snapshotId: holdingsSnapshotId,
    catalogSnapshotId,
    collectionsSnapshotId,
    collectionsReleaseId,
    address: query.address,
    total,
    items,
    drops,
    unavailableDropIds,
    nextCursor,
  };
}

export async function fetchOwnerTotal(
  db: D1ReadClient,
  address: string,
  snapshotId: string,
): Promise<number> {
  const [snapshotResult, statsResult] = await db.batch<SnapshotIdRow | OwnerStatsRow>([
    db.prepare(SNAPSHOT_ID_SQL),
    db.prepare(OWNER_STATS_SQL).bind(address),
  ]);
  assertSnapshotId((snapshotResult.results[0] as SnapshotIdRow | undefined)?.value, snapshotId);
  return numeric((statsResult.results[0] as OwnerStatsRow | undefined)?.token_count);
}

export async function fetchExportHoldingBatch(
  db: D1ReadClient,
  address: string,
  cursor: { poapId: number; sourceUid: string } | null,
): Promise<HoldingRow[]> {
  const statement = cursor
    ? db.prepare(EXPORT_NEXT_PAGE_SQL).bind(address, cursor.poapId, cursor.sourceUid)
    : db.prepare(EXPORT_FIRST_PAGE_SQL).bind(address);
  const result = await statement.all<HoldingRow>();
  return result.results;
}

export async function fetchExportCatalog(
  db: D1ReadClient,
  dropIds: number[],
): Promise<Map<number, ExportCatalogRow>> {
  const uniqueIds = [...new Set(dropIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (uniqueIds.length === 0) return new Map();

  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += EXPORT_LOOKUP_SIZE) {
    const chunk = uniqueIds.slice(offset, offset + EXPORT_LOOKUP_SIZE);
    const padded = [...chunk, ...Array(EXPORT_LOOKUP_SIZE - chunk.length).fill(0)];
    statements.push(db.prepare(EXPORT_CATALOG_SQL).bind(...padded));
  }
  const results = await db.batch<ExportCatalogRow>(statements);
  const rows = results.flatMap((result) => result.results);
  return new Map(rows.map((row) => [numeric(row.drop_id), row]));
}

export function toDropSummary(
  row: CatalogSummaryRow,
  mediaBaseUrl: string,
  snapshotId: string,
): DropSummary {
  const dropId = numeric(row.drop_id);
  return {
    dropId,
    fancyId: row.fancy_id,
    title: row.title,
    startDate: row.start_date,
    city: row.city,
    country: row.country,
    year: numeric(row.year),
    isVirtual: row.is_virtual === null ? null : numeric(row.is_virtual) === 1,
    imageUrl: artworkUrl(mediaBaseUrl, snapshotId, dropId),
    hasArtwork: numeric(row.has_artwork) === 1,
    tokenCount: numeric(row.token_count),
  };
}

export function toDropDetail(
  row: CatalogDetailRow,
  mediaBaseUrl: string,
  snapshotId: string,
): DropDetail {
  return {
    ...toDropSummary(row, mediaBaseUrl, snapshotId),
    description: row.description,
    endDate: row.end_date,
    eventUrl: safeExternalUrl(row.event_url),
    channel: row.channel,
    platform: row.platform,
    locationType: row.location_type,
    timezone: row.timezone,
    createdAt: row.created_at,
    reservationsTotal: numeric(row.email_reservations_total),
    reservationsMinted: numeric(row.email_reservations_minted),
    reservationsUnminted: numeric(row.email_reservations_unminted),
    ...(numeric(row.is_private) === 1 ? { isPrivate: true as const } : {}),
  };
}

export function safeExternalUrl(value: string | null): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function makeDropBrowseStatement(query: DropsQuery): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `?${values.length}`;
  };
  let sql = `
    SELECT ${SUMMARY_COLUMNS}
    FROM drops d`;

  if (query.ftsQuery) sql += "\n    JOIN drops_fts ON drops_fts.rowid = d.drop_id";
  sql += "\n    WHERE d.is_private = 0";
  if (query.ftsQuery) sql += `\n      AND drops_fts MATCH ${bind(query.ftsQuery)}`;
  if (query.year !== null) sql += `\n      AND d.year = ${bind(query.year)}`;
  if (query.type === "virtual") sql += "\n      AND d.is_virtual = 1";
  if (query.type === "in-person") sql += "\n      AND d.is_virtual = 0";

  if (query.cursor) {
    if (query.sort === "popular") {
      sql += `\n      AND (d.token_count, d.drop_id) < (${bind(query.cursor.k)}, ${bind(query.cursor.i)})`;
    } else {
      const operator = query.sort === "oldest" ? ">" : "<";
      sql += `\n      AND (d.start_date, d.drop_id) ${operator} (${bind(query.cursor.k)}, ${bind(query.cursor.i)})`;
    }
  }

  const order =
    query.sort === "oldest"
      ? "d.start_date ASC, d.drop_id ASC"
      : query.sort === "popular"
        ? "d.token_count DESC, d.drop_id DESC"
        : "d.start_date DESC, d.drop_id DESC";
  sql += `\n    ORDER BY ${order}\n    LIMIT ${bind(query.limit + 1)}`;
  return { sql, values };
}

async function fetchCatalogSummaries(
  db: D1ReadClient,
  dropIds: number[],
  mediaBaseUrl: string,
  snapshotId: string,
): Promise<Map<number, DropSummary>> {
  const uniqueIds = [...new Set(dropIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const statements = [db.prepare(SNAPSHOT_ID_SQL)];
  if (uniqueIds.length > 0) {
    const padded = [...uniqueIds, ...Array(OWNER_LOOKUP_SIZE - uniqueIds.length).fill(0)];
    statements.push(db.prepare(OWNER_CATALOG_SQL).bind(...padded));
  }
  const [snapshotResult, catalogResult] = await db.batch<SnapshotIdRow | CatalogSummaryRow>(
    statements,
  );
  assertSnapshotId((snapshotResult.results[0] as SnapshotIdRow | undefined)?.value, snapshotId);
  const rows = (catalogResult?.results ?? []) as CatalogSummaryRow[];
  return new Map(
    rows.map((row) => [numeric(row.drop_id), toDropSummary(row, mediaBaseUrl, snapshotId)]),
  );
}

async function fetchCatalogDetails(
  db: D1ReadClient,
  dropIds: number[],
  mediaBaseUrl: string,
  snapshotId: string,
): Promise<Map<number, DropDetail>> {
  const uniqueIds = [...new Set(dropIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const statements: D1PreparedStatement[] = [db.prepare(SNAPSHOT_ID_SQL)];
  for (let offset = 0; offset < uniqueIds.length; offset += EXPORT_LOOKUP_SIZE) {
    const chunk = uniqueIds.slice(offset, offset + EXPORT_LOOKUP_SIZE);
    const padded = [...chunk, ...Array(EXPORT_LOOKUP_SIZE - chunk.length).fill(0)];
    statements.push(db.prepare(PERSONAL_HOLDINGS_CATALOG_SQL).bind(...padded));
  }
  const results = await db.batch<SnapshotIdRow | CatalogDetailRow>(statements);
  assertSnapshotId((results[0]?.results[0] as SnapshotIdRow | undefined)?.value, snapshotId);
  const rows = results.slice(1).flatMap((result) => result.results as CatalogDetailRow[]);
  return new Map(
    rows.map((row) => [numeric(row.drop_id), toDropDetail(row, mediaBaseUrl, snapshotId)]),
  );
}

function makeIdLookupSql(columns: string, size: number, includeStats: boolean): string {
  const placeholders = Array.from({ length: size }, (_, index) => `?${index + 1}`).join(", ");
  return `
    SELECT ${columns}
    FROM drops d
    ${includeStats ? "LEFT JOIN drop_stats s ON s.drop_id = d.drop_id" : ""}
    WHERE d.is_private = 0 AND d.drop_id IN (${placeholders})`;
}

function fallbackDrop(row: HoldingRow, mediaBaseUrl: string, snapshotId: string): DropSummary {
  const dropId = numeric(row.drop_id);
  return {
    dropId,
    fancyId: "",
    title: `Archived Drop #${numeric(row.drop_id)}`,
    startDate: "",
    city: null,
    country: null,
    year: 0,
    isVirtual: null,
    imageUrl: artworkUrl(mediaBaseUrl, snapshotId, dropId),
    hasArtwork: false,
    tokenCount: 0,
  };
}

function parseStoredCount(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new ApiError(503, "Archive metadata is incomplete.", "archive_unavailable");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError(503, "Archive metadata is incomplete.", "archive_unavailable");
  }
  return parsed;
}

function assertSnapshotId(stored: string | undefined, expected: string): void {
  if (!stored || stored !== expected) {
    throw new ApiError(
      503,
      "Archive snapshot metadata does not match this deployment.",
      "snapshot_mismatch",
    );
  }
}

function parseStoredYears(value: string | undefined): number[] {
  try {
    const parsed = JSON.parse(value ?? "");
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return [...new Set(parsed)]
      .filter((year): year is number => Number.isInteger(year) && year >= 1900 && year <= 2100)
      .sort((left, right) => right - left);
  } catch {
    throw new ApiError(503, "Archive metadata is incomplete.", "archive_unavailable");
  }
}

function numeric(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
